import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { editorialAgentRules } from "../src/pipeline/interface-agent.mjs";
import { resetIds } from "../src/store/ids.mjs";

beforeEach(() => resetIds());

test("Edit tool_use commits a diff with old/new hunks", () => {
  const ev = {
    kind: "assistant", tool: "Edit", tool_use_id: "tu_e",
    input: {
      file_path: "src/payments/charge.ts",
      old_string: "return retry();",
      new_string: "if (idem) return cached; return retry();",
    },
    ts: 1,
  };
  const out = editorialAgentRules([ev], {});
  assert.equal(out.length, 1);
  assert.equal(out[0].op, "append");
  assert.equal(out[0].component.type, "diff");
  assert.equal(out[0].component.props.filename, "src/payments/charge.ts");
  const lines = out[0].component.props.hunks[0].lines;
  assert.equal(lines[0][0], "-");
  assert.equal(lines[lines.length - 1][0], "+");
});

test("Write of a source file produces a `module` card with parsed exports (not a diff)", () => {
  const ev = {
    kind: "assistant", tool: "Write", tool_use_id: "tu_w",
    input: { file_path: "src/new.ts", content: "export const x = 1;\nexport const y = 2;" },
    ts: 1,
  };
  const out = editorialAgentRules([ev], {});
  assert.equal(out[0].component.type, "module");
  assert.equal(out[0].component.props.filename, "src/new.ts");
  assert.equal(out[0].component.props.lineCount, 2);
  assert.deepEqual(out[0].component.props.exports, [
    { name: "x", kind: "const" },
    { name: "y", kind: "const" },
  ]);
  // source is preserved for click-to-expand
  assert.match(out[0].component.props.source, /export const x = 1/);
  // and no diff is also emitted
  assert.equal(out.filter(m => m.component?.type === "diff").length, 0);
});

test("Write of a .tsx component file produces a `module` card", () => {
  const ev = {
    kind: "assistant", tool: "Write", tool_use_id: "tu_w",
    input: {
      file_path: "src/components/HabitCard.tsx",
      content: "export function HabitCard() { return null; }\nexport interface HabitCardProps { habitId: string }",
    },
    ts: 1,
  };
  const out = editorialAgentRules([ev], {});
  assert.equal(out[0].component.type, "module");
  const exports = out[0].component.props.exports;
  assert.ok(exports.find(e => e.name === "HabitCard" && e.kind === "function"));
  assert.ok(exports.find(e => e.name === "HabitCardProps" && e.kind === "interface"));
});

test("Write of a YAML file produces a module with section pills", () => {
  const ev = {
    kind: "assistant", tool: "Write", tool_use_id: "tu_w",
    input: {
      file_path: ".github/workflows/ci.yml",
      content: "name: ci\non:\n  push:\n    branches: [main]\njobs:\n  test:\n    runs-on: ubuntu-latest\n  deploy:\n    runs-on: ubuntu-latest",
    },
    ts: 1,
  };
  const out = editorialAgentRules([ev], {});
  assert.equal(out[0].component.type, "module");
  const exports = out[0].component.props.exports;
  // Should pick up at least name, on, jobs as top-level sections
  assert.ok(exports.some(e => e.name === "name"));
  assert.ok(exports.some(e => e.name === "jobs"));
});

test("Write of a .tsx React component → emits BOTH a preview AND a module", () => {
  const ev = {
    kind: "assistant", tool: "Write", tool_use_id: "tu_w",
    input: {
      file_path: "src/components/HabitCard.tsx",
      content:
        "export function HabitCard() {\n" +
        "  return (\n" +
        "    <div className=\"habit-card\">\n" +
        "      <div className=\"name\">{habit?.name}</div>\n" +
        "      <div className={`streak ${b ? 'bumped' : ''}`}>{streak.current} day streak</div>\n" +
        "      <button onClick={() => x()}>I did it today</button>\n" +
        "    </div>\n" +
        "  );\n" +
        "}",
    },
    ts: 1,
  };
  const out = editorialAgentRules([ev], {});
  const types = out.filter(m => m.op === "append").map(m => m.component.type);
  assert.deepEqual(types, ["preview", "module"]);
  const preview = out.find(m => m.component?.type === "preview").component;
  assert.equal(preview.props.name, "HabitCard");
  const kinds = preview.props.elements.map(e => e.type);
  assert.ok(kinds.includes("name"));
  assert.ok(kinds.includes("streak"));
  assert.ok(kinds.includes("button"));
  const btn = preview.props.elements.find(e => e.type === "button");
  assert.equal(btn.text, "I did it today");
});

test("Write of a single-button component → preview with layout: button-only", () => {
  const ev = {
    kind: "assistant", tool: "Write", tool_use_id: "tu_w",
    input: {
      file_path: "src/components/FreezeButton.tsx",
      content: "export function FreezeButton() {\n  return (\n    <button onClick={() => f()}>❄ Freeze today</button>\n  );\n}",
    },
    ts: 1,
  };
  const out = editorialAgentRules([ev], {});
  const preview = out.find(m => m.component?.type === "preview").component;
  assert.equal(preview.props.layout, "button-only");
  assert.equal(preview.props.elements[0].kind, "freeze");
});

test("Write of a non-component .ts file → only a module, no preview", () => {
  const ev = {
    kind: "assistant", tool: "Write", tool_use_id: "tu_w",
    input: {
      file_path: "src/hooks/useTheme.ts",
      content: "export function useTheme() { return { theme: 'dark' }; }",
    },
    ts: 1,
  };
  const out = editorialAgentRules([ev], {});
  assert.equal(out.filter(m => m.component?.type === "preview").length, 0);
  assert.equal(out.filter(m => m.component?.type === "module").length, 1);
});

test("'Shipped to habits.app' text → milestone (not a plain note)", () => {
  const ev = {
    kind: "assistant",
    text: "Shipped to habits.app. All 10 plan items complete. 11 / 11 tests green, 82 kB bundle.",
    ts: 1,
  };
  const out = editorialAgentRules([ev], {});
  const ms = out.find(m => m.component?.type === "milestone");
  assert.ok(ms, "should commit a milestone");
  assert.match(ms.component.props.title, /habits\.app/);
  assert.equal(ms.component.props.url, "https://habits.app");
  const labels = ms.component.props.stats.map(s => s.label);
  assert.ok(labels.includes("Plan"));
  assert.ok(labels.includes("Tests"));
  assert.ok(labels.includes("Bundle"));
  assert.equal(out.filter(m => m.component?.type === "note").length, 0, "shouldn't ALSO be a note");
});

test("Edit (not Write) still produces a diff — we want to see what changed in existing code", () => {
  const ev = {
    kind: "assistant", tool: "Edit", tool_use_id: "tu_e",
    input: { file_path: "src/x.ts", old_string: "const a = 1;", new_string: "const a = 2;" },
    ts: 1,
  };
  const out = editorialAgentRules([ev], {});
  assert.equal(out[0].component.type, "diff");
});

test("Edit with a 'naive' / 'gap > 1' pattern is classified as a bug-fix with a headline", () => {
  const ev = {
    kind: "assistant", tool: "Edit", tool_use_id: "tu_e",
    input: {
      file_path: "src/hooks/useHabit.ts",
      old_string: "// naive: gap > 1 day resets the streak.\n  let current = 0;\n  return { current, longest: 0 };",
      new_string: "if (gap === 0) continue;\nif (gap === 1) current += 1;\nelse if (gap === 2) {} else current = 1;",
    },
    ts: 1,
  };
  const props = editorialAgentRules([ev], {})[0].component.props;
  assert.equal(props.kind, "bug-fix");
  assert.equal(props.icon, "🐛");
  assert.match(props.headline, /streak/i);
  assert.match(props.headline, /1-day gap|reset/i);
  assert.ok(props.before, "should have a before description");
  assert.ok(props.after, "should have an after description");
});

test("Edit that introduces a new `export async function X` is classified as a feature", () => {
  const ev = {
    kind: "assistant", tool: "Edit", tool_use_id: "tu_e",
    input: {
      file_path: "src/hooks/useHabit.ts",
      old_string: "return { current, longest };\n}",
      new_string: "return { current, longest };\n}\n\nexport async function freezeStreak(habitId: string) { /* … */ }",
    },
    ts: 1,
  };
  const props = editorialAgentRules([ev], {})[0].component.props;
  assert.equal(props.kind, "feature");
  assert.equal(props.icon, "✨");
  assert.match(props.headline, /Freeze Streak|Streak/i);
  assert.match(props.after, /freezeStreak/);
});

test("Edit that adds a `useTheme()` call is classified as wiring", () => {
  const ev = {
    kind: "assistant", tool: "Edit", tool_use_id: "tu_e",
    input: {
      file_path: "src/App.tsx",
      old_string: "function App() {\n  return <Home />;",
      new_string: "function App() {\n  useTheme();\n  return <Home />;",
    },
    ts: 1,
  };
  const props = editorialAgentRules([ev], {})[0].component.props;
  assert.equal(props.kind, "wiring");
  assert.match(props.headline, /theme/i);
});

test("Edit that adds subscribeToReminders is classified as wiring (push)", () => {
  const ev = {
    kind: "assistant", tool: "Edit", tool_use_id: "tu_e",
    input: {
      file_path: "src/App.tsx",
      old_string: "useTheme();\n  return <Home />;",
      new_string: "useTheme();\n  useEffect(() => { subscribeToReminders().catch(console.warn); }, []);\n  return <Home />;",
    },
    ts: 1,
  };
  const props = editorialAgentRules([ev], {})[0].component.props;
  assert.equal(props.kind, "wiring");
  assert.match(props.headline, /push notifications/i);
});

test("Generic Edit with no specific signal falls back to refactor", () => {
  const ev = {
    kind: "assistant", tool: "Edit", tool_use_id: "tu_e",
    input: { file_path: "src/x.ts", old_string: "const a = 1;", new_string: "const a = 2;" },
    ts: 1,
  };
  const props = editorialAgentRules([ev], {})[0].component.props;
  assert.equal(props.kind, "refactor");
});

test("text offering numbered options + a question becomes a decision card", () => {
  const ev = {
    kind: "assistant",
    text: `There are 3 reasonable ways to handle skipped days:
1) Auto grace day — every Nth missed day is free, no UI.
2) Manual freeze — user taps 'freeze' before midnight. Limited per month.
3) Both — 1 auto + 2 manual / month.

Which do you prefer?`,
    ts: 1,
  };
  const out = editorialAgentRules([ev], {});
  const decisions = out.filter(m => m.component?.type === "decision");
  assert.equal(decisions.length, 1, "should commit one decision");
  const props = decisions[0].component.props;
  assert.equal(props.options.length, 3);
  assert.match(props.options[0].label, /Auto grace day/);
  assert.match(props.options[1].label, /Manual freeze/);
  // and the prose is NOT also kept as a note alongside (replaces, not enriches)
  assert.equal(out.filter(m => m.component?.type === "note").length, 0);
});

test("plain prose without options does NOT become a decision", () => {
  const ev = {
    kind: "assistant",
    text: "I'm going to look at the charge handler and the retry logic.",
    ts: 1,
  };
  const out = editorialAgentRules([ev], {});
  assert.equal(out.filter(m => m.component?.type === "decision").length, 0);
});

test("long-running Bash that isn't a test/build/deploy auto-commits a streaming terminal", () => {
  const state = {};
  const ev = {
    kind: "assistant", tool: "Bash", tool_use_id: "tu_b",
    input: { command: "docker compose up" },
    ts: 1,
  };
  const out = editorialAgentRules([ev], state);
  const t = out.find(m => m.component?.type === "terminal");
  assert.ok(t, "should commit a terminal for docker compose up");
  assert.equal(t.component.props.command, "docker compose up");
  assert.equal(t.component.props.status, "running");
});

test("non-long-running Bash (ls, cat) does NOT auto-commit a terminal", () => {
  const ev = {
    kind: "assistant", tool: "Bash", tool_use_id: "tu_b",
    input: { command: "ls -la" }, ts: 1,
  };
  const out = editorialAgentRules([ev], {});
  assert.equal(out.filter(m => m.component?.type === "terminal").length, 0);
});

test("tool_result of a committed terminal streams + finalizes", () => {
  const state = {};
  editorialAgentRules([{
    kind: "assistant", tool: "Bash", tool_use_id: "tu_b",
    input: { command: "docker compose up" }, ts: 1,
  }], state);
  const out = editorialAgentRules([{
    kind: "tool_result", tool_use_id: "tu_b", content: "Started 3 services\n", ts: 2,
  }], state);
  const ops = out.map(m => m.op);
  assert.deepEqual(ops, ["stream", "finalize"]);
});

test("npm test → `tests` panel (not terminal), result parses pass/fail counts", () => {
  const state = {};
  const out1 = editorialAgentRules([{
    kind: "assistant", tool: "Bash", tool_use_id: "tu_t",
    input: { command: "npm test --silent" }, ts: 1,
  }], state);
  const t = out1.find(m => m.component?.type === "tests");
  assert.ok(t, "should commit a tests panel");
  assert.equal(t.component.props.status, "running");
  assert.equal(out1.filter(m => m.component?.type === "terminal").length, 0, "should NOT also commit a terminal");

  const out2 = editorialAgentRules([{
    kind: "tool_result", tool_use_id: "tu_t",
    content: "Test Files  2 passed (2)\nTests       7 passed (7)\nDuration    412ms",
    ts: 2,
  }], state);
  const patch = out2.find(m => m.op === "patch");
  assert.ok(patch, "tool_result should emit a patch on the tests component");
  assert.equal(patch.props.passed, 7);
  assert.equal(patch.props.failed, 0);
  assert.equal(patch.props.duration, "412ms");
});

test("vercel deploy → `deploy` step list (not terminal), result captures live URL", () => {
  const state = {};
  const out1 = editorialAgentRules([{
    kind: "assistant", tool: "Bash", tool_use_id: "tu_d",
    input: { command: "npx vercel deploy --prod" }, ts: 1,
  }], state);
  const d = out1.find(m => m.component?.type === "deploy");
  assert.ok(d, "should commit a deploy component");
  assert.ok(d.component.props.steps.length >= 2, "should have at least 2 steps");

  const out2 = editorialAgentRules([{
    kind: "tool_result", tool_use_id: "tu_d",
    content: "Vercel CLI 33.0.0\n  Production: https://habits.app [2s]",
    ts: 2,
  }], state);
  const patch = out2.find(m => m.op === "patch");
  assert.ok(patch);
  assert.equal(patch.props.status, "done");
  assert.match(patch.props.url, /https:\/\/habits\.app/);
});

test("npm run build → `stats` cards (not terminal), result parses bundle/modules/time", () => {
  const state = {};
  editorialAgentRules([{
    kind: "assistant", tool: "Bash", tool_use_id: "tu_b",
    input: { command: "npm run build" }, ts: 1,
  }], state);
  const out = editorialAgentRules([{
    kind: "tool_result", tool_use_id: "tu_b",
    content: "vite build\n  ✓ 142 modules transformed.\n  dist/assets/index.js  82.14 kB\n  ✓ built in 1.31s",
    ts: 2,
  }], state);
  const patch = out.find(m => m.op === "patch");
  assert.ok(patch);
  const labels = patch.props.stats.map(s => s.label);
  assert.ok(labels.includes("Bundle"));
  assert.ok(labels.includes("Modules"));
  assert.ok(labels.includes("Build time"));
});

test("Write of a *schema.ts file with multiple `interface` blocks → `schema` diagram (not diff)", () => {
  const ev = {
    kind: "assistant", tool: "Write", tool_use_id: "tu_w",
    input: {
      file_path: "src/db/schema.ts",
      content: "export interface Habit { id: string; name: string; createdAt: number }\n" +
               "export interface CheckIn { id: string; habitId: string; date: string }",
    },
    ts: 1,
  };
  const out = editorialAgentRules([ev], {});
  const s = out.find(m => m.component?.type === "schema");
  assert.ok(s, "should commit a schema component");
  assert.equal(s.component.props.entities.length, 2);
  assert.equal(s.component.props.entities[0].name, "Habit");
  assert.equal(out.filter(m => m.component?.type === "diff").length, 0, "should NOT also commit a diff");
});

test("Schema rule wins over module rule for schema files", () => {
  const ev = {
    kind: "assistant", tool: "Write", tool_use_id: "tu_w",
    input: {
      file_path: "src/db/schema.ts",
      content: "export interface A { id: string }\nexport interface B { id: string }",
    },
    ts: 1,
  };
  const out = editorialAgentRules([ev], {});
  // schema rule takes precedence
  assert.ok(out.find(m => m.component?.type === "schema"));
  assert.equal(out.filter(m => m.component?.type === "module").length, 0);
  assert.equal(out.filter(m => m.component?.type === "diff").length, 0);
});

test("a short summary-feeling note IS kept", () => {
  const ev = { kind: "assistant", text: "Done — all four tests are green.", ts: 1 };
  const out = editorialAgentRules([ev], {});
  assert.equal(out.find(m => m.component?.type === "note")?.component.props.text,
               "Done — all four tests are green.");
});

test("a long chatty paragraph is NOT kept as a note", () => {
  const ev = { kind: "assistant", text: "x".repeat(900), ts: 1 };
  const out = editorialAgentRules([ev], {});
  assert.equal(out.filter(m => m.component?.type === "note").length, 0);
});
