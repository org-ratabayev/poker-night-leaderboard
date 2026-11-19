/**
 * App factory: builds the fetch handler for a given database + config.
 * Kept separate from server.ts so tests can instantiate isolated instances.
 */
import type { Database } from "bun:sqlite";
import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { openDb } from "./db";
import {
  error,
  handleArchiveSeason,
  handleCreateSeason,
  handleDeleteGame,
  handleEliminate,
  handleHealth,
  handleLogin,
  handleLogout,
  handleMe,
  handleRegister,
  handleRenamePlayer,
  handleSeason,
  handleSetAdmin,
  handleSetTheme,
  handleStartGame,
  handleState,
  handleUndo,
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

/** Short content hash — used to version asset URLs so caches can never go stale. */
function contentHash(body: Uint8Array): string {
  // Bun.hash returns number|bigint depending on the runtime version; toString
  // works for both (negative results are sanitised out for a URL-safe token).
  return Bun.hash(body).toString(36).replace("-", "").slice(0, 8);
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

  // Asset versions: proxies (Cloudflare) cache .js/.css aggressively and can
  // override origin cache headers, so the HTML points at versioned URLs.
  const appVersion = staticFiles.has("app.js") ? contentHash(staticFiles.get("app.js")!.body) : "0";
  const cssVersion = staticFiles.has("style.css") ? contentHash(staticFiles.get("style.css")!.body) : "0";

  function serveStatic(name: string): Response {
    const file = staticFiles.get(name);
    if (!file) return error("Not found", 404);
    // index.html must never be cached: it carries the asset versions.
    if (name === "index.html") {
      const html = new TextDecoder()
        .decode(file.body)
        .replaceAll("__V_APP__", appVersion)
        .replaceAll("__V_CSS__", cssVersion);
      return new Response(html, {
        headers: { "Content-Type": file.type, "Cache-Control": "no-store" },
      });
    }
    // Versioned asset URLs never change content → safe to cache hard.
    const immutable = name === "app.js" || name === "style.css";
    return new Response(file.body, {
      headers: {
        "Content-Type": file.type,
        "Cache-Control": immutable ? "public, max-age=31536000, immutable" : "no-store",
      },
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
      handler: (req) => handleStartGame(ctx, req),
    },
    {
      pattern: /^\/api\/games\/(\d+)\/eliminate$/,
      method: "POST",
      handler: (req, _url, m) => handleEliminate(ctx, req, Number(m[1])),
    },
    {
      pattern: /^\/api\/games\/(\d+)\/undo$/,
      method: "POST",
      handler: (req, _url, m) => handleUndo(ctx, req, Number(m[1])),
    },
    {
      pattern: /^\/api\/games\/(\d+)$/,
      method: "DELETE",
      handler: (req, _url, m) => handleDeleteGame(ctx, req, Number(m[1])),
    },
    { pattern: /^\/api\/seasons$/, method: "POST", handler: (req) => handleCreateSeason(ctx, req) },
    { pattern: /^\/api\/settings\/theme$/, method: "POST", handler: (req) => handleSetTheme(ctx, req) },
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
