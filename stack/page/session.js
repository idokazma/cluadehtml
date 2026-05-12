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
};

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
