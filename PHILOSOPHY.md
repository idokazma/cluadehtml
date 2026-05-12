# Philosophy: Claude Code as a Living Document

## The Premise

The terminal is the wrong shape for what Claude Code actually does.

A CLI is a teletype. It assumes the conversation is the artifact — a linear scroll of prompts, tool calls, and replies that you read once and abandon. But the *real* artifact of an agent session is never the transcript. It is the state of the world the agent is reasoning about: the files it's touching, the tests that are red, the plan it's executing, the decisions still open, the diff that will land.

A scrolling log buries that state under its own history. Every meaningful update — "tests passed," "I changed my mind about the approach," "this file now has 14 edits" — is rendered the same way as every transient line of stdout, then pushed off-screen by the next thing the model says. You end up scrolling backwards to reconstruct what is true *right now*.

We want to invert that. The interface should show what is true right now, and relegate the conversation to one panel of many.

## The Move: From HTML Outputs to an HTML Interface

A growing thread inside the Claude Code team and community ([Thariq Shihipar's "Unreasonable Effectiveness of HTML"](https://x.com/trq212/status/2052809885763747935) is the clearest write-up) has been replacing **markdown outputs** with **HTML outputs**. Specs, implementation plans, PR reviews, research reports, design explorations, throwaway editors with "copy as JSON" buttons — all rendered as standalone HTML files instead of `.md` documents. The argument is right and overdue:

- HTML carries denser information (tables, SVG, CSS, inline JS, real interactivity) than markdown can.
- Long HTML is *readable*; long markdown is not.
- HTML is shareable — one link, opens in any browser, no special viewer.
- HTML can be two-way — sliders, drag-and-drop, "copy as prompt" buttons that close the loop back into the agent.
- And it's just more fun, which means the human actually engages with the output.

We agree with all of this. **And we want to take the next step.**

The artifact approach keeps the CLI as the spine and bolts HTML onto the leaves. You still type into a terminal; the agent still streams text replies; *every now and then* it writes out an HTML file as a deliverable, and you open it in a browser. Each artifact is excellent in isolation — but each one is also its own little universe. The plan from this morning, the design exploration from this afternoon, the PR review from an hour ago, and the throwaway editor you used to triage tickets are four separate files in four separate tabs. Nothing connects them. Nothing in any of them updates when the underlying work moves. The agent's *interface*, the place you actually live while working, is still a scrolling text log — only the deliverables got the upgrade.

We want to apply the same insight one level up: **if HTML is the right medium for the agent's outputs, it is also the right medium for the agent's interface.** Don't render N artifacts per session. Render one living document that *is* the session — the same document the whole way through, with every plan, diff, terminal tail, test panel, design exploration, and custom editor appearing as a block inside it. Not a stream of HTML answers. One HTML page, alive for the whole session, mutated in place by the agent as it works.

Old blocks stay live. The diff from twenty minutes ago is still a diff you can click into. The plan from the start of the session still updates as items are completed. The throwaway editor you spun up to triage tickets is still sitting where you left it, and its "copy as prompt" button still works. The history is not a transcript of dead snapshots — it is a backlog of still-working components, all sharing one page, all reachable, all interactive.

This is the move from **"the agent produces an HTML artifact for each answer"** to **"the agent and the user are co-editing one HTML document that represents the work."** The page is the spine; the conversation is one panel inside it; every artifact the agent would have written as a separate file is instead a block within the same living page — or, when it really should be a separate deliverable, a block that *links to* one. Either way, the interface itself is the document.

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

**8. One page per session, not one page per answer.**
The agent does not render a fresh artifact for each turn. There is exactly one document, and every turn either appends a block to it or mutates a block already in it. This is what makes the log a *log* and not a slideshow: scrolling back is scrolling through live components, not snapshots of dead ones. A diff from an hour ago is still a diff you can act on; a question from ten minutes ago is still a question you can answer; a test panel from earlier in the run still updates if its tests get re-run.

## What This Buys Us

- **Glanceability.** The state of the work is one look away, not a scroll-and-grep away.
- **Parallelism.** Multiple long operations can run and report without trampling each other's output.
- **Reversibility.** Every mutation is addressable, so undo, branch, and replay become tractable.
- **Lower-friction interaction.** Most decisions become a click. Typing is reserved for the things only typing can express.
- **Honest UX for an honest fact.** Agents have state. Pretending they're a conversation has been a useful lie; it's now in the way.

## What This Is Not

It is not a chat app with a sidebar. It is not a web wrapper around the existing terminal renderer. It is not a dashboard that polls the CLI for status. And it is not the artifact pattern — the agent does not produce a fresh HTML page for each output and leave you to juggle a folder of disconnected files. The CLI is not the source of truth with a prettier face — the page is the source of truth, and the agent's tools write to it directly. There is one page per session, it is alive, it remembers, and you can reach back into any block in it.

## Two Scopes: The Project Page and The Session Page

The HTML interface wraps **two** things, not one.

### 1. The session page

A live, mutating view of one agent run — the plan, diffs, tests, questions, terminal tails, and chat thread for the current task. This is what we've described above.

### 2. The project page

The first thing you see when you open Claude Code in a repo, **before** you've asked it to do anything. Today, opening the CLI in a new project gives you a blinking cursor and zero context — the human has to do all the work of figuring out what this codebase is, where they left off, what's broken, what's in flight. That is exactly backwards. The agent has already read the repo; it should hand you a briefing.

The project page is that briefing, generated and kept fresh by the agent:

- **What is this?** A one-paragraph description of the codebase, inferred from the code itself, not from a stale README. Stack, entry points, how to run it.
- **Where you left off.** The last few sessions, summarized as cards: "yesterday: added idempotency keys to /charge — 1 test still failing." Click to resume.
- **What's in flight.** Open branches, uncommitted changes, draft PRs, in-progress migrations. The agent surfaces these without being asked.
- **What's broken.** Failing CI, type errors on the current branch, dependencies with known CVEs, TODOs the agent thinks are stale. Each is a block you can click to start a session aimed at fixing it.
- **A map of the codebase.** Not a file tree — a *concept* tree. "Auth lives here. Payments lives here. The thing you'll probably want to touch for your task lives here."
- **Suggested next moves.** "You haven't run the test suite in 3 days." "There's a dependency upgrade waiting." "PR #482 has review comments." Each is a one-click session-starter.
- **A conversation panel,** same as in a session — but the default mode is "browse and click," not "type and wait."

The point is that **onboarding to a project should take seconds, not an afternoon**. A new contributor — or you, returning to a repo you haven't touched in a month — opens the page and is oriented immediately. The agent has done the reading for you.

### How the two scopes relate

The project page is a *meta-session* whose blocks are summaries of, and entry points into, real sessions. Starting a task from a project-page card spawns a session page; the session, when finished, writes its own summary block back into the project page. The project page is the index; sessions are the chapters. Both are live HTML, both follow the same principles, both are the source of truth for their scope.

This means a project gets a persistent, evolving "home" — not a folder of forgotten transcripts, but a living dashboard that knows what the repo is, what was done to it, what's wrong with it, and what to do next.

## The North Star

A user opens the page on a project they've never seen and, **without typing a single character**, understands what it is, what state it's in, and what they could do next. They open a session and, within thirty seconds of watching, understand the state of the work better than they did before. The interface is doing its job when the conversation has become optional — at both scopes.
