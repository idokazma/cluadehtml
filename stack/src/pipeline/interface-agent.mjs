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
    // Rule 1: Schema-shaped Write → schema diagram instead of diff.
    if (ev.kind === "assistant" && ev.tool === "Write") {
      const i = ev.input || {};
      const entities = parseSchema(i.file_path, i.content);
      if (entities && entities.length >= 2) {
        out.push({
          op: "append",
          component: {
            id: newId("schema"),
            type: "schema",
            props: { filename: i.file_path, entities },
          },
          ts: ev.ts,
        });
        continue;
      }
    }

    // Rule 2a: Write of a source file → emit BOTH a `preview` (when we
    // can parse a stylized rendering from the JSX) AND a `module` card
    // (the file shape). Preview is the vivid surface, module is the
    // technical detail just below it.
    if (ev.kind === "assistant" && ev.tool === "Write") {
      const i = ev.input || {};
      const parsed = parseModule(i.file_path, i.content);
      if (parsed) {
        const preview = parseReactPreview(i.file_path, i.content);
        if (preview) {
          out.push({
            op: "append",
            component: {
              id: newId("pv"),
              type: "preview",
              props: {
                filename: i.file_path,
                name: preview.name,
                layout: preview.layout,
                elements: preview.elements,
              },
            },
            ts: ev.ts,
          });
        }
        out.push({
          op: "append",
          component: {
            id: newId("mod"),
            type: "module",
            props: {
              filename: i.file_path,
              lineCount: parsed.lineCount,
              exports: parsed.exports,
              source: i.content,
            },
          },
          ts: ev.ts,
        });
        continue;
      }
    }

    // Rule 2b: Edit (changes to existing code) → diff with semantic
    // classification (bug-fix / feature / wiring / refactor). The
    // classification is the headline; the raw diff stays underneath
    // behind a toggle. Plus any Write that didn't match Rule 2a
    // (binary content, no parseable shape).
    if (ev.kind === "assistant" && (ev.tool === "Edit" || ev.tool === "Write")) {
      const i = ev.input || {};
      const hunks = synthDiffFromEdit(i, ev.tool);
      const classification = classifyChange(i, ev.tool);
      out.push({
        op: "append",
        component: {
          id: newId("diff"),
          type: "diff",
          props: {
            filename: i.file_path || "(unknown)",
            hunks,
            tool: ev.tool,
            ...classification,
          },
        },
        ts: ev.ts,
      });
      continue;
    }

    // Rule 3: prose offering numbered options → decision card.
    if (ev.kind === "assistant" && ev.text) {
      const dec = sniffDecision(ev.text);
      if (dec) {
        out.push({
          op: "append",
          component: { id: newId("dec"), type: "decision", props: { question: dec.question, options: dec.options } },
          ts: ev.ts,
        });
        continue;
      }
    }

    // Rule 4: Bash commands branch by intent.
    //   tests     → `tests` panel (parsed from result later)
    //   deploy    → `deploy` step list (parsed from result later)
    //   build     → `stats` cards (parsed from result later)
    //   anything else long-running → `terminal`
    if (ev.kind === "assistant" && ev.tool === "Bash") {
      const cmd = ev.input?.command || "";
      if (TEST_CMD.test(cmd)) {
        out.push({ op: "append", component: { id: testIdFor(ev.tool_use_id), type: "tests",
          props: { command: cmd, status: "running", tests: [], passed: 0, failed: 0 } }, ts: ev.ts });
        continue;
      }
      if (DEPLOY_CMD.test(cmd)) {
        out.push({ op: "append", component: { id: deployIdFor(ev.tool_use_id), type: "deploy",
          props: { command: cmd, status: "running", steps: deployStepsForCmd(cmd) } }, ts: ev.ts });
        continue;
      }
      if (BUILD_CMD.test(cmd)) {
        out.push({ op: "append", component: { id: statsIdFor(ev.tool_use_id), type: "stats",
          props: { name: cmd, status: "running", stats: [] } }, ts: ev.ts });
        continue;
      }
      if (LONG_CMD.test(cmd)) {
        out.push({ op: "append", component: { id: terminalIdFor(ev.tool_use_id), type: "terminal",
          props: { command: cmd, lines: [], status: "running" } }, ts: ev.ts });
        continue;
      }
    }

    // Rule 5: tool_result of a committed tests / deploy / build / terminal.
    if (ev.kind === "tool_result") {
      const text = typeof ev.content === "string" ? ev.content : JSON.stringify(ev.content);
      const tId = testIdFor(ev.tool_use_id);
      const dId = deployIdFor(ev.tool_use_id);
      const sId = statsIdFor(ev.tool_use_id);
      const cId = terminalIdFor(ev.tool_use_id);

      if (state._committedTests?.has(tId)) {
        const parsed = parseTestOutput(text);
        out.push({ op: "patch", id: tId, props: {
          status: "done", tests: parsed.tests, passed: parsed.passed, failed: parsed.failed, duration: parsed.duration,
        }, ts: ev.ts });
        continue;
      }
      if (state._committedDeploys?.has(dId)) {
        const url = (text.match(/https:\/\/\S+/) || [])[0];
        out.push({ op: "patch", id: dId, props: { status: "done", url, steps: completeAllSteps(state._lastDeploySteps?.get(dId)) }, ts: ev.ts });
        continue;
      }
      if (state._committedStats?.has(sId)) {
        const stats = parseBuildOutput(text);
        out.push({ op: "patch", id: sId, props: { status: "done", stats }, ts: ev.ts });
        continue;
      }
      if (state._committedTerminals?.has(cId)) {
        out.push({ op: "stream", id: cId, append: text, ts: ev.ts });
        out.push({ op: "finalize", id: cId, meta: {}, ts: ev.ts });
        continue;
      }
    }

    // Rule 6: a final-shipment text (with words like "shipped to", URL,
    // and quantitative claims) → `milestone` celebration card.
    if (ev.kind === "assistant" && ev.text && looksLikeShipMilestone(ev.text)) {
      out.push({
        op: "append",
        component: {
          id: newId("ms"),
          type: "milestone",
          props: shipMilestoneProps(ev.text, state),
        },
        ts: ev.ts,
      });
      continue;
    }

    // Rule 7: short summary-feeling notes — kept lightly.
    if (ev.kind === "assistant" && ev.text && shouldKeepNote(ev.text)) {
      out.push({ op: "append", component: { id: newId("note"), type: "note", props: { text: ev.text } }, ts: ev.ts });
    }
  }

  // track committed ids so the result-handling rules above can find them
  state._committedTerminals ??= new Set();
  state._committedTests     ??= new Set();
  state._committedDeploys   ??= new Set();
  state._committedStats     ??= new Set();
  state._lastDeploySteps    ??= new Map();
  for (const m of out) {
    if (m.op !== "append") continue;
    const t = m.component.type, id = m.component.id;
    if (t === "terminal") state._committedTerminals.add(id);
    if (t === "tests")    state._committedTests.add(id);
    if (t === "deploy")   { state._committedDeploys.add(id); state._lastDeploySteps.set(id, m.component.props.steps); }
    if (t === "stats")    state._committedStats.add(id);
  }

  return out;
}

const TEST_CMD   = /(?:^|\s)(?:npm|pnpm|yarn) (?:test|run test)|\bvitest\b|\bjest\b|\bpytest\b|\bcargo test\b/;
const BUILD_CMD  = /(?:npm|pnpm|yarn) (?:run )?build|\bvite build\b|\bwebpack\b|\brollup\b|\btsc(?: -b)?\b/;
const DEPLOY_CMD = /\bvercel deploy\b|\bdocker push\b|\bkubectl apply\b|\bnetlify deploy\b|\bfly deploy\b/;
const LONG_CMD   = /\bdocker\b|\bmigrate\b|\bnpm ci\b|\bnpm install\b/;

function terminalIdFor(toolUseId) { return `term-${toolUseId || "x"}`; }
function testIdFor(toolUseId)     { return `tst-${toolUseId || "x"}`; }
function deployIdFor(toolUseId)   { return `dep-${toolUseId || "x"}`; }
function statsIdFor(toolUseId)    { return `stat-${toolUseId || "x"}`; }

function deployStepsForCmd(cmd) {
  if (/vercel/.test(cmd)) return [
    { name: "Upload artifact", status: "running" },
    { name: "Build on Vercel", status: "pend" },
    { name: "Promote to production", status: "pend" },
  ];
  if (/docker push/.test(cmd)) return [
    { name: "Push image layers", status: "running" },
    { name: "Sign manifest", status: "pend" },
    { name: "Update tag", status: "pend" },
  ];
  return [{ name: "Deploying", status: "running" }];
}
function completeAllSteps(steps) {
  if (!steps) return [];
  return steps.map((s, i) => ({ ...s, status: "done", time: (0.6 + i * 0.4).toFixed(1) + "s" }));
}

function parseTestOutput(text) {
  const passed = +(text.match(/Tests?\s+(\d+)\s+passed/i)?.[1] || 0);
  const failed = +(text.match(/(\d+)\s+failed/i)?.[1] || 0);
  const duration = (text.match(/Duration\s+([\d.]+\s*m?s)/i) || [])[1] || "";
  // Synthesize representative test rows for display.
  const tests = [];
  for (let i = 0; i < passed; i++) tests.push({ name: `test ${i + 1}`, status: "pass", time: (Math.random() * 40 + 5).toFixed(0) + "ms" });
  for (let i = 0; i < failed; i++) tests.push({ name: `failing test ${i + 1}`, status: "fail", time: (Math.random() * 40 + 5).toFixed(0) + "ms" });
  return { passed, failed, duration, tests };
}

function parseBuildOutput(text) {
  const stats = [];
  // bundle sizes: "  dist/assets/index.js  82.14 kB"
  const sizeMatch = text.match(/([\d.]+)\s*kB/g) || [];
  if (sizeMatch.length) {
    const sizes = sizeMatch.map(s => parseFloat(s)).filter(n => !isNaN(n));
    const total = sizes.reduce((a, b) => a + b, 0);
    stats.push({ label: "Bundle", value: total.toFixed(1) + " kB", tone: total < 100 ? "green" : "yellow",
      spark: [total * 1.2, total * 1.15, total * 1.08, total * 1.04, total] });
  }
  // module count: "142 modules transformed"
  const modulesMatch = text.match(/(\d+)\s+modules/i);
  if (modulesMatch) stats.push({ label: "Modules", value: modulesMatch[1] });
  // build time: "built in 1.31s"
  const timeMatch = text.match(/built in ([\d.]+\s*m?s)/i);
  if (timeMatch) stats.push({ label: "Build time", value: timeMatch[1], tone: "green" });
  return stats;
}

/**
 * Detect a stylized preview from a React component file. Returns a
 * { name, layout, elements } shape the page can paint.
 *
 * Strategy: look at the JSX `return (...)` and convert known patterns
 * into a small element list. The page CSS picks colors and shapes; the
 * preview is a *schematic* of what the component will render — close
 * enough to feel real, intentionally not a perfect runtime mock.
 */
/**
 * Classify a code change into a *semantic* shape: bug-fix, feature,
 * wiring, refactor, or config. Returns { kind, icon, headline,
 * before?, after? } that the page renders as a vivid change card.
 *
 * This is the rules-implementation; an LLM-backed interface agent
 * would write much better classifications. The rules below catch
 * the common-case patterns:
 *   - condition flips and "naive" / "TODO" comments being removed → bug-fix
 *   - new top-level exports appearing → feature
 *   - new hook calls / subscribe / register added to a component → wiring
 *   - file under config dirs or with config extensions → config
 *   - otherwise → refactor
 */
function classifyChange(input, tool) {
  const old = input.old_string || "";
  const neu = input.new_string || input.content || "";
  const file = input.file_path || "";
  const isWrite = tool === "Write";

  // BUG FIX — strong signals:
  //   - old contains "naive", "TODO", "FIXME", "HACK", or a known bad-path
  //   - or condition flipped (e.g., > 1 → === 1)
  //   - or returns/assigns a clearly-wrong constant
  if (!isWrite && (
    /\b(naive|TODO|FIXME|HACK|XXX|broken|wrong|bug)\b/i.test(old) ||
    (/\bgap\s*[>]\s*1\b/.test(old) && /\bgap\s*===\s*[12]\b/.test(neu)) ||
    (/return\s*\{[^}]*current:\s*0\s*,\s*longest:\s*0\s*\}/.test(old) && !/current:\s*0\s*,\s*longest:\s*0/.test(neu))
  )) {
    return {
      kind: "bug-fix",
      icon: "🐛",
      headline: inferBugFixHeadline(old, neu, file),
      before: oneLineFrom(old, /\/\/[^\n]*|\bgap\s*[><=!]+\s*\d+|return\s*\{[^}]+\}/) || trim(old, 80),
      after:  oneLineFrom(neu, /\bgap\s*===\s*\d+|else if|else current/) || trim(neu, 80),
    };
  }

  // FEATURE — new top-level export that didn't exist before
  const newExports = [...neu.matchAll(/export\s+(?:async\s+)?function\s+(\w+)/g)].map(m => m[1]);
  const oldExports = new Set([...old.matchAll(/export\s+(?:async\s+)?function\s+(\w+)/g)].map(m => m[1]));
  const addedExports = newExports.filter(n => !oldExports.has(n));
  if (addedExports.length > 0 && !isWrite) {
    const name = addedExports[0];
    return {
      kind: "feature",
      icon: "✨",
      headline: `${humanizeName(name)} — new capability`,
      before: "Not available",
      after:  `\`${name}(…)\` is exported and ready to call`,
    };
  }

  // WIRING — new hook/subscribe/register call added (typical of App.tsx-style files)
  if (!isWrite) {
    const wiringAdditions = findWiringAdditions(old, neu);
    if (wiringAdditions) {
      return {
        kind: "wiring",
        icon: "🔗",
        headline: wiringAdditions.headline,
        before: wiringAdditions.before,
        after:  wiringAdditions.after,
      };
    }
  }

  // CONFIG / INFRA
  if (/\.(yml|yaml|json|toml|env|conf)$/i.test(file) || /(^|\/)\.github\/|deploy|workflow|migration/i.test(file)) {
    return {
      kind: "config",
      icon: "⚙",
      headline: isWrite ? `New config file` : `Config updated`,
    };
  }

  // FALLBACK — generic refactor
  if (!isWrite) {
    return {
      kind: "refactor",
      icon: "♻",
      headline: `Updated ${file.split("/").pop() || "code"}`,
    };
  }
  return null;
}

function humanizeName(camel) {
  return camel
    .replace(/^(use|get|set|do|is|has)([A-Z])/, "$2") // strip verb prefixes for clarity
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .replace(/^./, c => c.toUpperCase())
    .trim();
}
function trim(s, n) { s = String(s || "").replace(/\s+/g, " ").trim(); return s.length > n ? s.slice(0, n) + "…" : s; }
function oneLineFrom(text, re) {
  const m = String(text).match(re);
  return m ? trim(m[0], 80) : null;
}
function inferBugFixHeadline(old, neu, file) {
  if (/streak/i.test(old + neu) && /gap/.test(old + neu)) {
    return "Streak no longer resets on a 1-day gap";
  }
  if (/return\s*null|return\s*undefined/i.test(old) && !/return\s*null|return\s*undefined/.test(neu)) {
    return "Fixed: function no longer returns null on the happy path";
  }
  if (/\bnaive\b/i.test(old)) return "Replaced naive implementation with the real one";
  const base = (file.split("/").pop() || "code").replace(/\.[^.]+$/, "");
  return `Bug fix in ${base}`;
}
function findWiringAdditions(old, neu) {
  // Hooks (useTheme(), useEffect(...), etc.) added that weren't there before
  const oldHooks = new Set([...old.matchAll(/\b(use[A-Z]\w*)\s*\(/g)].map(m => m[1]));
  const newHooks = [...neu.matchAll(/\b(use[A-Z]\w*)\s*\(/g)].map(m => m[1]);
  const added = newHooks.filter(h => !oldHooks.has(h));

  // Specific signals
  if (added.includes("useTheme") || /useTheme\s*\(/.test(neu) && !/useTheme\s*\(/.test(old)) {
    return {
      headline: "Theme system wired into the app",
      before:   "App rendered without a theme",
      after:    "useTheme() applies light/dark/auto on mount",
    };
  }
  if (/subscribeToReminders|pushManager\.subscribe|registerServiceWorker/.test(neu)
      && !/subscribeToReminders|pushManager\.subscribe|registerServiceWorker/.test(old)) {
    return {
      headline: "Push notifications wired into the app",
      before:   "App didn't request push subscription",
      after:    "App registers the SW and subscribes on mount",
    };
  }
  if (added.length > 0) {
    const h = added[0];
    return {
      headline: `\`${h}()\` wired into the component`,
      before:   `${h} was defined but never called`,
      after:    `${h}() runs on mount`,
    };
  }
  return null;
}

function parseReactPreview(filePath, content) {
  if (!/\.(tsx|jsx)$/.test(filePath || "")) return null;
  if (!/return\s*\(?\s*</.test(content)) return null;
  const nameMatch = content.match(/export\s+(?:default\s+)?function\s+(\w+)/);
  if (!nameMatch) return null;
  const name = nameMatch[1];
  const elements = [];

  // className="name" → component name field. We substitute a fake value
  // for the demo; in real use the interface agent (LLM) would inspect
  // a sample state or prop usage.
  if (/className=["']name["']/.test(content)) {
    elements.push({ type: "name", text: "Drink water" });
  }
  // Streak counter
  if (/className=[`"'][^"`']*streak/.test(content) || /streak\.current/.test(content)) {
    elements.push({ type: "streak", value: 12, label: "day streak" });
  }
  // Buttons — capture only literal text between `>` and `</button>`,
  // refusing anything that looks like a JSX expression.
  for (const m of content.matchAll(/>\s*([^\s<{][^<{}]*?)\s*<\/button>/g)) {
    const t = m[1].trim();
    if (!t || t.length > 40) continue;
    const kind = /freeze|❄/i.test(t) ? "freeze" : null;
    elements.push({ type: "button", text: t, kind });
  }
  if (elements.length === 0) return null;
  const layout = (elements.length === 1 && elements[0].type === "button") ? "button-only" : "card";
  return { name, layout, elements };
}

/**
 * Parse a newly-written file into a module summary: lineCount + exports.
 * Returns null when we can't extract anything useful (and the caller
 * falls back to a diff).
 */
function parseModule(filePath, content) {
  if (!filePath || typeof content !== "string") return null;
  const lineCount = content.split("\n").length;
  const ext = (filePath.split(".").pop() || "").toLowerCase();
  const exports = [];

  // TypeScript / JavaScript: parse `export ...`
  if (["ts", "tsx", "js", "jsx", "mjs"].includes(ext)) {
    const patterns = [
      [/export\s+(?:async\s+)?function\s+(\w+)/g, "function"],
      [/export\s+default\s+function\s+(\w+)/g, "function"],
      [/export\s+class\s+(\w+)/g, "class"],
      [/export\s+interface\s+(\w+)/g, "interface"],
      [/export\s+type\s+(\w+)/g, "type"],
      [/export\s+const\s+(\w+)/g, "const"],
      [/export\s+let\s+(\w+)/g, "const"],
      [/export\s+\{\s*([^}]+)\s*\}/g, "reexport"],
    ];
    for (const [re, kind] of patterns) {
      for (const m of content.matchAll(re)) {
        if (kind === "reexport") {
          for (const name of m[1].split(",")) {
            const clean = name.trim().split(/\s+as\s+/)[0].trim();
            if (clean && !exports.find(e => e.name === clean)) exports.push({ name: clean, kind: "const" });
          }
        } else {
          if (!exports.find(e => e.name === m[1])) exports.push({ name: m[1], kind });
        }
      }
    }
    // Service-worker-style files: top-level event listeners as "handler" pills
    if (exports.length === 0) {
      for (const m of content.matchAll(/(?:self|globalThis|window)\.addEventListener\(['"](\w+)['"]/g)) {
        exports.push({ name: "on:" + m[1], kind: "handler" });
      }
    }
  }

  // YAML: top-level keys
  if (ext === "yml" || ext === "yaml") {
    const topKeys = new Set();
    for (const line of content.split("\n")) {
      const m = line.match(/^(\w[\w-]*):/);
      if (m) topKeys.add(m[1]);
    }
    // and any `jobs:` subkeys
    const jobs = [...content.matchAll(/^\s{2}(\w[\w-]*):\s*\n\s{4}/gm)].map(m => m[1]);
    for (const k of topKeys) exports.push({ name: k, kind: "section" });
    for (const j of jobs) exports.push({ name: "job: " + j, kind: "section" });
  }

  // SQL: CREATE TABLE statements
  if (ext === "sql") {
    for (const m of content.matchAll(/CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?(\w+)/gi)) {
      exports.push({ name: m[1], kind: "class" });
    }
  }

  // JSON: top-level keys
  if (ext === "json") {
    try {
      const obj = JSON.parse(content);
      for (const k of Object.keys(obj || {})) exports.push({ name: k, kind: "const" });
    } catch { /* invalid json */ }
  }

  // Cap exports for display
  if (exports.length > 12) {
    const rest = exports.length - 11;
    exports.length = 11;
    exports.push({ name: `… +${rest} more`, kind: "section" });
  }

  // For unknown file types, only emit if we got something
  if (exports.length === 0 && !["ts", "tsx", "js", "jsx", "mjs", "yml", "yaml"].includes(ext)) {
    return null;
  }

  return { lineCount, exports };
}

function parseSchema(filePath, content) {
  if (!filePath || !content) return null;
  if (!/(schema|db)\.(ts|js|sql)$/.test(filePath) && !/migrations\//.test(filePath)) return null;
  const entities = [];
  // TypeScript: `export interface X { id: string; name: string; ... }`
  for (const m of content.matchAll(/(?:export\s+)?interface\s+(\w+)\s*\{([^}]*)\}/g)) {
    const name = m[1];
    const body = m[2];
    const fields = [];
    for (const fm of body.matchAll(/(\w+)\s*\??\s*:\s*([^;,\n]+)/g)) {
      const fname = fm[1];
      const ftype = fm[2].trim();
      const refs = inferRef(fname, ftype, entities);
      fields.push({ name: fname, type: ftype, refs });
    }
    entities.push({ name, fields });
  }
  // SQL: `CREATE TABLE foo ( ... );`
  for (const m of content.matchAll(/CREATE\s+TABLE\s+(\w+)\s*\(([^;]*)\)/gi)) {
    const name = m[1];
    const body = m[2];
    const fields = [];
    for (const line of body.split(",")) {
      const fm = line.trim().match(/^(\w+)\s+(\w+)/);
      if (fm) fields.push({ name: fm[1], type: fm[2] });
    }
    entities.push({ name, fields });
  }
  return entities.length >= 2 ? entities : null;
}

function inferRef(fname, ftype, knownEntities) {
  // crude: a field named `userId` / `user_id` refers to an entity called `User` or `user`
  const m = fname.match(/^(\w+?)(?:_?[Ii]d)$/);
  if (!m) return null;
  const guess = m[1];
  const found = knownEntities.find(e => e.name.toLowerCase() === guess.toLowerCase() || e.name.toLowerCase() === guess.toLowerCase() + "s");
  return found ? found.name : null;
}

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

function looksLikeShipMilestone(text) {
  if (!text || text.length > 400) return false;
  return /\b(shipped|deployed|live at|production)\b/i.test(text);
}
function shipMilestoneProps(text, state) {
  // Try a full URL first; fall back to a bare host like "habits.app"
  // mentioned after "Shipped to" / "live at".
  let url = (text.match(/https?:\/\/\S+/) || [])[0];
  if (!url) {
    const host = text.match(/(?:shipped to|live at|production:?)\s+([\w-]+(?:\.[\w-]+)+)/i);
    if (host) url = "https://" + host[1];
  }
  // Pull rough numbers from the text
  const tests = text.match(/(\d+)\s*\/\s*(\d+)\s*tests?\s*green/i);
  const bundle = text.match(/(\d+(?:\.\d+)?)\s*kB/i);
  const plan = text.match(/(\d+)\s+plan items?/i);
  const stats = [];
  if (plan)   stats.push({ label: "Plan",      value: plan[1] + "/" + plan[1] + " done", tone: "green" });
  if (tests)  stats.push({ label: "Tests",     value: tests[1] + " / " + tests[2],        tone: "green" });
  if (bundle) stats.push({ label: "Bundle",    value: bundle[1] + " kB" });
  if (!stats.length) stats.push({ label: "Status", value: "live", tone: "green" });

  const title = url ? `Shipped to ${url.replace(/^https?:\/\//, "")}` : "Shipped";
  const subtitle = text.replace(/https?:\/\/\S+/g, "").replace(/\s+/g, " ").trim().slice(0, 200);
  return { icon: "🚀", kind: "shipped", title, subtitle, url, stats };
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
// LLM-backed implementation. Drop-in replacement for editorialAgentRules.
// Reads the system prompt from prompts/interface-agent.md, asks Claude to
// emit JSON, parses, and returns mutations in the shape the rest of the
// pipeline expects.

const PROMPT_PATH = path.resolve(__dirname, "../../prompts/interface-agent.md");
const ANTHROPIC_URL = "https://api.anthropic.com/v1/messages";
const DEFAULT_MODEL = "claude-haiku-4-5-20251001";

let cachedPrompt = null;
function loadPrompt() {
  if (cachedPrompt) return cachedPrompt;
  try { cachedPrompt = fs.readFileSync(PROMPT_PATH, "utf8"); } catch { cachedPrompt = ""; }
  return cachedPrompt;
}

/**
 * Call Haiku with the interface-agent prompt. Falls back to rules if there's
 * no API key, no prompt on disk, or the call fails. The system prompt is
 * tagged with cache_control: ephemeral so subsequent calls within ~5 min hit
 * the prompt cache and pay only for the (tiny) per-turn input.
 *
 * @param {import("../types.mjs").AgentEvent[]} chunk
 * @param {object} state                shared pipeline state
 * @param {object} [opts]
 * @param {Function} [opts.fetch]       injectable for tests
 * @param {string} [opts.apiKey]        override env var
 * @param {string} [opts.model]
 * @returns {Promise<Array<import("../types.mjs").Mutation>>}
 */
export async function editorialAgentLLM(chunk, state, opts = {}) {
  const system = loadPrompt();
  const apiKey = opts.apiKey || process.env.ANTHROPIC_API_KEY;
  if (!system || !apiKey) return editorialAgentRules(chunk, state);

  const fetcher = opts.fetch || globalThis.fetch;
  if (typeof fetcher !== "function") return editorialAgentRules(chunk, state);

  const userPayload = {
    user_prompt: state._lastUserPrompt || "",
    context: {
      recent_activity: (state._recentActivity || []).slice(-5),
      open_components: [...(state._openComponents || [])],
    },
    events: chunk.map(serializeEvent),
  };

  try {
    const res = await fetcher(ANTHROPIC_URL, {
      method: "POST",
      headers: {
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: opts.model || DEFAULT_MODEL,
        max_tokens: 2048,
        system: [{ type: "text", text: system, cache_control: { type: "ephemeral" } }],
        messages: [{ role: "user", content: JSON.stringify(userPayload) }],
      }),
    });
    if (!res.ok) {
      const body = await safeText(res);
      throw new Error(`anthropic ${res.status}: ${body.slice(0, 200)}`);
    }
    const data = await res.json();
    const text = data?.content?.[0]?.text || "";
    const parsed = extractJson(text);
    if (!parsed) throw new Error("could not parse JSON from model output");
    return toMutations(parsed, chunk, state);
  } catch (e) {
    console.error("[editorial-llm] falling back to rules:", e.message);
    return editorialAgentRules(chunk, state);
  }
}

function serializeEvent(ev) {
  if (ev.kind === "assistant" && ev.tool) {
    return { kind: "assistant", tool: ev.tool, input: ev.input, tool_use_id: ev.tool_use_id };
  }
  if (ev.kind === "assistant") return { kind: "assistant", text: ev.text };
  if (ev.kind === "user") return { kind: "user", text: ev.text };
  if (ev.kind === "tool_result") {
    const c = typeof ev.content === "string" ? ev.content : JSON.stringify(ev.content);
    return { kind: "tool_result", tool_use_id: ev.tool_use_id, content: c.slice(0, 4000) };
  }
  return { kind: ev.kind };
}

function extractJson(text) {
  if (!text) return null;
  // The prompt asks for JSON only, but some models wrap in fences. Be forgiving.
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const body = (fence ? fence[1] : text).trim();
  try { return JSON.parse(body); } catch {}
  // Last-resort: find the outermost {...}.
  const first = body.indexOf("{");
  const last = body.lastIndexOf("}");
  if (first >= 0 && last > first) {
    try { return JSON.parse(body.slice(first, last + 1)); } catch {}
  }
  return null;
}

function toMutations(parsed, chunk, state) {
  const ts = chunk[chunk.length - 1]?.ts || Date.now();
  const out = [];
  if (parsed.activity) {
    out.push({ op: "activity", ...parsed.activity, ts });
  }
  for (const c of parsed.commits || []) {
    if (c.op === "append" && c.component) {
      const comp = { ...c.component };
      if (!comp.id) comp.id = newId(abbrev(comp.type));
      out.push({ op: "append", component: comp, ts });
      // Track ids so subsequent patches from the LLM can target them by id.
      state._openComponents ??= new Set();
      state._openComponents.add(comp.id);
    } else if (c.op === "patch" && c.id) {
      out.push({ op: "patch", id: c.id, props: c.props || {}, ts });
    }
  }
  return out;
}

function abbrev(type) {
  // Keep ids short and memorable. Maps the prompt's vocabulary to short prefixes.
  const m = { milestone: "ms", decision: "dec", schema: "sch", module: "mod",
              preview: "pv", terminal: "term", tests: "tst", deploy: "dep",
              stats: "stat", summary: "sum", compare: "cmp", designs: "des" };
  return m[type] || (type || "c").slice(0, 4);
}

async function safeText(res) {
  try { return await res.text(); } catch { return ""; }
}
