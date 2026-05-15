#!/bin/bash
# Syncs the Claude OAuth token from macOS keychain to .env and restarts EJClaw if changed.

ENV_FILE="/Users/icheongho/AiGroup/EJClaw/.env"
LOG_PREFIX="[sync-claude-token]"

new_token=$(security find-generic-password -s "Claude Code-credentials" -w 2>/dev/null | python3 -c "
import sys, json
data = json.loads(sys.stdin.read())
print(data.get('claudeAiOauth', {}).get('accessToken', ''))
" 2>/dev/null)

if [ -z "$new_token" ]; then
  echo "$LOG_PREFIX Could not read token from keychain"
  exit 1
fi

current_token=$(grep "^CLAUDE_CODE_OAUTH_TOKENS=" "$ENV_FILE" | cut -d= -f2)

if [ "$new_token" = "$current_token" ]; then
  exit 0
fi

echo "$LOG_PREFIX Token changed, updating .env"
sed -i '' "s|^CLAUDE_CODE_OAUTH_TOKENS=.*|CLAUDE_CODE_OAUTH_TOKENS=$new_token|" "$ENV_FILE"

# Restart EJClaw if running
pid=$(pgrep -f "bun --watch src/index.ts" | head -1)
if [ -n "$pid" ]; then
  echo "$LOG_PREFIX Restarting EJClaw (pid $pid)"
  kill "$pid"
  sleep 2
  cd /Users/icheongho/AiGroup/EJClaw && nohup bun run dev >> /Users/icheongho/AiGroup/EJClaw/logs/ejclaw.log 2>&1 &
  echo "$LOG_PREFIX EJClaw restarted"
fi
