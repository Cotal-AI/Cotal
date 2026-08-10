/**
 * Where `cotal up --join <url>` is allowed to dial.
 *
 * A joining machine sends its agent credentials to a broker it does not run. NATS sends the
 * initial INFO in plaintext and unauthenticated, so an on-path attacker can forge one that does
 * not set `tls_required`, and a client that was never told to demand encryption puts its
 * credentials in the CONNECT line for the attacker to read. The fence has to be client-side.
 *
 * The URL scheme is NOT that fence. Measured against `@nats-io/transport-node` 3.4.0 (the client
 * this repo uses) pointed at a broker with no TLS configured at all:
 *
 *     nats://host:port  {}          -> CONNECTED
 *     tls://host:port   {}          -> CONNECTED     <- the scheme is cosmetic
 *     nats://host:port  {tls:{}}    -> REFUSED: server does not support 'tls'
 *
 * Only the explicit `tls` connect option makes the client demand TLS, and that option is the
 * broker-TLS work's surface, not this one's. So until it lands, `--join` does not warn and dial
 * anyway (that would be a fallback, which this repo forbids). It classifies the target and
 * refuses the ones it cannot protect.
 *
 * ONE deliberate limitation, stated rather than papered over: this classifies an ADDRESS, which
 * is a guard against the obvious mistake (dialing a LAN or public address in the clear), not
 * proof that the bytes are encrypted. An overlay address only rides an encrypted tunnel while the
 * overlay is actually up on this machine; the same literal with the overlay down is just a CGNAT
 * address.
 *
 * WHERE THIS GOES NEXT, so the next editor does not relax it for the wrong reason. Measured on
 * this stack: the `tls` connect option verifies the certificate CHAIN AND THE HOSTNAME (Node
 * defaults, `rejectUnauthorized: true`, servername from the URL), so a redirected name cannot
 * complete the handshake and hostnames become safe — but only once something REQUIRES TLS. The
 * relaxation is therefore a function of recorded strictness, not of time passing, and the agreed
 * eventual shape is `classifyJoinTarget(url, { tlsRequired })` rather than a third verdict: one
 * place keeps answering "may this machine send credentials to that address", with strictness as
 * an input it cannot otherwise see. Two counterintuitive consequences worth keeping in view:
 * the overlay ranges are the AWKWARD case under TLS (CGNAT space, no public CA will issue for it,
 * verifying a literal needs an IP SAN, so it implies a private CA on every joiner), while the
 * `<host>.ts.net` names refused below are the EASY case (publicly resolvable, publicly-trusted
 * certs). Do not pre-relax: with nothing requiring TLS today, literals-only is the correct rule.
 */

/** The address class a permitted target belongs to. This is a REACHABILITY allowlist: it says the
 *  address is one we are willing to consider, never that the connection is protected. What
 *  protects it is {@link DialPolicy.tlsRequired}, except on loopback where nothing leaves the
 *  machine to protect. */
export type JoinReach =
  /** A loopback literal: the bytes never leave the machine. */
  | "loopback"
  /** A private-overlay literal, permitted only alongside required TLS. See the note on
   *  {@link DialPolicy} for why the address alone is not enough. */
  | "overlay";

export interface JoinTarget {
  /** The normalized dial URL, port defaulted. */
  server: string;
  reach: JoinReach;
}

/** What the eventual connection will insist on, which the address alone cannot tell us. */
export interface DialPolicy {
  /**
   * Will the dial to this target REQUIRE TLS?
   *
   * This is the difference between an address and a guarantee, and getting it wrong was the
   * defect this parameter exists to close. An overlay address is not proof the overlay transport
   * is up: with the tunnel daemon stopped, `100.64.0.0/10` is ordinary CGNAT space, and hostile
   * DHCP or routing can answer a dial to it. So the address class establishes only that we are
   * willing to consider the target; requiring TLS is what makes it safe.
   *
   * There is no field on the mesh record to source this from yet — it arrives with the work that
   * teaches the broker to serve TLS — so callers pass `false` today and every non-loopback target
   * is refused. That is the intended sequencing, not an oversight: see the caller for the note
   * that must be updated at the same time the field appears.
   */
  tlsRequired: boolean;
}

/** The NATS default client port, used when the join URL omits one. */
const DEFAULT_PORT = 4222;

/** Loopback: `127.0.0.0/8` and `::1`. LITERALS ONLY, never `localhost`, because the whole point is
 *  a verdict that does not depend on a resolver an attacker could influence (a hosts-file entry or
 *  a poisoned lookup would otherwise turn "loopback" into any address at all). */
function isLoopbackLiteral(host: string): boolean {
  if (host === "::1" || host === "0:0:0:0:0:0:0:1") return true;
  const v4 = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (!v4) return false;
  const parts = v4.slice(1).map(Number);
  if (parts.some((n) => n > 255)) return false;
  return parts[0] === 127;
}

/** The private overlay's address space: `100.64.0.0/10` (the CGNAT range Tailscale assigns) and
 *  `fd7a:115c:a1e0::/48` (its ULA prefix). LITERALS ONLY, for the same reason as loopback: a
 *  MagicDNS name like `<host>.ts.net` is a resolver answer, and accepting it would let whoever
 *  answers that lookup redirect a plaintext credential-bearing dial anywhere they like. */
function isOverlayLiteral(host: string): boolean {
  const v4 = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (v4) {
    const parts = v4.slice(1).map(Number);
    if (parts.some((n) => n > 255)) return false;
    // 100.64.0.0/10 == 100.64.0.0 through 100.127.255.255.
    return parts[0] === 100 && parts[1] >= 64 && parts[1] <= 127;
  }
  return /^fd7a:115c:a1e0:/i.test(host);
}

/** A URL's hostname with an IPv6 literal's brackets removed (`[::1]` -> `::1`). */
function bareHost(url: URL): string {
  return url.hostname.startsWith("[") && url.hostname.endsWith("]")
    ? url.hostname.slice(1, -1)
    : url.hostname;
}

/**
 * Classify a `--join <url>` target, or throw the reason it is refused.
 *
 * Refusal is the point: an unclassifiable target is one whose credentials would cross a network
 * this build cannot encrypt, so it fails loud here rather than dialing and hoping.
 */
export function classifyJoinTarget(raw: string, policy: DialPolicy): JoinTarget {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error(`--join ${JSON.stringify(raw)} is not a URL - pass a broker address like nats://100.64.0.1:4222`);
  }
  if (url.protocol !== "nats:" && url.protocol !== "tls:")
    throw new Error(`--join ${JSON.stringify(raw)} must be a nats:// or tls:// URL, not ${url.protocol}//`);
  const host = bareHost(url);
  if (!host) throw new Error(`--join ${JSON.stringify(raw)} has no host`);
  const port = url.port || String(DEFAULT_PORT);
  const server = `${url.protocol}//${url.hostname}:${port}`;

  // Loopback is the one class that needs no transport guarantee: nothing leaves the machine, so
  // there is nothing on a wire for anyone to sit on.
  if (isLoopbackLiteral(host)) return { server, reach: "loopback" };

  if (isOverlayLiteral(host)) {
    if (policy.tlsRequired) return { server, reach: "overlay" };
    throw new Error(
      `${JSON.stringify(raw)} refused: ${host} is a private-overlay address, but this build cannot require TLS on the connection, and a machine that registers a mesh sends its agent credentials to that broker.\n` +
        `  The address alone is not enough. With the overlay's tunnel down, that range is ordinary carrier-grade NAT space, and whoever answers the dial receives the credentials.\n` +
        `  Serving the broker over TLS - the thing that makes this address safe - is not in this build yet. Until then only a loopback literal (127.0.0.0/8, ::1) can be registered.`,
    );
  }

  throw new Error(
    `${JSON.stringify(raw)} refused: this build cannot protect a connection to ${host}, and a machine that registers a mesh sends its agent credentials to that broker.\n` +
      `  Only a loopback literal (127.0.0.0/8, ::1) or a private-overlay literal (100.64.0.0/10, fd7a:115c:a1e0::/48) may be registered, and the overlay one only once TLS can be required.\n` +
      `  Ordinary private ranges are refused too: a cafe network is private, and private is not the same as yours.\n` +
      `  A hostname is refused even when it resolves somewhere permitted - otherwise whoever answers the lookup chooses which machine receives the credentials. Pass the address itself.`,
  );
}
