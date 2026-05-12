// Type definitions (JSDoc only — zero-runtime).
//
// Two distinct shapes flow through the system:
//   1. AgentEvent — what `claude -p --output-format stream-json` emits.
//   2. Mutation   — what the page applies. Append-only log of these
//                   *is* the session.

/**
 * @typedef {Object} AgentEvent
 * @property {"user" | "assistant" | "tool_result" | "result" | "system" | "stream_event" | "unknown"} kind
 * @property {string} [text]               // for assistant text blocks, user prompts
 * @property {string} [tool_use_id]        // for tool_use + tool_result correlation
 * @property {string} [tool]               // tool name (Read, Bash, Edit, …)
 * @property {object} [input]              // tool input
 * @property {string|object} [content]     // tool_result content
 * @property {object} [raw]                // the original JSON for debugging
 * @property {string} [session_id]
 * @property {number} ts                   // ms epoch
 */

/**
 * @typedef {{ id: string, type: string, props: object }} Component
 *
 * @typedef {
 *   | { op: "append",   id?: string, parent?: string, component: Component, ts: number }
 *   | { op: "patch",    id: string, props: object, ts: number }
 *   | { op: "stream",   id: string, append: string, ts: number }
 *   | { op: "finalize", id: string, meta?: object, ts: number }
 *   | { op: "activity", state: ActivityState, ts: number }            // transient — not persisted
 *   | { op: "promote",  fromActivity: number, component: Component, ts: number }
 * } Mutation
 *
 * @typedef {Object} ActivityState
 * @property {string} name            // "Reading src/charge.ts"
 * @property {string} [metric]        // "8 of 14 files"
 * @property {"running" | "done" | "idle"} status
 * @property {Array<{name: string, status: "done"|"running"|"queued", metric?: string}>} [recent]
 */

/**
 * @typedef {Object} UserAction
 * @property {string} id                 // component id the user acted on
 * @property {string} kind               // pick | apply | toggle | revert | edit | ask
 * @property {object} payload            // action-specific data
 * @property {number} ts
 */

export {};
