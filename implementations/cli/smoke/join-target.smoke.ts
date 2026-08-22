/**
 * The join dial policy: which broker addresses a machine may send its agent credentials to.
 *
 * A machine joining a broker it does not run puts its credentials in the CONNECT line. NATS sends
 * the initial INFO in plaintext and unauthenticated, so an on-path attacker forges one without
 * `tls_required` and reads them. The client side is the only fence, and the URL SCHEME IS NOT IT:
 * measured against `@nats-io/transport-node` 3.4.0 pointed at a broker with no TLS configured,
 * `tls://host:port` connects happily; only the explicit `tls` connect option refuses. So until the
 * broker-TLS transport lands, the join classifies its target and refuses what it cannot protect.
 *
 * The interesting cases are the ones that LOOK safe: a private RFC1918 address on hostile wifi, a
 * hostname that resolves to loopback today, an address that merely starts with the right digits.
 *
 * Hermetic (no broker, no network, no filesystem).
 * Run: pnpm smoke:join-target
 */
import { strict as assert } from "node:assert";
import { classifyJoinTarget } from "../src/lib/join-target.js";

let pass = 0;
const check = (name: string, cond: boolean, extra?: unknown) => {
  assert.ok(cond, `${name}${extra !== undefined ? ` — ${JSON.stringify(extra)}` : ""}`);
  pass++;
  console.log(`  ✓ ${name}`);
};

/** The policy as it stands on this branch: nothing can require TLS yet. */
const TODAY = { tlsRequired: false, allowUnencryptedOverlay: false };
/** The policy once the broker can serve TLS and the record can say so. */
const WITH_TLS = { tlsRequired: true, allowUnencryptedOverlay: false };
/** The operator explicitly accepted the tunnel dependency (`--allow-unencrypted-overlay`). */
const ACKED = { tlsRequired: false, allowUnencryptedOverlay: true };

/** Classify, expecting a permitted verdict. */
const permits = (url: string, reach: "loopback" | "overlay" | "public-tls", policy = TODAY, server?: string) => {
  const t = classifyJoinTarget(url, policy);
  check(`permits ${url} as ${reach}`, t.reach === reach, t);
  if (server) check(`  normalizes to ${server}`, t.server === server, t.server);
};

/** Classify, expecting a refusal. Returns the message so a caller can assert on its content. */
const refuses = (url: string, why: string, policy = TODAY): string => {
  let message = "";
  try {
    const t = classifyJoinTarget(url, policy);
    assert.fail(`${url} was PERMITTED as ${t.reach} — ${why}`);
  } catch (e) {
    message = (e as Error).message;
    if (/was PERMITTED as/.test(message)) throw e; // the assert.fail above, not a refusal
  }
  check(`refuses ${url} (${why})`, true);
  return message;
};

console.log("loopback literals — the bytes never leave the machine");
permits("nats://127.0.0.1:4222", "loopback", TODAY, "nats://127.0.0.1:4222");
permits("nats://127.0.0.1:47811", "loopback", TODAY, "nats://127.0.0.1:47811");
permits("nats://127.9.9.9:4222", "loopback"); // all of 127.0.0.0/8, not just .0.1
permits("nats://[::1]:4222", "loopback");
permits("tls://127.0.0.1:4222", "loopback");
// A join URL with no port is the NATS default, not a parse error.
permits("nats://127.0.0.1", "loopback", TODAY, "nats://127.0.0.1:4222");
// Loopback needs no transport guarantee either way: nothing leaves the machine.
permits("nats://127.0.0.1:4222", "loopback", WITH_TLS);

console.log("\nAN OVERLAY ADDRESS IS NOT A GUARANTEE — permitted now, but never silently");
// The hazard: with the tunnel daemon stopped, 100.64.0.0/10 is ordinary carrier-grade NAT space
// and hostile routing can answer the dial. The address class says only that we are willing to
// consider the target. Increment 1 permits it and SAYS SO; increment 2, once a record can carry
// TLS intent, turns the residual into a refusal at the call site. Both are pinned here so the
// second step is a one-line change with its test already written.
// DEFAULT REFUSES. A printed warning was not a fence: stderr is unread by scripts and it was
// never persisted, so a scripted registration got the risk with none of the notice. A flag is
// the one notice a script cannot miss, because without it the command fails.
const overlayDefault = refuses("nats://100.64.0.1:4222", "overlay, no TLS, no explicit acceptance", TODAY);
check("  the refusal names the opt-in flag", /--allow-unencrypted-overlay/.test(overlayDefault), overlayDefault);
const overlay = classifyJoinTarget("nats://100.64.0.1:4222", ACKED);
check("permits an overlay literal once explicitly accepted", overlay.reach === "overlay", overlay);
check("  but returns a residual rather than staying silent", Boolean(overlay.residual), overlay);
check(
  "  and the residual names the tunnel-down hazard",
  /tunnel is down|carrier-grade NAT/i.test(overlay.residual ?? ""),
  overlay.residual,
);
check(
  "  and warns the operator this becomes a refusal",
  /become a refusal/i.test(overlay.residual ?? ""),
  overlay.residual,
);
// With TLS required the same address is permitted with NOTHING outstanding — that is what
// increment 2 buys, and what the call site will demand before it stops warning.
const overlayTls = classifyJoinTarget("nats://100.64.0.1:4222", WITH_TLS);
check("with TLS required, the same literal has no residual", overlayTls.residual === undefined, overlayTls);
permits("nats://100.100.100.100:4222", "overlay", WITH_TLS);
permits("nats://100.100.100.100:4222", "overlay", ACKED);
permits("nats://100.127.255.255:4222", "overlay", WITH_TLS); // top of 100.64.0.0/10
permits("nats://[fd7a:115c:a1e0::1]:4222", "overlay", WITH_TLS);
permits("nats://100.64.0.1:4222", "overlay", ACKED); // only with explicit acceptance

console.log("\nthe boundary of 100.64.0.0/10 — off-by-one here silently widens the fence");
// Pinned as a REACH assertion under WITH_TLS: just outside the /10 these are public space and
// classify public-tls; a widened overlay detector would flip them to "overlay" and go red here.
// Under the overlay opt-in alone (no TLS) they stay refused — the opt-in buys overlay passage only.
permits("nats://100.63.255.255:4222", "public-tls", WITH_TLS);
refuses("nats://100.63.255.255:4222", "just below the range, even WITH the overlay opt-in", ACKED);
permits("nats://100.128.0.1:4222", "public-tls", WITH_TLS);
refuses("nats://100.128.0.1:4222", "just above the range, even WITH the overlay opt-in", ACKED);
permits("nats://100.0.0.1:4222", "public-tls", WITH_TLS);

console.log("\nprivate does NOT mean safe — hostile wifi is an RFC1918 network");
// Under WITH_TLS too: these are refused on address class, never merely for lacking TLS. A cafe
// LAN is private too — no public CA issues for these ranges, so "required TLS" cannot make them
// verifiable, and public-tls must never absorb them. If someone later widens the overlay
// detector to "private ranges", these go red.
for (const policy of [TODAY, WITH_TLS]) {
  refuses("nats://192.168.1.10:4222", "RFC1918: a coffee-shop LAN is private and hostile", policy);
  refuses("nats://10.0.0.5:4222", "RFC1918", policy);
  refuses("nats://172.16.0.5:4222", "RFC1918", policy);
  refuses("nats://169.254.1.1:4222", "link-local", policy);
}

console.log("\npublic addresses — the case this exists to stop");
const publicMsg = refuses("nats://203.0.113.7:4222", "a public address in the clear");
check("  the refusal names the permitted classes", /Only a loopback literal/i.test(publicMsg), publicMsg);
check("  and says private is not the same as yours", /private is not the same/i.test(publicMsg), publicMsg);
refuses("tls://203.0.113.7:4222", "tls:// is cosmetic in this client and must not buy passage without recorded strictness");

console.log("\npublic-tls — recorded strictness is what relaxes the fence, exactly as the doc block promised");
// The header pre-authorized this: the `tls` connect option verifies chain AND hostname, so once
// the record REQUIRES TLS, a hostname or public literal becomes safe to dial. Without it, every
// verdict below must be byte-identical to the old refusal — the relaxation is a function of
// recorded strictness, never of the address looking respectable.
permits("nats://203.0.113.7:4222", "public-tls", WITH_TLS, "nats://203.0.113.7:4222");
permits("tls://203.0.113.7:4222", "public-tls", WITH_TLS);
permits("nats://broker.example.com:4222", "public-tls", WITH_TLS, "nats://broker.example.com:4222");
permits("tls://broker.example.com", "public-tls", WITH_TLS, "tls://broker.example.com:4222");
const publicTls = classifyJoinTarget("tls://broker.example.com:4222", WITH_TLS);
check("  a public-tls verdict carries no residual — the transport is proven, not promised", publicTls.residual === undefined, publicTls);
// The same hostname WITHOUT recorded strictness keeps the existing sentence, verbatim in intent:
const hostMsg = refuses("nats://broker.example.com:4222", "hostname without required TLS", TODAY);
check("  the no-TLS hostname refusal is the existing sentence", /Only a loopback literal/i.test(hostMsg) && /whoever answers the lookup/i.test(hostMsg), hostMsg);
// A cafe LAN is private too: RFC1918 stays refused in BOTH modes (also pinned in the loop above).
refuses("nats://192.168.1.10:4222", "RFC1918 never becomes public-tls", WITH_TLS);
refuses("nats://10.1.2.3:4222", "RFC1918 never becomes public-tls", WITH_TLS);
refuses("nats://169.254.1.1:4222", "link-local never becomes public-tls", WITH_TLS);
// --force is a liveness escape, not a policy escape: no force-like field exists on DialPolicy,
// and smuggling one in changes nothing.
const FORCED = { tlsRequired: false, allowUnencryptedOverlay: false, force: true } as unknown as Parameters<typeof classifyJoinTarget>[1];
refuses("nats://203.0.113.7:4222", "--force does not waive the dial policy", FORCED);
refuses("nats://broker.example.com:4222", "--force does not waive the dial policy for hostnames", FORCED);
// Negative control: the pre-existing classes are untouched by the new reach (asserted throughout
// the loopback/overlay sections above; re-pinned here at the boundary).
permits("nats://127.0.0.1:4222", "loopback", WITH_TLS);
permits("nats://100.64.0.1:4222", "overlay", WITH_TLS);

console.log("\nhostnames — without recorded strictness a verdict must never depend on a lookup someone else answers");
refuses("nats://localhost:4222", "resolver-dependent, even though it 'is' loopback", TODAY);
refuses("nats://hub.example.ts.net:4222", "MagicDNS name: whoever answers the lookup picks the peer", TODAY);
refuses("nats://broker.internal:4222", "hostname", TODAY);
// With required TLS the hostname is verified by the certificate chain + hostname check, so the
// resolver stops being the authority — the doc block's EASY case (e.g. publicly-resolvable
// MagicDNS names with publicly-trusted certs).
permits("nats://hub.example.ts.net:4222", "public-tls", WITH_TLS);
permits("nats://broker.internal:4222", "public-tls", WITH_TLS);
permits("nats://localhost:4222", "public-tls", WITH_TLS); // a hostname like any other: the cert check is the authority now

console.log("\nmalformed input fails loud rather than defaulting to something");
refuses("not-a-url", "not a URL");
refuses("http://127.0.0.1:4222", "not a broker scheme");
refuses("ws://127.0.0.1:4222", "websocket is not classified by this policy");
refuses("nats://999.1.1.1:4222", "octet out of range is a hostname, not an IP");

console.log(`\njoin-target: ${pass} checks passed`);
