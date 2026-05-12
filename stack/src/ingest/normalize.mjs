// Normalize raw stream-json envelopes into our flat AgentEvent shape.
//
// We accept either the wire shape from `claude -p --output-format
// stream-json` *or* the session JSONL shape at ~/.claude/projects/...
// — both surface the same Anthropic-message content blocks under
// slightly different wrappers.

/**
 * @param {object} raw
 * @returns {Array<import("../types.mjs").AgentEvent>}  // can fan out content blocks
 */
export function normalize(raw) {
  if (!raw || typeof raw !== "object") return [];
  const ts = Date.now();

  // System init / result events — pass through with a tag.
  if (raw.type === "system") return [{ kind: "system", raw, ts, session_id: raw.session_id }];
  if (raw.type === "result") return [{ kind: "result", raw, ts }];

  // User messages (typed prompts + tool_result bundles).
  if (raw.type === "user") {
    const content = raw.message?.content || [];
    const out = [];
    for (const block of content) {
      if (typeof block === "string") {
        out.push({ kind: "user", text: block, ts, raw });
      } else if (block?.type === "text") {
        out.push({ kind: "user", text: block.text, ts, raw });
      } else if (block?.type === "tool_result") {
        out.push({
          kind: "tool_result",
          tool_use_id: block.tool_use_id,
          content: extractToolResult(block.content),
          ts,
          raw,
        });
      }
    }
    return out;
  }

  // Assistant messages — fan content blocks out as separate events.
  if (raw.type === "assistant") {
    const content = raw.message?.content || [];
    const out = [];
    for (const block of content) {
      if (block?.type === "text") {
        out.push({ kind: "assistant", text: block.text, ts, raw });
      } else if (block?.type === "tool_use") {
        out.push({
          kind: "assistant",
          tool_use_id: block.id,
          tool: block.name,
          input: block.input || {},
          ts,
          raw,
        });
      }
    }
    return out;
  }

  // stream-json wire envelope: { type: "stream_event", event: { ... } }
  if (raw.type === "stream_event" && raw.event) {
    return normalize({ type: raw.event.type, ...raw.event });
  }

  return [{ kind: "unknown", raw, ts }];
}

function extractToolResult(content) {
  if (content == null) return "";
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content.map(c => (typeof c === "string" ? c : c?.text || JSON.stringify(c))).join("\n");
  }
  return JSON.stringify(content);
}
