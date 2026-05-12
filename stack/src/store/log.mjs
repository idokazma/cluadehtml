// Append-only event log per session. The single source of truth for
// the rendered page — the page's state is exactly the fold over this
// log.
//
// Activity-indicator updates (op: "activity") are *transient* and not
// persisted — only committed mutations go in the log.

import fs from "node:fs";
import path from "node:path";

export class SessionLog {
  constructor(sessionDir, sessionId) {
    this.dir = sessionDir;
    this.id = sessionId;
    this.path = path.join(sessionDir, `${sessionId}.events.jsonl`);
    fs.mkdirSync(sessionDir, { recursive: true });
    // Wipe on new session (we're not implementing resume yet).
    fs.writeFileSync(this.path, "");
    this._buffer = [];
  }

  /** @param {import("../types.mjs").Mutation} m */
  write(m) {
    if (m.op === "activity") return; // transient
    this._buffer.push(m);
    fs.appendFileSync(this.path, JSON.stringify(m) + "\n");
  }

  /** Read all persisted mutations (for replay on connect). */
  readAll() {
    if (!fs.existsSync(this.path)) return [];
    return fs.readFileSync(this.path, "utf8")
      .split("\n").filter(Boolean)
      .map(l => { try { return JSON.parse(l); } catch { return null; } })
      .filter(Boolean);
  }
}
