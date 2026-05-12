# stack

A live HTML interface for Claude Code sessions. Wraps a session, runs
its events through an editorial pipeline, and renders the result as a
single page of stacked, interactive components — bidirectional: clicks
on components become inputs to the session.

This is **Phase 0+1+3 of `BUILD_PLAN.md`**, ie. the full skeleton:
ingest, prefilter, rule-based editorial pass, SSE server, page,
event log, action round-trip. The interface agent is implemented as
rules in `src/pipeline/interface-agent.mjs` with a clearly-marked
seam for swapping in a Haiku call against `prompts/interface-agent.md`.

## Run it

No dependencies. Requires Node 20+.

**Replay a fixture** (works without a real `claude` install):

```sh
node bin/stack.mjs run --replay fixtures/habits-day1.jsonl   # short (~17s)
node bin/stack.mjs run --replay fixtures/habits-3day.jsonl   # long (~75s)
```

Open `http://localhost:3737/` in your browser. The simulated session
plays out as components stack into the page; exploratory tool calls
fold into the activity indicator at the bottom.

**Run against a real `claude` session** (requires `claude` CLI in `PATH`):

```sh
node bin/stack.mjs run "fix the failing test in src/payments"
```

## What's in the box

```
stack/
  bin/stack.mjs                       — CLI entry
  src/
    types.mjs                         — JSDoc type defs
    ingest/
      claude.mjs                      — spawn `claude -p --output-format stream-json`
      replay.mjs                      — feed events from a fixture, paced
      normalize.mjs                   — wire envelopes -> flat AgentEvent
    pipeline/
      prefilter.mjs                   — buffer + activity updates + auto-commits
      interface-agent.mjs             — editorial pass (rules; LLM stub)
    server/
      index.mjs                       — HTTP + SSE
      synthesize.mjs                  — UserAction -> follow-up user message
    store/
      log.mjs                         — append-only events.jsonl (commits only)
      ids.mjs                         — stable component ids
  page/
    session.html                      — page shell
    session.css                       — styles
    session.js                        — SSE consumer + renderers + action POSTs
  fixtures/
    habits-day1.jsonl                 — one-day simulated session
  prompts/
    interface-agent.md                — the editorial system prompt
```

## How it flows

```
claude -p stream-json (or replay)
        │
        ▼
   normalize → AgentEvent
        │
        ├──► prefilter   ── activity / auto-commits (e.g. TodoWrite → plan)
        │                          │
        └──► interface-agent ───  commits (decision, diff, terminal, note, ...)
                                   │
                                   ▼
                         emit() ─► .stack/sessions/<id>.events.jsonl   (commits only — log)
                                   │
                                   └► SSE broadcast ──► browser page applies mutation

   browser interaction (click decision option)
                                   │
                                   ▼
                            POST /api/action
                                   │
                                   ▼
                       synthesizeUserMessage()
                                   │
                                   ▼
                  in `stack run`: claude --resume <id> -p "<synthesized>"
                  in `--replay`:  echoed back as a prompt component
```

## What's wired

- **End-to-end stream → page.** Ingest, normalize, prefilter, editorial
  rules, SSE, page renderers all connected. `node bin/stack.mjs run
  --replay fixtures/habits-day1.jsonl` produces a real page in the
  browser.
- **The activity indicator.** Most exploratory tool calls fold into a
  single live indicator at the bottom of the page, not committed
  components. Drill-down drawer included.
- **Editorial commits.** `TodoWrite` → plan (and updates the same
  component on subsequent calls). `Edit`/`Write` → diff. Long-running
  `Bash` (npm test, vitest, deploy…) → streaming terminal. Prose
  containing numbered options + a question → decision card.
- **Bidirectional actions.** Clicking a decision option POSTs to
  `/api/action`; the server synthesizes a follow-up user message and
  injects it back (replay mode: visible in the page; run mode: via
  `claude --resume <id> -p`).
- **Activity events are transient.** Not written to `events.jsonl`.
  Replay on connect gives a fresh tab the full committed state and
  picks up live mutations from there.
- **Action queueing.** Actions that arrive mid-turn are buffered and
  flushed when the turn settles.

## What's stubbed

- **The real Haiku call.** `editorialAgentLLM()` in
  `src/pipeline/interface-agent.mjs` falls through to the rules
  implementation today. The system prompt is in
  `prompts/interface-agent.md` and the request shape is sketched in
  the function's comment — swap the body in when `ANTHROPIC_API_KEY`
  is set.
- **`stack-mcp`** (the `render_*` explicit-emission MCP server) is
  not implemented yet (Phase 5).
- **Project page** is not implemented yet (Phase 4). Sessions are
  already attached to a project (cwd's `.stack/sessions/`); reading
  that across sessions is the next layer.
- **Snapshot HTML export** is not implemented.

## Tests

```sh
npm test           # all (~30s — includes the smoke test)
npm run test:unit  # unit tests only (~1s)
npm run test:smoke # end-to-end through the HTTP server (~25s)
```

Coverage:

| File | Covers |
| --- | --- |
| `test/normalize.test.mjs` | wire-envelope shapes → flat `AgentEvent` |
| `test/prefilter.test.mjs` | activity vs auto-commit; `TodoWrite` patch-in-place |
| `test/interface-agent.test.mjs` | `Edit`/`Write` → diff; numbered-options text → decision; long-running `Bash` → streaming terminal; short summaries → note; long prose ignored |
| `test/synthesize.test.mjs` | each `UserAction` kind → the right synthesized message |
| `test/log.test.mjs` | activity events not persisted; commits persisted in order |
| `test/smoke.test.mjs` | full pipeline through the live HTTP server: replay fixture → exact component types & counts; `POST /api/action` round-trips a decision pick into a synthesized prompt |

## Verify it works manually

```sh
node bin/stack.mjs run --replay fixtures/habits-day1.jsonl &
sleep 18 && curl -s http://localhost:3737/api/state | head -50
```

You should see a Map of components with one `prompt`, one `plan` (with
items completed/active reflecting the latest `TodoWrite`), one or two
`diff`s, one `terminal` (finalized), and one `decision`.

Open the page in a browser to interact. Right-click a component → "Ask
claude about this" drops a reference into the composer.
