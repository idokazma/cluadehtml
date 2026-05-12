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
