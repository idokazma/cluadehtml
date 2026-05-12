// The interface agent — editorial pass.
//
// Two implementations:
//   - editorialAgentRules: deterministic, used by default. Encodes the
//     "what earns a component" criteria from prompts/interface-agent.md
//     as code, so the system is testable end-to-end without an LLM in
//     the loop.
//   - editorialAgentLLM: stub for calling Haiku with the system prompt
//     in prompts/interface-agent.md. Drop-in replacement.
//
// Both take a settled "chunk" — a batch of buffered events since the
// last editorial pass — and return zero or more committed mutations to
// add on top of what the prefilter already emitted.

import fs from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { newId } from "../store/ids.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/**
 * @param {import("../types.mjs").AgentEvent[]} chunk
 * @param {object} state  shared with prefilter
 * @returns {Array<import("../types.mjs").Mutation>}
 */
export function editorialAgentRules(chunk, state) {
  const out = [];

  for (const ev of chunk) {
    // Rule 1: an Edit / Write tool_use is a deliverable — commit a diff.
    if (ev.kind === "assistant" && (ev.tool === "Edit" || ev.tool === "Write")) {
      const result = (state.lastResults || []).find(r => r.tool_use_id === ev.tool_use_id);
      // We may not have the result yet; commit speculatively with the
      // input we have, and the page renders the diff from old/new strings.
      const i = ev.input || {};
      const hunks = synthDiffFromEdit(i, ev.tool);
      out.push({
        op: "append",
        component: {
          id: newId("diff"),
          type: "diff",
          props: {
            filename: i.file_path || "(unknown)",
            hunks,
            tool: ev.tool,
          },
        },
        ts: ev.ts,
      });
      continue;
    }

    // Rule 2: an assistant text block that offers numbered options →
    // synthesize a decision card.
    if (ev.kind === "assistant" && ev.text) {
      const dec = sniffDecision(ev.text);
      if (dec) {
        out.push({
          op: "append",
          component: {
            id: newId("dec"),
            type: "decision",
            props: { question: dec.question, options: dec.options },
          },
          ts: ev.ts,
        });
        // We don't include the surrounding prose — the decision is the surface.
        continue;
      }
    }

    // Rule 3: a Bash tool_use whose command looks long-running → promote
    // to a terminal component immediately.
    if (ev.kind === "assistant" && ev.tool === "Bash") {
      const cmd = ev.input?.command || "";
      if (/(?:npm|pnpm|yarn) (?:run|test|build|ci)|jest|vitest|pytest|docker|deploy|migrate|tsc/.test(cmd)) {
        out.push({
          op: "append",
          component: {
            id: terminalIdFor(ev.tool_use_id),
            type: "terminal",
            props: { command: cmd, lines: [], status: "running" },
          },
          ts: ev.ts,
        });
        continue;
      }
    }

    // Rule 4: tool_result of a long-running Bash → stream it into the
    // terminal component we created above.
    if (ev.kind === "tool_result") {
      const id = terminalIdFor(ev.tool_use_id);
      if (state._committedTerminals?.has(id)) {
        const text = typeof ev.content === "string" ? ev.content : JSON.stringify(ev.content);
        out.push({ op: "stream", id, append: text, ts: ev.ts });
        out.push({ op: "finalize", id, meta: {}, ts: ev.ts });
        continue;
      }
    }

    // Rule 5: an assistant text block that names a final answer or
    // summary keyword → commit it as a `note` (lightly).
    if (ev.kind === "assistant" && ev.text && shouldKeepNote(ev.text)) {
      out.push({
        op: "append",
        component: { id: newId("note"), type: "note", props: { text: ev.text } },
        ts: ev.ts,
      });
    }
  }

  // Track which terminals we've committed so the streaming rule above
  // can find them.
  state._committedTerminals ??= new Set();
  for (const m of out) {
    if (m.op === "append" && m.component.type === "terminal") {
      state._committedTerminals.add(m.component.id);
    }
  }

  return out;
}

function terminalIdFor(toolUseId) { return `term-${toolUseId || "x"}`; }

/**
 * Sniffs an enumerated-options prompt out of free text.
 * Crude but precise: looks for "1)" or "1." or "Option 1:" patterns
 * followed by a "?" earlier in the text or a "which" word.
 */
function sniffDecision(text) {
  const numbered = [...text.matchAll(/(?:^|\n)\s*(?:(?:\d+)[.)]|Option\s+\d+:)\s+(.+?)(?=\n\s*(?:\d+)[.)]|\n\s*Option\s+\d+:|\n\s*$|$)/gs)];
  if (numbered.length < 2) return null;
  const askMatch = text.match(/([A-Z][^.?!\n]{8,160}\?)/);
  if (!askMatch && !/which (?:one|do you|of these|approach|option)/i.test(text)) return null;
  return {
    question: askMatch ? askMatch[1].trim() : "Which option do you prefer?",
    options: numbered.map((m) => {
      const raw = m[1].trim().split(/[—–:-]\s+|\n/);
      return { label: raw[0].trim().slice(0, 80), desc: (raw.slice(1).join(" — ") || raw[0]).slice(0, 200) };
    }),
  };
}

function shouldKeepNote(text) {
  if (!text) return false;
  // Keep very short summary-feeling notes; drop chatty ones.
  if (text.length > 600) return false;
  if (/^(here's|here is|done|fixed|shipped|all green|migrating|i'll|let me)/i.test(text.trim())) return true;
  // Anything with a checkmark, a bullet, or explicit summary cue.
  return /^[•✓\-\*]\s|summary|to recap|tl;dr|in short|next:/i.test(text);
}

function synthDiffFromEdit(input, tool) {
  // We don't have actual file contents at the wrapper level (Edit gives
  // us old_string + new_string; Write gives us content). Synthesize a
  // small diff representation the page can render.
  if (tool === "Write" && input.content) {
    return [{ startLine: 1, lines: input.content.split("\n").map(l => ["+", l]) }];
  }
  if (tool === "Edit" && input.old_string != null && input.new_string != null) {
    const olds = String(input.old_string).split("\n").map(l => ["-", l]);
    const news = String(input.new_string).split("\n").map(l => ["+", l]);
    return [{ startLine: 1, lines: [...olds, ...news] }];
  }
  return [{ startLine: 1, lines: [[" ", JSON.stringify(input).slice(0, 200)]] }];
}

// ----------------------------------------------------------------------------
// LLM-backed implementation (stub). Drop-in replacement: read the system
// prompt from prompts/interface-agent.md, ask the model to emit JSON,
// validate against the schema, return mutations.

const PROMPT_PATH = path.resolve(__dirname, "../../prompts/interface-agent.md");
let cachedPrompt = null;
function loadPrompt() {
  if (cachedPrompt) return cachedPrompt;
  try { cachedPrompt = fs.readFileSync(PROMPT_PATH, "utf8"); } catch { cachedPrompt = ""; }
  return cachedPrompt;
}

/**
 * @param {import("../types.mjs").AgentEvent[]} chunk
 * @param {object} state
 * @returns {Promise<Array<import("../types.mjs").Mutation>>}
 */
export async function editorialAgentLLM(chunk, state) {
  const system = loadPrompt();
  if (!system || !process.env.ANTHROPIC_API_KEY) {
    // No model available — fall back to rules.
    return editorialAgentRules(chunk, state);
  }
  // To keep this implementation honest while remaining runnable
  // without network access, we just call the rules path. A real
  // call would look like:
  //
  //   const r = await fetch("https://api.anthropic.com/v1/messages", {
  //     method: "POST",
  //     headers: { ... },
  //     body: JSON.stringify({
  //       model: "claude-haiku-4-5-20251001",
  //       system: [{ type: "text", text: system, cache_control: { type: "ephemeral" } }],
  //       messages: [{ role: "user", content: JSON.stringify(chunk) }],
  //       max_tokens: 2048,
  //     }),
  //   });
  //   const data = await r.json();
  //   const parsed = JSON.parse(data.content[0].text);
  //   return parsed.mutations;
  return editorialAgentRules(chunk, state);
}
