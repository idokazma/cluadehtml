// Index of all sessions for a project. Scans the sessions directory and
// distills each event log into a small summary the project page can show.
// Untouched by the live pipeline — pure read-side.

import fs from "node:fs";
import path from "node:path";

// Component types worth lifting into the rollup. Most events fold into
// activity; these are the things that earn the surface across sessions.
const KEY_TYPES = new Set([
  "milestone", "decision", "deploy", "schema", "plan", "preview", "tests", "diff",
]);

/**
 * List every session in a sessions directory, newest first.
 * @param {string} sessionsDir  typically <cwd>/.stack/sessions
 * @returns {Array<SessionSummary>}
 */
export function listSessions(sessionsDir) {
  if (!fs.existsSync(sessionsDir)) return [];
  const files = fs.readdirSync(sessionsDir).filter(f => f.endsWith(".events.jsonl"));
  const out = [];
  for (const file of files) {
    const full = path.join(sessionsDir, file);
    try {
      const summary = summarizeSession(full);
      if (summary) out.push(summary);
    } catch (e) {
      console.error(`[sessions] failed to read ${file}:`, e.message);
    }
  }
  out.sort((a, b) => b.startedAt - a.startedAt);
  return out;
}

/**
 * @typedef {object} SessionSummary
 * @property {string} id
 * @property {number} startedAt    ms epoch of first event
 * @property {number} endedAt      ms epoch of last event
 * @property {string} day          YYYY-MM-DD of startedAt (local time)
 * @property {string} prompt       first user prompt (or "" if none)
 * @property {Array<{type: string, props: object, ts: number}>} highlights
 * @property {{milestones: number, decisions: number, deploys: number, diffs: number, total: number}} counts
 */

function summarizeSession(file) {
  const id = path.basename(file).replace(/\.events\.jsonl$/, "");
  const stat = fs.statSync(file);
  // For empty logs, still surface the session as a stub.
  const lines = fs.readFileSync(file, "utf8").split("\n").filter(Boolean);
  if (!lines.length) return null;

  const components = new Map();   // id -> { type, props, ts }
  let firstTs = Infinity, lastTs = 0;
  for (const line of lines) {
    let m;
    try { m = JSON.parse(line); } catch { continue; }
    if (m.ts != null) {
      if (m.ts < firstTs) firstTs = m.ts;
      if (m.ts > lastTs)  lastTs  = m.ts;
    }
    if (m.op === "append" && m.component?.id) {
      components.set(m.component.id, {
        type: m.component.type,
        props: m.component.props || {},
        ts: m.ts || 0,
      });
    } else if (m.op === "patch" && m.id && components.has(m.id)) {
      const c = components.get(m.id);
      c.props = { ...c.props, ...m.props };
    }
  }
  if (firstTs === Infinity) firstTs = stat.mtimeMs;
  if (lastTs === 0)         lastTs  = stat.mtimeMs;

  // First user prompt (committed as a `prompt` component by prefilter).
  let prompt = "";
  for (const c of components.values()) {
    if (c.type === "prompt" && c.props?.text) { prompt = c.props.text; break; }
  }

  const highlights = [];
  const counts = { milestones: 0, decisions: 0, deploys: 0, diffs: 0, total: components.size };
  for (const c of components.values()) {
    if (!KEY_TYPES.has(c.type)) continue;
    if (c.type === "milestone") counts.milestones++;
    if (c.type === "decision")  counts.decisions++;
    if (c.type === "deploy")    counts.deploys++;
    if (c.type === "diff")      counts.diffs++;
    // Cap the highlight list per session.
    if (highlights.length < 8) highlights.push({ type: c.type, props: c.props, ts: c.ts });
  }
  // Stable highlight order: milestones / deploys first, then by timestamp.
  highlights.sort((a, b) => priority(b.type) - priority(a.type) || a.ts - b.ts);

  return {
    id,
    startedAt: firstTs,
    endedAt:   lastTs,
    day:       dayKey(firstTs),
    prompt,
    highlights,
    counts,
  };
}

function priority(type) {
  return { milestone: 3, deploy: 2, decision: 1 }[type] || 0;
}

function dayKey(ts) {
  const d = new Date(ts);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${dd}`;
}

/**
 * Read a single session's full event log.
 * @param {string} sessionsDir
 * @param {string} sessionId
 */
export function readSession(sessionsDir, sessionId) {
  const file = path.join(sessionsDir, `${sessionId}.events.jsonl`);
  if (!fs.existsSync(file)) return null;
  return fs.readFileSync(file, "utf8")
    .split("\n").filter(Boolean)
    .map(l => { try { return JSON.parse(l); } catch { return null; } })
    .filter(Boolean);
}
