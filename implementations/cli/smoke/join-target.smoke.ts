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
import { classifyJoinTarget, JoinRefusal, JOIN_REFUSAL_CODES, type JoinRefusalCode } from "../src/lib/join-target.js";

let pass = 0;
/**
 * Cells ENTERED, counted at entry and independent of every other book.
 *
 * The exit gate used to be `failures.length > 0` alone — which is a function of the array a
 * "log it but do not record it" defect empties, so the guard could not fire against the one
 * mutation it existed for: 24 visible ✗ on screen, rc 0, "118 checks passed". A guard whose
 * condition is computed from the thing the defect removes is not a guard. This counter is
 * incremented before any verdict is decided, so it survives a `check()` that has stopped recording,
 * and the epilogue compares the three books against each other.
 */
let attempted = 0;
/** Every failure this run collected, so a mutation's kill set is READ IN FULL rather than truncated
 *  at the first casualty. */
const failures: string[] = [];
/** How many cells this suite must run. A cell silently skipped or silently added is a defect in
 *  its own right, and one this file has already shipped once (an ambient-dependent arm). */
const EXPECTED_CELLS = 142;
/**
 * Every code the classifier may emit, IMPORTED from production rather than restated here.
 *
 * A hand-written list would be a second copy of a closed set — the species this lane keeps killing.
 * Because this file is never typechecked (`implementations/cli` compiles only `src`), that copy is
 * also the ONLY closure the cells actually run against: a seventh code added at a new throw site,
 * or a retired one, would leave the mirror stale and the unknown-code check dead while looking
 * perfectly maintained. Importing the array means a new arm is a compile error at the source AND a
 * runtime miss at the cell, with nothing to keep in sync by hand.
 */
const KNOWN_CODES: ReadonlySet<string> = new Set<string>(JOIN_REFUSAL_CODES);
/**
 * Record a cell's verdict and KEEP GOING.
 *
 * This used to be `assert.ok`, which throws: the first failing cell aborted the process, so a
 * mutation reported that SOMETHING died and never which cells it killed. An illegible kill set is
 * close to no mutation testing at all — you cannot tell a precise kill from a suite that fell over
 * early for an unrelated reason. Failures are collected here and the run exits non-zero at the end
 * with the whole list (see the epilogue), so the kill set is the list rather than one line.
 */
const check = (name: string, cond: boolean, extra?: unknown) => {
  attempted++;
  // `JSON.stringify` throws on a cycle, a BigInt, or a throwing `toJSON`. The reporter must never
  // be the thing that takes the run down — that failure mode is what this whole repair is about.
  let rendered = "";
  if (extra !== undefined) {
    try {
      rendered = ` — ${JSON.stringify(extra) ?? String(extra)}`;
    } catch {
      rendered = " — <extra could not be serialized>";
    }
  }
  const detail = `${name}${rendered}`;
  if (!cond) {
    failures.push(detail);
    console.log(`  ✗ ${detail}`);
    return;
  }
  pass++;
  console.log(`  ✓ ${name}`);
};

/** The policy as it stands on this branch: nothing can require TLS yet. */
const TODAY = { tlsRequired: false, allowUnencryptedOverlay: false };
/** The policy once the broker can serve TLS and the record can say so. */
const WITH_TLS = { tlsRequired: true, allowUnencryptedOverlay: false };
/** The operator explicitly accepted the tunnel dependency (`--allow-unencrypted-overlay`). */
const ACKED = { tlsRequired: false, allowUnencryptedOverlay: true };

/**
 * Describe ANY thrown value as a string, without ever throwing itself.
 *
 * JavaScript lets you throw anything — a string, `{}`, `null`, an object whose `message` is a
 * getter that throws, or one whose `toString` does. The previous guard read `(e as Error).message`
 * and called `.split` on it, so a throw with no `message` raised a TypeError INSIDE the reporter:
 * the run aborted at that cell, nothing was recorded, and the epilogue never ran. A reporter that
 * can itself throw is exactly what swallowed the original bug, so this one is total: every branch
 * returns a string, and the last resort is a description of the failure to describe.
 */
function describeThrown(e: unknown): string {
  if (e instanceof Error) {
    try {
      const m = typeof e.message === "string" ? e.message : "<non-string .message>";
      return `${e.name ?? "Error"}: ${m}`;
    } catch {
      return "Error whose .message accessor threw";
    }
  }
  if (e === null) return "threw null";
  if (e === undefined) return "threw undefined";
  if (typeof e === "string") return `threw a string: ${e}`;
  try {
    return `threw a non-Error ${typeof e}: ${JSON.stringify(e) ?? String(e)}`;
  } catch {
    // JSON.stringify throws on a cycle or a throwing toJSON; String() can throw on a null-prototype
    // object or a throwing toString. Neither may take the run down.
    try {
      return `threw a non-Error ${typeof e} that could not be serialized`;
    } catch {
      return "threw a value that could not be described";
    }
  }
}

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
    // Same total reporter as the refusal arm: a non-Error throw must not crash the describer.
    check(`permits ${url} as ${reach}`, false, `REFUSED: ${describeThrown(e).split("\n")[0]}`);
    return;
  }
  check(`permits ${url} as ${reach}`, t.reach === reach, t);
  if (server) check(`  normalizes to ${server}`, t.server === server, t.server);
};

/** Classify, expecting a refusal. Returns the message so a caller can assert on its content.
 *
 *  THE THROW MUST BE A REFUSAL, NOT MERELY A THROW. This arm used to `check(..., true)` after any
 *  exception that was not its own assert.fail — so a TypeError, a null dereference or any unrelated
 *  crash inside the classifier made the cell PASS. That is the entire security arm of this lane:
 *  every private-range, IPv6-spelling and loopback-name cell would have reported success if the
 *  classifier died instead of refusing, and a crashing classifier would be indistinguishable from a
 *  correct one. The guard lives INSIDE the helper so no call site can forget it. */
/**
 * Classify, expecting a refusal of a NAMED fence.
 *
 * `code` is declared optional only because the runtime check below is the one that binds. Making
 * the PARAMETER required would enforce nothing here: `implementations/cli/tsconfig.json` sets
 * `"include": ["src"]`, so this file is never compiled by `pnpm typecheck` — verified by injecting
 * an unlisted code and watching typecheck stay silent. A required type in a file no compiler reads
 * is a comment, and a mandatory-ness that cannot fail is exactly the species this helper family has
 * now produced three times. So the obligation is enforced where the file actually runs.
 */
const refuses = (url: string, why: string, policy = TODAY, code?: JoinRefusalCode): string => {
  let permitted: string | undefined;
  let thrown: unknown;
  try {
    const t = classifyJoinTarget(url, policy);
    permitted = t.reach; // an UNDER-REFUSAL: record it below, never throw out of here
  } catch (e) {
    thrown = e;
  }
  // THE UNDER-REFUSAL IS A RECORDED FAILURE, NOT AN ABORT. This used to `assert.fail` and rethrow,
  // so the one mutation this lane exists to catch — a private address wrongly permitted — exited at
  // the first casualty, skipped the epilogue, and left every later cell unrun. The failure that
  // matters most was the one the collector could not collect.
  if (permitted !== undefined) {
    check(`refuses ${url} (${why})`, false, `PERMITTED as ${permitted}`);
    return "";
  }
  // REFUSAL IDENTITY IS STRUCTURAL, NOT PROSE. This used to regex-match the rendered text, which is
  // a string shape standing in for a decision — the exact defect the fences in this file exist to
  // correct, reproduced in the harness that proves them. Measured before the fix: a fault firing
  // BEFORE the privacy check that emitted the privacy refusal's message verbatim was accepted as a
  // genuine private-range refusal (rc 0, 142/142), as were a bare string and a plain object whose
  // prose merely had refusal shape. Only the classifier sets this tag, so an unrelated fault cannot
  // wear it, and `code` says WHICH fence answered rather than merely that something did.
  const message = describeThrown(thrown);
  if (!(thrown instanceof JoinRefusal)) {
    check(`refuses ${url} (${why})`, false, `NOT A JoinRefusal — ${message.split("\n")[0]}`);
    return message;
  }
  // EVERY refusal cell must NAME the fence it expects. Without this an omitted code silently
  // degrades the cell to class-only, and a refusal from the WRONG fence — right class, right
  // message, wrong reason — passes. That is the reachable case a generic typed identity was ruled
  // insufficient for, so the obligation is checked here rather than left to a call site to honour.
  if (code === undefined) {
    check(`refuses ${url} (${why})`, false, `NO EXPECTED CODE DECLARED for ${url} — every refusal cell must name the fence it expects`);
    return message;
  }
  // THE UNION IS CLOSED IN THE TYPE SYSTEM, BUT NOTHING TYPECHECKS THIS FILE: `implementations/cli`
  // has `"include": ["src"]`, so a smoke is never compiled by `pnpm typecheck` and a typo'd or
  // retired code would sail through as a plain string. Re-assert the closure at runtime, or the
  // "compile error" this design leans on does not exist where it is being relied upon.
  if (!KNOWN_CODES.has(code)) {
    check(`refuses ${url} (${why})`, false, `UNKNOWN EXPECTED CODE ${JSON.stringify(code)} — not a member of JoinRefusalCode`);
    return message;
  }
  if (!KNOWN_CODES.has(thrown.code)) {
    check(`refuses ${url} (${why})`, false, `CLASSIFIER EMITTED AN UNKNOWN CODE ${JSON.stringify(thrown.code)}`);
    return message;
  }
  if (thrown.code !== code) {
    // The right fence must answer, not merely some fence: a parser regression that refused every
    // private address would otherwise green the privacy cells while privacy was never consulted.
    check(`refuses ${url} (${why})`, false, `WRONG FENCE — expected code ${code}, got ${thrown.code}`);
    return message;
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
const overlayDefault = refuses("nats://100.64.0.1:4222", "overlay, no TLS, no explicit acceptance", TODAY, "overlay-unacked");
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
refuses("nats://100.63.255.255:4222", "just below the range, even WITH the overlay opt-in", ACKED, "unprotected-target");
permits("nats://100.128.0.1:4222", "public-tls", WITH_TLS);
refuses("nats://100.128.0.1:4222", "just above the range, even WITH the overlay opt-in", ACKED, "unprotected-target");
permits("nats://100.0.0.1:4222", "public-tls", WITH_TLS);

console.log("\nprivate does NOT mean safe — hostile wifi is an RFC1918 network");
// Under WITH_TLS too: these are refused on address class, never merely for lacking TLS. A cafe
// LAN is private too — no public CA issues for these ranges, so "required TLS" cannot make them
// verifiable, and public-tls must never absorb them. If someone later widens the overlay
// detector to "private ranges", these go red.
for (const policy of [TODAY, WITH_TLS]) {
  refuses("nats://192.168.1.10:4222", "RFC1918: a coffee-shop LAN is private and hostile", policy, policy.tlsRequired ? "private-range" : "unprotected-target");
  refuses("nats://10.0.0.5:4222", "RFC1918", policy, policy.tlsRequired ? "private-range" : "unprotected-target");
  refuses("nats://172.16.0.5:4222", "RFC1918", policy, policy.tlsRequired ? "private-range" : "unprotected-target");
  refuses("nats://169.254.1.1:4222", "link-local", policy, policy.tlsRequired ? "private-range" : "unprotected-target");
}

console.log("\npublic addresses — the case this exists to stop");
const publicMsg = refuses("nats://203.0.113.7:4222", "a public address in the clear", TODAY, "unprotected-target");
check("  the refusal names the permitted classes", /Only a loopback literal/i.test(publicMsg), publicMsg);
check("  and says private is not the same as yours", /private is not the same/i.test(publicMsg), publicMsg);
refuses("tls://203.0.113.7:4222", "tls:// is cosmetic in this client and must not buy passage without recorded strictness", TODAY, "unprotected-target");

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
const hostMsg = refuses("nats://broker.example.com:4222", "hostname without required TLS", TODAY, "unprotected-target");
check("  the no-TLS hostname refusal is the existing sentence", /Only a loopback literal/i.test(hostMsg) && /whoever answers the lookup/i.test(hostMsg), hostMsg);
// A cafe LAN is private too: RFC1918 stays refused in BOTH modes (also pinned in the loop above).
refuses("nats://192.168.1.10:4222", "RFC1918 never becomes public-tls", WITH_TLS, "private-range");
refuses("nats://10.1.2.3:4222", "RFC1918 never becomes public-tls", WITH_TLS, "private-range");
refuses("nats://169.254.1.1:4222", "link-local never becomes public-tls", WITH_TLS, "private-range");

console.log("\nONE address, ONE verdict — an alternate spelling must not walk past the fence");
// `::ffff:192.168.1.10` and `::ffff:c0a8:010a` ARE 192.168.1.10. Classifying the v6 spelling on
// its own let a v4 regex miss, the address fall through to "not private", and `--tls --force`
// RECORD a LAN broker that the dotted form refuses. Every spelling is normalized before any
// classifier runs, so these track their dotted twins in both modes rather than being special-cased.
for (const policy of [TODAY, WITH_TLS]) {
  refuses("nats://[::ffff:192.168.1.10]:4222", "v4-mapped RFC1918, dotted tail", policy, policy.tlsRequired ? "private-range" : "unprotected-target");
  refuses("nats://[::ffff:c0a8:010a]:4222", "v4-mapped RFC1918, hex tail — the same address", policy, policy.tlsRequired ? "private-range" : "unprotected-target");
  refuses("nats://[::ffff:10.0.0.5]:4222", "v4-mapped 10/8", policy, policy.tlsRequired ? "private-range" : "unprotected-target");
  refuses("nats://[::ffff:169.254.1.1]:4222", "v4-mapped link-local", policy, policy.tlsRequired ? "private-range" : "unprotected-target");
}
// The mapping is a NORMALIZATION, not a blanket refusal: mapped loopback and mapped overlay keep
// the verdict their dotted twins get, or this "fix" would just break v6 spellings wholesale.
permits("nats://[::ffff:127.0.0.1]:4222", "loopback", TODAY);
permits("nats://[::ffff:127.0.0.1]:4222", "loopback", WITH_TLS);
permits("nats://[::ffff:100.64.0.1]:4222", "overlay", ACKED);
permits("nats://[::ffff:8.8.8.8]:4222", "public-tls", WITH_TLS);
refuses("nats://[::ffff:8.8.8.8]:4222", "mapped public address without required TLS", TODAY, "unprotected-target");
// Pure-v6 private space, pinned in both modes alongside the mapped forms.
for (const policy of [TODAY, WITH_TLS]) {
  refuses("nats://[fc00::1]:4222", "ULA fc00::/7", policy, policy.tlsRequired ? "private-range" : "unprotected-target");
  refuses("nats://[fd00::1]:4222", "ULA fd00::/8 (non-overlay)", policy, policy.tlsRequired ? "private-range" : "unprotected-target");
  refuses("nats://[fe80::1]:4222", "link-local fe80::/10", policy, policy.tlsRequired ? "private-range" : "unprotected-target");
}
permits("nats://[::1]:4222", "loopback", WITH_TLS);

console.log("\nlegacy IPv4 spellings — inet_aton takes octal, hex and short forms, and so does the dialer");
// VERIFIED against dns.lookup on a real machine: 3232235786, 0300.0250.01.012, 0xC0A8010A and
// 192.168.257 all resolve to private addresses, and 0177.0.0.1 to 127.0.0.1. A four-decimal-octet
// regex treated each as a HOSTNAME, so it sailed past the private fence and registered as public
// while the dotted spelling of the same host was refused. One cell per spelling, both modes.
for (const policy of [TODAY, WITH_TLS]) {
  refuses("nats://3232235786:4222", "decimal dword for 192.168.1.10", policy, policy.tlsRequired ? "private-range" : "unprotected-target");
  refuses("nats://0300.0250.01.012:4222", "octal dotted for 192.168.1.10", policy, policy.tlsRequired ? "private-range" : "unprotected-target");
  refuses("nats://0xC0.0xA8.0x01.0x0A:4222", "hex dotted for 192.168.1.10", policy, policy.tlsRequired ? "private-range" : "unprotected-target");
  refuses("nats://0xC0A8010A:4222", "hex dword for 192.168.1.10", policy, policy.tlsRequired ? "private-range" : "unprotected-target");
  refuses("nats://192.168.1.010:4222", "mixed dotted with an octal final octet", policy, policy.tlsRequired ? "private-range" : "unprotected-target");
  refuses("nats://192.168.257:4222", "3-part short form for 192.168.1.1", policy, policy.tlsRequired ? "private-range" : "unprotected-target");
  refuses("nats://167772161:4222", "decimal dword for 10.0.0.1", policy, policy.tlsRequired ? "private-range" : "unprotected-target");
  refuses("nats://[::ffff:3232235786]:4222", "a mapped literal whose tail is itself a dword", policy, "not-a-url");
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
refuses("nats://broker.example.com:4222", "a hostname without required TLS is still refused", TODAY, "unprotected-target");

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
  refuses("nats://[::ffff:0:127.0.0.1]:4222", "::ffff:0: is NOT the mapped loopback (ENETUNREACH), so nothing waives TLS for it", policy, policy.tlsRequired ? "private-range" : "unprotected-target");
  refuses("nats://[::ffff:0:7f00:1]:4222", "::ffff:0: hex tail is NOT the mapped loopback either", policy, policy.tlsRequired ? "private-range" : "unprotected-target");
  refuses("nats://[::ffff:0:100.64.0.1]:4222", "::ffff:0: must NOT inherit the overlay verdict, even with the overlay acked", policy, policy.tlsRequired ? "private-range" : "unprotected-target");
  refuses("nats://[::ffff:0:192.168.1.10]:4222", "::ffff:0: is not that private address either", policy, policy.tlsRequired ? "private-range" : "unprotected-target");
  // Refused EARLIER than the classifier: `new URL()` rejects it as an invalid IPv6 literal, so it
  // never reaches normalization at all. Pinned here because that is the behaviour we rely on — if
  // a future parser accepted it, this cell holds the line rather than letting a collapse appear.
  refuses("nats://[::ffff:3232235786]:4222", "a dword inside a mapped tail is not a valid literal (and does not resolve)", policy, "not-a-url");
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
refuses("nats://[::ffff:192.168.1.10]:4222", "the real mapped RFC1918 stays refused", WITH_TLS, "private-range");

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
  refuses("nats://192.168.01.10:4222", "leading-zero octal octets are still RFC1918", policy, policy.tlsRequired ? "private-range" : "unprotected-target");
  refuses("nats://192.168.1.0010:4222", "a wider octal final octet is still RFC1918", policy, policy.tlsRequired ? "private-range" : "unprotected-target");
}
permits("nats://010.0.0.5:4222", "public-tls", WITH_TLS); // octal 010 = 8, so 8.0.0.5: public
// OVERLAY PREFIX WIDTH. The overlay is fd7a:115c:a1e0::/48. A /32 reading would swallow the whole
// fd7a:115c::/32 space and hand `overlay` — permitted WITHOUT required TLS — to addresses that are
// not the overlay. Pinned with the ack policy, where a wrong verdict is most costly.
permits("nats://[fd7a:115c:a1e0::1]:4222", "overlay", ACKED);
refuses("nats://[fd7a:115c:ffff::1]:4222", "same /32, different /48 — not the overlay", ACKED, "unprotected-target");
refuses("nats://[fd7a:115c::1]:4222", "the /32 prefix itself is not the overlay", ACKED, "unprotected-target");
// NATIVE PUBLIC IPv6 had no coverage at all: neither documentation range nor a real public address
// was asserted in either mode. A v6 literal that is not private must behave like any public host.
for (const raw of ["nats://[2001:db8::1]:4222", "nats://[2606:4700::1111]:4222"]) {
  permits(raw, "public-tls", WITH_TLS);
  refuses(raw, "native public IPv6 without required TLS is refused like any public address", TODAY, "unprotected-target");
}
// --force is a liveness escape, not a policy escape: no force-like field exists on DialPolicy,
// and smuggling one in changes nothing.
const FORCED = { tlsRequired: false, allowUnencryptedOverlay: false, force: true } as unknown as Parameters<typeof classifyJoinTarget>[1];
refuses("nats://203.0.113.7:4222", "--force does not waive the dial policy", FORCED, "unprotected-target");
refuses("nats://broker.example.com:4222", "--force does not waive the dial policy for hostnames", FORCED, "unprotected-target");
// Negative control: the pre-existing classes are untouched by the new reach (asserted throughout
// the loopback/overlay sections above; re-pinned here at the boundary).
permits("nats://127.0.0.1:4222", "loopback", WITH_TLS);
permits("nats://100.64.0.1:4222", "overlay", WITH_TLS);

console.log("\nhostnames — without recorded strictness a verdict must never depend on a lookup someone else answers");
refuses("nats://localhost:4222", "resolver-dependent, even though it 'is' loopback", TODAY, "unprotected-target");
refuses("nats://hub.example.ts.net:4222", "MagicDNS name: whoever answers the lookup picks the peer", TODAY, "unprotected-target");
refuses("nats://broker.internal:4222", "hostname", TODAY, "unprotected-target");
// With required TLS the hostname is verified by the certificate chain + hostname check, so the
// resolver stops being the authority — the doc block's EASY case (e.g. publicly-resolvable
// MagicDNS names with publicly-trusted certs).
permits("nats://hub.example.ts.net:4222", "public-tls", WITH_TLS);
permits("nats://broker.internal:4222", "public-tls", WITH_TLS);
permits("nats://localhost:4222", "public-tls", WITH_TLS); // a hostname like any other: the cert check is the authority now

console.log("\nmalformed input fails loud rather than defaulting to something");
refuses("not-a-url", "not a URL", TODAY, "not-a-url");
refuses("http://127.0.0.1:4222", "not a broker scheme", TODAY, "bad-scheme");
refuses("ws://127.0.0.1:4222", "websocket is not classified by this policy", TODAY, "bad-scheme");
refuses("nats://999.1.1.1:4222", "octet out of range is a hostname, not an IP", TODAY, "unprotected-target");

// THE EPILOGUE IS THE GATE, AND IT DECIDES DIRECTLY — never through `check()`.
//
// Routing this decision through `check()` would put the gate inside the machinery it is meant to
// audit: a defect that stops `check()` recording would also stop the audit being recorded, and the
// suite would exit 0 having silently swallowed the finding. That is the recursive shape this file
// keeps producing, so the accounting is read here, compared three ways, and acted on with a bare
// `process.exit`.
//
// Three independent books must agree: cells ENTERED, cells PASSED, failures COLLECTED. Any defect
// that drops a record breaks the identity even when the failure list looks empty.
const accountingOk =
  attempted === EXPECTED_CELLS && pass + failures.length === attempted;
if (failures.length > 0 || !accountingOk) {
  console.error(`\njoin-target: ${failures.length} FAILED, ${pass} passed`);
  for (const f of failures) console.error(`  ✗ ${f}`);
  if (!accountingOk) {
    console.error(
      `\n✗ ACCOUNTING BROKEN — entered ${attempted}, passed ${pass}, failed ${failures.length}` +
        `, expected ${EXPECTED_CELLS} cells with passed+failed === entered.` +
        `\n  A cell was skipped, added, or its verdict was not recorded. The count cannot be trusted,` +
        ` so this run is a failure regardless of what the cells reported.`,
    );
  }
  process.exit(1);
}
console.log(`\njoin-target: ${pass} checks passed`);
