import { strict as assert } from "node:assert";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  brokerPolicyPath, writeBrokerPolicy, readBrokerPolicy, BrokerPolicyError,
} from "../src/broker-policy.js";

// The broker launch policy is what makes a TLS decision survive `cotal down`. `MeshEntry` does not
// survive it, so without this record a bare down/up would forget that a broker serves TLS and
// bring it back in cleartext — the silent downgrade arriving by the most ordinary operator gesture
// there is. These cases pin the two properties that matter: the decision round-trips, and every
// way of failing to honour it REFUSES rather than degrades.
const root = mkdtempSync(join(tmpdir(), "cotal-brokerpolicy-"));
const certFile = join(root, "server.crt"), keyFile = join(root, "server.key");
writeFileSync(certFile, "not-a-real-cert");
writeFileSync(keyFile, "not-a-real-key");

function fresh(): string {
  const d = mkdtempSync(join(tmpdir(), "cotal-bp-case-"));
  mkdirSync(join(d, ".cotal"), { recursive: true });
  return d;
}

/** Assert the call throws a BrokerPolicyError whose message matches, and — the part that matters —
 *  that it THROWS AT ALL rather than returning a plaintext policy. A silent downgrade would show
 *  up here as a returned value, so a bare `assert.throws` is the wrong shape: it would pass if the
 *  function threw for some unrelated reason. */
function refuses(fn: () => unknown, match: RegExp, what: string): void {
  let threw: unknown;
  let returned: unknown;
  try { returned = fn(); } catch (e) { threw = e; }
  assert.equal(
    threw instanceof BrokerPolicyError, true,
    `${what}: expected a BrokerPolicyError, got ${threw ? `${(threw as Error).name}: ${(threw as Error).message}` : `no throw, returned ${JSON.stringify(returned)}`}`,
  );
  assert.match((threw as Error).message, match, `${what}: wrong reason`);
}

// 1. No policy at all is NOT an error. A mesh created before this record existed simply has no
//    recorded decision, which is different from having a broken one.
{
  const d = fresh();
  assert.equal(readBrokerPolicy(d), undefined, "a mesh with no policy file must read as undefined, not throw");
}

// 2. Plaintext round-trips.
{
  const d = fresh();
  writeBrokerPolicy(d, { version: 1, transport: { kind: "plaintext" } });
  assert.deepEqual(readBrokerPolicy(d), { version: 1, transport: { kind: "plaintext" } });
}

// 3. TLS round-trips, and the parent directory is hardened. 0700 matters because this file is
//    INTEGRITY-critical: the paths are not secret, but whoever can rewrite them can point the
//    broker at a certificate they control on the next `up`.
{
  const d = fresh();
  writeBrokerPolicy(d, { version: 1, transport: { kind: "tls-required", certFile, keyFile } });
  assert.deepEqual(readBrokerPolicy(d), { version: 1, transport: { kind: "tls-required", certFile, keyFile } });
  if (process.platform !== "win32") {
    const mode = statSync(join(d, ".cotal")).mode & 0o777;
    assert.equal(mode & 0o077, 0, `.cotal must not be group/other-accessible; got ${mode.toString(8)}`);
  }
}

// 4. A TLS policy whose CERTIFICATE has moved must REFUSE. This is the ordinary way it breaks and
//    the one that must never degrade: the operator deliberately chose TLS, and a stale path is not
//    consent to serve cleartext.
{
  const d = fresh();
  const goneCert = join(d, "gone.crt");
  writeFileSync(goneCert, "x");
  writeBrokerPolicy(d, { version: 1, transport: { kind: "tls-required", certFile: goneCert, keyFile } });
  rmSync(goneCert);
  refuses(() => readBrokerPolicy(d), /certificate is missing/, "missing certificate");
}

// 5. Same for the private key.
{
  const d = fresh();
  const goneKey = join(d, "gone.key");
  writeFileSync(goneKey, "x");
  writeBrokerPolicy(d, { version: 1, transport: { kind: "tls-required", certFile, keyFile: goneKey } });
  rmSync(goneKey);
  refuses(() => readBrokerPolicy(d), /private key is missing/, "missing private key");
}

// 6. Corrupt JSON refuses. A half-written policy from a crashed `up` must not read as "no policy".
{
  const d = fresh();
  writeFileSync(brokerPolicyPath(d), '{"version": 1, "transport": {');
  refuses(() => readBrokerPolicy(d), /not valid JSON/, "truncated policy");
}

// 7. An unknown transport refuses rather than defaulting.
{
  const d = fresh();
  writeFileSync(brokerPolicyPath(d), JSON.stringify({ version: 1, transport: { kind: "sort-of-tls" } }));
  refuses(() => readBrokerPolicy(d), /unknown transport/, "unknown transport kind");
}

// 8. A future schema version refuses rather than guessing at a shape it does not understand.
{
  const d = fresh();
  writeFileSync(brokerPolicyPath(d), JSON.stringify({ version: 2, transport: { kind: "plaintext" } }));
  refuses(() => readBrokerPolicy(d), /unsupported version/, "future version");
}

// 9. TLS declared without both paths refuses. Half a pair is not a configuration.
{
  const d = fresh();
  writeFileSync(brokerPolicyPath(d), JSON.stringify({ version: 1, transport: { kind: "tls-required", certFile } }));
  refuses(() => readBrokerPolicy(d), /both a certFile and a keyFile/, "half a pair");
}

console.log("broker-policy smoke: OK - plaintext and TLS round-trip, .cotal is 0700, and every unusable policy REFUSES rather than degrading to plaintext (missing cert, missing key, corrupt JSON, unknown transport, future version, half pair)");
