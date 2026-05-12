# Build Plan: making the live HTML interface real

> A grounded plan for building the system described in `PHILOSOPHY.md` and
> mocked up in `demo.html` / `project.html`. Researched against Claude Code's
> actual observation points (hooks, Agent SDK, `-p` stream-json, session
> JSONL on disk, MCP, Channels).

## What we're building

A wrapper around Claude Code — call it **`stack`** for now — that turns every
agent session into a live HTML page of interactive components. Two agents are
involved:

- The **main agent** is the Claude Code session the user actually asked
  for — it reads files, runs commands, edits code, answers questions.
  Its outputs are not text, exactly: they're agent events (tool calls,
  tool results, content blocks).
- The **interface agent** sits beside it. It watches the main agent's
  event stream and decides, for each chunk, what HTML component best
  expresses it: a plan, a diff, a streaming terminal, a decision card,
  a chart, a slider playground, a small diagram, a custom HTML snippet.
  It is *not* a static lookup table — it is a model call with a
  vocabulary of components.

The interface agent's decisions become append-only mutations to a single
HTML document — one page per session, a stack of interactive components
that grows as the session goes. The same page is **bidirectional**: when
the user clicks a button in a component, picks an option, drags a slider,
or hits "copy as prompt", that interaction is synthesized into a message
that flows back into the main agent's session. The page is both display
and input.

Three concrete deliverables:

1. **A small wrapper** that launches `claude` (or attaches to a running one),
   observes every event, runs them through the interface agent, and emits
   component mutations.
2. **A local HTTP server + browser page** that subscribes to those mutations
   via SSE and renders/updates the stack — and POSTs user interactions back
   as session inputs.
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

## The rendering problem — an interface agent, not a lookup table

The main agent doesn't pick its own UI. It just does the work it was
asked to do. Beside it runs a smaller, faster, cheaper **interface
agent** with two responsibilities, in this order:

1. **Decide if the event deserves a component at all.** Most internal
   tool calls — exploratory reads, scratch greps, intermediate bash
   commands — don't. They roll up into a single live "activity"
   indicator.
2. **For events that do deserve a component, decide what shape it
   takes.** Plan, decision, diff, chart, code, comparison,
   playground, schema, raw HTML escape hatch, etc.

This is **not** a deterministic mapping table. The same tool call
can be silently absorbed into the activity indicator in one context
(exploratory) and surfaced as a prominent diff in another (the
deliverable). And many of the most useful components — decision
cards, charts, diagrams — come from *text* the main agent wrote, not
from a tool call at all.

### Editorial judgment — what earns a place on the page

A component on the page is expensive: it takes vertical space, it
demands the user's attention, it accumulates in the history. So the
interface agent applies a budget. An event becomes a committed
component when one or more of these is true:

- **Deliverable.** The agent finished something the user actually
  cares about: a diff, a generated file, a test result, a deploy
  outcome, a final answer.
- **Decision point.** The user needs to pick, approve, or steer —
  prose offering options, an ambiguous direction, a tradeoff.
- **State change.** Something durable in the project shifted: a
  migration ran, a config changed, a new file was created, the
  schema evolved.
- **Summary or rollup.** The agent has done a lot of internal work
  and wants to surface a digest ("looked at 14 files; here are the
  3 places that matter").
- **Explicitly asked for.** The user prompted "show me the schema",
  "compare these three approaches", "explain this function" — the
  ask itself is the request for a component.
- **Long-running.** Something will take a while; the user should
  see progress (a deploy, a long test run, a streamed search across
  a large repo).

Otherwise: the event folds into the **activity indicator**.

### The activity indicator

A single component, sticky-ish at the bottom of the live region,
that updates continuously as the main agent works. It shows the
current step in short prose plus a quiet metric:

```
  Reading src/payments/charge.ts            (8 of 14 files)
  Looking for the streak-reset bug           (2 grep hits)
  Writing the migration                      (1.4 s)
```

When the agent transitions to "doing something the user should see",
the activity indicator clears and a committed component appears
instead. The user can expand the indicator at any time to drill
into the underlying tool calls (collapsed by default).

This is the dial that separates a *narration* from a *log*. A
session log is exhaustive: every tool call rendered, every result
shown, easy to skim and easy to drown in. A narration is editorial:
the user sees the structure of the work, the decisions, and the
outputs, with the means available to drill deeper when they care.

### Stream events we consume

From `claude -p --output-format stream-json` (and the JSONL format):

- `user` — the user's prompt
- `assistant` — content blocks: `text`, `tool_use`
- `tool_result` — keyed by `tool_use_id`
- `result` — final outcome

### The interface agent

A separate model call (good fit: Haiku 4.5) wraps the live stream. It
receives a small window of events at a time — say, every settled chunk:
a complete `text` block, a `tool_use` + its `tool_result`, an
`assistant` turn boundary — and outputs *either* an `activity` update
(the default, low-signal events) *or* a list of committed component
descriptors (when something earns the surface). Its system prompt
holds the **component vocabulary** plus the **editorial criteria**
above.

Concretely:

```
incoming (a Read call exploring a file):
  { kind: "tool_use", tool: "Read", input: { file_path: "src/charge.ts" } }
  { kind: "tool_result", text: "..." }

interface agent output:
  { activity: { name: "Looking at charge.ts", metric: "3 of 14 files" } }
  // ↑ no committed component. just updates the indicator.

incoming (the diff that fixes the bug):
  { kind: "tool_use", tool: "Edit", input: { file_path: "...", old: "...", new: "..." } }
  { kind: "tool_result", text: "ok" }

interface agent output:
  [ { type: "diff", props: { filename: "...", hunks: [...] } } ]
  // ↑ this is a deliverable. commit it.

incoming (prose offering 3 options):
  { kind: "text", text: "There are 3 reasonable ways..." }

interface agent output:
  [ { type: "decision", props: { question, options[] } } ]
  // ↑ text that demands a choice. commit a decision card.
```

The main agent stays natural and verbose; the interface agent
*shapes* its output into something the user can interact with, and
*filters* the noise from the signal.

### Component vocabulary

The interface agent's prompt includes a strict, versioned list of the
component types it is allowed to emit. Each entry has:

- name (`activity`, `decision`, `plan`, `diff`, `chart`,
  `playground`, `compare`, `designs`, `schema`, `code`, `tree`,
  `terminal`, `tests`, `commits`, `deploy`, `stats`, `grep`,
  `summary`, `note`, …)
- the prop schema (JSON)
- **when to use it** (one or two sentences)
- **when *not* to use it** — the editorial guard

When none of the components in the vocabulary fit, there is an
**`html` escape hatch**: the agent can emit raw HTML for a one-off
component, which is rendered inside a sandboxed iframe with strict
CSP. This is how unusual visualizations land — plots, custom
diagrams, throwaway editors.

### Three layers of decision

The interface agent's editorial pass sits on top of two cheaper
layers, used together to keep latency and cost down:

1. **Fast deterministic prefilter (mostly a buffer, not a renderer).**
   For most tool calls, the prefilter doesn't commit a component at
   all — it just updates the activity indicator and *buffers* the
   event for the interface agent to consider. Only a small handful
   of cases auto-commit without waiting on the interface agent:
   - `TodoWrite` (always becomes / updates the `plan` component)
   - A `Bash` command marked long-running (auto-commits a `terminal`
     so the user can watch live)
   - Streaming output the user has opted to follow

2. **Interface agent runs every settled chunk.** It receives the
   buffered events plus context and outputs:
   - an `activity` update (default — most chunks)
   - 0+ committed component descriptors (when something earns the
     surface)
   - replacements / enrichments to previously committed components
     (e.g. "the diff you already showed should also have a small
     'why' summary attached")

3. **Explicit model emission.** Sometimes the main agent knows
   exactly what UI it wants. It can call a `render_*` MCP tool to
   request a specific component, bypassing the editorial pass. Used
   sparingly for rich interactive scaffolds where the model has
   unique structural knowledge.

### Why a separate agent

- **The main agent stays natural.** It doesn't have to clutter its
  thinking with UI choices or self-censor noisy tool calls.
- **The editorial budget is small and well-scoped.** Cheaper model,
  cacheable prompt, low latency.
- **Failure mode is graceful.** If the interface agent times out,
  the activity indicator keeps updating and the missed chunk just
  doesn't get a committed component. Never breaks the session.
- **The vocabulary and the editorial criteria can evolve.** Adding
  a component, or tightening "when not to surface", is a prompt
  edit, not a code patch.

---

## The bidirectional problem — HTML as input, not just output

A component is not display-only. The whole point is that the user can
*act on it*. The 3-option decision card is the canonical case: instead
of the user typing "I want option 2", they click a button on the card
and the system handles the rest.

### What "the user acted on a component" means

Every interactive component declares one or more **actions**. An action
is a typed event the page POSTs back to the server when the user does
something. Examples:

| Component | User does | Action emitted |
| --- | --- | --- |
| `decision` | clicks option *i* | `{ kind: "pick", id: "dec-7", option: 2, label: "Manual freeze" }` |
| `playground` | drags sliders, clicks "Apply" | `{ kind: "apply", id: "play-3", params: { duration: 280, scale: 1.5 } }` |
| `compare` | clicks "pick" on a row | `{ kind: "pick", id: "cmp-2", row: 1, option: "IndexedDB" }` |
| `designs` | clicks a tile | `{ kind: "pick", id: "des-4", choice: "Streak hero" }` |
| `plan` | toggles a step's checkbox | `{ kind: "toggle", id: "plan-1", step: 3, done: true }` |
| `diff` | clicks "revert" | `{ kind: "revert", id: "diff-9", file: "src/charge.ts" }` |
| `code` | clicks "edit & re-prompt" with new text | `{ kind: "edit", id: "code-5", new_code: "…" }` |
| any | right-click → "ask about this" + types text | `{ kind: "ask", id: "<any>", text: "<user prompt>" }` |

Actions go to `POST /api/action`. The server's job is to **synthesize
a follow-up user message** that makes the action legible to the main
agent, then re-enter the agent loop with that message.

### How an action becomes a session input

Two synthesis strategies, picked by the server based on the action kind:

1. **Reference-and-narrate.** The synthesized message refers to the
   acted-on component by id and describes the action plainly:

   ```
   [interaction with @dec-7]
   Picked option 2 of 3: "Manual freeze — User taps 'freeze today'
   before midnight. Limited per month."
   ```

   The main agent has produced `@dec-7` earlier in the session, so it
   already has the context. Used for decisions, picks, toggles,
   reverts.

2. **Verbatim insertion.** For "edit and re-prompt" or "ask about
   this", the user's text is the message — but prefixed with a small
   reference block:

   ```
   [reference: @code-5 (src/components/HabitCard.tsx)]
   <user's prompt>
   ```

   Used for free-form follow-ups.

### Routing back into the agent

How the synthesized message enters the running session depends on the
ingest mode:

- **`stack run`** mode: the wrapper holds the `claude` subprocess. The
  cleanest path is to call `claude --resume <id> -p "<synthesized>"`
  to start a new turn from the existing session id. This costs one
  extra spawn per interaction but is robust.
- **`stack attach`** mode: we don't control the process. We can either
  print the message into the user's terminal and let them hit Enter
  (lo-fi), or use Claude Code's Channels feature to push the message
  into the session as a notification.
- **Agent SDK** mode (v2): the wrapper owns the agent loop directly
  and just appends a user message — no process restart.

### Interruption semantics

What if the user clicks a button on `@dec-7` *while the main agent is
still mid-turn* doing something unrelated? Three options:

- **Queue.** Hold the action until the current turn settles; insert
  it as the next user message.
- **Interrupt.** Stop the main agent and start a new turn immediately.
- **Side-channel.** Inject the action as an out-of-band system note
  the main agent picks up at the next decision point.

We default to **Queue** for v1 (simplest, no interruption hassles).
Interrupt and side-channel become opt-ins later.

### What the user sees

When an action fires, the component immediately reflects the change
optimistically (e.g. `decision` marks the picked option). The
synthesized message appears in the page as a `prompt`-style chip,
just like a typed user prompt would. The main agent's response (new
components) appears below it, exactly as if the user had typed.

The end-to-end shape: **the page is now an editor for the session.**
Components are not just output. Every interactive affordance is an
input. The conversation is no longer just text in / text out — it is
*structured operations on a stack of stateful objects*, where typing
remains available as a fallback.

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

### Phase 0 — Prefilter spike *(1–2 days)*

Goal: prove the deterministic prefilter layer is sound — what gets a
guaranteed component shape without any model in the loop.

- Spawn `claude -p --output-format stream-json --verbose --include-partial-messages` against a real repo with a real task.
- Pipe events into a tiny prefilter that prints `would render: plan(...) / would render: diff(...) / would render: terminal(...)` for the tools where the answer is always the same.
- Mark text blocks as `note (prefilter)` for now.
- Run against 5–10 representative prompts, eyeball the output, refine the table of "always-the-same" tool mappings.

**Deliverable:** a transcript of "what components this real session would have produced from prefiltering alone." Establishes the baseline the interface agent will improve on.

### Phase 1 — MVP: prefilter only, live in the browser *(3–5 days)*

- `stack run "<prompt>"` launches `claude`, runs the prefilter, writes `.stack/sessions/<id>.events.jsonl`.
- Local Node server: SSE stream of mutations, replays the log on connect.
- Vanilla-JS page (the existing `demo.html` codebase, pruned to the components from the prefilter table).
- Components in scope: `prompt`, `note`, `plan`, `diff`, `terminal`, `search`, `web-result`, `tool` (generic), `code`.

**Deliverable:** you run `stack run "fix the failing test in src/payments"`, your browser opens, and watches the session play out as a live component stack — but every text block is still a `note`. The richer components come next.

### Phase 2 — Interface agent: smart rendering *(4–7 days)*

Goal: a real model call in the rendering loop, with a component
vocabulary. This is the unlock.

- Define the component vocabulary as a JSON schema (component types + props + when-to-use).
- Implement the interface agent: a Haiku 4.5 call that takes a settled chunk of events and returns 1+ component descriptors. Heavy use of prompt caching against the vocabulary prompt.
- Wire it in: prefilter runs first (instant), interface agent runs in parallel and can `replace`, `enrich`, or `insert` descriptors before they're committed to the log.
- Add the `html` escape hatch: the interface agent can emit a small raw-HTML chunk for one-offs (charts, diagrams, plots). Rendered into a sandboxed iframe.
- Components newly reachable: `decision`, `compare`, `designs`, `chart`, `schema`, `playground` (when synthesized from text), and arbitrary inline HTML/SVG for plots and diagrams.

**Deliverable:** the same prompt that produced "3 reasonable ways… which do you prefer?" as plain text now renders a clickable `decision` card. Numeric tool results sometimes get a small sparkline beside the terminal. Code-explanation prose sometimes gets a flow diagram.

### Phase 3 — Bidirectional: components are inputs *(4–7 days)*

The hard part: every interactive affordance becomes a session input.

- Define the `action` schema (one per component type). Each component declares which actions it can emit.
- `POST /api/action` synthesizes a follow-up user message via the two strategies (reference-and-narrate / verbatim insertion).
- Routing back into the session: `--resume <id> -p "<synthesized>"` in `stack run` mode; printed-to-terminal in `stack attach` mode for v1.
- Queue semantics: pending actions are held until the current turn settles, then injected as the next user message.
- Optimistic UI: the component reflects the action immediately; the model's response components appear below.

**Deliverable:** clicking "pick" on a decision card actually causes the main agent to act on the picked option. Dragging sliders + "Apply" sends settings back. Right-click "ask about this" round-trips.

### Phase 4 — Project page *(2–3 days)*

- `stack open` (or `stack` with no args) serves the project page.
- Generated from `.stack/index.json` (rebuilt from session logs) + live git state (`git status`, `gh pr list`, `gh run list`).
- Sessions grouped by day, "needs attention" pulled from open decisions and failing tests in recent sessions, in-flight from branches/PRs.
- The project page itself is rendered via the same component vocabulary; the interface agent can be asked to synthesize a "what changed since you were here" banner from the new session logs.

**Deliverable:** the `project.html` mockup, real.

### Phase 5 — Explicit model emission via MCP *(2–3 days)*

For cases the main agent knows exactly what UI it wants — rare,
high-leverage scaffolds like animation playgrounds or structured
design explorations — let it call render_* tools directly.

- Implement `stack-mcp` with `render_playground`, `render_designs`, and the others where the main agent has unique authority to set the structure.
- Register it with Claude Code in `.stack/mcp.json`.
- The mutations from these calls flow through the same log + SSE as everything else.

**Deliverable:** when the main agent is asked to "make the streak animation tunable," it explicitly calls `render_playground` and the resulting component skips the interface agent's interpretation.

### Phase 6 — Polish & ship *(1–2 weeks)*

- Single-binary distribution (`bun build` or `pkg`), or `npx stack`.
- Auto-open browser on `stack run`. Cross-OS.
- Sandbox the `html` escape hatch (iframe with `sandbox=""`, strict CSP).
- Self-contained `<id>.snapshot.html` exporter — entire session inlined, no server needed to view.
- Multi-session aware project page; subagent panels.
- Migrate `stack run` to the Agent SDK so bidirectional inputs no longer need `--resume` (clean live loop).

---

## Architecture sketch

```
                       ┌─────────────────────────────────────────────────┐
                       │  the user                                       │
                       │  - browser (session.html, project.html)         │
                       │  - terminal (optional; for `stack attach` mode) │
                       └──┬──────────────────────────────────────────▲───┘
                          │  POST /api/action,                       │
                          │  POST /api/prompt                        │  SSE
                          ▼                                          │
                              ┌──────────────────────────┐           │
                              │  stack server (Node)     │───────────┘
                              │  - serves pages          │
                              │  - SSE /events           │
                              │  - POST /api/{action,prompt}
                              │  - synthesizes session inputs
                              └────────────┬─────────────┘
                                           │ inject user msg
                                           ▼
                  ┌────────────────────────────────────────────────────┐
                  │                                                    │
                  ▼                                                    ▼
   ┌──────────────────────────┐                      ┌──────────────────────────────┐
   │   stack run              │                      │   stack attach               │
   │   spawns:                │                      │   no spawn; tails file:      │
   │     claude -p …          │                      │     ~/.claude/projects/      │
   │     stream-json          │                      │       <hash>/<id>.jsonl      │
   └──────────────┬───────────┘                      └──────────────┬───────────────┘
                  │                                                 │
                  └────────────┬────────────────────────────────────┘
                               │  events
                               ▼
                ┌─────────────────────────────────┐
                │  prefilter (deterministic)      │   "Bash → terminal" cases
                │  fast, always-applicable        │   for instant feedback
                └─────────────┬───────────────────┘
                              │  baseline descriptor
                              ▼
                ┌─────────────────────────────────┐
                │  interface agent  (Haiku 4.5)   │   smart shaping:
                │  vocabulary = component schema  │   replace / enrich / insert
                │  prompt-cached system prompt    │   incl. `html` escape hatch
                └─────────────┬───────────────────┘
                              │  final component descriptors
                              ▼
                ┌────────────────────────────────────────┐
                │  .stack/sessions/<id>.events.jsonl     │  ← single source of truth.
                │  append-only; replay = page state.     │     page is a fold over this.
                └─────────────┬──────────────────────────┘
                              │  + push live via SSE
                              ▼
                            browser
```

Two side channels:

- **`stack-mcp` (MCP server)** — registered with Claude Code as a normal MCP
  server. Receives `render_*` tool calls when the main agent explicitly
  wants a specific scaffold. These tool_use events flow through the same
  pipeline but skip the interface agent's interpretation (the main agent
  has already specified the structure).
- **User actions** — POSTs from the page. The server synthesizes a
  follow-up user message and routes it back into the session
  (`--resume -p` in run mode, terminal echo or Channels in attach mode).
  Queued behind the current turn by default.

---

## Tech choices & trade-offs

| Choice | Recommendation | Why |
| --- | --- | --- |
| **Wrap mode** | Subprocess on `claude -p --output-format stream-json` (v1); add `stack attach` (tail JSONL) for sessions the user started themselves | Avoids reimplementing the agent loop; works with whatever version of Claude Code the user has |
| **Wrapper language** | TypeScript (Node) | Same as the demo; SSE in a few lines; bundles to a single binary easily |
| **Frontend** | Vanilla JS, the demo's `el()` + `Map<id, block>` pattern | Components are independent; framework overhead would be pure cost |
| **Transport** | SSE for server→browser; HTTP POST for browser→server | One-way streaming is the natural shape; the return channel is rare and discrete |
| **Storage** | Append-only JSONL of component mutations per session | Diffable, tail-friendly, trivial to back up, snapshot is just a fold |
| **Rendering decisions** | Interface agent (Haiku 4.5) on top of a deterministic prefilter | Static tables get the obvious cases instantly; an agent gives us the smart cases (decision cards from prose, charts from numeric output, diagrams from explanations) without bloating the main agent's prompt |
| **Component vocabulary** | Versioned JSON schema in the interface agent's prompt; cached via prompt caching | Adding a component is a vocabulary edit, not a code patch; cache keeps latency and cost low |
| **Explicit components** | `stack-mcp` with a few `render_*` tools for scaffolds the main agent knows how to author directly | Avoids round-tripping rich structures (animation playgrounds, design grids) through the interface agent's interpretation |
| **HTML escape hatch** | Interface agent can emit raw HTML/SVG, rendered into a sandboxed iframe with strict CSP | Lets the model improvise charts and diagrams without putting arbitrary code in the host page |
| **Bidirectional inputs** | Per-component `action` schema → POST → synthesized user message → re-enter the loop | The page becomes an editor for the session — every interactive affordance is an input |
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

## A few open questions specific to the interface-agent design

- **Latency budget.** The interface agent adds a model call per
  settled chunk. Haiku 4.5 with prompt caching should keep this in
  the ~200–500 ms range; for very chatty sessions we may need to
  batch (debounce settled chunks) or run only on chunks where the
  prefilter is low-confidence.

- **Cost per session.** Most of the interface agent's input is the
  cacheable vocabulary prompt. Per-chunk cost is small (the new
  event + ~hundreds of tokens of recent context). For a long
  session with hundreds of chunks, this is still cents — fine.

- **Drift.** The interface agent can hallucinate components or
  produce schema-invalid props. We validate every descriptor
  against the vocabulary's JSON schema before committing; invalid
  ones fall back to the prefilter's baseline.

- **Determinism for tests.** Snapshot-testing pages becomes harder
  when an agent is making choices. We pin the interface agent to a
  fixed model + temperature 0 and golden-master the descriptor
  stream rather than the final HTML.

## Self-review — what I've hand-waved

A list of the things I've glossed over, ranked by how much they'd bite
us during real implementation. None are showstoppers; all need a real
answer before Phase 2.

### 1. *"Settled chunk"* is the most important undefined term

The editorial agent runs "on each settled chunk." But when *is* a chunk
settled? Per assistant turn? Per content block? Per tool_use + result
pair? Per N seconds? This single decision drives latency, cost, and the
feel of the entire UX — and I never pinned it down. **Best default:**
fire after every `assistant` turn boundary, plus a soft deadline (~3 s)
that promotes the in-flight chunk to a partial decision so very long
turns don't go blank. This needs a real experiment in the Phase 0 spike.

### 2. The editorial agent's context window isn't specified

It needs to know more than the current chunk to make good calls. To
decide *"is this Read exploratory or the answer the user asked for?"*
it needs the user's prompt and the agent's recent activity. How much
history? All of it? The last 5 chunks? Token cost scales linearly with
this. Probably: prompt + last 2k tokens of activity summary, with the
fixed vocabulary in a cached prefix.

### 3. Long-running detection is backwards

The prefilter is supposed to "auto-commit long-running Bash" so the
user sees progress. You can't know in advance. The real flow is: every
Bash starts as an activity-indicator line; if it's still running after
~1.5 s or starts producing output, *promote* it to a live `terminal`
component. Component promotion (activity → committed) is a primitive I
haven't called out explicitly anywhere in the plan; it should be.

### 4. Activity events shouldn't live in the events.jsonl

Activity-indicator updates are transient by definition. Persisting them
in the append-only log makes replay noisy and bloats sessions. They
should be ephemeral — live channel only. Only *committed* mutations
(append/patch/stream/finalize on real components) go in the log. The
log's invariant becomes: **fold the log → final committed state of the
page**, with activity indicator empty (because the session is no longer
live). That's the right shape.

### 5. User actions can go stale mid-turn

Queue semantics solve "don't interrupt the agent". They don't solve
"the user's click is no longer relevant by the time we process it".
Example: user picks an option on `@dec-7`, but the agent has already
moved on and resolved that decision via tool calls. We need either:
- a freshness check (the server checks whether `@dec-7` is still "open"
  before synthesizing the user message), or
- a clearly-marked staleness in the synthesized message
  ("the user picked option 2 of @dec-7 ~30 s ago; you may have already
  resolved this — confirm or proceed").

### 6. The interface agent's prompt is the most important artifact, and I haven't sketched it

I've said "vocabulary + criteria in the system prompt" five times
without ever writing it. This is the *only* concrete deliverable
that decides whether the whole design works. The Phase 0 spike should
include drafting and iterating on this prompt against transcripts of
real sessions before we build anything else.

### 7. The demo doesn't represent post-editorial reality

`demo.html` shows ~22 carefully-chosen committed components across 3
days. A real session would be ~80% activity-indicator updates with
occasional commits. The current demo is a curated *best-case* view —
fine as an aspirational mockup, misleading as a representation of
what a real session looks like. Worth either updating the demo to
include the activity indicator between commits, or labeling it as
"the surfaced view" with a toggle to expand the noise.

### 8. The project page hasn't been re-thought with the editorial lens

`project.html` renders every section unconditionally. By the new
philosophy, it should probably also have a "what's worth surfacing"
filter — there's no value in showing an empty "needs attention"
section, or a stale concept map that hasn't changed since last week.
A small editorial pass on project assembly seems right.

### 9. `snapshot.html` for sharing has an interactivity problem

A self-contained snapshot can't have working playground sliders or
decision buttons by default — those need handlers wired to a server.
Two options: (a) snapshots are explicitly *frozen* — sliders show the
last-set state, decisions show the picked option, but nothing's
clickable; (b) snapshots include a small embedded runtime that
re-renders from the embedded event log but no-ops on actions. (a) is
simpler and probably enough.

### 10. MCP server registration only works in `stack run` mode

Registering `stack-mcp` requires Claude Code to start with that
config. For `stack attach` (where the user already started `claude`
themselves), we can't retroactively add MCP tools. So `render_*`
explicit emission is a `stack run` feature only — which is fine,
but worth stating.

### The single riskiest assumption

That Haiku 4.5 can make consistent, sensible editorial judgments
("commit this; fold that") at the rate and quality this design
requires. If it under-surfaces, users miss things; if it
over-surfaces, we're back to the noisy log; if it's inconsistent,
the UX feels jittery — sometimes the bug-fix diff appears, sometimes
the same kind of edit silently folds into activity. **This needs to
be tested before Phase 2 is committed to.** The Phase 0 spike should
be expanded: instead of just printing "would render X," it should
actually run the candidate editorial-agent prompt against real
transcripts and have a human grade the calls against the criteria.
If the grade isn't ≥85% agreement with a human editor, the design
needs rethinking (different model, different criteria, more
hand-coded rules, or a smaller leap from the prefilter baseline).

## What to build first, in one sentence

A **prefilter spike** that pipes `claude -p --output-format stream-json`
into a script that prints "would render: terminal / would render: diff /
would render: plan" for the always-the-same cases, leaving everything
else as `note (prefilter)` — because once that baseline holds, every
later phase (interface agent, bidirectional inputs, project page) is an
additive layer on top of a working stream, and we can ship and learn at
each step.
