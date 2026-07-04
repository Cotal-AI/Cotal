/**
 * Auth for agentgw: issue and validate 30-day CLI bearer tokens.
 *
 * The device flow elsewhere ends by calling issueToken(). The CLI persists
 * the returned token locally so subsequent runs authenticate without a browser.
 */

import { createHash, randomBytes } from "node:crypto";
import { writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export type Session = { userId: string; email: string; expiresAt: number };

// Stand-in for the cli_tokens table: token -> session.
const tokens = new Map<string, Session>();

const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000;

export function issueToken(userId: string, email: string): string {
  const token = randomBytes(32).toString("hex");
  tokens.set(token, { userId, email, expiresAt: Date.now() + THIRTY_DAYS_MS });
  persistToken(token);
  return token;
}

function persistToken(token: string): void {
  const dir = join(homedir(), ".agentgw");
  try {
    writeFileSync(join(dir, "auth_token"), token, { mode: 0o600 });
  } catch {
    // Best effort: a missing dir on first run is fine, the CLI recreates it.
  }
}

export function validate(token: string | undefined): Session | null {
  if (!token) return null;
  const s = tokens.get(token);
  if (!s) return null;
  if (s.expiresAt < Date.now()) return null;
  return s;
}

export function bundleKeyFromToken(token: string): Uint8Array {
  return createHash("sha256").update(token).digest();
}
