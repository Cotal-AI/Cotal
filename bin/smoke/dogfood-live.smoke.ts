/**
 * DOGFOOD LIVE e2e: the REAL `@cotal-ai/web` package installed through the REAL `cotal ext`
 * mechanism and exercised against a REAL mesh — the full operator journey:
 *
 *  A. The dashboard is not part of the core surface: `cotal web` is an unknown command, and the
 *     `web` service preset refuses until its provider is installed, naming `cotal ext add`.
 *  B. `cotal ext add ./implementations/web` — the first real MULTI-PEER extension: BOTH
 *     @cotal-ai/core and @cotal-ai/workspace get linked to this binary's copies (provenance
 *     proves it), and the add names the `web` service preset it contributes.
 *  C. `cotal up --detach` (JWT auth), then the dashboard as an owned service: `service add --preset
 *     web` with a protected observer credential and read-only intent, `service start`. The running
 *     dashboard refuses an unauthenticated request, exchanges its single-use launch link (read from
 *     the private bootstrap file its log names) for a session, and over that session serves /,
 *     /app.js (packaged assets), and /api/meta against the live mesh. A second start is a no-op,
 *     `ext remove` refuses while it runs, and `service stop` ends it.
 *  D. `ext remove @cotal-ai/web`; the `web` preset refuses again.
 *
 * Needs dist built (the packages install per their `files: ["dist"]`), `nats-server` + npm on
 * PATH. Sandboxes COTAL_HOME/XDG_CONFIG_HOME + a temp root; kills only its own pids.
 * Run: pnpm smoke:dogfood:live
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { assertSmokeSandboxDown, freePort, recordSmokeSandbox } from "@cotal-ai/smoke-kit";
import { canonicalLocalProcessPath, DELIVERY_PIDFILE, MANAGER_PIDFILE } from "@cotal-ai/workspace";

// Ephemeral OS-assigned ports: no fixed-port collision across back-to-back / concurrent runs.
const AUTH_PORT = await freePort();
const WEB_PORT = await freePort();
const SPACE = "dogfood-custom";
const REPO = resolve(import.meta.dirname, "..", "..");

const sandbox = mkdtempSync(join(tmpdir(), "cotal-dogfood-"));
const configDir = join(sandbox, "xdg");
const home = join(sandbox, "home");
const root = join(sandbox, "proj");
for (const d of [configDir, home, root]) mkdirSync(d, { recursive: true });
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

const ownPids: number[] = [];
try {
  // -- A: the dashboard is not core ----------------------------------------------------------------
  const creds = join(sandbox, "dashboard.creds");
  const definition = ["service", "add", "web", "--preset", "web", "--space", SPACE, "--root", root, "--creds", creds, "--read-only", "--port", String(WEB_PORT)];
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
    for (const f of [join(root, ".cotal", "nats.pid"), record(DELIVERY_PIDFILE), record(MANAGER_PIDFILE)]) {
      const pid = Number(readFileSync(f, "utf8").trim());
      ownPids.push(pid);
    }

    const mint = cotal(["auth", "mint", "dashweb", "--profile", "observer", "--out", creds]);
    ok("an observer credential mints into a private file", mint.status === 0 && (statSync(creds).mode & 0o777) === 0o600, out(mint).slice(-400));
    const add = cotal(definition);
    ok("service add --preset web saves the dashboard definition", add.status === 0 && /Service definition saved/.test(add.stdout), out(add).slice(-500));
    const start = cotal(["service", "start", "web", "--space", SPACE]);
    const webPid = pidOf(start);
    if (Number.isFinite(webPid)) ownPids.push(webPid);
    ok("service start web runs the dashboard", start.status === 0 && /Owned service process running/.test(start.stdout) && alive(webPid), out(start).slice(-600));

    // The bootstrap link lives in an owner-private file; the service log names its path, never its
    // contents. The file is written once the listener is up, so its appearance is the readiness signal.
    let sessionPath: string | undefined;
    let launch: { launchUrl?: unknown } | undefined;
    for (let i = 0; i < 30 && launch === undefined; i++) {
      const logs = cotal(["service", "logs", "web", "--space", SPACE, "--json"]);
      sessionPath ??= /Private browser bootstrap file: ([^"\\\n]+)/.exec(logs.stdout)?.[1]?.trim();
      if (sessionPath && existsSync(sessionPath)) launch = JSON.parse(readFileSync(sessionPath, "utf8"));
      else await sleep(1000);
    }
    ok("the log names the private bootstrap file, and that file holds a launch link", typeof launch?.launchUrl === "string", { sessionPath });
    ok("the bootstrap file is owner-private", sessionPath !== undefined && (statSync(sessionPath).mode & 0o077) === 0, sessionPath);
    const launchUrl = launch!.launchUrl as string;
    const unauthenticated = await fetch(`http://127.0.0.1:${WEB_PORT}/`);
    ok("the dashboard refuses a request with no session", unauthenticated.status === 401, unauthenticated.status);
    // Spend the token ONCE and ride the session it mints. Presenting `?k=` a second time earns
    // `launch-token-already-used`, a different refusal that reads exactly like the first.
    const exchange = await fetch(launchUrl, { redirect: "manual" });
    const session = /(?:^|,\s*)cotal_web_session=([^;]+)/.exec(exchange.headers.get("set-cookie") ?? "")?.[1];
    ok("the launch link is accepted once and mints a session", exchange.status === 302 && session !== undefined, exchange.status);
    const authed = { cookie: `cotal_web_session=${session}` };
    const page = await fetch(`http://127.0.0.1:${WEB_PORT}/`, { headers: authed });
    ok("the web service serves the dashboard", page.status === 200, page.status);
    const html = await page.text();
    ok("dashboard page is the real asset (packaged via files:[dist])", /<html|<!doctype/i.test(html) && html.length > 200, html.slice(0, 120));
    const appJs = await fetch(`http://127.0.0.1:${WEB_PORT}/app.js`, { headers: authed });
    ok("static asset /app.js serves", appJs.status === 200);
    const meta = (await (await fetch(`http://127.0.0.1:${WEB_PORT}/api/meta`, { headers: authed })).json()) as { space?: string; pid?: number };
    ok("live /api/meta answers with the mesh's space and serving pid", meta.space === SPACE && meta.pid === webPid, { meta, webPid });

    const again = cotal(["service", "start", "web", "--space", SPACE]);
    ok("a second start is a no-op on the running instance", again.status === 0 && /Already running; nothing was started/.test(again.stdout) && pidOf(again) === webPid, out(again).slice(-500));
    const removeLive = cotal(["ext", "remove", "@cotal-ai/web"]);
    ok("ext remove refuses to orphan the running dashboard", removeLive.status === 2 && /LIFECYCLE_BLOCKED/.test(out(removeLive)) && alive(webPid), out(removeLive).slice(-500));
    const stop = cotal(["service", "stop", "web", "--space", SPACE, "--yes"]);
    for (let i = 0; i < 50 && alive(webPid); i++) await sleep(100);
    ok("service stop web ends the dashboard process", stop.status === 0 && /Service stopped/.test(stop.stdout) && !alive(webPid), out(stop).slice(-500));
    ok("a confirmed stop removes the private bootstrap file", sessionPath !== undefined && !existsSync(sessionPath), sessionPath);

    const down = cotal(["down"]);
    ok("bare down stops the auth mesh", down.status === 0 && ownPids.slice(0, 3).every((pid) => !alive(pid)), out(down).slice(-500));
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
