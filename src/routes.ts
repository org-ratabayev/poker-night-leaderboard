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
import { pointsForPosition } from "./points";
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
  points: number;
}

function standingsForSeason(db: Database, seasonId: number): StandingsRow[] {
  const rows = db
    .query(
      `SELECT r.player_id, p.name, COUNT(DISTINCT g.id) AS games, SUM(r.points) AS points
       FROM results r
       JOIN games g ON g.id = r.game_id
       JOIN players p ON p.id = r.player_id
       WHERE g.season_id = ? AND g.status = 'finished'
       GROUP BY r.player_id
       ORDER BY points DESC, p.name COLLATE NOCASE ASC`,
    )
    .all(seasonId) as { player_id: number; name: string; games: number; points: number }[];
  return rows.map((r) => ({
    player: { id: r.player_id, name: r.name },
    games: r.games,
    points: r.points,
  }));
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
    };
  });
}

/** The live game (status = 'running') for a season, if any. */
function runningGame(db: Database, seasonId: number): unknown | null {
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
  return {
    id: game.id,
    date: game.date,
    notes: game.notes,
    startedAt: game.created_at,
    totalPlayers: rows.length,
    remaining,
    eliminated,
  };
}

function seasonSummary(db: Database, season: { id: number; name: string; prize: string | null; archived_at: string | null }): unknown {
  const standings = standingsForSeason(db, season.id);
  return {
    id: season.id,
    name: season.name,
    prize: season.prize,
    archived: season.archived_at !== null,
    champion: standings.length > 0 ? standings[0].player : null,
  };
}

function publicPlayer(p: PlayerRow): unknown {
  return { id: p.id, name: p.name, isAdmin: p.is_admin === 1, joinedAt: p.created_at };
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
          runningGame: runningGame(ctx.db, active.id),
        }
      : null,
    seasons,
    players,
    pointsTable: ctx.points,
    today,
    todayHasGame,
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
    champion: standings.length > 0 ? standings[0].player : null,
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
    updatePoints.run(pointsForPosition(ctx.points, r.position), gameId, r.player_id);
  }
  ctx.db
    .query("UPDATE games SET status = 'finished', finished_at = datetime('now') WHERE id = ?")
    .run(gameId);

  return json({ ok: true, finished: true, winnerId: winner.player_id });
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
