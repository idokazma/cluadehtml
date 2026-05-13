// Turn-boundary batching: the editorial agent should be called once per
// turn, not once per event. We exercise this by running the bin script
// against a fixture and inspecting the editor calls via a hand-rolled
// shim — actually, the easier proof is to drive flushTurn() directly
// against the editorial-agent module with a counting fake.

import { test } from "node:test";
import assert from "node:assert/strict";

// We re-implement the tiny piece of bin/stack.mjs's batching loop here so
// we can test it in isolation without spinning up a server. The behavior
// under test is the *shape* of the buffering — boundaries, debounce, and
// serialized commits — not the editor logic itself.

function makeBatcher({ editorial, quietMs = 30 }) {
  let buffer = [];
  let timer = null;
  let chain = Promise.resolve();
  const emits = [];
  const editorialCalls = [];

  function flushTurn() {
    if (timer) { clearTimeout(timer); timer = null; }
    if (buffer.length === 0) return;
    const chunk = buffer;
    buffer = [];
    editorialCalls.push(chunk);
    chain = chain.then(async () => {
      const muts = await editorial(chunk);
      for (const m of muts) emits.push(m);
    });
    return chain;
  }

  function handle(ev) {
    if (ev.kind === "user" && ev.text != null && buffer.length > 0) flushTurn();
    if (ev.kind === "result") { buffer.push(ev); flushTurn(); return; }
    buffer.push(ev);
    if (timer) clearTimeout(timer);
    timer = setTimeout(flushTurn, quietMs);
  }

  async function settle() { await chain; }
  return { handle, flushTurn, settle, emits, editorialCalls };
}

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

test("a single turn -> one editorial call with all events", async () => {
  const editorial = async (chunk) => chunk.map(e => ({ op: "append", component: { id: "c", type: "note", props: { n: e.kind } }, ts: 0 }));
  const b = makeBatcher({ editorial });
  b.handle({ kind: "assistant", text: "I'll edit the file", ts: 1 });
  b.handle({ kind: "assistant", tool: "Edit", input: { file_path: "x" }, ts: 2 });
  b.handle({ kind: "tool_result", tool_use_id: "tu_1", content: "ok", ts: 3 });
  b.handle({ kind: "result", raw: {}, ts: 4 });
  await b.settle();
  assert.equal(b.editorialCalls.length, 1, "result event should flush exactly one editorial call");
  assert.equal(b.editorialCalls[0].length, 4, "the chunk should contain all 4 events");
});

test("user prompt after assistant flushes the prior turn", async () => {
  const editorial = async (chunk) => [];
  const b = makeBatcher({ editorial });
  b.handle({ kind: "user", text: "do the thing", ts: 1 });
  b.handle({ kind: "assistant", text: "doing it", ts: 2 });
  b.handle({ kind: "assistant", tool: "Edit", input: {}, ts: 3 });
  b.handle({ kind: "user", text: "actually, do this other thing", ts: 4 });
  await b.settle();
  // First flush: [user, assistant, assistant]; new user starts the next turn.
  assert.equal(b.editorialCalls.length, 1);
  assert.equal(b.editorialCalls[0].length, 3);
  assert.equal(b.editorialCalls[0][0].text, "do the thing");
});

test("quiet timer flushes when no result event arrives (tail/replay mode)", async () => {
  const editorial = async (chunk) => [];
  const b = makeBatcher({ editorial, quietMs: 20 });
  b.handle({ kind: "assistant", text: "hi", ts: 1 });
  b.handle({ kind: "assistant", tool: "Read", input: { file_path: "x" }, ts: 2 });
  await sleep(60);
  await b.settle();
  assert.equal(b.editorialCalls.length, 1, "debounced flush after quiet period");
  assert.equal(b.editorialCalls[0].length, 2);
});

test("editorial calls are serialized even when slow", async () => {
  // First call takes 50ms; second is fast. The mutations from the first
  // turn must appear in `emits` before the mutations from the second turn.
  const order = [];
  const editorial = async (chunk) => {
    const turnId = chunk[0].text;
    if (turnId === "slow") await sleep(50);
    order.push(turnId);
    return [{ op: "append", component: { id: turnId, type: "note", props: {} }, ts: 0 }];
  };
  const b = makeBatcher({ editorial });
  b.handle({ kind: "assistant", text: "slow", ts: 1 });
  b.handle({ kind: "result", raw: {}, ts: 2 });
  b.handle({ kind: "assistant", text: "fast", ts: 3 });
  b.handle({ kind: "result", raw: {}, ts: 4 });
  await b.settle();
  assert.deepEqual(order, ["slow", "fast"], "turns must run in order");
  assert.equal(b.emits[0].component.id, "slow", "slow turn's mutations emit first");
  assert.equal(b.emits[1].component.id, "fast");
});
