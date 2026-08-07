/**
 * App factory: builds the fetch handler for a given database + config.
 * Kept separate from server.ts so tests can instantiate isolated instances.
 */
import type { Database } from "bun:sqlite";
import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { loadCurrentPlayer } from "./auth";
import { openDb } from "./db";
import {
  error,
  handleArchiveSeason,
  handleCreateGame,
  handleCreateSeason,
  handleDeleteGame,
  handleHealth,
  handleLogin,
  handleLogout,
  handleMe,
  handleRegister,
  handleRenamePlayer,
  handleSeason,
  handleSetAdmin,
  handleState,
  type AuthedCtx,
  type Ctx,
} from "./routes";

export interface AppConfig {
  points: number[];
  inviteCode: string;
  sessionSecret: string;
}

// --- Static files (loaded into memory at boot; tiny and cacheable) ---

const STATIC_DIR = join(import.meta.dir, "..", "static");
const CONTENT_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".svg": "image/svg+xml",
};

function loadStatic(): Map<string, { body: Uint8Array; type: string }> {
  const files = new Map<string, { body: Uint8Array; type: string }>();
  for (const name of ["index.html", "style.css", "app.js", "favicon.svg"]) {
    try {
      const path = join(STATIC_DIR, name);
      if (!statSync(path).isFile()) continue;
      const ext = name.slice(name.lastIndexOf("."));
      files.set(name, {
        body: readFileSync(path),
        type: CONTENT_TYPES[ext] ?? "application/octet-stream",
      });
    } catch {
      console.warn(`[poker] static file missing: ${name}`);
    }
  }
  return files;
}

// --- Request plumbing ---

function originAllowed(req: Request, url: URL): boolean {
  const origin = req.headers.get("origin");
  if (!origin) return true; // non-browser clients (curl, tests) are fine
  try {
    return new URL(origin).host === url.host;
  } catch {
    return false;
  }
}

export function createApp(db: Database, config: AppConfig): (req: Request) => Promise<Response> {
  const ctx: Ctx = { db, points: config.points, inviteCode: config.inviteCode, sessionSecret: config.sessionSecret };
  const staticFiles = loadStatic();

  async function authed(req: Request): Promise<AuthedCtx | Response> {
    const user = await loadCurrentPlayer(ctx.db, ctx.sessionSecret, req);
    if (!user) return error("Not logged in", 401);
    return { ...ctx, user };
  }

  function serveStatic(name: string): Response {
    const file = staticFiles.get(name);
    if (!file) return error("Not found", 404);
    return new Response(file.body, {
      headers: { "Content-Type": file.type, "Cache-Control": "no-cache" },
    });
  }

  const apiRoutes: Array<{
    pattern: RegExp;
    method: string;
    handler: (req: Request, url: URL, match: RegExpMatchArray) => Promise<Response>;
  }> = [
    { pattern: /^\/api\/health$/, method: "GET", handler: () => handleHealth() },
    { pattern: /^\/api\/state$/, method: "GET", handler: (req) => handleState(ctx, req) },
    { pattern: /^\/api\/season\/(\d+)$/, method: "GET", handler: (req, _url, m) => handleSeason(ctx, req, Number(m[1])) },
    { pattern: /^\/api\/me$/, method: "GET", handler: (req) => handleMe(ctx, req) },
    { pattern: /^\/api\/auth\/register$/, method: "POST", handler: (req) => handleRegister(ctx, req) },
    { pattern: /^\/api\/auth\/login$/, method: "POST", handler: (req) => handleLogin(ctx, req) },
    { pattern: /^\/api\/auth\/logout$/, method: "POST", handler: () => handleLogout() },
    {
      pattern: /^\/api\/games$/,
      method: "POST",
      handler: async (req) => {
        const a = await authed(req);
        if (a instanceof Response) return a;
        return handleCreateGame(a, req);
      },
    },
    {
      pattern: /^\/api\/games\/(\d+)$/,
      method: "DELETE",
      handler: async (req, _url, m) => {
        const a = await authed(req);
        if (a instanceof Response) return a;
        return handleDeleteGame(a, Number(m[1]));
      },
    },
    { pattern: /^\/api\/seasons$/, method: "POST", handler: (req) => handleCreateSeason(ctx, req) },
    { pattern: /^\/api\/seasons\/(\d+)\/archive$/, method: "POST", handler: (req, _url, m) => handleArchiveSeason(ctx, req, Number(m[1])) },
    { pattern: /^\/api\/players\/(\d+)\/rename$/, method: "POST", handler: (req, _url, m) => handleRenamePlayer(ctx, req, Number(m[1])) },
    { pattern: /^\/api\/players\/(\d+)\/admin$/, method: "POST", handler: (req, _url, m) => handleSetAdmin(ctx, req, Number(m[1])) },
  ];

  return async function fetchHandler(req: Request): Promise<Response> {
    const url = new URL(req.url);

    if (req.method === "GET") {
      if (url.pathname === "/") return serveStatic("index.html");
      if (url.pathname === "/style.css") return serveStatic("style.css");
      if (url.pathname === "/app.js") return serveStatic("app.js");
      if (url.pathname === "/favicon.svg") return serveStatic("favicon.svg");
    }

    if (url.pathname.startsWith("/api/")) {
      if (!["GET", "HEAD", "OPTIONS"].includes(req.method) && !originAllowed(req, url)) {
        return error("Cross-origin request rejected", 403);
      }
      for (const route of apiRoutes) {
        const match = url.pathname.match(route.pattern);
        if (match && route.method === req.method) {
          try {
            return await route.handler(req, url, match);
          } catch (err) {
            console.error("[poker] route error:", err);
            return error("Internal server error", 500);
          }
        }
      }
      return error("Not found", 404);
    }

    return error("Not found", 404);
  };
}
