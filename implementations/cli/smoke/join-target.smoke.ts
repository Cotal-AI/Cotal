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

/** Classify, expecting a permitted verdict.
 *
 *  A REFUSAL IS A FAILURE OF THIS CELL, NOT AN ABORT OF THE SUITE. Calling the classifier bare
 *  meant an unexpected throw propagated out of the whole run, so every later cell went unreported
 *  and a mutation said only that SOMETHING died — never which cell. An illegible kill set is close
 *  to no mutation testing at all, so the throw is converted into this cell's own failure and the
 *  run continues to the cells that follow. */
const permits = (url: string, reach: "loopback" | "overlay" | "public-tls", policy = TODAY, server?: string) => {
  let t: ReturnType<typeof classifyJoinTarget>;
  try {
    t = classifyJoinTarget(url, policy);
  } catch (e) {
    check(`permits ${url} as ${reach}`, false, `REFUSED: ${(e as Error).message.split("\n")[0]}`);
    return;
  }
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

console.log("\nONE address, ONE verdict — an alternate spelling must not walk past the fence");
// `::ffff:192.168.1.10` and `::ffff:c0a8:010a` ARE 192.168.1.10. Classifying the v6 spelling on
// its own let a v4 regex miss, the address fall through to "not private", and `--tls --force`
// RECORD a LAN broker that the dotted form refuses. Every spelling is normalized before any
// classifier runs, so these track their dotted twins in both modes rather than being special-cased.
for (const policy of [TODAY, WITH_TLS]) {
  refuses("nats://[::ffff:192.168.1.10]:4222", "v4-mapped RFC1918, dotted tail", policy);
  refuses("nats://[::ffff:c0a8:010a]:4222", "v4-mapped RFC1918, hex tail — the same address", policy);
  refuses("nats://[::ffff:10.0.0.5]:4222", "v4-mapped 10/8", policy);
  refuses("nats://[::ffff:169.254.1.1]:4222", "v4-mapped link-local", policy);
}
// The mapping is a NORMALIZATION, not a blanket refusal: mapped loopback and mapped overlay keep
// the verdict their dotted twins get, or this "fix" would just break v6 spellings wholesale.
permits("nats://[::ffff:127.0.0.1]:4222", "loopback", TODAY);
permits("nats://[::ffff:127.0.0.1]:4222", "loopback", WITH_TLS);
permits("nats://[::ffff:100.64.0.1]:4222", "overlay", ACKED);
permits("nats://[::ffff:8.8.8.8]:4222", "public-tls", WITH_TLS);
refuses("nats://[::ffff:8.8.8.8]:4222", "mapped public address without required TLS", TODAY);
// Pure-v6 private space, pinned in both modes alongside the mapped forms.
for (const policy of [TODAY, WITH_TLS]) {
  refuses("nats://[fc00::1]:4222", "ULA fc00::/7", policy);
  refuses("nats://[fd00::1]:4222", "ULA fd00::/8 (non-overlay)", policy);
  refuses("nats://[fe80::1]:4222", "link-local fe80::/10", policy);
}
permits("nats://[::1]:4222", "loopback", WITH_TLS);

console.log("\nlegacy IPv4 spellings — inet_aton takes octal, hex and short forms, and so does the dialer");
// VERIFIED against dns.lookup on a real machine: 3232235786, 0300.0250.01.012, 0xC0A8010A and
// 192.168.257 all resolve to private addresses, and 0177.0.0.1 to 127.0.0.1. A four-decimal-octet
// regex treated each as a HOSTNAME, so it sailed past the private fence and registered as public
// while the dotted spelling of the same host was refused. One cell per spelling, both modes.
for (const policy of [TODAY, WITH_TLS]) {
  refuses("nats://3232235786:4222", "decimal dword for 192.168.1.10", policy);
  refuses("nats://0300.0250.01.012:4222", "octal dotted for 192.168.1.10", policy);
  refuses("nats://0xC0.0xA8.0x01.0x0A:4222", "hex dotted for 192.168.1.10", policy);
  refuses("nats://0xC0A8010A:4222", "hex dword for 192.168.1.10", policy);
  refuses("nats://192.168.1.010:4222", "mixed dotted with an octal final octet", policy);
  refuses("nats://192.168.257:4222", "3-part short form for 192.168.1.1", policy);
  refuses("nats://167772161:4222", "decimal dword for 10.0.0.1", policy);
  refuses("nats://[::ffff:3232235786]:4222", "a mapped literal whose tail is itself a dword", policy);
}
// Again a NORMALIZATION: legacy spellings of permitted addresses keep the permitted verdict.
permits("nats://0177.0.0.1:4222", "loopback", TODAY);   // octal 127.0.0.1
permits("nats://2130706433:4222", "loopback", WITH_TLS); // dword 127.0.0.1
permits("nats://1684300801:4222", "overlay", ACKED);     // dword 100.64.0.1
permits("nats://0x08080808:4222", "public-tls", WITH_TLS); // dword 8.8.8.8 is genuinely public
// NEGATIVE CONTROL: a real hostname must not be mistaken for a number in some base. These stay
// hostnames (public-tls under required TLS), or the normalizer would be eating names.
permits("nats://broker.example.com:4222", "public-tls", WITH_TLS);
permits("nats://09.0.0.1:4222", "public-tls", WITH_TLS);   // 09 is not octal and not decimal-legal
permits("nats://999.1.1.1:4222", "public-tls", WITH_TLS);  // octet out of range: a hostname
permits("nats://1.2.3.4.5:4222", "public-tls", WITH_TLS);  // five parts: not an IPv4 literal
refuses("nats://broker.example.com:4222", "a hostname without required TLS is still refused", TODAY);

console.log("\nthe OTHER direction — a canonicalizer must not OVER-collapse a lookalike");
// Everything above asks "is a private address under-refused?". This asks the mirror question a
// canonicalizer also has to answer: does a spelling that is NOT the same address wrongly inherit
// a permitted verdict? `::ffff:0:127.0.0.1` reads like the mapped loopback but is a DIFFERENT
// address — a socket dials it ENETUNREACH where `::ffff:127.0.0.1` connects — and
// `::ffff:3232235786` does not resolve at all (ENOTFOUND), so neither may borrow loopback,
// overlay or public-tls from the address it merely resembles. RFC 4291 mapped form is exactly
// `::ffff:a.b.c.d` / `::ffff:xxxx:xxxx`.
// The claim being pinned is precise: a lookalike must not INHERIT loopback or overlay, the two
// classes that are permitted WITHOUT required TLS. It is not that every lookalike is refused
// outright — under required TLS a non-private v6 literal is legitimately `public-tls`, and
// asserting a blanket refusal would be over-claiming (an earlier draft of this block did exactly
// that and went red here, which is how the real contract got written down).
for (const policy of [TODAY, ACKED]) {
  refuses("nats://[::ffff:0:127.0.0.1]:4222", "::ffff:0: is NOT the mapped loopback (ENETUNREACH), so nothing waives TLS for it", policy);
  refuses("nats://[::ffff:0:7f00:1]:4222", "::ffff:0: hex tail is NOT the mapped loopback either", policy);
  refuses("nats://[::ffff:0:100.64.0.1]:4222", "::ffff:0: must NOT inherit the overlay verdict, even with the overlay acked", policy);
  refuses("nats://[::ffff:0:192.168.1.10]:4222", "::ffff:0: is not that private address either", policy);
  // Refused EARLIER than the classifier: `new URL()` rejects it as an invalid IPv6 literal, so it
  // never reaches normalization at all. Pinned here because that is the behaviour we rely on — if
  // a future parser accepted it, this cell holds the line rather than letting a collapse appear.
  refuses("nats://[::ffff:3232235786]:4222", "a dword inside a mapped tail is not a valid literal (and does not resolve)", policy);
}
// Under REQUIRED TLS they are ordinary public literals: permitted, but as `public-tls` — never as
// loopback, which is the class that would have let them skip the transport guarantee entirely.
// (`[::ffff:3232235786]` is excluded here: it is not even a parseable IPv6 literal, so it is
// refused earlier as "not a URL" — a stricter answer than public-tls, pinned in the loop above.)
for (const raw of ["nats://[::ffff:0:127.0.0.1]:4222", "nats://[::ffff:0:7f00:1]:4222", "nats://[::ffff:0:100.64.0.1]:4222"]) {
  const t = classifyJoinTarget(raw, WITH_TLS);
  check(`  ${raw} classifies public-tls under required TLS, never loopback or overlay`,
    t.reach === "public-tls", t);
}
// And the true equivalents must STILL collapse, or the over-collapse fix has gone too far the
// other way — these are the cells that fail if `::ffff:` handling is deleted wholesale.
permits("nats://[::ffff:127.0.0.1]:4222", "loopback", WITH_TLS);
permits("nats://[::ffff:7f00:1]:4222", "loopback", WITH_TLS);
refuses("nats://[::ffff:192.168.1.10]:4222", "the real mapped RFC1918 stays refused", WITH_TLS);

console.log("\nthe parser dependency, asserted DIRECTLY rather than by proxy");
// The mapped-form handler deliberately does NOT canonicalize a legacy-spelled tail, on the stated
// grounds that `new URL()` rejects those before classification runs. That is a load-bearing
// dependency on runtime behaviour, and asserting it only through the refusal cells is a PROXY:
// simulate a parser that accepts and canonicalizes such a host and those cells stay green. Assert
// the parser itself, so the day Node changes this, the failure names the assumption rather than
// surfacing as a mysterious classification.
for (const literal of ["[::ffff:3232235786]", "[::ffff:0xC0A8010A]", "[::ffff:192.168.257]"]) {
  let rejected = false;
  try { new URL(`nats://${literal}:4222`); } catch { rejected = true; }
  check(`new URL() rejects ${literal} — the assumption the mapped-form handler relies on`, rejected);
}

console.log("\ndirection gaps the testing lens named — each verdict measured, then pinned");
// LEADING ZEROS. `192.168.01.10` is octal-per-part and still 192.168.1.10, so it must be refused;
// `010.0.0.5` is octal 8.0.0.5, which is genuinely PUBLIC and must not be over-collapsed into the
// 10/8 block it merely resembles. Both directions in one place, because the risk here is symmetric.
for (const policy of [TODAY, WITH_TLS]) {
  refuses("nats://192.168.01.10:4222", "leading-zero octal octets are still RFC1918", policy);
  refuses("nats://192.168.1.0010:4222", "a wider octal final octet is still RFC1918", policy);
}
permits("nats://010.0.0.5:4222", "public-tls", WITH_TLS); // octal 010 = 8, so 8.0.0.5: public
// OVERLAY PREFIX WIDTH. The overlay is fd7a:115c:a1e0::/48. A /32 reading would swallow the whole
// fd7a:115c::/32 space and hand `overlay` — permitted WITHOUT required TLS — to addresses that are
// not the overlay. Pinned with the ack policy, where a wrong verdict is most costly.
permits("nats://[fd7a:115c:a1e0::1]:4222", "overlay", ACKED);
refuses("nats://[fd7a:115c:ffff::1]:4222", "same /32, different /48 — not the overlay", ACKED);
refuses("nats://[fd7a:115c::1]:4222", "the /32 prefix itself is not the overlay", ACKED);
// NATIVE PUBLIC IPv6 had no coverage at all: neither documentation range nor a real public address
// was asserted in either mode. A v6 literal that is not private must behave like any public host.
for (const raw of ["nats://[2001:db8::1]:4222", "nats://[2606:4700::1111]:4222"]) {
  permits(raw, "public-tls", WITH_TLS);
  refuses(raw, "native public IPv6 without required TLS is refused like any public address", TODAY);
}
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
