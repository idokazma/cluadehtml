// Spawn `claude -p --output-format stream-json --verbose
// --include-partial-messages` and emit normalized events as they
// stream in.
//
// In v0 we never feed stdin to the subprocess; follow-up turns are
// done via `claude --resume <id> -p "<text>"`, started fresh each
// time (see server/route.mjs).

import { spawn } from "node:child_process";
import readline from "node:readline";
import { normalize } from "./normalize.mjs";

/**
 * @param {object} opts
 * @param {string} opts.prompt
 * @param {string} [opts.cwd]
 * @param {string} [opts.resumeId]
 * @param {(ev: import("../types.mjs").AgentEvent) => void} opts.onEvent
 * @param {() => void} opts.onClose
 */
export function runClaude({ prompt, cwd, resumeId, onEvent, onClose }) {
  const args = ["-p", prompt, "--output-format", "stream-json", "--verbose"];
  if (resumeId) args.unshift("--resume", resumeId);
  const child = spawn("claude", args, { cwd: cwd || process.cwd(), stdio: ["ignore", "pipe", "pipe"] });

  const rl = readline.createInterface({ input: child.stdout });
  rl.on("line", (line) => {
    line = line.trim();
    if (!line) return;
    let json;
    try { json = JSON.parse(line); } catch {
      console.error("[ingest] non-JSON line:", line.slice(0, 120));
      return;
    }
    for (const ev of normalize(json)) onEvent(ev);
  });

  child.stderr.on("data", (b) => {
    process.stderr.write("[claude stderr] " + b);
  });
  child.on("close", (code) => {
    if (code !== 0) console.error("[ingest] claude exited with code", code);
    onClose();
  });
  child.on("error", (err) => {
    console.error("[ingest] claude spawn error:", err.message);
    onClose();
  });

  return { child };
}
