/**
 * LIVE: a folder an earlier release started keeps its own launcher after a normal `down`, and a
 * refused controller `up` leaves its folder unchanged.
 *
 *  1. Legacy root. An unprepared folder started with `up --server` takes the retained launcher and
 *     writes no stack journal. After `down` removes its registration, `space create` refuses
 *     CONFLICT and names `cotal up`, and plain `up` starts it again with the same store and account
 *     identity, still with no stack journal.
 *  2. Controller root without its registration. After `down` and `space forget`, `up` refuses
 *     TARGET_UNAVAILABLE (exit 2), and after `space add --force` it refuses CONFLICT (exit 2, not 3).
 *     Neither writes the stack journal, `server.conf` or a new service instance record.
 *
 * Sandboxes COTAL_HOME and both project roots. Run: pnpm smoke:legacy-root-upgrade:live
 */
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { assertSmokeSandboxDown, createSuite, freePort, recordSmokeSandbox, type SmokeSandboxAnchor } from "@cotal-ai/smoke-kit";

const WT = resolve(import.meta.dirname, "..", "..", "..");
const CLI = join(WT, "bin", "cotal.ts");
const TSX_IMPORT = import.meta.resolve("tsx");
const home = mkdtempSync(join(tmpdir(), "cotal-legacy-root-"));
const configDir = join(home, "xdg");
// Set before the stores are imported; they read COTAL_HOME on each call.
process.env.COTAL_HOME = home;
const env = { ...process.env, COTAL_HOME: home, XDG_CONFIG_HOME: configDir, COTAL_SKIP_CONNECTOR_SEED: "1" };
const { serviceInstances } = await import("../src/lib/service-instances.js");
const { findMesh } = await import("@cotal-ai/workspace");

const { check, finish } = createSuite();
const anchors = new Map<string, SmokeSandboxAnchor>();
const roots: string[] = [];

type Envelope = { outcome: string; error?: { code: string; message: string; remedy?: string } };
type Run = { status: number | null; stdout: string; stderr: string; env?: Envelope };
const cli = (cwd: string, ...args: string[]): Run => {
  const options = { cwd, env, encoding: "utf8" as const, timeout: 180_000 };
  assertSmokeSandboxDown(anchors.get(cwd), args, options);
  const run = spawnSync(process.execPath, ["--import", TSX_IMPORT, CLI, ...args], options);
  let parsed: Envelope | undefined;
  try { parsed = JSON.parse(run.stdout) as Envelope; } catch { parsed = undefined; }
  return { status: run.status, stdout: run.stdout, stderr: run.stderr, env: parsed };
};
const shown = (run: Run) => ({ status: run.status, error: run.env?.error, out: run.stdout.slice(-1000), err: run.stderr.slice(-1500) });
const digest = (path: string) => existsSync(path) ? createHash("sha256").update(readFileSync(path)).digest("hex") : "absent";
const accountFiles = (root: string) => readdirSync(join(root, ".cotal", "auth")).filter((name) => name.startsWith("account.")).sort();
// Project roots sit beside COTAL_HOME, never inside it.
const folder = (name: string) => {
  const root = mkdtempSync(join(tmpdir(), `cotal-legacy-root-${name}-`));
  roots.push(root);
  return root;
};
const anchor = (root: string) => anchors.set(root, recordSmokeSandbox({ root, cotalHome: home, xdgConfigHome: configDir }));

process.on("exit", () => { for (const path of [home, ...roots]) rmSync(path, { recursive: true, force: true }); });

try {
  // 1. A legacy root after a normal down, and the `space create` remedy there.
  {
    const space = "legacy1";
    const root = folder(space);
    const server = `nats://127.0.0.1:${await freePort()}`;
    const first = cli(root, "up", "--server", server, "--space", space);
    anchor(root);
    check("an unprepared folder starts on the retained launcher", first.status === 0, shown(first));
    check("the retained launcher writes no stack journal", !existsSync(join(root, ".cotal", "stack-controller.json")));
    const store = digest(join(root, ".cotal", "store.id"));
    const accounts = accountFiles(root).map((name) => `${name}:${digest(join(root, ".cotal", "auth", name))}`);
    const stopped = cli(root, "down");
    check("down stops it and removes its registration", stopped.status === 0 && findMesh(space) === undefined, shown(stopped));

    const create = cli(home, "space", "create", space, "--root", root, "--json");
    check("space create refuses CONFLICT and names cotal up", create.status === 2 && create.env?.error?.code === "CONFLICT" && Boolean(create.env.error.remedy?.includes("cotal up")), shown(create));
    const again = cli(root, "up", "--space", space);
    check("plain up starts the stopped legacy root again", again.status === 0, shown(again));
    check("it still has no stack journal", !existsSync(join(root, ".cotal", "stack-controller.json")));
    check("its store identity is unchanged", digest(join(root, ".cotal", "store.id")) === store);
    check("its account records are unchanged", JSON.stringify(accountFiles(root).map((name) => `${name}:${digest(join(root, ".cotal", "auth", name))}`)) === JSON.stringify(accounts));
    const last = cli(root, "down");
    check("down stops it again", last.status === 0, shown(last));
  }

  // 2. A controller root whose registration is gone, then hand-added.
  {
    const space = "ctl1";
    const root = folder(space);
    const server = `nats://127.0.0.1:${await freePort()}`;
    const created = cli(home, "space", "create", space, "--root", root, "--json");
    check("space create prepares the controller root", created.status === 0, shown(created));
    anchor(root);
    const started = cli(root, "up", "--server", server, "--no-manager", "--json");
    check("up starts the controller stack", started.status === 0, shown(started));
    const stopped = cli(root, "down", "--yes", "--json");
    check("down --yes stops it", stopped.status === 0, shown(stopped));
    const forgot = cli(home, "space", "forget", space, "--json");
    check("space forget removes its prepared record", forgot.status === 0, shown(forgot));

    const journal = join(root, ".cotal", "stack-controller.json"), conf = join(root, ".cotal", "auth", "server.conf");
    const snapshot = () => JSON.stringify({ journal: digest(journal), conf: digest(conf), instances: serviceInstances(space).map((row) => `${row.name}:${row.record.revision}`).sort() });
    const before = snapshot();
    const unregistered = cli(root, "up", "--json");
    check("up without a registration refuses TARGET_UNAVAILABLE, exit 2", unregistered.status === 2 && unregistered.env?.error?.code === "TARGET_UNAVAILABLE", shown(unregistered));
    check("that refusal wrote no journal, server.conf or instance record", snapshot() === before, { before, after: snapshot() });

    const added = cli(home, "space", "add", space, "--server", server, "--root", root, "--force", "--yes", "--json");
    check("space add --force records a manual registration", added.status === 0, shown(added));
    const manual = cli(root, "up", "--json");
    check("up over a manual registration refuses CONFLICT, exit 2, not an unknown outcome", manual.status === 2 && manual.env?.error?.code === "CONFLICT", shown(manual));
    check("that refusal wrote nothing either", snapshot() === before, { before, after: snapshot() });
    cli(home, "space", "forget", space, "--json");
  }
} finally {
  for (const root of roots) if (anchors.has(root) && !existsSync(join(root, ".cotal", "stack-controller.json"))) cli(root, "down");
}
finish();
