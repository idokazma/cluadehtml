# cluadehtml

Exploration of replacing the Claude Code CLI with a live, mutating HTML page.

## What's here

- **[`PHILOSOPHY.md`](./PHILOSOPHY.md)** — the argument. Why HTML beats markdown
  for agent outputs (per Thariq Shihipar), and why the same insight should
  apply one level up: the agent's *interface* itself, not just its
  deliverables, should be one living HTML document per session.
- **[`demo.html`](./demo.html)** — interactive mockup of the session view.
  A simulated agent run plays out as a stream of interactive blocks (plan,
  diffs, terminal stream, live test panel, inline question, search). Right-click
  any block to ask claude about it, reference it via a `@b-id` pill, re-run,
  revert, copy.
- **[`project.html`](./project.html)** — interactive mockup of the project
  landing page. What you see when you `cd` into a repo before typing anything:
  description, where you left off, in-flight branches/PRs, what needs
  attention, suggested next moves, health, concept map.

## How to view

Open the `.html` files directly in a browser — they are self-contained, no
build step, no dependencies.

```sh
open demo.html       # macOS
xdg-open demo.html   # Linux
```

## Two scopes

The interface wraps two scopes, both as living HTML pages, both following the
same principles (see `PHILOSOPHY.md`):

| Scope     | What it is                                            | Mockup           |
| --------- | ----------------------------------------------------- | ---------------- |
| Session   | One agent run — plan, diffs, tests, chat, blocks       | `demo.html`      |
| Project   | The repo's home — onboarding, status, session index    | `project.html`   |
