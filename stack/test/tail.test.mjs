// Tail-mode ingest: write to a JSONL on disk, verify events arrive.

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { runTail } from "../src/ingest/tail.mjs";

function tmpFile() {
  return path.join(os.tmpdir(), `stack-tail-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}.jsonl`);
}
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

test("tails a file that starts empty and grows", async () => {
  const file = tmpFile();
  fs.writeFileSync(file, "");
  const events = [];
  const tailer = runTail({ file, pollMs: 30, onEvent: (e) => events.push(e) });
  try {
    fs.appendFileSync(file, JSON.stringify({
      type: "assistant",
      message: { role: "assistant", content: [{ type: "text", text: "hi" }] },
    }) + "\n");
    await sleep(120);
    assert.equal(events.length, 1);
    assert.equal(events[0].kind, "assistant");
    assert.equal(events[0].text, "hi");

    fs.appendFileSync(file, JSON.stringify({
      type: "assistant",
      message: { role: "assistant", content: [{ type: "tool_use", id: "tu_1", name: "Read", input: { file_path: "/tmp/x" } }] },
    }) + "\n");
    await sleep(120);
    assert.equal(events.length, 2);
    assert.equal(events[1].tool, "Read");
    assert.equal(events[1].input.file_path, "/tmp/x");
  } finally {
    tailer.stop();
    fs.unlinkSync(file);
  }
});

test("reads existing content from the start by default", async () => {
  const file = tmpFile();
  fs.writeFileSync(file,
    JSON.stringify({ type: "user", message: { role: "user", content: "kick off" } }) + "\n" +
    JSON.stringify({ type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "ok" }] } }) + "\n"
  );
  const events = [];
  const tailer = runTail({ file, pollMs: 30, onEvent: (e) => events.push(e) });
  await sleep(120);
  tailer.stop();
  fs.unlinkSync(file);
  assert.equal(events.length, 2);
  assert.equal(events[0].kind, "user");
  assert.equal(events[0].text, "kick off");
  assert.equal(events[1].kind, "assistant");
});

test("fromStart:false jumps to EOF and only reports new lines", async () => {
  const file = tmpFile();
  fs.writeFileSync(file, JSON.stringify({ type: "user", message: { role: "user", content: "old" } }) + "\n");
  const events = [];
  const tailer = runTail({ file, fromStart: false, pollMs: 30, onEvent: (e) => events.push(e) });
  await sleep(80);
  fs.appendFileSync(file, JSON.stringify({ type: "user", message: { role: "user", content: "new" } }) + "\n");
  await sleep(120);
  tailer.stop();
  fs.unlinkSync(file);
  assert.equal(events.length, 1);
  assert.equal(events[0].text, "new");
});

test("handles partial trailing lines across reads", async () => {
  const file = tmpFile();
  fs.writeFileSync(file, "");
  const events = [];
  const tailer = runTail({ file, pollMs: 30, onEvent: (e) => events.push(e) });
  try {
    const json = JSON.stringify({ type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "split" }] } });
    fs.appendFileSync(file, json.slice(0, 20));     // partial
    await sleep(80);
    assert.equal(events.length, 0, "partial line should not emit yet");
    fs.appendFileSync(file, json.slice(20) + "\n"); // complete it
    await sleep(120);
    assert.equal(events.length, 1);
    assert.equal(events[0].text, "split");
  } finally {
    tailer.stop();
    fs.unlinkSync(file);
  }
});

test("ignores summary entries (compaction markers)", async () => {
  const file = tmpFile();
  fs.writeFileSync(file,
    JSON.stringify({ type: "summary", summary: "compaction" }) + "\n" +
    JSON.stringify({ type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "real" }] } }) + "\n"
  );
  const events = [];
  const tailer = runTail({ file, pollMs: 30, onEvent: (e) => events.push(e) });
  await sleep(120);
  tailer.stop();
  fs.unlinkSync(file);
  assert.equal(events.length, 1);
  assert.equal(events[0].text, "real");
});

test("polls patiently for a file that doesn't exist yet", async () => {
  const file = tmpFile();
  const events = [];
  const tailer = runTail({ file, pollMs: 30, onEvent: (e) => events.push(e) });
  await sleep(80);
  fs.writeFileSync(file, JSON.stringify({ type: "user", message: { role: "user", content: "late" } }) + "\n");
  await sleep(150);
  tailer.stop();
  fs.unlinkSync(file);
  assert.equal(events.length, 1);
  assert.equal(events[0].text, "late");
});
