/**
 * DOGFOOD LIVE e2e: the REAL `@cotal-ai/web` package installed through the REAL `cotal ext`
 * mechanism and exercised against a REAL mesh — the full operator journey:
 *
 *  A. `web` left the core surface (unknown command; the built-in count shrank).
 *  B. `cotal ext add ./implementations/web` — the first real MULTI-PEER extension: BOTH
 *     @cotal-ai/core and @cotal-ai/workspace get linked to this binary's copies (provenance
 *     proves it); help + <TAB> list `web` from the manifest cache.
 *  C. `cotal up --detach` (JWT auth), then foreground and detached `cotal web`: the dashboard
 *     serves /, /app.js (packaged assets), and /api/meta over HTTP against the live mesh. Detached
 *     launch is PID-bound, root-pinned, logged, ready before return, and owned by `down`.
 *  D. `ext remove @cotal-ai/web`; `web` is unknown again.
 *
 * Needs dist built (the packages install per their `files: ["dist"]`), `nats-server` + npm on
 * PATH. Sandboxes COTAL_HOME/XDG_CONFIG_HOME + a temp root; kills only its own pids.
 * Run: pnpm smoke:dogfood:live
 */
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createServer, type AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

// Ephemeral OS-assigned ports: no fixed-port collision across back-to-back / concurrent runs.
const freePort = (): Promise<number> =>
  new Promise((res, rej) => {
    const s = createServer();
    s.on("error", rej);
    s.listen(0, "127.0.0.1", () => { const p = (s.address() as AddressInfo).port; s.close(() => res(p)); });
  });
const AUTH_PORT = await freePort();
const WEB_PORT = await freePort();
const SPACE = "dogfood-custom";
const REPO = resolve(import.meta.dirname, "..", "..");

const sandbox = mkdtempSync(join(tmpdir(), "cotal-dogfood-"));
const configDir = join(sandbox, "xdg");
const home = join(sandbox, "home");
const root = join(sandbox, "proj");
for (const d of [configDir, home, root]) mkdirSync(d, { recursive: true });

let pass = 0;
const ok = (name: string, cond: boolean, extra?: unknown) => {
  if (!cond) throw new Error(`FAIL: ${name}${extra !== undefined ? ` — ${JSON.stringify(extra)}` : ""}`);
  pass++;
  console.log(`  ✓ ${name}`);
};

const env = { ...process.env, XDG_CONFIG_HOME: configDir, COTAL_HOME: home };
const realNode = spawnSync("which", ["node"], { encoding: "utf8" }).stdout.trim();
const tsxCli = join(REPO, "node_modules", "tsx", "dist", "cli.mjs");
const binCotal = join(REPO, "bin", "cotal.ts");
const cotalAt = (cwd: string, args: string[], timeout = 180_000) =>
  spawnSync(realNode, [tsxCli, binCotal, ...args], { encoding: "utf8", env, cwd, timeout });
const cotal = (args: string[], timeout = 180_000) => cotalAt(root, args, timeout);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

let webChild: ReturnType<typeof spawn> | undefined;
const ownPids: number[] = [];
try {
  // -- A: web left the core surface ---------------------------------------------------------------
  {
    const r = cotal(["web", "--help"]);
    ok("`cotal web` is unknown before the extension is installed", r.status === 1 && /unknown command: web/.test(r.stderr), r.stderr.slice(0, 150));
  }

  // -- B: install the REAL @cotal-ai/web package (multi-peer link) --------------------------------------
  {
    const r = cotal(["ext", "add", join(REPO, "implementations", "web")]);
    ok("ext add @cotal-ai/web exits 0", r.status === 0, (r.stdout + r.stderr).slice(-500));
    ok("core peer linked to this binary's copy", /→ wrote @cotal-ai\/core link/.test(r.stderr), r.stderr.slice(-400));
    ok("workspace peer linked to this binary's copy", /→ wrote @cotal-ai\/workspace link/.test(r.stderr), r.stderr.slice(-400));
    ok("the add names the contributed `web` command", /web/.test(r.stdout), r.stdout);
    const help = cotal(["--help"]);
    ok("--help lists web (from the cache, no import)", help.status === 0 && /web\s+.*dashboard/.test(help.stdout), help.stdout.slice(-400));
    const comp = cotal(["__complete", "web", "--"]);
    ok("<TAB> offers web's cached flags", comp.status === 0 && /--port/.test(comp.stdout) && /--detach/.test(comp.stdout), comp.stdout);
  }

  // -- C: the dashboard runs against a real JWT-authed mesh -----------------------------------------
  {
    const server = `nats://127.0.0.1:${AUTH_PORT}`;
    const up = cotal(["up", "--detach", "--space", SPACE, "--server", server]);
    ok("up --detach (auth) exits 0", up.status === 0, (up.stdout + up.stderr).slice(-400));
    for (const f of ["nats.pid", "delivery.pid", "manager.pid"] as const) {
      const pid = Number(readFileSync(join(root, ".cotal", f), "utf8").trim());
      ownPids.push(pid);
    }

    const rawCreds = join(sandbox, "raw-web.creds");
    const mint = cotal(["mint", "raw-web", "--profile", "admin", "--out", rawCreds]);
    ok("admin fixture creds mint for raw-target rejection", mint.status === 0, mint.stderr);
    const noRoot = cotalAt(sandbox, ["web", "--detach", "--space", SPACE, "--server", server, "--creds", rawCreds, "--port", String(WEB_PORT), "--no-open"]);
    const noRootArtifacts = [root, sandbox, home].flatMap((dir) => [join(dir, ".cotal", "web.pid"), join(dir, ".cotal", "web.log"), join(dir, "web.pid"), join(dir, "web.log")]);
    ok("detached web rejects a reachable target without a recorded root before side effects", noRoot.status === 1 && /requires a recorded mesh root/.test(noRoot.stderr) && noRootArtifacts.every((path) => !existsSync(path)), noRoot.stdout + noRoot.stderr);

    webChild = spawn(realNode, [tsxCli, binCotal, "web", "--port", String(WEB_PORT), "--no-open"], {
      env,
      cwd: root,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let webErr = "";
    webChild.stderr?.on("data", (d: Buffer) => (webErr += d.toString()));
    let page: Response | undefined;
    for (let i = 0; i < 30 && !page; i++) {
      await sleep(1000);
      page = await fetch(`http://127.0.0.1:${WEB_PORT}/`).catch(() => undefined);
    }
    ok("the extension `web` command serves the dashboard", page?.status === 200, webErr.slice(-400));
    const html = await page!.text();
    ok("dashboard page is the real asset (packaged via files:[dist])", /<html|<!doctype/i.test(html) && html.length > 200, html.slice(0, 120));
    const appJs = await fetch(`http://127.0.0.1:${WEB_PORT}/app.js`);
    ok("static asset /app.js serves", appJs.status === 200);
    const meta = (await (await fetch(`http://127.0.0.1:${WEB_PORT}/api/meta`)).json()) as { space?: string; pid?: number };
    const foregroundPid = Number(readFileSync(join(root, ".cotal", "web.pid"), "utf8").trim());
    ok("live /api/meta answers with the mesh's space and serving pid", meta.space === SPACE && meta.pid === foregroundPid && alive(foregroundPid), meta);
    const removeLive = cotal(["ext", "remove", "@cotal-ai/web"]);
    ok("ext remove refuses to orphan a running web process", removeLive.status === 1 && /cotal down web/.test(removeLive.stderr), removeLive.stderr.slice(-400));
    const webDown = cotal(["down", "web"]);
    if (webChild.exitCode === null)
      await Promise.race([new Promise<void>((resolve) => webChild!.once("exit", () => resolve())), sleep(2_000)]);
    ok("down web stops the extension-owned process only", webDown.status === 0 && webChild.exitCode !== null, webDown.stdout + webDown.stderr);

    const logPath = join(root, ".cotal", "web.log");
    const oldLogLine = "OLD-LAUNCH-MUST-NOT-BE-REPORTED";
    writeFileSync(logPath, oldLogLine + "\n", { mode: 0o600 });
    const collisionReady = join(sandbox, "collision.ready");
    const collision = spawn(realNode, [
      "-e",
      `const http=require("node:http"),fs=require("node:fs"); const s=http.createServer((q,r)=>{r.setHeader("content-type","application/json");r.end(JSON.stringify({space:${JSON.stringify(SPACE)},pid:process.pid}))}); s.listen(${WEB_PORT},"127.0.0.1",()=>fs.writeFileSync(${JSON.stringify(collisionReady)},"ready")); setInterval(()=>{},1000);`,
    ], { detached: true, stdio: "ignore" });
    collision.unref();
    if (collision.pid) ownPids.push(collision.pid);
    for (let i = 0; i < 100 && !existsSync(collisionReady); i++) await sleep(20);
    ok("port-collision fixture is listening", existsSync(collisionReady));
    const collided = cotalAt(sandbox, ["web", "--detach", "--space", SPACE, "--port", String(WEB_PORT), "--no-open"]);
    ok("detached readiness never accepts another listener's pid", collided.status === 1 && /exited before becoming ready/.test(collided.stderr) && /Port .* is in use/.test(collided.stderr), collided.stdout + collided.stderr);
    ok("failed launch reports only its appended log tail", !collided.stderr.includes(oldLogLine), collided.stderr);
    ok("failed launch leaves no child pidfile", !existsSync(join(root, ".cotal", "web.pid")));
    if (collision.pid) try { process.kill(collision.pid, "SIGTERM"); } catch { /* gone */ }
    for (let i = 0; collision.pid && alive(collision.pid) && i < 100; i++) await sleep(20);

    rmSync(logPath, { force: true });
    const shadowPath = join(home, "meshes", "aaa-shadow.json");
    const currentPath = join(home, "current-mesh");
    writeFileSync(shadowPath, JSON.stringify({ space: "aaa-shadow", server, root, mode: "open", ts: new Date().toISOString() }), { mode: 0o600 });
    writeFileSync(currentPath, SPACE, { mode: 0o600 });
    ok("canonical-target fixture is isolated and ambiguous", existsSync(join(home, "meshes", `${SPACE}.json`)) && existsSync(shadowPath) && readFileSync(currentPath, "utf8") === SPACE);
    const detached = cotalAt(sandbox, ["web", "--detach", "--port", String(WEB_PORT), "--no-open"]);
    ok("implicit detached launch from outside the root exits only after HTTP readiness", detached.status === 0 && /web dashboard ready/.test(detached.stdout), detached.stdout + detached.stderr);
    const webPid = Number(readFileSync(join(root, ".cotal", "web.pid"), "utf8").trim());
    const reportedPid = Number(detached.stdout.match(/\(pid (\d+)\)/)?.[1]);
    ownPids.push(webPid);
    const detachedMeta = await (await fetch(`http://127.0.0.1:${WEB_PORT}/api/meta`)).json() as { space?: string; pid?: number };
    ok("detached child preserves the implicit parent target across same-root registry ambiguity", detachedMeta.space === SPACE && detachedMeta.pid === webPid && reportedPid === webPid && alive(webPid), detachedMeta);
    ok("detached launch creates a private diagnostic log", existsSync(logPath) && (statSync(logPath).mode & 0o777) === 0o600 && /Cotal web/.test(readFileSync(logPath, "utf8")));

    const duplicate = cotalAt(sandbox, ["web", "--detach", "--space", SPACE, "--port", String(WEB_PORT + 1), "--no-open"]);
    ok("a second detached launch fails without disturbing the recorded owner", duplicate.status === 1 && /already running/.test(duplicate.stderr) && alive(webPid) && readFileSync(join(root, ".cotal", "web.pid"), "utf8").trim() === String(webPid), duplicate.stdout + duplicate.stderr);

    const down = cotal(["down"]);
    ok("bare down stops detached web, removes the shadow, and stops the auth mesh", down.status === 0 && !alive(webPid) && !existsSync(join(root, ".cotal", "web.pid")) && !existsSync(shadowPath), down.stdout + down.stderr);
  }

  // -- D: remove the extension; the surface shrinks back ---------------------------------------------
  {
    ok("ext remove @cotal-ai/web exits 0", cotal(["ext", "remove", "@cotal-ai/web"]).status === 0);
    const r = cotal(["web"]);
    ok("`cotal web` is unknown again after remove", r.status === 1 && /unknown command: web/.test(r.stderr), r.stderr.slice(0, 150));
  }

  console.log(`\nDOGFOOD LIVE SMOKE OK ✅ (${pass} checks)`);
} finally {
  webChild?.kill("SIGKILL");
  spawnSync(realNode, [tsxCli, binCotal, "down"], { encoding: "utf8", env, cwd: root });
  for (const p of ownPids) if (alive(p)) { try { process.kill(p, "SIGTERM"); } catch { /* gone */ } }
  rmSync(sandbox, { recursive: true, force: true });
}
