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
 *  - REFUSALS ASSERT ON THE REASON. Every mesh here runs `--open`, so there are no credentials to
 *    reject: a refused CONNECT cannot be an auth failure, and a transport refusal is the only thing
 *    it can be. `no protocol reply` therefore means what this suite says it means.
 *
 * COTAL_HOME is sandboxed and every broker started here is reaped in the `finally`.
 * Needs `nats-server` and `openssl` on PATH. Run: pnpm smoke:up-tls:live  (BUILD FIRST — the CLI
 * subprocess runs built dist, so an unbuilt edit to `packages/core` is invisible to it.)
 */
import { strict as assert } from "node:assert";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import net from "node:net";
import tls from "node:tls";

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
function cotal(args: string[], home: string, cwd: string): Run {
  const r = spawnSync("npx", ["tsx", CLI, ...args], {
    encoding: "utf8", cwd, timeout: 180_000,
    // `up` verifies the broker it just started with its OWN client, and `EndpointOptions.tls` is a
    // boolean that cannot carry a CA file — so against a private CA that verification fails and the
    // command exits non-zero even though the listener came up correctly encrypted. Supplying the CA
    // through the documented escape hatch is not a workaround for the test's benefit: it is the
    // exact remedy the changeset tells private-CA operators to use, so this exercises it rather than
    // asserting it works.
    env: { ...process.env, COTAL_HOME: home, NODE_EXTRA_CA_CERTS: caFile },
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
function cleartextReply(port: number, timeoutMs = 4000): Promise<string | undefined> {
  return new Promise((res) => {
    const sock = net.connect(port, "127.0.0.1");
    let buf = "";
    let sent = false;
    const done = (v: string | undefined) => { try { sock.destroy(); } catch { /* */ } res(v); };
    sock.setTimeout(timeoutMs, () => done(undefined));
    sock.on("error", () => done(undefined));
    // THE REFUSAL USUALLY ARRIVES AS A CLOSE, NOT A SILENCE. A TLS-required listener hangs up on a
    // cleartext CONNECT rather than answering it, so waiting for an inactivity timeout would be both
    // slow and — with no close handler at all — a promise that never settles. That is exactly how
    // this suite first failed: no assertion, no error, no output, just an unsettled await.
    sock.on("close", () => done(undefined));
    sock.on("data", (d) => {
      buf += d.toString("utf8");
      if (!sent && buf.includes("\r\n")) {
        sent = true;
        buf = "";
        sock.write('CONNECT {"verbose":true,"pedantic":false,"protocol":1,"lang":"smoke","version":"0"}\r\nPING\r\n');
        return;
      }
      if (sent && /(PONG|\+OK|-ERR)/.test(buf)) done(buf.split("\r\n")[0]);
    });
  });
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

    const clear = await cleartextReply(port);
    assert.equal(clear, undefined,
      `GATE FAILED (--detach): a TLS-required listener answered a CLEARTEXT CONNECT with ${JSON.stringify(clear)}. ` +
      `The mesh is --open, so this cannot be an auth refusal; the server parsed our CONNECT in the clear.`);
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
    const clear = await cleartextReply(port);
    assert.equal(clear, undefined, `GATE FAILED (-f manifest): cleartext CONNECT answered with ${JSON.stringify(clear)}`);
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

  // The per-route table is the artifact a mutation proof reads. Printed always, pass or fail.
  console.log("  ── route outcomes ──");
  for (const o of outcomes) console.log(`  ${o.ok ? "PASS" : "FAIL"}  ${o.route}${o.ok ? "" : `  :: ${(o.err ?? "").split("\n")[0]}`}`);
  const failed = outcomes.filter((o) => !o.ok);
  if (outcomes.length !== 5)
    throw new Error(`HARNESS: expected 5 routes, recorded ${outcomes.length} — a route did not run at all`);
  if (failed.length > 0)
    throw new Error(`${failed.length}/5 routes FAILED: ${failed.map((f) => f.route).join(", ")}`);
  console.log("✓ up-tls-routes: 5/5 routes encrypt or refuse; admission proved on each, one variable apart");
}

try {
  await main();
} finally {
  for (const h of homes) {
    try { cotal(["down"], h.home, h.cwd); } catch { /* best effort */ }
  }
  try { rmSync(root, { recursive: true, force: true }); } catch { /* */ }
}
