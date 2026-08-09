import { strict as assert } from "node:assert";
import { createSpaceAuth, serverConfig, openServerConfig } from "../src/index.js";

// Every CALL-SITE SHAPE of the broker config renderers, exercised in a GATED suite.
//
// Why this exists, and what it does NOT claim. Making `transport` a required union rewrote 64 call
// sites in four distinct shapes. Three of those shapes appear in suites that `smoke:ci` runs, so a
// broken rewrite in them turns something red. THE FOURTH — `extraAccounts` supplied from a
// VARIABLE rather than an array literal — appears at exactly three sites, and ALL THREE ARE IN
// `:live` SUITES, which the gate does not run. So that shape's only coverage was below the door:
// a break in it would ship without any red appearing anywhere.
//
// This suite closes the SHAPE at a level the gate reaches. It is honest about the limit: rendering
// the shape here proves the shape is renderable and that the transport survives it, NOT that the
// three real call sites are correct. Those remain `:live`-only, a pre-existing condition of those
// suites rather than something this change introduced, and it is called out in the PR body.
//
// No brokers, no build — pure rendering, so this is safe to run outside a build-lock hold.
const auth = await createSpaceAuth("shapes");
const storeDir = "/tmp/shapes-js";
const extra = [{ pub: auth.sys.pub, jwt: auth.sys.jwt }];

/** The four shapes the rewrite touched, named as they appear in the tree. */
const shapes: Array<{ name: string; render: () => string }> = [
  {
    name: "1: { port: PORT, storeDir: join(dir, \"js\") }",
    render: () => serverConfig(auth, [auth], { transport: { kind: "plaintext" }, port: 4301, storeDir }),
  },
  {
    name: "2: { port, storeDir }",
    render: () => serverConfig(auth, [auth], { transport: { kind: "plaintext" }, port: 4302, storeDir }),
  },
  {
    name: "3: { ..., extraAccounts: [ literal ] }",
    render: () => serverConfig(auth, [auth], {
      transport: { kind: "plaintext" }, port: 4303, storeDir,
      extraAccounts: [{ pub: auth.sys.pub, jwt: auth.sys.jwt }],
    }),
  },
  {
    // THE BELOW-THE-DOOR ONE. Structurally identical to shape 3 at the type level, but this is the
    // form whose only real call sites live in ungated `:live` suites.
    name: "4: { ..., extraAccounts: prepared.extraAccounts }  <- :live-only in the tree",
    render: () => serverConfig(auth, [auth], {
      transport: { kind: "plaintext" }, port: 4304, storeDir, extraAccounts: extra,
    }),
  },
];

for (const s of shapes) {
  const conf = s.render();
  assert.match(conf, /^port: 43\d\d$/m, `shape ${s.name}: no port rendered`);
  assert.match(conf, /jetstream \{ store_dir:/, `shape ${s.name}: no jetstream block`);
  assert.doesNotMatch(conf, /^tls \{/m, `shape ${s.name}: plaintext transport must render NO tls block`);
  // The one that would be silent: a rewrite that dropped `transport` at a site would still render
  // a valid-looking plaintext config. There is nothing to assert about its ABSENCE — which is
  // exactly why the union is required at the type level rather than checked here. This suite
  // guards the shapes; the compiler guards the omission.
}

// TLS renders on both renderers, and `allow_non_tls` NEVER appears in either. Mixed mode is the
// one configuration that would let a client decline the upgrade and be served in cleartext, so its
// absence is asserted rather than assumed — including on the plaintext path, where a stray emit
// would be just as wrong.
for (const [what, tlsConf, plainConf] of [
  [
    "serverConfig",
    serverConfig(auth, [auth], { transport: { kind: "tls-required", certFile: "/c.crt", keyFile: "/c.key" }, port: 4310, storeDir }),
    serverConfig(auth, [auth], { transport: { kind: "plaintext" }, port: 4311, storeDir }),
  ],
  [
    "openServerConfig",
    openServerConfig({ transport: { kind: "tls-required", certFile: "/c.crt", keyFile: "/c.key" }, port: 4312, storeDir }),
    openServerConfig({ transport: { kind: "plaintext" }, port: 4313, storeDir }),
  ],
] as const) {
  assert.match(tlsConf, /^tls \{$/m, `${what}: tls-required must render a tls block`);
  assert.match(tlsConf, /^\s+cert_file: "\/c\.crt"$/m, `${what}: cert_file missing`);
  assert.match(tlsConf, /^\s+key_file: "\/c\.key"$/m, `${what}: key_file missing`);
  assert.doesNotMatch(tlsConf, /allow_non_tls/, `${what}: allow_non_tls must NEVER be emitted - it is mixed mode, and a client that declines the upgrade is served in cleartext`);
  assert.doesNotMatch(tlsConf, /handshake_first/, `${what}: handshake_first must never be emitted - it breaks the plaintext INFO reachability probe`);
  assert.doesNotMatch(tlsConf, /verify/, `${what}: verify/verify_and_map must never be emitted - mTLS is a deliberate non-goal`);
  assert.doesNotMatch(plainConf, /^tls \{/m, `${what}: plaintext must render no tls block`);
  assert.doesNotMatch(plainConf, /allow_non_tls/, `${what}: allow_non_tls must not appear on the plaintext path either`);
}

// The open renderer must NOT carry auth material. It exists because a no-auth broker has no
// business holding the operator, system account or MEMORY resolver — if it grew them, the two
// renderers would have quietly converged and the reason for the split would be gone.
{
  const openConf = openServerConfig({ transport: { kind: "plaintext" }, port: 4320, storeDir });
  for (const forbidden of ["operator:", "system_account:", "resolver:", "resolver_preload:"]) {
    assert.equal(openConf.includes(forbidden), false, `openServerConfig must not emit ${forbidden} - a no-auth broker carries no trust material`);
  }
}

console.log(`serverconfig-shapes smoke: OK - all 4 call-site shapes render (incl. the :live-only extraAccounts-from-variable form), tls renders on both renderers, allow_non_tls/handshake_first/verify never emitted, open renderer carries no auth material`);
