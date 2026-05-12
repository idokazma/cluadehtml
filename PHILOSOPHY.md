# Philosophy: Claude Code as a Stack of Interactive Components

## The Premise

Claude's reply to a prompt is almost always *more structured than the medium it lands in*. A plan is a list of decisions. Code is a tree. A diff is two files. A test summary is a table. A design exploration is a grid of options. A research finding is a chart, a citation, and a paragraph.

Today, all of that gets flattened into markdown — because markdown is what a CLI can render. So Claude takes a structured thing it knows perfectly well, lossily encodes it as bullets and code fences, and ships it to a terminal that pretends it's prose. You read it once, and the structure is gone.

There's a growing realization (best articulated in [Thariq Shihipar's "Unreasonable Effectiveness of HTML"](https://x.com/trq212/status/2052809885763747935)) that **HTML is the right output format for an agent.** It carries the structure intact: tables stay tables, diagrams stay diagrams, options stay clickable, sliders stay tunable, "copy as prompt" buttons close the loop back to the model. A plan you can check off beats a list of bullets. A diff you can scroll through and annotate beats a fenced code block.

Thariq's pattern is to ask Claude to emit **a standalone HTML file** for each output and open it in a browser. That works. But it splits the experience: your conversation lives in a terminal, your useful artifacts live in a folder of disconnected `.html` files, and nothing connects them.

## The Move

**Render each agent reply as one or more interactive HTML components, inline, stacked into a single page that grows as the session goes.**

That's it. The CLI is replaced by a page. The page starts empty. You type a prompt at the bottom (chat-style). Claude's reply is not text — it's a component, or a few components, appended to the page. Another prompt, another component. The session is the stack.

A plan reply is a checklist component you can click. A code reply is a syntax-highlighted snippet with copy and "edit and re-prompt" buttons. An "explain this function" reply is a diagram component. A refactor reply is a diff component. A "compare three approaches" reply is a tabbed component. A "tune this animation" reply is a slider component with a live preview and a "copy as prompt" button.

The key inversion: **what was previously the agent's "answer" is now the agent's "component."** Same content, structured medium.

## Why Stack Them

A folder of HTML artifacts loses the through-line of the work. A scrollable stack of components keeps it. You scroll up and the plan from earlier is still a plan you can check off, the diff from an hour ago is still a diff you can scroll, the design exploration is still a grid you can click into. Nothing was a snapshot; everything was, and remains, a working interface.

This is what makes the page a **session** and not a slideshow. The history is composed of live components, not dead text. You can right-click any component and ask Claude something specifically about it — "redo this plan with X constraint", "make this diff smaller", "explain why you picked this option". The component becomes part of the prompt for the next turn.

## Principles

1. **Each turn produces components, not text.** Claude's job is no longer "write a reply"; it's "render a reply as one or more interactive components." Markdown is a fallback, not the default.

2. **Components stack chronologically.** New components append to the bottom of the page, like messages. Old components stay where they were.

3. **Old components stay live.** A plan from twenty turns ago is still a clickable plan. A slider is still tunable. A "copy as prompt" button still works. The history is interactive, not archival.

4. **A component is a unit of attention.** You can right-click any component to ask Claude about *it* specifically. References to a component get a `@id` pill that scrolls to and highlights it. This makes the conversation grounded in concrete things instead of vague text.

5. **Components are composable.** A "plan" component contains "step" components. A "diff" component contains per-file diffs. The agent picks the granularity. Small components are reusable across replies; large ones are bespoke.

6. **The user can edit the page.** Check off a plan item, change a slider, edit a snippet inline — the agent sees the edit and can react to it. The page is not just output; it's input too.

7. **Long-running work lives in its own component.** A test run is a component that updates as tests finish. A streaming search is a component that fills in. The user can keep prompting; the running component just keeps going inside the page.

8. **Chat is the input bar, not the medium.** The text input at the bottom stays — typing is still the most powerful way to steer. But the *output* of every exchange is a component above it, not a paragraph next to it.

## What This Buys Us

- **Structure is preserved end-to-end.** What the model knows, the page shows.
- **History is useful, not just visible.** You can act on past replies, not just re-read them.
- **Reduced typing.** Most decisions become a click on a component, not a sentence asking for the thing the component already offers.
- **Sharable sessions.** The page is one self-contained artifact. Send it; everything is there.
- **A unified surface for what used to be N separate Claude tools.** Plans, diffs, design explorations, throwaway editors — they're all just components in the same stack.

## Two implications worth naming

**The rendering is done by an agent, not a table.** The main agent —
the Claude session doing your actual work — shouldn't have to decide
"should this be a decision card or a paragraph?" while it's busy
reading files and editing code. So beside it runs a smaller
*interface agent* whose only job is to look at each chunk of the main
agent's output and pick the component that best expresses it. The
mapping is not a static lookup. The same tool result might become a
chart in one context and a tree in another. Many of the most valuable
components — decision cards from prose offering 3 options, sparklines
from numbers in a tool result, diagrams from explanation text — never
correspond to a tool call at all; they emerge from text the main agent
wrote naturally.

**The interface agent is an editor, not a transcriber.** Not every
event the main agent fires deserves a component. A session that reads
twenty files to debug one line should surface *that line and its fix*
— not twenty file viewers. The first question the interface agent
asks of every event isn't *"what component is this?"* but *"does this
earn a place on the page?"* Most internal tool calls — exploratory
reads, scratch greps, intermediate bash commands — roll up into a
single live **activity indicator** (one component that updates as the
agent works). Only deliverables, decisions, state changes, summaries,
and things the user explicitly asked to see graduate into committed
components. The session is a narration, not a log. The user can
always expand the activity indicator to see the underlying steps —
but the default is silence on noise and clarity on what matters.

**The page is bidirectional.** A component is not display-only. When
the user clicks an option on a decision card, drags a slider, picks a
design tile, or right-clicks to ask about a specific block, that
interaction is structured (it carries the component id and a typed
action) and flows back into the main agent's session as a synthesized
user message. The 3-option case is the canonical one: today you'd
type "I want option 2"; with this design you click. The page is both
output and input. The conversation stops being text-in / text-out and
starts being *structured operations on a stack of stateful objects* —
with typing still available as a fallback.

## What This Is Not

- It is not a chat app where messages happen to render markdown nicely. The reply is a component, not a styled message.
- It is not the artifact pattern (one HTML file per answer, opened in a browser tab). It is the artifact pattern moved *inline*, *stacked*, and *connected*.
- It is not a dashboard the agent maintains. The agent doesn't paint a fixed UI; it appends interactive components in response to prompts.
- It is not a redesign of the CLI's text. It is a replacement of the medium.

## The North Star

A user prompts Claude. Instead of a wall of markdown, a small interactive component appears below their prompt — tuned to exactly what they asked for. They click into it, modify it, prompt again. Another component appears. After thirty minutes they have a stack of fifteen components — a plan they checked off, a diff they reviewed, three design options they compared, a sliders panel they tuned, a snippet they copied — and every one of them is still alive, still clickable, still part of the prompt for whatever comes next.

The session isn't a transcript. It's a stack of working interfaces, built one component at a time.
