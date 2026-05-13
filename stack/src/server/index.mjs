// Local HTTP + SSE server for one stack session.
//
// Routes:
//   GET  /                  the page shell (current session)
//   GET  /project           project rollup across all sessions for this cwd
//   GET  /api/sessions      JSON: list of session summaries
//   GET  /static/*          page assets
//   GET  /events            SSE stream of mutations
//   POST /api/action        bidirectional input: component action
//   POST /api/prompt        free-form follow-up prompt
//   GET  /api/state         current state (components Map, for debugging)

import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { listSessions } from "../store/sessions.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PAGE_DIR = path.resolve(__dirname, "../../page");

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js":   "text/javascript; charset=utf-8",
  ".mjs":  "text/javascript; charset=utf-8",
  ".css":  "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg":  "image/svg+xml",
};

/**
 * @param {object} opts
 * @param {() => import("../types.mjs").Mutation[]} opts.replay  committed mutations so far
 * @param {(action: import("../types.mjs").UserAction) => void} opts.onAction
 * @param {(text: string) => void} opts.onPrompt
 * @param {() => Map<string, import("../types.mjs").Component>} opts.getState
 */
export function startServer({ replay, onAction, onPrompt, getState, sessionsDir, port = 3737 }) {
  const subscribers = new Set();

  const server = http.createServer((req, res) => {
    const url = new URL(req.url, `http://${req.headers.host}`);

    if (req.method === "GET" && url.pathname === "/") {
      return serveFile(res, path.join(PAGE_DIR, "session.html"));
    }
    if (req.method === "GET" && url.pathname === "/project") {
      return serveFile(res, path.join(PAGE_DIR, "project.html"));
    }
    if (req.method === "GET" && url.pathname === "/api/sessions") {
      const sessions = sessionsDir ? listSessions(sessionsDir) : [];
      res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
      return res.end(JSON.stringify({ sessions }));
    }
    if (req.method === "GET" && url.pathname.startsWith("/static/")) {
      const file = path.join(PAGE_DIR, url.pathname.slice("/static/".length));
      if (!file.startsWith(PAGE_DIR)) return notFound(res);
      return serveFile(res, file);
    }
    if (req.method === "GET" && url.pathname === "/events") {
      return handleSSE(req, res, subscribers, replay);
    }
    if (req.method === "POST" && url.pathname === "/api/action") {
      return readJSON(req).then(body => {
        try { onAction(body); res.writeHead(200, { "content-type": "application/json" }); res.end('{"ok":true}'); }
        catch (e) { fail(res, e); }
      }).catch(e => fail(res, e));
    }
    if (req.method === "POST" && url.pathname === "/api/prompt") {
      return readJSON(req).then(body => {
        try { onPrompt(body.text || ""); res.writeHead(200, { "content-type": "application/json" }); res.end('{"ok":true}'); }
        catch (e) { fail(res, e); }
      }).catch(e => fail(res, e));
    }
    if (req.method === "GET" && url.pathname === "/api/state") {
      const state = getState();
      const obj = Object.fromEntries(state);
      res.writeHead(200, { "content-type": "application/json" });
      return res.end(JSON.stringify(obj, null, 2));
    }
    return notFound(res);
  });

  server.listen(port, () => {
    console.log(`stack server: http://localhost:${port}`);
  });

  return {
    broadcast(mutation) {
      const data = `event: mutation\ndata: ${JSON.stringify(mutation)}\n\n`;
      for (const res of subscribers) {
        try { res.write(data); } catch { subscribers.delete(res); }
      }
    },
    close() { server.close(); for (const r of subscribers) r.end(); },
  };
}

function handleSSE(req, res, subscribers, replay) {
  res.writeHead(200, {
    "content-type": "text/event-stream",
    "cache-control": "no-cache, no-transform",
    "connection": "keep-alive",
    "access-control-allow-origin": "*",
  });
  res.write(":\n\n"); // initial comment to flush headers
  // Replay the committed log so a fresh tab catches up.
  const log = replay();
  res.write(`event: replay-start\ndata: {"count":${log.length}}\n\n`);
  for (const m of log) res.write(`event: mutation\ndata: ${JSON.stringify(m)}\n\n`);
  res.write(`event: replay-end\ndata: {}\n\n`);
  subscribers.add(res);
  req.on("close", () => subscribers.delete(res));
}

function serveFile(res, file) {
  fs.readFile(file, (err, buf) => {
    if (err) return notFound(res);
    const ext = path.extname(file);
    res.writeHead(200, { "content-type": MIME[ext] || "application/octet-stream" });
    res.end(buf);
  });
}
function notFound(res) { res.writeHead(404); res.end("not found"); }
function fail(res, e) { console.error(e); res.writeHead(500); res.end(String(e?.message || e)); }
function readJSON(req) {
  return new Promise((resolve, reject) => {
    let buf = "";
    req.on("data", c => buf += c);
    req.on("end", () => { try { resolve(buf ? JSON.parse(buf) : {}); } catch (e) { reject(e); } });
    req.on("error", reject);
  });
}
