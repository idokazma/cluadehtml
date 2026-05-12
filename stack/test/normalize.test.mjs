import { test } from "node:test";
import assert from "node:assert/strict";
import { normalize } from "../src/ingest/normalize.mjs";

test("user prompt text becomes a single user event", () => {
  const evs = normalize({
    type: "user",
    message: { content: [{ type: "text", text: "hello" }] },
  });
  assert.equal(evs.length, 1);
  assert.equal(evs[0].kind, "user");
  assert.equal(evs[0].text, "hello");
});

test("user tool_result becomes a tool_result event keyed by tool_use_id", () => {
  const evs = normalize({
    type: "user",
    message: { content: [{ type: "tool_result", tool_use_id: "tu_1", content: "ok" }] },
  });
  assert.equal(evs.length, 1);
  assert.equal(evs[0].kind, "tool_result");
  assert.equal(evs[0].tool_use_id, "tu_1");
  assert.equal(evs[0].content, "ok");
});

test("assistant fans out text + tool_use blocks", () => {
  const evs = normalize({
    type: "assistant",
    message: {
      content: [
        { type: "text", text: "I'll read this file." },
        { type: "tool_use", id: "tu_1", name: "Read", input: { file_path: "src/a.ts" } },
      ],
    },
  });
  assert.equal(evs.length, 2);
  assert.equal(evs[0].kind, "assistant");
  assert.equal(evs[0].text, "I'll read this file.");
  assert.equal(evs[1].kind, "assistant");
  assert.equal(evs[1].tool, "Read");
  assert.equal(evs[1].tool_use_id, "tu_1");
  assert.deepEqual(evs[1].input, { file_path: "src/a.ts" });
});

test("tool_result with array content concatenates text parts", () => {
  const evs = normalize({
    type: "user",
    message: { content: [{ type: "tool_result", tool_use_id: "x", content: [
      { type: "text", text: "line 1" },
      { type: "text", text: "line 2" },
    ] }] },
  });
  assert.equal(evs[0].content, "line 1\nline 2");
});

test("system init passes through with session_id", () => {
  const evs = normalize({ type: "system", subtype: "init", session_id: "abc" });
  assert.equal(evs[0].kind, "system");
  assert.equal(evs[0].session_id, "abc");
});

test("result event passes through", () => {
  const evs = normalize({ type: "result", subtype: "success" });
  assert.equal(evs[0].kind, "result");
});

test("stream_event envelope unwraps inner event", () => {
  const evs = normalize({
    type: "stream_event",
    event: { type: "result", subtype: "success" },
  });
  assert.equal(evs[0].kind, "result");
});

test("unknown shapes become 'unknown' events without crashing", () => {
  const evs = normalize({ type: "weird_new_thing" });
  assert.equal(evs[0].kind, "unknown");
});
