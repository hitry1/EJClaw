import type { Database } from 'bun:sqlite';

import { getTableColumns } from './helpers.js';
import type { SchemaMigrationDefinition } from './types.js';

export const OLLAMA_TURN_ATTEMPTS_MIGRATION: SchemaMigrationDefinition = {
  version: 18,
  name: 'ollama_turn_attempts',
  apply(database: Database) {
    const row = database
      .prepare(
        `SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'paired_turn_attempts'`,
      )
      .get() as { sql?: string } | undefined;
    const sql = row?.sql ?? '';

    if (sql.includes("'claude-code', 'codex'") && !sql.includes("'ollama'")) {
      const cols = getTableColumns(database, 'paired_turn_attempts');
      const colList = cols.join(', ');
      const db = database;

      db.exec(`CREATE TABLE paired_turn_attempts_new (
        attempt_id TEXT NOT NULL PRIMARY KEY,
        parent_attempt_id TEXT,
        parent_handoff_id INTEGER,
        continuation_handoff_id INTEGER,
        turn_id TEXT NOT NULL,
        attempt_no INTEGER NOT NULL,
        task_id TEXT NOT NULL,
        task_updated_at TEXT NOT NULL,
        role TEXT NOT NULL,
        intent_kind TEXT NOT NULL,
        state TEXT NOT NULL,
        executor_service_id TEXT,
        executor_agent_type TEXT,
        active_run_id TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        completed_at TEXT,
        last_error TEXT,
        UNIQUE (turn_id, attempt_no),
        FOREIGN KEY (parent_attempt_id)
          REFERENCES paired_turn_attempts_new(attempt_id)
          ON DELETE CASCADE,
        FOREIGN KEY (turn_id) REFERENCES paired_turns(turn_id) ON DELETE CASCADE,
        CHECK (role IN ('owner', 'reviewer', 'arbiter')),
        CHECK (
          intent_kind IN (
            'owner-turn',
            'reviewer-turn',
            'arbiter-turn',
            'owner-follow-up',
            'finalize-owner-turn'
          )
        ),
        CHECK (
          state IN (
            'running',
            'delegated',
            'completed',
            'failed',
            'cancelled'
          )
        ),
        CHECK (executor_agent_type IN ('claude-code', 'codex', 'ollama', 'opencode') OR executor_agent_type IS NULL)
      )`);

      db.exec(
        `INSERT INTO paired_turn_attempts_new (${colList}) SELECT ${colList} FROM paired_turn_attempts`,
      );
      db.exec(`DROP TABLE paired_turn_attempts`);
      db.exec(
        `ALTER TABLE paired_turn_attempts_new RENAME TO paired_turn_attempts`,
      );
      db.exec(
        `CREATE INDEX IF NOT EXISTS idx_paired_turn_attempts_turn ON paired_turn_attempts(turn_id, attempt_no)`,
      );
      db.exec(
        `CREATE INDEX IF NOT EXISTS idx_paired_turn_attempts_task ON paired_turn_attempts(task_id, task_updated_at, attempt_no)`,
      );
    }
  },
};
