#!/bin/sh
# Notify a running stack server that the Claude Code session has ended so it
# can emit a final milestone, freeze the page, and save a static artifact to
# .stack/artifacts/<session-id>.html.
#
# Usage: configure as a Stop hook in ~/.claude/settings.json (see
# stack-session-end.example.json next to this script).
#
# Honors STACK_URL (default http://localhost:3737). Silent on failure so a
# missing stack server never blocks Claude Code from ending the session.

URL="${STACK_URL:-http://localhost:3737}/api/session-end"
SUMMARY="${1:-}"
TITLE="${2:-}"

curl -s --max-time 5 -X POST \
  -H 'content-type: application/json' \
  -d "{\"summary\": \"${SUMMARY}\", \"title\": \"${TITLE}\"}" \
  "$URL" >/dev/null 2>&1 || true
