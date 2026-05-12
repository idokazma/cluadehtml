import { test } from "node:test";
import assert from "node:assert/strict";
import { synthesizeUserMessage } from "../src/server/synthesize.mjs";

const noComps = new Map();

test("pick: reference-and-narrate with label + desc", () => {
  const msg = synthesizeUserMessage(
    { id: "dec-7", kind: "pick", payload: { option: 2, label: "Manual freeze", desc: "Tap before midnight" } },
    noComps,
  );
  assert.match(msg, /\[interaction with @dec-7\]/);
  assert.match(msg, /Picked Manual freeze/);
  assert.match(msg, /Tap before midnight/);
});

test("apply: lists params one per line", () => {
  const msg = synthesizeUserMessage(
    { id: "play-3", kind: "apply", payload: { params: { duration: 280, scale: 1.5 } } },
    noComps,
  );
  assert.match(msg, /@play-3/);
  assert.match(msg, /duration: 280/);
  assert.match(msg, /scale: 1\.5/);
});

test("toggle: names the step number and the new state", () => {
  const msg = synthesizeUserMessage(
    { id: "plan-1", kind: "toggle", payload: { step: 3, done: true } },
    noComps,
  );
  assert.match(msg, /step 3 as done/);
});

test("revert: requests reverting the change", () => {
  const msg = synthesizeUserMessage(
    { id: "diff-9", kind: "revert", payload: {} },
    noComps,
  );
  assert.match(msg, /reverting this change/);
});

test("edit: verbatim-insert the new code with file reference", () => {
  const comps = new Map([["code-5", { id: "code-5", type: "code", props: { filename: "x.ts", code: "old" } }]]);
  const msg = synthesizeUserMessage(
    { id: "code-5", kind: "edit", payload: { new_code: "new code" } },
    comps,
  );
  assert.match(msg, /@code-5 \(x\.ts\)/);
  assert.match(msg, /Use this version instead/);
  assert.match(msg, /```\nnew code\n```/);
});

test("ask: verbatim-insert the user's text with a reference block", () => {
  const msg = synthesizeUserMessage(
    { id: "diff-5", kind: "ask", payload: { text: "why is the gap check inverted?" } },
    noComps,
  );
  assert.match(msg, /\[reference: @diff-5\]/);
  assert.match(msg, /why is the gap check inverted\?/);
});
