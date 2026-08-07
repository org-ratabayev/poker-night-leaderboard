/**
 * Auth: argon2id password hashing (Bun.password), HMAC-SHA256 signed session
 * cookies (WebCrypto), per-IP login rate limiting.
 */
import type { Database } from "bun:sqlite";
import type { PlayerRow } from "./db";

export const SESSION_COOKIE = "pl_session";
const SESSION_TTL_SECONDS = 30 * 24 * 3600; // 30 days

export interface SessionPayload {
  uid: number;
  exp: number;
}

// --- Base64url helpers (RFC 4648, no padding) ---

function b64urlEncode(bytes: Uint8Array): string {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function b64urlDecode(str: string): Uint8Array {
  const b64 = str.replace(/-/g, "+").replace(/_/g, "/");
  const padded = b64 + "=".repeat((4 - (b64.length % 4)) % 4);
  const bin = atob(padded);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

function bytesToStr(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return s;
}

async function hmacSha256(secret: string, data: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(data));
  return b64urlEncode(new Uint8Array(sig));
}

function timingSafeEqualStr(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

// --- Passwords ---

export function hashPassword(plain: string): Promise<string> {
  return Bun.password.hash(plain); // argon2id by default
}

export function verifyPassword(plain: string, hash: string): Promise<boolean> {
  return Bun.password.verify(plain, hash);
}

// --- Session tokens ---

export async function signSession(secret: string, uid: number): Promise<string> {
  const payload: SessionPayload = {
    uid,
    exp: Math.floor(Date.now() / 1000) + SESSION_TTL_SECONDS,
  };
  const body = b64urlEncode(new TextEncoder().encode(JSON.stringify(payload)));
  const sig = await hmacSha256(secret, body);
  return `${body}.${sig}`;
}

export async function verifySession(
  secret: string,
  token: string | null | undefined,
): Promise<SessionPayload | null> {
  if (!token) return null;
  const dot = token.lastIndexOf(".");
  if (dot < 0) return null;
  const body = token.slice(0, dot);
  const sig = token.slice(dot + 1);
  const expected = await hmacSha256(secret, body);
  if (!timingSafeEqualStr(expected, sig)) return null;
  try {
    const payload = JSON.parse(bytesToStr(b64urlDecode(body))) as SessionPayload;
    if (typeof payload.uid !== "number" || typeof payload.exp !== "number") return null;
    if (payload.exp < Date.now() / 1000) return null;
    return payload;
  } catch {
    return null;
  }
}

// --- Cookies ---

export function setSessionCookie(token: string): string {
  const parts = [
    `${SESSION_COOKIE}=${token}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Lax",
    "Secure",
    `Max-Age=${SESSION_TTL_SECONDS}`,
  ];
  return parts.join("; ");
}

export function clearSessionCookie(): string {
  return `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Secure; Max-Age=0`;
}

export function readCookie(req: Request, name: string): string | null {
  const header = req.headers.get("cookie");
  if (!header) return null;
  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    if (eq < 0) continue;
    if (part.slice(0, eq).trim() === name) {
      return decodeURIComponent(part.slice(eq + 1).trim());
    }
  }
  return null;
}

// --- Resolve the authenticated player (if any) ---

export async function loadCurrentPlayer(
  db: Database,
  secret: string,
  req: Request,
): Promise<PlayerRow | null> {
  const token = readCookie(req, SESSION_COOKIE);
  const payload = await verifySession(secret, token);
  if (!payload) return null;
  const row = db
    .query("SELECT * FROM players WHERE id = ?")
    .get(payload.uid) as PlayerRow | null;
  return row ?? null;
}

// --- Rate limiting (in-memory, per IP) ---

const LOGIN_WINDOW_MS = 5 * 60 * 1000;
const LOGIN_MAX_ATTEMPTS = 10;

const attempts = new Map<string, { count: number; resetAt: number }>();

export function rateLimited(ip: string): boolean {
  const now = Date.now();
  const entry = attempts.get(ip);
  if (!entry || entry.resetAt < now) {
    attempts.set(ip, { count: 1, resetAt: now + LOGIN_WINDOW_MS });
    return false;
  }
  entry.count += 1;
  return entry.count > LOGIN_MAX_ATTEMPTS;
}

export function resetRateLimit(ip: string): void {
  attempts.delete(ip);
}

export function clientIp(req: Request): string {
  // cloudflared appends CF-Connecting-IP; fall back to the socket address.
  return req.headers.get("cf-connecting-ip") ?? req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? "unknown";
}

// --- Constant-time invite code comparison ---

export function inviteMatches(invite: string | undefined, expected: string): boolean {
  if (!invite) return false;
  return timingSafeEqualStr(invite.trim(), expected.trim());
}
