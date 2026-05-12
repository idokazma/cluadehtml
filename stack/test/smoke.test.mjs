// End-to-end smoke test: spawn `stack run --replay fixtures/habits-day1.jsonl`,
// scrape /api/state and /events, assert on the final shape of the page.

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");

const PORT = 3939;

async function waitForServer(port, attempts = 30) {
  for (let i = 0; i < attempts; i++) {
    try {
      const r = await fetch(`http://localhost:${port}/`);
      if (r.ok) return;
    } catch {}
    await sleep(150);
  }
  throw new Error("server never came up");
}
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function spawnWrapper(port) {
  const child = spawn("node", ["bin/stack.mjs", "run", "--replay", "fixtures/habits-day1.jsonl", "--port", String(port)], {
    cwd: ROOT,
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, NO_COLOR: "1" },
  });
  let stdout = "";
  const done = new Promise((resolve) => {
    child.stdout.on("data", (d) => {
      stdout += d.toString();
      if (stdout.includes("[replay] complete")) resolve();
    });
  });
  child.stderr.on("data", () => {});
  return { child, done, stdoutRef: () => stdout };
}

test("replay produces the expected committed components end-to-end", async (t) => {
  const { child, done } = spawnWrapper(PORT);
  t.after(() => { try { child.kill("SIGKILL"); } catch {} });

  await waitForServer(PORT);
  await Promise.race([done, sleep(30000)]);
  await sleep(500); // last flush
  const state = await (await fetch(`http://localhost:${PORT}/api/state`)).json();

  const ids = Object.keys(state);
  assert.ok(ids.length >= 7, `expected at least 7 committed components, got ${ids.length}: ${ids.join(", ")}`);

  // Count by type — the fixture should have shaken out into a known mix.
  const byType = {};
  for (const c of Object.values(state)) byType[c.type] = (byType[c.type] || 0) + 1;

  assert.equal(byType.prompt, 1, "exactly one user prompt");
  assert.equal(byType.plan, 1, "exactly one plan component (TodoWrite patched in place)");
  assert.equal(byType.decision, 1, "exactly one decision card (sniffed from the prose)");
  assert.ok(byType.diff >= 1, "at least one diff");
  assert.equal(byType.terminal, 1, "exactly one terminal (the npm test)");
  assert.ok(byType.note >= 1, "at least one note");

  // Plan should have been patched: at least 3 items done by the end.
  const plan = Object.values(state).find(c => c.type === "plan");
  const doneCount = plan.props.items.filter(i => i.done).length;
  assert.ok(doneCount >= 3, `plan should show at least 3 completed items, got ${doneCount}`);

  // The decision card should have the 3 storage options.
  const dec = Object.values(state).find(c => c.type === "decision");
  assert.equal(dec.props.options.length, 3);
  assert.match(dec.props.options[0].label, /localStorage/);
  assert.match(dec.props.options[1].label, /IndexedDB/);
});

test("POST /api/action with a 'pick' synthesizes a follow-up user prompt visible in state", async (t) => {
  const port = PORT + 1;
  const { child, done } = spawnWrapper(port);
  t.after(() => { try { child.kill("SIGKILL"); } catch {} });

  await waitForServer(port);
  // Let the decision component get committed.
  for (let i = 0; i < 30; i++) {
    await sleep(400);
    const r = await fetch(`http://localhost:${port}/api/state`);
    const state = await r.json();
    if (Object.values(state).some(c => c.type === "decision")) break;
  }
  const stateBefore = await (await fetch(`http://localhost:${port}/api/state`)).json();
  const dec = Object.values(stateBefore).find(c => c.type === "decision");
  assert.ok(dec, "decision should have been committed before we pick");

  await fetch(`http://localhost:${port}/api/action`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ id: dec.id, kind: "pick", payload: { option: 2, label: "IndexedDB (via Dexie)" } }),
  });

  // Wait for the replay to finish, then check that a new user prompt
  // appeared with the synthesized message.
  for (let i = 0; i < 40; i++) {
    await sleep(400);
    const r = await fetch(`http://localhost:${port}/api/state`);
    const s = await r.json();
    const promptsWithPick = Object.values(s).filter(c =>
      c.type === "prompt" && c.props.text.includes("Picked IndexedDB"));
    if (promptsWithPick.length) return;
  }
  assert.fail("expected a synthesized prompt containing 'Picked IndexedDB' but none appeared");
});
