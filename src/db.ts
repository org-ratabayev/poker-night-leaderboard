/**
 * SQLite access layer (bun:sqlite — built into the Bun runtime, no deps).
 *
 * Live-tournament model:
 *   - a game is started by an admin with a set of participants
 *     (status = 'running'; every participant has position = NULL)
 *   - the admin marks players as eliminated one by one; the first player out
 *     gets the worst position (N), the next one N-1, ...
 *   - when a single player is left, that player wins (position 1) and points
 *     for all positions are written (status = 'finished')
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
  status: string; // 'running' | 'finished'
  bets_locked: number; // 1 once the first player is out
  created_by: number | null;
  created_at: string;
  finished_at: string | null;
}

export interface ResultRow {
  game_id: number;
  player_id: number;
  position: number | null; // NULL = still in the game
  points: number;
}

export function openDb(dataDir: string): Database {
  mkdirSync(dataDir, { recursive: true });
  const db = new Database(join(dataDir, "poker.db"));
  db.exec("PRAGMA journal_mode = WAL;");
  migrate(db);
  db.exec("PRAGMA foreign_keys = ON;");
  return db;
}

function tableColumns(db: Database, table: string): string[] {
  return (db.query(`PRAGMA table_info(${table})`).all() as { name: string }[]).map((c) => c.name);
}

// --- Key/value settings ---

export function getSetting(db: Database, key: string, fallback: string): string {
  const row = db.query("SELECT value FROM settings WHERE key = ?").get(key) as { value: string } | null;
  return row?.value ?? fallback;
}

export function setSetting(db: Database, key: string, value: string): void {
  db.query(
    "INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
  ).run(key, value);
}

export function clearSetting(db: Database, key: string): void {
  db.query("DELETE FROM settings WHERE key = ?").run(key);
}

function migrate(db: Database): void {
  db.exec("PRAGMA foreign_keys = OFF;");

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
      status TEXT NOT NULL DEFAULT 'finished',
      created_by INTEGER REFERENCES players(id),
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      finished_at TEXT
    );
    CREATE TABLE IF NOT EXISTS results (
      game_id INTEGER NOT NULL REFERENCES games(id) ON DELETE CASCADE,
      player_id INTEGER NOT NULL REFERENCES players(id),
      position INTEGER,
      points INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (game_id, player_id)
    );
    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS bets (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      game_id INTEGER NOT NULL REFERENCES games(id) ON DELETE CASCADE,
      bettor_id INTEGER NOT NULL REFERENCES players(id),
      on_player_id INTEGER NOT NULL REFERENCES players(id),
      stake INTEGER NOT NULL,
      payout INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_bets_game ON bets(game_id);
  `);

  // --- migrations for databases created by older versions ---

  const seasonCols = tableColumns(db, "seasons");
  if (!seasonCols.includes("prize")) {
    db.exec("ALTER TABLE seasons ADD COLUMN prize TEXT;");
  }

  const gameCols = tableColumns(db, "games");
  if (!gameCols.includes("status")) {
    db.exec("ALTER TABLE games ADD COLUMN status TEXT NOT NULL DEFAULT 'finished';");
  }
  if (!gameCols.includes("finished_at")) {
    db.exec("ALTER TABLE games ADD COLUMN finished_at TEXT;");
  }
  if (!gameCols.includes("bets_locked")) {
    db.exec("ALTER TABLE games ADD COLUMN bets_locked INTEGER NOT NULL DEFAULT 0;");
  }

  // results.position used to be NOT NULL; the live model needs NULL for
  // "still in the game". SQLite cannot drop NOT NULL in place → rebuild.
  const positionInfo = (db.query("PRAGMA table_info(results)").all() as {
    name: string;
    notnull: number;
  }[]).find((c) => c.name === "position");
  if (positionInfo && positionInfo.notnull === 1) {
    db.exec(`
      ALTER TABLE results RENAME TO results_old;
      CREATE TABLE results (
        game_id INTEGER NOT NULL REFERENCES games(id) ON DELETE CASCADE,
        player_id INTEGER NOT NULL REFERENCES players(id),
        position INTEGER,
        points INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (game_id, player_id)
      );
      INSERT INTO results (game_id, player_id, position, points)
        SELECT game_id, player_id, position, COALESCE(points, 0) FROM results_old;
      DROP TABLE results_old;
    `);
  }

  // Ensure exactly one active season exists.
  const active = db
    .query("SELECT id FROM seasons WHERE archived_at IS NULL LIMIT 1")
    .get() as { id: number } | null;
  if (!active) {
    db.query("INSERT INTO seasons (name) VALUES (?)").run("Season 1");
  }
}
