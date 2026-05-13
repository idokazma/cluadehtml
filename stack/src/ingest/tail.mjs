// Tail a Claude Code session JSONL on disk as it grows. Emits normalized
// AgentEvents to onEvent — same downstream contract as runClaude/runReplay.
//
// Unlike the spawn-and-pipe ingest, this attaches to a session the user is
// already running in a normal Claude Code terminal. Read-only: we observe
// the JSONL, we don't drive the session. (Driving via `claude --resume
// <sessionId>` is possible but out of scope here — sessionId is captured in
// the emitted events for a future bidirectional layer.)

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { normalize } from "./normalize.mjs";

/**
 * @param {object} opts
 * @param {string} opts.file              path to the .jsonl session file
 * @param {boolean} [opts.fromStart=true] read existing content, or jump to EOF
 * @param {number} [opts.pollMs=500]      poll interval
 * @param {(ev: import("../types.mjs").AgentEvent) => void} opts.onEvent
 * @param {() => void} [opts.onClose]
 * @returns {{ stop: () => void }}
 */
export function runTail({ file, fromStart = true, pollMs = 500, onEvent, onClose }) {
  let offset = 0;
  let stopped = false;
  let pending = "";  // carry partial trailing line between reads
  let timer = null;

  if (!fromStart) {
    try { offset = fs.statSync(file).size; } catch { /* file may not exist yet */ }
  }

  function schedule() {
    if (stopped) return;
    timer = setTimeout(tick, pollMs);
  }

  function tick() {
    timer = null;
    if (stopped) return;
    let stat;
    try { stat = fs.statSync(file); }
    catch { return schedule(); }            // file not there yet — keep polling

    if (stat.size < offset) {                // truncated / rotated
      offset = 0;
      pending = "";
    }
    if (stat.size > offset) {
      const fd = fs.openSync(file, "r");
      try {
        const len = stat.size - offset;
        const buf = Buffer.alloc(len);
        fs.readSync(fd, buf, 0, len, offset);
        offset = stat.size;
        pending += buf.toString("utf8");
        const lines = pending.split("\n");
        pending = lines.pop() || "";          // keep trailing partial for next tick
        for (const line of lines) {
          const t = line.trim();
          if (!t) continue;
          let json;
          try { json = JSON.parse(t); } catch { continue; }
          if (json?.type === "summary") continue;   // compaction marker — skip
          for (const ev of normalize(json)) onEvent(ev);
        }
      } finally {
        fs.closeSync(fd);
      }
    }
    schedule();
  }

  tick();

  return {
    stop() {
      if (stopped) return;
      stopped = true;
      if (timer) clearTimeout(timer);
      onClose?.();
    },
  };
}

/**
 * Find the most-recently-modified Claude Code session JSONL for the given
 * working directory. Throws if no project dir or no sessions are found.
 *
 * @param {string} [cwd]
 * @returns {string}
 */
export function autoDiscoverSession(cwd = process.cwd()) {
  const encoded = cwd.replace(/\//g, "-");
  const dir = path.join(os.homedir(), ".claude", "projects", encoded);
  if (!fs.existsSync(dir)) {
    throw new Error(`No session dir at ${dir}. Pass --tail <path/to/session.jsonl>.`);
  }
  const files = fs.readdirSync(dir)
    .filter(f => f.endsWith(".jsonl"))
    .map(f => ({ f, m: fs.statSync(path.join(dir, f)).mtimeMs }))
    .sort((a, b) => b.m - a.m);
  if (!files.length) throw new Error(`No .jsonl sessions in ${dir}.`);
  return path.join(dir, files[0].f);
}
