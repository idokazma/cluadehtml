import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { prefilter } from "../src/pipeline/prefilter.mjs";
import { resetIds } from "../src/store/ids.mjs";

beforeEach(() => resetIds());

test("user event becomes a prompt append", () => {
  const out = prefilter({ kind: "user", text: "hi", ts: 1 }, {});
  assert.equal(out.length, 1);
  assert.equal(out[0].op, "append");
  assert.equal(out[0].component.type, "prompt");
  assert.equal(out[0].component.props.text, "hi");
});

test("assistant text emits an activity update, not a component", () => {
  const out = prefilter({ kind: "assistant", text: "thinking…", ts: 1 }, {});
  assert.equal(out.length, 1);
  assert.equal(out[0].op, "activity");
  // crucially: no committed component for a text-only chunk
  assert.equal(out.find(m => m.op === "append"), undefined);
});

test("TodoWrite auto-commits as a plan (with active/done flags)", () => {
  const state = {};
  const out = prefilter({
    kind: "assistant",
    tool: "TodoWrite",
    tool_use_id: "tu_1",
    input: { todos: [
      { content: "A", status: "completed" },
      { content: "B", status: "in_progress" },
      { content: "C", status: "pending" },
    ] },
    ts: 1,
  }, state);

  assert.equal(out.length, 1);
  assert.equal(out[0].op, "append");
  assert.equal(out[0].component.type, "plan");
  const items = out[0].component.props.items;
  assert.equal(items[0].done, true);
  assert.equal(items[1].active, true);
  assert.equal(items[2].done, false);
  assert.equal(items[2].active, false);
});

test("TodoWrite called a second time emits a patch, not a new append", () => {
  const state = {};
  prefilter({ kind: "assistant", tool: "TodoWrite", tool_use_id: "tu_1",
    input: { todos: [{ content: "A", status: "pending" }] }, ts: 1 }, state);

  const out = prefilter({ kind: "assistant", tool: "TodoWrite", tool_use_id: "tu_2",
    input: { todos: [{ content: "A", status: "completed" }] }, ts: 2 }, state);

  assert.equal(out[0].op, "patch");
  assert.equal(out[0].id, state.planComponentId);
  assert.equal(out[0].props.items[0].done, true);
});

test("Read updates the activity indicator, not a committed component", () => {
  const state = {};
  const out = prefilter({
    kind: "assistant", tool: "Read", tool_use_id: "tu_r",
    input: { file_path: "src/payments/charge.ts" }, ts: 1,
  }, state);

  assert.equal(out.length, 1);
  assert.equal(out[0].op, "activity");
  assert.match(out[0].state.name, /charge\.ts/);
});

test("tool_result marks the latest activity step as done with a duration", () => {
  const state = {};
  prefilter({ kind: "assistant", tool: "Bash", tool_use_id: "tu_b",
    input: { command: "ls" }, ts: 1000 }, state);
  const out = prefilter({ kind: "tool_result", tool_use_id: "tu_b", content: "ok", ts: 1450 }, state);

  assert.equal(out[0].op, "activity");
  const last = out[0].state.recent.at(-1);
  assert.equal(last.status, "done");
  assert.equal(last.metric, "450ms");
});

test("result event flips activity to idle", () => {
  const out = prefilter({ kind: "result", ts: 1 }, {});
  assert.equal(out[0].state.status, "idle");
});
