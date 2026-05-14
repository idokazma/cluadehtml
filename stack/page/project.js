const root = document.getElementById("root");

const CHIP_LABELS = {
  milestone: (p) => p.title || "milestone",
  deploy:    (p) => p.command ? `deploy: ${trunc(p.command, 32)}` : "deploy",
  decision:  (p) => trunc(p.question || "decision", 50),
  schema:    (p) => p.filename ? trunc(p.filename, 40) : "schema",
  diff:      (p) => p.headline ? trunc(p.headline, 50) : (p.filename ? trunc(p.filename, 40) : "diff"),
  plan:      (p) => `plan · ${(p.items || []).length} items`,
  preview:   (p) => p.name ? `preview ${p.name}` : "preview",
  tests:     (p) => p.passed != null ? `${p.passed}/${(p.passed || 0) + (p.failed || 0)} tests` : "tests",
};
const CHIP_ICONS = {
  milestone: "🏁",
  deploy: "🚀",
  decision: "❓",
  schema: "🗂",
  diff: "✏️",
  plan: "📋",
  preview: "👁",
  tests: "✅",
};

function trunc(s, n) { s = String(s || ""); return s.length > n ? s.slice(0, n - 1) + "…" : s; }
function fmtTime(ts) {
  const d = new Date(ts);
  const h = String(d.getHours()).padStart(2, "0");
  const m = String(d.getMinutes()).padStart(2, "0");
  return `${h}:${m}`;
}
function fmtDay(key) {
  const today = todayKey();
  if (key === today) return "today";
  const y = new Date(); y.setDate(y.getDate() - 1);
  if (key === toKey(y)) return "yesterday";
  const d = new Date(key + "T00:00:00");
  return d.toLocaleDateString(undefined, { weekday: "long", month: "short", day: "numeric" });
}
function todayKey() { return toKey(new Date()); }
function toKey(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function el(tag, attrs = {}, children = []) {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === "class") n.className = v;
    else if (k === "html") n.innerHTML = v;
    else n.setAttribute(k, v);
  }
  for (const c of [].concat(children)) {
    if (c == null) continue;
    n.append(c.nodeType ? c : document.createTextNode(c));
  }
  return n;
}

function chipFor(highlight) {
  const labeller = CHIP_LABELS[highlight.type] || ((p) => highlight.type);
  const icon = CHIP_ICONS[highlight.type] || "•";
  return el("span", { class: `chip ${highlight.type}` }, [`${icon} ${labeller(highlight.props || {})}`]);
}

function render(sessions) {
  root.innerHTML = "";
  if (!sessions.length) {
    root.append(el("div", { class: "empty-state" }, [
      el("p", {}, "no sessions yet."),
      el("p", {}, [
        "start one with ",
        el("code", {}, "stack run \"your prompt\""),
        " or ",
        el("code", {}, "stack run --tail"),
        ".",
      ]),
    ]));
    return;
  }
  // Group by day.
  const byDay = new Map();
  for (const s of sessions) {
    if (!byDay.has(s.day)) byDay.set(s.day, []);
    byDay.get(s.day).push(s);
  }
  for (const [day, group] of byDay) {
    const dayEl = el("section", { class: "day" });
    dayEl.append(el("p", { class: "day-label" }, fmtDay(day)));
    for (const s of group) {
      dayEl.append(sessionCard(s));
    }
    root.append(dayEl);
  }
}

function sessionCard(s) {
  const prompt = s.prompt
    ? el("p", { class: "session-prompt" }, s.prompt)
    : el("p", { class: "session-prompt empty" }, "(no prompt captured)");
  const meta = el("p", { class: "session-meta" }, [
    `${s.counts.total} components`,
    s.counts.milestones ? `· ${s.counts.milestones} milestone${s.counts.milestones > 1 ? "s" : ""}` : null,
    s.counts.deploys ? `· ${s.counts.deploys} deploy${s.counts.deploys > 1 ? "s" : ""}` : null,
    s.counts.decisions ? `· ${s.counts.decisions} decision${s.counts.decisions > 1 ? "s" : ""}` : null,
    s.counts.diffs ? `· ${s.counts.diffs} diff${s.counts.diffs > 1 ? "s" : ""}` : null,
  ].filter(Boolean).join(" "));
  const highlights = el("div", { class: "highlights" });
  for (const h of s.highlights) highlights.append(chipFor(h));
  return el("article", { class: "session" }, [
    el("div", { class: "session-time" }, fmtTime(s.startedAt)),
    el("div", { class: "session-body" }, [prompt, meta, highlights]),
  ]);
}

(async () => {
  try {
    const r = await fetch("/api/sessions");
    const { sessions } = await r.json();
    render(sessions);
  } catch (e) {
    root.innerHTML = `<p class="empty-state">failed to load sessions: ${e.message}</p>`;
  }
})();
