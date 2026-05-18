import type { Database } from 'bun:sqlite';

import { getTableColumns } from './helpers.js';
import type { SchemaMigrationDefinition } from './types.js';

export const OLLAMA_AGENT_TYPE_MIGRATION: SchemaMigrationDefinition = {
  version: 17,
  name: 'ollama_agent_type',
  apply(database: Database) {
    const ptSqlRow = database
      .prepare(
        `SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'paired_tasks'`,
      )
      .get() as { sql?: string } | undefined;
    const ptSql = ptSqlRow?.sql ?? '';

    if (
      ptSql.includes("'claude-code', 'codex'") &&
      !ptSql.includes("'ollama'")
    ) {
      const cols = getTableColumns(database, 'paired_tasks');
      const colList = cols.join(', ');

      database.exec(`CREATE TABLE paired_tasks_new (
          id TEXT PRIMARY KEY,
          chat_jid TEXT NOT NULL,
          group_folder TEXT NOT NULL,
          owner_service_id TEXT NOT NULL,
          reviewer_service_id TEXT NOT NULL,
          owner_agent_type TEXT,
          reviewer_agent_type TEXT,
          arbiter_agent_type TEXT,
          title TEXT,
          source_ref TEXT,
          plan_notes TEXT,
          review_requested_at TEXT,
          round_trip_count INTEGER NOT NULL DEFAULT 0,
          owner_failure_count INTEGER NOT NULL DEFAULT 0,
          owner_step_done_streak INTEGER NOT NULL DEFAULT 0,
          finalize_step_done_count INTEGER NOT NULL DEFAULT 0,
          task_done_then_user_reopen_count INTEGER NOT NULL DEFAULT 0,
          empty_step_done_streak INTEGER NOT NULL DEFAULT 0,
          status TEXT NOT NULL DEFAULT 'active',
          arbiter_verdict TEXT,
          arbiter_requested_at TEXT,
          completion_reason TEXT,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          CHECK (status IN ('active', 'review_ready', 'in_review', 'merge_ready', 'completed', 'arbiter_requested', 'in_arbitration')),
          CHECK (owner_agent_type IN ('claude-code', 'codex', 'ollama', 'opencode') OR owner_agent_type IS NULL),
          CHECK (reviewer_agent_type IN ('claude-code', 'codex', 'ollama', 'opencode') OR reviewer_agent_type IS NULL),
          CHECK (arbiter_agent_type IN ('claude-code', 'codex', 'ollama', 'opencode') OR arbiter_agent_type IS NULL)
        )`);

      database.exec(
        `INSERT INTO paired_tasks_new (${colList}) SELECT ${colList} FROM paired_tasks`,
      );
      database.exec(`DROP TABLE paired_tasks`);
      database.exec(`ALTER TABLE paired_tasks_new RENAME TO paired_tasks`);
      database.exec(
        `CREATE INDEX IF NOT EXISTS idx_paired_tasks_chat_status ON paired_tasks(chat_jid, status, updated_at)`,
      );
    }
  },
};
