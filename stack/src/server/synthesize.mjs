// Turn a UserAction into a synthesized user message the main agent
// can react to — the reference-and-narrate / verbatim-insertion split
// from BUILD_PLAN.md.

/**
 * @param {import("../types.mjs").UserAction} action
 * @param {Map<string, import("../types.mjs").Component>} components  current page state
 * @returns {string}
 */
export function synthesizeUserMessage(action, components) {
  const comp = components.get(action.id);
  const ref = `@${action.id}`;

  switch (action.kind) {
    case "pick": {
      const opt = action.payload?.option;
      const label = action.payload?.label || `option ${opt}`;
      const desc = action.payload?.desc ? ` — ${action.payload.desc}` : "";
      return `[interaction with ${ref}]\nPicked ${label}${desc}.`;
    }
    case "apply": {
      const params = action.payload?.params || {};
      return `[interaction with ${ref}]\nApply these settings:\n${formatParams(params)}`;
    }
    case "toggle": {
      const step = action.payload?.step;
      const done = action.payload?.done;
      return `[interaction with ${ref}]\nThe user marked step ${step} as ${done ? "done" : "not done"}.`;
    }
    case "revert": {
      return `[interaction with ${ref}]\nThe user requested reverting this change.`;
    }
    case "edit": {
      const code = action.payload?.new_code || "";
      const file = action.payload?.file || (comp?.props?.filename) || "(file)";
      return `[reference: ${ref} (${file})]\nUse this version instead:\n\`\`\`\n${code}\n\`\`\``;
    }
    case "ask": {
      const text = action.payload?.text || "";
      return `[reference: ${ref}]\n${text}`;
    }
    default:
      return `[interaction with ${ref}]\nAction: ${action.kind}`;
  }
}

function formatParams(obj) {
  return Object.entries(obj).map(([k, v]) => `  - ${k}: ${JSON.stringify(v)}`).join("\n");
}
