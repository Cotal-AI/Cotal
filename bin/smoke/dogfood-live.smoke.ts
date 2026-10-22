/**
 * DOGFOOD LIVE e2e: the REAL `@cotal-ai/web` package installed through the REAL `cotal ext`
 * mechanism and exercised against a REAL mesh — the full operator journey:
 *
 *  A. The dashboard is not part of the core surface: `cotal web` is an unknown command, and the
 *     `web` service preset refuses until its provider is installed, naming `cotal ext add`.
 *  B. `cotal ext add ./implementations/web` — the first real MULTI-PEER extension: BOTH
 *     @cotal-ai/core and @cotal-ai/workspace get linked to this binary's copies (provenance
 *     proves it), and the add names the `web` service preset it contributes.
 *  C. `cotal up --detach` (JWT auth), a message sent through the CLI, then the dashboard as an owned
 *     service with a protected admin credential and read-only intent:
 *     - a root that is not the registered one is refused before any child launches;
 *     - a port another process holds fails the start, leaves that listener alone and substitutes no
 *       other port, and the same definition starts once the port is free;
 *     - the running dashboard refuses an unauthenticated request, exchanges its single-use launch
 *       link (read from the private bootstrap file its log names) for a session, serves / and
 *       /app.js, reads the sent message back through its broker-backed history and activity
 *       routes, and refuses channel delete as read-only;
 *     - a second start is a no-op, `ext remove` refuses while it runs, and `service stop` ends it;
 *     - started again, bare `down` stops it before the stack.
 *  D. `ext remove @cotal-ai/web`; the `web` preset refuses again.
 *
 * Needs dist built (the packages install per their `files: ["dist"]`), `nats-server` + npm on
 * PATH. Sandboxes COTAL_HOME/XDG_CONFIG_HOME + a temp root; kills only its own pids.
 * Run: pnpm smoke:dogfood:live
 */
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { assertSmokeSandboxDown, freePort, recordSmokeSandbox } from "@cotal-ai/smoke-kit";
import { canonicalLocalProcessPath, DELIVERY_PIDFILE, MANAGER_PIDFILE } from "@cotal-ai/workspace";

// Ephemeral OS-assigned ports: no fixed-port collision across back-to-back / concurrent runs.
const AUTH_PORT = await freePort();
const WEB_PORT = await freePort();
const SPACE = "dogfood-custom";
const NONCE = `dogfood-${randomUUID()}`;
const REPO = resolve(import.meta.dirname, "..", "..");

const sandbox = mkdtempSync(join(tmpdir(), "cotal-dogfood-"));
const configDir = join(sandbox, "xdg");
const home = join(sandbox, "home");
const root = join(sandbox, "proj");
const otherRoot = join(sandbox, "other");
for (const d of [configDir, home, root, otherRoot]) mkdirSync(d, { recursive: true });
const sandboxAnchor = recordSmokeSandbox({ root, cotalHome: home, xdgConfigHome: configDir });

let pass = 0;
const ok = (name: string, cond: boolean, extra?: unknown) => {
  if (!cond) throw new Error(`FAIL: ${name}${extra !== undefined ? ` — ${JSON.stringify(extra)}` : ""}`);
  pass++;
  console.log(`  ✓ ${name}`);
};

const env = { ...process.env, XDG_CONFIG_HOME: configDir, COTAL_HOME: home, COTAL_SKIP_CONNECTOR_SEED: "1" };
const realNode = spawnSync("which", ["node"], { encoding: "utf8" }).stdout.trim();
const tsxCli = join(REPO, "node_modules", "tsx", "dist", "cli.mjs");
const binCotal = join(REPO, "bin", "cotal.ts");
const cotal = (args: string[], timeout = 180_000) => {
  const options = { encoding: "utf8" as const, env, cwd: root, timeout };
  assertSmokeSandboxDown(sandboxAnchor, args, options);
  return spawnSync(realNode, [tsxCli, binCotal, ...args], options);
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};
const out = (r: ReturnType<typeof cotal>) => r.stdout + r.stderr;
const pidOf = (r: ReturnType<typeof cotal>) => Number(/^\s*PID:\s+(\d+)\s*$/m.exec(r.stdout)?.[1]);
const web = (path: string, init?: RequestInit) => fetch(`http://127.0.0.1:${WEB_PORT}${path}`, { ...init, signal: AbortSignal.timeout(15_000) });

/** The service's bounded log tail, parsed from its JSON result. */
const serviceLog = (name: string) => {
  const r = cotal(["service", "logs", name, "--space", SPACE, "--json"]);
  const result = (JSON.parse(r.stdout) as { result: { instance: { instanceId: string }; lines: string[] } }).result;
  return { instanceId: result.instance.instanceId, lines: result.lines };
};

interface Bootstrap { launchUrl?: unknown; instanceId?: unknown; launchRequestId?: unknown; process?: { pid?: unknown } }
/** Waits for the log to name a bootstrap file this launch has not named before, then reads it. The
 *  file is written once the listener is up, so its appearance is the readiness signal. */
const bootstrapAfter = async (seen: string[]) => {
  for (let i = 0; i < 30; i++) {
    const log = serviceLog("web");
    const path = log.lines.map((line) => /Private browser bootstrap file: (.+)$/.exec(line)?.[1]?.trim()).filter((p) => p !== undefined && !seen.includes(p)).at(-1);
    if (path && existsSync(path)) return { path, log, session: JSON.parse(readFileSync(path, "utf8")) as Bootstrap };
    await sleep(1000);
  }
  return undefined;
};

const ownPids: number[] = [];
try {
  // -- A: the dashboard is not core ----------------------------------------------------------------
  const creds = join(sandbox, "dashboard.creds");
  const flags = ["--preset", "web", "--space", SPACE, "--creds", creds, "--read-only"];
  const definition = ["service", "add", "web", ...flags, "--root", root, "--port", String(WEB_PORT)];
  {
    const r = cotal(["web", "--help"]);
    ok("`cotal web` is an unknown command", r.status === 1 && /unknown command: web/.test(r.stderr), r.stderr.slice(0, 150));
    const preset = cotal(definition);
    ok("the web preset refuses before its provider is installed, naming ext add", preset.status === 2 && /no registered or installed service preset is named "web"/.test(out(preset)) && /cotal ext add @cotal-ai\/web/.test(out(preset)), out(preset).slice(-500));
  }

  // -- B: install the REAL @cotal-ai/web package (multi-peer link) --------------------------------------
  {
    const r = cotal(["ext", "add", join(REPO, "implementations", "web")]);
    ok("ext add @cotal-ai/web exits 0", r.status === 0, out(r).slice(-500));
    ok("core peer linked to this binary's copy", /→ wrote @cotal-ai\/core link/.test(r.stderr), r.stderr.slice(-400));
    ok("workspace peer linked to this binary's copy", /→ wrote @cotal-ai\/workspace link/.test(r.stderr), r.stderr.slice(-400));
    ok("the add names the contributed `web` service preset", /service-preset:web/.test(r.stdout), r.stdout);
  }

  // -- C: the dashboard runs as an owned service against a real JWT-authed mesh ---------------------
  {
    const server = `nats://127.0.0.1:${AUTH_PORT}`;
    const up = cotal(["up", "--detach", "--space", SPACE, "--server", server]);
    ok("up --detach (auth) exits 0", up.status === 0, out(up).slice(-400));
    const record = (t: string) => canonicalLocalProcessPath(t, { root, space: SPACE });
    const meshPids = [join(root, ".cotal", "nats.pid"), record(DELIVERY_PIDFILE), record(MANAGER_PIDFILE)].map((f) => Number(readFileSync(f, "utf8").trim()));
    ownPids.push(...meshPids);
    const sent = cotal(["send", "-c", "general", NONCE, "--space", SPACE]);
    ok("a message is sent to #general through the CLI", sent.status === 0 && /Message stored/.test(sent.stdout), out(sent).slice(-400));

    // The dashboard reads chat, DMs and anycast, which is the admin profile's read-only messaging scope.
    const mint = cotal(["auth", "mint", "dashweb", "--profile", "admin", "--out", creds]);
    ok("an admin credential mints into a private file", mint.status === 0 && (statSync(creds).mode & 0o777) === 0o600, out(mint).slice(-400));

    const wrong = cotal(["service", "add", "webwrong", ...flags, "--root", otherRoot, "--port", String(await freePort())]);
    ok("a definition naming an unregistered root is saved", wrong.status === 0 && /Service definition saved/.test(wrong.stdout), out(wrong).slice(-500));
    const wrongStart = cotal(["service", "start", "webwrong", "--space", SPACE]);
    ok("its start is refused before a child launches, with no other target substituted", wrongStart.status === 2 && /refused before a child launch/.test(out(wrongStart)) && /do not resolve to one target; no different target was substituted/.test(out(wrongStart)), out(wrongStart).slice(-600));
    const wrongStatus = cotal(["service", "status", "webwrong", "--space", SPACE]);
    ok("the refused instance never had a process", /Recorded state:\s+failed/.test(wrongStatus.stdout) && /PID:\s+not established/.test(wrongStatus.stdout), out(wrongStatus).slice(-600));
    ok("service remove forgets the refused definition", cotal(["service", "remove", "webwrong", "--space", SPACE, "--yes"]).status === 0);

    // Another process holds the dashboard's port. The start must fail without touching it.
    const squatter = createServer((_req, res) => res.end("squatter"));
    await new Promise<void>((ready) => squatter.listen(WEB_PORT, "127.0.0.1", ready));
    const add = cotal(definition);
    ok("service add --preset web saves the dashboard definition", add.status === 0 && /Service definition saved/.test(add.stdout), out(add).slice(-500));
    const blocked = cotal(["service", "start", "web", "--space", SPACE]);
    ok("a start on a held port fails before readiness", blocked.status === 5 && /exited before readiness was established/.test(out(blocked)), out(blocked).slice(-600));
    const blockedLog = serviceLog("web").lines;
    ok("its log says the port is in use and no other port was chosen", blockedLog.some((l) => /native dashboard port is in use; no alternate port was selected/.test(l)) && !blockedLog.some((l) => /Private browser bootstrap file/.test(l)), blockedLog);
    const held = await web("/");
    ok("the process holding the port is still the one answering on it", squatter.listening && (await held.text()) === "squatter", held.status);
    squatter.closeAllConnections();
    await new Promise<void>((closed) => squatter.close(() => closed()));

    const start = cotal(["service", "start", "web", "--space", SPACE]);
    const webPid = pidOf(start);
    if (Number.isFinite(webPid)) ownPids.push(webPid);
    ok("once the port is free the same definition starts", start.status === 0 && /Owned service process running/.test(start.stdout) && alive(webPid), out(start).slice(-600));

    const boot = await bootstrapAfter([]);
    ok("the log names the private bootstrap file, and that file holds a launch link", typeof boot?.session.launchUrl === "string", boot?.path);
    const { path: sessionPath, session, log } = boot!;
    ok("the bootstrap file is owner-private", (statSync(sessionPath).mode & 0o077) === 0, sessionPath);
    ok("the bootstrap file belongs to this instance and process", session.instanceId === log.instanceId && session.process?.pid === webPid, { session: { instanceId: session.instanceId, pid: session.process?.pid }, log: log.instanceId, webPid });
    const launchUrl = session.launchUrl as string;
    const token = new URL(launchUrl).searchParams.get("k");
    ok("the service log carries the bootstrap path, never the launch token", token !== null && token.length > 0 && !log.lines.some((l) => l.includes(token)));
    const unauthenticated = await web("/");
    ok("the dashboard refuses a request with no session", unauthenticated.status === 401, unauthenticated.status);
    // Spend the token ONCE and ride the session it mints. Presenting `?k=` a second time earns
    // `launch-token-already-used`, a different refusal that reads exactly like the first.
    const exchange = await fetch(launchUrl, { redirect: "manual", signal: AbortSignal.timeout(15_000) });
    const cookie = /(?:^|,\s*)cotal_web_session=([^;]+)/.exec(exchange.headers.get("set-cookie") ?? "")?.[1];
    ok("the launch link is accepted once and mints a session", exchange.status === 302 && cookie !== undefined, exchange.status);
    const authed = { cookie: `cotal_web_session=${cookie}` };
    const page = await web("/", { headers: authed });
    const html = await page.text();
    ok("dashboard page is the real asset (packaged via files:[dist])", page.status === 200 && /<html|<!doctype/i.test(html) && html.length > 200, html.slice(0, 120));
    const appJs = await web("/app.js", { headers: authed });
    ok("static asset /app.js serves", appJs.status === 200 && /javascript/.test(appJs.headers.get("content-type") ?? ""), appJs.headers.get("content-type"));
    const metaRes = await web("/api/meta", { headers: authed });
    const meta = (await metaRes.json()) as { space?: string; pid?: number; channelDeleteSupported?: boolean };
    ok("/api/meta names the space and serving pid, and no channel delete", metaRes.status === 200 && meta.space === SPACE && meta.pid === webPid && meta.channelDeleteSupported === false, { meta, webPid });

    // Broker-backed reads: the message sent above, read through the dashboard's own endpoint.
    type Message = { channel?: string; parts?: { kind: string; text?: string }[] };
    const isNonce = (m?: Message) => m?.channel === "general" && m.parts?.some((p) => p.kind === "text" && p.text === NONCE) === true;
    const historyRead = async () => {
      const r = await web("/api/channels/general/history", { headers: authed });
      return { status: r.status, page: (await r.json()) as Message[] };
    };
    const history = await historyRead();
    ok("channel history returns the sent message", history.status === 200 && Array.isArray(history.page) && history.page.filter(isNonce).length === 1, history);
    const channelsRes = await web("/api/channels", { headers: authed });
    const channels = (await channelsRes.json()) as { channel: string; messages: number }[];
    ok("the channel list counts #general's message", channelsRes.status === 200 && channels.some((c) => c.channel === "general" && c.messages >= 1), channels);
    const activityRes = await web("/api/activity", { headers: authed });
    const activity = (await activityRes.json()) as { entries?: { mode: string; msg: Message }[]; partial?: boolean };
    ok("the activity feed carries the message from a complete read", activityRes.status === 200 && activity.partial === false && activity.entries?.some((e) => e.mode === "chat" && isNonce(e.msg)) === true, activity);
    const dms = await web("/api/dms", { headers: authed });
    ok("the direct-message history answers for the admin credential", dms.status === 200 && Array.isArray(await dms.json()), dms.status);
    const del = await web("/api/channel/delete", {
      method: "POST",
      headers: { ...authed, origin: `http://127.0.0.1:${WEB_PORT}`, "content-type": "application/json" },
      body: JSON.stringify({ channel: "general" }),
    });
    const refusal = (await del.json()) as { code?: string };
    ok("channel delete is refused as read-only", del.status === 403 && refusal.code === "PERMISSION_DENIED", refusal);
    const after = await historyRead();
    ok("the refused delete left the message in place", after.status === 200 && after.page.filter(isNonce).length === 1, after);
    const served = serviceLog("web").lines;
    ok("the dashboard's endpoint reported no error while serving", !served.some((l) => /endpoint reported an error/.test(l)), served);

    const again = cotal(["service", "start", "web", "--space", SPACE]);
    ok("a second start is a no-op on the running instance", again.status === 0 && /Already running; nothing was started/.test(again.stdout) && pidOf(again) === webPid, out(again).slice(-500));
    const removeLive = cotal(["ext", "remove", "@cotal-ai/web"]);
    ok("ext remove refuses to orphan the running dashboard", removeLive.status === 2 && /LIFECYCLE_BLOCKED/.test(out(removeLive)) && alive(webPid), out(removeLive).slice(-500));
    const stop = cotal(["service", "stop", "web", "--space", SPACE, "--yes"]);
    for (let i = 0; i < 50 && alive(webPid); i++) await sleep(100);
    ok("service stop web ends the dashboard process", stop.status === 0 && /Service stopped/.test(stop.stdout) && !alive(webPid), out(stop).slice(-500));
    ok("a confirmed stop removes the private bootstrap file", !existsSync(sessionPath), sessionPath);

    // Running again, the dashboard is stopped by bare down, ahead of the stack.
    const restart = cotal(["service", "start", "web", "--space", SPACE]);
    const livePid = pidOf(restart);
    if (Number.isFinite(livePid)) ownPids.push(livePid);
    ok("the stopped dashboard starts again", restart.status === 0 && /Owned service process running/.test(restart.stdout) && alive(livePid) && livePid !== webPid, out(restart).slice(-600));
    const liveBoot = await bootstrapAfter([sessionPath]);
    ok("the new launch writes its own bootstrap file", liveBoot !== undefined && liveBoot.session.process?.pid === livePid, liveBoot?.path);
    const down = cotal(["down"]);
    const downOut = out(down);
    for (let i = 0; i < 50 && alive(livePid); i++) await sleep(100);
    ok("bare down marks the running dashboard to stop", down.status === 0 && /^\s*web\s+\S+\s+\S+\s+running\s+stop\s*$/m.test(down.stdout), downOut.slice(0, 900));
    // Both reports are written to stdout, so their order there is the order they happened in.
    const serviceStopped = down.stdout.indexOf("Service stopped");
    ok("bare down stops the dashboard before the stack", serviceStopped >= 0 && serviceStopped < down.stdout.indexOf("stopped manager") && serviceStopped < down.stdout.indexOf("stopped nats-server"), downOut.slice(-900));
    ok("the dashboard process is gone and its bootstrap file removed", !alive(livePid) && liveBoot !== undefined && !existsSync(liveBoot.path), liveBoot?.path);
    ok("bare down stops the auth mesh", meshPids.every((pid) => !alive(pid)), downOut.slice(-500));
  }

  // -- D: remove the extension; the preset's provider is gone again ----------------------------------
  {
    ok("ext remove @cotal-ai/web exits 0", cotal(["ext", "remove", "@cotal-ai/web"]).status === 0);
    const r = cotal(definition);
    ok("the web preset refuses again once its provider is removed", r.status === 2 && /no registered or installed service preset is named "web"/.test(out(r)), out(r).slice(-500));
  }

  console.log(`\nDOGFOOD LIVE SMOKE OK ✅ (${pass} checks)`);
} finally {
  cotal(["down"]);
  for (const p of ownPids) if (alive(p)) { try { process.kill(p, "SIGTERM"); } catch { /* gone */ } }
  rmSync(sandbox, { recursive: true, force: true });
}
