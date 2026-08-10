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

/** Classify, expecting a permitted verdict. */
const permits = (url: string, reach: "loopback" | "overlay", server?: string) => {
  const t = classifyJoinTarget(url);
  check(`permits ${url} as ${reach}`, t.reach === reach, t);
  if (server) check(`  normalizes to ${server}`, t.server === server, t.server);
};

/** Classify, expecting a refusal. Returns the message so a caller can assert on its content. */
const refuses = (url: string, why: string): string => {
  let message = "";
  try {
    const t = classifyJoinTarget(url);
    assert.fail(`${url} was PERMITTED as ${t.reach} — ${why}`);
  } catch (e) {
    message = (e as Error).message;
    if (/was PERMITTED as/.test(message)) throw e; // the assert.fail above, not a refusal
  }
  check(`refuses ${url} (${why})`, true);
  return message;
};

console.log("loopback literals — the bytes never leave the machine");
permits("nats://127.0.0.1:4222", "loopback", "nats://127.0.0.1:4222");
permits("nats://127.0.0.1:47811", "loopback", "nats://127.0.0.1:47811");
permits("nats://127.9.9.9:4222", "loopback"); // all of 127.0.0.0/8, not just .0.1
permits("nats://[::1]:4222", "loopback");
permits("tls://127.0.0.1:4222", "loopback");
// A join URL with no port is the NATS default, not a parse error.
permits("nats://127.0.0.1", "loopback", "nats://127.0.0.1:4222");

console.log("\nthe overlay's OWN ranges — a WireGuard tunnel between two enrolled machines");
permits("nats://100.64.0.1:4222", "overlay");
permits("nats://100.100.100.100:4222", "overlay");
permits("nats://100.127.255.255:4222", "overlay"); // top of 100.64.0.0/10
permits("nats://[fd7a:115c:a1e0::1]:4222", "overlay");

console.log("\nthe boundary of 100.64.0.0/10 — off-by-one here silently widens the fence");
refuses("nats://100.63.255.255:4222", "just below the overlay range");
refuses("nats://100.128.0.1:4222", "just above the overlay range");
refuses("nats://100.0.0.1:4222", "100.x but outside the /10");

console.log("\nprivate does NOT mean safe — hostile wifi is an RFC1918 network");
refuses("nats://192.168.1.10:4222", "RFC1918: a coffee-shop LAN is private and hostile");
refuses("nats://10.0.0.5:4222", "RFC1918");
refuses("nats://172.16.0.5:4222", "RFC1918");
refuses("nats://169.254.1.1:4222", "link-local");

console.log("\npublic addresses — the case this exists to stop");
const publicMsg = refuses("nats://203.0.113.7:4222", "a public address in the clear");
check(
  "  the refusal names the coming client-TLS surface as the unlock",
  /TLS/i.test(publicMsg),
  publicMsg,
);
refuses("tls://203.0.113.7:4222", "tls:// is cosmetic in this client and must not buy passage");

console.log("\nhostnames — a verdict must never depend on a lookup someone else answers");
refuses("nats://localhost:4222", "resolver-dependent, even though it 'is' loopback");
refuses("nats://hub.example.ts.net:4222", "MagicDNS name: whoever answers the lookup picks the peer");
refuses("nats://broker.internal:4222", "hostname");

console.log("\nmalformed input fails loud rather than defaulting to something");
refuses("not-a-url", "not a URL");
refuses("http://127.0.0.1:4222", "not a broker scheme");
refuses("ws://127.0.0.1:4222", "websocket is not classified by this policy");
refuses("nats://999.1.1.1:4222", "octet out of range is a hostname, not an IP");

console.log(`\njoin-target: ${pass} checks passed`);
