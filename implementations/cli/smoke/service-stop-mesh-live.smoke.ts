/**
 * `service stop` names the mesh before it prints the stop impact.
 *
 * `service stop` and `service restart` printed the native impact or broker stop scope before the
 * result, and that first report had no `Mesh:` line, so the space was named only after the review.
 * The impact is now the first report and begins with `Mesh: <space>`, as `down` does.
 *
 * Prepares a space at a sandboxed root (`space create`), so `up --detach --open --no-manager` starts
 * it as a controller stack whose broker is the saved `stack-broker` definition. An unprepared root
 * takes the retained launcher, which saves no definition for `service stop` to resolve. It then
 * stops that broker with `service stop stack-broker --yes --plain`; that stop is also the teardown.
 * If the suite fails before it, every running instance the sandbox's own `service --json` inventory
 * lists is sent SIGTERM by pid. Needs `nats-server` on PATH.
 *
 * Run: pnpm smoke:service-stop-mesh:live
 */
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createSuite, freePort } from "@cotal-ai/smoke-kit";

const BIN = join(import.meta.dirname, "..", "..", "..", "bin", "dist", "cotal.js");
if (!existsSync(BIN)) {
  console.error(`✗ ${BIN} missing - build first: pnpm --filter cotal-ai... build`);
  process.exit(1);
}

interface Inventory { result?: { instances?: { pid?: number; observedProcess?: string }[] } }

const { check, finish } = createSuite();
const home = mkdtempSync(join(tmpdir(), "cotal-service-stop-mesh-"));
const root = realpathSync(mkdtempSync(join(home, "project-")));
const space = `svcmesh-${randomUUID().slice(0, 8)}`;
const server = `nats://127.0.0.1:${await freePort()}`;
const HOST_ENV = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith("COTAL_") && k !== "FORCE_COLOR" && k !== "NO_COLOR"));
const env = { ...HOST_ENV, HOME: home, USERPROFILE: home, XDG_CONFIG_HOME: join(home, ".config"), COTAL_HOME: join(home, ".cotal"), COTAL_SKIP_CONNECTOR_SEED: "1", NO_COLOR: "1" };
const cotal = (...words: string[]) => {
  const r = spawnSync(process.execPath, [BIN, ...words], { cwd: root, env, encoding: "utf8", timeout: 120_000 });
  return { status: r.status, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
};
const shown = (r: ReturnType<typeof cotal>) => ({ status: r.status, stdout: r.stdout.slice(0, 1200), stderr: r.stderr.slice(0, 600) });

try {
  const prepared = cotal("space", "create", space, "--root", root);
  check("fixture: the space is prepared at the sandbox root", prepared.status === 0, shown(prepared));
  const up = cotal("up", "--detach", "--open", "--no-manager", "--server", server, "--space", space);
  check("fixture: an open broker-only controller stack starts", up.status === 0 && existsSync(join(root, ".cotal", "stack-controller.json")), shown(up));

  const stop = cotal("service", "stop", "stack-broker", "--yes", "--plain");
  const mesh = stop.stdout.indexOf(`Mesh: ${space}`), scope = stop.stdout.indexOf("Broker stop scope");
  check("service stop of the stack broker exits 0", stop.status === 0, shown(stop));
  check("its output begins with Mesh: <space>", stop.stdout.split("\n")[0] === `Mesh: ${space}`, shown(stop));
  check("the broker stop scope is printed after that Mesh line", mesh === 0 && scope > mesh, { mesh, scope, stdout: stop.stdout.slice(0, 1200) });
} catch (error) {
  check("scenario completed", false, (error as Error).stack ?? String(error));
} finally {
  const inventory = cotal("service", "--json");
  let rows: NonNullable<NonNullable<Inventory["result"]>["instances"]> = [];
  try { rows = (JSON.parse(inventory.stdout) as Inventory).result?.instances ?? []; } catch { rows = []; }
  for (const row of rows) {
    if (row.observedProcess !== "running" || typeof row.pid !== "number") continue;
    try { process.kill(row.pid, "SIGTERM"); } catch { /* already gone */ }
  }
  rmSync(home, { recursive: true, force: true });
}

finish();
process.exit(process.exitCode ?? 0);
