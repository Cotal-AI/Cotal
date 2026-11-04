/**
 * The Cotal join link — the onboarding half of the wire contract (v0).
 *
 *   cotal://[token@]host[:port]/space[?channel=a,b]    plaintext
 *   cotals://[token@]host[:port]/space[?channel=a,b]   TLS required
 *   cotal://user:pass@host/space                       user/password auth
 *
 * One copy-pasteable string carries server + credentials + space, so a peer
 * joins with a single value. The nats.js client does NOT read credentials from
 * a URL, so we parse them out here and hand them to connect() as options.
 */
export interface JoinLink {
  /** nats:// server URL (auth is carried separately, never in this string). */
  servers: string;
  space: string;
  /** Channels from the link, if any (?channel=a,b). */
  channels?: string[];
  /** Whether a TLS connection is required. */
  tls: boolean;
  /** Bare token (userinfo without a password). */
  token?: string;
  /** Username (userinfo with a password). */
  user?: string;
  pass?: string;
}

/** Parse a `cotal://` / `cotals://` join link. Throws on anything malformed. */
export function parseJoinLink(link: string): JoinLink {
  const tls = link.startsWith("cotals://");
  if (!tls && !link.startsWith("cotal://"))
    throw new Error(`not a Cotal link (expected cotal:// or cotals://): ${link}`);

  // Reparse under a "special" scheme so the WHATWG URL parser populates the
  // authority (credentials/host/port) reliably — non-special schemes don't.
  const u = new URL(link.replace(/^cotals?:\/\//, tls ? "https://" : "http://"));
  if (!u.hostname) throw new Error(`Cotal link has no host: ${link}`);

  const space = decodeURIComponent(u.pathname.replace(/^\/+/, "").split("/")[0] ?? "");
  if (!space) throw new Error(`Cotal link has no space (cotal://host/<space>): ${link}`);

  const chParam = u.searchParams.get("channels") ?? u.searchParams.get("channel");
  const channels = chParam
    ? chParam.split(",").map((s) => s.trim()).filter(Boolean)
    : undefined;

  const user = u.username ? decodeURIComponent(u.username) : undefined;
  const pass = u.password ? decodeURIComponent(u.password) : undefined;

  return {
    servers: `nats://${u.hostname}:${u.port || "4222"}`,
    space,
    channels,
    tls,
    // userinfo with no ':' is a bare token; with ':' it's user/password.
    token: user && !pass ? user : undefined,
    user: pass ? user : undefined,
    pass: pass || undefined,
  };
}

/** Build a join link from its parts (for an operator handing one out). */
export function formatJoinLink(opts: {
  host: string;
  port?: number;
  space: string;
  token?: string;
  tls?: boolean;
  channels?: string[];
}): string {
  const scheme = opts.tls ? "cotals" : "cotal";
  const cred = opts.token ? `${encodeURIComponent(opts.token)}@` : "";
  const port = opts.port ? `:${opts.port}` : "";
  const query = opts.channels?.length ? `?channel=${opts.channels.join(",")}` : "";
  return `${scheme}://${cred}${opts.host}${port}/${encodeURIComponent(opts.space)}${query}`;
}

/** Whether a broker URL, or any URL in a comma-separated list, has a user name or password in it. A
 *  value with no scheme is read as nats://, as the NATS client reads it. That client keeps only a
 *  broker URL's host and port, so such credentials would be dropped in silence. */
export function brokerUrlHasUserinfo(servers: string): boolean {
  return servers.split(",").some((entry) => /^[^:/?#]+:\/\/[^/?#]*@/.test(entry.includes("://") ? entry.trim() : `nats://${entry.trim()}`));
}
