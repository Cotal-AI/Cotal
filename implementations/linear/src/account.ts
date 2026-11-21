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
import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { mkSecretDir, writeSecretFileAtomic } from "@cotal-ai/core";
import { homeCotalDir } from "@cotal-ai/workspace";
import { isLinearMode, type LinearMode } from "./origin.js";

export type LinearAccount = { allowedTools?: string[] } & (
  | { name: string; mode: LinearMode; auth: "token"; /** Absolute path of the 0600 file holding the bearer. */ tokenFile: string }
  | { name: string; mode: LinearMode; auth: "oauth" }
);

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

/** Refuse a credential file that another user could read or that is not a regular file. POSIX mode
 *  bits do not map onto Windows ACLs (every file reads as 666 there), so the mode check applies where
 *  the concept exists; on win32 a secret's privacy is the ACL `writeSecretFileAtomic` sets at write. */
export function assertPrivateFile(path: string): void {
  const st = statSync(path);
  if (!st.isFile()) throw new Error(`${path} is not a regular file`);
  if (process.platform !== "win32" && (st.mode & 0o077) !== 0) throw new Error(`${path} is readable by other users (mode ${(st.mode & 0o777).toString(8)}); chmod 600 it`);
}

function allowedTools(value: unknown): string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.some(name => typeof name !== "string" || !name.length || name.trim() !== name || /[\u0000-\u001f\u007f]/u.test(name)) || new Set(value).size !== value.length)
    throw new Error("allowedTools must be an array of distinct nonempty tool names without surrounding whitespace or terminal controls");
  return [...value] as string[];
}

export class AccountRecordError extends Error {
  constructor(readonly path: string, reason: string) {
    super(`${path}: ${reason}. Repair this record while preserving the intended allowedTools policy, then repeat the account add or login`);
  }
}

/** Validate an existing record before any credential replacement or OAuth authorization. */
export function assertAccountWritable(name: string): void {
  if (existsSync(accountPath(name))) loadAccount(name);
}

export function saveAccount(account: LinearAccount, token?: string): void {
  assertAccountName(account.name);
  assertAccountWritable(account.name);
  const tools = allowedTools(account.allowedTools) ?? (existsSync(accountPath(account.name)) ? loadAccount(account.name).allowedTools : undefined);
  const saved = { ...account, ...(tools === undefined ? {} : { allowedTools: tools }) };
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
  writeSecretFileAtomic(accountPath(account.name), `${JSON.stringify(saved, null, 2)}\n`);
}

export function loadAccount(name: string): LinearAccount {
  const path = accountPath(name);
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, "utf8"));
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT")
      throw new Error(`no Linear account "${name}" (${path}); add one with \`cotal linear account add\``, { cause: e });
    throw new AccountRecordError(path, e instanceof SyntaxError ? "invalid JSON in account record" : "account record cannot be read");
  }
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) throw new AccountRecordError(path, "account record must be an object");
  const a = raw as { name?: unknown; mode?: unknown; auth?: unknown; tokenFile?: unknown; allowedTools?: unknown };
  if (a.name !== name || !isLinearMode(a.mode)) throw new AccountRecordError(path, "invalid name or mode in account record");
  let tools: string[] | undefined;
  try { tools = allowedTools(a.allowedTools); }
  catch { throw new AccountRecordError(path, "allowedTools must be an array of distinct nonempty tool names without surrounding whitespace or terminal controls"); }
  const policy = tools === undefined ? {} : { allowedTools: tools };
  if (a.auth === "token" && typeof a.tokenFile === "string") return { name, mode: a.mode, auth: "token", tokenFile: a.tokenFile, ...policy };
  if (a.auth === "oauth") return { name, mode: a.mode, auth: "oauth", ...policy };
  throw new AccountRecordError(path, "invalid authentication fields in account record");
}

/** Whether a {@link loadAccount} failure means no record exists under that name. */
export function accountMissing(error: unknown): boolean {
  return error instanceof Error && (error.cause as NodeJS.ErrnoException | undefined)?.code === "ENOENT";
}

/** Read the bearer fresh each time, so a rotated token file is picked up without a restart. */
export function readAccountToken(account: Extract<LinearAccount, { auth: "token" }>): string {
  assertPrivateFile(account.tokenFile);
  const token = readFileSync(account.tokenFile, "utf8").trim();
  if (!token || /\s/.test(token)) throw new Error(`${account.tokenFile} must hold one non-empty token line`);
  return token;
}
