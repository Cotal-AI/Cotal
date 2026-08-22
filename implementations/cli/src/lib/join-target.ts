/**
 * Which broker addresses `cotal meshes add` may register.
 *
 * Registering a mesh is how a machine begins sending its agent credentials to a broker it does
 * not run. NATS sends the initial INFO in plaintext and unauthenticated, so an on-path attacker
 * can forge one that does not set `tls_required`, and a client that was never told to demand
 * encryption puts its credentials in the CONNECT line for the attacker to read. The fence has to
 * be client-side.
 *
 * The URL scheme is NOT that fence. Measured against `@nats-io/transport-node` 3.4.0 (the client
 * this repo uses) pointed at a broker with no TLS configured at all:
 *
 *     nats://host:port  {}          -> CONNECTED
 *     tls://host:port   {}          -> CONNECTED     <- the scheme is cosmetic
 *     nats://host:port  {tls:{}}    -> REFUSED: server does not support 'tls'
 *
 * Only the explicit `tls` connect option makes the client demand TLS, and that option is the
 * broker-TLS work's surface, not this one's. So this gates on the ADDRESS instead, in two steps.
 * Step one, here: refuse public addresses, ordinary private ranges and every hostname outright,
 * and refuse an overlay literal TOO unless the operator accepted it explicitly
 * ({@link DialPolicy.allowUnencryptedOverlay}); accepted, it returns a {@link JoinTarget.residual}
 * the caller prints and records as consent. Step two, once a record can carry TLS intent: the
 * acceptance stops being needed because the transport is proven instead of promised.
 *
 * ONE deliberate limitation, stated rather than papered over: this classifies an ADDRESS, which
 * is a guard against the obvious mistake (dialing a LAN or public address in the clear), not
 * proof that the bytes are encrypted. An overlay address only rides an encrypted tunnel while the
 * overlay is actually up on this machine; the same literal with the overlay down is just a CGNAT
 * address.
 *
 * WHERE THIS WENT, so the next editor knows the relaxation below is the authorized one. The
 * previous header said, measured on this stack: the `tls` connect option verifies the certificate
 * CHAIN AND THE HOSTNAME (Node defaults, `rejectUnauthorized: true`, servername from the URL), so
 * a redirected name cannot complete the handshake and hostnames become safe — but only once
 * something REQUIRES TLS. The relaxation is a function of recorded strictness, not of time
 * passing, and the agreed shape is `classifyJoinTarget(url, { tlsRequired })` rather than a third
 * verdict: one place keeps answering "may this machine send credentials to that address", with
 * strictness as an input it cannot otherwise see. THAT PRECONDITION HAS NOW LANDED: the broker
 * can serve TLS and the mesh record carries `tlsRequired`, so with `tlsRequired: true` a hostname
 * or a public literal classifies as {@link JoinReach} `"public-tls"`. Two counterintuitive
 * consequences remain in force: the overlay ranges are the AWKWARD case under TLS (CGNAT space,
 * no public CA will issue for it, verifying a literal needs an IP SAN, so it implies a private CA
 * on every joiner), while the `<host>.ts.net` names are the EASY case (publicly resolvable,
 * publicly-trusted certs). With `tlsRequired: false` nothing is relaxed: literals-only stays the
 * rule, verbatim. And ordinary private ranges are refused in BOTH modes — no public CA issues for
 * them, so required TLS cannot make them verifiable, and a cafe LAN is private too.
 */

/** The address class a permitted target belongs to. This is a REACHABILITY allowlist: it says the
 *  address is one we are willing to consider, never that the connection is protected. What
 *  protects it is {@link DialPolicy.tlsRequired}, except on loopback where nothing leaves the
 *  machine to protect. */
export type JoinReach =
  /** A loopback literal: the bytes never leave the machine. */
  | "loopback"
  /** A private-overlay literal. Permitted TODAY without required TLS, carrying a
   *  {@link JoinTarget.residual} that says so; it becomes conditional on TLS in step two. The
   *  address alone is not a guarantee - see {@link DialPolicy.tlsRequired}. */
  | "overlay"
  /** A hostname or public literal dialed with REQUIRED TLS ({@link DialPolicy.tlsRequired}):
   *  the certificate chain + hostname check is the authority, so the resolver no longer picks
   *  the peer. Never produced with `tlsRequired: false`. */
  | "public-tls";

export interface JoinTarget {
  /** The normalized dial URL, port defaulted. */
  server: string;
  reach: JoinReach;
  /**
   * Set when the target is permitted but its protection is NOT guaranteed, carrying the sentence
   * the operator needs to read. Exactly one case produces it today: an overlay literal dialed
   * without required TLS, where the address class is right but the tunnel being up is an
   * assumption rather than a fact.
   *
   * It is a returned value rather than a throw because by the time it is produced the operator has
   * ALREADY accepted the risk, so the remaining job is to carry the sentence: the caller prints it
   * as a second notice and records it on the entry as evidence of consent. The refusal for someone
   * who has NOT accepted happens earlier, and is a throw.
   */
  residual?: string;
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
   * The mesh record now carries this intent (`MeshEntry.tlsRequired`), so callers pass the
   * record's real strictness. With it `false` an overlay literal is refused unless
   * {@link DialPolicy.allowUnencryptedOverlay} says the operator accepted the tunnel dependency.
   * With it `true` the acceptance stops being needed — the transport is proven rather than
   * promised — and a hostname or public literal becomes registrable as `"public-tls"`.
   */
  tlsRequired: boolean;
  /**
   * Did the operator EXPLICITLY accept the overlay's tunnel dependency?
   *
   * The default is `false` and the default refuses, because the previous shape — permit and print
   * a warning — is not a fence. A warning is written to stderr, which a non-interactive caller
   * need not read, and it was not persisted, so nothing repeated it at the dials that followed. A
   * scripted registration therefore got the risk with none of the notice.
   *
   * A flag is the one form of notice a script cannot miss: without it the command fails, and the
   * failure is in the exit code rather than in prose nobody reads. The acceptance is then recorded
   * on the mesh entry, so a later dial can tell that a human agreed to this rather than inferring
   * consent from an address.
   */
  allowUnencryptedOverlay: boolean;
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

/** Ordinary private ranges: RFC1918, link-local, and the non-overlay ULA/link-local v6 space.
 *  Refused in BOTH modes — a cafe LAN is private too, and no public CA issues certificates for
 *  these ranges, so required TLS cannot make an address here verifiable. */
function isPrivateLiteral(host: string): boolean {
  const v4 = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (v4) {
    const p = v4.slice(1).map(Number);
    if (p.some((n) => n > 255)) return false; // not an IP literal at all; treated as a hostname
    if (p[0] === 10) return true; // 10.0.0.0/8
    if (p[0] === 172 && p[1] >= 16 && p[1] <= 31) return true; // 172.16.0.0/12
    if (p[0] === 192 && p[1] === 168) return true; // 192.168.0.0/16
    if (p[0] === 169 && p[1] === 254) return true; // 169.254.0.0/16 link-local
    return false;
  }
  // ULA fc00::/7 and link-local fe80::/10; the overlay's fd7a:115c:a1e0::/48 is classified first.
  return /^(f[cd][0-9a-f]{2}:|fe[89ab][0-9a-f]{0,2}:)/i.test(host);
}

/** A URL's hostname with an IPv6 literal's brackets removed (`[::1]` -> `::1`). */
function bareHost(url: URL): string {
  return url.hostname.startsWith("[") && url.hostname.endsWith("]")
    ? url.hostname.slice(1, -1)
    : url.hostname;
}

/**
 * Classify a registration target, or throw the reason it is refused.
 *
 * Refusal is the point: an unclassifiable target is one whose credentials would cross a network
 * this build cannot encrypt, so it fails loud here rather than dialing and hoping.
 */
export function classifyJoinTarget(raw: string, policy: DialPolicy): JoinTarget {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error(`${JSON.stringify(raw)} is not a URL - pass a broker address like nats://100.64.0.1:4222`);
  }
  if (url.protocol !== "nats:" && url.protocol !== "tls:")
    throw new Error(`${JSON.stringify(raw)} must be a nats:// or tls:// URL, not ${url.protocol}//`);
  const host = bareHost(url);
  if (!host) throw new Error(`${JSON.stringify(raw)} has no host`);
  const port = url.port || String(DEFAULT_PORT);
  const server = `${url.protocol}//${url.hostname}:${port}`;

  // Loopback is the one class that needs no transport guarantee: nothing leaves the machine, so
  // there is nothing on a wire for anyone to sit on.
  if (isLoopbackLiteral(host)) return { server, reach: "loopback" };

  if (isOverlayLiteral(host)) {
    if (policy.tlsRequired) return { server, reach: "overlay" };
    if (!policy.allowUnencryptedOverlay)
      throw new Error(
        `${JSON.stringify(raw)} refused: ${host} is a private-overlay address, and this build cannot require TLS on the connection.\n` +
          `  That is safe while the overlay tunnel is up, and NOT safe if it is down: the range is then ordinary carrier-grade\n` +
          `  NAT, and whoever answers the dial receives the credentials this machine sends.\n` +
          `  Only you can know whether the tunnel is up, so accept it explicitly with --allow-unencrypted-overlay, which records\n` +
          `  your acceptance on the mesh entry. The flag goes away once the broker can be served over TLS.`,
      );
    return {
      server,
      reach: "overlay",
      residual:
        `${host} is a private-overlay address, and this build cannot yet require TLS on the connection.\n` +
        `  That is safe while the overlay tunnel is actually up: it authenticates both machines and encrypts the link.\n` +
        `  It is NOT safe if the tunnel is down. That range is then ordinary carrier-grade NAT space, and whoever\n` +
        `  answers the dial receives the credentials this machine will send. Keep the tunnel up, and expect this to\n` +
        `  become a refusal once the broker can be served over TLS and the record can say TLS is required.`,
    };
  }

  // Recorded strictness relaxes the fence, exactly as the header pre-authorized: with TLS
  // REQUIRED, the `tls` connect option verifies the certificate chain and the hostname, so a
  // hostname or a public literal is safe — the resolver stops choosing the peer. Private ranges
  // stay refused: no public CA issues for them, and a cafe LAN is private too.
  if (policy.tlsRequired) {
    if (!isPrivateLiteral(host)) return { server, reach: "public-tls" };
    throw new Error(
      `${JSON.stringify(raw)} refused: ${host} is a private-range address, and requiring TLS does not make it verifiable - no public CA issues certificates for RFC1918 or link-local space, and a cafe LAN is private, not yours.\n` +
        `  Register the broker by its public name or address, or run it on this machine and use a loopback literal.`,
    );
  }

  throw new Error(
    `${JSON.stringify(raw)} refused: this build cannot protect a connection to ${host}, and a machine that registers a mesh sends its agent credentials to that broker.\n` +
      `  Only a loopback literal (127.0.0.0/8, ::1) or a private-overlay literal (100.64.0.0/10, fd7a:115c:a1e0::/48) may be registered. An overlay literal additionally needs --allow-unencrypted-overlay, which records that you accepted its tunnel dependency.\n` +
      `  Ordinary private ranges are refused too: a cafe network is private, and private is not the same as yours.\n` +
      `  A hostname is refused even when it resolves somewhere permitted - otherwise whoever answers the lookup chooses which machine receives the credentials. Pass the address itself.`,
  );
}
