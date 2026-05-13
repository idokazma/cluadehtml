// Artifact builder: produces a self-contained HTML page with embedded events.

import { test } from "node:test";
import assert from "node:assert/strict";
import { buildArtifact } from "../src/store/artifact.mjs";

const SAMPLE_EVENTS = [
  { op: "append", component: { id: "user-1", type: "prompt", props: { text: "build it" } }, ts: 1 },
  { op: "append", component: { id: "note-2", type: "note", props: { text: "on it" } }, ts: 2 },
  { op: "append", component: { id: "ms-3", type: "milestone", props: { icon: "🚀", title: "Shipped", subtitle: "to prod" } }, ts: 3 },
];

test("produces a self-contained HTML document", () => {
  const html = buildArtifact({ sessionId: "abc-1234", events: SAMPLE_EVENTS });
  assert.ok(html.startsWith("<!doctype html>"));
  // CSS inlined (no <link rel="stylesheet">).
  assert.ok(!/<link[^>]+stylesheet/i.test(html), "must not link external stylesheet");
  assert.ok(/<style>/.test(html), "should inline a <style> block");
  // JS inlined (no external src to /static/).
  assert.ok(!/src=["']\/static\/session\.js/.test(html), "must not src external session.js");
  // Embedded events present.
  assert.ok(html.includes("__STATIC_EVENTS__"), "events injected into a global");
  assert.ok(html.includes("Shipped"), "milestone text appears in payload");
});

test("escapes XSS in title and dangerous chars in events", () => {
  const evil = [{ op: "append", component: { id: "x", type: "note", props: { text: "</script><script>alert(1)</script>" } }, ts: 1 }];
  const html = buildArtifact({ sessionId: "s", events: evil, title: "<script>boom</script>" });
  // Title is HTML-escaped in the <title> element.
  assert.ok(!/<title>[^<]*<script>boom/.test(html), "title is escaped");
  // Embedded events JSON has `<` replaced so it can't close the script tag.
  const between = html.match(/__STATIC_EVENTS__ = (.*?);<\/script>/s);
  assert.ok(between, "events embed found");
  assert.ok(!between[1].includes("</script>"), "no raw </script> in embedded JSON");
});

test("includes 'archived' pill so the page identifies itself", () => {
  const html = buildArtifact({ sessionId: "z", events: SAMPLE_EVENTS });
  assert.ok(/id="connection">archived</.test(html));
});
