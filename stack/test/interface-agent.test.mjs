import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { editorialAgentRules } from "../src/pipeline/interface-agent.mjs";
import { resetIds } from "../src/store/ids.mjs";

beforeEach(() => resetIds());

test("Edit tool_use commits a diff with old/new hunks", () => {
  const ev = {
    kind: "assistant", tool: "Edit", tool_use_id: "tu_e",
    input: {
      file_path: "src/payments/charge.ts",
      old_string: "return retry();",
      new_string: "if (idem) return cached; return retry();",
    },
    ts: 1,
  };
  const out = editorialAgentRules([ev], {});
  assert.equal(out.length, 1);
  assert.equal(out[0].op, "append");
  assert.equal(out[0].component.type, "diff");
  assert.equal(out[0].component.props.filename, "src/payments/charge.ts");
  const lines = out[0].component.props.hunks[0].lines;
  assert.equal(lines[0][0], "-");
  assert.equal(lines[lines.length - 1][0], "+");
});

test("Write tool_use commits a diff with all-additions", () => {
  const ev = {
    kind: "assistant", tool: "Write", tool_use_id: "tu_w",
    input: { file_path: "src/new.ts", content: "export const x = 1;\nexport const y = 2;" },
    ts: 1,
  };
  const out = editorialAgentRules([ev], {});
  assert.equal(out[0].component.type, "diff");
  assert.deepEqual(out[0].component.props.hunks[0].lines.map(l => l[0]), ["+", "+"]);
});

test("text offering numbered options + a question becomes a decision card", () => {
  const ev = {
    kind: "assistant",
    text: `There are 3 reasonable ways to handle skipped days:
1) Auto grace day — every Nth missed day is free, no UI.
2) Manual freeze — user taps 'freeze' before midnight. Limited per month.
3) Both — 1 auto + 2 manual / month.

Which do you prefer?`,
    ts: 1,
  };
  const out = editorialAgentRules([ev], {});
  const decisions = out.filter(m => m.component?.type === "decision");
  assert.equal(decisions.length, 1, "should commit one decision");
  const props = decisions[0].component.props;
  assert.equal(props.options.length, 3);
  assert.match(props.options[0].label, /Auto grace day/);
  assert.match(props.options[1].label, /Manual freeze/);
  // and the prose is NOT also kept as a note alongside (replaces, not enriches)
  assert.equal(out.filter(m => m.component?.type === "note").length, 0);
});

test("plain prose without options does NOT become a decision", () => {
  const ev = {
    kind: "assistant",
    text: "I'm going to look at the charge handler and the retry logic.",
    ts: 1,
  };
  const out = editorialAgentRules([ev], {});
  assert.equal(out.filter(m => m.component?.type === "decision").length, 0);
});

test("long-running Bash that isn't a test/build/deploy auto-commits a streaming terminal", () => {
  const state = {};
  const ev = {
    kind: "assistant", tool: "Bash", tool_use_id: "tu_b",
    input: { command: "docker compose up" },
    ts: 1,
  };
  const out = editorialAgentRules([ev], state);
  const t = out.find(m => m.component?.type === "terminal");
  assert.ok(t, "should commit a terminal for docker compose up");
  assert.equal(t.component.props.command, "docker compose up");
  assert.equal(t.component.props.status, "running");
});

test("non-long-running Bash (ls, cat) does NOT auto-commit a terminal", () => {
  const ev = {
    kind: "assistant", tool: "Bash", tool_use_id: "tu_b",
    input: { command: "ls -la" }, ts: 1,
  };
  const out = editorialAgentRules([ev], {});
  assert.equal(out.filter(m => m.component?.type === "terminal").length, 0);
});

test("tool_result of a committed terminal streams + finalizes", () => {
  const state = {};
  editorialAgentRules([{
    kind: "assistant", tool: "Bash", tool_use_id: "tu_b",
    input: { command: "docker compose up" }, ts: 1,
  }], state);
  const out = editorialAgentRules([{
    kind: "tool_result", tool_use_id: "tu_b", content: "Started 3 services\n", ts: 2,
  }], state);
  const ops = out.map(m => m.op);
  assert.deepEqual(ops, ["stream", "finalize"]);
});

test("npm test → `tests` panel (not terminal), result parses pass/fail counts", () => {
  const state = {};
  const out1 = editorialAgentRules([{
    kind: "assistant", tool: "Bash", tool_use_id: "tu_t",
    input: { command: "npm test --silent" }, ts: 1,
  }], state);
  const t = out1.find(m => m.component?.type === "tests");
  assert.ok(t, "should commit a tests panel");
  assert.equal(t.component.props.status, "running");
  assert.equal(out1.filter(m => m.component?.type === "terminal").length, 0, "should NOT also commit a terminal");

  const out2 = editorialAgentRules([{
    kind: "tool_result", tool_use_id: "tu_t",
    content: "Test Files  2 passed (2)\nTests       7 passed (7)\nDuration    412ms",
    ts: 2,
  }], state);
  const patch = out2.find(m => m.op === "patch");
  assert.ok(patch, "tool_result should emit a patch on the tests component");
  assert.equal(patch.props.passed, 7);
  assert.equal(patch.props.failed, 0);
  assert.equal(patch.props.duration, "412ms");
});

test("vercel deploy → `deploy` step list (not terminal), result captures live URL", () => {
  const state = {};
  const out1 = editorialAgentRules([{
    kind: "assistant", tool: "Bash", tool_use_id: "tu_d",
    input: { command: "npx vercel deploy --prod" }, ts: 1,
  }], state);
  const d = out1.find(m => m.component?.type === "deploy");
  assert.ok(d, "should commit a deploy component");
  assert.ok(d.component.props.steps.length >= 2, "should have at least 2 steps");

  const out2 = editorialAgentRules([{
    kind: "tool_result", tool_use_id: "tu_d",
    content: "Vercel CLI 33.0.0\n  Production: https://habits.app [2s]",
    ts: 2,
  }], state);
  const patch = out2.find(m => m.op === "patch");
  assert.ok(patch);
  assert.equal(patch.props.status, "done");
  assert.match(patch.props.url, /https:\/\/habits\.app/);
});

test("npm run build → `stats` cards (not terminal), result parses bundle/modules/time", () => {
  const state = {};
  editorialAgentRules([{
    kind: "assistant", tool: "Bash", tool_use_id: "tu_b",
    input: { command: "npm run build" }, ts: 1,
  }], state);
  const out = editorialAgentRules([{
    kind: "tool_result", tool_use_id: "tu_b",
    content: "vite build\n  ✓ 142 modules transformed.\n  dist/assets/index.js  82.14 kB\n  ✓ built in 1.31s",
    ts: 2,
  }], state);
  const patch = out.find(m => m.op === "patch");
  assert.ok(patch);
  const labels = patch.props.stats.map(s => s.label);
  assert.ok(labels.includes("Bundle"));
  assert.ok(labels.includes("Modules"));
  assert.ok(labels.includes("Build time"));
});

test("Write of a *schema.ts file with multiple `interface` blocks → `schema` diagram (not diff)", () => {
  const ev = {
    kind: "assistant", tool: "Write", tool_use_id: "tu_w",
    input: {
      file_path: "src/db/schema.ts",
      content: "export interface Habit { id: string; name: string; createdAt: number }\n" +
               "export interface CheckIn { id: string; habitId: string; date: string }",
    },
    ts: 1,
  };
  const out = editorialAgentRules([ev], {});
  const s = out.find(m => m.component?.type === "schema");
  assert.ok(s, "should commit a schema component");
  assert.equal(s.component.props.entities.length, 2);
  assert.equal(s.component.props.entities[0].name, "Habit");
  assert.equal(out.filter(m => m.component?.type === "diff").length, 0, "should NOT also commit a diff");
});

test("Write of a *.tsx component file still produces a diff (schema rule only matches schema/db files)", () => {
  const ev = {
    kind: "assistant", tool: "Write", tool_use_id: "tu_w",
    input: { file_path: "src/components/HabitCard.tsx", content: "export function HabitCard() { return null; }" },
    ts: 1,
  };
  const out = editorialAgentRules([ev], {});
  assert.ok(out.find(m => m.component?.type === "diff"));
  assert.equal(out.filter(m => m.component?.type === "schema").length, 0);
});

test("a short summary-feeling note IS kept", () => {
  const ev = { kind: "assistant", text: "Done — all four tests are green.", ts: 1 };
  const out = editorialAgentRules([ev], {});
  assert.equal(out.find(m => m.component?.type === "note")?.component.props.text,
               "Done — all four tests are green.");
});

test("a long chatty paragraph is NOT kept as a note", () => {
  const ev = { kind: "assistant", text: "x".repeat(900), ts: 1 };
  const out = editorialAgentRules([ev], {});
  assert.equal(out.filter(m => m.component?.type === "note").length, 0);
});
