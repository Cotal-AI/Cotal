/**
 * Linear accounts: one named, explicit upstream identity per entry. An account fixes the mode
 * (`write` → `/mcp`, `readonly` → `/mcp/readonly`) and its credential, sent as
 * `Authorization: Bearer`, which the Linear MCP docs accept for API keys and OAuth tokens alike.
 * `token` accounts read a Linear API key (or an access token obtained elsewhere) from a private
 * file at use. `oauth` accounts hold the state of `cotal linear account login` (see `oauth.ts`).
 * Credentials never come from argv or the environment, are never logged, and are only sent to the
 * pinned Linear MCP origin.
 *
 * Layout under the cotal machine home: `linear/<name>.json` (0600, no secret), plus
 * `linear/<name>.token` when `--token-stdin` stored the token, or `linear/<name>.oauth.json` for an
 * OAuth login. All 0600.
 */
import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { mkSecretDir, writeSecretFileAtomic } from "@cotal-ai/core";
import { homeCotalDir } from "@cotal-ai/workspace";
import { isLinearMode, type LinearMode } from "./origin.js";

export type LinearAccount =
  | { name: string; mode: LinearMode; auth: "token"; /** Absolute path of the 0600 file holding the bearer. */ tokenFile: string }
  | { name: string; mode: LinearMode; auth: "oauth" };

const NAME = /^[a-z0-9][a-z0-9-]{0,31}$/;

export function assertAccountName(name: string): void {
  if (!NAME.test(name)) throw new Error(`account name "${name}" must match ${NAME.source}`);
}

export function linearDir(): string {
  return join(homeCotalDir(), "linear");
}

export function oauthStatePath(name: string): string {
  assertAccountName(name);
  return join(linearDir(), `${name}.oauth.json`);
}

function accountPath(name: string): string {
  assertAccountName(name);
  return join(linearDir(), `${name}.json`);
}

export function storedTokenPath(name: string): string {
  assertAccountName(name);
  return join(linearDir(), `${name}.token`);
}

/** Refuse a credential file that another user could read or that is not a regular file. */
export function assertPrivateFile(path: string): void {
  const st = statSync(path);
  if (!st.isFile()) throw new Error(`${path} is not a regular file`);
  if ((st.mode & 0o077) !== 0) throw new Error(`${path} is readable by other users (mode ${(st.mode & 0o777).toString(8)}); chmod 600 it`);
}

export function saveAccount(account: LinearAccount, token?: string): void {
  assertAccountName(account.name);
  if (!isLinearMode(account.mode)) throw new Error(`mode must be "write" or "readonly"`);
  mkSecretDir(linearDir());
  if (account.auth === "token") {
    if (token !== undefined) {
      const trimmed = token.trim();
      if (!trimmed || /\s/.test(trimmed)) throw new Error("the token must be one non-empty line");
      writeSecretFileAtomic(account.tokenFile, `${trimmed}\n`);
    }
    assertPrivateFile(account.tokenFile);
  } else if (token !== undefined) throw new Error("an oauth account takes no token");
  writeSecretFileAtomic(accountPath(account.name), `${JSON.stringify(account, null, 2)}\n`);
}

export function loadAccount(name: string): LinearAccount {
  const path = accountPath(name);
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, "utf8"));
  } catch (e) {
    throw new Error(`no Linear account "${name}" (${path}): ${(e as Error).message}. Add one with \`cotal linear account add\``);
  }
  const a = raw as { name?: unknown; mode?: unknown; auth?: unknown; tokenFile?: unknown };
  if (a.name !== name || !isLinearMode(a.mode)) throw new Error(`${path} is not a valid Linear account record`);
  if (a.auth === "token" && typeof a.tokenFile === "string") return { name, mode: a.mode, auth: "token", tokenFile: a.tokenFile };
  if (a.auth === "oauth") return { name, mode: a.mode, auth: "oauth" };
  throw new Error(`${path} is not a valid Linear account record`);
}

/** Read the bearer fresh each time, so a rotated token file is picked up without a restart. */
export function readAccountToken(account: Extract<LinearAccount, { auth: "token" }>): string {
  assertPrivateFile(account.tokenFile);
  const token = readFileSync(account.tokenFile, "utf8").trim();
  if (!token || /\s/.test(token)) throw new Error(`${account.tokenFile} must hold one non-empty token line`);
  return token;
}
