import { createServer } from "node:http";
import { homedir } from "node:os";
import { join } from "node:path";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { UnauthorizedError } from "@modelcontextprotocol/sdk/client/auth.js";
import type { OAuthClientProvider } from "@modelcontextprotocol/sdk/client/auth.js";
import type {
  OAuthClientInformationMixed,
  OAuthClientMetadata,
  OAuthTokens,
} from "@modelcontextprotocol/sdk/shared/auth.js";
import { buildRemoteTransport } from "./transport.js";
import { c } from "./ui.js";

/** Default loopback port for the OAuth redirect — a stable redirect_uri so one dynamic client
 *  registration stays valid across logins. Override with `--callback-port`. */
export const DEFAULT_CALLBACK_PORT = 8976;

/** Per-service OAuth cache dir: `~/.cotal/mcp-auth/<service>/` (user-global, like the control socket). */
export function mcpAuthDir(service: string): string {
  return join(homedir(), ".cotal", "mcp-auth", service.replace(/[^A-Za-z0-9_.-]/g, "_"));
}

/** Best-effort open of a URL in the default browser (the URL is also printed). */
function openBrowser(url: string): void {
  const [cmd, args] =
    process.platform === "darwin"
      ? ["open", [url]]
      : process.platform === "win32"
        ? ["cmd", ["/c", "start", "", url]]
        : ["xdg-open", [url]];
  try {
    spawn(cmd as string, args as string[], { stdio: "ignore", detached: true }).unref();
  } catch {
    /* no opener on this platform — the printed URL is the fallback */
  }
}

export interface OAuthProviderOpts {
  /** Cache dir (from {@link mcpAuthDir}). */
  dir: string;
  /** The loopback redirect URL registered with the authorization server. */
  redirectUrl: string;
  scope?: string;
  /** Invoked when the SDK needs the user to authorize — login opens a browser; the daemon throws. */
  onRedirect(url: URL): void | Promise<void>;
}

/**
 * A disk-backed {@link OAuthClientProvider}. The MCP SDK drives discovery, dynamic client
 * registration, PKCE, code exchange, and token refresh; this only persists the artifacts
 * (client registration, tokens, PKCE verifier, CSRF state) under `dir`, mode 0600.
 */
export class FileOAuthProvider implements OAuthClientProvider {
  private readonly dir: string;
  private readonly _redirectUrl: string;
  private readonly scope?: string;
  private readonly onRedirect: (url: URL) => void | Promise<void>;
  private _state?: string;

  constructor(opts: OAuthProviderOpts) {
    this.dir = opts.dir;
    this._redirectUrl = opts.redirectUrl;
    this.scope = opts.scope;
    this.onRedirect = opts.onRedirect;
    mkdirSync(this.dir, { recursive: true });
  }

  get redirectUrl(): string {
    return this._redirectUrl;
  }

  get clientMetadata(): OAuthClientMetadata {
    return {
      client_name: "cotal-mcp-bridge",
      redirect_uris: [this._redirectUrl],
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
      ...(this.scope ? { scope: this.scope } : {}),
    };
  }

  private file(name: string): string {
    return join(this.dir, name);
  }
  private readJson<T>(name: string): T | undefined {
    const p = this.file(name);
    return existsSync(p) ? (JSON.parse(readFileSync(p, "utf8")) as T) : undefined;
  }
  private writeJson(name: string, value: unknown): void {
    writeFileSync(this.file(name), JSON.stringify(value, null, 2), { mode: 0o600 });
  }

  clientInformation(): OAuthClientInformationMixed | undefined {
    return this.readJson<OAuthClientInformationMixed>("client.json");
  }
  saveClientInformation(info: OAuthClientInformationMixed): void {
    this.writeJson("client.json", info);
  }

  tokens(): OAuthTokens | undefined {
    return this.readJson<OAuthTokens>("tokens.json");
  }
  saveTokens(tokens: OAuthTokens): void {
    this.writeJson("tokens.json", tokens);
  }

  saveCodeVerifier(verifier: string): void {
    writeFileSync(this.file("verifier.txt"), verifier, { mode: 0o600 });
  }
  codeVerifier(): string {
    const p = this.file("verifier.txt");
    if (!existsSync(p)) throw new Error("no PKCE code verifier saved — restart the login");
    return readFileSync(p, "utf8");
  }

  state(): string {
    if (!this._state) {
      this._state = randomBytes(16).toString("hex");
      writeFileSync(this.file("state.txt"), this._state, { mode: 0o600 });
    }
    return this._state;
  }
  /** The state persisted for the in-flight authorization, read by the loopback callback. */
  pendingState(): string | undefined {
    const p = this.file("state.txt");
    return existsSync(p) ? readFileSync(p, "utf8") : undefined;
  }

  redirectToAuthorization(url: URL): void | Promise<void> {
    return this.onRedirect(url);
  }

  /** True once a token has been cached (the daemon refuses to start OAuth without this). */
  hasTokens(): boolean {
    return existsSync(this.file("tokens.json"));
  }
}

/** Build a daemon-side provider: it never opens a browser — if the SDK needs interactive auth
 *  (no cached/refreshable token), it throws an actionable error pointing at `login`. */
export function daemonOAuthProvider(service: string, url: string, scope?: string): FileOAuthProvider {
  return new FileOAuthProvider({
    dir: mcpAuthDir(service),
    redirectUrl: `http://127.0.0.1:${DEFAULT_CALLBACK_PORT}/callback`,
    scope,
    onRedirect() {
      throw new Error(
        `not authenticated for ${url} — run: cotal mcp-bridge login --url ${url}` +
          (service ? ` --name ${service}` : ""),
      );
    },
  });
}

/**
 * Interactive OAuth login: start a loopback callback server, open the browser to the
 * authorization URL the SDK builds, capture the redirect, finish the token exchange, and
 * verify the cached token works. Tokens land in `~/.cotal/mcp-auth/<service>/`.
 */
export async function runOAuthLogin(opts: {
  url: string;
  service: string;
  sse?: boolean;
  scope?: string;
  callbackPort?: number;
  /** Override how the authorization URL is opened (defaults to the system browser; tests inject). */
  openUrl?: (url: string) => void;
}): Promise<{ tools: number }> {
  const port = opts.callbackPort ?? DEFAULT_CALLBACK_PORT;
  const redirectUrl = `http://127.0.0.1:${port}/callback`;
  const dir = mcpAuthDir(opts.service);
  const open = opts.openUrl ?? openBrowser;

  const provider = new FileOAuthProvider({
    dir,
    redirectUrl,
    scope: opts.scope,
    onRedirect(url) {
      console.log(c.dim(`\nOpening your browser to authorize…\n  ${url.href}\n`));
      open(url.href);
    },
  });

  const transport = buildRemoteTransport(opts.url, { sse: opts.sse, authProvider: provider });
  const client = new Client({ name: "cotal-mcp-bridge", version: "0.3.1" });

  // Loopback server resolves the authorization code (or "" if already authorized via cache).
  const code = await new Promise<string>((resolve, reject) => {
    const server = createServer((req, res) => {
      const u = new URL(req.url ?? "/", redirectUrl);
      if (u.pathname !== "/callback") {
        res.writeHead(404).end();
        return;
      }
      const done = (status: number, html: string) => {
        res.writeHead(status, { "content-type": "text/html" });
        res.end(`<!doctype html><meta charset=utf-8><body style="font-family:sans-serif">${html}</body>`);
        server.close();
      };
      const error = u.searchParams.get("error");
      if (error) {
        done(400, `<h1>Authorization failed</h1><p>${error}</p>`);
        reject(new Error(`authorization error: ${error}`));
        return;
      }
      const want = provider.pendingState();
      if (want && u.searchParams.get("state") !== want) {
        done(400, "<h1>State mismatch</h1>");
        reject(new Error("OAuth state mismatch — possible CSRF; aborting"));
        return;
      }
      const got = u.searchParams.get("code");
      if (!got) {
        done(400, "<h1>No authorization code</h1>");
        reject(new Error("no authorization code in callback"));
        return;
      }
      done(200, "<h1>Authorized ✓</h1><p>You can close this tab and return to the terminal.</p>");
      resolve(got);
    });
    server.on("error", reject);
    server.listen(port, "127.0.0.1", () => {
      // connect() triggers discovery + redirectToAuthorization (opens the browser). On REDIRECT
      // it rejects with UnauthorizedError — expected; we then wait for the loopback callback.
      client.connect(transport).then(
        () => {
          server.close();
          resolve(""); // already authorized via a cached/refreshed token
        },
        (e) => {
          if (e instanceof UnauthorizedError) return;
          server.close();
          reject(e);
        },
      );
    });
  });

  if (code) await transport.finishAuth(code);
  await client.close().catch(() => {});

  // Verify the cached token actually works (fresh provider that refuses interactive auth).
  const verifyProvider = daemonOAuthProvider(opts.service, opts.url, opts.scope);
  const verifyTransport = buildRemoteTransport(opts.url, { sse: opts.sse, authProvider: verifyProvider });
  const verifyClient = new Client({ name: "cotal-mcp-bridge", version: "0.3.1" });
  await verifyClient.connect(verifyTransport);
  const { tools } = await verifyClient.listTools();
  await verifyClient.close();
  return { tools: tools.length };
}
