/**
 * API tests. Spin up an isolated app instance per test file run using a
 * temp data dir, then exercise it through real HTTP Requests.
 */
import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb } from "../src/db";
import { parsePointsTable, pointsForPosition, formulaPoints, DEFAULT_POINTS_TABLE } from "../src/points";
import { seasonalTheme } from "../src/routes";
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
let evaCookie = "";
let gameBId = 0;

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

  test("formula scoring: 1st always 100, last gets 100/N", () => {
    expect(formulaPoints(2, 1)).toBe(100);
    expect(formulaPoints(2, 2)).toBe(50);
    expect(formulaPoints(3, 2)).toBe(67);
    expect(formulaPoints(4, 4)).toBe(25);
    expect(formulaPoints(6, 1)).toBe(100);
    expect(formulaPoints(6, 6)).toBe(17);
    expect(formulaPoints(6, 0)).toBe(0);
    expect(formulaPoints(6, 7)).toBe(0);
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
    expect(results[1].points).toBe(50); // formula: 2 players → last gets 100/2
    // standings include the 50-point starting bank
    expect(body.activeSeason.standings[0].player.name).toBe("Ruslan");
    expect(body.activeSeason.standings[0].points).toBe(150);
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
    // running games don't count: everybody is back to the 50-point bank
    expect(state.activeSeason.standings.every((r) => r.points === 50)).toBe(true);
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
    expect(byName["Vini"].points).toBe(33); // formula: 3 players → 100/3
    expect(byName["Alex"].position).toBe(2);
    expect(byName["Alex"].points).toBe(67);
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
    expect(after.activeSeason.standings.every((r) => r.points === 50)).toBe(true); // bank only
    expect(after.todayHasGame).toBe(false);
  });
});

// --- Bets: hidden until the lock, parimutuel payouts, admin = regular player ---

describe("betting", () => {
  test("setup: 4-player game builds season points", async () => {
    const eva = await req("POST", "/api/auth/register", { name: "Eva", password: "password123", invite: "secret-invite" });
    expect(eva.status).toBe(201);
    evaCookie = setCookieOf(eva);

    const start = await req("POST", "/api/games", { participants: [1, 2, 3, 4], date: "2026-08-10" }, adminCookie);
    expect(start.status).toBe(201);
    const { gameId } = (await start.json()) as { gameId: number };

    for (const p of [4, 3, 2]) {
      await req("POST", `/api/games/${gameId}/eliminate`, { playerId: p }, adminCookie);
    }
    const state = await (await req("GET", "/api/state", undefined, adminCookie)).json() as {
      activeSeason: { standings: { player: { name: string }; points: number }[] };
    };
    const byName = Object.fromEntries(state.activeSeason.standings.map((r) => [r.player.name, r.points]));
    // game points + 50-point starting bank
    expect(byName["Ruslan"]).toBe(150);
    expect(byName["Alex"]).toBe(125);
    expect(byName["Vini"]).toBe(100);
    expect(byName["Eva"]).toBe(75);
  });

  test("game B starts with two participants", async () => {
    const res = await req("POST", "/api/games", { participants: [2, 3], date: "2026-08-11" }, adminCookie);
    expect(res.status).toBe(201);
    gameBId = ((await res.json()) as { gameId: number }).gameId;
  });

  test("a player can bet on themselves", async () => {
    // Alex (2) is playing and backs himself — allowed (it only rewards winning).
    const res = await req("POST", `/api/games/${gameBId}/bets`, { onPlayerId: 2, stake: 30 }, playerCookie);
    expect(res.status).toBe(201);
  });

  test("unauthenticated cannot bet", async () => {
    const res = await req("POST", `/api/games/${gameBId}/bets`, { onPlayerId: 2, stake: 10 });
    expect(res.status).toBe(401);
  });

  test("stake limits are enforced", async () => {
    expect((await req("POST", `/api/games/${gameBId}/bets`, { onPlayerId: 2, stake: 2 }, adminCookie)).status).toBe(400);
    expect((await req("POST", `/api/games/${gameBId}/bets`, { onPlayerId: 2, stake: 101 }, adminCookie)).status).toBe(400);
  });

  test("can only bet on a player in the game", async () => {
    // Ruslan (1) is not in game B
    const res = await req("POST", `/api/games/${gameBId}/bets`, { onPlayerId: 1, stake: 10 }, adminCookie);
    expect(res.status).toBe(400);
  });

  test("everyone bets — spectators, the admin and players in the game", async () => {
    // Ruslan (admin, not playing) backs Alex; Eva backs Vini. Alex already
    // backed himself above.
    const a = await req("POST", `/api/games/${gameBId}/bets`, { onPlayerId: 2, stake: 30 }, adminCookie);
    expect(a.status).toBe(201);
    const b = await req("POST", `/api/games/${gameBId}/bets`, { onPlayerId: 3, stake: 30 }, evaCookie);
    expect(b.status).toBe(201);
  });

  test("stake cannot exceed the bettor's balance", async () => {
    // Eva has 75 pts and already committed 30 → 45 available, 50 is too much.
    const res = await req("POST", `/api/games/${gameBId}/bets`, { onPlayerId: 2, stake: 50 }, evaCookie);
    expect(res.status).toBe(400);
  });

  test("bets are hidden from everyone before the lock", async () => {
    const asDirector = await (await req("GET", "/api/state", undefined, adminCookie)).json() as {
      activeSeason: { runningGame: { bets: { locked: boolean; all: unknown[] | null; mine: unknown[] } } };
    };
    expect(asDirector.activeSeason.runningGame.bets.locked).toBe(false);
    expect(asDirector.activeSeason.runningGame.bets.all).toBeNull();
    expect(asDirector.activeSeason.runningGame.bets.mine.length).toBe(1); // only my own bets

    // A participant sees only their own bet, never anybody else's
    const asPlayer = await (await req("GET", "/api/state", undefined, playerCookie)).json() as {
      activeSeason: { runningGame: { bets: { all: unknown[] | null; mine: unknown[] } } };
    };
    expect(asPlayer.activeSeason.runningGame.bets.all).toBeNull();
    expect(asPlayer.activeSeason.runningGame.bets.mine.length).toBe(1);
  });

  test("first elimination locks betting and reveals all bets", async () => {
    const res = await req("POST", `/api/games/${gameBId}/eliminate`, { playerId: 3 }, adminCookie);
    const body = (await res.json()) as { finished: boolean; winnerId: number };
    expect(body.finished).toBe(true);
    expect(body.winnerId).toBe(2); // Alex won

    // betting is closed now
    const late = await req("POST", `/api/games/${gameBId}/bets`, { onPlayerId: 2, stake: 5 }, evaCookie);
    expect([400, 409]).toContain(late.status);

    const state = await (await req("GET", "/api/state", undefined, adminCookie)).json() as {
      activeSeason: { games: { id: number; bets: { bettorName: string; onName: string; stake: number; payout: number }[] }[] };
    };
    const game = state.activeSeason.games.find((g) => g.id === gameBId)!;
    const byBettor = Object.fromEntries(game.bets.map((b) => [b.bettorName, b]));
    // Parimutuel: pool = 30 (Ruslan) + 30 (Eva) + 30 (Alex on himself) = 90.
    // The winner (Alex) was backed with 60 → Ruslan 45, Alex 45, Eva 0.
    expect(game.bets.length).toBe(3);
    expect(byBettor["Ruslan"].payout).toBe(45);
    expect(byBettor["Eva"].payout).toBe(0);
    expect(byBettor["Alex"].payout).toBe(45);
  });

  test("betting P/L is reflected in the standings", async () => {
    const state = await (await req("GET", "/api/state", undefined, adminCookie)).json() as {
      activeSeason: { standings: { player: { name: string }; points: number; bets: number }[] };
    };
    const byName = Object.fromEntries(state.activeSeason.standings.map((r) => [r.player.name, r]));
    // bank 50 + game points + bet P/L
    expect(byName["Ruslan"].points).toBe(165); // 50 + 100 + 15
    expect(byName["Ruslan"].bets).toBe(1);
    expect(byName["Alex"].points).toBe(240); // 50 + 75 + 100 + 15
    expect(byName["Vini"].points).toBe(150); // 50 + 50 + 50
    expect(byName["Eva"].points).toBe(45); // 50 + 25 − 30
    expect(state.activeSeason.standings[0].player.name).toBe("Alex");
  });

  test("stakes are refunded when nobody backed the winner", async () => {
    const start = await req("POST", "/api/games", { participants: [1, 2], date: "2026-08-12" }, adminCookie);
    expect(start.status).toBe(201);
    const { gameId } = (await start.json()) as { gameId: number };

    // Eva has 5 pts → bets 5 on Alex; Ruslan (playing) wins.
    const bet = await req("POST", `/api/games/${gameId}/bets`, { onPlayerId: 2, stake: 5 }, evaCookie);
    expect(bet.status).toBe(201);

    await req("POST", `/api/games/${gameId}/eliminate`, { playerId: 2 }, adminCookie);

    const state = await (await req("GET", "/api/state", undefined, adminCookie)).json() as {
      activeSeason: { games: { id: number; bets: { bettorName: string; stake: number; payout: number }[] }[] };
    };
    const game = state.activeSeason.games.find((g) => g.id === gameId)!;
    expect(game.bets[0].payout).toBe(game.bets[0].stake); // refunded
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

// --- Theme (site-wide setting + seasonal default) ---

describe("theme", () => {
  test("seasonal default: December = christmas, other months = default", () => {
    expect(seasonalTheme(new Date("2026-12-15T12:00:00Z"))).toBe("christmas");
    expect(seasonalTheme(new Date("2026-08-15T12:00:00Z"))).toBe("default");
    expect(seasonalTheme(new Date("2026-01-01T00:00:00Z"))).toBe("default");
  });

  test("state exposes the resolved theme and the raw setting", async () => {
    const res = await req("GET", "/api/state", undefined, adminCookie);
    const body = (await res.json()) as { siteTheme: string; siteThemeSetting: string };
    expect(["default", "christmas"]).toContain(body.siteTheme);
    expect(body.siteThemeSetting).toBe("auto");
  });

  test("non-admin cannot change the site theme", async () => {
    const res = await req("POST", "/api/settings/theme", { theme: "christmas" }, playerCookie);
    expect(res.status).toBe(403);
  });

  test("admin sets the Christmas theme for everyone", async () => {
    const res = await req("POST", "/api/settings/theme", { theme: "christmas" }, adminCookie);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { siteTheme: string };
    expect(body.siteTheme).toBe("christmas");
    const state = await (await req("GET", "/api/state", undefined, playerCookie)).json() as {
      siteTheme: string;
      siteThemeSetting: string;
    };
    expect(state.siteTheme).toBe("christmas");
    expect(state.siteThemeSetting).toBe("christmas");
  });

  test("admin resets to auto (seasonal)", async () => {
    const res = await req("POST", "/api/settings/theme", { theme: "auto" }, adminCookie);
    expect(res.status).toBe(200);
    const state = await (await req("GET", "/api/state", undefined, adminCookie)).json() as {
      siteThemeSetting: string;
    };
    expect(state.siteThemeSetting).toBe("auto");
  });

  test("invalid theme rejected", async () => {
    const res = await req("POST", "/api/settings/theme", { theme: "halloween" }, adminCookie);
    expect(res.status).toBe(400);
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
