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
 * Sandbox: each cell gets its own `COTAL_HOME` **and** a temp project `cwd` with its own `.cotal/`.
 * `COTAL_HOME` alone only relocates the mesh registry; broker policy, the NATS store, and pidfiles
 * follow `findCotalRoot` from cwd. A probe that sets only `COTAL_HOME` and runs `cotal up` from a
 * tree whose walked root is the operator home can still write live operator config — do not copy
 * that pattern. Every broker started here is reaped in the `finally`.
 * Needs `nats-server` and `openssl` on PATH. Run: pnpm smoke:up-tls:live  (BUILD FIRST — the CLI
 * subprocess runs built dist, so an unbuilt edit to `packages/core` is invisible to it.)
 */
import { strict as assert } from "node:assert";
import { spawnSync, spawn as spawnProc } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
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

  // EXPIRED. OpenSSL 3.4+ accepts absolute `-not_before`/`-not_after`; 3.0.x does not (and 3.6+
  // rejects `-days -1`). Try absolute dates first, fall back to `-days -1` which yields an
  // already-expired leaf on 3.0.x. CA-signed even though nothing verifies its chain.
  sh("openssl", ["req", "-newkey", "rsa:2048", "-nodes", "-keyout", join(pki, "expired.key"),
    "-out", join(pki, "expired.csr"), "-subj", "/CN=expired"]);
  try {
    sh("openssl", ["x509", "-req", "-in", join(pki, "expired.csr"), "-CA", join(pki, "ca.pem"),
      "-CAkey", join(pki, "ca.key"), "-CAcreateserial", "-out", join(pki, "expired.pem"),
      "-not_before", "20200101000000Z", "-not_after", "20200102000000Z",
      "-extfile", join(pki, "good.ext")]);
  } catch {
    sh("openssl", ["x509", "-req", "-in", join(pki, "expired.csr"), "-CA", join(pki, "ca.pem"),
      "-CAkey", join(pki, "ca.key"), "-CAcreateserial", "-out", join(pki, "expired.pem"),
      "-days", "-1", "-extfile", join(pki, "good.ext")]);
  }
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
          // BOTH surfaces matter: Selected Mesh (connection line) AND Recorded Meshes (list row).
          // A fix that reds only the selected line while the list still prints green `reachable`
          // via a bare TCP/INFO probe is the FAIL1 residual that greened a substitute in one
          // section while redding another — operators read the list first.
          assert.match(result.out, /connection\s+.*unreachable/,
            `GATE FAILED (status): did not report the substituted plaintext broker unreachable:\n${result.out}`);
          assert.match(result.out, /\bdown\b/,
            `GATE FAILED (status Recorded Meshes): list did not mark the TLS-required mesh down ` +
            `under a plaintext substitute (still greening via bare isReachable):\n${result.out}`);
          assert.doesNotMatch(result.out, /\breachable\b/,
            `GATE FAILED (status Recorded Meshes): still printed green "reachable" for a ` +
            `tlsRequired mesh against a plaintext substitute:\n${result.out}`);
        }
        assert.match(result.out, /tls|TLS|no mesh running|stale registry|unreachable|down/,
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

    // CONTROL: the failure must be certificate verification after the listener bound the port —
    // not an earlier refusal (expired cert, half-pair). Commit-after-apply no longer prints
    // "TLS: serving" before the listener is proved, so the control keys on the cert cause and on
    // evidence the broker process was started (pid file or "Started nats-server"), then torn down.
    assert.notEqual(r.status, 0, `an untrusted CA must fail verification:\n${r.out}`);
    assert.match(r.out, /self-signed|unable to verify|certificate|not become reachable/,
      `CONTROL FAILED: failed for some reason other than certificate/reachability verification:\n${r.out}`);
    assert.doesNotMatch(r.out, /EXPIRED|must be given together|can't change its transport/,
      `CONTROL FAILED: this is a pre-start refusal, not the post-bind teardown path:\n${r.out}`);

    // THE CLAIM: nothing is left holding the port.
    assert.equal(await serverInfo(port), undefined,
      `GATE FAILED: a broker survived a post-start failure and is holding ${port} with no registry ` +
      `entry — \`cotal down\` cannot reach it, because it works from the registry.`);
    console.log("  ✓ post-start failure: listener torn down, no orphan holding the port");
  });

  // ── J: POLICY ROOT MUST BE THE FINAL MESH ROOT (S4). ───────────────────────────────────────────
  //    When the nearest ancestor root already owns a different auth space, `ensureRootForSpace`
  //    creates `cwd/.cotal` for the new space. That pin used to run AFTER `resolveTransport`, so
  //    the TLS policy was written to the PARENT while the listener and MeshEntry landed on the
  //    CHILD. First `up --tls-*` looked green (transport in memory); `down` then bare `up` from
  //    the child found no policy and served plaintext. Also polluted the parent's policy file.
  //
  //    The gate is the documented retain path: parent auth mesh → child TLS up → down → bare up
  //    still TLS; child policy exists; parent policy unchanged by the child launch.
  await route("policy-root-before-transport", async () => {
    const home = join(root, `home-s4`);
    const parent = join(root, `parent-s4`);
    const child = join(parent, `child-s4`);
    mkdirSync(join(parent, ".cotal"), { recursive: true });
    mkdirSync(child, { recursive: true });
    mkdirSync(home, { recursive: true });
    const parentPort = await freePort();
    const childPort = await freePort();
    homes.push({ home, port: parentPort, cwd: parent });
    homes.push({ home, port: childPort, cwd: child });

    const parentUp = cotal(["up", "--detach", "--space", "parent-space",
      "--server", `nats://127.0.0.1:${parentPort}`], home, parent);
    assert.equal(parentUp.status, 0, `parent auth mesh must start:\n${parentUp.out}`);
    const parentPolicyBefore = join(parent, ".cotal", "broker-policy.json");
    const parentPolicySnap = existsSync(parentPolicyBefore)
      ? readFileSync(parentPolicyBefore, "utf8") : null;

    const childUp = cotal(["up", "--detach", "--space", "child-space",
      "--server", `nats://127.0.0.1:${childPort}`,
      "--tls-cert", pkiFiles.cert, "--tls-key", pkiFiles.key], home, child);
    assert.equal(childUp.status, 0, `child TLS mesh must start:\n${childUp.out}`);
    assert.match(childUp.out, /making this folder its own root|TLS: serving/,
      `CONTROL: expected a root pin and/or TLS serving line:\n${childUp.out}`);

    const childPolicy = join(child, ".cotal", "broker-policy.json");
    assert.equal(existsSync(childPolicy), true,
      `GATE FAILED (S4): child has no broker-policy.json — policy was written to the wrong root`);
    assert.match(readFileSync(childPolicy, "utf8"), /tls-required/,
      `GATE FAILED (S4): child policy is not tls-required:\n${readFileSync(childPolicy, "utf8")}`);

    if (parentPolicySnap === null) {
      assert.equal(existsSync(parentPolicyBefore), false,
        `GATE FAILED (S4): child launch wrote a policy into the parent root`);
    } else {
      assert.equal(readFileSync(parentPolicyBefore, "utf8"), parentPolicySnap,
        `GATE FAILED (S4): child launch mutated the parent's broker-policy.json`);
    }

    const firstInfo = await serverInfo(childPort);
    assert.equal(firstInfo?.tls_required, true, "first child listener must require TLS");
    assertCleartextRefused(await cleartextReply(childPort), "s4/first-up");

    cotal(["down"], home, child);
    const bare = cotal(["up", "--detach", "--space", "child-space",
      "--server", `nats://127.0.0.1:${childPort}`], home, child);
    assert.equal(bare.status, 0, `bare child re-up must inherit TLS policy:\n${bare.out}`);
    assert.match(bare.out, /inheriting the recorded broker policy|TLS: serving/,
      `bare re-up must name the inherited TLS decision:\n${bare.out}`);

    const bareInfo = await serverInfo(childPort);
    assert.equal(bareInfo?.tls_required, true,
      `GATE FAILED (S4): bare re-up after down served plaintext — the retain path evaporated`);
    assertCleartextRefused(await cleartextReply(childPort), "s4/bare-reup");

    // Registry bit must still claim TLS (a green first session that rewrites the bit off is the
    // same defect wearing a different hat).
    const meshes = cotal(["meshes"], home, child);
    assert.match(meshes.out, /child-space/, `meshes must list the child:\n${meshes.out}`);
    // The record is a JSON file under COTAL_HOME; assert the durable field, not display copy.
    const meshesDir = join(home, "meshes");
    const recPath = spawnSync("bash", ["-lc",
      `grep -l 'child-space' "${meshesDir}"/*.json 2>/dev/null | head -1`], { encoding: "utf8" }).stdout.trim();
    assert.ok(recPath, `CONTROL: no mesh record for child-space under ${meshesDir}`);
    const rec = JSON.parse(readFileSync(recPath, "utf8")) as { tlsRequired?: boolean; root?: string };
    assert.equal(rec.tlsRequired, true,
      `GATE FAILED (S4): MeshEntry.tlsRequired rewritten false after bare re-up:\n${JSON.stringify(rec)}`);
    // macOS: /var → /private/var; compare realpaths so a symlink does not look like a wrong root.
    assert.equal(realpathSync(rec.root ?? ""), realpathSync(child),
      `GATE FAILED (S4): MeshEntry.root is not the child root:\n${JSON.stringify(rec)}`);

    console.log("  ✓ S4: child TLS policy on child root; bare re-up retains TLS; parent policy untouched");
    cotal(["down"], home, child);
    cotal(["down"], home, parent);
  });

  // ── J2: S4 OPEN-CHILD ARM — pin is mode-independent. ───────────────────────────────────────────
  //    Auth→auth was closed; open child under a foreign ancestor still wrote into the parent root
  //    (ensureRootForSpace early-returned when !useAuth). Same retain gate with --open.
  await route("policy-root-open-child", async () => {
    const home = join(root, `home-s4o`);
    const parent = join(root, `parent-s4o`);
    const child = join(parent, `child-s4o`);
    mkdirSync(join(parent, ".cotal"), { recursive: true });
    mkdirSync(child, { recursive: true });
    mkdirSync(home, { recursive: true });
    const parentPort = await freePort();
    const childPort = await freePort();
    homes.push({ home, port: parentPort, cwd: parent });
    homes.push({ home, port: childPort, cwd: child });

    const parentUp = cotal(["up", "--detach", "--space", "parent-oa",
      "--server", `nats://127.0.0.1:${parentPort}`], home, parent);
    assert.equal(parentUp.status, 0, `parent auth mesh must start:\n${parentUp.out}`);
    const parentPolicyBefore = join(parent, ".cotal", "broker-policy.json");
    const parentPidBefore = existsSync(join(parent, ".cotal", "nats.pid"))
      ? readFileSync(join(parent, ".cotal", "nats.pid"), "utf8") : null;
    const parentPolicySnap = existsSync(parentPolicyBefore)
      ? readFileSync(parentPolicyBefore, "utf8") : null;

    const childUp = cotal(["up", "--detach", "--open", "--space", "child-oa",
      "--server", `nats://127.0.0.1:${childPort}`,
      "--tls-cert", pkiFiles.cert, "--tls-key", pkiFiles.key], home, child);
    assert.equal(childUp.status, 0, `open child TLS mesh must start:\n${childUp.out}`);

    const childPolicy = join(child, ".cotal", "broker-policy.json");
    assert.equal(existsSync(childPolicy), true,
      `GATE FAILED (S4-open): child has no broker-policy.json — open path still wrote the ancestor`);
    assert.match(readFileSync(childPolicy, "utf8"), /tls-required/);
    if (parentPolicySnap === null) {
      assert.equal(existsSync(parentPolicyBefore), false,
        `GATE FAILED (S4-open): open child wrote policy into the parent root`);
    } else {
      assert.equal(readFileSync(parentPolicyBefore, "utf8"), parentPolicySnap,
        `GATE FAILED (S4-open): open child mutated parent broker-policy.json`);
    }
    if (parentPidBefore !== null) {
      assert.equal(readFileSync(join(parent, ".cotal", "nats.pid"), "utf8"), parentPidBefore,
        `GATE FAILED (S4-open): open child overwrote parent nats.pid`);
    }

    assert.equal((await serverInfo(childPort))?.tls_required, true, "child listener TLS");
    assert.notEqual((await serverInfo(parentPort))?.tls_required, true, "parent still plaintext");
    assertCleartextRefused(await cleartextReply(childPort), "s4o/first");

    cotal(["down"], home, child);
    // Parent must still be reachable after child down (no shared pid/store).
    assert.ok(await serverInfo(parentPort), "parent listener must survive child down");

    const bare = cotal(["up", "--detach", "--open", "--space", "child-oa",
      "--server", `nats://127.0.0.1:${childPort}`], home, child);
    assert.equal(bare.status, 0, `bare open child re-up must inherit TLS:\n${bare.out}`);
    assert.equal((await serverInfo(childPort))?.tls_required, true,
      `GATE FAILED (S4-open): bare re-up served plaintext`);
    assertCleartextRefused(await cleartextReply(childPort), "s4o/bare");

    console.log("  ✓ S4-open: open child owns root/policy/pid; parent untouched; bare re-up retains TLS");
    cotal(["down"], home, child);
    cotal(["down"], home, parent);
  });

  // ── K: REFRESH REFUSE MUST NOT MUTATE POLICY (S5). ─────────────────────────────────────────────
  //    `up --tls-*` against a live plaintext mesh correctly refuses — but used to write
  //    tls-required policy first. The next bare `up` then printed TLS: inheriting / serving /
  //    green already-running over a cleartext listener. Commit-after-apply: refuse mutates nothing.
  await route("refresh-refuse-no-policy-write", async () => {
    const { home, cwd } = sandbox();
    const port = await freePort();
    homes.push({ home, port, cwd });

    const plain = cotal(["up", "--detach", "--open", "--server", `nats://127.0.0.1:${port}`], home, cwd);
    assert.equal(plain.status, 0, `plaintext mesh must start:\n${plain.out}`);
    assert.notEqual((await serverInfo(port))?.tls_required, true, "setup: listener must be plaintext");
    const policy = join(cwd, ".cotal", "broker-policy.json");
    const before = existsSync(policy) ? readFileSync(policy, "utf8") : null;

    const refuse = cotal(["up", "--open", "--server", `nats://127.0.0.1:${port}`,
      "--tls-cert", pkiFiles.cert, "--tls-key", pkiFiles.key], home, cwd);
    assert.notEqual(refuse.status, 0, `TLS flags against a live mesh must refuse:\n${refuse.out}`);
    assert.match(refuse.out, /can't change its transport|already running/,
      `refusal must name the transport lock:\n${refuse.out}`);
    assert.doesNotMatch(refuse.out, /TLS: serving|TLS: inheriting/,
      `GATE FAILED (S5): refuse path printed TLS success copy:\n${refuse.out}`);
    if (before === null) {
      assert.equal(existsSync(policy), false,
        `GATE FAILED (S5): refused refresh wrote broker-policy.json`);
    } else {
      assert.equal(readFileSync(policy, "utf8"), before,
        `GATE FAILED (S5): refused refresh mutated broker-policy.json`);
    }

    const bare = cotal(["up", "--open", "--server", `nats://127.0.0.1:${port}`], home, cwd);
    assert.equal(bare.status, 0, `bare refresh must still succeed:\n${bare.out}`);
    assert.doesNotMatch(bare.out, /TLS: serving|TLS: inheriting/,
      `GATE FAILED (S5): bare refresh claims TLS over a plaintext listener:\n${bare.out}`);
    assert.notEqual((await serverInfo(port))?.tls_required, true, "listener must still be plaintext");
    const ok = await cleartextReply(port);
    assert.ok(ok.reply, `CONTROL: plaintext listener must still accept cleartext CONNECT:\n${JSON.stringify(ok)}`);

    console.log("  ✓ S5: refused TLS refresh mutates nothing; bare refresh does not claim TLS");
    cotal(["down"], home, cwd);
  });

  // ── L: DRY-RUN MUST CHECK DIAL-HOST SAN (S6). ──────────────────────────────────────────────────
  //    `up -f --dry-run` returned before assertServesDialHost and green-lit a cert/server pair the
  //    real command refuses. Validate against the effective manifest server; still no writes.
  await route("dry-run-dial-host", async () => {
    const { home, cwd } = sandbox();
    const port = await freePort();
    writeFileSync(join(cwd, "cotal.yaml"),
      `apiVersion: cotal/v1\nkind: Mesh\nspace: tlsdryhost\nbroker:\n  servers: nats://127.0.0.1:${port}\n  auth: false\nchannels:\n  general:\n    subscribe: []\n`);
    const policy = join(cwd, ".cotal", "broker-policy.json");

    const bad = cotal(["up", "-f", "cotal.yaml", "--dry-run",
      "--tls-cert", pkiFiles.otherCert, "--tls-key", pkiFiles.otherKey], home, cwd);
    assert.notEqual(bad.status, 0,
      `GATE FAILED (S6): dry-run accepted a cert whose SAN does not match the planned server:\n${bad.out}`);
    assert.match(bad.out, /host|SAN|IP|DNS|verify|mismatch|not-this-host|other/i,
      `dry-run refusal must name the host/SAN problem:\n${bad.out}`);
    assert.equal(existsSync(policy), false, "dry-run must not write policy");

    const good = cotal(["up", "-f", "cotal.yaml", "--dry-run",
      "--tls-cert", pkiFiles.cert, "--tls-key", pkiFiles.key], home, cwd);
    assert.equal(good.status, 0, `matching SAN dry-run must still succeed:\n${good.out}`);
    assert.equal(existsSync(policy), false, "successful dry-run must not write either");

    console.log("  ✓ S6: dry-run refuses wrong-SAN; matching SAN still green; no writes");
  });

  // ── M: DELIVERY MUST LAUNCH WITH --tls ON A FRESH TLS MESH (S9). ───────────────────────────────
  //    Commit-after-apply moved policy write after startMeshDetached; delivery inside still read
  //    the (absent) policy and launched flagless — auto-upgrade only, INFO-downgrade harvestable.
  //    Gate the real child argv, not daemon readiness.
  await route("delivery-launches-with-tls", async () => {
    const { home, cwd } = sandbox();
    const port = await freePort();
    homes.push({ home, port, cwd });
    const up = cotal(["up", "--detach", "--server", `nats://127.0.0.1:${port}`,
      "--tls-cert", pkiFiles.cert, "--tls-key", pkiFiles.key], home, cwd);
    assert.equal(up.status, 0, `TLS auth mesh must start:\n${up.out}`);
    assert.match(up.out, /delivery/, `CONTROL: summary should mention delivery:\n${up.out}`);

    // Inspect the live delivery child. Prefer ps argv containing this server/space.
    const ps = spawnSync("bash", ["-lc",
      `ps -ax -o args= 2>/dev/null | grep -F 'deliver' | grep -F '${port}' | grep -v grep || true`],
      { encoding: "utf8" });
    const line = (ps.stdout ?? "").trim().split("\n").filter(Boolean)[0] ?? "";
    assert.ok(line, `CONTROL: no delivery process found for port ${port};\nup out:\n${up.out}`);
    assert.match(line, /--tls\b/,
      `GATE FAILED (S9): delivery launched WITHOUT --tls (flagless auto-upgrade):\n${line}`);

    console.log("  ✓ S9: fresh TLS detach launches delivery with --tls");
    cotal(["down"], home, cwd);
  });

  // ── N: S10 — NO-CA CONNECT MUST NOT PRUNE A LIVE tlsRequired REGISTRY ENTRY. ───────────────────
  //    preflightTarget probes with {tls:true}; cert failure used to classify unreachable+prune and
  //    delete a healthy record when NODE_EXTRA_CA_CERTS was missing. Guard: INFO.tls_required keeps
  //    the entry as tls-trust. Mirror: plaintext-on-port still reports unreachable (not tls-trust).
  await route("s10-no-ca-keeps-registry", async () => {
    const { home, cwd } = sandbox();
    const port = await freePort();
    homes.push({ home, port, cwd });
    const up = cotal(["up", "--detach", "--open", "--server", `nats://127.0.0.1:${port}`,
      "--tls-cert", pkiFiles.cert, "--tls-key", pkiFiles.key], home, cwd);
    assert.equal(up.status, 0, `TLS mesh must start:\n${up.out}`);

    // Strip CA for the preflighted command (cotal send → connectOrExit → preflightTarget).
    const send = cotal(["send", "dm", "nobody", "probe"], home, cwd, { NODE_EXTRA_CA_CERTS: "" });
    assert.match(send.out, /NODE_EXTRA_CA_CERTS|tls-trust|conservatively kept|TLS-required NATS listener/,
      `GATE FAILED (S10): no-CA send must name trust repair / tls-trust, not silent success:\n${send.out}`);
    assert.doesNotMatch(send.out, /stale registry entry - removed/,
      `GATE FAILED (S10): no-CA send pruned the registry:\n${send.out}`);

    const meshes = cotal(["meshes"], home, cwd);
    assert.match(meshes.out, /tls-required|main/,
      `GATE FAILED (S10): registry entry gone after no-CA connect:\n${meshes.out}`);

    // Mirror hazard: replace TLS listener with plaintext on the same port; status must not say tls-trust.
    cotal(["down"], home, cwd);
    // Re-up then kill only nats, leave registry — same shape as web+status cell.
    const up2 = cotal(["up", "--detach", "--open", "--server", `nats://127.0.0.1:${port}`,
      "--tls-cert", pkiFiles.cert, "--tls-key", pkiFiles.key], home, cwd);
    assert.equal(up2.status, 0, `re-up for mirror:\n${up2.out}`);
    const pidPath = join(cwd, ".cotal", "nats.pid");
    const natsPid = Number(readFileSync(pidPath, "utf8").trim());
    try { process.kill(natsPid, "SIGTERM"); } catch { /* */ }
    await new Promise((r) => setTimeout(r, 400));
    const plain = spawnProc("nats-server", ["-a", "127.0.0.1", "-p", String(port), "-js", "-sd", join(cwd, "plain-js")], {
      stdio: "ignore", detached: true,
    });
    plain.unref?.();
    await new Promise((r) => setTimeout(r, 400));
    try {
      const st = cotal(["status"], home, cwd, { NODE_EXTRA_CA_CERTS: "" });
      assert.match(st.out, /connection\s+.*unreachable/,
        `GATE FAILED (S10 mirror): plaintext-on-port must be unreachable, not tls-trust:\n${st.out}`);
      assert.doesNotMatch(st.out, /tls-trust/,
        `GATE FAILED (S10 mirror): plaintext substitute classified tls-trust:\n${st.out}`);
    } finally {
      try { process.kill(plain.pid!, "SIGTERM"); } catch { /* */ }
      cotal(["down"], home, cwd);
    }
    console.log("  ✓ S10: no-CA keeps tlsRequired registry; plaintext-on-port is unreachable not tls-trust");
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
  if (outcomes.length !== 15)
    throw new Error(`HARNESS: expected 15 routes, recorded ${outcomes.length} — a route did not run at all`);
  if (failed.length > 0)
    throw new Error(`${failed.length}/15 routes FAILED: ${failed.map((f) => f.route).join(", ")}`);
  console.log("✓ up-tls-routes: 15/15 routes encrypt or refuse; admission proved on each, one variable apart");
}

try {
  await main();
} finally {
  for (const h of homes) {
    try { cotal(["down"], h.home, h.cwd); } catch { /* best effort */ }
  }
  try { rmSync(root, { recursive: true, force: true }); } catch { /* */ }
}
