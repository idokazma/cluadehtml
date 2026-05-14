// LLM-backed editorial agent: shape of the API call + parsing of the response.
// We mock fetch end-to-end — no network, no API key needed.

import { test } from "node:test";
import assert from "node:assert/strict";
import { editorialAgentLLM } from "../src/pipeline/interface-agent.mjs";

function makeFetch(mockResponse, { status = 200 } = {}) {
  const calls = [];
  const fn = async (url, opts) => {
    calls.push({ url, opts });
    return {
      ok: status >= 200 && status < 300,
      status,
      async json() { return mockResponse; },
      async text() { return JSON.stringify(mockResponse); },
    };
  };
  fn.calls = calls;
  return fn;
}

function modelSays(json) {
  return { content: [{ type: "text", text: JSON.stringify(json) }] };
}

test("calls Anthropic with the prompt cached and parses the response", async () => {
  const fetcher = makeFetch(modelSays({
    activity: { name: "Editing useHabit.ts", metric: "+5 -1", status: "done" },
    commits: [
      { op: "append", component: { type: "diff", props: { filename: "useHabit.ts", headline: "Streak no longer resets on a 1-day gap", kind: "bug-fix" } } },
    ],
  }));

  const state = {};
  const muts = await editorialAgentLLM(
    [{ kind: "assistant", tool: "Edit", input: { file_path: "useHabit.ts", old_string: "gap > 1", new_string: "gap === 1" }, ts: 100 }],
    state,
    { fetch: fetcher, apiKey: "sk-test" },
  );

  assert.equal(fetcher.calls.length, 1);
  const body = JSON.parse(fetcher.calls[0].opts.body);
  assert.equal(body.model, "claude-haiku-4-5-20251001");
  assert.equal(body.system[0].cache_control.type, "ephemeral", "system prompt must be cache-controlled");
  assert.ok(body.system[0].text.includes("Interface Agent"), "system prompt should be the interface-agent.md content");

  assert.equal(muts.length, 2);
  assert.equal(muts[0].op, "activity");
  assert.equal(muts[0].name, "Editing useHabit.ts");
  assert.equal(muts[1].op, "append");
  assert.equal(muts[1].component.type, "diff");
  assert.ok(muts[1].component.id, "append components get an id assigned");
  assert.ok(muts[1].component.id.startsWith("diff"));
});

test("strips markdown fences if the model wraps JSON in them", async () => {
  const fenced = { content: [{ type: "text", text: "```json\n" + JSON.stringify({ activity: null, commits: [] }) + "\n```" }] };
  const fetcher = makeFetch(fenced);
  const muts = await editorialAgentLLM([{ kind: "assistant", text: "ok", ts: 1 }], {}, { fetch: fetcher, apiKey: "k" });
  assert.deepEqual(muts, []);
});

test("falls back to rules on API error", async () => {
  const fetcher = makeFetch({ type: "error", error: { message: "rate limited" } }, { status: 429 });
  const muts = await editorialAgentLLM(
    [{ kind: "assistant", tool: "Edit", input: { file_path: "src/x.ts", old_string: "naive", new_string: "real" }, ts: 1 }],
    {},
    { fetch: fetcher, apiKey: "k" },
  );
  // Rules should have classified the "naive" replacement as bug-fix.
  assert.ok(muts.length >= 1, "rules fallback should emit something");
  const diff = muts.find(m => m.op === "append" && m.component?.type === "diff");
  assert.ok(diff, "rules fallback should produce a diff for the Edit");
  assert.equal(diff.component.props.kind, "bug-fix");
});

test("falls back to rules when no API key", async () => {
  const fetcher = makeFetch(modelSays({ activity: null, commits: [] }));
  delete process.env.ANTHROPIC_API_KEY;
  const muts = await editorialAgentLLM(
    [{ kind: "assistant", tool: "Edit", input: { file_path: "x.ts", old_string: "naive", new_string: "real" }, ts: 1 }],
    {},
    { fetch: fetcher /* no apiKey */ },
  );
  assert.equal(fetcher.calls.length, 0, "fetcher must not be called without a key");
  assert.ok(muts.length >= 1, "rules still produce output");
});

test("patch commits flow through with their id", async () => {
  const fetcher = makeFetch(modelSays({
    activity: null,
    commits: [{ op: "patch", id: "tst-1", props: { status: "done", passed: 11, failed: 0 } }],
  }));
  const muts = await editorialAgentLLM([{ kind: "tool_result", tool_use_id: "tu_1", content: "Tests 11 passed", ts: 1 }], {}, { fetch: fetcher, apiKey: "k" });
  assert.equal(muts.length, 1);
  assert.equal(muts[0].op, "patch");
  assert.equal(muts[0].id, "tst-1");
  assert.equal(muts[0].props.passed, 11);
});

test("falls back to rules on bad JSON in the model output", async () => {
  const garbage = { content: [{ type: "text", text: "not json at all, sorry" }] };
  const fetcher = makeFetch(garbage);
  const muts = await editorialAgentLLM(
    [{ kind: "assistant", tool: "Edit", input: { file_path: "x.ts", old_string: "naive", new_string: "real" }, ts: 1 }],
    {},
    { fetch: fetcher, apiKey: "k" },
  );
  assert.ok(muts.length >= 1, "rules fallback");
});
