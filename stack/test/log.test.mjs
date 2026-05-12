import { test } from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import fs from "node:fs";
import path from "node:path";
import { SessionLog } from "../src/store/log.mjs";

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "stack-test-"));
}

test("activity mutations are NOT persisted", () => {
  const dir = tmpDir();
  const log = new SessionLog(dir, "s1");
  log.write({ op: "activity", state: { name: "x", status: "running" }, ts: 1 });
  assert.equal(log.readAll().length, 0);
});

test("commit mutations are persisted in order", () => {
  const dir = tmpDir();
  const log = new SessionLog(dir, "s2");
  log.write({ op: "append", component: { id: "a-1", type: "note", props: { text: "hi" } }, ts: 1 });
  log.write({ op: "patch", id: "a-1", props: { text: "hello" }, ts: 2 });
  log.write({ op: "activity", state: { name: "drop me", status: "running" }, ts: 3 });
  log.write({ op: "stream", id: "term-1", append: "line\n", ts: 4 });

  const all = log.readAll();
  assert.equal(all.length, 3);
  assert.deepEqual(all.map(m => m.op), ["append", "patch", "stream"]);
});

test("new SessionLog wipes the previous file (no implicit resume in v0)", () => {
  const dir = tmpDir();
  const log = new SessionLog(dir, "s3");
  log.write({ op: "append", component: { id: "a", type: "note", props: {} }, ts: 1 });
  assert.equal(log.readAll().length, 1);

  const log2 = new SessionLog(dir, "s3");
  assert.equal(log2.readAll().length, 0);
});
