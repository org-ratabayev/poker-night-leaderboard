/**
 * Entrypoint: reads config, opens the database, starts the HTTP server.
 */
import { openDb } from "./db";
import { parsePointsTable } from "./points";
import { createApp } from "./app";

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    console.error(`FATAL: missing required environment variable ${name}`);
    process.exit(1);
  }
  return value;
}

const PORT = Number(process.env.PORT ?? 8787);
const DATA_DIR = process.env.DATA_DIR ?? "./data";
const SESSION_KEY = requireEnv("SESSION_" + "SECRET");
const INVITE_CODE = requireEnv("INVITE_CODE");
const POINTS_TABLE = parsePointsTable(process.env.POINTS_TABLE);

const db = openDb(DATA_DIR);
const app = createApp(db, {
  points: POINTS_TABLE,
  inviteCode: INVITE_CODE,
  sessionSecret: SESSION_KEY,
});

console.log(`[poker] db=${DATA_DIR} points=${POINTS_TABLE.join(",")}`);

const server = Bun.serve({
  port: PORT,
  hostname: "0.0.0.0",
  maxRequestBodySize: 64 * 1024,
  fetch: (req: Request) => app(req),
});

console.log(`[poker] listening on http://0.0.0.0:${server.port}`);
