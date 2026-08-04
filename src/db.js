import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const dataDir = path.join(ROOT, 'data');
fs.mkdirSync(dataDir, { recursive: true });

export const DB_PATH = path.join(dataDir, 'focus.db');
export const db = new DatabaseSync(DB_PATH);

db.exec(`
  PRAGMA journal_mode = WAL;
  PRAGMA busy_timeout = 5000;

  CREATE TABLE IF NOT EXISTS inspections (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    ended_at     INTEGER NOT NULL,
    duration_sec INTEGER,
    difficulty   TEXT    NOT NULL,
    note         TEXT    NOT NULL DEFAULT '',
    created_at   INTEGER NOT NULL,
    deleted      INTEGER NOT NULL DEFAULT 0
  );
  CREATE INDEX IF NOT EXISTS idx_insp_ended ON inspections (ended_at);
  CREATE INDEX IF NOT EXISTS idx_insp_diff_dur ON inspections (difficulty, duration_sec);

  CREATE TABLE IF NOT EXISTS work_events (
    id      INTEGER PRIMARY KEY AUTOINCREMENT,
    type    TEXT    NOT NULL,
    at      INTEGER NOT NULL,
    note    TEXT    NOT NULL DEFAULT '',
    deleted INTEGER NOT NULL DEFAULT 0
  );
  CREATE INDEX IF NOT EXISTS idx_ev_at ON work_events (at);

  CREATE TABLE IF NOT EXISTS settings (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );
`);

// 2026-08-01: 勤務・休憩イベントにもメモ欄を追加。既存DBにはALTERで追補(ID・既存データは不変)
const evCols = db.prepare('PRAGMA table_info(work_events)').all().map(c => c.name);
if (!evCols.includes('note')) {
  db.exec("ALTER TABLE work_events ADD COLUMN note TEXT NOT NULL DEFAULT ''");
}
