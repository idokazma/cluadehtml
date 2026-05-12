// The prefilter is mostly a *buffer*, not a renderer.
//
// For every incoming AgentEvent, it returns either:
//   - an activity-indicator update (most cases), or
//   - one auto-committed mutation for the few cases where waiting on
//     the editorial pass would feel slow (TodoWrite for the plan,
//     things that are clearly long-running).
//
// The interface agent runs in parallel on settled chunks and can
// override or supplement what the prefilter decided.

import { newId } from "../store/ids.mjs";

const TOOL_NAMES = {
  Read: { activity: (e) => `Reading ${shortPath(e.input?.file_path)}` },
  Edit: { activity: (e) => `Editing ${shortPath(e.input?.file_path)}` },
  Write: { activity: (e) => `Writing ${shortPath(e.input?.file_path)}` },
  Bash: { activity: (e) => `Running: ${truncate(e.input?.command, 60)}` },
  Grep: { activity: (e) => `Searching for "${truncate(e.input?.pattern, 30)}"` },
  Glob: { activity: (e) => `Listing ${e.input?.pattern || ""}` },
  WebFetch: { activity: (e) => `Fetching ${shortHost(e.input?.url)}` },
  WebSearch: { activity: (e) => `Searching the web: "${truncate(e.input?.query, 30)}"` },
  Task: { activity: (e) => `Delegating: ${truncate(e.input?.description, 40)}` },
};

/**
 * @param {import("../types.mjs").AgentEvent} ev
 * @param {object} state  shared mutable buffer between calls
 * @returns {Array<import("../types.mjs").Mutation>}
 */
export function prefilter(ev, state) {
  const out = [];
  state.recent ??= [];
  state.activeTools ??= new Map();   // tool_use_id -> { name, startedAt, activityName }

  if (ev.kind === "user") {
    out.push({
      op: "append",
      component: { id: newId("user"), type: "prompt", props: { text: ev.text || "" } },
      ts: ev.ts,
    });
    return out;
  }

  if (ev.kind === "assistant" && ev.text) {
    // text block: buffer for the editorial agent; show a quiet "thinking" line
    out.push({
      op: "activity",
      state: { name: "Drafting reply…", status: "running", recent: state.recent.slice(-5) },
      ts: ev.ts,
    });
    return out;
  }

  if (ev.kind === "assistant" && ev.tool) {
    // a tool_use: choose between auto-commit and activity
    const spec = TOOL_NAMES[ev.tool];
    const activityName = spec ? spec.activity(ev) : `${ev.tool}(…)`;
    state.activeTools.set(ev.tool_use_id, {
      name: ev.tool,
      activityName,
      startedAt: ev.ts,
    });

    // auto-commit cases
    if (ev.tool === "TodoWrite") {
      const items = (ev.input?.todos || []).map((t) => ({
        label: t.content,
        done: t.status === "completed",
        active: t.status === "in_progress",
      }));
      out.push({
        op: "append",
        component: { id: ensurePlanId(state), type: "plan", props: { title: "Plan", items } },
        ts: ev.ts,
      });
      // If a plan id already existed, send a patch instead of a second append
      if (state.planComponentId) {
        const last = out.pop();
        out.push({ op: "patch", id: state.planComponentId, props: last.component.props, ts: ev.ts });
      } else {
        state.planComponentId = out[out.length - 1].component.id;
      }
      return out;
    }

    // everything else: start as activity. May be promoted to a real
    // component later if it runs long, or if the editorial agent decides.
    pushRecent(state.recent, { name: activityName, status: "running" });
    out.push({
      op: "activity",
      state: { name: activityName, status: "running", recent: state.recent.slice(-5) },
      ts: ev.ts,
    });
    return out;
  }

  if (ev.kind === "tool_result") {
    const t = state.activeTools.get(ev.tool_use_id);
    if (t) {
      const dur = ev.ts - t.startedAt;
      const last = state.recent[state.recent.length - 1];
      if (last) {
        last.status = "done";
        last.metric = formatDuration(dur);
      }
      state.activeTools.delete(ev.tool_use_id);
      out.push({
        op: "activity",
        state: { name: t.activityName, status: "running", recent: state.recent.slice(-5) },
        ts: ev.ts,
      });
    }
    // tool_result content is buffered (in state.lastResults) for the
    // editorial agent to read. We don't auto-commit anything.
    state.lastResults ??= [];
    state.lastResults.push({ tool: t?.name, content: ev.content, tool_use_id: ev.tool_use_id, ts: ev.ts });
    if (state.lastResults.length > 32) state.lastResults.shift();
    return out;
  }

  if (ev.kind === "result") {
    out.push({
      op: "activity",
      state: { name: "Idle", status: "idle", recent: state.recent.slice(-5) },
      ts: ev.ts,
    });
    return out;
  }

  return out;
}

function ensurePlanId(state) { return state.planComponentId || newId("plan"); }

function pushRecent(recent, entry) {
  recent.push(entry);
  if (recent.length > 32) recent.shift();
}

function shortPath(p) {
  if (!p) return "(file)";
  const parts = p.split("/");
  return parts.length <= 3 ? p : ".../" + parts.slice(-3).join("/");
}
function shortHost(u) {
  try { return new URL(u).host; } catch { return u || "(url)"; }
}
function truncate(s, n) {
  if (!s) return "";
  s = String(s);
  return s.length > n ? s.slice(0, n) + "…" : s;
}
function formatDuration(ms) {
  if (ms < 1000) return ms + "ms";
  return (ms / 1000).toFixed(1) + "s";
}
