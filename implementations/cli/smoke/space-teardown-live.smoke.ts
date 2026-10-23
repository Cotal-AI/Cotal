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
 *     receipt names `cotal up`, and `cotal down --yes` with `cotal space forget`. A bare `up` then
 *     creates the streams again on the running broker, empty, says so and starts delivery, and a
 *     later `up` finds them held.
 *  7. A partial loss. When the running broker lost only the delivery bucket, `up` leaves the rest as
 *     they are and refuses TARGET_NOT_FOUND (exit 2) naming the restart, which creates it.
 *
 * Sandboxes COTAL_HOME and every project root. Run: pnpm smoke:space-teardown:live
 */
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { connect } from "@nats-io/transport-node";
import { jetstreamManager } from "@nats-io/jetstream";
import { deliveryBucket, mintCreds, mintLifecycleUid, newIdentity, standaloneConnectOpts } from "@cotal-ai/core";
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
const { findMesh, findPreparedSpace, getSpaceAuth, workspaceSecretStore } = await import("@cotal-ai/workspace");

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
    check("its receipt names the route back: cotal up there, or cotal down --yes and cotal space forget",
      /Next/.test(deleted.stdout) && deleted.stdout.includes("cotal up") && deleted.stdout.includes(`Run in ${root}: create the space's streams again`) && deleted.stdout.includes("cotal down --yes") && deleted.stdout.includes(`cotal space forget ${space}`), shown(deleted));
    const bare = cli(root, "up", "--json");
    const members = (bare.env?.result?.members as { role: string; state: string }[] | undefined) ?? [];
    check("a bare up creates the streams again on the running broker and starts delivery", bare.status === 0 && bare.env?.result?.streamsRecreated === true && members.some((row) => row.role === "broker" && row.state === "reused") && members.some((row) => row.role === "delivery" && row.state === "started"), shown(bare));
    const sent = cli(root, "send", "-c", "general", "after the delete", "--space", space, "--json");
    check("the space takes a message again", sent.status === 0, shown(sent));
    const again = cli(root, "up", "--json");
    check("a later up finds the streams held and recreates nothing", again.status === 0 && again.env?.result?.streamsRecreated === false, shown(again));
    const last = cli(root, "down", "--yes", "--json");
    check("down --yes stops it", last.status === 0, shown(last));
  }

  // 7. A partial loss keeps the refusal.
  {
    const space = "tear4";
    const root = folder(space);
    const created = cli(home, "space", "create", space, "--root", root, "--json");
    check("space create prepares a fourth controller root", created.status === 0, shown(created));
    anchor(root);
    const server = `nats://127.0.0.1:${await freePort()}`;
    const started = cli(root, "up", "--server", server, "--no-manager", "--json");
    const stopped = cli(root, "service", "stop", "stack-delivery", "--space", space, "--yes", "--json");
    check("up starts the broker and delivery, which then stops on its own", started.status === 0 && stopped.status === 0, { up: shown(started), stop: shown(stopped) });
    // The broker loses only the delivery bucket, which a delivery start reads, with the same
    // teardown grant space delete mints.
    const auth = await getSpaceAuth(workspaceSecretStore(root), space);
    const identity = newIdentity();
    const creds = await mintCreds(auth!, identity, "teardown", { lifecycleUid: mintLifecycleUid(), transferStreams: [] });
    const nc = await connect({ servers: server, ...standaloneConnectOpts({ creds, tls: false }), inboxPrefix: `_INBOX_${identity.id}`, reconnect: false });
    try { await (await jetstreamManager(nc)).streams.delete(`KV_${deliveryBucket(space)}`); } finally { await nc.drain(); }
    const partial = cli(root, "up", "--no-manager", "--json");
    check("up over a broker that lost one bucket refuses TARGET_NOT_FOUND, exit 2, naming the restart", partial.status === 2 && partial.env?.error?.code === "TARGET_NOT_FOUND" && Boolean(partial.env.error.message.includes("missing some of this space's streams")) && Boolean(partial.env.error.remedy?.includes("cotal down --yes, then cotal up")), shown(partial));
    const down = cli(root, "down", "--yes", "--json");
    const back = cli(root, "up", "--no-manager", "--json");
    check("down --yes, then up, starts it again", down.status === 0 && back.status === 0, { down: shown(down), up: shown(back) });
    const last = cli(root, "down", "--yes", "--json");
    check("down --yes stops it", last.status === 0, shown(last));
  }
} finally {
  for (const root of roots) if (anchors.has(root)) cli(root, "down", "--yes", "--json");
}
finish();
