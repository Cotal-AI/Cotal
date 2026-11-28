/**
 * LIVE: a bad broker address never pins a folder, a live stack's streams are not deleted under it,
 * and reset works after a normal `down`.
 *
 *  1. Broker address. `up --server notaurl` refuses USAGE_INVALID (exit 1) in an unprepared and a
 *     prepared folder, and a DNS-named address refuses on the controller route (exit 2). None of
 *     them writes a stack journal or a registration, and the prepared folder then starts on a
 *     valid address.
 *  2. Space delete on a live stack. `space delete --yes` refuses LIFECYCLE_BLOCKED (exit 2) before
 *     any broker connection and names `cotal down` and `cotal reset store`; the dry run warns in
 *     JSON and opens with that refusal as its verdict in text. The stack still stops cleanly.
 *  3. Reset verdicts. On the live stack `reset store --dry-run` exits 0 with a refused verdict and
 *     a remedy naming `cotal down`, and `reset space --dry-run` refuses with that remedy. Its list
 *     names each process once, the delivery daemon as its stack member with its pidfile's pid.
 *  4. Reset after a normal down. `reset store` is offered and removes the store, naming the
 *     workflow runs that go with it in its preview and receipt and saying why the down listed
 *     none, and `up` starts again. `reset space` is offered, its preview opens with the offered verdict and
 *     names the store contents
 *     that go with the identity as `reset store`'s does, and it removes the identity, keeping the
 *     prepared record and the stack journal, and `up` starts again with a new account. After
 *     either reset, `status` exits 0 and neither it nor `up` warns STORE_MISSING. It clears
 *     the credentialRef of a saved service whose credential the removed account issued, names it,
 *     and keeps any other.
 *  5. A forgotten name starts elsewhere. After `down --yes`, `space forget` removes the stack
 *     definitions saved for the root, and another folder starts a stack under the same name.
 *  6. Space delete under a stopped stack. Beside a running service the user added, it refuses naming
 *     that service's `cotal service stop` and then the delete again, since `down` refuses there
 *     too. Under a terminal, a message posted while the typed confirmation waits refuses CONFLICT
 *     naming the changed count. With only the broker running the delete applies, and its receipt
 *     names `cotal up`, and `cotal down --yes` with `cotal space forget`. History, send and
 *     `run ps` then refuse naming the missing streams, and `status` shows them absent with `up
 *     --root` first in its Next. A run waiting at a checkpoint is listed with its state in the
 *     preview and the receipt, and a finished run is not. A bare `up` creates the streams again on
 *     the running broker, empty, says so and starts delivery, and a later `up` finds them held.
 *  7. A partial loss. When the running broker lost only the delivery bucket, `up` leaves the rest as
 *     they are and refuses TARGET_NOT_FOUND (exit 2) naming the restart, which creates it.
 *  8. A stack whose registration an older CLI dropped or replaced. With none, `down --yes` refuses
 *     CONFLICT (exit 2) and stops nothing while the broker's launch receipt names another address,
 *     and stops the stack through its journal once it matches. A registration added by hand at
 *     another address refuses CONFLICT, naming `cotal space forget`, and stays. One added by hand
 *     at the stack's own root and broker is stopped through, and neither leaves a registration.
 *  9. A store directory that also holds the user's files. After `up --store-dir` and `down`,
 *     `reset store`, `reset space` and their dry runs refuse CONFLICT naming those files, and the
 *     folder keeps them. Once that store path is a link, they refuse naming it and its target.
 * 10. A deleted folder. With a whole stack running, its folder is deleted. `status` marks the folder
 *     gone, `send` and `history` refuse DEPENDENCY_UNAVAILABLE and name `down --space --yes`, which
 *     from another folder stops every member by signal and removes the stack definitions, no member
 *     process is left, and another folder starts the same name.
 * 11. An open space deleted under its running stack. Another Cotal home adds the space and deletes
 *     it. `status` says the space was deleted under the running stack and leads its Next with
 *     `cotal down --yes`, then `cotal up`; history, send and `run ps` refuse with that cause and
 *     remedy. `down --yes` and `up` give the space its streams back.
 *     After `down`, `doctor auth` still identifies the recorded open stack, including with `--fix`
 *     or `--space`. An overriding auth broker names the address mismatch, not a new `up` here.
 *     A stopped auth space whose folder is deleted names moving it back or forgetting the space.
 * 12. Reset targets with nothing to reset. `reset store` and `reset space` of a name no space has
 *     refuse TARGET_NOT_FOUND saying so, naming `cotal space` first. Of a prepared space no stack
 *     has run for, they refuse TARGET_NOT_FOUND naming its root, `cotal up` and `cotal space forget`.
 * 13. A store write the broker could not make. With the store made read-only, a send that needs a
 *     new block file fails and nats-server stops JetStream. That send exits 3 naming the logged
 *     permission failure, and later sends refuse DEPENDENCY_UNAVAILABLE naming it, with no claim that
 *     the space was deleted and no step that creates its streams again empty. Each Next makes the
 *     store writable again, and `status` leads with the same step. With the store writable, `down
 *     --yes` and `up` bring back every message stored before the failure.
 * 14. A moved folder. With a stack running, its folder is renamed. `down --space --yes` from another
 *     folder stops it, and its Next names `cotal space create <space> --adopt --root <folder>` before
 *     `cotal space create <space>`. Adopting the renamed folder keeps its history, and the receipt's
 *     restart command starts it without a manager at its saved payload limit.
 * 15. A forgotten stack that ran a manager, started again in its own folder without one. While the
 *     manager runs, `up --no-manager` refuses LIFECYCLE_BLOCKED. After `down --yes`, `space forget`
 *     removes the three stack definitions, and the journal names none of their instances. `space
 *     create` there and `up --no-manager` start a new broker and delivery with no manager instance,
 *     and `down --yes` stops them. Each down leaves no member process.
 *  16. Forgetting a running open stack refuses and names a stop that works without a terminal.
 *      Once forgotten, it starts in its original mode at the recorded address and store,
 *      without delivery, and can read its retained history.
 *
 * Sandboxes COTAL_HOME and every project root. Run: pnpm smoke:space-teardown:live
 */
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, readlinkSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { connect } from "@nats-io/transport-node";
import { jetstream, jetstreamManager } from "@nats-io/jetstream";
import { canonicalBackupStreamConfig, deliveryBucket, isStreamNotFound, mintCreds, mintLifecycleUid, newIdentity, pluginChannelStream, pluginFanoutDurableConfig, PLUGIN_CHANNEL_ROOT, PLUGIN_FANOUT_DURABLE, standaloneConnectOpts } from "@cotal-ai/core";
import { assertSmokeSandboxDown, createSuite, freePort, recordSmokeSandbox, type SmokeSandboxAnchor } from "@cotal-ai/smoke-kit";
import { openSigned } from "../../../packages/core/smoke/_snapshot-ack.js";
import { pluginChannelSubject } from "../../../packages/core/src/plugin-channel-route.js";
import { clean, cotalPty, wait } from "./_console-pty.js";

const WT = resolve(import.meta.dirname, "..", "..", "..");
const CLI = join(WT, "bin", "dist", "cotal.js");
const home = mkdtempSync(join(tmpdir(), "cotal-space-teardown-"));
const configDir = join(home, "xdg");
// The CLI children must not inherit a managed session's mesh identity from whatever runs this
// suite; they get only the private home and the values set below.
for (const key of Object.keys(process.env)) if (key.startsWith("COTAL_")) delete process.env[key];
// Set before the stores are imported; they read COTAL_HOME on each call.
process.env.COTAL_HOME = home;
const env = { ...process.env, COTAL_HOME: home, XDG_CONFIG_HOME: configDir, COTAL_SKIP_CONNECTOR_SEED: "1" };
const { deliveryCredsKey, findMesh, findPreparedSpace, getSpaceAuth, recordMesh, removeMesh, workspaceSecretStore } = await import("@cotal-ai/workspace");
const { observeServiceProcess, serviceInstances, serviceInstanceStore } = await import("../src/lib/service-instances.js");
const { shellWord } = await import("../src/lib/endpoint-errors.js");
const { readStackJournal } = await import("../src/lib/stack-journal.js");

const { check, finish } = createSuite();
const anchors = new Map<string, SmokeSandboxAnchor>();
const roots: string[] = [];

type Envelope = {
  outcome: string;
  error?: { code: string; message: string; remedy?: string };
  target?: { space?: string; root?: string; processes?: string[] } | null;
  warnings?: { code: string; message: string }[];
  result?: Record<string, unknown> & { applyVerdict?: { offered: boolean; code?: string; remedy?: string | null } };
};
type Run = { status: number | null; stdout: string; stderr: string; env?: Envelope };
const cliWithEnv = (cwd: string, args: string[], childEnv: NodeJS.ProcessEnv): Run => {
  // Room for a history that holds messages near the broker's payload limit.
  const options = { cwd, env: childEnv, encoding: "utf8" as const, timeout: 180_000, maxBuffer: 64 * 1024 * 1024 };
  assertSmokeSandboxDown(anchors.get(cwd), args, options);
  const run = spawnSync(process.execPath, [CLI, ...args], options);
  let parsed: Envelope | undefined;
  try { parsed = JSON.parse(run.stdout) as Envelope; } catch { parsed = undefined; }
  return { status: run.status, stdout: run.stdout, stderr: run.stderr, env: parsed };
};
const cli = (cwd: string, ...args: string[]) => cliWithEnv(cwd, args, env);
const shown = (run: Run) => ({ status: run.status, error: run.env?.error, out: run.stdout.slice(-1000), err: run.stderr.slice(-1500) });

async function deleteWithPluginHistory(root: string, space: string): Promise<Run> {
  const server = findMesh(space)!.server;
  const auth = (await getSpaceAuth(workspaceSecretStore(root), space))!;
  const decoy = `${space}_decoy`;
  const spaces = [space, decoy];
  const names = spaces.map(pluginChannelStream);
  const actor = newIdentity().id;
  const subjects = spaces.map((name) => pluginChannelSubject(name, actor, actor, `${PLUGIN_CHANNEL_ROOT}.fixture.post`));
  const nc = await openSigned(server, auth, "space_delete_fixture", {
    pub: { allow: ["$JS.API.INFO", ...subjects, ...names.flatMap((name) => [
      `$JS.API.STREAM.CREATE.${name}`, `$JS.API.STREAM.INFO.${name}`, `$JS.API.STREAM.MSG.GET.${name}`,
      `$JS.API.CONSUMER.CREATE.${name}.>`, `$JS.API.CONSUMER.INFO.${name}.${PLUGIN_FANOUT_DURABLE}`,
    ]), `$JS.API.STREAM.DELETE.${names[1]}`] },
    sub: { allow: ["_INBOX_space_delete_fixture.>"] },
  });
  try {
    const manager = await jetstreamManager(nc);
    for (const [index, name] of spaces.entries()) {
      await manager.streams.add(canonicalBackupStreamConfig(name, names[index]));
      await manager.consumers.add(names[index], pluginFanoutDurableConfig(name));
      await jetstream(nc).publish(subjects[index], new Uint8Array([42 + index]));
    }
    const preview = cli(home, "space", "delete", space, "--dry-run", "--json");
    const streams = preview.env?.result?.streams as { name: string; messages: number }[] | undefined;
    check("authenticated plugin teardown preview names the exact history and omits the decoy", preview.status === 0 && streams !== undefined && streams.some((entry) => entry.name === names[0] && entry.messages === 1) && !streams.some((entry) => entry.name === names[1]), shown(preview));
    const deleted = cli(home, "space", "delete", space, "--yes");
    const gone = await manager.streams.info(names[0]).then(() => false, isStreamNotFound);
    const durableGone = await manager.consumers.info(names[0], PLUGIN_FANOUT_DURABLE).then(() => false, isStreamNotFound);
    check("authenticated plugin teardown removes the exact stream and its fan-out", deleted.status === 0 && gone && durableGone, shown(deleted));
    const kept = await manager.streams.getMessage(names[1], { last_by_subj: subjects[1] });
    const durable = await manager.consumers.info(names[1], PLUGIN_FANOUT_DURABLE);
    check("authenticated plugin teardown leaves the decoy post and fan-out intact", kept?.data[0] === 43 && durable.num_pending === 1);
    const repeated = cli(home, "space", "delete", space, "--yes");
    check("repeated authenticated plugin teardown succeeds after records deletion", repeated.status === 0, shown(repeated));
    return deleted;
  } finally {
    try { await (await jetstreamManager(nc)).streams.delete(names[1]).catch((error: unknown) => { if (!isStreamNotFound(error)) throw error; }); }
    finally { await nc.close(); }
  }
}

function checkStoppedDeliveryLog(root: string, space: string, instanceId: string | null | undefined): void {
  const credential = join(root, ".cotal", deliveryCredsKey(space, { injected: false, root }));
  check("the stop removed the delivery launch credential", !existsSync(credential), credential);
  const args = ["service", "logs", "stack-delivery", "--space", space, "--tail", "30", "--json"];
  const logs = cli(root, ...args);
  const result = logs.env?.result as { instance?: { instanceId?: string; observedProcess?: string; recordedState?: string }; lines?: string[]; path?: string } | undefined;
  check("the stopped delivery instance's captured log is readable without its launch credential",
    logs.status === 0 && typeof instanceId === "string" && result?.instance?.instanceId === instanceId && result.instance.observedProcess === "gone"
    && result.instance.recordedState === "stopped" && (result.lines?.length ?? 0) > 0, shown(logs));
  if (!result?.path) return;
  const path = result.path, moved = `${path}.moved`;
  renameSync(path, moved);
  try {
    const missing = cli(root, ...args);
    check("the missing captured file is refused by its log path, not by a launch input",
      missing.status === 2 && missing.env?.error?.code === "TARGET_NOT_FOUND" && missing.env.error.message.includes(path), shown(missing));
  } finally { renameSync(moved, path); }
}

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

process.on("exit", (code) => {
  // A failed scenario can still own live processes or unsettled records. Keep its roots intact.
  if (code === 0) for (const path of [home, ...roots]) rmSync(path, { recursive: true, force: true });
});

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
    check("a DNS-named address refuses USAGE_INVALID before the controller route, exit 1", named.status === 1 && named.env?.error?.code === "USAGE_INVALID", shown(named));
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
    // The decision leads every destructive preview, as it does in reset store's.
    const previewText = cli(home, "space", "delete", space, "--dry-run");
    const refusedAt = previewText.stdout.search(/^Verdict$/m);
    check("the text preview opens with the refused verdict, before the impact, and does not repeat it as a warning",
      previewText.status === 0 && refusedAt >= 0 && refusedAt < previewText.stdout.search(/^Live space impact$/m) && previewText.stdout.includes(`space delete ${space} would refuse (LIFECYCLE_BLOCKED)`) && !previewText.stderr.includes("the apply would refuse"),
      { status: previewText.status, out: previewText.stdout.slice(0, 600), err: previewText.stderr });
    const deleted = cli(home, "space", "delete", space, "--yes", "--json");
    check("space delete --yes refuses LIFECYCLE_BLOCKED, exit 2", deleted.status === 2 && deleted.env?.error?.code === "LIFECYCLE_BLOCKED", shown(deleted));
    check("its remedy names cotal down and cotal reset store", Boolean(deleted.env?.error?.remedy?.includes("cotal down")) && Boolean(deleted.env?.error?.remedy?.includes(`cotal reset store ${space}`)), deleted.env?.error);

    // 3. Reset previews and refusals carry a verdict, one reason and a Next (B4-04).
    const stopReview = `from ${root}, review the stop with \`cotal down --dry-run\`, confirm it with \`cotal down --yes\``;
    const storeLive = cli(root, "reset", "store", space, "--dry-run", "--json");
    check("reset store --dry-run on a live stack exits 0 with a refused verdict", storeLive.status === 0 && storeLive.env?.result?.applyVerdict?.offered === false && storeLive.env.result.applyVerdict.code === "LIFECYCLE_BLOCKED", shown(storeLive));
    check("that verdict names how to review and confirm the stop, then retry the store preview", storeLive.env?.result?.applyVerdict?.remedy === `${stopReview}, then run \`cotal reset store ${space} --dry-run\``, storeLive.env?.result?.applyVerdict);
    const storeLiveText = cli(root, "reset", "store", space, "--dry-run", "--plain");
    check("a live store preview without a recorded run list suggests the live inventory, not a start",
      storeLiveText.status === 0 && storeLiveText.stdout.includes("would refuse (LIFECYCLE_BLOCKED)") && storeLiveText.stdout.includes("No run list was recorded") &&
      storeLiveText.stdout.includes(`If a manager is available, list live runs with \`cotal run --space ${space}\``) && !storeLiveText.stdout.includes("`cotal up`"), shown(storeLiveText));
    const spaceLive = cli(root, "reset", "space", space, "--dry-run", "--json");
    check("reset space --dry-run refuses and names how to review and confirm the stop, then retry the space preview", spaceLive.status === 2 && spaceLive.env?.error?.code === "LIFECYCLE_BLOCKED" && spaceLive.env.error.remedy === `${stopReview}, then run \`cotal reset space ${space} --dry-run\``, shown(spaceLive));
    // The delivery daemon's own pidfile names the process its stack member runs, so it is listed once.
    const processes = spaceLive.env?.target?.processes ?? [];
    const pids = processes.flatMap((row) => /\bpid (\d+)/.exec(row)?.[1] ?? []);
    check("the refusal lists each process once: delivery as its stack member with the pidfile's pid, and no pid twice",
      processes.length === 2 && !processes.some((row) => row.startsWith("delivery daemon")) && /^stack-delivery, pid \d+, instance [0-9a-f-]+$/.test(processes.find((row) => row.startsWith("stack-delivery")) ?? "")
        && processes.some((row) => /^stack-broker, instance [0-9a-f-]+$/.test(row)) && new Set(pids).size === pids.length && spaceLive.env?.error?.message.split("delivery").length === 2, processes);

    const stopPreview = cli(root, "down", "--dry-run", "--json");
    check("down --dry-run reviews the stop and leaves the stack running", stopPreview.status === 0 && findMesh(space) !== undefined, shown(stopPreview));
    const stopped = cli(root, "down", "--yes", "--json");
    check("the refused delete left a stack that down --yes stops", stopped.status === 0, shown(stopped));
    check("down removed the registration and kept the prepared record", findMesh(space) === undefined && findPreparedSpace(space) !== undefined);
    // Starting it again to delete would meet the running-stack refusal, so the stopped refusal names reset store.
    const deleteStopped = cli(home, "space", "delete", space, "--yes", "--json");
    check("space delete after down refuses TARGET_UNAVAILABLE and names cotal reset store, not cotal up",
      deleteStopped.status === 2 && deleteStopped.env?.error?.code === "TARGET_UNAVAILABLE" && Boolean(deleteStopped.env.error.remedy?.includes(`cotal reset store ${space} --yes`)) && !deleteStopped.env.error.remedy?.includes("cotal up"), shown(deleteStopped));
    const deletePreview = cli(home, "space", "delete", space, "--dry-run", "--json");
    check("the stopped stack's deletion preview names reset impact and says a stream inventory needs a running broker",
      deletePreview.status === 2 && deletePreview.env?.error?.code === "TARGET_UNAVAILABLE" &&
        deletePreview.env.error.remedy === `preview the impact of resetting its store with \`cotal reset store ${space} --dry-run\`. A stream inventory requires a running broker.`, shown(deletePreview));

    // 4. Reset after a normal down (B4-02).
    const forcedColor: NodeJS.ProcessEnv = { ...env, FORCE_COLOR: "1" };
    delete forcedColor.NO_COLOR;
    const storeConfirmation = cliWithEnv(root, ["reset", "store", space, "--plain"], forcedColor);
    const [previewWords, confirmWords] = Array.from(storeConfirmation.stderr.matchAll(/`(?:pnpm )?cotal (reset store [^`]+)`/g), ([, words]) => words);
    check("the noninteractive plain store reset refusal keeps --plain on both commands",
      storeConfirmation.status === 1 && storeConfirmation.stdout === "" && storeConfirmation.stderr.includes("USAGE_INVALID")
      && previewWords === `reset store ${space} --dry-run --plain` && confirmWords === `reset store ${space} --yes --plain`, shown(storeConfirmation));
    const suggestedPreview = previewWords === `reset store ${space} --dry-run` || previewWords === `reset store ${space} --dry-run --plain`
      ? cliWithEnv(root, previewWords.split(" "), forcedColor) : undefined;
    check("the printed store preview succeeds without ANSI even with FORCE_COLOR",
      suggestedPreview?.status === 0 && suggestedPreview.stdout.includes(`reset store ${space} is offered`)
      && !`${suggestedPreview.stdout}${suggestedPreview.stderr}`.includes("\x1b"), suggestedPreview && shown(suggestedPreview));
    const storeStopped = cli(root, "reset", "store", space, "--dry-run", "--json");
    // This stack runs with --no-manager, so its down recorded why it could not read the runs.
    const contents = storeStopped.env?.result?.storeContents as { removed?: string[]; listed?: boolean; runsAtLastDown?: { read?: boolean; reason?: string } | null } | undefined;
    check("reset store --dry-run after down offers the apply, names the workflow runs it removes and says why the down listed none", storeStopped.status === 0 && storeStopped.env?.result?.applyVerdict?.offered === true && contents?.removed?.includes("workflow runs and their journals") === true && contents.listed === false && contents.runsAtLastDown?.read === false && contents.runsAtLastDown.reason === "the stack's manager was not running", shown(storeStopped));
    const storeStoppedText = cli(root, "reset", "store", space, "--dry-run", "--plain");
    check("a stopped store preview still says how to start and inspect an unread run list",
      storeStoppedText.status === 0 && storeStoppedText.stdout.includes("could not read the runs") && storeStoppedText.stdout.includes("run `cotal up` and `cotal run`"), shown(storeStoppedText));
    const storeApplied = cli(root, "reset", "store", space, "--yes", "--json");
    check("reset store --yes removes the stopped store and names the workflow runs that went with it", storeApplied.status === 0 && storeApplied.env?.result?.selectedBy === "stopped-stack" && Array.isArray(storeApplied.env.result.removedPaths) && (storeApplied.env.result.removedPaths as unknown[]).length > 0 && (storeApplied.env.result.removedContents as string[] | undefined)?.includes("workflow runs and their journals") === true, shown(storeApplied));
    // The reset leaves the store as a fresh up prepares it, so nothing reports it lost.
    const missing = (run: Run) => Boolean(run.env?.warnings?.some((warning) => warning.code === "STORE_MISSING"));
    const statusAfterStore = cli(root, "status", "--json");
    check("status after reset store exits 0 without a missing-store warning", statusAfterStore.status === 0 && !missing(statusAfterStore), shown(statusAfterStore));
    const restarted = cli(root, "up", "--json");
    check("bare up starts the stack again on an empty store, without a missing-store warning", restarted.status === 0 && !missing(restarted), shown(restarted));
    // A saved service naming a credential this account issued would hand its child a credential the
    // next identity rejects; one naming any other file is not attributed to it.
    const keys = folder("keys");
    const minted = join(keys, "svc.creds"), foreign = join(keys, "foreign.creds");
    const mint = cli(root, "auth", "mint", "svc", "--out", minted, "--space", space, "--json");
    check("auth mint writes a credential this space's account issued", mint.status === 0 && existsSync(minted), shown(mint));
    writeFileSync(foreign, "not a credential\n", { mode: 0o600 });
    const saveService = (name: string, creds: string) => {
      const file = join(keys, `${name}.json`);
      writeFileSync(file, JSON.stringify({ schemaVersion: 1, space, launch: { type: "process", executable: "/bin/sh", args: ["-c", ""], cwd: root }, readiness: { type: "process", timeoutMs: 5000 }, credentialRef: { kind: "file", path: creds } }));
      return cli(root, "service", "add", name, "--file", file, "--space", space, "--json");
    };
    const saved = [saveService("minted", minted), saveService("foreign", foreign)];
    check("service add saves a definition naming each file", saved.every((run) => run.status === 0), saved.map(shown));
    const before = accountDigest(root);
    const stoppedAgain = cli(root, "down", "--yes", "--json");
    check("down --yes stops it again", stoppedAgain.status === 0, shown(stoppedAgain));

    const spaceConfirmation = cli(root, "reset", "space", space, "--json");
    check("reset space confirmation keeps JSON in both the preview and apply commands",
      spaceConfirmation.status === 1 && spaceConfirmation.env?.error?.code === "USAGE_INVALID"
        && spaceConfirmation.env.error.remedy === `review \`cotal reset space ${space} --dry-run --json\` first, then run \`cotal reset space ${space} --yes --json\``, shown(spaceConfirmation));
    const spacePreview = cli(root, "reset", "space", space, "--dry-run", "--json");
    check("reset space --dry-run after down offers the apply", spacePreview.status === 0 && spacePreview.env?.result?.applyVerdict?.offered === true, shown(spacePreview));
    // The store goes with the identity, so the preview names what it holds, as reset store's does.
    const spaceContents = spacePreview.env?.result?.storeContents as { removed?: string[] } | undefined;
    const spacePreviewText = cli(root, "reset", "space", space, "--dry-run");
    check("the reset space preview names the store's workflow runs and channel history in JSON and in its Store contents section",
      Boolean(spaceContents?.removed?.includes("workflow runs and their journals") && spaceContents.removed.includes("channel history")) && spacePreviewText.status === 0 && /^Store contents$/m.test(spacePreviewText.stdout) && spacePreviewText.stdout.includes("Removing the store removes workflow runs and their journals, channel history"),
      { json: spaceContents, text: shown(spacePreviewText) });
    const offeredAt = spacePreviewText.stdout.search(/^Verdict$/m);
    check("the reset space preview opens with the offered verdict and its --yes command, as reset store's does",
      offeredAt >= 0 && offeredAt < spacePreviewText.stdout.search(/^Reset space impact$/m) && spacePreviewText.stdout.includes(`reset space ${space} is offered`) && spacePreviewText.stdout.includes(`cotal reset space ${space} --yes`) && !/^Next$/m.test(spacePreviewText.stdout),
      spacePreviewText.stdout.slice(0, 600));
    const issuedRefs = JSON.stringify([{ definition: "minted", path: minted }]);
    check("the preview names the one credentialRef this identity issued", JSON.stringify(spacePreview.env?.result?.clearsCredentialRefs) === issuedRefs, spacePreview.env?.result?.clearsCredentialRefs);
    const spaceApplied = cli(root, "reset", "space", space, "--yes", "--json");
    check("reset space --yes removes the identity and keeps the stack's records", spaceApplied.status === 0 && spaceApplied.env?.result?.localIdentityRemoved === true && spaceApplied.env.result.registrationRemoved === false, shown(spaceApplied));
    const shownMinted = cli(root, "service", "show", "minted", "--space", space, "--json"), shownForeign = cli(root, "service", "show", "foreign", "--space", space, "--json");
    check("it clears that credentialRef and says so, and keeps the other",
      JSON.stringify(spaceApplied.env?.result?.clearedCredentialRefs) === issuedRefs && shownMinted.status === 0 && !shownMinted.stdout.includes('"credentialRef"') && shownForeign.stdout.includes(JSON.stringify(foreign)),
      { cleared: spaceApplied.env?.result?.clearedCredentialRefs, minted: shown(shownMinted), foreign: shown(shownForeign) });
    check("the prepared record and the stack journal stay", findPreparedSpace(space) !== undefined && existsSync(journalOf(root)));
    const statusAfterSpace = cli(root, "status", "--json");
    check("status after reset space exits 0 without a missing-store warning", statusAfterSpace.status === 0 && !missing(statusAfterSpace), shown(statusAfterSpace));
    const fresh = cli(root, "up", "--json");
    check("bare up starts it again, without a missing-store warning", fresh.status === 0 && !missing(fresh), shown(fresh));
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
    const started = cli(root, "up", "--server", `nats://127.0.0.1:${await freePort()}`, "--json");
    const services = cli(root, "service", "--space", space, "--json");
    const instance = (definition: string) => (services.env?.result?.instances as { definition: string; instanceId: string }[] | undefined)?.find((row) => row.definition === definition)?.instanceId;
    const delivery = instance("stack-delivery"), manager = instance("stack-manager");
    check("up starts the broker, delivery and the manager", started.status === 0 && typeof delivery === "string" && typeof manager === "string", { up: shown(started), services: shown(services) });
    // One run waits at a checkpoint and one finishes; the delete names only the first.
    writeFileSync(join(root, "wait.js"), 'const d = await checkpoint("approve", "Ship it?");\nlog("resolved", d.status);\n');
    writeFileSync(join(root, "done.js"), 'log("done");\n');
    const waiting = cli(root, "run", "start", "wait.js", "--space", space, "--json"), finishing = cli(root, "run", "start", "done.js", "--space", space, "--json");
    const runId = (waiting.env?.result?.result as { runId?: string } | undefined)?.runId;
    check("a run that waits and a run that finishes start", waiting.status === 0 && typeof runId === "string" && finishing.status === 0, { waiting: shown(waiting), finishing: shown(finishing) });
    let runs: { unfinished?: { runId: string; state: string }[]; finished?: number } | undefined;
    for (let i = 0; i < 40; i++) {
      runs = cli(home, "space", "delete", space, "--dry-run", "--json").env?.result?.runs as typeof runs;
      if (runs?.finished === 1) break;
      await new Promise((settle) => setTimeout(settle, 250));
    }
    check("the finished run is counted and only the waiting run is listed, with its state", runs?.finished === 1 && runs.unfinished?.length === 1 && runs.unfinished[0]?.runId === runId && runs.unfinished[0].state === "running", runs);
    const journal = cli(root, "run", "show", runId ?? "-", "--limit", "1", "--space", space);
    check("run show --limit reads one journal row", journal.status === 0 && journal.stdout.includes("Journal · last 1 of"), shown(journal));
    const pagedJournal = cli(root, "run", "show", runId ?? "-", "--page", "--limit", "1", "--space", space);
    check("run show refuses inventory paging even when the journal limit is valid", pagedJournal.status === 1 && pagedJournal.stdout === "" && pagedJournal.stderr.includes("remove --page to read the journal") && pagedJournal.stderr.includes("cotal run --page --on <instance>"), shown(pagedJournal));
    for (const [definition, id] of [["stack-manager", manager], ["stack-delivery", delivery]] as const) {
      const stoppedMember = cli(root, "service", "stop", definition, "--instance", String(id), "--space", space, "--yes", "--json");
      check(`the ${definition} member stops on its own`, stoppedMember.status === 0, shown(stoppedMember));
    }
    const runPreview = cli(home, "space", "delete", space, "--dry-run");
    check("the delete preview lists the waiting run and says it goes with the streams",
      runPreview.status === 0 && /Workflow runs that have not finished/.test(runPreview.stdout) && runPreview.stdout.includes(runId ?? "-") && runPreview.stdout.includes("cotal run show <run>"), shown(runPreview));
    const deleteOfferedAt = runPreview.stdout.search(/^Verdict$/m);
    check("with only the broker running, the delete preview opens with the offered verdict and its --yes command",
      deleteOfferedAt >= 0 && deleteOfferedAt < runPreview.stdout.search(/^Live space impact$/m) && runPreview.stdout.includes(`space delete ${space} is offered`) && runPreview.stdout.includes(`cotal space delete ${space} --yes`),
      runPreview.stdout.slice(0, 600));
    // A service the user added still uses the streams, and `down` refuses beside it, so the refusal
    // names that service's own stop and then the delete again.
    writeFileSync(join(root, "idle.json"), JSON.stringify({ schemaVersion: 1, space, launch: { type: "process", executable: process.execPath, args: ["-e", "setTimeout(() => {}, 600000)"], cwd: root }, readiness: { type: "process", timeoutMs: 10000 } }));
    const added = cli(root, "service", "add", "idle", "--file", "idle.json", "--space", space, "--json");
    const idleStart = cli(root, "service", "start", "idle", "--space", space, "--json");
    const idle = idleStart.env?.result?.instanceId;
    check("rig: a service the user added runs beside the broker", added.status === 0 && idleStart.status === 0 && typeof idle === "string", { added: shown(added), started: shown(idleStart) });
    const besideService = cli(home, "space", "delete", space, "--yes", "--json");
    check("space delete beside it refuses LIFECYCLE_BLOCKED, naming its service stop and then the delete again",
      besideService.status === 2 && besideService.env?.error?.code === "LIFECYCLE_BLOCKED" && /^services of this space still run here \(idle\)/.test(besideService.env.error.message) &&
        besideService.env.error.remedy === `stop each service with \`cotal service stop idle --instance ${String(idle)} --space ${space} --yes\`, then run \`cotal space delete ${space}\` again`, shown(besideService));
    const idleStop = cli(root, "service", "stop", "idle", "--instance", String(idle), "--space", space, "--yes", "--json");
    check("the named service stop stops it", idleStop.status === 0, shown(idleStop));
    // The typed confirmation was given for the message counts it showed, so a message stored while it
    // waits refuses the delete.
    const first = cli(root, "send", "-c", "general", "before the review", "--json");
    const ptyEnv = Object.fromEntries(Object.entries(env).filter((pair): pair is [string, string] => pair[1] !== undefined));
    const typed = cotalPty(["space", "delete", space], { cwd: home, env: ptyEnv, cols: 160, rows: 60 });
    let typedOut = "", typedExit: number | undefined;
    typed.onData((data) => (typedOut += data));
    typed.onExit((e) => (typedExit = e.exitCode));
    const until = async (done: () => boolean) => { for (const t0 = Date.now(); Date.now() - t0 < 90_000 && !done(); await wait(100)); return done(); };
    const asked = await until(() => clean(typedOut).includes("Type the exact space name"));
    const during = cli(root, "send", "-c", "general", "while the confirmation waits", "--json");
    typed.write(`${space}\r`);
    const ended = await until(() => typedExit !== undefined);
    if (!ended) typed.kill();
    check("a message stored while the typed confirmation waits refuses CONFLICT, exit 2, naming the changed count",
      first.status === 0 && asked && during.status === 0 && typedExit === 2 && clean(typedOut).includes(`CHAT_${space} holds 2 messages, 1 message when reviewed`) && /CONFLICT/.test(typedOut),
      { first: shown(first), during: shown(during), exit: typedExit, out: clean(typedOut).slice(-1500) });

    const deleted = await deleteWithPluginHistory(root, space);
    check("space delete applies with only the broker running", deleted.status === 0 && /Space streams deleted/.test(deleted.stdout), shown(deleted));
    check("its receipt lists the waiting run it removed", /Workflow runs removed/.test(deleted.stdout) && deleted.stdout.includes(runId ?? "-"), shown(deleted));
    check("its receipt names the route back: cotal up there, or cotal down --yes and cotal space forget",
      /Next/.test(deleted.stdout) && deleted.stdout.includes("cotal up") && deleted.stdout.includes(`Run in ${root}: create the space's streams again`) && deleted.stdout.includes("cotal down --yes") && deleted.stdout.includes(`cotal space forget ${space}`), shown(deleted));
    // Before that up, history used to read "0 messages" and send exited 3 with "no responders".
    const [readGone, sendGone] = [cli(root, "history", "general", "--space", space, "--json"), cli(root, "send", "-c", "general", "before the up", "--space", space, "--json")];
    check("before the up, history and send refuse TARGET_UNAVAILABLE: the streams are not on the broker, and cotal up there creates them",
      [readGone, sendGone].every((r) => r.status === 2 && r.env?.error?.code === "TARGET_UNAVAILABLE" && r.env.error.message?.startsWith(`the streams of ${space} are not on its broker; a space delete removes them`) === true
        && r.env.error.remedy === `run \`cotal up\` in ${root} to create them again, empty`), { history: shown(readGone), send: shown(sendGone) });
    const statusGone = cli(root, "status", "--json");
    const streamsGone = (statusGone.env?.result?.selected as { spaceStreams?: { state: string; stack: string | null } } | undefined)?.spaceStreams;
    check("status says the streams are not on the broker while the stack's other members are stopped", statusGone.status === 0 && streamsGone?.state === "absent" && streamsGone.stack === "stopped", shown(statusGone));
    const statusShown = cli(root, "status");
    const statusNext = statusShown.stdout.slice(statusShown.stdout.indexOf("\nNext\n") + 6).split("\n")[0] ?? "";
    check("its Space streams row says a space delete removed them, and its first Next is the up that creates them again",
      statusShown.stdout.includes("Space streams:") && statusShown.stdout.includes("not on the broker · a space delete removed them") && statusNext.includes(`up --root ${root}`) && statusNext.includes("Create the space's streams again, empty"), shown(statusShown));
    const runsGone = cli(root, "run", "ps", "--space", space);
    check("run ps refuses TARGET_UNAVAILABLE naming the same cause", runsGone.status === 2 && runsGone.stderr.includes(`the streams of ${space} are not on its broker; a space delete removes them`), shown(runsGone));
    const bare = cli(root, "up", "--json");
    const members = (bare.env?.result?.members as { role: string; state: string }[] | undefined) ?? [];
    check("a bare up creates the streams again on the running broker and starts delivery", bare.status === 0 && bare.env?.result?.streamsRecreated === true && members.some((row) => row.role === "broker" && row.state === "reused") && members.some((row) => row.role === "delivery" && row.state === "started"), shown(bare))
    const gone = cli(root, "run", "show", runId ?? "-", "--space", space, "--json");
    check("the removed run is gone after the streams return", gone.status === 2 && gone.env?.error?.code === "TARGET_NOT_FOUND", shown(gone));;
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
    check("up over a broker that lost one bucket refuses TARGET_NOT_FOUND, exit 2, naming the restart", partial.status === 2 && partial.env?.error?.code === "TARGET_NOT_FOUND" && Boolean(partial.env.error.message.includes("missing some of this space's streams")) && Boolean(partial.env.error.remedy?.includes("`cotal down --yes`, then `cotal up`")), shown(partial));
    const down = cli(root, "down", "--yes", "--json");
    const back = cli(root, "up", "--no-manager", "--json");
    check("down --yes, then up, starts it again", down.status === 0 && back.status === 0, { down: shown(down), up: shown(back) });
    const last = cli(root, "down", "--yes", "--json");
    check("down --yes stops it", last.status === 0, shown(last));
  }

  // 8. A registration an older `meshes rm --force` dropped, or `meshes add --force` replaced.
  {
    const space = "tear6";
    const root = folder(`${space} project`);
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
    check("with no registration and a broker receipt for another address, down refuses and points to the journal that names the broker",
      mismatched.status === 2 && mismatched.env?.error?.code === "CONFLICT" && Boolean(mismatched.env.error.message.includes("is not the launch its journal records")) &&
      mismatched.env.error.remedy?.includes(journalOf(root)) === true && readStackJournal(root)?.journal.members.some((row) => row.role === "broker" && row.instanceId === broker.instanceId) === true, shown(mismatched));
    check("...stopping nothing and writing no registration", live() === running && running > 0 && findMesh(space) === undefined, { running, now: live() });
    const noStop = cli(home, "space", "forget", space, "--json");
    check("forget tells the user to restore the registration when the broker receipt does not match",
      noStop.status === 2 && noStop.env?.error?.code === "LIFECYCLE_BLOCKED" && noStop.env.error.remedy?.startsWith("restore the stack's registration") === true && live() === running, shown(noStop));
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
    const journal = readFileSync(journalOf(root), "utf8");
    const runningAgain = live();
    const forgot = cli(home, "space", "forget", space, "--json");
    check("forget of a running stack with no registration keeps its journal and names a quoted stop in its root",
      forgot.status === 2 && forgot.env?.error?.code === "LIFECYCLE_BLOCKED" &&
      forgot.env.error.remedy?.includes(`\`cd ${shellWord(root)} && `) === true && forgot.env.error.remedy.includes(" down --yes`") &&
      !forgot.env.error.remedy.includes("down --space") && findMesh(space) === undefined && runningAgain > 0 && live() === runningAgain && readFileSync(journalOf(root), "utf8") === journal, shown(forgot));
    const dropped = cli(root, "down", "--yes", "--json");
    check("a stack restarted and then left with no registration stops through its journal",
      again.status === 0 && dropped.status === 0 && Boolean(dropped.env?.warnings?.some((row) => row.code === "REGISTRATION_REBUILT" && row.message.includes("had no registration"))) && live() === 0, { up: shown(again), down: shown(dropped) });
    const after = cli(home, "space", "forget", space, "--json");
    check("forget succeeds after the stop it named", after.status === 0 && findPreparedSpace(space) === undefined, shown(after));
  }

  // 9. A controller stack whose --store-dir also holds the user's files: the reset keeps them.
  {
    const space = "tear5";
    const root = folder(space);
    const store = folder(`${space}-store`);
    writeFileSync(join(store, "notes.txt"), "mine\n");
    mkdirSync(join(store, "photos"));
    const server = `nats://127.0.0.1:${await freePort()}`;
    const created = cli(home, "space", "create", space, "--root", root, "--json");
    check("space create prepares a root for a store beside the user's files", created.status === 0, shown(created));
    anchor(root);
    const started = cli(root, "up", "--server", server, "--store-dir", store, "--no-manager", "--json");
    check("up starts the stack on that --store-dir", started.status === 0, shown(started));
    const stopped = cli(root, "down", "--yes", "--json");
    check("down --yes stops it", stopped.status === 0, shown(stopped));
    for (const kind of ["store", "space"]) for (const mode of ["--dry-run", "--yes"]) {
      const reset = cli(root, "reset", kind, space, mode, "--json");
      check(`reset ${kind} ${mode} refuses CONFLICT, naming the files beside the store`, reset.status === 2 && reset.env?.error?.code === "CONFLICT" && Boolean(reset.env.error.message.includes(`${store} also holds notes.txt, photos`)), shown(reset));
    }
    check("the folder keeps the user's files and the store", existsSync(join(store, "notes.txt")) && existsSync(join(store, "photos")) && existsSync(join(store, "jetstream")));
    // The recorded store path replaced by a link: each reset names the path and its target.
    const moved = `${store}-real`;
    renameSync(store, moved);
    roots.push(moved);
    symlinkSync(moved, store);
    for (const kind of ["store", "space"]) for (const mode of ["--dry-run", "--yes"]) {
      const reset = cli(root, "reset", kind, space, mode, "--json");
      check(`reset ${kind} ${mode} refuses CONFLICT, naming the linked store path and the directory it points to`, reset.status === 2 && reset.env?.error?.code === "CONFLICT" && Boolean(reset.env.error.message.includes(`the recorded store path ${store} is a link to ${moved}`)) && Boolean(reset.env.error.remedy?.includes(`cotal reset ${kind} ${space} --dry-run`)), shown(reset));
    }
    check("nothing is removed through the link", existsSync(join(moved, "notes.txt")) && existsSync(join(moved, "jetstream")));
    rmSync(store);
    const missing = `${store}-missing`;
    symlinkSync(missing, store);
    for (const kind of ["store", "space"]) for (const mode of ["--dry-run", "--yes"]) {
      const reset = cli(root, "reset", kind, space, mode, "--json");
      check(`reset ${kind} ${mode} refuses a dangling store link`, reset.status === 2 && reset.env?.error?.code === "CONFLICT"
        && reset.env.error.message.includes(`the recorded store path ${store} is a link to ${missing}`)
        && reset.env.error.message.includes("nothing was removed") && reset.env.error.remedy?.includes("restore this space's original store directory at the recorded path") === true
        && reset.env.error.remedy.includes(`cotal reset ${kind} ${space} --dry-run`), shown(reset));
    }
    check("the dangling link and parked store remain", readlinkSync(store) === missing
      && !existsSync(missing) && existsSync(join(moved, "jetstream")));
  }

  // 10. A stack whose folder is deleted stops from another folder, and its name starts again.
  if (process.platform === "linux") {
    const space = "tear-retained";
    const root = folder(space);
    anchor(root);
    const started = cli(root, "up", "--space", space, "--server", `nats://127.0.0.1:${await freePort()}`);
    check("default up starts a retained stack", started.status === 0, shown(started));
    const files = readdirSync(join(root, ".cotal")).filter((name) => name.endsWith(".pid"));
    const pids = files.map((name) => ({ name, pid: Number(readFileSync(join(root, ".cotal", name), "utf8")) }));
    check("the default stack recorded all three components", pids.length === 3, pids);
    anchors.delete(root);
    rmSync(root, { recursive: true, force: true });
    const other = folder(`${space}-other`);
    anchor(other);
    const refused = cli(other, "space", "forget", space, "--json");
    check("forget names all retained processes and the whole-stack stop", refused.status === 2 && Boolean(refused.env?.error?.message.includes("manager: pid")) && Boolean(refused.env?.error?.message.includes("delivery: pid")) && Boolean(refused.env?.error?.remedy?.includes(`cotal down --space ${space} --yes`)), shown(refused));
    const preview = cli(other, "down", "--space", space, "--dry-run", "--json");
    check("the deleted default stack preview lists three members", preview.status === 0 && (preview.env?.result?.members as unknown[])?.length === 3, shown(preview));
    // Following the historical listener-only remedy must not make forget lose the daemons.
    process.kill(pids.find((row) => row.name === "nats.pid")!.pid, "SIGTERM");
    const stillRefused = cli(other, "space", "forget", space, "--json");
    check("forget still refuses after only its broker stops", stillRefused.status === 2 && findMesh(space) !== undefined && Boolean(stillRefused.env?.error?.message.includes("manager: pid")), shown(stillRefused));
    const stopped = cli(other, "down", "--space", space, "--yes", "--json");
    check("down stops the surviving retained components from another folder", stopped.status === 0 && stopped.env?.result?.kind === "gone-root-stack-stop" && findMesh(space) === undefined, shown(stopped));
    check("the deleted default stack leaves no component process", pids.every(({ pid }) => { try { process.kill(pid, 0); return false; } catch { return true; } }), pids);
  }
  {
    const space = "tear7";
    const root = folder(space);
    const created = cli(home, "space", "create", space, "--root", root, "--json");
    check("space create prepares a root that is then deleted", created.status === 0, shown(created));
    anchor(root);
    const started = cli(root, "up", "--server", `nats://127.0.0.1:${await freePort()}`, "--json");
    const listed = cli(root, "service", "--space", space, "--json");
    const pids = ((listed.env?.result?.instances as { pid: number | null }[] | undefined) ?? []).map((row) => row.pid);
    check("up starts the broker, delivery and the manager", started.status === 0 && pids.length === 3 && pids.every((pid) => typeof pid === "number"), { up: shown(started), services: shown(listed) });
    anchors.delete(root);
    rmSync(root, { recursive: true, force: true });
    const other = folder(`${space}-other`);
    anchor(other);
    const status = cli(other, "status", "--space", space, "--json");
    check("status says the project folder is gone", (status.env?.result?.selected as { rootGone?: unknown } | undefined)?.rootGone === true, shown(status));
    // The seed went with the folder, so a command that connects names the same stop.
    for (const args of [["send", "-c", "general", "hi"], ["history", "general"]]) {
      const refused = cli(other, ...args, "--space", space, "--json");
      check(`${args[0]} refuses DEPENDENCY_UNAVAILABLE, naming the gone folder and cotal down --space ${space} --yes`,
        refused.status === 2 && refused.env?.error?.code === "DEPENDENCY_UNAVAILABLE" && refused.env.target?.space === space && Boolean(refused.env.error.message.includes(`${root}, and that folder is gone`))
          && refused.env.error.remedy === `stop the stack it left running and free its name with \`cotal down --space ${space} --yes\``, shown(refused));
    }
    const stopped = cli(other, "down", "--space", space, "--yes", "--json");
    const members = (stopped.env?.result?.members as { result: string }[] | undefined) ?? [];
    check("down --space from another folder stops every member by signal and removes the stack definitions",
      stopped.status === 0 && stopped.env?.result?.kind === "gone-root-stack-stop" && members.length === 3 && members.every((row) => row.result === "stopped")
        && JSON.stringify(stopped.env?.result?.releasedDefinitions) === JSON.stringify(["stack-broker", "stack-delivery", "stack-manager"]), shown(stopped));
    check("no member process is left", pids.every((pid) => { try { process.kill(pid!, 0); return false; } catch { return true; } }), pids);
    const spaceServiceDir = join(home, "services", Buffer.from(space, "utf8").toString("hex"));
    check("gone-root down removes retired instance logs, sidecars, broker launch scratch, and the empty space service directory",
      !existsSync(spaceServiceDir), spaceServiceDir);
    const elsewhere = folder(`${space}b`);
    const again = cli(home, "space", "create", space, "--root", elsewhere, "--json");
    anchor(elsewhere);
    const reused = cli(elsewhere, "up", "--server", `nats://127.0.0.1:${await freePort()}`, "--no-manager", "--json");
    check("another folder prepares and starts a stack under the same name", again.status === 0 && reused.status === 0, { create: shown(again), up: shown(reused) });
    const last = cli(elsewhere, "down", "--yes", "--json");
    check("down --yes stops it", last.status === 0, shown(last));
    anchors.delete(elsewhere);
    rmSync(elsewhere, { recursive: true, force: true });
    for (const args of [["send", "-c", "general", "hi"], ["history", "general"]]) {
      const refused = cli(other, ...args, "--space", space, "--json");
      check(`${args[0]} keeps move-back or forget advice when the gone folder has no running stack members`,
        refused.status === 2 && refused.env?.error?.code === "TARGET_UNAVAILABLE"
          && refused.env.error.message.includes(`${elsewhere}, which no longer exists`)
          && Boolean(refused.env.error.remedy?.includes(`cotal space forget ${space}`))
          && !refused.env.error.remedy?.includes("cotal down"), shown(refused));
    }
  }

  // 11. An open space another machine deleted under its running stack.
  {
    const space = "tear9";
    const root = folder(space);
    const created = cli(home, "space", "create", space, "--root", root, "--json");
    check("space create prepares an open stack's root", created.status === 0, shown(created));
    anchor(root);
    const server = `nats://127.0.0.1:${await freePort()}`;
    const started = cli(root, "up", "--open", "--server", server, "--json");
    check("up --open starts the stack with its manager", started.status === 0, shown(started));
    // The other machine: a Cotal home and a project folder of its own, on the same broker.
    const elsewhere = folder(`${space}-elsewhere`);
    const elsewhereEnv = { ...env, COTAL_HOME: join(elsewhere, "home"), XDG_CONFIG_HOME: join(elsewhere, "xdg") };
    for (const dir of ["home", "xdg", "proj"]) mkdirSync(join(elsewhere, dir), { mode: 0o700 });
    const other = (...args: string[]) => {
      const run = spawnSync(process.execPath, [CLI, ...args], { cwd: join(elsewhere, "proj"), env: elsewhereEnv, encoding: "utf8", timeout: 180_000 });
      let parsed: Envelope | undefined;
      try { parsed = JSON.parse(run.stdout) as Envelope; } catch { parsed = undefined; }
      return { status: run.status, stdout: run.stdout, stderr: run.stderr, env: parsed } satisfies Run;
    };
    const added = other("space", "add", space, "--server", server, "--root", join(elsewhere, "proj"));
    const confirmation = other("space", "delete", space, "--json");
    check("space delete confirmation keeps JSON in both the preview and apply commands",
      confirmation.status === 1 && confirmation.env?.error?.code === "USAGE_INVALID"
        && confirmation.env.error.remedy === `inspect \`cotal space delete ${space} --dry-run --json\` first, then run \`cotal space delete ${space} --yes --json\``, shown(confirmation));
    const preview = other("space", "delete", space, "--dry-run", "--json");
    check("the suggested delete preview returns JSON without applying", preview.status === 0 && preview.env?.result?.kind === "live-space-delete-impact", shown(preview));
    const deleted = other("space", "delete", space, "--yes", "--json");
    check("another Cotal home adds the open space and deletes it with a JSON receipt while the stack runs",
      added.status === 0 && deleted.status === 0 && deleted.env?.result?.kind === "live-space-delete",
      { added: shown(added), deleted: shown(deleted) });
    const statusGone = cli(root, "status", "--json");
    const streamsGone = (statusGone.env?.result?.selected as { spaceStreams?: { state: string; root: string | null; stack: string | null } } | undefined)?.spaceStreams;
    check("status says the streams are not on the broker while the stack runs", statusGone.status === 0 && streamsGone?.state === "absent" && streamsGone.stack === "running" && streamsGone.root === root, shown(statusGone));
    const statusShown = cli(root, "status");
    const next = statusShown.stdout.slice(statusShown.stdout.indexOf("\nNext\n") + 6).split("\n");
    check("its Space streams row says the space was deleted under the running stack, and Next leads with down --yes, then up",
      statusShown.stdout.includes("not on the broker · the space was deleted under its running stack") && /cotal down --yes +Stop the stack its space was deleted under/.test(next[0] ?? "") && /cotal up +Then start it again; up creates the space's streams, empty/.test(next[1] ?? ""), shown(statusShown));
    const message = `the streams of ${space} are not on its broker while its stack runs, so the space was deleted under it; nothing can be read or stored until they are created again`;
    const remedy = `stop the stack with \`cotal down --yes\` in ${root}, then run \`cotal up\` there to create them again, empty`;
    const [readGone, sendGone] = [cli(root, "history", "general", "--json"), cli(root, "send", "-c", "general", "after the delete", "--json")];
    check("history and send refuse TARGET_UNAVAILABLE naming the deletion and down --yes, then up, where they read 0 messages and exited 3",
      [readGone, sendGone].every((r) => r.status === 2 && r.env?.error?.code === "TARGET_UNAVAILABLE" && r.env.error.message === message && r.env.error.remedy === remedy), { history: shown(readGone), send: shown(sendGone) });
    const runsGone = cli(root, "run", "ps");
    check("run ps refuses TARGET_UNAVAILABLE naming the same cause, not the contract-store read", runsGone.status === 2 && runsGone.stderr.includes(`the streams of ${space} are not on its broker`) && !runsGone.stderr.includes("contract-store"), shown(runsGone));
    const stopped = cli(root, "down", "--yes", "--json");
    const restarted = cli(root, "up", "--json");
    const sent = cli(root, "send", "-c", "general", "after the restart", "--json");
    check("down --yes, then up, gives the space its streams back", stopped.status === 0 && restarted.status === 0 && sent.status === 0, { down: shown(stopped), up: shown(restarted), send: shown(sent) });
    const last = cli(root, "down", "--yes", "--json");
    check("down --yes stops it", last.status === 0, shown(last));
    for (const flags of [[], ["--fix"], ["--space", space], ["--space", space, "--fix"]]) {
      const diagnosed = cli(root, "doctor", "auth", ...flags, "--json");
      check(`doctor auth ${flags.join(" ")} on a stopped open stack is a root-local no-op`,
        diagnosed.status === 0 && diagnosed.env?.outcome === "no-op" && diagnosed.env.target?.root === root
          && diagnosed.env.result?.space === space && diagnosed.env.result?.credentialScope === "open-space"
          && diagnosed.env.result?.brokerAuthorization === "not-checked"
          && (diagnosed.env.result?.repair as { attempted?: boolean } | undefined)?.attempted === false, shown(diagnosed));
      const plain = cli(root, "doctor", "auth", ...flags, "--plain");
      check("the stopped open stack's text report says there are no credentials, with no root-folder remedy",
        plain.status === 0 && plain.stdout.includes("No credentials to check") && !`${plain.stdout}${plain.stderr}`.includes("root folder"), shown(plain));
    }
    const wrongSpace = cli(root, "doctor", "auth", "--space", "not-this-stack", "--json");
    check("an open stack does not establish open mode for another named space",
      wrongSpace.status === 2 && wrongSpace.env?.error?.code === "AUTH_REQUIRED", shown(wrongSpace));

    const authSpace = "tear9auth";
    const openUp = cli(root, "up", "--json");
    check("the open stack starts again at its recorded broker", openUp.status === 0, shown(openUp));
    const authRoot = folder(authSpace);
    const authServer = `nats://127.0.0.1:${await freePort()}`;
    const authCreated = cli(home, "space", "create", authSpace, "--root", authRoot, "--json");
    check("space create prepares the second auth stack's root", authCreated.status === 0, shown(authCreated));
    const authUp = cli(authRoot, "up", "--server", authServer, "--json");
    check("a second stack starts an authenticated broker", authUp.status === 0, shown(authUp));
    anchor(authRoot);
    const caller = folder("doctor-caller");
    mkdirSync(join(caller, ".cotal"), { mode: 0o700 });
    {
      const mismatch = cli(caller, "send", "-c", "general", "hi", "--space", space, "--server", authServer, "--json");
      check("an open space with an overriding auth broker names both addresses and dropping --server, never up here",
        mismatch.status === 2 && mismatch.env?.error?.code === "AUTH_REQUIRED"
          && mismatch.env.error.message.includes(authServer) && mismatch.env.error.message.includes(`"${space}" is recorded as an open mesh at ${server}`)
          && mismatch.env.error.remedy === `check that address, or drop --server and retry with \`--space ${space}\` to reach its recorded broker at ${server}`
          && !mismatch.env.error.remedy.includes("cotal up"), shown(mismatch));
    }
    const openDown = cli(root, "down", "--yes", "--json");
    check("the open stack stops after the mismatched broker refusal", openDown.status === 0, shown(openDown));
    const authDown = cli(authRoot, "down", "--yes", "--json");
    check("the auth stack stops cleanly before its folder is deleted", authDown.status === 0, shown(authDown));
    anchors.delete(authRoot);
    rmSync(authRoot, { recursive: true, force: true });
    for (const flags of [[], ["--fix"]]) {
      const missing = cli(caller, "doctor", "auth", "--space", authSpace, ...flags, "--json");
      check("doctor auth for the deleted auth root names moving it back or forgetting it, not rerunning in that folder",
        missing.status === 2 && missing.env?.error?.code === "AUTH_REQUIRED"
          && Boolean(missing.env.error.remedy?.includes(`${authRoot}, no longer exists`))
          && Boolean(missing.env.error.remedy?.includes("move it back"))
          && Boolean(missing.env.error.remedy?.includes(`cotal space forget ${authSpace}`))
          && !missing.env.error.remedy?.startsWith("run `"), shown(missing));
    }
  }

  // 12. A mistyped name and a prepared space no stack ran for have nothing to reset.
  {
    const space = "tear12";
    const root = folder(space);
    const created = cli(home, "space", "create", space, "--root", root, "--json");
    check("space create prepares a root no stack runs in", created.status === 0, shown(created));
    for (const command of ["store", "space"]) {
      const typo = cli(home, "reset", command, "tear", "--dry-run", "--json");
      check(`reset ${command} of a name no space has refuses TARGET_NOT_FOUND, exit 2, saying so and naming cotal space first`,
        typo.status === 2 && typo.env?.error?.code === "TARGET_NOT_FOUND" && typo.env.error.message === "no space this machine registered or prepared has this exact name; nothing was removed" && Boolean(typo.env.error.remedy?.startsWith("see the spaces with `cotal space`; if it ran from a legacy root")), shown(typo));
      const unstarted = cli(home, "reset", command, space, "--dry-run", "--json");
      check(`reset ${command} of a prepared space no stack ran for refuses TARGET_NOT_FOUND, naming its root, cotal up and space forget`,
        unstarted.status === 2 && unstarted.env?.error?.code === "TARGET_NOT_FOUND" && unstarted.env.error.message === `reset ${command} found nothing to reset: no stack has run for "${space}" in ${root}, so no broker wrote a store; nothing was removed`
          && unstarted.env.error.remedy === `start it with \`cotal up\` from ${root}, or remove its local record with \`cotal space forget ${space}\``, shown(unstarted));
    }
  }

  // 13. A store write the broker could not make stops JetStream; it deletes nothing.
  if (process.platform !== "win32") {
    const space = "tear13";
    const root = folder(space);
    const created = cli(home, "space", "create", space, "--root", root, "--json");
    check("space create prepares a stack whose store goes read-only", created.status === 0, shown(created));
    anchor(root);
    const started = cli(root, "up", "--server", `nats://127.0.0.1:${await freePort()}`, "--no-manager", "--json");
    check("up starts it", started.status === 0, shown(started));
    const texts = ["eins", "zwei", "drei", "vier", "fünf", "sechs"];
    check("six messages are stored", texts.every((text) => cli(root, "send", "-c", "general", text, "--json").status === 0));
    const store = join(root, ".cotal", "nats");
    const big = join(root, "big.txt");
    writeFileSync(big, "B".repeat(900_000));
    spawnSync("chmod", ["-R", "a-w", join(store, "jetstream")]);
    try {
      // The chat stream's first block holds about 8 MB, so a later message needs a file the broker cannot create.
      let failed: Run | undefined, stored = 0;
      for (let i = 0; i < 14 && !failed; i++) {
        const sent = cli(root, "send", "-c", "general", "--file", big, "--json");
        if (sent.status === 0) stored++;
        else failed = sent;
      }
      check("the send whose block the broker cannot create exits 3 naming the logged permission failure, and its Next makes the store writable, not free disk",
        failed?.status === 3 && failed.env?.error?.code === "OPERATION_UNKNOWN" && /broker logged a store write failure at .*: permission denied/.test(failed.env.error.message) &&
          failed.env.error.remedy === `Make ${store} writable by this account again, as chmod -R u+w ${store} does, then restart the broker with \`cotal down\` and \`cotal up\` before sending again. The broker disabled JetStream, so if \`cotal down\` refuses because the manager's stop cannot be recorded, it names the manager process to end on this host first.`, failed && shown(failed));
      const after = cli(root, "send", "-c", "general", "after the failure", "--json");
      const message = after.env?.error?.message ?? "";
      check("a later send refuses DEPENDENCY_UNAVAILABLE naming the write failure, and does not say the space was deleted",
        after.status === 2 && after.env?.error?.code === "DEPENDENCY_UNAVAILABLE" && message.startsWith(`the broker of ${space} has answered no JetStream request since it logged a store write failure at `) && message.includes(": permission denied") && !/deleted/.test(message), shown(after));
      check("its Next makes the store writable and restarts the broker, which keeps the history, and creates nothing again empty",
        after.env?.error?.remedy === `make ${store} writable by this account again, as chmod -R u+w ${store} does, then restart the broker with \`cotal down --yes\` and \`cotal up\` in ${root}, which keeps the history` && !/empty/.test(after.env.error.remedy), shown(after));
      const status = cli(root, "status", "--json");
      const selected = status.env?.result?.selected as { spaceStreams?: { state: string } } | undefined;
      check("status names the write failure and does not report the streams absent", (status.env?.result?.store as { state?: string; cause?: string } | undefined)?.state === "write-failed" && selected?.spaceStreams?.state !== "absent", shown(status));
      const components = cli(root, "status", "--components");
      check("component health grades the reachable broker not-serving after its store write fails",
        components.status !== 0 && /broker\s+not-serving/.test(components.stdout) && components.stdout.includes("store write failed:") && components.stdout.includes("permission denied"), shown(components));
      const statusText = cli(root, "status");
      check("its Next leads with down, after making the store writable again",
        statusText.stdout.split("\n").some((line) => /cotal down +First make /.test(line) && line.includes(`${store} writable by this account again`)) && !statusText.stdout.includes("deleted under"), shown(statusText));
      spawnSync("chmod", ["-R", "u+w", join(store, "jetstream")]);
      const stopped = cli(root, "down", "--yes", "--json");
      const restarted = cli(root, "up", "--json");
      const kept = cli(root, "history", "general", "--limit", "100", "--json");
      const held = ((kept.env?.result?.items ?? []) as { text?: string }[]).map((m) => m.text);
      check("with the store writable, down --yes and up bring back every message stored before the failure",
        stopped.status === 0 && restarted.status === 0 && kept.status === 0 && texts.every((text) => held.includes(text)) && held.length === texts.length + stored, { down: shown(stopped), up: shown(restarted), held: held.map((text) => text?.slice(0, 12)), stored });
    } finally {
      spawnSync("chmod", ["-R", "u+w", join(store, "jetstream")]);
    }
    const last = cli(root, "down", "--yes", "--json");
    check("down --yes stops it", last.status === 0, shown(last));
  }

  // 14. An open stack whose folder is renamed while it runs stops from another folder. Adopting it
  // keeps its mode, saved payload limit, channel metadata and history.
  {
    const space = "tear14";
    const root = folder(space);
    const created = cli(home, "space", "create", space, "--root", root, "--json");
    check("space create prepares a root that is then renamed", created.status === 0, shown(created));
    anchor(root);
    const server = `nats://127.0.0.1:${await freePort()}`;
    const started = cli(root, "up", "--open", "--server", server, "--no-manager", "--max-payload", "16384", "--json");
    const channel = "moved.notes", description = "Notes kept across the move";
    const saved = cli(root, "channel", "set", channel, "--desc", description);
    const messages = ["first post across the move", "second post across the move"];
    const sent = messages.map((message) => cli(root, "send", "-c", channel, message, "--json"));
    check("open up starts the stack and stores channel metadata and two messages",
      started.status === 0 && started.env?.result?.mode === "open" && saved.status === 0 && sent.every((post) => post.status === 0), { up: shown(started), channel: shown(saved), send: sent.map(shown) });
    anchors.delete(root);
    const moved = `${root}-moved`;
    renameSync(root, moved);
    roots.push(moved);
    const other = folder(`${space}-other`);
    anchor(other);
    const stopped = cli(other, "down", "--space", space, "--yes");
    anchors.delete(other);
    const text = stopped.stdout.replace(/\x1b\[[0-9;]*m/g, "");
    const next = text.slice(text.indexOf("\nNext\n")).split("\n").map((line) => line.trim().split(/\s{2,}/)[0]).filter((command) => /^(?:pnpm )?cotal /.test(command)).map((command) => command.replace(/^pnpm /, ""));
    check("down --space from another folder stops it, and its Next names the adopt route before another folder",
      stopped.status === 0 && text.includes("Stack stopped; its folder was gone") && JSON.stringify(next) === JSON.stringify([`cotal space create ${space} --adopt --root <folder>`, `cotal space create ${space}`]), shown(stopped));
    const restart = /--adopt --root <folder>[^\n]* then run `(?:pnpm )?cotal (up[^`\n]*)` there/.exec(text)?.[1];
    check("the adoption advice preserves --no-manager without changing the fresh-start advice",
      restart === "up --no-manager" && /Otherwise prepare the space in another folder, then run `(?:pnpm )?cotal up` there/.test(text), shown(stopped));
    const adopted = cli(other, "space", "create", space, "--adopt", "--root", moved, "--json");
    anchor(moved);
    const restarted = cli(moved, ...(restart ?? "up").split(" "), "--json");
    const members = restarted.env?.result?.members as { role: string; state: string }[] | undefined;
    check("the printed restart starts the adopted stack at its original address without a manager",
      adopted.status === 0 && restarted.status === 0 && restarted.env?.result?.mode === "open" && restarted.env.result.server === server
      && members?.some((member) => member.role === "manager" && member.state === "not-attempted") === true, { adopt: shown(adopted), up: shown(restarted) });
    if (restarted.status === 0) {
      const nc = await connect({ servers: server, reconnect: false, timeout: 2_000 });
      try { check("the restarted broker serves at the saved 16384-byte payload limit", nc.info?.max_payload === 16384, nc.info?.max_payload); }
      finally { await nc.close(); }
    }
    const channels = cli(moved, "channel", "--plain");
    check("the adopted open stack lists the saved channel metadata",
      channels.status === 0 && channels.stdout.includes(channel) && channels.stdout.includes(description), shown(channels));
    const kept = cli(moved, "history", channel, "--limit", "20", "--json");
    const retained = ((kept.env?.result?.items ?? []) as { text?: string }[]).map((item) => item.text);
    check("the adopted open stack retains both posts",
      kept.status === 0 && retained.length === messages.length && messages.every((message) => retained.includes(message)), shown(kept));
    const last = cli(moved, "down", "--yes", "--json");
    check("down --yes stops it", last.status === 0, shown(last));
  }

  // 15. A forgotten space whose stack ran a manager starts again in its own folder without one.
  {
    const space = "tear15";
    const root = folder(space);
    const server = `nats://127.0.0.1:${await freePort()}`;
    type Row = { role: string; instanceId: string | null; state: string };
    const rows = (run: Run) => (run.env?.result?.members ?? []) as Row[];
    const ids = (members: Row[]) => members.flatMap((row) => row.instanceId === null ? [] : [row.instanceId]).sort();
    const journalRows = () => (JSON.parse(readFileSync(journalOf(root), "utf8")) as { members: Row[] }).members;
    const pidsOf = () => ((cli(root, "service", "--space", space, "--json").env?.result?.instances as { pid: number | null }[] | undefined) ?? []).map((row) => row.pid);
    const gone = (pids: (number | null)[]) => pids.every((pid) => { try { process.kill(pid!, 0); return false; } catch { return true; } });
    const created = cli(home, "space", "create", space, "--root", root, "--json");
    check("space create prepares a root whose stack runs a manager", created.status === 0, shown(created));
    anchor(root);
    const started = cli(root, "up", "--server", server, "--json"), first = rows(started), firstPids = pidsOf();
    const manager = first.find((row) => row.role === "manager")?.instanceId;
    check("up starts the broker, delivery and the manager", started.status === 0 && typeof manager === "string" && firstPids.length === 3 && firstPids.every((pid) => typeof pid === "number"), shown(started));
    const omitted = cli(root, "up", "--server", server, "--no-manager", "--json");
    check("up --no-manager refuses LIFECYCLE_BLOCKED while that manager runs, and the journal keeps it",
      omitted.status === 2 && omitted.env?.error?.code === "LIFECYCLE_BLOCKED" && journalRows().find((row) => row.role === "manager")?.instanceId === manager, shown(omitted));
    const stopped = cli(root, "down", "--yes", "--json");
    check("down --yes stops every member, and no member process is left", stopped.status === 0 && JSON.stringify(ids(rows(stopped))) === JSON.stringify(ids(first)) && gone(firstPids), shown(stopped));
    checkStoppedDeliveryLog(root, space, first.find((row) => row.role === "delivery")?.instanceId);
    const cycledUp = cli(root, "up", "--json"), cycledRows = rows(cycledUp), cycledPids = pidsOf();
    const cycledDown = cli(root, "down", "--yes", "--json");
    const spaceServiceDir = join(home, "services", Buffer.from(space, "utf8").toString("hex"));
    const instanceEntries = existsSync(join(spaceServiceDir, "instances")) ? readdirSync(join(spaceServiceDir, "instances")).sort() : [];
    check("restarting and stopping the stack replaces retired manager logs and prior broker launch scratch without leaking retired files",
      cycledUp.status === 0 && cycledDown.status === 0 && gone(cycledPids)
        && instanceEntries.filter((f) => f.endsWith(".log")).length === 3
        && instanceEntries.filter((f) => f.startsWith(".broker-ports-")).length === 1
        && instanceEntries.filter((f) => f.startsWith(".broker-launch-")).length === 1
        && !instanceEntries.some((f) => f.includes(Buffer.from(manager!, "utf8").toString("hex"))),
      { cycledRows, instanceEntries });
    const forgot = cli(home, "space", "forget", space, "--json");
    check("space forget removes the three stack definitions, the journal names none of their instances, and the space's services directory is gone",
      forgot.status === 0 && JSON.stringify(forgot.env?.result?.releasedDefinitions) === JSON.stringify(["stack-broker", "stack-delivery", "stack-manager"]) && ids(journalRows()).length === 0 && !existsSync(spaceServiceDir), { forget: shown(forgot), journal: journalRows(), exists: existsSync(spaceServiceDir) });
    const again = cli(home, "space", "create", space, "--root", root, "--json");
    const restarted = cli(root, "up", "--server", server, "--no-manager", "--json"), second = rows(restarted), secondPids = pidsOf();
    check("space create there and up --no-manager start a new broker and delivery, and record no manager instance",
      again.status === 0 && restarted.status === 0 && second.find((row) => row.role === "manager")?.instanceId === null && ids(second).length === 2 && !ids(second).some((id) => ids(first).includes(id)) && secondPids.length === 2,
      { create: shown(again), up: shown(restarted) });
    const last = cli(root, "down", "--yes", "--json");
    check("down --yes then stops them, and no member process is left",
      last.status === 0 && JSON.stringify(ids(rows(last))) === JSON.stringify(ids(second)) && rows(last).every((row) => row.instanceId === null || row.state === "stopped") && gone(secondPids), shown(last));
  }
  // 16. Forgetting an open space does not make its stopped broker a first start.
  {
    const space = "tear16";
    const root = folder(space);
    const server = `nats://127.0.0.1:${await freePort()}`;
    const store = join(root, "retained-store");
    const text = "retained-before-forget";
    const created = cli(root, "space", "create", space, "--json");
    anchor(root);
    const started = cli(root, "up", "--open", "--no-manager", "--server", server, "--store-dir", store, "--json");
    const sent = cli(root, "send", "-c", "audit", text, "--json");
    const blocked = cli(root, "space", "forget", space, "--plain");
    const stop = /stop it with `(?:pnpm )?cotal (down --yes)`/.exec(blocked.stderr)?.[1];
    check("forget of a running stack keeps the registration and names how to confirm its stop without a terminal",
      blocked.status === 2 && blocked.stderr.includes("LIFECYCLE_BLOCKED") && stop !== undefined
        && blocked.stderr.includes(`in ${root} to explicitly confirm the stop`) && findMesh(space)?.root === root, shown(blocked));
    const stopped = stop === undefined ? undefined : cli(root, ...stop.split(" "));
    const forgot = cli(root, "space", "forget", space, "--json");
    const recreated = cli(root, "space", "create", space, "--json");
    check("the open stack stored a message and was stopped, forgotten and prepared again",
      created.status === 0 && started.env?.result?.mode === "open" && sent.status === 0 && stopped?.status === 0
        && forgot.status === 0 && JSON.stringify(forgot.env?.result?.releasedDefinitions) === '["stack-broker"]' && recreated.status === 0,
      { created: shown(created), started: shown(started), sent: shown(sent), stopped: stopped && shown(stopped), forgot: shown(forgot), recreated: shown(recreated) });
    const restarted = cli(root, "up", "--no-manager", "--json");
    const delivery = (restarted.env?.result?.members as { role: string; instanceId: string | null }[] | undefined)?.find((row) => row.role === "delivery");
    const history = cli(root, "history", "audit", "--limit", "10", "--json");
    check("up without a mode or address keeps the open broker and its retained history without starting delivery",
      restarted.status === 0 && restarted.env?.result?.mode === "open" && restarted.env?.result?.server === server && delivery?.instanceId === null
        && findMesh(space)?.storeDir === store && history.status === 0 && (history.env?.result?.items as { text?: string }[] | undefined)?.some((row) => row.text === text) === true,
      { restarted: shown(restarted), history: shown(history) });
    const last = cli(root, "down", "--yes", "--json");
    check("the reopened open stack stops cleanly", last.status === 0, shown(last));
  }

  // A stopped project's original path can be occupied by a file after the folder is moved.
  {
    const space = "root-obstructed";
    const root = folder(space), outside = folder(`${space}-caller`);
    const created = cli(root, "space", "create", space, "--json");
    anchor(root);
    const started = cli(root, "up", "--open", "--server", `nats://127.0.0.1:${await freePort()}`, "--json");
    const stopped = cli(root, "down", "--yes", "--json");
    check("the open stack starts and stops before the project moves",
      created.status === 0 && started.status === 0 && stopped.status === 0, [created, started, stopped].map(shown));

    const moved = join(outside, "original-project");
    renameSync(root, moved);
    anchors.delete(root);
    const contents = "must remain intact\n";
    writeFileSync(root, contents, { flag: "wx" });
    anchor(outside);
    const released = cli(outside, "down", "--space", space, "--yes", "--plain");
    anchors.delete(outside);
    check("named down releases the stopped stack and explains how to restore the occupied project path",
      released.status === 0 && released.stdout.includes(`${root} - occupied by a file`)
        && released.stdout.includes("already stopped") && released.stdout.includes("Removed the saved definitions stack-broker, stack-manager")
        && released.stdout.includes("It was left untouched.") && !released.stdout.includes("The broker wrote")
        && released.stdout.includes("move the file aside and restore the original project folder"), shown(released));
    check("named down preserves the file and the moved project's journal",
      lstatSync(root).isFile() && readFileSync(root, "utf8") === contents && existsSync(journalOf(moved)));
  }
} finally {
  for (const root of roots) if (anchors.has(root)) cli(root, "down", "--yes", "--json");
}
finish();
