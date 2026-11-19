/**
 * Funny character avatars — deterministic by nickname, no external services
 * (nothing leaves the server, no third-party API, works offline).
 *
 * 1. A nickname may contain a telling word ("ant" → 🐜, "king" → 👑, …).
 * 2. Otherwise a stable hash of the name picks a character from the list.
 *
 * Players may also pick a character themselves (stored in players.avatar).
 */

export const AVATARS = [
  "🤡", "👽", "🤖", "🐸", "🦧", "🐷", "🐙", "🦄", "🥔", "🍕",
  "👻", "🧟", "🧛", "🧙", "🦸", "🥸", "🤠", "🦆", "🐔", "🦥",
  "🦦", "🐹", "🐿️", "🦔", "🐊", "🦖", "🐳", "🦈", "🐡", "🦀",
  "🦞", "🐝", "🦋", "🕷️", "🐛", "🍄", "🌵", "🎃", "👺", "👹",
  "🐧", "🦉", "🐨", "🐼", "🦊", "🐺", "🐻", "🦁", "🐮", "🐵",
  "🐶", "🐱", "🐭", "🐰", "🦇", "🐲", "🦕", "🦩", "🦚", "🐲",
] as const;

/** A telling word in the nickname wins over the hash — more fun. */
const KEYWORDS: [string, string][] = [
  ["ant", "🐜"],
  ["vin", "🍷"],
  ["bon", "🍬"],
  ["lion", "🦁"],
  ["bear", "🐻"],
  ["wolf", "🐺"],
  ["fox", "🦊"],
  ["cat", "🐱"],
  ["dog", "🐶"],
  ["fish", "🐟"],
  ["king", "👑"],
  ["queen", "👸"],
  ["boss", "😎"],
  ["ninja", "🥷"],
  ["pirate", "🏴‍☠️"],
  ["bot", "🤖"],
  ["ghost", "👻"],
  ["star", "⭐"],
  ["moon", "🌙"],
  ["sun", "☀️"],
  ["fire", "🔥"],
  ["ice", "🧊"],
  ["ace", "🃏"],
  ["poker", "♠️"],
  ["chip", "🪙"],
  ["lucky", "🍀"],
  ["big", "🐘"],
  ["fast", "🐆"],
  ["slow", "🐢"],
  ["sleep", "😴"],
  ["pizza", "🍕"],
  ["potato", "🥔"],
  ["clown", "🤡"],
  ["monkey", "🐵"],
  ["duck", "🦆"],
  ["chick", "🐔"],
];

/** Stable non-negative hash of a string. */
function nameHash(name: string): number {
  let h = 0;
  for (let i = 0; i < name.length; i++) {
    h = (h * 31 + name.charCodeAt(i)) >>> 0;
  }
  return h;
}

/** Deterministic auto avatar for a nickname. */
export function autoAvatar(name: string): string {
  const n = name.toLowerCase();
  for (const [word, emoji] of KEYWORDS) {
    if (n.includes(word)) return emoji;
  }
  return AVATARS[nameHash(n) % AVATARS.length];
}

/** Explicit choice wins, otherwise the deterministic one. */
export function avatarFor(name: string, chosen: string | null | undefined): string {
  if (chosen && (AVATARS as readonly string[]).includes(chosen)) return chosen;
  return autoAvatar(name);
}

/** TRUE if a player may use this avatar (or null to reset to auto). */
export function isValidAvatar(value: unknown): value is string | null {
  return value === null || (typeof value === "string" && (AVATARS as readonly string[]).includes(value));
}
