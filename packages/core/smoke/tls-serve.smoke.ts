import { strict as assert } from "node:assert";
import { writeFileSync, mkdirSync, mkdtempSync, openSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn, spawnSync } from "node:child_process";
import net from "node:net";
import tlsMod from "node:tls";
import { createSpaceAuth, serverConfig, openServerConfig, mintCreds, newIdentity, isReachable, validateTlsMaterial, probeServedCert } from "../src/index.js";
import { SMOKE_BROKER_TOKEN, teardownOnSignal } from "@cotal-ai/smoke-kit";

// The broker-TLS fence, proved by EXECUTION rather than by inspecting the rendered config.
//
// A config file that contains a `tls` block proves nothing: nats-server can hold a tls block and
// still serve a listener that a plaintext client talks to (mixed mode), and it will happily start
// and serve an EXPIRED cert. So every assertion here drives a real client against a real broker.
//
// The gating property is the REFUSAL: a plaintext client MUST NOT be able to complete the NATS
// handshake against a TLS-required listener. The reason this matters is not confidentiality in the
// abstract — a flagless NATS client sends its credentials in the CONNECT line, so a listener that
// accepts plaintext accepts credentials in the clear.
//
// Non-circularity is built in: `plaintextConnectAccepted` is asserted TRUE against a plaintext
// broker in the same run. Without that control, "the plaintext client was refused" would also be
// satisfied by a probe that is simply broken, or by a broker that never started at all.
const dir = mkdtempSync(join(tmpdir(), SMOKE_BROKER_TOKEN));
const space = "tlsserve";
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// nats-server is handed cert/key PATHS, so the material has to exist on disk. We mint it per-run
// instead of committing a fixture: a committed key is a private key in the repo, and a committed
// cert has a fixed expiry that eventually turns an unrelated suite red. Fail loud if openssl is
// missing rather than skipping — a security smoke that silently no-ops is worse than absent.
function requireOpenssl(): void {
  const r = spawnSync("openssl", ["version"], { encoding: "utf8" });
  if (r.error || r.status !== 0)
    throw new Error("tls-serve smoke requires the `openssl` CLI on PATH to mint throwaway certs; refusing to skip a security gate");
}

/** Mint a throwaway self-signed cert/key pair. `days` may be negative to mint an ALREADY-EXPIRED
 *  cert (openssl backdates `notBefore` by the same amount), which is how the expiry case is built. */
function mintCert(name: string, cn: string, san: string, days = 3650): { certFile: string; keyFile: string } {
  const certFile = join(dir, `${name}.crt`), keyFile = join(dir, `${name}.key`);
  const r = spawnSync("openssl", [
    "req", "-x509", "-newkey", "rsa:2048", "-nodes",
    "-keyout", keyFile, "-out", certFile,
    "-days", String(days), "-subj", `/CN=${cn}`, "-addext", `subjectAltName=${san}`,
  ], { encoding: "utf8" });
  if (r.status !== 0) throw new Error(`openssl failed minting ${name}: ${r.stderr}`);
  return { certFile, keyFile };
}

/** Send a CONNECT+PING in CLEARTEXT and report whether the server answered at the NATS protocol
 *  level. Deliberately raw rather than a nats.js client: nats.js auto-upgrades to TLS when INFO
 *  advertises `tls_required`, which would mask the very thing under test. We need to know what
 *  happens to a peer that STAYS in cleartext.
 *
 *  "Accepted" means ANY protocol reply — `PONG`, `+OK`, or even `-ERR 'Authorization Violation'`.
 *  An auth rejection still counts, and that is the whole point: to produce it the server had to
 *  RECEIVE AND PARSE our CONNECT line in the clear, and a real client's CONNECT line is where its
 *  credentials live. Requiring a PONG instead would conflate a TLS refusal with an auth refusal
 *  and make the gate vacuous against this repo's JWT-mode brokers, which reject anonymous clients
 *  whether or not TLS is on. */
function plaintextConnectAccepted(host: string, port: number): Promise<{ accepted: boolean; reply: string }> {
  return new Promise((resolve) => {
    const sock = net.connect(port, host);
    let buf = "", sentConnect = false, settled = false;
    const done = (accepted: boolean) => {
      if (settled) return;
      settled = true;
      sock.destroy();
      const after = buf.slice(buf.indexOf("\r\n") + 2).trim();
      resolve({ accepted, reply: after.slice(0, 120) });
    };
    // A TLS-required server drops the connection rather than answering, so silence is a refusal.
    sock.setTimeout(5000, () => done(false));
    sock.on("data", (d) => {
      buf += d.toString();
      if (!sentConnect && buf.includes("\r\n")) {
        sentConnect = true;
        sock.write('CONNECT {"verbose":true,"pedantic":false,"protocol":1,"lang":"smoke","version":"0"}\r\nPING\r\n');
        return;
      }
      if (/PONG|\+OK|-ERR/.test(buf.slice(buf.indexOf("\r\n") + 2))) done(true);
    });
    sock.on("error", () => done(false));
    sock.on("close", () => done(false));
  });
}

/** Read the server's unauthenticated INFO line — the same plaintext greeting an on-path attacker
 *  sees and can forge. Used to assert the server ADVERTISES tls_required, which is what a
 *  flagless client keys off when it decides to upgrade. */
function readInfo(host: string, port: number): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const sock = net.connect(port, host);
    let buf = "";
    sock.setTimeout(5000, () => { sock.destroy(); reject(new Error("no INFO within 5s")); });
    sock.on("data", (d) => {
      buf += d.toString();
      const line = buf.split("\r\n")[0];
      if (line?.startsWith("INFO ")) { sock.destroy(); resolve(JSON.parse(line.slice(5))); }
    });
    sock.on("error", reject);
  });
}

/** Wait until the broker is actually answering, by polling for its INFO line.
 *
 *  This replaces a fixed `sleep()` after each spawn, and the difference matters beyond tidiness.
 *  A fixed wait encodes an assumption about how fast the machine is, and this box runs several
 *  campaigns' gates at once — under load a broker can take longer than any constant you pick, and
 *  the suite then fails for scheduling reasons rather than code reasons. A red manufactured by CPU
 *  contention is worse than a slow suite: someone spends an hour proving it was noise, and the
 *  lesson everyone actually learns is to discount reds. Poll for the condition instead. */
async function waitForBroker(host: string, port: number, log: string, timeoutMs = 20_000): Promise<Record<string, unknown>> {
  const deadline = Date.now() + timeoutMs;
  let last = "";
  while (Date.now() < deadline) {
    try {
      return await readInfo(host, port);
    } catch (e) {
      last = (e as Error).message;
      await sleep(100);
    }
  }
  throw new Error(`broker at ${host}:${port} never served INFO within ${timeoutMs}ms (last: ${last})\n${readFileSync(log, "utf8").split("\n").slice(-8).join("\n")}`);
}

/** Grab a port the OS says is free right now. Fixed ports are a standing hazard in this suite:
 *  a run that dies on an assertion can leave its broker holding the port, and the NEXT run then
 *  fails with "address already in use" — a cascading red that looks like a product bug and is not.
 *  This box also hosts other campaigns' brokers, so squatting on a guessed number is antisocial. */
function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.once("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const port = (srv.address() as net.AddressInfo).port;
      srv.close(() => resolve(port));
    });
  });
}

// Every broker this smoke starts, so the finally-block can reap them even when an assertion throws.
const started: Array<{ tag: string; child: ReturnType<typeof spawn>; release: () => void }> = [];
function killAll(): void {
  for (const s of started) {
    try { s.child.kill("SIGKILL"); } catch { /* already gone */ }
    s.release();
  }
  started.length = 0;
}
process.on("exit", killAll);

async function startBroker(tag: string, conf: string): Promise<{ log: string; kill: () => void }> {
  const log = join(dir, `${tag}.log`);
  const fd = openSync(log, "w");
  const child = spawn("nats-server", ["-c", conf], { stdio: ["ignore", fd, fd] });
  // Each broker is owned, and each carries the one shared scratch dir: removing it is idempotent
  // under `force`, and it means whichever broker is still owned when a signal lands takes the
  // directory with it rather than leaving it to whichever one happened to be reaped last.
  const entry = { tag, child, release: teardownOnSignal(child, dir) };
  started.push(entry);
  // A broker that dies at boot (bad cert, bound port) must not surface later as a mysterious
  // assertion failure — say so at the point of death, with the log that explains it.
  child.on("exit", (code, signal) => {
    if (code !== 0 && code !== null && !signal)
      console.error(`  [${tag}] nats-server exited ${code}:\n${readFileSync(log, "utf8").split("\n").slice(-6).join("\n")}`);
  });
  return {
    log,
    kill: () => { try { child.kill("SIGTERM"); } catch { /* already gone */ } },
  };
}

requireOpenssl();
const auth = await createSpaceAuth(space);
const creds = await mintCreds(auth, newIdentity(), "provisioner");
const valid = mintCert("valid", "127.0.0.1", "IP:127.0.0.1,DNS:localhost");
// Validate once up front: this both exercises the accept path of `validateTlsMaterial` and gives
// every served-leaf comparison below a single source of truth for what SHOULD be on the wire.
const validMaterial = validateTlsMaterial(
  { kind: "tls-required", certFile: valid.certFile, keyFile: valid.keyFile },
  { dialHost: "localhost" },
);

// ---------------------------------------------------------------------------------------------
// CONTROL: a PLAINTEXT broker. Establishes that the probe can detect a completed handshake at all.
// Without this the TLS assertion below is unfalsifiable.
// ---------------------------------------------------------------------------------------------
try {
const plainPort = await freePort(), plainStore = join(dir, "plain-js"), plainConf = join(dir, "plain.conf");
mkdirSync(plainStore, { recursive: true });
writeFileSync(plainConf, serverConfig(auth, [auth], { transport: { kind: "plaintext" }, port: plainPort, storeDir: plainStore }));
const plain = await startBroker("plain", plainConf);
{
  let up = false;
  for (let i = 0; i < 50; i++) { if (await isReachable(`nats://127.0.0.1:${plainPort}`, { creds })) { up = true; break; } await sleep(200); }
  if (!up) throw new Error(`plaintext broker not up:\n${readFileSync(plain.log, "utf8")}`);
}
{
  const r = await plaintextConnectAccepted("127.0.0.1", plainPort);
  assert.equal(
    r.accepted, true,
    `CONTROL FAILED: a cleartext CONNECT got no protocol reply from a PLAINTEXT broker (saw ${JSON.stringify(r.reply)}). The probe is broken, so the TLS refusal below would prove nothing.`,
  );
  console.log(`  control: plaintext broker parsed our cleartext CONNECT and replied ${JSON.stringify(r.reply.split("\n")[0])}`);
}
const plainInfo = await readInfo("127.0.0.1", plainPort);
assert.notEqual(plainInfo.tls_required, true, "plaintext broker must not advertise tls_required");
plain.kill();
await sleep(300);

// ---------------------------------------------------------------------------------------------
// THE GATE: a TLS-REQUIRED broker must REFUSE a plaintext client, and accept a strict one.
// ---------------------------------------------------------------------------------------------
const tlsPort = await freePort(), tlsStore = join(dir, "tls-js"), tlsConf = join(dir, "tls.conf");
mkdirSync(tlsStore, { recursive: true });
writeFileSync(tlsConf, serverConfig(auth, [auth], {
  port: tlsPort, storeDir: tlsStore,
  transport: { kind: "tls-required", certFile: valid.certFile, keyFile: valid.keyFile },
}));
const tls = await startBroker("tls", tlsConf);
const tlsInfo = await waitForBroker("127.0.0.1", tlsPort, tls.log);
assert.equal(tlsInfo.tls_required, true, `TLS broker must advertise tls_required; INFO was ${JSON.stringify(tlsInfo)}`);
// `allow_non_tls` would surface as tls_available WITHOUT tls_required, i.e. mixed mode, which
// permits exactly the cleartext credential path this feature exists to close.
assert.notEqual(tlsInfo.tls_available, true, "TLS broker must not advertise tls_available (that is mixed mode / allow_non_tls)");

{
  const r = await plaintextConnectAccepted("127.0.0.1", tlsPort);
  assert.equal(
    r.accepted, false,
    `GATE FAILED: a TLS-REQUIRED listener parsed a cleartext CONNECT and replied ${JSON.stringify(r.reply)}. A real client's CONNECT line carries its credentials, so this is cleartext credential exposure.`,
  );
}

// The honest path still has to work, or a listener that simply refuses EVERYTHING would satisfy
// the gate above. So: complete a real STARTTLS upgrade and speak NATS over it.
//
// This deliberately does NOT use `isReachable(..., { tls: true })`. Our client maps `tls: true` to
// nats.js `tls: {}`, which verifies against Node/system trust and therefore cannot be pointed at a
// privately-issued CA — `EndpointOptions.tls` is a boolean with nowhere to put a `caFile`. That is
// a real, named product gap for private-PKI operators (today they must set NODE_EXTRA_CA_CERTS on
// the process), and it is a FOLLOW-UP, not something to paper over here. Asserting it with an
// explicitly-trusting TLS client keeps this smoke honest about what it proves: the listener really
// is serving TLS and really does speak NATS over it.
{
  // `probeServedCert` performs the real STARTTLS dance — plain TCP, read INFO, upgrade the SAME
  // socket — which is the only way in: NATS defaults to `handshake_first: false`, so a TLS-first
  // dial gets "TLS handshake error: EOF" from a server that is perfectly healthy.
  const served = await probeServedCert({ host: "127.0.0.1", port: tlsPort, servername: "localhost" });

  // And the leaf it served must be exactly the file we installed. This is the primitive the
  // rotation path is built on, and it is the check the reference deployment lacked: there, the
  // cert FILES were renewed while the running broker went on serving the previous certificate,
  // so anything comparing mtimes or trusting a reload's exit code would have reported success.
  assert.equal(
    served.fingerprint256, validMaterial.fingerprint256,
    `the broker is serving a different leaf than the file on disk: served ${served.fingerprint256}, file ${validMaterial.fingerprint256}`,
  );
  console.log(`  honest path: STARTTLS completed; served leaf matches the file on disk (${served.fingerprint256.slice(0, 17)}...)`);
}
tls.kill();
await sleep(300);

// ---------------------------------------------------------------------------------------------
// OPEN (NO-AUTH) MODE. This is the path that used to bypass every renderer: `cotal up` started an
// open broker from bare CLI flags, so a cert/key pair would have been accepted while the listener
// came up in cleartext — the silent downgrade, reachable by an operator who did everything right.
// Now open mode renders a config too, so the required transport union covers BOTH modes.
//
// The control is STRONGER here than under auth. An open broker answers a cleartext client with a
// real PONG rather than `-ERR 'Authorization Violation'`, so "the plaintext peer was accepted" is
// unambiguous — there is no auth refusal to confuse with a transport refusal.
//
// Note what open-mode TLS does and does not buy: CONFIDENTIALITY, NOT AUTHENTICATION. Anyone who
// can reach the port still gets in; the traffic is merely hidden from a passive observer.
{
  const openPlainPort = await freePort(), openTlsPort = await freePort();
  const openPlainStore = join(dir, "open-plain-js"), openTlsStore = join(dir, "open-tls-js");
  mkdirSync(openPlainStore, { recursive: true });
  mkdirSync(openTlsStore, { recursive: true });

  const openPlainConf = join(dir, "open-plain.conf"), openTlsConf = join(dir, "open-tls.conf");
  writeFileSync(openPlainConf, openServerConfig({ port: openPlainPort, storeDir: openPlainStore, transport: { kind: "plaintext" } }));
  writeFileSync(openTlsConf, openServerConfig({
    port: openTlsPort, storeDir: openTlsStore,
    transport: { kind: "tls-required", certFile: valid.certFile, keyFile: valid.keyFile },
  }));

  const openPlain = await startBroker("open-plain", openPlainConf);
  await waitForBroker("127.0.0.1", openPlainPort, openPlain.log);
  const acceptedPlain = await plaintextConnectAccepted("127.0.0.1", openPlainPort);
  assert.equal(
    acceptedPlain.accepted, true,
    `CONTROL FAILED: an OPEN plaintext broker did not answer a cleartext CONNECT (saw ${JSON.stringify(acceptedPlain.reply)})`,
  );
  assert.match(
    acceptedPlain.reply, /PONG/,
    `an OPEN plaintext broker should answer PING with PONG (no auth in the way); saw ${JSON.stringify(acceptedPlain.reply)}`,
  );
  openPlain.kill();
  await sleep(300);

  const openTls = await startBroker("open-tls", openTlsConf);
  const openInfo = await waitForBroker("127.0.0.1", openTlsPort, openTls.log);
  assert.equal(openInfo.tls_required, true, `OPEN-mode TLS broker must advertise tls_required; INFO was ${JSON.stringify(openInfo)}`);
  assert.notEqual(openInfo.tls_available, true, "OPEN-mode TLS broker must not advertise tls_available (mixed mode)");

  const refused = await plaintextConnectAccepted("127.0.0.1", openTlsPort);
  assert.equal(
    refused.accepted, false,
    `GATE FAILED (open mode): a TLS-required OPEN listener answered a cleartext CONNECT with ${JSON.stringify(refused.reply)}. This is the exact path that previously bypassed the renderer.`,
  );
  const openServed = await probeServedCert({ host: "127.0.0.1", port: openTlsPort, servername: "localhost" });
  assert.equal(openServed.fingerprint256, validMaterial.fingerprint256, "open-mode broker served a different leaf than the file on disk");
  openTls.kill();
  console.log(`  open mode: plaintext broker answered ${JSON.stringify(acceptedPlain.reply.replace(/\r\n/g, " "))}; TLS-required open listener refused cleartext and served the expected leaf`);
}

console.log("tls-serve smoke: OK - cleartext refused by TLS-required listeners in BOTH auth and open mode, served leaf matches disk, controls proved each probe detects a real handshake");
} finally {
  killAll();
  // The scratch dir goes with them. Its absence here is why this suite leaked a directory on
  // every green run: the brokers were reaped and the tree they wrote was not.
  rmSync(dir, { recursive: true, force: true });
}
