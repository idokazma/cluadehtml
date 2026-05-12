#!/usr/bin/env node
// stack — wraps a Claude Code session and renders it as a live HTML
// page of interactive components.
//
// Usage:
//   stack run "<prompt>"                  ← spawn `claude -p ...`
//   stack run --replay <file.jsonl>       ← replay a stream-json fixture
//   stack run --replay <file> --port 4000
//
// The browser opens to http://localhost:3737/ by default.

import path from "node:path";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { runReplay } from "../src/ingest/replay.mjs";
import { runClaude } from "../src/ingest/claude.mjs";
import { prefilter } from "../src/pipeline/prefilter.mjs";
import { editorialAgentRules } from "../src/pipeline/interface-agent.mjs";
import { startServer } from "../src/server/index.mjs";
import { SessionLog } from "../src/store/log.mjs";
import { synthesizeUserMessage } from "../src/server/synthesize.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);

if (args[0] !== "run" || args.length < 2) {
  console.error("usage: stack run \"<prompt>\"   |   stack run --replay <file.jsonl>");
  process.exit(1);
}

const opts = parseOpts(args.slice(1));
main(opts).catch(e => { console.error(e); process.exit(1); });

async function main({ prompt, replayFile, port }) {
  const sessionId = randomUUID();
  const sessionDir = path.resolve(process.cwd(), ".stack", "sessions");
  const log = new SessionLog(sessionDir, sessionId);

  // In-memory page state — mirrors what the browser will hold.
  /** @type {Map<string, import("../src/types.mjs").Component>} */
  const components = new Map();

  // Shared mutable state between prefilter and editorial agent.
  const pipelineState = {};

  // Action queue: actions that arrive while the agent is mid-turn are
  // held here and flushed once the turn settles (we use the
  // "result" event as the settle marker).
  let turnInFlight = false;
  const pendingActions = [];
  const pendingPrompts = [];

  const server = startServer({
    port,
    replay: () => log.readAll(),
    getState: () => components,
    onAction: (action) => {
      action.ts = Date.now();
      if (turnInFlight) { pendingActions.push(action); console.log("[action] queued"); }
      else flushAction(action);
    },
    onPrompt: (text) => {
      if (!text.trim()) return;
      if (turnInFlight) pendingPrompts.push(text);
      else followUp(text);
    },
  });

  function flushAction(action) {
    const msg = synthesizeUserMessage(action, components);
    console.log("[action]", action.kind, "@" + action.id, "→ synthesized prompt");
    followUp(msg);
  }

  function flushPending() {
    while (pendingActions.length) flushAction(pendingActions.shift());
    while (pendingPrompts.length) followUp(pendingPrompts.shift());
  }

  function followUp(text) {
    // In replay mode, we have nowhere to send it — show it on the page
    // as a synthetic user prompt and emit a stub assistant note so the
    // bidirectional loop is visible end-to-end.
    if (replayFile) {
      emit({
        op: "append",
        component: { id: `user-${Date.now()}`, type: "prompt", props: { text } },
        ts: Date.now(),
      });
      setTimeout(() => emit({
        op: "append",
        component: { id: `note-${Date.now()}`, type: "note", props: { text: "(replay mode — would send to `claude --resume ...`)" } },
        ts: Date.now(),
      }), 400);
      return;
    }
    // Live mode: re-enter the agent loop with --resume.
    turnInFlight = true;
    runClaude({
      prompt: text,
      cwd: process.cwd(),
      resumeId: sessionId,
      onEvent: handleEvent,
      onClose: () => { turnInFlight = false; flushPending(); },
    });
  }

  function handleEvent(ev) {
    if (ev.kind === "system" && ev.raw?.subtype === "init") return;
    if (ev.kind === "result") { turnInFlight = false; }

    // run prefilter + editorial in sequence (v0). In prod these would
    // be parallel with the editorial pass arriving slightly later.
    const a = prefilter(ev, pipelineState);
    const b = editorialAgentRules([ev], pipelineState);
    for (const m of [...a, ...b]) emit(m);

    if (ev.kind === "result") flushPending();
  }

  function emit(m) {
    if (m.op !== "activity") {
      log.write(m);
      applyToState(components, m);
    }
    server.broadcast(m);
  }

  console.log(`session: ${sessionId}`);
  console.log(`log:     ${log.path}`);

  if (replayFile) {
    console.log(`replay:  ${replayFile}\n`);
    turnInFlight = true;
    await runReplay({
      file: path.resolve(process.cwd(), replayFile),
      onEvent: handleEvent,
      onClose: () => { turnInFlight = false; flushPending(); console.log("\n[replay] complete"); },
    });
  } else {
    console.log(`prompt:  ${prompt}\n`);
    turnInFlight = true;
    runClaude({
      prompt,
      cwd: process.cwd(),
      onEvent: handleEvent,
      onClose: () => { turnInFlight = false; flushPending(); console.log("\n[claude] done"); },
    });
  }
}

function applyToState(map, m) {
  if (m.op === "append") map.set(m.component.id, m.component);
  else if (m.op === "patch") {
    const c = map.get(m.id); if (c) c.props = { ...c.props, ...m.props };
  }
}

function parseOpts(args) {
  const out = { port: 3737 };
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--replay") out.replayFile = args[++i];
    else if (a === "--port") out.port = parseInt(args[++i], 10);
    else if (!a.startsWith("--")) out.prompt = a;
  }
  return out;
}
