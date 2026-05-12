# Philosophy: Claude Code as a Living Document

## The Premise

The terminal is the wrong shape for what Claude Code actually does.

A CLI is a teletype. It assumes the conversation is the artifact — a linear scroll of prompts, tool calls, and replies that you read once and abandon. But the *real* artifact of an agent session is never the transcript. It is the state of the world the agent is reasoning about: the files it's touching, the tests that are red, the plan it's executing, the decisions still open, the diff that will land.

A scrolling log buries that state under its own history. Every meaningful update — "tests passed," "I changed my mind about the approach," "this file now has 14 edits" — is rendered the same way as every transient line of stdout, then pushed off-screen by the next thing the model says. You end up scrolling backwards to reconstruct what is true *right now*.

We want to invert that. The interface should show what is true right now, and relegate the conversation to one panel of many.

## The Model: A Live Page, Not a Log

Replace the CLI with a single HTML page that the agent **renders into and updates in place** as it works. Think of it less like a chat client and more like a dashboard the agent is co-authoring with you in real time — closer to a Jupyter notebook that rewrites its own cells, or an IDE whose entire UI is owned by the model.

The page is the session. When the agent starts a task, it lays out the regions it expects to need: a plan, a file tree of touched files, a diff preview, a test panel, a terminal tail, an open-questions list, a chat thread. As it works, it **mutates** those regions — checking off plan items, replacing a stale diff with a fresh one, flipping a test from yellow to green, dismissing a question once you answer it. Nothing important scrolls away, because important things don't live in the scroll.

This is the shift Hud and tools like it have been pointing at: the agent is not a chatbot that occasionally edits files. It is a process with state, and the UI should be a live view of that state.

## Principles

**1. The page reflects truth, not history.**
If a file has been edited five times, the page shows the current diff, not five diffs. If the plan has changed, the old plan is gone, not struck through. History is recoverable (timeline, undo, transcript) but not the default view. The default view answers "where are we?", not "how did we get here?".

**2. The agent owns the layout.**
The model decides what regions exist for a given task. A refactor session looks different from a debugging session looks different from a "explain this codebase" session. The UI is generated, not fixed. A small set of primitive components (panel, list, diff, table, form, chart, terminal, chat) is enough — the agent composes them.

**3. Updates are diffs, not redraws.**
Every change the agent makes to the page is a small, addressable mutation: "set plan item 3 to done", "replace the diff in panel `auth.ts`", "append a line to the test log". This keeps the UI cheap, makes every change inspectable, and means the user's scroll position, selection, and focus are never destroyed by a refresh.

**4. The user is a first-class editor of the page.**
The page is not read-only. You can check off a plan item yourself. You can edit a file in the diff panel and the agent sees the edit. You can dismiss a question, pin a panel, drag a file into context, approve or reject a proposed action inline. Interaction is structured input, not free-text instructions a parser has to guess at.

**5. Chat is a panel, not the frame.**
Natural language is still the most powerful way to steer the agent, so a conversation thread stays. But it sits beside the work, not above it. Most exchanges with the agent should be a click on a checkbox, a button on a proposal, a typed value in a form field — not a sentence asking it to do the thing the UI could have offered directly.

**6. Long-running work is visible by default.**
Background processes — a test run, a build, a streaming search, a subagent — appear as live tiles on the page, not buried in a process list. You can glance and see what's running, what's stalled, what finished. The CLI's worst failure mode is the silent agent; the page makes silence physically impossible.

**7. The page is the protocol.**
The HTML is not a presentation layer over a "real" CLI session — it *is* the session. There is no hidden truth behind it. Anything the agent knows, it has put on the page (or in a collapsible drawer of the page). This makes sessions resumable, shareable, and reviewable: send someone the page and they have everything.

## What This Buys Us

- **Glanceability.** The state of the work is one look away, not a scroll-and-grep away.
- **Parallelism.** Multiple long operations can run and report without trampling each other's output.
- **Reversibility.** Every mutation is addressable, so undo, branch, and replay become tractable.
- **Lower-friction interaction.** Most decisions become a click. Typing is reserved for the things only typing can express.
- **Honest UX for an honest fact.** Agents have state. Pretending they're a conversation has been a useful lie; it's now in the way.

## What This Is Not

It is not a chat app with a sidebar. It is not a web wrapper around the existing terminal renderer. It is not a dashboard that polls the CLI for status. The CLI is not the source of truth with a prettier face — the page is the source of truth, and the agent's tools write to it directly.

## The North Star

A user opens the page, watches the agent work for thirty seconds without typing, and *understands the state of their project better than they did before they opened it*. The interface is doing its job when the conversation has become optional.
