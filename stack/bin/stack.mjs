#!/usr/bin/env node
// stack — wraps a Claude Code session and renders it as a live HTML
// page of interactive components.
//
// Usage:
//   stack run "<prompt>"                  ← spawn `claude -p ...`
//   stack run --replay <file.jsonl>       ← replay a stream-json fixture
//   stack run --tail [<file.jsonl>]       ← attach to an existing session on disk
//   stack run --tail --port 4000          ← --tail with no path auto-discovers
//
// The browser opens to http://localhost:3737/ by default.

import path from "node:path";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { runReplay } from "../src/ingest/replay.mjs";
import { runClaude } from "../src/ingest/claude.mjs";
import { runTail, autoDiscoverSession } from "../src/ingest/tail.mjs";
import { prefilter } from "../src/pipeline/prefilter.mjs";
import { editorialAgentRules, editorialAgentLLM } from "../src/pipeline/interface-agent.mjs";
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

async function main(opts) {
  const { prompt, replayFile, tailFile, tailAuto, port } = opts;
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
    // In replay / tail modes, we have nowhere to send it — show it on the
    // page as a synthetic user prompt and emit a stub assistant note so
    // the bidirectional loop is visible end-to-end. Tail mode could one
    // day drive the user's session via `claude --resume <sessionId>`; for
    // now it's strictly observational.
    if (replayFile || tailFile || tailAuto) {
      const modeNote = replayFile
        ? "(replay mode — would send to `claude --resume ...`)"
        : "(tail mode — observing only; not wired to drive the live session)";
      emit({
        op: "append",
        component: { id: `user-${Date.now()}`, type: "prompt", props: { text } },
        ts: Date.now(),
      });
      setTimeout(() => emit({
        op: "append",
        component: { id: `note-${Date.now()}`, type: "note", props: { text: modeNote } },
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

  // ---- editorial-agent batching --------------------------------------------
  // Prefilter stays synchronous and per-event (so the activity indicator
  // stays live). Editorial events get buffered until a turn boundary, then
  // flushed as a chunk to the (possibly LLM-backed) interface agent. Calls
  // are queued sequentially so commits stay in order even when the LLM is
  // slow.

  const TURN_QUIET_MS = 1500;
  let turnBuffer = [];
  let turnFlushTimer = null;
  let editorialChain = Promise.resolve();
  const editorial = opts.useLLM ? editorialAgentLLM : editorialAgentRules;

  function flushTurn() {
    if (turnFlushTimer) { clearTimeout(turnFlushTimer); turnFlushTimer = null; }
    if (turnBuffer.length === 0) return;
    const chunk = turnBuffer;
    turnBuffer = [];
    editorialChain = editorialChain.then(async () => {
      const muts = await editorial(chunk, pipelineState);
      for (const m of muts) emit(m);
    }).catch(e => console.error("[editorial]", e));
  }

  function handleEvent(ev) {
    if (ev.kind === "system" && ev.raw?.subtype === "init") return;

    // A new user prompt opens a new turn — flush whatever came before.
    if (ev.kind === "user" && ev.text != null && turnBuffer.length > 0) {
      flushTurn();
    }
    if (ev.kind === "user" && ev.text != null) {
      pipelineState._lastUserPrompt = ev.text;
    }

    // Prefilter is synchronous and immediate (activity indicator, plan card).
    for (const m of prefilter(ev, pipelineState)) emit(m);

    // Result events bound an agent turn in wrap mode — never carry them in.
    if (ev.kind === "result") {
      flushTurn();
      turnInFlight = false;
      flushPending();
      return;
    }

    // Everything else gets buffered for the editorial pass.
    turnBuffer.push(ev);

    // Tail / replay modes don't get `result` events, so debounce as fallback.
    if (turnFlushTimer) clearTimeout(turnFlushTimer);
    turnFlushTimer = setTimeout(flushTurn, TURN_QUIET_MS);
  }

  function emit(m) {
    if (m.op !== "activity") {
      log.write(m);
      applyToState(components, m);
    }
    server.broadcast(m);
  }

  console.log(`session:  ${sessionId}`);
  console.log(`log:      ${log.path}`);
  console.log(`editor:   ${opts.useLLM ? "LLM (Haiku, cached) — falls back to rules" : "rules"}`);

  async function onIngestClose(label) {
    flushTurn();
    await editorialChain;
    turnInFlight = false;
    flushPending();
    console.log(`\n[${label}] complete`);
  }

  if (replayFile) {
    console.log(`replay:   ${replayFile}\n`);
    turnInFlight = true;
    await runReplay({
      file: path.resolve(process.cwd(), replayFile),
      onEvent: handleEvent,
      onClose: () => onIngestClose("replay"),
    });
  } else if (tailFile || tailAuto) {
    const resolved = tailFile
      ? path.resolve(process.cwd(), tailFile)
      : autoDiscoverSession(process.cwd());
    console.log(`tail:     ${resolved}\n`);
    turnInFlight = false;   // tail never sees a `result` turn boundary
    const tailer = runTail({
      file: resolved,
      onEvent: handleEvent,
      onClose: () => console.log("\n[tail] stopped"),
    });
    const stop = async () => { tailer.stop(); flushTurn(); await editorialChain; process.exit(0); };
    process.on("SIGINT", stop);
    process.on("SIGTERM", stop);
  } else {
    console.log(`prompt:   ${prompt}\n`);
    turnInFlight = true;
    runClaude({
      prompt,
      cwd: process.cwd(),
      onEvent: handleEvent,
      onClose: () => onIngestClose("claude"),
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
  // Auto-pick the LLM agent if an API key is in the env; --llm/--no-llm overrides.
  out.useLLM = !!process.env.ANTHROPIC_API_KEY;
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--replay") out.replayFile = args[++i];
    else if (a === "--tail") {
      const next = args[i + 1];
      if (next && !next.startsWith("--")) { out.tailFile = next; i++; }
      else out.tailAuto = true;
    }
    else if (a === "--port") out.port = parseInt(args[++i], 10);
    else if (a === "--llm") out.useLLM = true;
    else if (a === "--no-llm") out.useLLM = false;
    else if (!a.startsWith("--")) out.prompt = a;
  }
  return out;
}
