/**
 * SQLite access layer (bun:sqlite — built into the Bun runtime, no deps).
 * Schema is small and stable; migrate() is idempotent.
 */
import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { join } from "node:path";

export interface PlayerRow {
  id: number;
  name: string;
  pass_hash: string;
  is_admin: number;
  created_at: string;
}

export interface SeasonRow {
  id: number;
  name: string;
  prize: string | null;
  created_at: string;
  archived_at: string | null;
}

export interface GameRow {
  id: number;
  season_id: number;
  date: string;
  notes: string | null;
  created_by: number | null;
  created_at: string;
}

export interface ResultRow {
  game_id: number;
  player_id: number;
  position: number;
  points: number;
}

export function openDb(dataDir: string): Database {
  mkdirSync(dataDir, { recursive: true });
  const db = new Database(join(dataDir, "poker.db"));
  db.exec("PRAGMA journal_mode = WAL;");
  db.exec("PRAGMA foreign_keys = ON;");
  migrate(db);
  return db;
}

function migrate(db: Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS seasons (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      prize TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      archived_at TEXT
    );
    CREATE TABLE IF NOT EXISTS players (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL UNIQUE COLLATE NOCASE,
      pass_hash TEXT NOT NULL,
      is_admin INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS games (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      season_id INTEGER NOT NULL REFERENCES seasons(id),
      date TEXT NOT NULL,
      notes TEXT,
      created_by INTEGER REFERENCES players(id),
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS results (
      game_id INTEGER NOT NULL REFERENCES games(id) ON DELETE CASCADE,
      player_id INTEGER NOT NULL REFERENCES players(id),
      position INTEGER NOT NULL,
      points INTEGER NOT NULL,
      PRIMARY KEY (game_id, player_id)
    );
  `);

  // Add `prize` column to seasons created before it existed.
  const cols = db.query("PRAGMA table_info(seasons)").all() as { name: string }[];
  if (!cols.some((c) => c.name === "prize")) {
    db.exec("ALTER TABLE seasons ADD COLUMN prize TEXT;");
  }

  // Ensure exactly one active season exists.
  const active = db
    .query("SELECT id FROM seasons WHERE archived_at IS NULL LIMIT 1")
    .get() as { id: number } | null;
  if (!active) {
    db.query("INSERT INTO seasons (name) VALUES (?)").run("Season 1");
  }
}
