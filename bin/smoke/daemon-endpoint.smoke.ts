/**
 * `cotal daemon` local endpoint: live, red-first cells over real unix sockets and the stock
 * `@cotal-ai/seat` SO_PEERCRED helper. Nothing here restates the endpoint's rules; every cell drives
 * the shipped `serveDaemon` / `queryDaemon` / CLI entry and counts what happened.
 *
 * Cells (each asserts counts, not just "no error"):
 *  E1  the CLI verb is reachable through the composition root (`cotal daemon status`), and with no
 *      daemon running it refuses as TARGET_UNAVAILABLE / NOT_RUNNING;
 *  E2  positive: serve, then status over the real socket returns state "ready" with this pid and
 *      version; the bound socket is a 0600 socket in a 0700 dir owned by this uid;
 *  E3  contract: unknown op, unknown field, wrong version, bad id, non-object, non-JSON and an
 *      oversize line are each refused with their typed code, and the server answers zero statuses;
 *  E4  loose / foreign / symlinked directory: serve refuses and changes nothing (mode unchanged,
 *      zero entries created), and the client sends zero bytes;
 *  E5  squat: a pre-existing non-socket file, a live foreign listener, and even a dead socket this
 *      uid owns at the socket path are all refused with zero unlinks (no automatic reclamation);
 *  E6  second instance: a second serve against a live endpoint refuses ALREADY_RUNNING;
 *  E7  shutdown removes only its own socket (dev+ino-checked), not a replacement at the same path;
 *  E10 N concurrent starters on an empty path: exactly one ready, N-1 refused, 0 live unlinks;
 *  E11 an unterminated 1 MiB write is refused at the 64 KiB limit and the connection closed;
 *  E8  cross-uid (server side): a peer reported by the kernel as another uid is dropped with zero
 *      frames decoded. Needs an unprivileged user namespace; reported UNTESTED when unavailable;
 *  E9  cross-uid (client side): the client refuses a listener whose kernel uid differs, writing
 *      zero bytes. Same namespace requirement.
 *
 * Run: tsx bin/smoke/daemon-endpoint.smoke.ts   (Linux only)
 */
import { mkdtempSync, mkdirSync, chmodSync, writeFileSync, symlinkSync, lstatSync, readdirSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { createServer, type Socket } from "node:net";
import { spawnSync, spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { peerCredentials } from "@cotal-ai/seat";
import { EndpointRefusal, daemonPaths } from "../daemon/endpoint.js";
import { serveDaemon } from "../daemon/server.js";
import { queryDaemon, type ClientCounters } from "../daemon/client.js";

if (process.platform !== "linux") {
  console.log("daemon-endpoint smoke: Linux only; skipped on " + process.platform);
  process.exit(0);
}

const here = dirname(fileURLToPath(import.meta.url));
const repo = join(here, "..", "..");
const uid = process.geteuid!();
const peerUid = (s: Socket) => peerCredentials(s).uid;
let pass = 0, fail = 0, untested = 0;
const check = (name: string, cond: boolean, extra?: unknown) => {
  if (cond) { pass++; console.log(`  ✓ ${name}`); } else { fail++; console.log(`  ✗ FAIL: ${name}`, extra ?? ""); }
};
const refusalCode = async (p: Promise<unknown>): Promise<string> => {
  try { await p; return "no-refusal"; } catch (e) { return e instanceof EndpointRefusal ? e.code : `other:${(e as Error).message}`; }
};
const mode = (p: string) => (lstatSync(p).mode & 0o777).toString(8).padStart(4, "0");

// COTAL_DAEMON_SMOKE_TMP chooses the scratch parent; the cross-uid cells need every ancestor
// directory to be searchable by the subordinate uid, which a private home directory is not.
const root = mkdtempSync(join(process.env.COTAL_DAEMON_SMOKE_TMP ?? tmpdir(), "cotal-daemon-smoke-"));
// The CLI children get no mesh identity or connection material from whatever runs this suite.
for (const key of Object.keys(process.env)) if (key.startsWith("COTAL_")) delete process.env[key];
chmodSync(root, 0o700);
const runtime = (name: string) => { const r = join(root, name); mkdirSync(r, { mode: 0o700 }); return r; };
const paths = (rt: string) => daemonPaths({ XDG_RUNTIME_DIR: rt });

try {
  // ---- E1: through the real composition root ----
  {
    const rt = runtime("e1");
    const cli = spawnSync(process.execPath, ["--import", "tsx", join(repo, "bin", "cotal.ts"), "daemon", "status", "--json"], {
      env: { ...process.env, XDG_RUNTIME_DIR: rt, COTAL_NO_UPDATE_CHECK: "1" }, encoding: "utf8", timeout: 60_000,
    });
    let doc: { outcome?: string; error?: { code?: string; cause?: { code?: string } } } = {};
    try { doc = JSON.parse(cli.stdout); } catch { /* reported below */ }
    check("E1 `cotal daemon status` is a registered verb (not an unknown-command refusal)", !/unknown command/i.test(cli.stdout + cli.stderr), (cli.stdout + cli.stderr).slice(0, 300));
    check("E1 with no daemon it refuses TARGET_UNAVAILABLE / NOT_RUNNING", doc.outcome === "refused" && doc.error?.code === "TARGET_UNAVAILABLE" && doc.error?.cause?.code === "NOT_RUNNING", { status: cli.status, doc });
    check("E1 refusal exits 2 (boundary refusal)", cli.status === 2, cli.status);
  }

  // ---- E2: positive lifecycle ----
  {
    const p = paths(runtime("e2"));
    const d = await serveDaemon({ paths: p, version: "0.0.0-smoke", peerUid });
    check("E2 dir created 0700 and socket bound 0600, both owned by this uid", d.dirOutcome === "created" && mode(p.dir) === "0700" && mode(p.socket) === "0600" && lstatSync(p.socket).uid === uid && lstatSync(p.socket).isSocket());
    const counters: ClientCounters = { bytesWritten: 0 };
    const r = await queryDaemon({ paths: p, peerUid, counters });
    check("E2 status answers ready with this pid and version", r.ok && r.result.state === "ready" && r.result.pid === process.pid && r.result.version === "0.0.0-smoke" && r.result.protocol === 1, r);
    check("E2 counters: 1 accepted, 1 frame decoded, 1 status, 0 peer rejections, 0 refusals", d.counters.accepted === 1 && d.counters.framesDecoded === 1 && d.counters.statusAnswered === 1 && d.counters.peerRejected === 0 && d.counters.requestsRefused === 0, d.counters);
    check("E2 client wrote exactly one request line", counters.bytesWritten > 0 && counters.bytesWritten < 200, counters);
    await d.close();
    check("E2 shutdown removed its own socket and left the dir", !existsSync(p.socket) && existsSync(p.dir));
  }

  // ---- E3: closed contract ----
  {
    const p = paths(runtime("e3"));
    const d = await serveDaemon({ paths: p, version: "0.0.0-smoke", peerUid });
    const cases: [string, string, string][] = [
      ["unknown op", JSON.stringify({ v: 1, id: "a1", op: "shutdown" }), "UNKNOWN_OP"],
      ["unknown field", JSON.stringify({ v: 1, id: "a2", op: "status", extra: 1 }), "UNKNOWN_FIELD"],
      ["wrong version", JSON.stringify({ v: 2, id: "a3", op: "status" }), "BAD_VERSION"],
      ["bad id", JSON.stringify({ v: 1, id: "bad id!", op: "status" }), "BAD_ID"],
      ["non-object", JSON.stringify([1, 2]), "NOT_OBJECT"],
      ["non-JSON", "{nope", "BAD_JSON"],
    ];
    let refused = 0;
    for (const [name, line, code] of cases) {
      const r = await queryDaemon({ paths: p, peerUid, rawLine: line });
      const ok = !r.ok && r.error.code === code;
      if (ok) refused++;
      check(`E3 ${name} refused ${code}`, ok, r);
    }
    const big = await queryDaemon({ paths: p, peerUid, rawLine: "x".repeat(70 * 1024) });
    check("E3 oversize line refused LINE_TOO_LONG", !big.ok && big.error.code === "LINE_TOO_LONG", big);
    check(`E3 ${cases.length}/${cases.length} contract cases refused with their exact code`, refused === cases.length, refused);
    check("E3 server counted 7 refusals and answered 0 statuses", d.counters.requestsRefused === cases.length + 1 && d.counters.statusAnswered === 0, d.counters);
    await d.close();
  }

  // ---- E4: directory refusals change nothing ----
  {
    const loose = runtime("e4a"); mkdirSync(join(loose, "cotal"), { mode: 0o755 }); chmodSync(join(loose, "cotal"), 0o755);
    const pl = paths(loose);
    check("E4 serve refuses a 0755 dir (DIR_WRONG_MODE)", (await refusalCode(serveDaemon({ paths: pl, version: "x", peerUid }))) === "DIR_WRONG_MODE");
    check("E4 the 0755 dir was not chmod-ed and holds 0 entries", mode(pl.dir) === "0755" && readdirSync(pl.dir).length === 0);
    const c4: ClientCounters = { bytesWritten: 0 };
    check("E4 client refuses the 0755 dir before connecting (0 bytes)", (await refusalCode(queryDaemon({ paths: pl, peerUid, counters: c4 }))) === "DIR_WRONG_MODE" && c4.bytesWritten === 0);

    const sym = runtime("e4b"); const target = join(sym, "real"); mkdirSync(target, { mode: 0o700 }); symlinkSync(target, join(sym, "cotal"));
    check("E4 serve refuses a symlinked dir (DIR_SYMLINK) and binds nothing in its target", (await refusalCode(serveDaemon({ paths: paths(sym), version: "x", peerUid }))) === "DIR_SYMLINK" && readdirSync(target).length === 0);

    const file = runtime("e4c"); writeFileSync(join(file, "cotal"), "not a dir");
    check("E4 serve refuses a file where the dir should be (DIR_NOT_DIRECTORY)", (await refusalCode(serveDaemon({ paths: paths(file), version: "x", peerUid }))) === "DIR_NOT_DIRECTORY");
  }

  // ---- E5: squats ----
  {
    const p = paths(runtime("e5a")); mkdirSync(p.dir, { mode: 0o700 }); writeFileSync(p.socket, "squat");
    check("E5 a regular file at the socket path is refused (SOCKET_NOT_SOCKET) and not removed", (await refusalCode(serveDaemon({ paths: p, version: "x", peerUid }))) === "SOCKET_NOT_SOCKET" && lstatSync(p.socket).isFile());

    const q = paths(runtime("e5b")); mkdirSync(q.dir, { mode: 0o700 });
    const squatter = createServer(() => {}); await new Promise<void>((r) => squatter.listen(q.socket, () => r()));
    check("E5 a live listener at the path is refused (ALREADY_RUNNING) and not removed", (await refusalCode(serveDaemon({ paths: q, version: "x", peerUid }))) === "ALREADY_RUNNING" && lstatSync(q.socket).isSocket());
    await new Promise<void>((r) => squatter.close(() => r()));

    const s = paths(runtime("e5c")); mkdirSync(s.dir, { mode: 0o700 });
    const child = spawn(process.execPath, ["-e", `require("net").createServer().listen(${JSON.stringify(s.socket)}, () => process.kill(process.pid, "SIGKILL"))`], { stdio: "ignore" });
    await new Promise<void>((r) => child.once("exit", () => r()));
    check("E5 instrument: a dead socket owned by this uid exists", existsSync(s.socket) && lstatSync(s.socket).isSocket());
    const deadIno = lstatSync(s.socket).ino;
    check("E5 a dead socket owned by this uid is NOT reclaimed: refused ALREADY_RUNNING", (await refusalCode(serveDaemon({ paths: s, version: "x", peerUid }))) === "ALREADY_RUNNING");
    check("E5 the dead socket is still there, same inode (0 unlinks)", existsSync(s.socket) && lstatSync(s.socket).ino === deadIno);
    rmSync(s.socket);
    const d = await serveDaemon({ paths: s, version: "x", peerUid });
    check("E5 after the operator removes it by hand, serve binds", lstatSync(s.socket).isSocket() && (await queryDaemon({ paths: s, peerUid })).ok);
    await d.close();

    // Through the real CLI: a stale (dead) socket left by a SIGKILLed daemon is a typed CONFLICT
    // refusal whose remedy names the manual recovery; the CLI removes nothing.
    const st = runtime("e5d"); const sp = paths(st); mkdirSync(sp.dir, { mode: 0o700 });
    const killed = spawn(process.execPath, ["-e", `require("net").createServer().listen(${JSON.stringify(sp.socket)}, () => process.kill(process.pid, "SIGKILL"))`], { stdio: "ignore" });
    await new Promise<void>((r) => killed.once("exit", () => r()));
    const staleIno = lstatSync(sp.socket).ino;
    const cliServe = spawnSync(process.execPath, ["--import", "tsx", join(repo, "bin", "cotal.ts"), "daemon", "serve", "--json"], { env: { ...process.env, XDG_RUNTIME_DIR: st, COTAL_NO_UPDATE_CHECK: "1" }, encoding: "utf8", timeout: 60_000 });
    let sdoc: { outcome?: string; error?: { code?: string; remedy?: string; cause?: { code?: string } } } = {};
    try { sdoc = JSON.parse(cliServe.stdout); } catch { /* reported below */ }
    check("E5 CLI serve over a stale socket refuses CONFLICT/ALREADY_RUNNING with rc 2", cliServe.status === 2 && sdoc.outcome === "refused" && sdoc.error?.code === "CONFLICT" && sdoc.error?.cause?.code === "ALREADY_RUNNING", { status: cliServe.status, sdoc, err: cliServe.stderr.slice(0, 200) });
    check("E5 its remedy names the manual recovery and says the daemon never removes it", /remove the socket path/.test(sdoc.error?.remedy ?? "") && /never removes it/.test(sdoc.error?.remedy ?? ""), sdoc.error?.remedy);
    check("E5 the stale socket is untouched by the CLI (same inode)", lstatSync(sp.socket).ino === staleIno);
  }

  // ---- E6: second instance ----
  {
    const p = paths(runtime("e6"));
    const d1 = await serveDaemon({ paths: p, version: "x", peerUid });
    const ino = lstatSync(p.socket).ino;
    check("E6 a second serve refuses ALREADY_RUNNING", (await refusalCode(serveDaemon({ paths: p, version: "x", peerUid }))) === "ALREADY_RUNNING");
    check("E6 the first daemon's socket is untouched and still answers", lstatSync(p.socket).ino === ino && (await queryDaemon({ paths: p, peerUid })).ok);
    await d1.close();
  }

  // ---- E7: shutdown removes only its own socket ----
  {
    const p = paths(runtime("e7"));
    const d = await serveDaemon({ paths: p, version: "x", peerUid });
    check("E7 no private bind name is left in the directory after start", readdirSync(p.dir).length === 1 && readdirSync(p.dir)[0] === "daemon.sock", readdirSync(p.dir));
    // A replacement appears at the public path while the daemon runs: a file, then a live socket.
    rmSync(p.socket); writeFileSync(p.socket, "replacement");
    await d.close();
    check("E7 shutdown left a replacement FILE at the path untouched", existsSync(p.socket) && lstatSync(p.socket).isFile());
    rmSync(p.socket);
    const d2 = await serveDaemon({ paths: p, version: "x", peerUid });
    rmSync(p.socket);
    const other = createServer(); await new Promise<void>((r) => other.listen(p.socket, () => r()));
    const otherIno = lstatSync(p.socket).ino;
    await d2.close();
    check("E7 shutdown left another process's live SOCKET at the path untouched", existsSync(p.socket) && lstatSync(p.socket).ino === otherIno);
    await new Promise<void>((r) => other.close(() => r()));
  }

  // ---- E10 (T10): concurrent starts, separate processes, empty path ----
  {
    const rt = runtime("e10"); const p = paths(rt);
    const N = 6;
    const starter = join(root, "starter.mts");
    // The starter lives in the scratch dir, so it imports the bin package's own resolution of
    // @cotal-ai/seat by file URL rather than by bare name (bare names resolve from the file's dir).
    const seatUrl = import.meta.resolve("@cotal-ai/seat");
    writeFileSync(starter, `
      import { peerCredentials } from ${JSON.stringify(seatUrl)};
      import { serveDaemon } from ${JSON.stringify(join(here, "..", "daemon", "server.js"))};
      import { daemonPaths } from ${JSON.stringify(join(here, "..", "daemon", "endpoint.js"))};
      const go = Number(process.argv[2]);
      while (Date.now() < go) await new Promise((r) => setTimeout(r, 1));
      try {
        const d = await serveDaemon({ paths: daemonPaths({ XDG_RUNTIME_DIR: ${JSON.stringify(rt)} }), version: "x", peerUid: (s) => peerCredentials(s).uid });
        process.stdout.write("READY\\n");
        process.on("SIGTERM", () => void d.close().then(() => process.exit(0)));
        setTimeout(() => void d.close().then(() => process.exit(0)), 15000);
      } catch (e) { process.stdout.write("REFUSED " + (e.code ?? e.message) + "\\n"); process.exit(0); }
    `);
    const go = Date.now() + 2500;
    const kids = Array.from({ length: N }, () => spawn(process.execPath, ["--import", "tsx", starter, String(go)], { cwd: repo, stdio: ["ignore", "pipe", "pipe"] }));
    const outs = kids.map(() => "");
    kids.forEach((k, i) => k.stdout.on("data", (b) => { outs[i] += String(b); }));
    for (let t = 0; t < 200 && outs.filter((o) => /^(READY|REFUSED .+)$/m.test(o)).length < N; t++) await new Promise((r) => setTimeout(r, 100));
    const ready = outs.filter((o) => /^READY$/m.test(o)).length;
    const refused = outs.filter((o) => /^REFUSED ALREADY_RUNNING$/m.test(o)).length;
    const leftover = existsSync(p.dir) ? readdirSync(p.dir).filter((n) => n !== "daemon.sock") : ["<dir missing>"];
    check(`E10 ${N} concurrent starters: exactly 1 ready, ${N - 1} refused ALREADY_RUNNING`, ready === 1 && refused === N - 1, outs);
    check("E10 the one public socket answers status, and no private bind names are left behind", (await queryDaemon({ paths: p, peerUid })).ok && leftover.length === 0, leftover);
    for (const k of kids) k.kill("SIGTERM");
    await Promise.all(kids.map((k) => new Promise<void>((r) => { if (k.exitCode !== null || k.signalCode !== null) r(); else k.once("exit", () => r()); })));
    check("E10 after the winner stops, the path is empty (it removed only its own socket)", !existsSync(p.socket));
  }

  // ---- E11 (T11): unterminated 1 MiB write is cut off at the limit ----
  {
    const p = paths(runtime("e11"));
    const d = await serveDaemon({ paths: p, version: "x", peerUid });
    const { connect: rawConnect } = await import("node:net");
    const sent = await new Promise<{ written: number; reply: string; closed: boolean }>((resolve) => {
      const c = rawConnect(p.socket);
      let reply = "", written = 0, done = false;
      const finish = (closed: boolean) => { if (!done) { done = true; resolve({ written, reply, closed }); } };
      c.setEncoding("utf8");
      c.on("data", (b: string) => { reply += b; });
      c.on("close", () => finish(true));
      c.on("error", () => {});
      c.on("connect", () => {
        const chunk = Buffer.alloc(16 * 1024, 0x78);
        const pump = () => { while (written < 1024 * 1024) { written += chunk.length; if (!c.write(chunk)) { c.once("drain", pump); return; } } };
        pump();
      });
      setTimeout(() => finish(false), 5000);
    });
    check("E11 the daemon refused LINE_TOO_LONG and closed the connection", sent.reply.includes("LINE_TOO_LONG") && sent.closed, { reply: sent.reply.slice(0, 120), closed: sent.closed });
    check("E11 counters: 1 refusal, 0 frames decoded, 0 statuses", d.counters.requestsRefused === 1 && d.counters.framesDecoded === 0 && d.counters.statusAnswered === 0, d.counters);
    check("E11 the daemon still answers status afterwards", (await queryDaemon({ paths: p, peerUid })).ok);
    await d.close();
  }

  // ---- E8/E9: cross-uid via an unprivileged user namespace ----
  // `unshare --user --map-auto --setuid 0` runs the other side as namespace uid 0, which the kernel
  // maps to this user's first subordinate uid. From here, SO_PEERCRED and stat() report that
  // subordinate uid (e.g. 100000), a uid that is not ours: a real second uid without creating an OS
  // user or touching machine config. When namespaces or a subuid range are unavailable, both cells
  // are reported UNTESTED, never passed.
  {
    const probe = spawnSync("unshare", ["--user", "--map-auto", "--setuid", "0", "--setgid", "0", "--", "true"], { encoding: "utf8" });
    const havePython = ["/usr/bin/python3", "/usr/local/bin/python3"].some((p) => existsSync(p));
    if (probe.status !== 0 || !havePython) {
      untested += 2;
      console.log(`  ○ UNTESTED E8/E9 cross-uid: ${probe.status !== 0 ? `unprivileged user namespace with a subuid map unavailable (${(probe.stderr || "").trim().slice(0, 120)})` : "no system python3 for the namespaced peer"}`);
    } else {
      // The peer is a tiny Python helper: the subordinate uid cannot execute a Node that lives in a
      // private home directory, and the peer only needs to connect-and-send or listen-and-report.
      const python = ["/usr/bin/python3", "/usr/local/bin/python3"].find((p) => existsSync(p));
      const helper = join(root, "ns-helper.py");
      writeFileSync(helper, [
        "import socket, sys, time",
        "mode, path = sys.argv[1], sys.argv[2]",
        "if mode == 'listen':",
        "    s = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM); s.bind(path); s.listen(4)",
        "    print('LISTENING', flush=True); s.settimeout(10)",
        "    try:",
        "        c, _ = s.accept(); c.settimeout(2)",
        "        try:",
        "            if c.recv(4096): print('GOT-BYTES', flush=True)",
        "        except socket.timeout: pass",
        "    except socket.timeout: pass",
        "else:",
        "    c = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)",
        "    try:",
        "        c.connect(path); print('CONNECTED', flush=True)",
        "        c.sendall(b'{\"v\":1,\"id\":\"x1\",\"op\":\"status\"}\\n'); time.sleep(1)",
        "    except OSError as e: print('CONNECT-ERROR', e.errno, flush=True)",
      ].join("\n") + "\n");
      chmodSync(root, 0o711); chmodSync(helper, 0o644);
      const ns = (args: string[]) => ["--user", "--map-auto", "--setuid", "0", "--setgid", "0", "--", python ?? "python3", helper, ...args];

      // E8: we serve; a peer running as the subordinate uid connects. The test opens ITS OWN temp
      // dir and socket to that uid for this cell only (the daemon itself never does), so the only
      // thing left to stop the peer is the server's SO_PEERCRED gate.
      const rt8 = runtime("e8");
      const p8 = paths(rt8);
      const d8 = await serveDaemon({ paths: p8, version: "x", peerUid });
      chmodSync(rt8, 0o711); chmodSync(p8.dir, 0o711); chmodSync(p8.socket, 0o666);
      const c8 = spawnSync("unshare", ns(["connect", p8.socket]), { encoding: "utf8", timeout: 15_000 });
      chmodSync(p8.socket, 0o600); chmodSync(p8.dir, 0o700); chmodSync(rt8, 0o700);
      if (!String(c8.stdout).includes("CONNECTED")) {
        untested++;
        console.log(`  ○ UNTESTED E8 cross-uid server: namespaced client could not connect (${String(c8.stdout).trim()} ${String(c8.stderr).trim().slice(0, 120)})`);
      } else {
        await new Promise((r) => setTimeout(r, 200));
        check("E8 a peer the kernel reports as another uid is dropped: 1 peer rejection, 0 accepted, 0 frames decoded, 0 statuses", d8.counters.peerRejected === 1 && d8.counters.accepted === 0 && d8.counters.framesDecoded === 0 && d8.counters.statusAnswered === 0, d8.counters);
      }
      await d8.close();

      // E9: the subordinate uid listens at the daemon path; our client must refuse before writing.
      const rt9 = runtime("e9");
      const p9 = paths(rt9); mkdirSync(p9.dir, { mode: 0o700 });
      chmodSync(rt9, 0o711); chmodSync(p9.dir, 0o777);
      const lsn = spawn("unshare", ns(["listen", p9.socket]), { stdio: ["ignore", "pipe", "pipe"] });
      let out = "";
      lsn.stdout.on("data", (b) => { out += String(b); });
      for (let i = 0; i < 80 && !out.includes("LISTENING"); i++) await new Promise((r) => setTimeout(r, 100));
      chmodSync(p9.dir, 0o700); chmodSync(rt9, 0o700);
      if (!out.includes("LISTENING") || !existsSync(p9.socket)) {
        untested++;
        console.log(`  ○ UNTESTED E9 cross-uid client: namespaced listener did not bind (${out.trim()})`);
      } else {
        const sockUid = lstatSync(p9.socket).uid;
        const c9: ClientCounters = { bytesWritten: 0 };
        const code = await refusalCode(queryDaemon({ paths: p9, peerUid, counters: c9 }));
        await new Promise((r) => setTimeout(r, 200));
        check("E9 instrument: the listener's socket is owned by another uid", sockUid !== uid, { sockUid, uid });
        check("E9 the client refuses the foreign endpoint (SOCKET_WRONG_OWNER) with 0 bytes written", code === "SOCKET_WRONG_OWNER" && c9.bytesWritten === 0, { code, c9 });
        check("E9 the foreign listener received 0 bytes", !out.includes("GOT-BYTES"), out);
      }
      lsn.kill("SIGKILL");
      await new Promise<void>((r) => { if (lsn.exitCode !== null || lsn.signalCode !== null) r(); else lsn.once("exit", () => r()); });
      chmodSync(root, 0o700);
    }
  }
} catch (e) {
  fail++;
  console.error("  ✗ smoke crashed:", e instanceof Error ? (e.stack ?? e.message) : e);
} finally {
  rmSync(root, { recursive: true, force: true });
}

console.log(`\nDAEMON ENDPOINT SMOKE ${fail === 0 ? "OK" : "FAILED"}  (${pass} passed, ${fail} failed, ${untested} untested)`);
process.exit(fail === 0 ? 0 : 1);
