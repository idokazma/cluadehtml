// session.js — applies mutations from /events into the DOM.
//
// Components are registered in a Map<id, { type, props, dom }>.
// Each mutation (append / patch / stream / finalize / activity)
// finds the right renderer for the type and updates the DOM.

const $  = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const el = (tag, attrs = {}, ...children) => {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (k === "class") n.className = v;
    else if (k === "html") n.innerHTML = v;
    else if (k.startsWith("on")) n.addEventListener(k.slice(2), v);
    else if (v !== false && v != null) n.setAttribute(k, v);
  }
  for (const c of children.flat()) {
    if (c == null || c === false) continue;
    n.append(c.nodeType ? c : document.createTextNode(c));
  }
  return n;
};

const stream = $("#stream");
const components = new Map();

// ---- renderers ----
const renderers = {
  prompt: {
    mount: (c) => el("div", { class: "prompt" },
      el("div", { class: "who" }, "you"),
      el("div", null, c.props.text || ""),
    ),
  },
  note: {
    mount: (c) => el("div", { class: "component" },
      header("✦", "note", "claude"),
      el("div", { class: "note", html: escapeHtml(c.props.text || "") }),
    ),
  },
  plan: {
    mount: (c) => {
      const node = el("div", { class: "component plan" },
        header("📋", "plan", c.props.title || "Plan", (c.props.items || []).length + " steps"),
        el("div", { class: "c-body" }, el("ul")),
      );
      renderPlanItems(node, c);
      return node;
    },
    update: (dom, c) => renderPlanItems(dom, c),
  },
  diff: {
    mount: (c) => {
      const dom = el("div", { class: "component" },
        header("✎", "diff", c.props.filename || "(file)"),
        el("div", { class: "diff" }),
      );
      renderDiff(dom, c);
      return dom;
    },
  },
  terminal: {
    mount: (c) => {
      const dom = el("div", { class: "component" },
        header("⌘", "terminal", "$ " + (c.props.command || ""), c.props.status === "running" ? "running…" : "done"),
        el("pre", { class: "term" }),
      );
      for (const ln of c.props.lines || []) $(".term", dom).append(el("span", { class: "line" }, ln + "\n"));
      return dom;
    },
    stream: (dom, append) => {
      const t = $(".term", dom);
      t.append(el("span", { class: "line" }, append));
      t.scrollTop = t.scrollHeight;
    },
    finalize: (dom, meta) => {
      const m = $(".meta", dom);
      if (m) m.textContent = (meta && meta.exit != null) ? `exit ${meta.exit}` : "done";
    },
  },
  decision: {
    mount: (c) => {
      const dom = el("div", { class: "component decision" },
        header("?", "decision", "question for you"),
        el("div", { class: "c-body" },
          el("div", { style: "margin-bottom: 10px; color: var(--fg);" }, c.props.question || ""),
          el("div", { class: "opts" },
            ...(c.props.options || []).map((o, i) =>
              el("div", {
                class: "opt",
                onclick: () => pickDecision(c.id, dom, i, o),
              },
                el("div", { class: "opt-label" }, o.label || `Option ${i+1}`),
                el("div", { class: "opt-desc" }, o.desc || ""),
              )
            ),
          ),
        ),
      );
      if (c.props.picked != null) markPicked(dom, c.props.picked);
      return dom;
    },
  },

  /* tests panel — pass/fail rows + summary */
  tests: {
    mount: (c) => {
      const dom = el("div", { class: "component" },
        header("✓", "tests", "$ " + (c.props.command || ""),
          c.props.status === "running" ? "running…" : ((c.props.failed || 0) > 0 ? `${c.props.failed} failed` : "all passed")),
        el("div", { class: "tests" }),
        el("div", { class: "tests-summary" }),
      );
      renderTests(dom, c);
      return dom;
    },
    update: (dom, c) => renderTests(dom, c),
  },

  /* schema diagram */
  schema: {
    mount: (c) => {
      const dom = el("div", { class: "component schema" },
        header("🗂", "schema", c.props.filename || "schema",
          (c.props.entities || []).length + " tables"),
        el("div", { class: "schema-svg" }),
        el("div", { class: "schema-detail" }, "Click a table to see its purpose."),
      );
      renderSchema(dom, c);
      return dom;
    },
  },

  /* deploy: sequential progress steps */
  deploy: {
    mount: (c) => {
      const dom = el("div", { class: "component" },
        header("🚀", "deploy", "$ " + (c.props.command || ""),
          c.props.status === "done" ? (c.props.url ? "deployed" : "done") : "running…"),
        el("div", { class: "deploy" }),
      );
      renderDeploy(dom, c);
      return dom;
    },
    update: (dom, c) => {
      const meta = $(".meta", dom);
      if (meta) meta.textContent = c.props.status === "done" ? (c.props.url ? "deployed" : "done") : "running…";
      renderDeploy(dom, c);
    },
  },

  /* stats grid with optional sparklines */
  stats: {
    mount: (c) => {
      const dom = el("div", { class: "component" },
        header("📊", "stats", c.props.name || "build output",
          (c.props.stats || []).length + " metrics"),
        el("div", { class: "stats-grid" }),
      );
      renderStatsGrid(dom, c);
      return dom;
    },
    update: (dom, c) => renderStatsGrid(dom, c),
  },

function header(icon, kind, name, meta) {
  return el("div", { class: "c-head" },
    el("span", { class: "icon" }, icon),
    el("span", { class: "kind" }, kind),
    el("span", { class: "name" }, name),
    el("span", { class: "meta" }, meta || ""),
  );
}

function renderPlanItems(dom, c) {
  const ul = $("ul", dom);
  ul.innerHTML = "";
  (c.props.items || []).forEach((it, i) => {
    ul.append(el("li", { class: (it.done ? "done " : "") + (it.active ? "active" : "") + " plan-item",
      onclick: () => toggleStep(c.id, i, !it.done) },
      el("span", { class: "check" }),
      el("span", null, it.label),
    ));
  });
  const meta = $(".meta", dom);
  if (meta) meta.textContent = `${(c.props.items || []).filter(i => i.done).length} / ${(c.props.items || []).length}`;
}

function renderDiff(dom, c) {
  const wrap = $(".diff", dom);
  wrap.innerHTML = "";
  let line = (c.props.hunks?.[0]?.startLine ?? 1);
  for (const h of c.props.hunks || []) {
    for (const [k, t] of h.lines) {
      const cls = k === "+" ? "add" : k === "-" ? "del" : "ctx";
      wrap.append(el("div", { class: `row ${cls}` },
        el("span", { class: "gutter" }, k === "-" ? "" : String(line)),
        document.createTextNode(t),
      ));
      if (k !== "-") line++;
    }
  }
}

function renderTests(dom, c) {
  const wrap = $(".tests", dom);
  wrap.innerHTML = "";
  const tests = c.props.tests || [];
  for (const t of tests) {
    wrap.append(el("div", { class: `test ${t.status || "pend"}` },
      el("span", { class: "badge" }, t.status === "pass" ? "✓" : t.status === "fail" ? "✕" : ""),
      el("span", { class: "nm" }, t.name),
      el("span", { class: "tm" }, t.time || ""),
    ));
  }
  const total = c.props.passed || 0;
  const failed = c.props.failed || 0;
  const sum = $(".tests-summary", dom);
  if (sum) {
    sum.innerHTML = "";
    sum.append(
      el("span", null, el("b", { class: "ok" }, String(total)), " passed"),
      failed > 0 ? el("span", null, el("b", { class: "bad" }, String(failed)), " failed") : null,
      c.props.duration ? el("span", null, "in ", el("b", null, c.props.duration)) : null,
    );
  }
  const meta = $(".meta", dom);
  if (meta) meta.textContent = c.props.status === "running" ? "running…" : (failed > 0 ? `${failed} failed` : `${total} passed`);
}

function renderSchema(dom, c) {
  const svgWrap = $(".schema-svg", dom);
  svgWrap.innerHTML = "";
  const entities = c.props.entities || [];
  if (entities.length === 0) {
    svgWrap.append(el("div", { style: "padding: 14px; color: var(--fg-mute); font-size: 12px;" }, "(no entities parsed)"));
    return;
  }
  // simple grid layout
  const cols = entities.length <= 2 ? entities.length : 2;
  const rows = Math.ceil(entities.length / cols);
  const boxW = 180, boxH = 90, padX = 30, padY = 20;
  const W = cols * boxW + (cols + 1) * padX;
  const H = rows * boxH + (rows + 1) * padY + 20;
  const ns = "http://www.w3.org/2000/svg";
  const svg = document.createElementNS(ns, "svg");
  svg.setAttribute("viewBox", `0 0 ${W} ${H}`);
  svg.setAttribute("preserveAspectRatio", "xMidYMid meet");
  // entities
  const positions = new Map();
  entities.forEach((e, i) => {
    const row = Math.floor(i / cols), col = i % cols;
    const x = padX + col * (boxW + padX);
    const y = padY + row * (boxH + padY);
    positions.set(e.name, { x, y, w: boxW, h: boxH });
  });
  // relationships
  for (const e of entities) {
    for (const f of e.fields || []) {
      if (f.refs && positions.has(f.refs)) {
        const a = positions.get(e.name), b = positions.get(f.refs);
        const ln = document.createElementNS(ns, "line");
        ln.setAttribute("class", "rel");
        ln.setAttribute("x1", a.x + a.w / 2); ln.setAttribute("y1", a.y);
        ln.setAttribute("x2", b.x + b.w / 2); ln.setAttribute("y2", b.y + b.h);
        svg.append(ln);
      }
    }
  }
  // entity boxes
  for (const e of entities) {
    const p = positions.get(e.name);
    const g = document.createElementNS(ns, "g");
    const r = document.createElementNS(ns, "rect");
    r.setAttribute("class", "entity"); r.setAttribute("x", p.x); r.setAttribute("y", p.y);
    r.setAttribute("width", p.w); r.setAttribute("height", p.h); r.setAttribute("rx", "6");
    g.append(r);
    const t = document.createElementNS(ns, "text");
    t.setAttribute("class", "title"); t.setAttribute("x", p.x + 10); t.setAttribute("y", p.y + 18);
    t.textContent = e.name;
    g.append(t);
    (e.fields || []).slice(0, 5).forEach((f, fi) => {
      const tx = document.createElementNS(ns, "text");
      tx.setAttribute("class", "field"); tx.setAttribute("x", p.x + 10); tx.setAttribute("y", p.y + 36 + fi * 12);
      tx.textContent = f.name + (f.refs ? " (fk)" : "");
      g.append(tx);
    });
    g.addEventListener("click", () => {
      $$(".entity", svg).forEach(rect => rect.classList.remove("active"));
      r.classList.add("active");
      const detail = $(".schema-detail", dom);
      if (detail) {
        detail.innerHTML = `<b style="color: var(--fg);">${e.name}</b> — ${(e.fields || []).map(f => f.name).join(", ")}`;
      }
    });
    svg.append(g);
  }
  svgWrap.append(svg);
}

function renderDeploy(dom, c) {
  const wrap = $(".deploy", dom);
  wrap.innerHTML = "";
  for (const step of c.props.steps || []) {
    wrap.append(el("div", { class: `deploy-step ${step.status || "pend"}` },
      el("div", { class: "ico" }, step.status === "done" ? "✓" : step.status === "fail" ? "✕" : ""),
      el("span", { class: "nm" }, step.name),
      el("span", { class: "tm" }, step.time || ""),
    ));
  }
  if (c.props.url) {
    wrap.append(el("div", { style: "padding: 8px 14px; border-top: 1px dashed var(--line); font-size: 12px;" },
      el("span", { style: "color: var(--fg-dim);" }, "Live at "),
      el("a", { href: c.props.url, target: "_blank", style: "color: var(--accent); font-family: var(--mono);" }, c.props.url),
    ));
  }
}

function renderStatsGrid(dom, c) {
  const wrap = $(".stats-grid", dom);
  wrap.innerHTML = "";
  for (const s of c.props.stats || []) {
    const card = el("div", { class: "stat" },
      el("div", { class: "lbl" }, s.label),
      el("div", { class: "val " + (s.tone || "") }, String(s.value)),
      s.delta ? el("div", { class: "delta " + (s.delta.startsWith("-") ? "down" : "") }, s.delta) : null,
    );
    if (s.spark && s.spark.length > 1) {
      const w = 100, h = 28;
      const max = Math.max(...s.spark, 1), min = Math.min(...s.spark, 0);
      const pts = s.spark.map((v, i) => {
        const x = (i / Math.max(s.spark.length - 1, 1)) * w;
        const y = h - ((v - min) / Math.max(max - min, 1)) * (h - 4) - 2;
        return [x, y];
      });
      const lp = pts.map((p, i) => (i ? "L" : "M") + p[0] + "," + p[1]).join(" ");
      const ap = lp + ` L${w},${h} L0,${h} Z`;
      card.append(el("div", { html: `<svg viewBox="0 0 ${w} ${h}" preserveAspectRatio="none"><path class="area" d="${ap}"/><path class="line" d="${lp}"/><circle class="dot" cx="${pts.at(-1)[0]}" cy="${pts.at(-1)[1]}" r="2.5"/></svg>` }));
    }
    wrap.append(card);
  }
}

// ---- mutations ----
function apply(m) {
  if (m.op === "activity") return updateActivity(m.state);
  if (m.op === "append") {
    const c = m.component;
    const r = renderers[c.type] || fallback;
    const dom = r.mount(c);
    components.set(c.id, { ...c, dom });
    dom.dataset.id = c.id;
    dom.addEventListener("contextmenu", openCtx);
    stream.append(dom);
    autoscroll();
    return;
  }
  const b = components.get(m.id);
  if (!b) return;
  if (m.op === "patch") {
    b.props = { ...b.props, ...m.props };
    const r = renderers[b.type];
    if (r?.update) r.update(b.dom, b);
    else { const fresh = r.mount(b); b.dom.replaceWith(fresh); b.dom = fresh; }
  } else if (m.op === "stream") {
    const r = renderers[b.type];
    if (r?.stream) r.stream(b.dom, m.append);
  } else if (m.op === "finalize") {
    const r = renderers[b.type];
    if (r?.finalize) r.finalize(b.dom, m.meta);
  }
}
const fallback = {
  mount: (c) => el("div", { class: "component" },
    header("?", c.type || "unknown", "(no renderer)"),
    el("pre", { class: "term" }, JSON.stringify(c.props, null, 2)),
  ),
};

// ---- activity indicator ----
const activityEl = $("#activity");
const activityName = $("#activity-name");
const activityMetric = $("#activity-metric");
const activityDrawer = $("#activity-drawer");
let drawerOpen = false;

function updateActivity(state) {
  if (!state) return;
  activityEl.hidden = false;
  activityName.textContent = state.name || "";
  activityMetric.textContent = state.metric || "";
  if (drawerOpen) renderDrawer(state);
  activityEl.classList.toggle("idle", state.status === "idle");
}
function renderDrawer(state) {
  activityDrawer.innerHTML = "";
  for (const it of (state?.recent || [])) {
    activityDrawer.append(el("div", { class: "item " + (it.status || "") },
      el("div", { class: "s" }),
      el("div", null, it.name),
      el("div", { class: "m" }, it.metric || ""),
    ));
  }
}
$("#activity-expand").addEventListener("click", () => {
  drawerOpen = !drawerOpen;
  activityDrawer.hidden = !drawerOpen;
  $("#activity-expand").textContent = drawerOpen ? "▴" : "▾";
});

// ---- decision interaction (bidirectional!) ----
function pickDecision(id, dom, i, opt) {
  markPicked(dom, i);
  postAction({ id, kind: "pick", payload: { option: i + 1, label: opt.label, desc: opt.desc } });
}
function markPicked(dom, i) {
  $$(".opt", dom).forEach((o, idx) => o.classList.toggle("picked", idx === i));
  const meta = $(".meta", dom);
  if (meta) meta.textContent = "resolved";
}
function toggleStep(id, step, done) {
  postAction({ id, kind: "toggle", payload: { step, done } });
}

async function postAction(action) {
  console.log("[action]", action);
  try {
    await fetch("/api/action", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(action),
    });
  } catch (e) {
    console.error("action failed", e);
  }
}

// ---- composer ----
const composer = $("#composer");
const sendBtn = $("#send");
composer.addEventListener("input", () => {
  composer.style.height = "auto";
  composer.style.height = Math.min(composer.scrollHeight, 140) + "px";
});
composer.addEventListener("keydown", e => {
  if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); sendBtn.click(); }
});
sendBtn.addEventListener("click", async () => {
  const text = composer.value.trim();
  if (!text) return;
  composer.value = ""; composer.style.height = "auto";
  await fetch("/api/prompt", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ text }),
  });
});

// ---- right-click context menu ----
const ctxMenu = $("#ctx-menu");
function openCtx(ev) {
  ev.preventDefault();
  ev.stopPropagation();
  const id = ev.currentTarget.dataset.id;
  ctxMenu.innerHTML = "";
  const askBtn = el("button", { onclick: () => {
    composer.value = `@${id} `;
    composer.focus();
    ctxMenu.hidden = true;
  } }, "Ask claude about this");
  ctxMenu.append(askBtn);
  ctxMenu.style.left = Math.min(ev.clientX, innerWidth - 240) + "px";
  ctxMenu.style.top  = Math.min(ev.clientY, innerHeight - 60) + "px";
  ctxMenu.hidden = false;
}
document.addEventListener("click", () => ctxMenu.hidden = true);

// ---- SSE ----
const conn = $("#connection");
const es = new EventSource("/events");
es.addEventListener("open", () => conn.textContent = "live");
es.addEventListener("mutation", (e) => {
  try { apply(JSON.parse(e.data)); }
  catch (err) { console.error("bad mutation", err, e.data); }
});
es.addEventListener("replay-start", () => conn.textContent = "replaying…");
es.addEventListener("replay-end",   () => conn.textContent = "live");
es.addEventListener("error", () => conn.textContent = "disconnected");

// ---- helpers ----
function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c => ({ "&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;" }[c]));
}
function autoscroll() {
  const m = document.getElementById("main");
  if (m.scrollHeight - m.scrollTop - m.clientHeight < 240) {
    requestAnimationFrame(() => m.scrollTo({ top: m.scrollHeight, behavior: "smooth" }));
  }
}
