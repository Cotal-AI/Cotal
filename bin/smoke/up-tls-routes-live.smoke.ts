/**
 * `cotal up --tls-cert/--tls-key` ENCRYPTS OR REFUSES TO START, on every route to a listener.
 *
 * This suite exists because the previous one did not test the feature. It proved that a
 * TLS-required listener refuses cleartext, that the served leaf matches the file on disk, and that
 * `INFO` advertises `tls_required` — all true, all about the gate, and every one of them still green
 * while `cotal up -f`, `cotal up --detach` and a refresh accepted `--tls-cert` and served PLAINTEXT
 * while printing `✓ mesh up`. A broker that refused every client would have passed it in full.
 *
 * So the shape here is deliberate:
 *
 *  - EVERY ROUTE IS DRIVEN THROUGH THE REAL CLI, as a subprocess, with the operator's own flags.
 *    Nothing is constructed in this file. The three downgrades were all at call boundaries between
 *    `up`'s argument parsing and the code that starts a listener, which is precisely the region a
 *    test that builds its own inputs cannot see.
 *
 *  - EVERY REFUSAL IS PAIRED WITH AN ADMISSION, over the same broker, on the same port, sending the
 *    same CONNECT line, differing in exactly one variable: whether the socket is upgraded to TLS.
 *    Without that pair, "cleartext was refused" is satisfied by a broker that refuses everything,
 *    including one that failed to start.
 *
 *  - THE ADMISSION LEG VERIFIES THE CERTIFICATE PROPERLY rather than routing around the problem.
 *    An earlier version dropped this leg because `isReachable(tls: true)` could not verify a
 *    self-signed certificate, and substituted a handshake-level probe. That was a correct fix to a
 *    real problem and it silently narrowed the claim from "the mesh works over TLS" to "TLS
 *    completes". Here the material is signed by a throwaway CA that is passed to `tls.connect` as
 *    `ca`, with `rejectUnauthorized: true`, so the chain and the hostname are both actually checked.
 *
 *  - REFUSALS ASSERT ON THE REASON, and every refusal cell first proves it reached the RIGHT broker.
 *    `assertCleartextRefused` requires an `INFO` line (a broker exists) advertising `tls_required`
 *    (it is the listener under test) BEFORE it will accept silence as evidence. Without those two,
 *    "no reply" is satisfied by a closed port, a wrong port, or a typo — and since the expected
 *    result is silence, nothing would be left over to look wrong.
 *
 *  - ROUTES A–E RUN `--open` so a refused CONNECT cannot be an auth failure, which is what lets them
 *    assert on the transport. ROUTE F RUNS AUTHED, because testing a fence with the fence disabled
 *    is a structural blind spot: an open-mesh green has hidden a permissions fact repeatedly
 *    elsewhere. It carries its own discriminator — the same credential admitted over TLS and refused
 *    in the clear — so the two questions stay separable rather than collapsing into one boolean.
 *
 * COTAL_HOME is sandboxed and every broker started here is reaped in the `finally`.
 * Needs `nats-server` and `openssl` on PATH. Run: pnpm smoke:up-tls:live  (BUILD FIRST — the CLI
 * subprocess runs built dist, so an unbuilt edit to `packages/core` is invisible to it.)
 */
import { strict as assert } from "node:assert";
import { spawnSync, spawn as spawnProc } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import net from "node:net";
import tls from "node:tls";
import { connect, credsAuthenticator } from "@nats-io/transport-node";

const CLI = join(import.meta.dirname, "..", "cotal.ts");

function need(bin: string): void {
  // Presence, not exit status: `nats-server version` is not a real subcommand and exits non-zero,
  // which says nothing about whether the binary is there. A null status is what "could not spawn"
  // looks like.
  const r = spawnSync(bin, ["--version"], { encoding: "utf8" });
  if (r.status === null)
    throw new Error(`up-tls-routes smoke requires \`${bin}\` on PATH; refusing to skip a security gate`);
}

const root = mkdtempSync(join(tmpdir(), "cotal-uptls-"));
const pki = join(root, "pki");
mkdirSync(pki, { recursive: true });

function sh(cmd: string, args: string[], cwd?: string): void {
  const r = spawnSync(cmd, args, { encoding: "utf8", cwd });
  if (r.status !== 0) throw new Error(`${cmd} ${args.join(" ")} failed: ${r.stderr || r.stdout}`);
}

/** A throwaway CA plus a leaf it signs. The CA is what makes the admission leg a real verification
 *  rather than a disabled one: it is handed to `tls.connect` as `ca`, so `rejectUnauthorized` stays
 *  on and the chain and hostname are genuinely checked. */
function mintPki(): { ca: string; cert: string; key: string; expiredCert: string; expiredKey: string; otherCert: string; otherKey: string } {
  sh("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", join(pki, "ca.key"),
    "-out", join(pki, "ca.pem"), "-days", "2", "-subj", "/CN=cotal-smoke-ca",
    "-addext", "basicConstraints=critical,CA:TRUE"]);

  // The GOOD leaf is CA-signed, because it is the only one a client ever verifies: the admission leg
  // needs a chain it can actually validate with `rejectUnauthorized: true`.
  sh("openssl", ["req", "-newkey", "rsa:2048", "-nodes", "-keyout", join(pki, "good.key"),
    "-out", join(pki, "good.csr"), "-subj", "/CN=good"]);
  writeFileSync(join(pki, "good.ext"), "subjectAltName=DNS:localhost,IP:127.0.0.1\nbasicConstraints=CA:FALSE\n");
  sh("openssl", ["x509", "-req", "-in", join(pki, "good.csr"), "-CA", join(pki, "ca.pem"),
    "-CAkey", join(pki, "ca.key"), "-CAcreateserial", "-out", join(pki, "good.pem"),
    "-days", "2", "-extfile", join(pki, "good.ext")]);

  // EXPIRED. Note the form: `openssl req -x509 -days -1` is REJECTED outright ("Non-positive number"),
  // while `openssl x509 -req -days -1` is accepted and backdates `notBefore` to match. Only the
  // signing form can produce an already-expired certificate, so this one is CA-signed even though
  // nothing ever verifies its chain.
  //
  // Worth stating plainly: `tls-serve`'s `mintCert` carries a comment saying negative days are "how
  // the expiry case is built", and that suite never calls it with a negative value. The expiry case
  // did not exist. This is the first execution of it.
  sh("openssl", ["req", "-newkey", "rsa:2048", "-nodes", "-keyout", join(pki, "expired.key"),
    "-out", join(pki, "expired.csr"), "-subj", "/CN=expired"]);
  sh("openssl", ["x509", "-req", "-in", join(pki, "expired.csr"), "-CA", join(pki, "ca.pem"),
    "-CAkey", join(pki, "ca.key"), "-CAcreateserial", "-out", join(pki, "expired.pem"),
    "-days", "-1", "-extfile", join(pki, "good.ext")]);
  sh("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", join(pki, "other.key"),
    "-out", join(pki, "other.pem"), "-days", "2", "-subj", "/CN=other",
    "-addext", "subjectAltName=DNS:not-this-host.example"]);

  return {
    ca: join(pki, "ca.pem"),
    cert: join(pki, "good.pem"), key: join(pki, "good.key"),
    expiredCert: join(pki, "expired.pem"), expiredKey: join(pki, "expired.key"),
    otherCert: join(pki, "other.pem"), otherKey: join(pki, "other.key"),
  };
}

function freePort(): Promise<number> {
  return new Promise((res) => {
    const s = net.createServer();
    s.listen(0, "127.0.0.1", () => { const p = (s.address() as { port: number }).port; s.close(() => res(p)); });
  });
}

/** Set once `mintPki` has run. Handed to the CLI subprocess as `NODE_EXTRA_CA_CERTS`. */
let caFile = "";

interface Run { status: number | null; out: string }
function cotal(args: string[], home: string, cwd: string, env: Record<string, string> = {}): Run {
  const r = spawnSync("npx", ["tsx", CLI, ...args], {
    encoding: "utf8", cwd, timeout: 180_000,
    // `up` verifies the broker it just started with its OWN client, and `EndpointOptions.tls` is a
    // boolean that cannot carry a CA file — so against a private CA that verification fails and the
    // command exits non-zero even though the listener came up correctly encrypted. Supplying the CA
    // through the documented escape hatch is not a workaround for the test's benefit: it is the
    // exact remedy the changeset tells private-CA operators to use, so this exercises it rather than
    // asserting it works.
    env: { ...process.env, COTAL_HOME: home, NODE_EXTRA_CA_CERTS: caFile, ...env },
  });
  return { status: r.status, out: `${r.stdout ?? ""}${r.stderr ?? ""}` };
}

/** The server's greeting, read in the clear. This is what an on-path attacker sees and can forge,
 *  and it is how we tell an encrypted listener from a plaintext one without trusting the CLI's
 *  own success line — which is the exact thing that lied on three routes. */
function serverInfo(port: number, timeoutMs = 4000): Promise<Record<string, unknown> | undefined> {
  return new Promise((res) => {
    const sock = net.connect(port, "127.0.0.1");
    let buf = "";
    const done = (v: Record<string, unknown> | undefined) => { try { sock.destroy(); } catch { /* */ } res(v); };
    sock.setTimeout(timeoutMs, () => done(undefined));
    sock.on("error", () => done(undefined));
    // A close without a greeting is "nothing usable here" — and without this handler the promise
    // would simply never settle, which surfaces as an unsettled top-level await and no output at all.
    sock.on("close", () => done(undefined));
    sock.on("data", (d) => {
      buf += d.toString("utf8");
      const nl = buf.indexOf("\r\n");
      if (nl < 0) return;
      const line = buf.slice(0, nl);
      try { done(JSON.parse(line.replace(/^INFO\s+/, "")) as Record<string, unknown>); } catch { done(undefined); }
    });
  });
}

/** THE NEGATIVE. A cleartext CONNECT+PING. Any protocol reply at all counts as acceptance, because
 *  producing one means the server parsed our CONNECT in the clear — and a real client's CONNECT line
 *  is where its credentials ride. Requiring a `PONG` specifically would conflate a TLS refusal with
 *  an auth refusal and pass against a plaintext broker; that was this suite's first bug. */
interface Cleartext {
  /** An `INFO` line arrived, so the socket reached A BROKER rather than a closed port. */
  sawInfo: boolean;
  /** That `INFO` advertised `tls_required`, so it reached the RIGHT broker and the right mode. */
  tlsRequired: boolean;
  /** A protocol reply to our cleartext CONNECT. Present means the credential was read in the clear. */
  reply?: string;
}

/**
 * THE THREE OUTCOMES ARE SEPARATE FIELDS, NOT ONE VALUE, AND THAT IS THE POINT.
 *
 * This used to return `string | undefined`, where `undefined` meant BOTH "no INFO ever arrived" and
 * "INFO arrived, CONNECT sent, silence". Those are opposite facts: the first is a broken fixture, the
 * second is the claim. Collapsed together, `reply === undefined` is satisfied by a closed port, a
 * wrong port, a broker that never started, or a typo in the address — every one of which passes a
 * cell whose expected result is silence, leaving nothing over to look wrong.
 *
 * The three existing cells were safe only because `serverInfo` and the `tls_required` assertion
 * happened to run above them in the same block. Nothing forced that ordering, and a new cell or a
 * reordered one got a vacuous pass with no warning. Splitting the fields makes the vacuous
 * construction unwritable rather than merely discouraged.
 *
 * `sawInfo` is deliberately NOT acceptance. A NATS server sends `INFO` on the raw socket before any
 * TLS handshake — that is how `tls_required` is observable at all — so the greeting proves the
 * fixture is aimed correctly and proves nothing about the fence. Only `reply` is acceptance, because
 * producing one means the server parsed our CONNECT, and a real client's CONNECT line carries its
 * credentials. Any of `PONG`, `+OK` or `-ERR` counts: an auth error is the loudest confirmation that
 * the transport fence was absent, since the server had to read the credential to reject it.
 */
function cleartextReply(port: number, connectLine?: string, timeoutMs = 4000): Promise<Cleartext> {
  return new Promise((res) => {
    const sock = net.connect(port, "127.0.0.1");
    let buf = "";
    let sent = false;
    const out: Cleartext = { sawInfo: false, tlsRequired: false };
    const done = () => { try { sock.destroy(); } catch { /* */ } res(out); };
    sock.setTimeout(timeoutMs, done);
    sock.on("error", done);
    // THE REFUSAL USUALLY ARRIVES AS A CLOSE, NOT A SILENCE. A TLS-required listener hangs up on a
    // cleartext CONNECT rather than answering it, so waiting for an inactivity timeout would be both
    // slow and — with no close handler at all — a promise that never settles. That is exactly how
    // this suite first failed: no assertion, no error, no output, just an unsettled await.
    sock.on("close", done);
    sock.on("data", (d) => {
      buf += d.toString("utf8");
      if (!sent && buf.includes("\r\n")) {
        const line = buf.slice(0, buf.indexOf("\r\n"));
        out.sawInfo = /^INFO\s/.test(line);
        try { out.tlsRequired = JSON.parse(line.replace(/^INFO\s+/, "")).tls_required === true; } catch { /* leave false */ }
        sent = true;
        buf = "";
        sock.write(connectLine ?? 'CONNECT {"verbose":true,"pedantic":false,"protocol":1,"lang":"smoke","version":"0"}\r\nPING\r\n');
        return;
      }
      if (sent && /(PONG|\+OK|-ERR)/.test(buf)) { out.reply = buf.split("\r\n")[0]; done(); }
    });
  });
}

/** Assert a cleartext CONNECT was refused BY THE TRANSPORT, with its own positive controls first.
 *  Steps 1 and 2 are what stop step 3 being vacuous, and they belong here rather than in a comment
 *  asking the next caller to remember them. */
function assertCleartextRefused(r: Cleartext, where: string): void {
  assert.equal(r.sawInfo, true,
    `FIXTURE BROKEN (${where}): no INFO on the raw socket, so nothing was reached. "No reply" here ` +
    `would be a pass against a closed port, not evidence of a TLS fence.`);
  assert.equal(r.tlsRequired, true,
    `FIXTURE BROKEN (${where}): the broker reached does not advertise tls_required, so this is not ` +
    `the listener under test. A refusal from it proves nothing about the feature.`);
  assert.equal(r.reply, undefined,
    `GATE FAILED (${where}): a TLS-required listener answered a CLEARTEXT CONNECT with ` +
    `${JSON.stringify(r.reply)}. The server parsed our CONNECT in the clear — which is where a real ` +
    `client's credentials ride.`);
}

/** THE ADMISSION, and the control that makes the negative mean anything. Same broker, same port,
 *  same CONNECT line — the ONE variable that differs is the TLS upgrade. `rejectUnauthorized` is on
 *  and the throwaway CA is supplied, so this fails if the chain is untrusted or the name does not
 *  match, rather than papering over either. */
function admitOverTls(port: number, caFile: string, servername: string, timeoutMs = 8000): Promise<{ ok: boolean; detail: string }> {
  return new Promise((res) => {
    const sock = net.connect(port, "127.0.0.1");
    let buf = "";
    const done = (ok: boolean, detail: string) => { try { sock.destroy(); } catch { /* */ } res({ ok, detail }); };
    sock.setTimeout(timeoutMs, () => done(false, "timeout before INFO"));
    sock.on("error", (e) => done(false, `tcp: ${(e as NodeJS.ErrnoException).code ?? e.message}`));
    sock.on("close", () => done(false, "server closed the connection before the TLS upgrade completed"));
    sock.on("data", (d) => {
      buf += d.toString("utf8");
      if (!buf.includes("\r\n")) return;
      sock.removeAllListeners("data");
      sock.setTimeout(0);
      const up = tls.connect(
        { socket: sock, servername, ca: readFileSync(caFile), rejectUnauthorized: true },
        () => {
          let r = "";
          up.on("data", (b) => {
            r += b.toString("utf8");
            if (/PONG/.test(r)) done(true, "PONG over TLS");
            else if (/-ERR/.test(r)) done(false, `server refused after TLS: ${r.split("\r\n")[0]}`);
          });
          up.write('CONNECT {"verbose":true,"pedantic":false,"protocol":1,"lang":"smoke","version":"0"}\r\nPING\r\n');
        },
      );
      up.setTimeout(timeoutMs, () => done(false, "timeout after TLS upgrade"));
      up.on("error", (e) => done(false, `handshake: ${(e as NodeJS.ErrnoException).code ?? e.message}`));
    });
  });
}

const homes: { home: string; port: number; cwd: string }[] = [];
function sandbox(): { home: string; cwd: string } {
  const home = join(root, `home-${homes.length}`);
  const cwd = join(root, `proj-${homes.length}`);
  mkdirSync(join(cwd, ".cotal"), { recursive: true });
  mkdirSync(home, { recursive: true });
  return { home, cwd };
}


/**
 * Run one route and RECORD its outcome instead of aborting the suite.
 *
 * A fail-fast suite cannot answer the question a mutation proof asks. When the `--detach` threading
 * was deliberately broken, route A reddened correctly and routes B through E never executed — so the
 * run showed that A's assertion was load-bearing and said NOTHING about whether the routes are
 * independently covered. A log that stops at the first failure looks the same as one where the rest
 * were fine.
 *
 * Collecting failures makes the mutation answer both halves: exactly one route red, four green, is
 * evidence of independent coverage. Everything red is evidence of a broken harness.
 */
const outcomes: { route: string; ok: boolean; err?: string }[] = [];
async function route(name: string, fn: () => Promise<void>): Promise<void> {
  try {
    await fn();
    outcomes.push({ route: name, ok: true });
  } catch (e) {
    outcomes.push({ route: name, ok: false, err: e instanceof Error ? e.message : String(e) });
    console.log(`  ✗ ${name}: FAILED`);
  }
}

async function main(): Promise<void> {
  need("nats-server");
  need("openssl");
  const pkiFiles = mintPki();
  caFile = pkiFiles.ca;

  // ── ROUTE A: `up --detach`. Served PLAINTEXT while printing `✓ mesh up`. ──────────────────────
  await route("--detach", async () => {
    const { home, cwd } = sandbox();
    const port = await freePort();
    homes.push({ home, port, cwd });
    const r = cotal(["up", "--detach", "--open", "--server", `nats://127.0.0.1:${port}`,
      "--tls-cert", pkiFiles.cert, "--tls-key", pkiFiles.key], home, cwd);

    const info = await serverInfo(port);
    assert.equal(r.status, 0, `--detach with a valid TLS pair must start: exit ${r.status}\n${r.out}`);
    assert.equal(info?.tls_required, true,
      `GATE FAILED (--detach): listener does not advertise tls_required. This is the downgrade: the ` +
      `command accepted --tls-cert, printed success, and served plaintext.\nINFO: ${JSON.stringify(info)}\n${r.out}`);
    assert.notEqual(info?.tls_available, true, "--detach listener must not be mixed mode (allow_non_tls)");

    const admitted = await admitOverTls(port, pkiFiles.ca, "localhost");
    assert.equal(admitted.ok, true,
      `ADMISSION FAILED (--detach): a legitimate verifying client could not use the mesh over TLS ` +
      `(${admitted.detail}). Without this leg, the refusal below is satisfied by a broker that refuses everything.`);

    // The mesh is --open, so there are no credentials to reject: a refusal here cannot be an auth
    // failure, which is what lets this assert on the REASON rather than on a boolean.
    assertCleartextRefused(await cleartextReply(port), "--detach");
    console.log("  ✓ --detach: tls_required, verifying client ADMITTED (PONG over TLS), cleartext REFUSED");
    cotal(["down"], home, cwd);
  });

  // ── ROUTE B: `up -f manifest`. Same downgrade, different entry point. ─────────────────────────
  await route("-f manifest", async () => {
    const { home, cwd } = sandbox();
    const port = await freePort();
    homes.push({ home, port, cwd });
    writeFileSync(join(cwd, "cotal.yaml"),
      `apiVersion: cotal/v1\nkind: Mesh\nspace: tlsmanifest\nbroker:\n  servers: nats://127.0.0.1:${port}\n  auth: false\nchannels:\n  general:\n    subscribe: []\n`);
    const r = cotal(["up", "-f", "cotal.yaml", "--tls-cert", pkiFiles.cert, "--tls-key", pkiFiles.key], home, cwd);

    const info = await serverInfo(port);
    assert.equal(info?.tls_required, true,
      `GATE FAILED (-f manifest): listener does not advertise tls_required — the manifest route dropped ` +
      `the flags at the call boundary and served plaintext.\nINFO: ${JSON.stringify(info)}\nexit ${r.status}\n${r.out}`);

    const admitted = await admitOverTls(port, pkiFiles.ca, "localhost");
    assert.equal(admitted.ok, true, `ADMISSION FAILED (-f manifest): ${admitted.detail}`);
    assertCleartextRefused(await cleartextReply(port), "-f manifest");
    console.log("  ✓ -f manifest: tls_required, verifying client ADMITTED, cleartext REFUSED");
    cotal(["down"], home, cwd);
  });

  // ── ROUTE C: the already-running refresh. Printed `✓ already running` over an unchanged listener. ─
  await route("refresh", async () => {
    const { home, cwd } = sandbox();
    const port = await freePort();
    homes.push({ home, port, cwd });
    const first = cotal(["up", "--detach", "--open", "--server", `nats://127.0.0.1:${port}`], home, cwd);
    assert.equal(first.status, 0, `plaintext mesh must start for the refresh case:\n${first.out}`);

    const again = cotal(["up", "--server", `nats://127.0.0.1:${port}`,
      "--tls-cert", pkiFiles.cert, "--tls-key", pkiFiles.key], home, cwd);
    assert.notEqual(again.status, 0,
      `GATE FAILED (refresh): \`up --tls-cert\` against an ALREADY RUNNING plaintext mesh exited 0. ` +
      `A running broker cannot change its transport, so this told the operator they had TLS.\n${again.out}`);
    assert.match(again.out, /can't change its transport/,
      `the refusal must name the TRANSPORT as the reason, not a generic failure:\n${again.out}`);
    const info = await serverInfo(port);
    assert.notEqual(info?.tls_required, true, "the running listener must be unchanged by a refused refresh");
    console.log("  ✓ refresh: --tls-cert against a running mesh REFUSED, naming the transport; listener untouched");
    cotal(["down"], home, cwd);
  });

  // ── D: an EXPIRED cert must refuse before launch. nats-server would start and serve it. ───────
  await route("expired-cert", async () => {
    const { home, cwd } = sandbox();
    const port = await freePort();
    homes.push({ home, port, cwd });
    const r = cotal(["up", "--detach", "--open", "--server", `nats://127.0.0.1:${port}`,
      "--tls-cert", pkiFiles.expiredCert, "--tls-key", pkiFiles.expiredKey], home, cwd);
    assert.notEqual(r.status, 0, `an EXPIRED certificate must not yield a started mesh:\n${r.out}`);
    assert.match(r.out, /EXPIRED/, `the refusal must name expiry as the cause:\n${r.out}`);
    assert.equal(await serverInfo(port), undefined, "nothing may be listening after an expired-cert refusal");
    console.log("  ✓ expired cert: refused before launch, naming expiry, no listener");
  });

  // ── E: a cert for the WRONG host must refuse, and say which check failed. ─────────────────────
  await route("wrong-host", async () => {
    const { home, cwd } = sandbox();
    const port = await freePort();
    homes.push({ home, port, cwd });
    const r = cotal(["up", "--detach", "--open", "--server", `nats://127.0.0.1:${port}`,
      "--tls-cert", pkiFiles.otherCert, "--tls-key", pkiFiles.otherKey], home, cwd);
    assert.notEqual(r.status, 0, `a certificate that does not cover the dial host must refuse:\n${r.out}`);
    assert.match(r.out, /does not cover the dial host/, `the refusal must name the host mismatch:\n${r.out}`);
    assert.equal(await serverInfo(port), undefined, "nothing may be listening after a hostname refusal");
    console.log("  ✓ wrong-host cert: refused before launch, naming the mismatch, no listener");
  });


  // ── F: AN AUTHED MESH. Every arm above runs --open, and an open-mesh green has repeatedly hidden
  //    a permissions fact elsewhere in this campaign — testing a fence with the fence disabled is a
  //    structural blind spot, not bad luck. This arm carries its own discriminator so the two
  //    questions stay separable. ──────────────────────────────────────────────────────────────────
  await route("authed", async () => {
    const { home, cwd } = sandbox();
    const port = await freePort();
    homes.push({ home, port, cwd });

    // No --open: auth is the default, so the CLI provisions the space and we never touch
    // `setupSpaceStreams` or the JS API. Both of those carry fixture traps that present as a
    // permissions refusal and would be indistinguishable from a real finding. Driving the real
    // entry point avoids them by construction rather than by care.
    const up = cotal(["up", "--detach", "--server", `nats://127.0.0.1:${port}`,
      "--tls-cert", pkiFiles.cert, "--tls-key", pkiFiles.key], home, cwd);
    assert.equal(up.status, 0, `authed mesh with a valid TLS pair must start: exit ${up.status}\n${up.out}`);

    const credsFile = join(cwd, "probe.creds");
    // `observer`, not `agent`: the agent profile's dm/dlv/chathist grants are lifecycle-keyed exact
    // names (SPEC 13.1) and minting one requires a lifecycleUid that only a real spawn supplies.
    // This cell needs A credential the broker accepts, not a particular role.
    const mint = cotal(["mint", "probe", "--profile", "observer", "--out", credsFile], home, cwd);
    assert.equal(mint.status, 0, `minting a probe credential must succeed:\n${mint.out}`);
    const creds = readFileSync(credsFile, "utf8");

    // ── CELL A: the authed client succeeds OVER TLS. Real credential, real nkey signature, real
    //    verification (`caFile`, so `rejectUnauthorized` stays on). This is the admission half.
    const nc = await connect({
      servers: `127.0.0.1:${port}`,
      authenticator: credsAuthenticator(new TextEncoder().encode(creds)),
      tls: { caFile },
      maxReconnectAttempts: 0,
      timeout: 10_000,
    });
    try {
      await nc.flush();
      // Being pointed somewhere else looks exactly like being refused, so name the target rather
      // than inferring it from success.
      assert.equal(nc.info?.port, port, `CELL A connected to the WRONG broker: ${nc.info?.port} != ${port}`);
      assert.equal(nc.info?.tls_required, true, "CELL A: the broker it reached does not require TLS");
    } finally {
      await nc.close();
    }

    // ── CELL B: the SAME credential, in the clear, must be refused BY THE TRANSPORT.
    //    This cannot be built with the client library: nats.js upgrades the socket itself once it
    //    reads `tls_required`, so a "plaintext" nats.js client SUCCEEDS against a TLS broker. That
    //    is the very fact this feature exists to address, which makes a library-based control
    //    satisfied by the defect it is meant to detect. Raw protocol is the only construction in
    //    which "plaintext" is expressible.
    //
    //    The JWT rides unsigned on purpose. The claim is that the transport refuses BEFORE auth is
    //    consulted, so the server never reaches the signature; and if the fence were missing it
    //    would answer `-ERR Authorization Violation`, which `assertCleartextRefused` counts as
    //    acceptance. An auth error here is the loudest possible proof that the credential was read
    //    in the clear.
    const jwt = /-----BEGIN NATS USER JWT-----\s*([\s\S]*?)\s*-----END NATS USER JWT-----/.exec(creds)?.[1]?.trim();
    assert.ok(jwt, "could not extract the JWT from the minted credential - fixture broken, not a finding");
    const line = `CONNECT {"verbose":true,"pedantic":false,"protocol":1,"lang":"smoke","version":"0","jwt":"${jwt}"}\r\nPING\r\n`;
    assertCleartextRefused(await cleartextReply(port, line), "authed/cleartext");

    console.log("  ✓ authed: TLS+creds ADMITTED (flush, right port), same credential in cleartext REFUSED");
    cotal(["down"], home, cwd);
  });


  // ── G: `cotal web` MUST DEMAND TLS, not merely tolerate it. ─────────────────────────────────────
  //    This is an ENFORCEMENT cell, not a wiring assertion, and the distinction is the point: a
  //    check that the option is present in a constructed object proves the string is there and says
  //    nothing about whether the connection would refuse. So the pair below discriminates on
  //    BEHAVIOUR, one variable apart.
  //
  //    The state is built by the product, not by hand: `up --tls-cert` writes the record, then the
  //    TLS broker is replaced by a PLAINTEXT one on the same port. A client that merely tolerates
  //    TLS connects to that happily; a client that requires it cannot. Before the fix, `web` dropped
  //    `conn.tls` at the CotalEndpoint construction and this cell would have gone green by
  //    connecting — which is the whole failure mode, since the server's cooperation was doing the
  //    work the client should have been doing.
  await route("web+status-demand-tls", async () => {
    for (const command of ["web", "status"] as const) {
      const { home, cwd } = sandbox();
      const port = await freePort();
      homes.push({ home, port, cwd });

      const up = cotal(["up", "--detach", "--open", "--server", `nats://127.0.0.1:${port}`,
        "--tls-cert", pkiFiles.cert, "--tls-key", pkiFiles.key], home, cwd);
      assert.equal(up.status, 0, `TLS mesh must start for the ${command} cell:\n${up.out}`);
      const tlsInfo = await serverInfo(port);
      assert.equal(tlsInfo?.tls_required, true, `${command} cell setup: broker must be TLS-required`);

      // Swap the listener underneath the record: same port, no TLS. `cotal down` is wrong here: it
      // removes the record and makes the command fall back to the default mesh, testing nothing.
      const pidFile = join(cwd, ".cotal", "nats.pid");
      const brokerPid = Number(readFileSync(pidFile, "utf8").trim());
      assert.ok(brokerPid > 0, `could not read the broker pid from ${pidFile} - fixture broken`);
      try { process.kill(brokerPid, "SIGTERM"); } catch { /* already gone */ }
      for (let i = 0; i < 40; i++) {
        if ((await serverInfo(port, 400)) === undefined) break;
        await new Promise((r) => setTimeout(r, 250));
      }
      assert.equal(await serverInfo(port), undefined,
        "fixture: the TLS broker did not stop, so the substitution never happened");
      const nats = spawnProc("nats-server", ["-a", "127.0.0.1", "-p", String(port)], { detached: true, stdio: "ignore" });
      nats.unref();
      for (let i = 0; i < 40; i++) {
        const info = await serverInfo(port, 500);
        if (info && info.tls_required !== true) break;
        await new Promise((r) => setTimeout(r, 250));
      }
      const plainInfo = await serverInfo(port);
      assert.ok(plainInfo, `${command} cell setup: the replacement plaintext broker never answered`);
      assert.notEqual(plainInfo?.tls_required, true, `${command} cell setup: replacement broker must be PLAINTEXT`);

      try {
        const result = command === "web"
          ? cotal(["web", "--port", String(await freePort()), "--no-open"], home, cwd)
          : cotal(["status"], home, cwd);
        // Each command gets its own record because the correct fail-closed preflight prunes the
        // substituted listener. Sharing one makes the second command fall back to the default mesh.
        if (command === "web") {
          assert.notEqual(result.status, 0,
            `GATE FAILED (web): connected to a PLAINTEXT broker while its mesh record requires TLS. ` +
            `The client tolerated the transport instead of demanding it, which is the downgrade this ` +
            `feature exists to prevent.\n${result.out}`);
        } else {
          // `status` is intentionally informational and exits 0 for resolver failures. Its security
          // claim is the rendered verdict: the substituted listener must be UNREACHABLE, never ok.
          assert.match(result.out, /connection\s+.*unreachable/,
            `GATE FAILED (status): did not report the substituted plaintext broker unreachable:\n${result.out}`);
        }
        assert.match(result.out, /tls|TLS|no mesh running|stale registry/,
          `${command} refused, but for none of the transport/reachability reasons — assert on the ` +
          `REASON, or this passes for any startup failure:\n${result.out}`);
        assert.doesNotMatch(result.out, /connection\s+ok/,
          `${command} reported a healthy connection to a substituted plaintext broker:\n${result.out}`);
      } finally {
        try { process.kill(-nats.pid!, "SIGKILL"); } catch { try { nats.kill("SIGKILL"); } catch { /* */ } }
      }
    }
    console.log("  ✓ web + status: both DEMAND TLS — refused a plaintext broker under a TLS-required record");
  });


  // ── H: `--dry-run` VALIDATES BUT DOES NOT PERSIST. ──────────────────────────────────────────────
  //    Hoisting `resolveTransport` above the `--file` branch is what makes the transport dominate
  //    every route, and it put a WRITE in front of a command whose whole contract is "mutate
  //    nothing": `up -f --dry-run --tls-cert` printed "nothing was changed" and left a
  //    broker-policy.json behind. An instrument that modifies what it inspects is a defect even
  //    when everything it reports is true.
  //
  //    Both halves are asserted, because suppressing the write is only correct if the CHECKING
  //    survives: a dry run that stopped refusing an expired certificate would be a worse bug than
  //    the one being fixed.
  await route("dry-run-no-write", async () => {
    const { home, cwd } = sandbox();
    const port = await freePort();
    writeFileSync(join(cwd, "cotal.yaml"),
      `apiVersion: cotal/v1\nkind: Mesh\nspace: tlsdry\nbroker:\n  servers: nats://127.0.0.1:${port}\n  auth: false\nchannels:\n  general:\n    subscribe: []\n`);
    const policy = join(cwd, ".cotal", "broker-policy.json");

    const dry = cotal(["up", "-f", "cotal.yaml", "--dry-run",
      "--tls-cert", pkiFiles.cert, "--tls-key", pkiFiles.key], home, cwd);
    assert.equal(dry.status, 0, `a valid dry run must succeed:\n${dry.out}`);
    assert.equal(existsSync(policy), false,
      `GATE FAILED (dry-run): the broker policy was WRITTEN by a command that printed "nothing was ` +
      `changed". ${policy}`);
    assert.equal(await serverInfo(port), undefined, "a dry run must start no listener");

    // The other half: validation must still run, or suppressing the write broke the check.
    const bad = cotal(["up", "-f", "cotal.yaml", "--dry-run",
      "--tls-cert", pkiFiles.expiredCert, "--tls-key", pkiFiles.expiredKey], home, cwd);
    assert.notEqual(bad.status, 0, `a dry run with an EXPIRED cert must still refuse:\n${bad.out}`);
    assert.match(bad.out, /EXPIRED/, `the dry-run refusal must name expiry:\n${bad.out}`);
    assert.equal(existsSync(policy), false, "a refused dry run must not write the policy either");
    console.log("  ✓ dry-run: validates (expired refused) and writes NOTHING");
  });


  // ── I: A POST-START FAILURE MUST NOT LEAVE AN ORPHAN LISTENER. ──────────────────────────────────
  //    The port is bound and `nats.pid` written before the mesh is recorded, so a throw in between
  //    used to exit non-zero while leaving a live broker that `cotal down` cannot reach — it works
  //    from the registry, and there is no entry. A third state between started and refused.
  //
  //    Reachable only BECAUSE of TLS: the post-start client verifies the certificate, so a private
  //    CA with no `NODE_EXTRA_CA_CERTS` fails after the listener is up. The feature introduced the
  //    state, so the feature tears it down.
  await route("no-orphan-on-postfail", async () => {
    const { home, cwd } = sandbox();
    const port = await freePort();
    homes.push({ home, port, cwd });
    // NODE_EXTRA_CA_CERTS deliberately BLANK: this is the operator who forgot it.
    const r = cotal(["up", "--detach", "--open", "--server", `nats://127.0.0.1:${port}`,
      "--tls-cert", pkiFiles.cert, "--tls-key", pkiFiles.key], home, cwd, { NODE_EXTRA_CA_CERTS: "" });

    // CONTROL: the failure must be the POST-START one, not an earlier refusal — otherwise this cell
    // passes for the wrong reason and proves nothing about teardown.
    assert.notEqual(r.status, 0, `an untrusted CA must fail the post-start verification:\n${r.out}`);
    assert.match(r.out, /TLS: serving/,
      `CONTROL FAILED: the listener never started, so this is not the post-start path and the ` +
      `teardown was never exercised:\n${r.out}`);
    assert.match(r.out, /self-signed|unable to verify|certificate/,
      `CONTROL FAILED: failed for some reason other than certificate verification:\n${r.out}`);

    // THE CLAIM: nothing is left holding the port.
    assert.equal(await serverInfo(port), undefined,
      `GATE FAILED: a broker survived a post-start failure and is holding ${port} with no registry ` +
      `entry — \`cotal down\` cannot reach it, because it works from the registry.`);
    console.log("  ✓ post-start failure: listener torn down, no orphan holding the port");
  });

  // The per-route table is the artifact a mutation proof reads. Printed always, pass or fail.
  console.log("  ── route outcomes ──");
  for (const o of outcomes) {
    console.log(`  ${o.ok ? "PASS" : "FAIL"}  ${o.route}`);
    // The WHOLE error, not its first line. Assertion messages here embed the CLI's own output,
    // which is the part that explains the failure — truncating to one line discards exactly the
    // evidence and forces a second run to recover it.
    if (!o.ok) console.log((o.err ?? "").split("\n").map((l) => `        ${l}`).join("\n"));
  }
  const failed = outcomes.filter((o) => !o.ok);
  if (outcomes.length !== 9)
    throw new Error(`HARNESS: expected 9 routes, recorded ${outcomes.length} — a route did not run at all`);
  if (failed.length > 0)
    throw new Error(`${failed.length}/9 routes FAILED: ${failed.map((f) => f.route).join(", ")}`);
  console.log("✓ up-tls-routes: 9/9 routes encrypt or refuse; admission proved on each, one variable apart");
}

try {
  await main();
} finally {
  for (const h of homes) {
    try { cotal(["down"], h.home, h.cwd); } catch { /* best effort */ }
  }
  try { rmSync(root, { recursive: true, force: true }); } catch { /* */ }
}
