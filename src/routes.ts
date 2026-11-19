/**
 * API route handlers. All responses are JSON. Auth checks per route:
 *   - open:      /api/health, /api/state, /api/season/:id
 *   - user:      /api/auth/*, /api/me
 *   - admin:     starting/eliminating/undoing/deleting games, seasons,
 *                player management
 *
 * Live tournament rules:
 *   - only an admin starts a game, and only one game per calendar day;
 *   - only one game can be running at a time;
 *   - the admin marks players as eliminated: the first player out gets the
 *     worst position (N), the next N-1, ... the last remaining player wins
 *     (position 1) and the game finishes with points assigned.
 */
import type { Database } from "bun:sqlite";
import type { PlayerRow, GameRow } from "./db";
import { clearSetting, getSetting, setSetting } from "./db";
import { formulaPoints } from "./points";
import {
  clearSessionCookie,
  clientIp,
  hashPassword,
  inviteMatches,
  loadCurrentPlayer,
  rateLimited,
  resetRateLimit,
  setSessionCookie,
  signSession,
  verifyPassword,
} from "./auth";

export interface Ctx {
  db: Database;
  points: number[];
  inviteCode: string;
  sessionSecret: string;
}

export interface AuthedCtx extends Ctx {
  user: PlayerRow;
}

// --- JSON helpers ---

export function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8" },
  });
}

export function error(message: string, status = 400): Response {
  return json({ error: message }, status);
}

// --- Helpers ---

export function todayUtc(): string {
  return new Date().toISOString().slice(0, 10);
}

function validateDate(d: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(d)) return false;
  const date = new Date(`${d}T00:00:00Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === d;
}

export interface StandingsRow {
  player: { id: number; name: string };
  games: number;
  bets: number;
  points: number;
}

/** Betting limits (in season points). */
export const MIN_STAKE = 5;
export const MAX_STAKE = 100;

function standingsForSeason(db: Database, seasonId: number): StandingsRow[] {
  // Season points = starting bank + tournament points from finished games +
  // betting P/L (payout − stake) from finished games.
  const base =
    (db.query("SELECT starting_points FROM seasons WHERE id = ?").get(seasonId) as {
      starting_points: number;
    } | null)?.starting_points ?? 0;
  const rows = db
    .query(
      `WITH gp AS (
         SELECT r.player_id AS pid,
                COUNT(DISTINCT r.game_id) AS games,
                SUM(r.points) AS pts
         FROM results r JOIN games g ON g.id = r.game_id
         WHERE g.season_id = ? AND g.status = 'finished'
         GROUP BY r.player_id
       ), bp AS (
         SELECT b.bettor_id AS pid,
                COUNT(DISTINCT b.game_id) AS bets,
                SUM(b.payout - b.stake) AS pts
         FROM bets b JOIN games g ON g.id = b.game_id
         WHERE g.season_id = ? AND g.status = 'finished'
         GROUP BY b.bettor_id
       )
       SELECT p.id, p.name,
              COALESCE(gp.games, 0) AS games,
              COALESCE(bp.bets, 0) AS bets,
              COALESCE(gp.pts, 0) + COALESCE(bp.pts, 0) AS pts
       FROM players p
       LEFT JOIN gp ON gp.pid = p.id
       LEFT JOIN bp ON bp.pid = p.id
       ORDER BY pts DESC, p.name COLLATE NOCASE ASC`,
    )
    .all(seasonId, seasonId) as { id: number; name: string; games: number; bets: number; pts: number }[];
  // Re-sort after adding the bank (the SQL ordering only ranks the deltas).
  return rows
    .map((r) => ({
      player: { id: r.id, name: r.name },
      games: r.games,
      bets: r.bets,
      points: base + r.pts,
    }))
    .sort((a, b) => b.points - a.points || a.player.name.localeCompare(b.player.name));
}

/** Finished games only — used for the history list. */
function finishedGames(db: Database, seasonId: number, limit = 100): unknown[] {
  const games = db
    .query(
      "SELECT * FROM games WHERE season_id = ? AND status = 'finished' ORDER BY date DESC, id DESC LIMIT ?",
    )
    .all(seasonId, limit) as GameRow[];
  return games.map((g) => {
    const results = db
      .query(
        `SELECT r.player_id, p.name, r.position, r.points
         FROM results r JOIN players p ON p.id = r.player_id
         WHERE r.game_id = ? ORDER BY r.position ASC`,
      )
      .all(g.id) as { player_id: number; name: string; position: number; points: number }[];
    const creator = g.created_by
      ? (db.query("SELECT name FROM players WHERE id = ?").get(g.created_by) as { name: string } | null)
      : null;
    return {
      id: g.id,
      date: g.date,
      notes: g.notes,
      createdBy: creator?.name ?? null,
      createdAt: g.created_at,
      finishedAt: g.finished_at,
      results: results.map((r) => ({
        playerId: r.player_id,
        name: r.name,
        position: r.position,
        points: r.points,
      })),
      bets: db
        .query(
          `SELECT b.bettor_id AS bettorId, bp.name AS bettorName,
                  b.on_player_id AS onPlayerId, op.name AS onName, b.stake, b.payout
           FROM bets b
           JOIN players bp ON bp.id = b.bettor_id
           JOIN players op ON op.id = b.on_player_id
           WHERE b.game_id = ? ORDER BY b.id`,
        )
        .all(g.id) as unknown[],
    };
  });
}

/** The live game (status = 'running') for a season, if any. Bets stay hidden until the lock. */
function runningGame(db: Database, seasonId: number, viewerId: number | null): unknown | null {
  const game = db
    .query("SELECT * FROM games WHERE season_id = ? AND status = 'running' ORDER BY id DESC LIMIT 1")
    .get(seasonId) as GameRow | null;
  if (!game) return null;
  const rows = db
    .query(
      `SELECT r.player_id, p.name, r.position
       FROM results r JOIN players p ON p.id = r.player_id
       WHERE r.game_id = ?`,
    )
    .all(game.id) as { player_id: number; name: string; position: number | null }[];
  const remaining = rows
    .filter((r) => r.position === null)
    .map((r) => ({ id: r.player_id, name: r.name }))
    .sort((a, b) => a.name.localeCompare(b.name));
  const eliminated = rows
    .filter((r) => r.position !== null)
    .map((r) => ({ id: r.player_id, name: r.name, position: r.position as number }))
    .sort((a, b) => b.position - a.position); // first player out first
  const locked = game.bets_locked === 1;
  // My own bets are always visible to me; everybody's bets only after the lock
  // (before the lock nobody can see who bet on whom — no copying, no collusion).
  const mine = viewerId
    ? (db
        .query(
          `SELECT b.id, b.on_player_id AS onPlayerId, p.name AS onName, b.stake, b.created_at AS createdAt
           FROM bets b JOIN players p ON p.id = b.on_player_id
           WHERE b.game_id = ? AND b.bettor_id = ? ORDER BY b.id`,
        )
        .all(game.id, viewerId) as unknown[])
    : [];
  const all = locked
    ? (db
        .query(
          `SELECT b.bettor_id AS bettorId, bp.name AS bettorName,
                  b.on_player_id AS onPlayerId, op.name AS onName, b.stake
           FROM bets b
           JOIN players bp ON bp.id = b.bettor_id
           JOIN players op ON op.id = b.on_player_id
           WHERE b.game_id = ? ORDER BY b.id`,
        )
        .all(game.id) as unknown[])
    : null;
  const pool = locked
    ? (db.query("SELECT COALESCE(SUM(stake), 0) AS s FROM bets WHERE game_id = ?").get(game.id) as { s: number }).s
    : null;
  return {
    id: game.id,
    date: game.date,
    notes: game.notes,
    startedAt: game.created_at,
    totalPlayers: rows.length,
    remaining,
    eliminated,
    bets: { locked, open: game.status === "running" && !locked, pool, mine, all },
  };
}

/** Parimutuel settlement: losers' stakes are split among those who backed the winner. */
function settleBets(db: Database, gameId: number, winnerId: number): void {
  const bets = db.query("SELECT id, on_player_id, stake FROM bets WHERE game_id = ?").all(gameId) as {
    id: number;
    on_player_id: number;
    stake: number;
  }[];
  if (bets.length === 0) return;
  const pool = bets.reduce((sum, b) => sum + b.stake, 0);
  const winnerStake = bets.filter((b) => b.on_player_id === winnerId).reduce((sum, b) => sum + b.stake, 0);
  const update = db.prepare("UPDATE bets SET payout = ? WHERE id = ?");
  for (const bet of bets) {
    let payout = 0;
    if (winnerStake === 0) payout = bet.stake; // nobody backed the winner → stakes are refunded
    else if (bet.on_player_id === winnerId) payout = Math.floor((bet.stake * pool) / winnerStake);
    update.run(payout, bet.id);
  }
}

function seasonSummary(db: Database, season: { id: number; name: string; prize: string | null; archived_at: string | null }): unknown {
  const standings = standingsForSeason(db, season.id);
  return {
    id: season.id,
    name: season.name,
    prize: season.prize,
    archived: season.archived_at !== null,
    champion: standings.find((r) => r.games > 0 || r.bets > 0)?.player ?? null,
  };
}

function publicPlayer(p: PlayerRow): unknown {
  return { id: p.id, name: p.name, isAdmin: p.is_admin === 1, joinedAt: p.created_at };
}

// --- Theme ---

export type Theme = "default" | "christmas";

/** December → the Christmas theme is the default for everyone. */
export function seasonalTheme(now = new Date()): Theme {
  return now.getUTCMonth() === 11 ? "christmas" : "default";
}

export function siteTheme(db: Database): Theme {
  const stored = getSetting(db, "theme", "");
  if (stored === "christmas" || stored === "default") return stored;
  return seasonalTheme();
}

/** POST /api/settings/theme { theme: "default" | "christmas" | "auto" } — admin. */
export async function handleSetTheme(ctx: Ctx, req: Request): Promise<Response> {
  const auth = await requireAdmin(ctx, req);
  if (auth instanceof Response) return auth;
  const body = (await req.json().catch(() => null)) as { theme?: unknown } | null;
  const theme = typeof body?.theme === "string" ? body.theme : "";
  if (theme === "auto") {
    clearSetting(ctx.db, "theme");
  } else if (theme === "christmas" || theme === "default") {
    setSetting(ctx.db, "theme", theme);
  } else {
    return error('theme must be "default", "christmas" or "auto"');
  }
  return json({ ok: true, siteTheme: siteTheme(ctx.db) });
}

// --- Route handlers ---

export async function handleHealth(): Promise<Response> {
  return json({ ok: true });
}

export async function handleState(ctx: Ctx, req: Request): Promise<Response> {
  const user = await loadCurrentPlayer(ctx.db, ctx.sessionSecret, req);
  const active = ctx.db
    .query("SELECT * FROM seasons WHERE archived_at IS NULL ORDER BY id DESC LIMIT 1")
    .get() as { id: number; name: string; prize: string | null; archived_at: string | null } | null;
  const seasons = (
    ctx.db.query("SELECT * FROM seasons ORDER BY id DESC").all() as {
      id: number;
      name: string;
      prize: string | null;
      archived_at: string | null;
    }[]
  ).map((s) => seasonSummary(ctx.db, s));
  const players = (
    ctx.db.query("SELECT id, name FROM players ORDER BY name COLLATE NOCASE ASC").all() as {
      id: number;
      name: string;
    }[]
  ).map((p) => ({ id: p.id, name: p.name }));

  const today = todayUtc();
  const todayHasGame =
    (ctx.db.query("SELECT COUNT(*) AS n FROM games WHERE date = ?").get(today) as { n: number }).n > 0;

  return json({
    me: user ? publicPlayer(user) : null,
    activeSeason: active
      ? {
          id: active.id,
          name: active.name,
          prize: active.prize,
          standings: standingsForSeason(ctx.db, active.id),
          games: finishedGames(ctx.db, active.id),
          runningGame: runningGame(ctx.db, active.id, user?.id ?? null),
        }
      : null,
    seasons,
    players,
    pointsTable: ctx.points,
    today,
    todayHasGame,
    siteTheme: siteTheme(ctx.db),
    siteThemeSetting: getSetting(ctx.db, "theme", "auto"),
  });
}

export async function handleSeason(ctx: Ctx, _req: Request, seasonId: number): Promise<Response> {
  const season = ctx.db.query("SELECT * FROM seasons WHERE id = ?").get(seasonId) as {
    id: number;
    name: string;
    prize: string | null;
    archived_at: string | null;
  } | null;
  if (!season) return error("Season not found", 404);
  const standings = standingsForSeason(ctx.db, season.id);
  return json({
    id: season.id,
    name: season.name,
    prize: season.prize,
    archived: season.archived_at !== null,
    champion: standings.find((r) => r.games > 0 || r.bets > 0)?.player ?? null,
    standings,
    games: finishedGames(ctx.db, season.id),
  });
}

export async function handleRegister(ctx: Ctx, req: Request): Promise<Response> {
  const ip = clientIp(req);
  if (rateLimited(ip)) return error("Too many attempts, try again later", 429);

  const body = (await req.json().catch(() => null)) as
    | { name?: unknown; password?: unknown; invite?: unknown }
    | null;
  if (!body) return error("Invalid JSON body");
  const name = typeof body.name === "string" ? body.name.trim() : "";
  const password = typeof body.password === "string" ? body.password : "";
  const invite = typeof body.invite === "string" ? body.invite : "";

  if (!inviteMatches(invite, ctx.inviteCode)) return error("Invalid invite code", 403);
  if (!/^[^\x00-\x1f\x7f]{1,30}$/.test(name)) {
    return error("Name must be 1-30 characters");
  }
  if (password.length < 8) return error("Password must be at least 8 characters");
  if (password.length > 128) return error("Password too long");

  const existing = ctx.db.query("SELECT id FROM players WHERE name = ? COLLATE NOCASE").get(name);
  if (existing) return error("That name is already taken");

  const passHash = await hashPassword(password);
  const isFirst = (ctx.db.query("SELECT COUNT(*) AS n FROM players").get() as { n: number }).n === 0;
  const res = ctx.db
    .query("INSERT INTO players (name, pass_hash, is_admin) VALUES (?, ?, ?)")
    .run(name, passHash, isFirst ? 1 : 0);
  const player = ctx.db.query("SELECT * FROM players WHERE id = ?").get(res.lastInsertRowid) as PlayerRow;
  const token = await signSession(ctx.sessionSecret, player.id);
  return new Response(JSON.stringify({ me: publicPlayer(player) }), {
    status: 201,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Set-Cookie": setSessionCookie(token),
    },
  });
}

export async function handleLogin(ctx: Ctx, req: Request): Promise<Response> {
  const ip = clientIp(req);
  if (rateLimited(ip)) return error("Too many attempts, try again later", 429);

  const body = (await req.json().catch(() => null)) as { name?: unknown; password?: unknown } | null;
  if (!body) return error("Invalid JSON body");
  const name = typeof body.name === "string" ? body.name.trim() : "";
  const password = typeof body.password === "string" ? body.password : "";

  const player = ctx.db.query("SELECT * FROM players WHERE name = ? COLLATE NOCASE").get(name) as PlayerRow | null;
  if (!player || !(await verifyPassword(password, player.pass_hash))) {
    return error("Invalid name or password", 401);
  }
  resetRateLimit(ip);
  const token = await signSession(ctx.sessionSecret, player.id);
  return new Response(JSON.stringify({ me: publicPlayer(player) }), {
    status: 200,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Set-Cookie": setSessionCookie(token),
    },
  });
}

export async function handleLogout(): Promise<Response> {
  return new Response(JSON.stringify({ ok: true }), {
    status: 200,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Set-Cookie": clearSessionCookie(),
    },
  });
}

export async function handleMe(ctx: Ctx, req: Request): Promise<Response> {
  const user = await loadCurrentPlayer(ctx.db, ctx.sessionSecret, req);
  if (!user) return error("Not logged in", 401);
  return json({ me: publicPlayer(user) });
}

// --- Games: live tournament flow (admin only) ---

async function requireAdmin(ctx: Ctx, req: Request): Promise<AuthedCtx | Response> {
  const user = await loadCurrentPlayer(ctx.db, ctx.sessionSecret, req);
  if (!user) return error("Not logged in", 401);
  if (user.is_admin !== 1) return error("Admin only", 403);
  return { ...ctx, user };
}

/** POST /api/games — start tonight's game with a set of participants. */
export async function handleStartGame(ctx: Ctx, req: Request): Promise<Response> {
  const auth = await requireAdmin(ctx, req);
  if (auth instanceof Response) return auth;

  const body = (await req.json().catch(() => null)) as
    | { participants?: unknown; date?: unknown; notes?: unknown }
    | null;
  if (!body) return error("Invalid JSON body");

  const date = typeof body.date === "string" && body.date ? body.date : todayUtc();
  if (!validateDate(date)) return error("Invalid date (expected YYYY-MM-DD)");
  const notes = typeof body.notes === "string" ? body.notes.trim().slice(0, 500) || null : null;

  const rawParticipants = Array.isArray(body.participants) ? body.participants : [];
  const participants: number[] = [];
  for (const p of rawParticipants) {
    if (typeof p !== "number" || !Number.isInteger(p)) return error("participants must be player ids");
    if (!participants.includes(p)) participants.push(p);
  }
  if (participants.length < 2) return error("A game needs at least 2 players");
  if (participants.length > 50) return error("Too many players");

  const placeholders = participants.map(() => "?").join(",");
  const found = ctx.db
    .query(`SELECT id FROM players WHERE id IN (${placeholders})`)
    .all(...participants) as { id: number }[];
  if (found.length !== participants.length) return error("Unknown player in participants");

  const sameDay = ctx.db.query("SELECT id FROM games WHERE date = ?").get(date);
  if (sameDay) return error("Only one game per day", 409);
  const running = ctx.db.query("SELECT id FROM games WHERE status = 'running'").get();
  if (running) return error("A game is already in progress", 409);

  const active = ctx.db
    .query("SELECT id FROM seasons WHERE archived_at IS NULL ORDER BY id DESC LIMIT 1")
    .get() as { id: number } | null;
  if (!active) return error("No active season");

  const gameRes = ctx.db
    .query("INSERT INTO games (season_id, date, notes, status, created_by) VALUES (?, ?, ?, 'running', ?)")
    .run(active.id, date, notes, auth.user.id);
  const gameId = Number(gameRes.lastInsertRowid);
  const insertResult = ctx.db.prepare(
    "INSERT INTO results (game_id, player_id, position, points) VALUES (?, ?, NULL, 0)",
  );
  for (const playerId of participants) insertResult.run(gameId, playerId);

  return json({ ok: true, gameId }, 201);
}

/** POST /api/games/:id/eliminate — mark a player as eliminated. */
export async function handleEliminate(ctx: Ctx, req: Request, gameId: number): Promise<Response> {
  const auth = await requireAdmin(ctx, req);
  if (auth instanceof Response) return auth;

  const body = (await req.json().catch(() => null)) as { playerId?: unknown } | null;
  const playerId = typeof body?.playerId === "number" ? body.playerId : null;
  if (playerId === null) return error("playerId is required");

  const game = ctx.db.query("SELECT * FROM games WHERE id = ?").get(gameId) as GameRow | null;
  if (!game) return error("Game not found", 404);
  if (game.status !== "running") return error("Game is not running", 400);

  const rows = ctx.db
    .query("SELECT player_id, position FROM results WHERE game_id = ?")
    .all(gameId) as { player_id: number; position: number | null }[];
  const inGame = rows.filter((r) => r.position === null);
  const target = inGame.find((r) => r.player_id === playerId);
  if (!target) return error("Player is not in this game", 400);
  if (inGame.length <= 1) return error("Game already has a winner", 400);

  // First out gets the worst position (N), then N-1, ...
  const position = inGame.length;
  ctx.db
    .query("UPDATE results SET position = ? WHERE game_id = ? AND player_id = ?")
    .run(position, gameId, playerId);
  // The first elimination locks betting: from here the outcome is partially known.
  ctx.db.query("UPDATE games SET bets_locked = 1 WHERE id = ?").run(gameId);

  const remaining = inGame.length - 1;
  if (remaining > 1) {
    return json({ ok: true, finished: false, remaining });
  }

  // One player left — they win. Assign points for every position.
  const winner = inGame.find((r) => r.player_id !== playerId)!;
  ctx.db
    .query("UPDATE results SET position = 1 WHERE game_id = ? AND player_id = ?")
    .run(gameId, winner.player_id);
  const finalRows = ctx.db
    .query("SELECT player_id, position FROM results WHERE game_id = ?")
    .all(gameId) as { player_id: number; position: number }[];
  const updatePoints = ctx.db.prepare(
    "UPDATE results SET points = ? WHERE game_id = ? AND player_id = ?",
  );
  for (const r of finalRows) {
    updatePoints.run(formulaPoints(finalRows.length, r.position), gameId, r.player_id);
  }
  ctx.db
    .query("UPDATE games SET status = 'finished', finished_at = datetime('now') WHERE id = ?")
    .run(gameId);
  settleBets(ctx.db, gameId, winner.player_id);

  return json({ ok: true, finished: true, winnerId: winner.player_id });
}

/** POST /api/games/:id/bets { onPlayerId, stake } — non-participants only, before the lock. */
export async function handlePlaceBet(ctx: Ctx, req: Request, gameId: number): Promise<Response> {
  const user = await loadCurrentPlayer(ctx.db, ctx.sessionSecret, req);
  if (!user) return error("Not logged in", 401);

  const body = (await req.json().catch(() => null)) as { onPlayerId?: unknown; stake?: unknown } | null;
  const onPlayerId = typeof body?.onPlayerId === "number" ? body.onPlayerId : null;
  const stake = typeof body?.stake === "number" ? Math.floor(body.stake) : null;
  if (onPlayerId === null || stake === null) return error("onPlayerId and stake are required");

  const game = ctx.db.query("SELECT * FROM games WHERE id = ?").get(gameId) as GameRow | null;
  if (!game) return error("Game not found", 404);
  if (game.status !== "running") return error("Game is not running", 400);
  if (game.bets_locked === 1) return error("Betting is locked — the first player is already out", 409);

  // Note: betting on yourself is allowed — it only reinforces honest play
  // (you profit only if you actually win).

  const onPlayer = ctx.db
    .query("SELECT 1 AS x FROM results WHERE game_id = ? AND player_id = ?")
    .get(gameId, onPlayerId);
  if (!onPlayer) return error("You can only bet on a player in this game", 400);

  if (stake < MIN_STAKE) return error(`Minimum stake is ${MIN_STAKE} points`);
  if (stake > MAX_STAKE) return error(`Maximum stake is ${MAX_STAKE} points`);

  // Balance = current season points; already committed stakes count against it.
  const balance =
    standingsForSeason(ctx.db, game.season_id).find((r) => r.player.id === user.id)?.points ?? 0;
  const committed = (
    ctx.db
      .query("SELECT COALESCE(SUM(stake), 0) AS s FROM bets WHERE game_id = ? AND bettor_id = ?")
      .get(gameId, user.id) as { s: number }
  ).s;
  if (balance - committed < stake) {
    return error(`Not enough points (available: ${Math.max(balance - committed, 0)})`);
  }

  ctx.db
    .query("INSERT INTO bets (game_id, bettor_id, on_player_id, stake) VALUES (?, ?, ?, ?)")
    .run(gameId, user.id, onPlayerId, stake);
  return json({ ok: true, available: balance - committed - stake }, 201);
}

/** POST /api/games/:id/undo — revert the last step (elimination or the win). */
export async function handleUndo(ctx: Ctx, req: Request, gameId: number): Promise<Response> {
  const auth = await requireAdmin(ctx, req);
  if (auth instanceof Response) return auth;

  const game = ctx.db.query("SELECT * FROM games WHERE id = ?").get(gameId) as GameRow | null;
  if (!game) return error("Game not found", 404);

  if (game.status === "finished") {
    // Reopen: put the winner back in the game and clear points.
    const winner = ctx.db
      .query("SELECT player_id FROM results WHERE game_id = ? AND position = 1")
      .get(gameId) as { player_id: number } | null;
    if (!winner) return error("Nothing to undo");
    ctx.db
      .query("UPDATE results SET position = NULL, points = 0 WHERE game_id = ? AND player_id = ?")
      .run(gameId, winner.player_id);
    ctx.db.query("UPDATE results SET points = 0 WHERE game_id = ?").run(gameId);
    // Bets stay locked once the first player was out; only the payouts are reversed.
    ctx.db.query("UPDATE bets SET payout = 0 WHERE game_id = ?").run(gameId);
    ctx.db
      .query("UPDATE games SET status = 'running', finished_at = NULL WHERE id = ?")
      .run(gameId);
    return json({ ok: true, reopened: true });
  }

  const last = ctx.db
    .query(
      "SELECT player_id FROM results WHERE game_id = ? AND position IS NOT NULL ORDER BY position DESC LIMIT 1",
    )
    .get(gameId) as { player_id: number } | null;
  if (!last) return error("Nothing to undo");

  ctx.db
    .query("UPDATE results SET position = NULL, points = 0 WHERE game_id = ? AND player_id = ?")
    .run(gameId, last.player_id);
  return json({ ok: true, restoredPlayerId: last.player_id });
}

/** DELETE /api/games/:id — admin only. */
export async function handleDeleteGame(ctx: Ctx, req: Request, gameId: number): Promise<Response> {
  const auth = await requireAdmin(ctx, req);
  if (auth instanceof Response) return auth;

  const game = ctx.db.query("SELECT id FROM games WHERE id = ?").get(gameId);
  if (!game) return error("Game not found", 404);
  ctx.db.query("DELETE FROM games WHERE id = ?").run(gameId);
  return json({ ok: true });
}

// --- Seasons (admin only) ---

export async function handleCreateSeason(ctx: Ctx, req: Request): Promise<Response> {
  const auth = await requireAdmin(ctx, req);
  if (auth instanceof Response) return auth;
  const body = (await req.json().catch(() => null)) as { name?: unknown; prize?: unknown } | null;
  const name = typeof body?.name === "string" && body.name.trim() ? body.name.trim().slice(0, 60) : null;
  const prize = typeof body?.prize === "string" ? body.prize.trim().slice(0, 200) || null : null;
  const active = ctx.db.query("SELECT id FROM seasons WHERE archived_at IS NULL LIMIT 1").get();
  if (active) return error("Archive the current season first");
  const res = ctx.db
    .query("INSERT INTO seasons (name, prize) VALUES (?, ?)")
    .run(
      name ?? "Season " + (ctx.db.query("SELECT COUNT(*) AS n FROM seasons").get() as { n: number }).n,
      prize,
    );
  return json({ ok: true, seasonId: Number(res.lastInsertRowid) }, 201);
}

export async function handleArchiveSeason(ctx: Ctx, req: Request, seasonId: number): Promise<Response> {
  const auth = await requireAdmin(ctx, req);
  if (auth instanceof Response) return auth;
  const season = ctx.db.query("SELECT * FROM seasons WHERE id = ?").get(seasonId) as {
    id: number;
    archived_at: string | null;
  } | null;
  if (!season) return error("Season not found", 404);
  if (season.archived_at !== null) return error("Season already archived");
  ctx.db.query("UPDATE seasons SET archived_at = datetime('now') WHERE id = ?").run(seasonId);
  const next = `Season ${seasonId + 1}`;
  ctx.db.query("INSERT INTO seasons (name) VALUES (?)").run(next);
  return json({ ok: true, nextSeason: next }, 200);
}

// --- Players (admin only) ---

export async function handleRenamePlayer(ctx: Ctx, req: Request, playerId: number): Promise<Response> {
  const auth = await requireAdmin(ctx, req);
  if (auth instanceof Response) return auth;
  const body = (await req.json().catch(() => null)) as { name?: unknown } | null;
  const name = typeof body?.name === "string" ? body.name.trim() : "";
  if (!/^[^\x00-\x1f\x7f]{1,30}$/.test(name)) return error("Name must be 1-30 characters");
  const taken = ctx.db
    .query("SELECT id FROM players WHERE name = ? COLLATE NOCASE AND id != ?")
    .get(name, playerId);
  if (taken) return error("That name is already taken");
  const res = ctx.db.query("UPDATE players SET name = ? WHERE id = ?").run(name, playerId);
  if (res.changes === 0) return error("Player not found", 404);
  return json({ ok: true });
}

export async function handleSetAdmin(ctx: Ctx, req: Request, playerId: number): Promise<Response> {
  const auth = await requireAdmin(ctx, req);
  if (auth instanceof Response) return auth;
  const body = (await req.json().catch(() => null)) as { isAdmin?: unknown } | null;
  const isAdmin = body?.isAdmin === true ? 1 : 0;
  const res = ctx.db.query("UPDATE players SET is_admin = ? WHERE id = ?").run(isAdmin, playerId);
  if (res.changes === 0) return error("Player not found", 404);
  return json({ ok: true });
}
