/**
 * Linear accounts: one named, explicit upstream identity per entry. An account fixes the mode
 * (`write` → `/mcp`, `readonly` → `/mcp/readonly`) and where its credential lives. The credential is
 * a Linear API key or OAuth access token sent as `Authorization: Bearer`, which the Linear MCP docs
 * accept for both. It is read from a private file at use and never taken from argv or the
 * environment, never logged, and never sent anywhere except the pinned Linear MCP origin.
 *
 * Layout under the cotal machine home: `linear/<name>.json` (0600, no secret) and, when the token
 * was stored by `cotal linear account add --token-stdin`, `linear/<name>.token` (0600).
 */
import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { mkSecretDir, writeSecretFileAtomic } from "@cotal-ai/core";
import { homeCotalDir } from "@cotal-ai/workspace";
import { isLinearMode, type LinearMode } from "./origin.js";

export interface LinearAccount {
  name: string;
  mode: LinearMode;
  /** Absolute path of the 0600 file holding the bearer. */
  tokenFile: string;
}

const NAME = /^[a-z0-9][a-z0-9-]{0,31}$/;

export function assertAccountName(name: string): void {
  if (!NAME.test(name)) throw new Error(`account name "${name}" must match ${NAME.source}`);
}

export function linearDir(): string {
  return join(homeCotalDir(), "linear");
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
function assertPrivateFile(path: string): void {
  const st = statSync(path);
  if (!st.isFile()) throw new Error(`${path} is not a regular file`);
  if ((st.mode & 0o077) !== 0) throw new Error(`${path} is readable by other users (mode ${(st.mode & 0o777).toString(8)}); chmod 600 it`);
}

export function saveAccount(account: LinearAccount, token?: string): void {
  assertAccountName(account.name);
  if (!isLinearMode(account.mode)) throw new Error(`mode must be "write" or "readonly"`);
  mkSecretDir(linearDir());
  if (token !== undefined) {
    const trimmed = token.trim();
    if (!trimmed || /\s/.test(trimmed)) throw new Error("the token must be one non-empty line");
    writeSecretFileAtomic(account.tokenFile, `${trimmed}\n`);
  }
  assertPrivateFile(account.tokenFile);
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
  const a = raw as Partial<LinearAccount>;
  if (a.name !== name || !isLinearMode(a.mode) || typeof a.tokenFile !== "string")
    throw new Error(`${path} is not a valid Linear account record`);
  return { name, mode: a.mode, tokenFile: a.tokenFile };
}

/** Read the bearer fresh each time, so a rotated token file is picked up without a restart. */
export function readAccountToken(account: LinearAccount): string {
  assertPrivateFile(account.tokenFile);
  const token = readFileSync(account.tokenFile, "utf8").trim();
  if (!token || /\s/.test(token)) throw new Error(`${account.tokenFile} must hold one non-empty token line`);
  return token;
}
