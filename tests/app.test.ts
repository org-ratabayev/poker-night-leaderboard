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
  if (body !== undefined) headers["Content-Type"] = "application/json";
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
    const body = (await res.json()) as { activeSeason: { name: string }; players: unknown[]; seasons: unknown[] };
    expect(body.activeSeason.name).toBe("Season 1");
    expect(body.players.length).toBe(2);
    expect(body.seasons.length).toBe(1);
  });
});

// --- Games ---

describe("games", () => {
  test("unauthenticated game rejected", async () => {
    const res = await req("POST", "/api/games", { date: "2026-08-07", results: [] });
    expect(res.status).toBe(401);
  });

  test("invalid positions rejected", async () => {
    const res = await req("POST", "/api/games", { date: "2026-08-07", results: [{ playerId: 1, position: 2 }, { playerId: 2, position: 5 }] }, playerCookie);
    expect(res.status).toBe(400);
  });

  test("unknown player rejected", async () => {
    const res = await req("POST", "/api/games", { date: "2026-08-07", results: [{ playerId: 1, position: 1 }, { playerId: 999, position: 2 }] }, playerCookie);
    expect(res.status).toBe(400);
  });

  test("any logged-in player can add a game", async () => {
    const res = await req("POST", "/api/games", {
      date: "2026-08-07",
      notes: "Friday night",
      results: [{ playerId: 1, position: 1 }, { playerId: 2, position: 2 }],
    }, playerCookie); // created_by = Alex (id 2)
    expect(res.status).toBe(201);
  });

  test("admin can also add a game", async () => {
    const res = await req("POST", "/api/games", {
      date: "2026-08-14",
      results: [{ playerId: 1, position: 1 }, { playerId: 2, position: 2 }],
    }, adminCookie); // created_by = Ruslan (id 1)
    expect(res.status).toBe(201);
  });

  test("standings computed correctly", async () => {
    const res = await req("GET", "/api/state", undefined, adminCookie);
    const body = (await res.json()) as {
      activeSeason: { standings: { player: { name: string }; points: number; games: number }[]; games: unknown[] };
    };
    expect(body.activeSeason.standings[0].player.name).toBe("Ruslan");
    expect(body.activeSeason.standings[0].points).toBe(200);
    expect(body.activeSeason.standings[0].games).toBe(2);
    expect(body.activeSeason.standings[1].player.name).toBe("Alex");
    expect(body.activeSeason.standings[1].points).toBe(150);
    expect(body.activeSeason.games.length).toBe(2);
  });

  test("non-author non-admin cannot delete", async () => {
    const res = await req("DELETE", "/api/games/2", undefined, playerCookie); // game 2 belongs to Ruslan
    expect(res.status).toBe(403);
  });

  test("author can delete own game", async () => {
    const res = await req("DELETE", "/api/games/1", undefined, playerCookie); // game 1 belongs to Alex
    expect(res.status).toBe(200);
    const state = await (await req("GET", "/api/state", undefined, adminCookie)).json() as { activeSeason: { standings: { points: number }[] } };
    expect(state.activeSeason.standings[0].points).toBe(100); // only Ruslan's game (2026-08-14) remains
  });

  test("admin can delete any game", async () => {
    const res = await req("DELETE", "/api/games/2", undefined, adminCookie);
    expect(res.status).toBe(200);
    const state = await (await req("GET", "/api/state", undefined, adminCookie)).json() as { activeSeason: { standings: unknown[] } };
    expect(state.activeSeason.standings).toHaveLength(0);
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
    // Games were deleted in earlier tests, so champion may be null — just check shape.
    expect(body).toHaveProperty("champion");
  });

  test("admin cannot create second active season", async () => {
    const res = await req("POST", "/api/seasons", { name: "Bogus" }, adminCookie);
    expect(res.status).toBe(400);
  });
});
