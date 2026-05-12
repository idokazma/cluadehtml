# cluadehtml

A different shape for Claude Code: instead of streaming markdown into a
terminal, render each reply as one or more **interactive HTML components**,
stacked into a single page that grows as the session goes.

## What's here

- **[`PHILOSOPHY.md`](./PHILOSOPHY.md)** — the argument. Builds on Thariq
  Shihipar's [Unreasonable Effectiveness of HTML](https://x.com/trq212/status/2052809885763747935)
  (HTML as the right output format for an agent), then takes one step further:
  don't ship one HTML file per answer — render each answer as inline,
  stackable, interactive components, and let the stack of them *be* the
  session.

- **[`BUILD_PLAN.md`](./BUILD_PLAN.md)** — how to actually build it.
  Researched against Claude Code's real observation points (hooks, Agent
  SDK, `claude -p --output-format stream-json`, session JSONL on disk, MCP,
  Channels). Covers the wrapper, the mapping from tool calls to components,
  the local server, persistence, and a phased roll-out.

- **[`architecture.html`](./architecture.html)** — visual explainer for the
  system. Draws all the flows (forward, bespoke render_*, user-action
  round-trip, project aggregation), the mapping table, the four mutation
  ops, the file layout, and a click-through walkthrough of one event from
  the model emitting `tool_use(Read)` all the way to a component in the
  browser.

- **[`stack/`](./stack/)** — **the implementation**. Node + ESM, no
  dependencies, runnable today:

  ```sh
  cd stack
  node bin/stack.mjs run --replay fixtures/habits-day1.jsonl
  # open http://localhost:3737/
  ```

  Wires the full pipeline end-to-end: ingest (claude subprocess or
  replay) → normalize → prefilter (activity indicator + auto-commits)
  → editorial pass → SSE → browser page. Bidirectional inputs
  (`POST /api/action`) round-trip. The editorial agent's system
  prompt is in [`stack/prompts/interface-agent.md`](./stack/prompts/interface-agent.md);
  the rules implementation is a faithful translation of that prompt
  so the system runs without an API key, with a clearly-marked seam
  for swapping in a real Haiku call.

- **[`demo.html`](./demo.html)** — interactive mockup of the idea. Open it
  in a browser. A simulated agent run plays out as a stack of components:
  a clickable plan, a file diff, a streaming terminal, a live test panel,
  an inline question with options, search results, file edits. Right-click
  any component to ask claude about it specifically; click `@b-id` pills
  in any reply to scroll to and highlight the referenced component.

- **[`project.html`](./project.html)** — separate exploration of what a
  project landing page might look like (cards for "where you left off",
  "needs attention", etc.). Different idea from the core proposal — kept
  here as a side sketch, not part of the main argument.

## How to view

The HTML files are self-contained — no build step, no dependencies.

```sh
open demo.html       # macOS
xdg-open demo.html   # Linux
```
