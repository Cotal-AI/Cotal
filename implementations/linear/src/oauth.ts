/**
 * OAuth for a Linear MCP account, through the MCP SDK's client: dynamic client registration and an
 * authorization-code grant with PKCE, against the authorization server the pinned Linear MCP origin
 * advertises. `cotal linear account login` runs it once on a loopback redirect and prints only the
 * authorize URL. Refresh happens before a request is sent, never by re-sending a refused request.
 *
 * Every OAuth request goes to `https://mcp.linear.app` (any path), with no redirects followed and a
 * bounded body. If Linear moves its authorization server to another origin, login refuses and
 * names that origin rather than following it.
 *
 * State (client registration, tokens, the PKCE verifier) lives in one 0600 file per account.
 */
import { randomBytes } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { auth, type OAuthClientProvider } from "@modelcontextprotocol/sdk/client/auth.js";
import type { OAuthClientInformationMixed, OAuthClientMetadata, OAuthTokens } from "@modelcontextprotocol/sdk/shared/auth.js";
import type { FetchLike } from "@modelcontextprotocol/sdk/shared/transport.js";
import { mkSecretDir, writeSecretFileAtomic } from "@cotal-ai/core";
import { assertPrivateFile, linearDir, oauthStatePath, readAccountToken, saveAccount, type LinearAccount } from "./account.js";
import { LINEAR_MCP_ORIGIN, linearMcpUrl, OriginRefusedError, ResponseTooLargeError, type LinearMode } from "./origin.js";

/** How an upstream session gets its bearer. `prepare` runs before discovery and before dispatch. */
export interface LinearCredential {
  bearer(): string;
  prepare(): Promise<void>;
}

interface OAuthState {
  client?: OAuthClientInformationMixed;
  tokens?: OAuthTokens;
  /** Epoch ms when `tokens` arrived; `expires_in` counts from here. */
  obtainedAt?: number;
  codeVerifier?: string;
}

const MAX_OAUTH_BODY = 64 * 1024;
const LOGIN_TIMEOUT_MS = 5 * 60_000;
/** Refresh this long before the access token expires. */
const REFRESH_MARGIN_MS = 60_000;

export function scopeFor(mode: LinearMode): string {
  return mode === "readonly" ? "read" : "read write";
}

/** OAuth traffic only reaches the Linear MCP origin, never follows a redirect, and is bounded. */
const oauthFetch: FetchLike = async (url, init) => {
  const target = new URL(typeof url === "string" ? url : url.href);
  if (target.origin !== LINEAR_MCP_ORIGIN) throw new OriginRefusedError(`refusing an OAuth request to ${target.origin}: only ${LINEAR_MCP_ORIGIN} is allowed`);
  const res = await fetch(target, { ...init, redirect: "manual" });
  if (res.type === "opaqueredirect" || (res.status >= 300 && res.status < 400)) {
    await res.body?.cancel().catch(() => {});
    throw new OriginRefusedError(`refusing a ${res.status} redirect from ${target.origin}${target.pathname}`);
  }
  return new Response(await boundedBody(res), { status: res.status, statusText: res.statusText, headers: res.headers });
};

async function boundedBody(res: Response): Promise<Uint8Array> {
  const declared = res.headers.get("content-length");
  if (declared !== null && Number(declared) > MAX_OAUTH_BODY) {
    await res.body?.cancel().catch(() => {});
    throw new ResponseTooLargeError(MAX_OAUTH_BODY);
  }
  const out = new Uint8Array(MAX_OAUTH_BODY);
  if (!res.body) return out.subarray(0, 0);
  const reader = res.body.getReader();
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (total + value.byteLength > MAX_OAUTH_BODY) {
      await reader.cancel().catch(() => {});
      throw new ResponseTooLargeError(MAX_OAUTH_BODY);
    }
    out.set(value, total);
    total += value.byteLength;
  }
  return out.subarray(0, total);
}

class FileOAuthProvider implements OAuthClientProvider {
  private expectedState?: string;

  constructor(private readonly name: string, private readonly redirect: string | undefined, private readonly scope: string) {}

  load(): OAuthState {
    const path = oauthStatePath(this.name);
    if (!existsSync(path)) return {};
    assertPrivateFile(path);
    return JSON.parse(readFileSync(path, "utf8")) as OAuthState;
  }

  private store(patch: Partial<OAuthState>): void {
    mkSecretDir(linearDir());
    writeSecretFileAtomic(oauthStatePath(this.name), `${JSON.stringify({ ...this.load(), ...patch }, null, 2)}\n`);
  }

  /** Start a login from nothing: a new redirect port means a new client registration. */
  reset(): void {
    mkSecretDir(linearDir());
    writeSecretFileAtomic(oauthStatePath(this.name), "{}\n");
  }

  get redirectUrl(): string | undefined {
    return this.redirect;
  }

  get clientMetadata(): OAuthClientMetadata {
    return {
      client_name: "Cotal Linear",
      redirect_uris: this.redirect ? [this.redirect] : [],
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
      scope: this.scope,
    };
  }

  state(): string {
    this.expectedState = randomBytes(16).toString("hex");
    return this.expectedState;
  }

  stateFor(): string | undefined {
    return this.expectedState;
  }

  clientInformation(): OAuthClientInformationMixed | undefined {
    return this.load().client;
  }

  saveClientInformation(client: OAuthClientInformationMixed): void {
    this.store({ client });
  }

  tokens(): OAuthTokens | undefined {
    return this.load().tokens;
  }

  saveTokens(tokens: OAuthTokens): void {
    this.store({ tokens, obtainedAt: Date.now() });
  }

  prepareTokenRequest(): URLSearchParams | undefined {
    if (this.redirect !== undefined) return undefined;
    const refreshToken = this.tokens()?.refresh_token;
    if (!refreshToken) return undefined;
    return new URLSearchParams({ grant_type: "refresh_token", refresh_token: refreshToken });
  }

  redirectToAuthorization(url: URL): void {
    if (!this.redirect) throw new Error(`the Linear OAuth session for ${this.name} has ended; run \`cotal linear account login ${this.name}\` again`);
    if (url.protocol !== "https:") throw new OriginRefusedError(`refusing a non-https authorization URL (${url.origin})`);
    console.log(`Open this URL to authorize Cotal with Linear:\n${url.href}`);
  }

  saveCodeVerifier(codeVerifier: string): void {
    this.store({ codeVerifier });
  }

  codeVerifier(): string {
    const v = this.load().codeVerifier;
    if (!v) throw new Error("no PKCE verifier is stored for this login");
    return v;
  }
}

/** Interactive login: loopback redirect, PKCE, dynamic registration. Saves an `oauth` account. */
export async function loginAccount(name: string, mode: LinearMode): Promise<void> {
  const serverUrl = linearMcpUrl(mode);
  const scope = scopeFor(mode);
  const http = createServer();
  await new Promise<void>((ok, bad) => {
    http.once("error", bad);
    http.listen(0, "127.0.0.1", () => ok());
  });
  try {
    const port = (http.address() as AddressInfo).port;
    const provider = new FileOAuthProvider(name, `http://127.0.0.1:${port}/callback`, scope);
    provider.reset();
    let timer: NodeJS.Timeout | undefined;
    const code = new Promise<string>((ok, bad) => {
      timer = setTimeout(() => bad(new Error("no authorization arrived within 5 minutes")), LOGIN_TIMEOUT_MS);
      http.on("request", (req, res) => {
        const u = new URL(req.url ?? "/", `http://127.0.0.1:${port}`);
        if (req.method !== "GET" || u.pathname !== "/callback") {
          res.writeHead(404).end();
          return;
        }
        const expected = provider.stateFor();
        if (!expected || u.searchParams.get("state") !== expected) {
          res.writeHead(400).end("state mismatch");
          bad(new Error("the authorization callback carried the wrong state; nothing was saved"));
          return;
        }
        const error = u.searchParams.get("error");
        const got = u.searchParams.get("code");
        if (error || !got) {
          res.writeHead(400).end("authorization failed");
          bad(new Error(`Linear refused the authorization: ${error ?? "no code"}`));
          return;
        }
        res.writeHead(200, { "content-type": "text/plain" }).end("Linear authorization received. You can close this tab.");
        ok(got);
      });
    });
    code.catch(() => {});
    try {
      if ((await auth(provider, { serverUrl, scope, fetchFn: oauthFetch })) !== "AUTHORIZED") {
        const authorizationCode = await code;
        if ((await auth(provider, { serverUrl, scope, authorizationCode, fetchFn: oauthFetch })) !== "AUTHORIZED")
          throw new Error("Linear did not issue tokens for this authorization");
      }
    } finally {
      clearTimeout(timer);
    }
    if (!provider.tokens()?.access_token) throw new Error("Linear issued no access token");
    saveAccount({ name, mode, auth: "oauth" });
  } finally {
    http.close();
  }
}

function oauthCredential(account: Extract<LinearAccount, { auth: "oauth" }>): LinearCredential {
  const provider = new FileOAuthProvider(account.name, undefined, scopeFor(account.mode));
  let refreshing: Promise<void> | undefined;
  const relogin = `run \`cotal linear account login ${account.name} --mode ${account.mode}\``;
  return {
    bearer() {
      const token = provider.tokens()?.access_token;
      if (!token) throw new Error(`the Linear account ${account.name} has no OAuth token; ${relogin}`);
      return token;
    },
    async prepare() {
      const s = provider.load();
      if (!s.tokens) throw new Error(`the Linear account ${account.name} has no OAuth token; ${relogin}`);
      if (s.tokens.expires_in === undefined || s.obtainedAt === undefined) return;
      if (s.obtainedAt + s.tokens.expires_in * 1000 - REFRESH_MARGIN_MS > Date.now()) return;
      if (!s.tokens.refresh_token) throw new Error(`the OAuth token for ${account.name} expired and cannot be refreshed; ${relogin}`);
      // One refresh at a time: Linear rotates refresh tokens, so a second concurrent refresh fails.
      refreshing ??= (async () => {
        const r = await auth(provider, { serverUrl: linearMcpUrl(account.mode), scope: scopeFor(account.mode), fetchFn: oauthFetch });
        if (r !== "AUTHORIZED") throw new Error(`the OAuth refresh for ${account.name} failed; ${relogin}`);
      })().finally(() => (refreshing = undefined));
      await refreshing;
    },
  };
}

export function credentialFor(account: LinearAccount): LinearCredential {
  if (account.auth === "oauth") return oauthCredential(account);
  return { bearer: () => readAccountToken(account), prepare: async () => {} };
}
