// Replay an offline fixture as if it were live `claude -p` output.
// Each line is one stream-json wire envelope; we pace them so the
// session feels live in the browser.

import fs from "node:fs";
import readline from "node:readline";
import { normalize } from "./normalize.mjs";

/**
 * @param {object} opts
 * @param {string} opts.file        path to a .jsonl fixture
 * @param {number} [opts.gapMs]     default gap between events (ms)
 * @param {(ev: import("../types.mjs").AgentEvent) => void} opts.onEvent
 * @param {() => void} opts.onClose
 */
export async function runReplay({ file, gapMs = 350, onEvent, onClose }) {
  const stream = fs.createReadStream(file);
  const rl = readline.createInterface({ input: stream });
  for await (const line of rl) {
    const t = line.trim();
    if (!t) continue;
    let json;
    try { json = JSON.parse(t); } catch { continue; }
    // Allow per-line pacing override: `{"_pace": 1200, ...event}`
    const pace = (json && json._pace) || gapMs;
    if (json && json._pace != null) delete json._pace;
    for (const ev of normalize(json)) onEvent(ev);
    await sleep(pace);
  }
  onClose();
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
