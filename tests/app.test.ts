/**
 * API tests. Spin up an isolated app instance per test file run using a
 * temp data dir, then exercise it through real HTTP Requests.
 */
import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb } from "../src/db";
import { parsePointsTable, pointsForPosition, DEFAULT_POINTS_TABLE } from "../src/points";
import { createApp } from "../src/app";

let dataDir: string;
let db: ReturnType<typeof openDb>;
let fetchHandler: (req: Request) => Promise<Response>;

const CONFIG = {
  points: parsePointsTable(DEFAULT_POINTS_TABLE),
  inviteCode: "secret-invite",
  sessionSecret: "test-secret-please-ignore-0123456789abcdef",
};

async function req(method: string, path: string, body?: unknown, cookie?: string): Promise<Response> {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (cookie) headers["Cookie"] = cookie;
  return fetchHandler(new Request(`http://test.local${path}`, {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  }));
}

function setCookieOf(res: Response): string {
  const raw = res.headers.get("set-cookie") ?? "";
  return raw.split(";")[0];
}

let adminCookie = "";
let playerCookie = "";

beforeAll(() => {
  dataDir = mkdtempSync(join(tmpdir(), "poker-test-"));
  db = openDb(dataDir);
  fetchHandler = createApp(db, CONFIG);
});

afterAll(() => {
  db.close();
  rmSync(dataDir, { recursive: true, force: true });
});

// --- Points ---

describe("points", () => {
  test("default table", () => {
    const t = parsePointsTable(undefined);
    expect(t).toEqual([100, 75, 55, 40, 30, 20, 12, 8, 5, 3]);
  });
  test("custom table", () => {
    expect(parsePointsTable("10,5")).toEqual([10, 5]);
  });
  test("invalid table throws", () => {
    expect(() => parsePointsTable("abc")).toThrow();
  });
  test("position mapping", () => {
    const t = parsePointsTable(DEFAULT_POINTS_TABLE);
    expect(pointsForPosition(t, 1)).toBe(100);
    expect(pointsForPosition(t, 2)).toBe(75);
    expect(pointsForPosition(t, 10)).toBe(3);
    expect(pointsForPosition(t, 11)).toBe(0); // beyond table
    expect(pointsForPosition(t, 0)).toBe(0);
  });
});

// --- Auth ---

describe("auth", () => {
  test("register requires invite", async () => {
    const res = await req("POST", "/api/auth/register", { name: "Ruslan", password: "password123", invite: "wrong" });
    expect(res.status).toBe(403);
  });

  test("first user registers and becomes admin", async () => {
    const res = await req("POST", "/api/auth/register", { name: "Ruslan", password: "password123", invite: "secret-invite" });
    expect(res.status).toBe(201);
    adminCookie = setCookieOf(res);
    const me = (await res.json()) as { me: { isAdmin: boolean } };
    expect(me.me.isAdmin).toBe(true);
  });

  test("duplicate name rejected", async () => {
    const res = await req("POST", "/api/auth/register", { name: "ruslan", password: "password123", invite: "secret-invite" });
    expect(res.status).toBe(400);
  });

  test("second user is not admin", async () => {
    const res = await req("POST", "/api/auth/register", { name: "Alex", password: "password123", invite: "secret-invite" });
    expect(res.status).toBe(201);
    playerCookie = setCookieOf(res);
    const me = (await res.json()) as { me: { isAdmin: boolean } };
    expect(me.me.isAdmin).toBe(false);
  });

  test("login with wrong password", async () => {
    const res = await req("POST", "/api/auth/login", { name: "Ruslan", password: "nope" });
    expect(res.status).toBe(401);
  });

  test("login works", async () => {
    const res = await req("POST", "/api/auth/login", { name: "ruslan", password: "password123" });
    expect(res.status).toBe(200);
    adminCookie = setCookieOf(res);
  });

  test("me without cookie is 401", async () => {
    expect((await req("GET", "/api/me")).status).toBe(401);
  });

  test("me with cookie works", async () => {
    const res = await req("GET", "/api/me", undefined, adminCookie);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { me: { name: string } };
    expect(body.me.name).toBe("Ruslan");
  });

  test("tampered cookie rejected", async () => {
    const res = await req("GET", "/api/me", undefined, adminCookie.slice(0, -2) + "xx");
    expect(res.status).toBe(401);
  });

  test("state exposes active season and players", async () => {
    const res = await req("GET", "/api/state", undefined, adminCookie);
    const body = (await res.json()) as {
      activeSeason: { name: string; runningGame: unknown };
      players: unknown[];
      seasons: unknown[];
      todayHasGame: boolean;
    };
    expect(body.activeSeason.name).toBe("Season 1");
    expect(body.players.length).toBe(2);
    expect(body.seasons.length).toBe(1);
    expect(body.activeSeason.runningGame).toBeNull();
    expect(body.todayHasGame).toBe(false);
  });
});

// --- Games: live tournament flow (admin only, one game per day) ---

describe("games: live tournament", () => {
  test("non-admin cannot start a game", async () => {
    const res = await req("POST", "/api/games", { participants: [1, 2] }, playerCookie);
    expect(res.status).toBe(403);
  });

  test("unauthenticated cannot start a game", async () => {
    const res = await req("POST", "/api/games", { participants: [1, 2] });
    expect(res.status).toBe(401);
  });

  test("needs at least 2 participants", async () => {
    const res = await req("POST", "/api/games", { participants: [1] }, adminCookie);
    expect(res.status).toBe(400);
  });

  test("admin starts tonight's game", async () => {
    const res = await req("POST", "/api/games", { participants: [1, 2], notes: "€10 buy-in" }, adminCookie);
    expect(res.status).toBe(201);
    const body = (await res.json()) as { gameId: number };
    expect(body.gameId).toBeGreaterThan(0);
  });

  test("only one game per day", async () => {
    const res = await req("POST", "/api/games", { participants: [1, 2] }, adminCookie);
    expect(res.status).toBe(409);
  });

  test("running game is visible to everyone", async () => {
    const res = await req("GET", "/api/state", undefined, playerCookie);
    const body = (await res.json()) as {
      activeSeason: { runningGame: { remaining: { name: string }[]; eliminated: unknown[]; totalPlayers: number } };
      todayHasGame: boolean;
    };
    expect(body.activeSeason.runningGame.remaining.length).toBe(2);
    expect(body.activeSeason.runningGame.eliminated.length).toBe(0);
    expect(body.activeSeason.runningGame.totalPlayers).toBe(2);
    expect(body.todayHasGame).toBe(true);
  });

  test("non-admin cannot eliminate", async () => {
    const res = await req("POST", "/api/games/1/eliminate", { playerId: 2 }, playerCookie);
    expect(res.status).toBe(403);
  });

  test("eliminating a player assigns the worst position and finishes the game", async () => {
    // 2 players: eliminating one leaves a single player → they win.
    const res = await req("POST", "/api/games/1/eliminate", { playerId: 2 }, adminCookie);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { finished: boolean; winnerId: number };
    expect(body.finished).toBe(true);
    expect(body.winnerId).toBe(1);
  });

  test("finished game has positions and points", async () => {
    const res = await req("GET", "/api/state", undefined, adminCookie);
    const body = (await res.json()) as {
      activeSeason: {
        runningGame: unknown;
        games: { results: { name: string; position: number; points: number }[] }[];
        standings: { player: { name: string }; points: number }[];
      };
    };
    expect(body.activeSeason.runningGame).toBeNull();
    expect(body.activeSeason.games.length).toBe(1);
    const results = body.activeSeason.games[0].results;
    expect(results.length).toBe(2);
    expect(results[0].name).toBe("Ruslan");
    expect(results[0].position).toBe(1);
    expect(results[0].points).toBe(100);
    expect(results[1].name).toBe("Alex");
    expect(results[1].position).toBe(2);
    expect(results[1].points).toBe(75);
    // standings
    expect(body.activeSeason.standings[0].player.name).toBe("Ruslan");
    expect(body.activeSeason.standings[0].points).toBe(100);
  });

  test("eliminating from a finished game is rejected", async () => {
    const res = await req("POST", "/api/games/1/eliminate", { playerId: 1 }, adminCookie);
    expect(res.status).toBe(400);
  });

  test("undo reopens a finished game", async () => {
    const res = await req("POST", "/api/games/1/undo", {}, adminCookie);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { reopened: boolean };
    expect(body.reopened).toBe(true);
    const state = await (await req("GET", "/api/state", undefined, adminCookie)).json() as {
      activeSeason: { runningGame: { remaining: unknown[] } | null; standings: unknown[]; games: unknown[] };
    };
    expect(state.activeSeason.runningGame).not.toBeNull();
    expect(state.activeSeason.runningGame!.remaining.length).toBe(1);
    expect(state.activeSeason.games.length).toBe(0); // nothing finished → excluded from history
    expect(state.activeSeason.standings.length).toBe(0); // running games don't count
  });

  test("undo restores the last eliminated player", async () => {
    const res = await req("POST", "/api/games/1/undo", {}, adminCookie);
    expect(res.status).toBe(200);
    const state = await (await req("GET", "/api/state", undefined, adminCookie)).json() as {
      activeSeason: { runningGame: { remaining: unknown[] } };
    };
    expect(state.activeSeason.runningGame.remaining.length).toBe(2);
  });

  test("nothing to undo when no eliminations", async () => {
    const res = await req("POST", "/api/games/1/undo", {}, adminCookie);
    expect(res.status).toBe(400);
  });

  test("three-player game: positions 3, 2, then winner", async () => {
    // Finish the current game first, then start a 3-player game on another date.
    await req("POST", "/api/games/1/eliminate", { playerId: 2 }, adminCookie);
    await req("DELETE", "/api/games/1", undefined, adminCookie);

    const third = await req("POST", "/api/auth/register", { name: "Vini", password: "password123", invite: "secret-invite" });
    expect(third.status).toBe(201);

    const start = await req("POST", "/api/games", { participants: [1, 2, 3], date: "2026-08-08" }, adminCookie);
    expect(start.status).toBe(201);
    const { gameId } = (await start.json()) as { gameId: number };

    const first = await req("POST", `/api/games/${gameId}/eliminate`, { playerId: 3 }, adminCookie);
    const firstBody = (await first.json()) as { finished: boolean; remaining: number };
    expect(firstBody.finished).toBe(false);
    expect(firstBody.remaining).toBe(2);

    const second = await req("POST", `/api/games/${gameId}/eliminate`, { playerId: 2 }, adminCookie);
    const secondBody = (await second.json()) as { finished: boolean; winnerId: number };
    expect(secondBody.finished).toBe(true);
    expect(secondBody.winnerId).toBe(1);

    const state = await (await req("GET", "/api/state", undefined, adminCookie)).json() as {
      activeSeason: {
        games: { results: { name: string; position: number; points: number }[] }[];
      };
    };
    const results = state.activeSeason.games[0].results;
    const byName = Object.fromEntries(results.map((r) => [r.name, r]));
    expect(byName["Vini"].position).toBe(3);
    expect(byName["Vini"].points).toBe(55);
    expect(byName["Alex"].position).toBe(2);
    expect(byName["Alex"].points).toBe(75);
    expect(byName["Ruslan"].position).toBe(1);
    expect(byName["Ruslan"].points).toBe(100);
  });

  test("non-admin cannot delete a game", async () => {
    const state = await (await req("GET", "/api/state", undefined, adminCookie)).json() as {
      activeSeason: { games: { id: number }[] };
    };
    const gameId = state.activeSeason.games[0].id;
    const res = await req("DELETE", `/api/games/${gameId}`, undefined, playerCookie);
    expect(res.status).toBe(403);
  });

  test("admin deletes a game and the day is free again", async () => {
    const state = await (await req("GET", "/api/state", undefined, adminCookie)).json() as {
      activeSeason: { games: { id: number }[] };
    };
    const gameId = state.activeSeason.games[0].id;
    const del = await req("DELETE", `/api/games/${gameId}`, undefined, adminCookie);
    expect(del.status).toBe(200);
    const after = await (await req("GET", "/api/state", undefined, adminCookie)).json() as {
      activeSeason: { games: unknown[]; standings: unknown[] };
      todayHasGame: boolean;
    };
    expect(after.activeSeason.games.length).toBe(0);
    expect(after.activeSeason.standings.length).toBe(0);
    expect(after.todayHasGame).toBe(false);
  });
});

// --- Static assets: cache-busting contract ---

describe("static assets", () => {
  test("index.html is never cached and carries versioned asset URLs", async () => {
    const res = await fetchHandler(new Request("http://test.local/"));
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    const html = await res.text();
    expect(html).toMatch(/\/app\.js\?v=[a-z0-9]+/);
    expect(html).toMatch(/\/style\.css\?v=[a-z0-9]+/);
    // placeholders must always be substituted
    expect(html).not.toContain("__V_APP__");
    expect(html).not.toContain("__V_CSS__");
  });

  test("versioned assets are immutable-cacheable and served", async () => {
    const js = await fetchHandler(new Request("http://test.local/app.js?v=abc123"));
    expect(js.status).toBe(200);
    expect(js.headers.get("cache-control")).toContain("immutable");
    expect((await js.text()).length).toBeGreaterThan(100);

    const css = await fetchHandler(new Request("http://test.local/style.css?v=abc123"));
    expect(css.status).toBe(200);
    expect(css.headers.get("cache-control")).toContain("immutable");
  });

  test("the same asset version is stable for identical content", async () => {
    const a = await (await fetchHandler(new Request("http://test.local/"))).text();
    const b = await (await fetchHandler(new Request("http://test.local/"))).text();
    const version = a.match(/\/app\.js\?v=([a-z0-9]+)/)![1];
    expect(b).toContain(`/app.js?v=${version}`);
  });

  test("unknown asset returns 404", async () => {
    const res = await fetchHandler(new Request("http://test.local/nope.js"));
    expect(res.status).toBe(404);
  });
});

// --- Seasons ---

describe("seasons", () => {
  test("non-admin cannot archive", async () => {
    const res = await req("POST", "/api/seasons/1/archive", {}, playerCookie);
    expect(res.status).toBe(403);
  });

  test("admin archives and new season auto-starts", async () => {
    const res = await req("POST", "/api/seasons/1/archive", {}, adminCookie);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { nextSeason: string };
    expect(body.nextSeason).toBe("Season 2");
    const state = await (await req("GET", "/api/state", undefined, adminCookie)).json() as {
      activeSeason: { name: string };
      seasons: { name: string; archived: boolean }[];
    };
    expect(state.activeSeason.name).toBe("Season 2");
    expect(state.seasons[0].name).toBe("Season 2"); // newest first
    expect(state.seasons[0].archived).toBe(false);
    expect(state.seasons[1].name).toBe("Season 1");
    expect(state.seasons[1].archived).toBe(true);
  });

  test("champion recorded for archived season", async () => {
    const res = await req("GET", "/api/season/1", undefined, adminCookie);
    const body = (await res.json()) as { champion: { name: string } | null };
    expect(body).toHaveProperty("champion");
  });

  test("admin cannot create second active season", async () => {
    const res = await req("POST", "/api/seasons", { name: "Bogus" }, adminCookie);
    expect(res.status).toBe(400);
  });
});
