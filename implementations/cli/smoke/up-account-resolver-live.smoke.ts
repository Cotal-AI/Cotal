/**
 * LIVE: `cotal up --account-resolver full` must start the broker on nats-server's full account
 * resolver and KEEP it across a plain later `up`, and `--account-resolver memory` must take it back.
 *
 * `serverConfig` renders the full resolver (`accountResolver: { kind: "full" }`), which lets a host
 * add and retire space accounts on the running broker with `pushAccountClaim` instead of a reload.
 * But `up` rendered `resolver: MEMORY` on every start, and nats-server switches resolvers only at
 * start and refuses a reload that changes one, so a broker `up` started could never take a push and
 * a host that rendered the full resolver had its next reload refused.
 *
 * Judged on what the broker DOES, not only on the text: the full resolver stores each account it
 * resolves in its directory, so the space account's claim appearing there as `<pub>.jwt` is
 * nats-server's own evidence that it runs that resolver. MEMORY writes no such file.
 *
 *  1. `up --account-resolver full` renders the full resolver, records it, creates the directory
 *     owner-private, and the broker stores the space account's claim there.
 *  2. a running broker refuses `--account-resolver memory`: the resolver is fixed at its start.
 *  3. `down`, then a PLAIN `up` renders and records the full resolver again.
 *  4. `down`, then `up --account-resolver memory` renders MEMORY and drops the record.
 *
 * Sandboxes COTAL_HOME and a project root under a scratch base with proven-clean `.cotal` ancestry;
 * kills only its own children. Needs `nats-server` on PATH.
 * Run: pnpm smoke:up-account-resolver:live  (BUILD FIRST - the subprocess runs built dist.)
 */
import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { join, resolve as resolvePath } from "node:path";
import { assertSmokeSandboxDown, freePort, recordSmokeSandbox } from "@cotal-ai/smoke-kit";
import { makeScratch, assertScratchHeld } from "../../../bin/smoke/_scratch.js";

const scratch = makeScratch("cotal-up-resolver-");
const home = mkdtempSync(join(scratch, "home-"));
const root = mkdtempSync(join(scratch, "root-"));
const configDir = join(home, "xdg");
const sandbox = recordSmokeSandbox({ root, cotalHome: home, xdgConfigHome: configDir });
process.env.COTAL_HOME = home;

const { authDir, accountJwtsDir, loadSpaceAccountAuth, ACCOUNT_JWT_LIMIT } = await import("@cotal-ai/workspace");

const WT = resolvePath(import.meta.dirname, "..", "..", "..");
const CLI = join(WT, "bin", "cotal.ts");
// Loading tsx into node makes the child the CLI itself; the `.bin/tsx` shim would relay only SIGINT
// and SIGTERM and orphan it.
const TSX_IMPORT = import.meta.resolve("tsx");

let pass = 0;
const ok = (name: string, cond: boolean, extra?: unknown) => {
  if (!cond) throw new Error(`FAIL: ${name}${extra !== undefined ? ` - ${JSON.stringify(extra)}` : ""}`);
  pass++;
  console.log(`  ✓ ${name}`);
};

/** The ambient environment with every `COTAL_` key stripped, then this smoke's own sandbox put
 *  back: a suite run from a mesh-joined session would otherwise point the real CLI at the caller's
 *  mesh and pass while doing it. Enforced by bin/smoke/suite-ambient-env.smoke.ts. */
const sandboxEnv = (() => {
  const copy = { ...process.env };
  for (const key of Object.keys(copy)) if (key.startsWith("COTAL_")) delete copy[key];
  return { ...copy, COTAL_HOME: home, XDG_CONFIG_HOME: configDir, COTAL_SKIP_CONNECTOR_SEED: "1", NO_COLOR: "1" };
})();

const kids: ChildProcess[] = [];
async function run(args: string[]): Promise<{ status: number | null; out: string }> {
  const options = { cwd: root, env: sandboxEnv, stdio: ["ignore", "pipe", "pipe"] as ["ignore", "pipe", "pipe"] };
  assertSmokeSandboxDown(sandbox, args, options);
  const cp = spawn(process.execPath, ["--import", TSX_IMPORT, CLI, ...args], options);
  kids.push(cp);
  let out = "";
  cp.stdout?.on("data", (b: Buffer) => { out += b.toString(); });
  cp.stderr?.on("data", (b: Buffer) => { out += b.toString(); });
  await once(cp, "exit");
  return { status: cp.exitCode, out };
}

const confText = () => readFileSync(join(authDir(root), "server.conf"), "utf8");
const resolverLine = () => confText().split("\n").find((l) => l.startsWith("resolver:"));
const recordedResolver = () => (JSON.parse(readFileSync(join(root, ".cotal", "broker-policy.json"), "utf8")) as { accountResolver?: unknown }).accountResolver;
const dir = accountJwtsDir(root);
const fullLine = `resolver: { type: full, dir: ${JSON.stringify(dir)}, allow_delete: false, interval: "60000ms", limit: ${ACCOUNT_JWT_LIMIT} }`;

/** Wait for the broker to store `pub`'s claim in the resolver directory: it does so while it loads
 *  its preloads, which can trail the listener coming up. */
async function storedClaim(pub: string, budgetMs = 5_000): Promise<string | undefined> {
  const file = join(dir, `${pub}.jwt`);
  for (const deadline = Date.now() + budgetMs; Date.now() < deadline; await new Promise((r) => setTimeout(r, 100)))
    if (existsSync(file)) return readFileSync(file, "utf8");
  return undefined;
}

try {
  mkdirSync(join(root, ".cotal"), { recursive: true });
  assertScratchHeld(root, "up account-resolver fixture");
  const port = await freePort();
  const server = `nats://127.0.0.1:${port}`;
  const space = "resolver";

  console.log("1) cotal up --account-resolver full");
  const first = await run(["up", "--detach", "--no-manager", "--space", space, "--server", server, "--account-resolver", "full"]);
  ok("up --account-resolver full exits 0", first.status === 0, first.out.slice(-1500));
  ok("…and renders the full resolver on the root's account-jwts directory", resolverLine() === fullLine, resolverLine());
  ok("…and records it in the broker policy", recordedResolver() === "full", recordedResolver());
  ok("…and creates that directory owner-private", existsSync(dir) && (statSync(dir).mode & 0o077) === 0, existsSync(dir) ? (statSync(dir).mode & 0o777).toString(8) : "missing");
  const account = loadSpaceAccountAuth(authDir(root), space);
  ok("the space account record exists", account !== undefined);
  ok("…and the broker stored the space account's claim there, so it runs the full resolver", await storedClaim(account!.account.pub) === account!.account.jwt);

  console.log("\n2) a running broker refuses a different --account-resolver");
  const conflict = await run(["up", "--space", space, "--server", server, "--account-resolver", "memory"]);
  ok("--account-resolver memory on a running full broker exits non-zero", conflict.status !== 0, { status: conflict.status, out: conflict.out.slice(-800) });
  ok("…naming that the resolver is fixed at start and the `cotal down` that frees it",
    conflict.out.includes("can't change --account-resolver") && conflict.out.includes("cotal down"), conflict.out.slice(-800));
  ok("…and changes neither the record nor the rendered resolver", recordedResolver() === "full" && resolverLine() === fullLine);

  console.log("\n3) down, then a PLAIN up renders the recorded full resolver again");
  const down = await run(["down", "--yes"]);
  ok("down exits 0", down.status === 0, down.out.slice(-1500));
  rmSync(join(dir, `${account!.account.pub}.jwt`));
  const again = await run(["up", "--detach", "--no-manager", "--space", space, "--server", server]);
  ok("a plain up with no flag exits 0", again.status === 0, again.out.slice(-1500));
  ok("…and renders the full resolver again", resolverLine() === fullLine, resolverLine());
  ok("…and the restarted broker stores the space account's claim again", await storedClaim(account!.account.pub) === account!.account.jwt);
  ok("…and the record is unchanged", recordedResolver() === "full", recordedResolver());

  console.log("\n4) down, then up --account-resolver memory takes the root back to MEMORY");
  const down2 = await run(["down", "--yes"]);
  ok("down exits 0", down2.status === 0, down2.out.slice(-1500));
  rmSync(join(dir, `${account!.account.pub}.jwt`));
  const memory = await run(["up", "--detach", "--no-manager", "--space", space, "--server", server, "--account-resolver", "memory"]);
  ok("up --account-resolver memory exits 0", memory.status === 0, memory.out.slice(-1500));
  ok("…and renders resolver: MEMORY", resolverLine() === "resolver: MEMORY", resolverLine());
  ok("…and the record no longer names a resolver", recordedResolver() === undefined, recordedResolver());
  ok("…and the broker stores no claim in the directory", await storedClaim(account!.account.pub, 1_500) === undefined);

  const last = await run(["down", "--yes"]);
  ok("the final down exits 0", last.status === 0, last.out.slice(-1500));
  console.log(`\nup-account-resolver live smoke: OK - ${pass} checks`);
} finally {
  for (const cp of kids) { try { cp.kill("SIGKILL"); } catch { /* already gone */ } }
}
