#!/usr/bin/env node
// Tails a Claude Code session JSONL file, debounces, and asks `claude -p` to
// re-render a single HTML page that visualizes session progress. The watcher
// is intentionally dumb: it filters noise out of the transcript, then hands
// the curated events + the current page to a fresh Claude and lets that Claude
// decide how to visualize. No fixed schema, no component library.

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const args = parseArgs(process.argv.slice(2));
const htmlPath = path.resolve(args.html || path.join(__dirname, 'page', 'progress.html'));
const promptPath = path.resolve(args.prompt || path.join(__dirname, 'prompts', 'render.md'));
const debounceMs = Math.round((parseFloat(args.debounce) || 15) * 1000);
const maxEvents = parseInt(args['max-events'], 10) || 60;
const pollMs = parseInt(args['poll-ms'], 10) || 500;
const sessionPath = path.resolve(args.session || autoDiscoverSession());

let offset = 0;
let buffer = [];
let debounceTimer = null;
let rendering = false;
let renderQueued = false;

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) continue;
    const key = a.slice(2);
    const next = argv[i + 1];
    if (next && !next.startsWith('--')) { out[key] = next; i++; }
    else out[key] = 'true';
  }
  return out;
}

function autoDiscoverSession() {
  const encoded = process.cwd().replace(/\//g, '-');
  const dir = path.join(os.homedir(), '.claude', 'projects', encoded);
  if (!fs.existsSync(dir)) {
    throw new Error(`No session dir at ${dir}. Pass --session <path/to/session.jsonl>.`);
  }
  const files = fs.readdirSync(dir)
    .filter(f => f.endsWith('.jsonl'))
    .map(f => ({ f, m: fs.statSync(path.join(dir, f)).mtimeMs }))
    .sort((a, b) => b.m - a.m);
  if (!files.length) throw new Error(`No .jsonl sessions in ${dir}.`);
  return path.join(dir, files[0].f);
}

function classify(line) {
  let entry;
  try { entry = JSON.parse(line); } catch { return null; }
  const msg = entry.message || entry;
  const role = msg.role || entry.type;
  const content = msg.content;
  const out = [];

  if (role === 'user') {
    if (typeof content === 'string') {
      out.push({ kind: 'user_text', text: clip(content, 1200) });
    } else if (Array.isArray(content)) {
      for (const b of content) {
        if (b.type === 'text') out.push({ kind: 'user_text', text: clip(b.text, 1200) });
        else if (b.type === 'tool_result') {
          const text = stringifyResult(b.content);
          out.push({ kind: 'tool_result', text: clip(text, 400), is_error: !!b.is_error });
        }
      }
    }
  } else if (role === 'assistant') {
    if (typeof content === 'string') {
      out.push({ kind: 'assistant_text', text: content });
    } else if (Array.isArray(content)) {
      for (const b of content) {
        if (b.type === 'text') out.push({ kind: 'assistant_text', text: b.text });
        else if (b.type === 'tool_use') {
          out.push({ kind: 'tool_use', name: b.name, input: summarizeInput(b.input) });
        }
      }
    }
  }
  return out.length ? out : null;
}

function stringifyResult(c) {
  if (typeof c === 'string') return c;
  if (Array.isArray(c)) return c.map(x => x?.text ?? '').join('');
  return JSON.stringify(c ?? '');
}

function summarizeInput(input) {
  if (!input || typeof input !== 'object') return input;
  const out = {};
  for (const [k, v] of Object.entries(input)) {
    if (typeof v === 'string' && v.length > 300) out[k] = clip(v, 300);
    else out[k] = v;
  }
  return out;
}

function clip(s, n) {
  if (typeof s !== 'string') return '';
  return s.length > n ? s.slice(0, n) + `… (${s.length - n} more chars)` : s;
}

function poll() {
  let stat;
  try { stat = fs.statSync(sessionPath); } catch { return; }
  if (stat.size <= offset) return;
  const fd = fs.openSync(sessionPath, 'r');
  try {
    const buf = Buffer.alloc(stat.size - offset);
    fs.readSync(fd, buf, 0, buf.length, offset);
    offset = stat.size;
    const lines = buf.toString('utf8').split('\n').filter(l => l.trim());
    let added = 0;
    for (const line of lines) {
      const events = classify(line);
      if (!events) continue;
      for (const e of events) { buffer.push(e); added++; }
    }
    if (added > 0) {
      console.log(`[watch] +${added} events (buffer ${buffer.length})`);
      scheduleRender();
    }
  } finally {
    fs.closeSync(fd);
  }
}

function scheduleRender() {
  if (debounceTimer) clearTimeout(debounceTimer);
  debounceTimer = setTimeout(triggerRender, debounceMs);
}

async function triggerRender() {
  if (rendering) { renderQueued = true; return; }
  if (buffer.length === 0) return;
  rendering = true;
  const events = buffer.slice(-maxEvents);
  const dropped = buffer.length - events.length;
  buffer = [];
  const currentHtml = fs.existsSync(htmlPath)
    ? fs.readFileSync(htmlPath, 'utf8')
    : '<!doctype html><html><body></body></html>';
  const template = fs.readFileSync(promptPath, 'utf8');
  const prompt = template
    .replace('{{EVENTS}}', formatEvents(events, dropped))
    .replace('{{CURRENT_HTML}}', currentHtml);
  console.log(`[watch] rendering ${events.length} events${dropped ? ` (+${dropped} dropped)` : ''}…`);
  const t0 = Date.now();
  try {
    const out = await callClaude(prompt);
    const html = extractHtml(out);
    if (!html) {
      console.warn('[watch] no html in response, skipping write');
    } else {
      fs.writeFileSync(htmlPath, html);
      console.log(`[watch] wrote ${html.length} bytes -> ${htmlPath} (${Date.now() - t0}ms)`);
    }
  } catch (e) {
    console.error('[watch] render failed:', e.message);
  }
  rendering = false;
  if (renderQueued) { renderQueued = false; scheduleRender(); }
}

function formatEvents(events, dropped) {
  const head = dropped > 0 ? `(${dropped} earlier events omitted — only the most recent ${events.length} shown)\n\n` : '';
  return head + events.map(e => {
    if (e.kind === 'assistant_text') return `[assistant text]\n${e.text}`;
    if (e.kind === 'user_text') return `[user text]\n${e.text}`;
    if (e.kind === 'tool_use') return `[tool ${e.name}] ${JSON.stringify(e.input)}`;
    if (e.kind === 'tool_result') return `[tool result${e.is_error ? ' ERROR' : ''}] ${e.text}`;
    return JSON.stringify(e);
  }).join('\n\n');
}

function callClaude(prompt) {
  return new Promise((resolve, reject) => {
    const child = spawn('claude', ['-p', '--output-format', 'text'], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env },
    });
    let stdout = '', stderr = '';
    child.stdout.on('data', d => { stdout += d; });
    child.stderr.on('data', d => { stderr += d; });
    child.on('error', reject);
    child.on('close', code => {
      if (code !== 0) reject(new Error(`claude exited ${code}: ${stderr.trim()}`));
      else resolve(stdout);
    });
    child.stdin.write(prompt);
    child.stdin.end();
  });
}

function extractHtml(text) {
  const fence = text.match(/```(?:html)?\s*\n([\s\S]*?)\n```/i);
  const candidate = (fence ? fence[1] : text).trim();
  if (!candidate) return null;
  if (!candidate.startsWith('<')) return null;
  return candidate;
}

console.log(`[watch] tailing  ${sessionPath}`);
console.log(`[watch] writing  ${htmlPath}`);
console.log(`[watch] debounce ${debounceMs}ms · max-events ${maxEvents} · poll ${pollMs}ms`);

if (fs.existsSync(sessionPath)) offset = 0; // read from start so first render has full context
setInterval(poll, pollMs);
poll();
