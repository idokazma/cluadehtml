# Build Plan: making the live HTML interface real

> A grounded plan for building the system described in `PHILOSOPHY.md` and
> mocked up in `demo.html` / `project.html`. Researched against Claude Code's
> actual observation points (hooks, Agent SDK, `-p` stream-json, session
> JSONL on disk, MCP, Channels).

## What we're building

A wrapper around Claude Code — call it **`stack`** for now — that turns every
agent session into a live HTML page of interactive components. Each tool call,
text reply, and tool result becomes (or updates) a component in a single
stacked document. The document is the session. Sessions belong to a project
(the cwd / git root). A separate page rolls all the sessions of a project up
into a living briefing.

Three concrete deliverables:

1. **A small wrapper** that launches `claude` (or attaches to a running one),
   observes every event, and emits component mutations.
2. **A local HTTP server + browser page** that subscribes to those mutations
   via SSE and renders/updates the stack.
3. **A persistence + aggregation layer** that stores each session as a
   replayable mutation log and generates a project page from the set.

---

## The observation problem — what to wrap

Research notes (`claude-code-guide` audit of current docs):

| Channel | Gives us | Doesn't |
| --- | --- | --- |
| **Hooks** (`PreToolUse`, `PostToolUse`, `UserPromptSubmit`, `Stop`, `SessionStart`…) | Precise lifecycle points; can block actions; sees tool name + input + result | Does **not** stream assistant text or expose a full event stream; no way to inject content visible to the model in a useful way. *Not a streaming observation channel.* |
| **Claude Agent SDK** (TS / Python) | You run the agent loop; receive typed `AssistantMessage` / `ToolResultMessage` / `ResultMessage` via an async iterator. Stable `session_id`. Best DX. | Locks you to TS or Python; bigger up-front investment; can't easily attach to a session a user started in a terminal. |
| **Headless `claude -p --output-format stream-json --verbose --include-partial-messages`** | Newline-delimited JSON events for every tool_use, tool_result, text delta, and final result. Works against the real CLI. Easy to subprocess from any language. | Non-interactive by default — once started, you don't get nice mid-run user interrupts without restarting with `--resume`. |
| **Tail `~/.claude/projects/<dir-hash>/<session>.jsonl`** | A live JSONL log of an interactive session that the user is running themselves. Updates as the session progresses. | Format isn't a stable public API; can have partial writes; you're a passive observer (can't steer). |
| **MCP server** | Sees calls into *its own* tools; can be used as the channel by which the model "speaks components" to us. | Doesn't see other tool calls — *not* a generic observer. |
| **Channels (MCP, research preview)** | Can push notifications *into* a running session. | Not an observation channel either. |

**Decision.** Build the wrapper with two ingest modes:

- **`stack run "<prompt>"`** — we spawn `claude -p --output-format stream-json …`
  as a subprocess and parse its event stream. Easy, works today.
- **`stack attach`** — we don't spawn anything; we tail
  `~/.claude/projects/<hash>/<id>.jsonl` so a user can keep using their
  normal interactive CLI and the page is just an enriched view.

We can revisit the Agent SDK later (Phase 4+) when we need true bi-directional
mid-session steering. The two modes above cover the MVP cleanly.

---

## The project-attachment problem

Claude Code already attaches sessions to directories. Sessions live at
`~/.claude/projects/<dir-hash>/<session-uuid>.jsonl`, scoped per-cwd, with
resumption via `claude --resume <uuid>`. We adopt the same convention and
shadow it with our own per-project store:

```
<project-cwd>/.stack/
  project.json              — { name, root, created, claude_dir_hash }
  sessions/
    <uuid>.events.jsonl     — our derived component-mutation log
    <uuid>.snapshot.html    — self-contained shareable snapshot
  index.json                — list of sessions w/ summaries, for the project page
```

The project page is generated from `index.json` + live git/CI state. A
session is "attached to a project" simply by being created with that
project's cwd; no extra registration step.

---

## The mapping problem — turning agent events into components

This is the heart of the system. The mapping is the contract between the
agent's stream and the page.

### Stream events we consume

From `claude -p --output-format stream-json` (and the JSONL format):

- `user` — the user's prompt
- `assistant` — content blocks: `text`, `tool_use`
- `tool_result` — keyed by `tool_use_id`
- `result` — final outcome

### Heuristic mapping for built-in tools

| Tool call | Component | Lifecycle |
| --- | --- | --- |
| `TodoWrite` | `plan` | Mutate in place when called again with a new todo list (match by stable component id, not list contents) |
| `Read` | `file-viewer` | Inline with line range |
| `Edit` / `Write` / `NotebookEdit` | `diff` | Show before/after; reversible affordance |
| `Bash` | `terminal` (streaming) | Append output lines as they arrive |
| `Glob` / `Grep` | `search-results` | List with file:line + snippet |
| `WebFetch` / `WebSearch` | `web-result` | Title + summary + link |
| `Task` (subagent) | `subagent` (collapsible, contains a nested stack) | The recursive case |
| Unknown / MCP tool | `tool` (generic fallback) | Name + params + collapsible result |

Text blocks from `assistant` render as a `note` — unless the text is
*mostly* a fenced code block, in which case it becomes a `code` component.

### Bespoke components via MCP

The mapping above covers Claude's standard toolbox, which gets us most of the
demo (plan, diff, terminal, search, code, file tree). The interesting
components from `demo.html` — **decision card, comparison table, design
exploration, theme playground, sparkline stats, schema diagram, deploy
progress** — aren't standard tool calls. They need a way for the model to
*ask for* a specific component to render.

We ship an MCP server, **`stack-mcp`**, exposing tools:

```
render_plan(items[])
render_compare(columns[], rows[])
render_designs(designs[])
render_decision(question, options[])
render_playground(kind, params{})
render_stats(stats[])
render_schema(entities[], relations[])
render_code(filename, lang, code)
render_html(html_string)           # escape hatch — sandboxed iframe
```

When the model wants a comparison table or a slider playground, it calls
one of these. The MCP server is silent on the model side (returns a tiny
ack like `{"id": "cmp-7"}`); the wrapper sees the tool call, knows the
schema, and renders the matching component. The model effectively has
"speak component" as part of its toolbox.

This is the same idea Anthropic's "Channels" feature is hinting at, but
applied in the other direction — model → UI, not UI → model.

### Plain text fallback

When the model emits text that doesn't fit a component, render it as a
`note`. Honour the existing markdown habits Claude already has, but treat
markdown as a fallback medium, not the default. (This matches the
philosophy: components first, markdown if no component fits.)

---

## The rendering & update problem

### Transport: SSE, not WebSockets

The page subscribes to a typed event stream of mutations:

```js
{ op: "append",   parent: "stream",        component: { id, type, props } }
{ op: "patch",    id: "plan-3",            props: { items: [...] } }
{ op: "stream",   id: "term-7",            append: "line of output\n" }
{ op: "finalize", id: "term-7",            meta: { exit: 0 } }
{ op: "day",      num: 2, date: "...",     label: "Iteration" }
```

Server-Sent Events fit perfectly: one-way (server → browser), built into
the browser as `EventSource`, no framing overhead, no backpressure dance,
trivially proxied. WebSockets buy us a return channel we don't need at
this layer (user actions go through a separate `POST /api/prompt` endpoint).

### Page architecture

No framework. The demo's vanilla JS approach is the right scale: a `Map`
keyed by component id, an `el()` helper, per-kind renderers that own their
own update logic. Adding React/Vue would buy us a lot of weight for a UI
whose components are almost entirely independent of each other.

### Local server

A single Node process (~300 lines) does everything:

| Route | Purpose |
| --- | --- |
| `GET /` | Serves the session page shell |
| `GET /events?session=<id>` | SSE stream of mutations |
| `POST /api/prompt` | New user prompt → forwarded to wrapper stdin / new `--resume` |
| `POST /api/action` | Component action (e.g. "pick option 2 of decision") → injected as a follow-up user message |
| `GET /sessions` | Project page (HTML) |
| `GET /sessions.json` | Project page data |
| `GET /static/*` | Page assets |

### Update model

The mapper produces an idempotent stream of `{op, id, …}` events. The
browser applies them in order. Persistence is just appending each event
to `<id>.events.jsonl`. Replay is just re-reading and re-applying.

This means **a session's HTML state == the fold over its event log.** No
hidden state. Easy to snapshot, share, diff.

---

## Build phases

### Phase 0 — Mapper spike *(1–2 days)*

Goal: prove that the stream-json → component mapping is sound.

- Spawn `claude -p --output-format stream-json --verbose --include-partial-messages` against a real repo with a real task.
- Pipe events into a tiny mapper that prints `would render: plan(...) / would render: diff(...) / would render: terminal(...)`.
- Run against 5–10 representative prompts, eyeball the output, refine the mapping table.

**Deliverable:** a transcript of "what components this real session would have produced." No UI yet. This shakes out the mapping decisions before we commit to a page architecture.

### Phase 1 — MVP: live session in the browser *(3–5 days)*

- `stack run "<prompt>"` launches `claude`, runs the mapper, writes `.stack/sessions/<id>.events.jsonl`.
- Local Node server: SSE stream of mutations, replays the log on connect.
- Vanilla-JS page (the existing `demo.html` codebase, pruned to the components from the heuristic map).
- Components in scope: `prompt`, `note`, `plan`, `diff`, `terminal`, `search`, `web-result`, `tool` (generic), `code`.

**Deliverable:** you run `stack run "fix the failing test in src/payments"`, your browser opens, and watches the session play out as a live component stack. The CLI's text scroll is no longer load-bearing.

### Phase 2 — Bespoke components via MCP *(2–3 days)*

- Implement `stack-mcp` with `render_decision`, `render_compare`, `render_playground`, `render_designs`, `render_stats`, `render_schema`, `render_html`.
- Register it with Claude Code in `.stack/mcp.json`. Add a system-prompt nudge: "When the user would benefit from picking, comparing, tuning, or exploring, prefer a `render_*` tool over markdown."
- Real session against a real task that ends up using two or three of these.

**Deliverable:** the more interesting components from the mockup, real.

### Phase 3 — Project page *(2–3 days)*

- `stack open` (or `stack` with no args) serves the project page.
- Generated from `.stack/index.json` (rebuilt from session logs) + live git state (`git status`, `gh pr list`, `gh run list`).
- Sessions grouped by day, "needs attention" pulled from open decisions and failing tests in recent sessions, in-flight from branches/PRs.

**Deliverable:** the `project.html` mockup, real.

### Phase 4 — Interactive components close the loop *(3–5 days)*

The hard part: when the user clicks a "pick" button on a decision card, or drags a slider and hits "copy as prompt", or right-clicks "ask about this" — the response has to make it back into the running session.

- Right-click "ask about this" → POSTs to `/api/prompt` with `@<id> <user text>` and an attached snapshot of the referenced component. Backend forwards via `--resume <session> -p "<prompt>"`.
- Component actions (picking a decision option, accepting a plan, applying playground settings) → POSTs to `/api/action`, which synthesizes a follow-up user message like *"the user picked option 2: 'Manual streak-freeze'"*.
- Either branch the conversation with `--resume` or feed live via stdin (only available with `stack attach` mode in v1).

**Deliverable:** the demo's right-click and `Copy as prompt` flows actually round-trip.

### Phase 5 — Polish & ship *(1–2 weeks)*

- Single-binary distribution (`bun build` or `pkg`), or `npx stack`.
- Auto-open browser on `stack run`. Cross-OS.
- Sandbox `render_html` (iframe with `sandbox=""`, strict CSP).
- Self-contained `<id>.snapshot.html` exporter — entire session inlined, no server needed to view.
- Multi-session aware project page; subagent panels.

---

## Architecture sketch

```
                       ┌─────────────────────────────────────────────────┐
                       │  the user                                       │
                       │  - browser (session.html, project.html)         │
                       │  - terminal (optional; for `stack attach` mode) │
                       └────────────────────┬────────────────────────────┘
                                            │  HTTP + SSE
                                            ▼
                              ┌──────────────────────────┐
                              │  stack server (Node)     │
                              │  - serves pages          │
                              │  - SSE /events           │
                              │  - POST /api/prompt      │
                              │  - POST /api/action      │
                              └────────────┬─────────────┘
                                           │
                  ┌────────────────────────┴───────────────────────────┐
                  │                                                    │
                  ▼                                                    ▼
   ┌──────────────────────────┐                      ┌──────────────────────────────┐
   │   stack run              │                      │   stack attach               │
   │   spawns:                │                      │   no spawn; tails file:      │
   │     claude -p            │                      │     ~/.claude/projects/      │
   │     --output-format      │                      │       <hash>/<id>.jsonl      │
   │     stream-json          │                      │                              │
   └──────────────┬───────────┘                      └──────────────┬───────────────┘
                  │                                                 │
                  └────────────┬────────────────────────────────────┘
                               ▼
                ┌────────────────────────────────┐
                │  the mapper                    │
                │  stream-json/jsonl event  ───► │ component mutation event
                │  - heuristic table             │ { op, id, type, props, ... }
                │  - stack-mcp render_* calls    │
                └─────────────┬──────────────────┘
                              │
                              ▼
        ┌────────────────────────────────────────┐
        │  .stack/sessions/<id>.events.jsonl     │  ← single source of truth.
        │  append-only; replay = page state.     │     page is a fold over this.
        └────────────────────────────────────────┘
```

Two side channels:

- **`stack-mcp` (MCP server)** — registered with Claude Code as a normal MCP
  server. Receives `render_*` tool calls. Doesn't talk to the page directly;
  emits events that the mapper picks up alongside the main stream.
- **User actions** — POSTs from the page that synthesize follow-up prompts.

---

## Tech choices & trade-offs

| Choice | Recommendation | Why |
| --- | --- | --- |
| **Wrap mode** | Subprocess on `claude -p --output-format stream-json` (v1); add `stack attach` (tail JSONL) for sessions the user started themselves | Avoids reimplementing the agent loop; works with whatever version of Claude Code the user has |
| **Wrapper language** | TypeScript (Node) | Same as the demo; SSE in a few lines; bundles to a single binary easily |
| **Frontend** | Vanilla JS, the demo's `el()` + `Map<id, block>` pattern | Components are independent; framework overhead would be pure cost |
| **Transport** | SSE for server→browser; HTTP POST for browser→server | One-way streaming is the natural shape; the return channel is rare and discrete |
| **Storage** | Append-only JSONL of component mutations per session | Diffable, tail-friendly, trivial to back up, snapshot is just a fold |
| **Bespoke components** | MCP server with `render_*` tools | Lets the model "speak components" without inventing a new IO channel; reuses Claude Code's existing tool-use mechanism |
| **HTML escape hatch** | `render_html(string)` rendered into a sandboxed iframe with strict CSP | Lets the model improvise without putting arbitrary code in the host page |
| **Multi-session** | Concurrent JSONL files in `.stack/sessions/` | Append is atomic; project page picks them up by listing the dir |

---

## Open questions & risks

1. **Mid-session steering with `-p`.**
   `--output-format stream-json` is non-interactive. We can re-prompt with
   `--resume <id> -p "<text>"` but that ends one process and starts another,
   which breaks streaming continuity inside long-running tools (`Bash`,
   `Task`). Two mitigations:
   - Accept the break for v1 — every user follow-up *is* a new turn.
   - In v2, switch to the **Agent SDK** for true live multi-turn, where
     stdin-style steering is natural. The mapper is the same; only the
     ingest changes.

2. **Tool result size.**
   `Read` on a 5k-line file, `Grep` with 2000 hits, `Bash` that prints a
   megabyte. The mapper must:
   - Persist the full content in the event log (for replay & search).
   - Render a truncated, expandable component in the page (don't dump
     megabytes into the DOM).

3. **Model-emitted HTML is dangerous.**
   `render_html` is powerful but a foot-gun. Mitigations:
   - Render only inside `<iframe sandbox=""></iframe>` — no JS by default,
     opt-in via `sandbox="allow-scripts"` with a strict CSP that forbids
     network calls and same-origin access.
   - Document the threat model. Treat as a power-user toggle, off by default
     for projects you don't trust.

4. **Subagents.**
   When the agent spawns a `Task` subagent, its events stream nested inside
   the parent. The page handles this by recursively rendering a `subagent`
   component that itself contains a (collapsible) child stack. The same
   renderer code applies. No new concept — just nesting.

5. **JSONL is not a stable public API.**
   `~/.claude/projects/<hash>/<id>.jsonl` works today but isn't versioned.
   The mapper should be tolerant — unknown event types render as a generic
   `tool` component, never crash. Pin to a known Claude Code version range
   in `package.json` and test against new releases in CI.

6. **Two terminals on one project.**
   Concurrent `stack run` against the same cwd write to distinct
   `<uuid>.events.jsonl` files. The project page lists both. No locking
   needed.

7. **What about the existing terminal scroll?**
   Two viable modes:
   - **Stack mode**: `stack run` *replaces* the visible CLI output with a
     spinner + "open browser →"; the page is the experience.
   - **Stack alongside**: `claude` runs normally and `stack attach` opens
     the page in parallel as an enriched view. Easier first foothold for
     existing users; both can coexist.

---

## What this unlocks later

Things that get cheap once the foundation is in place:

- **Shareable sessions.** A single `<id>.snapshot.html` file with everything
  inlined — send it on Slack, paste it into a PR description.
- **Session diffs.** Run the same prompt against two branches, see what
  changed in the component stack.
- **Project memory.** The project page accumulates the decisions, schemas,
  design choices the agent made — query-able across sessions ("what did we
  decide about auth?").
- **Cross-session references.** `@dec-7` in a new session can resolve to a
  decision card from three sessions ago.
- **Multi-agent views.** Parallel subagents get separate panels in the same
  page, updating concurrently.
- **A real onboarding experience.** New contributor opens the project page,
  reads the briefing, picks a "needs attention" card, gets dropped into a
  session targeted at that problem.

---

## What to build first, in one sentence

A **mapper spike** that pipes `claude -p --output-format stream-json` into a
script that prints "would render: plan / would render: diff / would render:
terminal" — because the entire design hinges on whether that mapping table
holds up against real sessions, and we can test it without writing a single
line of UI.
