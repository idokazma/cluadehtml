// Session index: scan a sessions dir, summarize each event log.

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { listSessions, readSession } from "../src/store/sessions.mjs";

function tmpDir() {
  const d = path.join(os.tmpdir(), `stack-sessions-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  fs.mkdirSync(d, { recursive: true });
  return d;
}

function writeSession(dir, id, events) {
  fs.writeFileSync(path.join(dir, `${id}.events.jsonl`), events.map(e => JSON.stringify(e)).join("\n") + "\n");
}

test("listSessions returns [] for a non-existent dir", () => {
  assert.deepEqual(listSessions("/nope/never/here"), []);
});

test("summarizes a session's prompt, counts, and highlights", () => {
  const dir = tmpDir();
  writeSession(dir, "abc", [
    { op: "append", component: { id: "user-1", type: "prompt", props: { text: "build a habit tracker" } }, ts: 1700000000000 },
    { op: "append", component: { id: "plan-2", type: "plan", props: { title: "Plan", items: [{ label: "x" }, { label: "y" }] } }, ts: 1700000001000 },
    { op: "append", component: { id: "diff-3", type: "diff", props: { filename: "useHabit.ts", headline: "Streak no longer resets", kind: "bug-fix" } }, ts: 1700000002000 },
    { op: "append", component: { id: "tst-1", type: "tests", props: { command: "npm test", status: "running", passed: 0, failed: 0 } }, ts: 1700000003000 },
    { op: "patch", id: "tst-1", props: { status: "done", passed: 11, failed: 0 }, ts: 1700000004000 },
    { op: "append", component: { id: "ms-4", type: "milestone", props: { title: "Shipped to habits.app", icon: "🚀" } }, ts: 1700000005000 },
  ]);
  try {
    const [s] = listSessions(dir);
    assert.equal(s.id, "abc");
    assert.equal(s.prompt, "build a habit tracker");
    assert.equal(s.startedAt, 1700000000000);
    assert.equal(s.endedAt, 1700000005000);
    assert.equal(s.counts.milestones, 1);
    assert.equal(s.counts.diffs, 1);
    // Milestone should be lifted first (highest priority).
    assert.equal(s.highlights[0].type, "milestone");
    // Patched test counts should be reflected in highlights props.
    const tests = s.highlights.find(h => h.type === "tests");
    assert.equal(tests.props.passed, 11);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("sorts sessions newest-first across multiple", () => {
  const dir = tmpDir();
  writeSession(dir, "old", [{ op: "append", component: { id: "user-1", type: "prompt", props: { text: "old" } }, ts: 1000 }]);
  writeSession(dir, "new", [{ op: "append", component: { id: "user-1", type: "prompt", props: { text: "new" } }, ts: 9000 }]);
  try {
    const sessions = listSessions(dir);
    assert.equal(sessions.length, 2);
    assert.equal(sessions[0].id, "new");
    assert.equal(sessions[1].id, "old");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("skips empty session logs", () => {
  const dir = tmpDir();
  fs.writeFileSync(path.join(dir, "empty.events.jsonl"), "");
  writeSession(dir, "ok", [{ op: "append", component: { id: "u", type: "prompt", props: { text: "x" } }, ts: 1 }]);
  try {
    const sessions = listSessions(dir);
    assert.equal(sessions.length, 1);
    assert.equal(sessions[0].id, "ok");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("readSession returns full event log or null", () => {
  const dir = tmpDir();
  writeSession(dir, "abc", [{ op: "append", component: { id: "u", type: "prompt", props: { text: "hi" } }, ts: 1 }]);
  try {
    assert.equal(readSession(dir, "nope"), null);
    const events = readSession(dir, "abc");
    assert.equal(events.length, 1);
    assert.equal(events[0].component.props.text, "hi");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
