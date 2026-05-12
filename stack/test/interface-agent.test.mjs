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

test("long-running Bash auto-commits a streaming terminal", () => {
  const state = {};
  const ev = {
    kind: "assistant", tool: "Bash", tool_use_id: "tu_b",
    input: { command: "npm test --silent" },
    ts: 1,
  };
  const out = editorialAgentRules([ev], state);
  const t = out.find(m => m.component?.type === "terminal");
  assert.ok(t, "should commit a terminal");
  assert.equal(t.component.props.command, "npm test --silent");
  assert.equal(t.component.props.status, "running");
});

test("non-test Bash does NOT auto-commit a terminal", () => {
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
    input: { command: "vitest run" }, ts: 1,
  }], state);
  const out = editorialAgentRules([{
    kind: "tool_result", tool_use_id: "tu_b", content: "7 passed\n", ts: 2,
  }], state);
  const ops = out.map(m => m.op);
  assert.deepEqual(ops, ["stream", "finalize"]);
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
