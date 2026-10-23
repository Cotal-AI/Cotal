/**
 * LIVE: a bad broker address never pins a folder, a live stack's streams are not deleted under it,
 * and reset works after a normal `down`.
 *
 *  1. Broker address. `up --server notaurl` refuses USAGE_INVALID (exit 1) in an unprepared and a
 *     prepared folder, and a DNS-named address refuses on the controller route (exit 2). None of
 *     them writes a stack journal or a registration, and the prepared folder then starts on a
 *     valid address.
 *  2. Space delete on a live stack. `space delete --yes` refuses LIFECYCLE_BLOCKED (exit 2) before
 *     any broker connection and names `cotal down` and `cotal reset store`; the dry run warns. The
 *     stack still stops cleanly.
 *  3. Reset verdicts. On the live stack `reset store --dry-run` exits 0 with a refused verdict and
 *     a remedy naming `cotal down`, and `reset space --dry-run` refuses with that remedy.
 *  4. Reset after a normal down. `reset store` is offered and removes the store, and `up` starts
 *     again. `reset space` is offered and removes the identity, keeping the prepared record and
 *     the stack journal, and `up` starts again with a new account.
 *  5. A forgotten name starts elsewhere. After `down --yes`, `space forget` removes the stack
 *     definitions saved for the root, and another folder starts a stack under the same name.
 *  6. Space delete under a stopped stack. With only the broker running the delete applies, and its
 *     receipt names `cotal down --yes` and `cotal space forget`. A bare `up` then refuses
 *     TARGET_NOT_FOUND (exit 2), saying the broker lost the streams and naming the restart, which
 *     starts the stack again.
 *  7. A stack whose registration an older CLI dropped or replaced. With none, `down --yes` refuses
 *     CONFLICT (exit 2) and stops nothing while the broker's launch receipt names another address,
 *     and stops the stack through its journal once it matches. A registration added by hand at
 *     another address refuses CONFLICT, naming `cotal space forget`, and stays. One added by hand
 *     at the stack's own root and broker is stopped through, and neither leaves a registration.
 *
 * Sandboxes COTAL_HOME and every project root. Run: pnpm smoke:space-teardown:live
 */
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { assertSmokeSandboxDown, createSuite, freePort, recordSmokeSandbox, type SmokeSandboxAnchor } from "@cotal-ai/smoke-kit";

const WT = resolve(import.meta.dirname, "..", "..", "..");
const CLI = join(WT, "bin", "cotal.ts");
const TSX_IMPORT = import.meta.resolve("tsx");
const home = mkdtempSync(join(tmpdir(), "cotal-space-teardown-"));
const configDir = join(home, "xdg");
// The CLI children must not inherit a managed session's mesh identity from whatever runs this
// suite; they get only the private home and the values set below.
for (const key of Object.keys(process.env)) if (key.startsWith("COTAL_")) delete process.env[key];
// Set before the stores are imported; they read COTAL_HOME on each call.
process.env.COTAL_HOME = home;
const env = { ...process.env, COTAL_HOME: home, XDG_CONFIG_HOME: configDir, COTAL_SKIP_CONNECTOR_SEED: "1" };
const { findMesh, findPreparedSpace, recordMesh, removeMesh } = await import("@cotal-ai/workspace");
const { observeServiceProcess, serviceInstances, serviceInstanceStore } = await import("../src/lib/service-instances.js");

const { check, finish } = createSuite();
const anchors = new Map<string, SmokeSandboxAnchor>();
const roots: string[] = [];

type Envelope = {
  outcome: string;
  error?: { code: string; message: string; remedy?: string };
  warnings?: { code: string; message: string }[];
  result?: Record<string, unknown> & { applyVerdict?: { offered: boolean; code?: string; remedy?: string | null } };
};
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
const journalOf = (root: string) => join(root, ".cotal", "stack-controller.json");
const accountDigest = (root: string) => {
  const dir = join(root, ".cotal", "auth");
  if (!existsSync(dir)) return "absent";
  const hash = createHash("sha256");
  for (const name of readdirSync(dir).filter((file) => file.startsWith("account.")).sort()) hash.update(name).update(readFileSync(join(dir, name)));
  return hash.digest("hex");
};
// Project roots sit beside COTAL_HOME, never inside it.
const folder = (name: string) => {
  const root = mkdtempSync(join(tmpdir(), `cotal-space-teardown-${name}-`));
  roots.push(root);
  return root;
};
const anchor = (root: string) => anchors.set(root, recordSmokeSandbox({ root, cotalHome: home, xdgConfigHome: configDir }));

process.on("exit", () => { for (const path of [home, ...roots]) rmSync(path, { recursive: true, force: true }); });

try {
  // 1. A bad broker address refuses before anything is written (B6-01).
  {
    const loose = folder("loose");
    const typo = cli(loose, "up", "--server", "notaurl", "--space", "loose", "--json");
    check("up --server notaurl in an unprepared folder refuses USAGE_INVALID, exit 1", typo.status === 1 && typo.env?.error?.code === "USAGE_INVALID", shown(typo));
    check("it wrote no stack journal and no registration", !existsSync(journalOf(loose)) && findMesh("loose") === undefined);

    const space = "addr1";
    const root = folder(space);
    const created = cli(home, "space", "create", space, "--root", root, "--json");
    check("space create prepares the folder", created.status === 0, shown(created));
    anchor(root);
    const prepared = cli(root, "up", "--server", "notaurl", "--json");
    check("up --server notaurl in a prepared folder refuses USAGE_INVALID, exit 1", prepared.status === 1 && prepared.env?.error?.code === "USAGE_INVALID", shown(prepared));
    const port = await freePort();
    const named = cli(root, "up", "--server", `nats://localhost:${port}`, "--json");
    check("a DNS-named address refuses on the controller route, exit 2", named.status === 2 && named.env?.error?.code === "UNSUPPORTED", shown(named));
    check("neither refusal wrote a stack journal or a registration", !existsSync(journalOf(root)) && findMesh(space) === undefined);
    const started = cli(root, "up", "--server", `nats://127.0.0.1:${port}`, "--no-manager", "--json");
    check("the same folder then starts on a valid address", started.status === 0, shown(started));
    const stopped = cli(root, "down", "--yes", "--json");
    check("down --yes stops it", stopped.status === 0, shown(stopped));
  }

  // 2-4. One static-auth controller stack through delete, reset verdicts and reset after down.
  {
    const space = "tear1";
    const root = folder(space);
    const server = `nats://127.0.0.1:${await freePort()}`;
    const created = cli(home, "space", "create", space, "--root", root, "--json");
    check("space create prepares the controller root", created.status === 0, shown(created));
    anchor(root);
    const started = cli(root, "up", "--server", server, "--no-manager", "--json");
    check("up starts the broker and delivery", started.status === 0, shown(started));

    // 2. Space delete refuses while the stack runs (B4-01).
    const preview = cli(home, "space", "delete", space, "--dry-run", "--json");
    check("space delete --dry-run warns that the apply would refuse", Boolean(preview.env?.warnings?.some((row) => row.code === "LIFECYCLE_BLOCKED")) && preview.env?.result?.applyBlockedBy !== null, shown(preview));
    check("the preview read the broker, so its warning does not say no broker was contacted", !preview.env?.warnings?.some((row) => row.message.includes("no broker was contacted")), preview.env?.warnings);
    const deleted = cli(home, "space", "delete", space, "--yes", "--json");
    check("space delete --yes refuses LIFECYCLE_BLOCKED, exit 2", deleted.status === 2 && deleted.env?.error?.code === "LIFECYCLE_BLOCKED", shown(deleted));
    check("its remedy names cotal down and cotal reset store", Boolean(deleted.env?.error?.remedy?.includes("cotal down")) && Boolean(deleted.env?.error?.remedy?.includes(`cotal reset store ${space}`)), deleted.env?.error);

    // 3. Reset previews and refusals carry a verdict, one reason and a Next (B4-04).
    const storeLive = cli(root, "reset", "store", space, "--dry-run", "--json");
    check("reset store --dry-run on a live stack exits 0 with a refused verdict", storeLive.status === 0 && storeLive.env?.result?.applyVerdict?.offered === false && storeLive.env.result.applyVerdict.code === "LIFECYCLE_BLOCKED", shown(storeLive));
    check("that verdict's remedy names cotal down", Boolean(storeLive.env?.result?.applyVerdict?.remedy?.includes("cotal down")), storeLive.env?.result?.applyVerdict);
    const spaceLive = cli(root, "reset", "space", space, "--dry-run", "--json");
    check("reset space --dry-run on a live stack refuses with a remedy naming cotal down", spaceLive.status === 2 && spaceLive.env?.error?.code === "LIFECYCLE_BLOCKED" && Boolean(spaceLive.env.error.remedy?.includes("cotal down")), shown(spaceLive));

    const stopped = cli(root, "down", "--yes", "--json");
    check("the refused delete left a stack that down --yes stops", stopped.status === 0, shown(stopped));
    check("down removed the registration and kept the prepared record", findMesh(space) === undefined && findPreparedSpace(space) !== undefined);
    // Starting it again to delete would meet the running-stack refusal, so the stopped refusal names reset store.
    const deleteStopped = cli(home, "space", "delete", space, "--yes", "--json");
    check("space delete after down refuses TARGET_UNAVAILABLE and names cotal reset store, not cotal up",
      deleteStopped.status === 2 && deleteStopped.env?.error?.code === "TARGET_UNAVAILABLE" && Boolean(deleteStopped.env.error.remedy?.includes(`cotal reset store ${space} --yes`)) && !deleteStopped.env.error.remedy?.includes("cotal up"), shown(deleteStopped));

    // 4. Reset after a normal down (B4-02).
    const storeStopped = cli(root, "reset", "store", space, "--dry-run", "--json");
    check("reset store --dry-run after down offers the apply", storeStopped.status === 0 && storeStopped.env?.result?.applyVerdict?.offered === true, shown(storeStopped));
    const storeApplied = cli(root, "reset", "store", space, "--yes", "--json");
    check("reset store --yes removes the stopped store", storeApplied.status === 0 && storeApplied.env?.result?.selectedBy === "stopped-stack" && Array.isArray(storeApplied.env.result.removedPaths) && (storeApplied.env.result.removedPaths as unknown[]).length > 0, shown(storeApplied));
    const restarted = cli(root, "up", "--json");
    check("bare up starts the stack again on an empty store", restarted.status === 0, shown(restarted));
    const before = accountDigest(root);
    const stoppedAgain = cli(root, "down", "--yes", "--json");
    check("down --yes stops it again", stoppedAgain.status === 0, shown(stoppedAgain));

    const spacePreview = cli(root, "reset", "space", space, "--dry-run", "--json");
    check("reset space --dry-run after down offers the apply", spacePreview.status === 0 && spacePreview.env?.result?.applyVerdict?.offered === true, shown(spacePreview));
    const spaceApplied = cli(root, "reset", "space", space, "--yes", "--json");
    check("reset space --yes removes the identity and keeps the stack's records", spaceApplied.status === 0 && spaceApplied.env?.result?.localIdentityRemoved === true && spaceApplied.env.result.registrationRemoved === false, shown(spaceApplied));
    check("the prepared record and the stack journal stay", findPreparedSpace(space) !== undefined && existsSync(journalOf(root)));
    const fresh = cli(root, "up", "--json");
    check("bare up starts it again", fresh.status === 0, shown(fresh));
    check("with a new account identity", accountDigest(root) !== before && accountDigest(root) !== "absent", { before, after: accountDigest(root) });
    const last = cli(root, "down", "--yes", "--json");
    check("down --yes stops it", last.status === 0, shown(last));
  }

  // 5. A forgotten space's stack definitions go with it, so its name starts in another folder.
  {
    const space = "tear2";
    const root = folder(space);
    const created = cli(home, "space", "create", space, "--root", root, "--json");
    check("space create prepares a second controller root", created.status === 0, shown(created));
    anchor(root);
    const started = cli(root, "up", "--server", `nats://127.0.0.1:${await freePort()}`, "--no-manager", "--json");
    const stopped = cli(root, "down", "--yes", "--json");
    check("up starts it and down --yes stops it", started.status === 0 && stopped.status === 0, { up: shown(started), down: shown(stopped) });
    const forgot = cli(home, "space", "forget", space, "--json");
    check("space forget removes the stack definitions saved for the root",
      forgot.status === 0 && JSON.stringify(forgot.env?.result?.releasedDefinitions) === JSON.stringify(["stack-broker", "stack-delivery"]), shown(forgot));
    const elsewhere = folder(`${space}b`);
    const again = cli(home, "space", "create", space, "--root", elsewhere, "--json");
    anchor(elsewhere);
    const reused = cli(elsewhere, "up", "--server", `nats://127.0.0.1:${await freePort()}`, "--no-manager", "--json");
    check("another folder prepares and starts a stack under the same name", again.status === 0 && reused.status === 0, { create: shown(again), up: shown(reused) });
    const last = cli(elsewhere, "down", "--yes", "--json");
    check("down --yes stops it", last.status === 0, shown(last));
  }

  // 6. Delete with only the broker running, and the route back.
  {
    const space = "tear3";
    const root = folder(space);
    const created = cli(home, "space", "create", space, "--root", root, "--json");
    check("space create prepares a third controller root", created.status === 0, shown(created));
    anchor(root);
    const started = cli(root, "up", "--server", `nats://127.0.0.1:${await freePort()}`, "--no-manager", "--json");
    const services = cli(root, "service", "--space", space, "--json");
    const delivery = (services.env?.result?.instances as { definition: string; instanceId: string }[] | undefined)?.find((row) => row.definition === "stack-delivery")?.instanceId;
    check("up starts the broker and delivery", started.status === 0 && typeof delivery === "string", { up: shown(started), services: shown(services) });
    const stoppedDelivery = cli(root, "service", "stop", "stack-delivery", "--instance", String(delivery), "--space", space, "--yes", "--json");
    check("the delivery member stops on its own", stoppedDelivery.status === 0, shown(stoppedDelivery));

    const deleted = cli(home, "space", "delete", space, "--yes");
    check("space delete applies with only the broker running", deleted.status === 0 && /Space streams deleted/.test(deleted.stdout), shown(deleted));
    check("its receipt names the route back: cotal down --yes, or cotal space forget after it",
      /Next/.test(deleted.stdout) && deleted.stdout.includes("cotal down --yes") && deleted.stdout.includes(`Stop the stack in ${root}`) && deleted.stdout.includes(`cotal space forget ${space}`), shown(deleted));
    const bare = cli(root, "up", "--json");
    check("a bare up under the broker that lost the streams refuses TARGET_NOT_FOUND, exit 2", bare.status === 2 && bare.env?.error?.code === "TARGET_NOT_FOUND", shown(bare));
    check("...saying why, and naming the restart",
      Boolean(bare.env?.error?.message.includes("no longer holds this space's streams")) && Boolean(bare.env?.error?.remedy?.includes("cotal down --yes, then cotal up")), bare.env?.error);
    const down = cli(root, "down", "--yes", "--json");
    const back = cli(root, "up", "--json");
    check("down --yes, then up, starts the stack again", down.status === 0 && back.status === 0, { down: shown(down), up: shown(back) });
    const last = cli(root, "down", "--yes", "--json");
    check("down --yes stops it", last.status === 0, shown(last));
  }

  // 7. A registration an older `meshes rm --force` dropped, or `meshes add --force` replaced.
  {
    const space = "tear4";
    const root = folder(space);
    const created = cli(home, "space", "create", space, "--root", root, "--json");
    anchor(root);
    const server = `nats://127.0.0.1:${await freePort()}`;
    const started = cli(root, "up", "--server", server, "--no-manager", "--json");
    const registered = findMesh(space);
    check("space create and up start a fourth controller root", created.status === 0 && started.status === 0 && registered?.origin === "up", { create: shown(created), up: shown(started) });
    // Read from the instance records, as the stop reads them: `service --space` resolves the
    // registration this section removes.
    const live = () => serviceInstances(space).filter((row) => observeServiceProcess(row.record.value) === "running").length;
    const running = live();
    const broker = serviceInstances(space).find((row) => row.record.value.definition === "stack-broker")!.record.value;
    const receipt = join(serviceInstanceStore(space).directory()!, `.broker-launch-${broker.launchRequestId}.json`);
    const original = readFileSync(receipt, "utf8");

    removeMesh(space);
    writeFileSync(receipt, original.replace(server, "nats://127.0.0.1:1"), { mode: 0o600 });
    const mismatched = cli(root, "down", "--yes", "--json");
    check("with no registration and a broker receipt for another address, down refuses CONFLICT, exit 2",
      mismatched.status === 2 && mismatched.env?.error?.code === "CONFLICT" && Boolean(mismatched.env.error.message.includes("is not the launch its journal records")), shown(mismatched));
    check("...stopping nothing and writing no registration", live() === running && running > 0 && findMesh(space) === undefined, { running, now: live() });
    writeFileSync(receipt, original, { mode: 0o600 });

    recordMesh({ ...registered!, origin: "manual", server: "nats://127.0.0.1:2" });
    const elsewhere = cli(root, "down", "--yes", "--json");
    check("a registration added by hand at another address refuses CONFLICT, exit 2, naming cotal space forget",
      elsewhere.status === 2 && elsewhere.env?.error?.code === "CONFLICT" && Boolean(elsewhere.env.error.remedy?.includes(`cotal space forget ${space}`)), shown(elsewhere));
    check("...keeping that registration and every member", findMesh(space)?.server === "nats://127.0.0.1:2" && live() === running, findMesh(space));

    recordMesh({ ...registered!, origin: "manual" });
    const preview = cli(root, "down", "--dry-run", "--json");
    check("one added by hand at the stack's own root and broker previews the rebuilt registration", preview.status === 0 && Boolean(preview.env?.warnings?.some((row) => row.code === "REGISTRATION_REBUILT" && row.message.includes("would use"))), shown(preview));
    const same = cli(root, "down", "--yes", "--json");
    check("...and down --yes stops the whole stack through it", same.status === 0 && Boolean(same.env?.warnings?.some((row) => row.code === "REGISTRATION_REBUILT")) && live() === 0, shown(same));
    check("...leaving no registration and the prepared record", findMesh(space) === undefined && findPreparedSpace(space) !== undefined, findMesh(space));

    const again = cli(root, "up", "--json");
    removeMesh(space);
    const dropped = cli(root, "down", "--yes", "--json");
    check("a stack restarted and then left with no registration stops through its journal",
      again.status === 0 && dropped.status === 0 && Boolean(dropped.env?.warnings?.some((row) => row.code === "REGISTRATION_REBUILT" && row.message.includes("had no registration"))) && live() === 0, { up: shown(again), down: shown(dropped) });
  }
} finally {
  for (const root of roots) if (anchors.has(root)) cli(root, "down", "--yes", "--json");
}
finish();
