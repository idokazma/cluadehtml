// Build a self-contained static HTML artifact for a session. The artifact
// inlines page/session.css and page/session.js, embeds the session's
// committed mutations as `window.__STATIC_EVENTS__`, and omits everything
// interactive (SSE, input bar, action menu). It's the session frozen as a
// portable file the user can share, commit, or revisit forever.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PAGE_DIR = path.resolve(__dirname, "../../page");

/**
 * @param {object} opts
 * @param {string} opts.sessionId
 * @param {Array<import("../types.mjs").Mutation>} opts.events
 * @param {string} [opts.title]
 * @returns {string}  full HTML document
 */
export function buildArtifact({ sessionId, events, title }) {
  const css = readPage("session.css");
  const js  = readPage("session.js");
  const safeTitle = escapeHtml(title || `stack — session ${sessionId.slice(0, 8)}`);
  const eventsJson = JSON.stringify(events).replace(/</g, "\\u003c");
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>${safeTitle}</title>
<style>${css}</style>
</head>
<body>

<header>
  <div class="logo">C</div>
  <div>
    <div class="title">stack <span class="sub">— archived</span></div>
  </div>
  <div class="spacer"></div>
  <span class="pill" id="connection">archived</span>
</header>

<main id="main">
  <div class="stream" id="stream"></div>
</main>

<div class="activity" id="activity" hidden>
  <div class="dot"></div>
  <div class="name" id="activity-name">Idle</div>
  <div class="metric" id="activity-metric"></div>
  <button class="expand" id="activity-expand">▾</button>
</div>
<div class="activity-drawer" id="activity-drawer" hidden></div>
<div class="input-bar"><div class="input-wrap"><textarea id="composer" disabled></textarea><button class="send-btn" id="send" disabled>Send</button></div></div>
<div class="ctx-menu" id="ctx-menu" hidden></div>

<script>window.__STATIC_EVENTS__ = ${eventsJson};</script>
<script type="module">${js}</script>

</body>
</html>
`;
}

function readPage(name) {
  return fs.readFileSync(path.join(PAGE_DIR, name), "utf8");
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c => ({ "&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;" }[c]));
}
