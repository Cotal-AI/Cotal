/**
 * DOGFOOD LIVE e2e: the REAL `@cotal-ai/web` package installed through the REAL `cotal ext`
 * mechanism and exercised against a REAL mesh — the full operator journey:
 *
 *  A. `web` left the core surface (unknown command; the built-in count shrank).
 *  B. `cotal ext add ./implementations/web` — the first real MULTI-PEER extension: BOTH
 *     @cotal-ai/core and @cotal-ai/workspace get linked to this binary's copies (provenance
 *     proves it); help + <TAB> list `web` from the manifest cache.
 *  C. `cotal up --detach` (JWT auth) then `cotal web`: the dashboard serves /, /app.js (packaged
 *     assets) and /api/meta over HTTP against the live mesh — the admin-mint + purger-pre-mint
 *     path, exactly as an operator runs it.
 *  D. `ext remove @cotal-ai/web`; `web` is unknown again.
 *
 * Needs dist built (the packages install per their `files: ["dist"]`), `nats-server` + npm on
 * PATH. Sandboxes COTAL_HOME/XDG_CONFIG_HOME + a temp root; kills only its own pids.
 * Run: pnpm smoke:dogfood:live
 */
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
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
const cotal = (args: string[], timeout = 180_000) =>
  spawnSync(realNode, [tsxCli, binCotal, ...args], { encoding: "utf8", env, cwd: root, timeout });
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
    ok("<TAB> offers web's cached flags", comp.status === 0 && /--port/.test(comp.stdout), comp.stdout);
  }

  // -- C: the dashboard runs against a real JWT-authed mesh -----------------------------------------
  {
    const up = cotal(["up", "--detach", "--server", `nats://127.0.0.1:${AUTH_PORT}`]);
    ok("up --detach (auth) exits 0", up.status === 0, (up.stdout + up.stderr).slice(-400));
    for (const f of ["nats.pid", "delivery.pid", "manager.pid"] as const) {
      const pid = Number(readFileSync(join(root, ".cotal", f), "utf8").trim());
      ownPids.push(pid);
    }
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
    const meta = (await (await fetch(`http://127.0.0.1:${WEB_PORT}/api/meta`)).json()) as { space?: string };
    ok("live /api/meta answers with the mesh's space", typeof meta.space === "string" && meta.space.length > 0, meta);
    webChild.kill("SIGTERM");
    const down = cotal(["down"]);
    ok("down stops the auth mesh", down.status === 0, down.stderr.slice(-200));
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
