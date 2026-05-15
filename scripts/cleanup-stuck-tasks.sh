#!/bin/bash
# Cleans up paired_tasks stuck in 'active' for more than TIMEOUT_MINUTES.
# Sends a Discord notification to #ai-debate when cleanup occurs.

DB="/Users/icheongho/AiGroup/EJClaw/store/messages.db"
ENV_FILE="/Users/icheongho/AiGroup/EJClaw/.env"
TIMEOUT_MINUTES=30
CHANNEL_ID="1501796297911570505"
LOG_PREFIX="[cleanup-stuck-tasks]"

stuck=$(sqlite3 "$DB" "
  SELECT id FROM paired_tasks
  WHERE status = 'active'
    AND updated_at < datetime('now', '-${TIMEOUT_MINUTES} minutes');
")

if [ -z "$stuck" ]; then
  exit 0
fi

count=0
while IFS= read -r task_id; do
  echo "$LOG_PREFIX Cleaning stuck task: $task_id"
  sqlite3 "$DB" "
    DELETE FROM paired_task_execution_leases WHERE task_id = '$task_id';
    DELETE FROM paired_turn_reservations WHERE task_id = '$task_id';
    DELETE FROM paired_tasks WHERE id = '$task_id';
  "
  count=$((count + 1))
done <<< "$stuck"

# Kill orphaned agent processes
ps aux | grep -E "agent-runner|claude.*stream-json" | grep -v grep | \
  awk '{print $2}' | xargs kill 2>/dev/null || true

# Send Discord notification
BOT_TOKEN=$(grep "^DISCORD_OWNER_BOT_TOKEN=" "$ENV_FILE" | cut -d= -f2)
if [ -n "$BOT_TOKEN" ]; then
  MSG="⚠️ [자동복구] stuck 태스크 ${count}개를 정리했습니다. 다시 메시지를 보내주세요."
  curl -s -X POST "https://discord.com/api/v10/channels/${CHANNEL_ID}/messages" \
    -H "Authorization: Bot ${BOT_TOKEN}" \
    -H "Content-Type: application/json" \
    -d "{\"content\": \"${MSG}\"}" > /dev/null
fi

echo "$LOG_PREFIX Done. Cleaned $count task(s)."
