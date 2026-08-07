/**
 * API route handlers. All responses are JSON. Auth checks per route:
 *   - open:      /api/health, /api/state, /api/season/:id
 *   - user:      /api/auth/*, POST /api/games
 *   - admin:     DELETE /api/games/:id (or author), /api/seasons, /api/players/:id/*
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
  readCookie,
  resetRateLimit,
  SESSION_COOKIE,
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

// --- Public shape helpers ---

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
       WHERE g.season_id = ?
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

function gamesForSeason(db: Database, seasonId: number, limit = 100): unknown[] {
  const games = db
    .query("SELECT * FROM games WHERE season_id = ? ORDER BY date DESC, id DESC LIMIT ?")
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
      results: results.map((r) => ({
        playerId: r.player_id,
        name: r.name,
        position: r.position,
        points: r.points,
      })),
    };
  });
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

  return json({
    me: user ? publicPlayer(user) : null,
    activeSeason: active
      ? {
          id: active.id,
          name: active.name,
          prize: active.prize,
          standings: standingsForSeason(ctx.db, active.id),
          games: gamesForSeason(ctx.db, active.id),
        }
      : null,
    seasons,
    players,
    pointsTable: ctx.points,
  });
}

export async function handleSeason(ctx: Ctx, req: Request, seasonId: number): Promise<Response> {
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
    games: gamesForSeason(ctx.db, season.id),
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

// --- Games ---

function validateDate(d: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(d)) return false;
  const date = new Date(`${d}T00:00:00Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === d;
}

export async function handleCreateGame(ctx: AuthedCtx, req: Request): Promise<Response> {
  const body = (await req.json().catch(() => null)) as
    | { date?: unknown; notes?: unknown; results?: unknown }
    | null;
  if (!body) return error("Invalid JSON body");
  const date = typeof body.date === "string" ? body.date : "";
  if (!validateDate(date)) return error("Invalid date (expected YYYY-MM-DD)");
  const notes = typeof body.notes === "string" ? body.notes.trim().slice(0, 500) : null;

  const active = ctx.db.query("SELECT id FROM seasons WHERE archived_at IS NULL ORDER BY id DESC LIMIT 1").get() as { id: number } | null;
  if (!active) return error("No active season");

  const rawResults = Array.isArray(body.results) ? body.results : [];
  if (rawResults.length === 0 || rawResults.length > 50) {
    return error("A game needs 1-50 players");
  }
  const results: { playerId: number; position: number }[] = [];
  const seenPlayers = new Set<number>();
  const seenPositions = new Set<number>();
  for (const r of rawResults) {
    const rp = r as { playerId?: unknown; position?: unknown };
    if (typeof rp.playerId !== "number" || typeof rp.position !== "number") {
      return error("Each result needs playerId and position");
    }
    if (!Number.isInteger(rp.playerId) || !Number.isInteger(rp.position)) return error("playerId and position must be integers");
    if (seenPlayers.has(rp.playerId)) return error("Duplicate player in results");
    if (rp.position < 1 || rp.position > rawResults.length) return error("Positions must be 1..N");
    if (seenPositions.has(rp.position)) return error("Duplicate position");
    seenPlayers.add(rp.playerId);
    seenPositions.add(rp.position);
    results.push({ playerId: rp.playerId, position: rp.position });
  }
  // Contiguous positions: the set must be exactly {1..N}.
  if (seenPositions.size !== rawResults.length) return error("Positions must be 1..N");

  const playerIds = results.map((r) => r.playerId);
  const placeholders = playerIds.map(() => "?").join(",");
  const found = ctx.db
    .query(`SELECT id FROM players WHERE id IN (${placeholders})`)
    .all(...playerIds) as { id: number }[];
  if (found.length !== playerIds.length) return error("Unknown player in results");

  const gameRes = ctx.db
    .query("INSERT INTO games (season_id, date, notes, created_by) VALUES (?, ?, ?, ?)")
    .run(active.id, date, notes, ctx.user.id);
  const gameId = Number(gameRes.lastInsertRowid);
  const insertResult = ctx.db.prepare("INSERT INTO results (game_id, player_id, position, points) VALUES (?, ?, ?, ?)");
  for (const r of results) {
    insertResult.run(gameId, r.playerId, r.position, pointsForPosition(ctx.points, r.position));
  }
  return json({ ok: true, gameId }, 201);
}

export async function handleDeleteGame(ctx: AuthedCtx, gameId: number): Promise<Response> {
  const game = ctx.db.query("SELECT * FROM games WHERE id = ?").get(gameId) as GameRow | null;
  if (!game) return error("Game not found", 404);
  const isAdmin = ctx.user.is_admin === 1;
  const isAuthor = game.created_by === ctx.user.id;
  if (!isAdmin && !isAuthor) return error("Only the author or an admin can delete this game", 403);
  ctx.db.query("DELETE FROM games WHERE id = ?").run(gameId);
  return json({ ok: true });
}

// --- Seasons (admin only) ---

async function requireAdmin(ctx: Ctx, req: Request): Promise<AuthedCtx | Response> {
  const user = await loadCurrentPlayer(ctx.db, ctx.sessionSecret, req);
  if (!user) return error("Not logged in", 401);
  if (user.is_admin !== 1) return error("Admin only", 403);
  return { ...ctx, user };
}

export async function handleCreateSeason(ctx: Ctx, req: Request): Promise<Response> {
  const auth = await requireAdmin(ctx, req);
  if (auth instanceof Response) return auth;
  const body = (await req.json().catch(() => null)) as { name?: unknown; prize?: unknown } | null;
  const name = typeof body?.name === "string" && body.name.trim() ? body.name.trim().slice(0, 60) : null;
  const prize = typeof body?.prize === "string" ? body.prize.trim().slice(0, 200) || null : null;
  const active = ctx.db.query("SELECT id FROM seasons WHERE archived_at IS NULL LIMIT 1").get();
  if (active) return error("Archive the current season first");
  const res = ctx.db.query("INSERT INTO seasons (name, prize) VALUES (?, ?)").run(name ?? "Season " + (ctx.db.query("SELECT COUNT(*) AS n FROM seasons").get() as { n: number }).n, prize);
  return json({ ok: true, seasonId: Number(res.lastInsertRowid) }, 201);
}

export async function handleArchiveSeason(ctx: Ctx, req: Request, seasonId: number): Promise<Response> {
  const auth = await requireAdmin(ctx, req);
  if (auth instanceof Response) return auth;
  const season = ctx.db.query("SELECT * FROM seasons WHERE id = ?").get(seasonId) as { id: number; archived_at: string | null; name: string } | null;
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
  const taken = ctx.db.query("SELECT id FROM players WHERE name = ? COLLATE NOCASE AND id != ?").get(name, playerId);
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
