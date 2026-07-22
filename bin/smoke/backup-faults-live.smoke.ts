/** Live fault injection at every backup stage, and whole-attempt restore replay after an exact-ID
 *  chunk-handoff timeout. Both halves assert the same contract from opposite ends: a failed attempt
 *  publishes nothing, keeps nothing, and leaves the cut retryable at the SAME destination. */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { createServer, type AddressInfo } from "node:net";
import { existsSync, lstatSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  chatStream,
  mintCreds,
  newIdentity,
  spaceBackupInventory,
  type SpaceBackupSelection,
} from "@cotal-ai/core";
import { authDir, loadSoleSpaceAuth } from "@cotal-ai/workspace";
import { BACKUP_MANIFEST_FORMAT, type BackupManifest } from "../../implementations/cli/src/lib/backup-artifact.js";

const freePort = () => new Promise<number>((resolvePort, reject) => {
  const server = createServer();
  server.once("error", reject);
  server.listen(0, "127.0.0.1", () => {
    const port = (server.address() as AddressInfo).port;
    server.close((error) => error ? reject(error) : resolvePort(port));
  });
});

const worktree = resolve(import.meta.dirname, "..", "..");
const cliPath = join(worktree, "bin", "cotal.ts");
const taskSeedPath = join(worktree, "implementations", "cli", "smoke", "seed-task-durable.ts");
const tsx = join(worktree, "node_modules", ".bin", "tsx");

/** Every `cotal backup create` stage the product can be told to throw at, with the message each
 *  injection reports. The list IS the assertion that no stage is silently unhooked. */
const BACKUP_STAGES = {
  initiation: /smoke-injected failure at snapshot initiation/,
  chunk: /smoke-injected failure at the first snapshot chunk/,
  close: /smoke-injected failure after snapshot close/,
  manifest: /smoke-injected failure before manifest publication/,
} as const;

const journalState = (root: string): string | undefined => {
  const path = join(root, ".cotal", "maintenance", "v1", "journal.json");
  if (!existsSync(path)) return undefined;
  return (JSON.parse(readFileSync(path, "utf8")) as { state: string }).state;
};

const attemptResidue = (root: string): string[] => {
  const attempts = join(root, ".cotal", "maintenance", "attempts");
  return existsSync(attempts) ? readdirSync(attempts) : [];
};

/** Parse a published artifact as a real consumer would: the format tag, the exact stream inventory
 *  for the selection, and a files list whose recorded SHA-256 matches the bytes on disk. */
function assertValidManifest(directory: string, space: string, selection: SpaceBackupSelection): BackupManifest {
  const manifest = JSON.parse(readFileSync(join(directory, "manifest.json"), "utf8")) as BackupManifest;
  assert.equal(manifest.format, BACKUP_MANIFEST_FORMAT, "retried artifact declares the current backup format");
  assert.equal(manifest.space, space);
  assert.equal(manifest.selection, selection);
  const expected = [...spaceBackupInventory(space)[selection]].sort();
  assert.deepEqual(manifest.streams.map((stream) => stream.stream).sort(), expected, "retried artifact snapshots the whole selection");
  // One snapshot per stream plus the checkpoints file: a partial retry would publish fewer.
  assert.equal(manifest.files.length, expected.length + 1, "retried artifact publishes one file per stream plus checkpoints");
  for (const file of manifest.files) {
    assert.match(file.sha256, /^[0-9a-f]{64}$/, `${file.path} records a SHA-256`);
    const bytes = readFileSync(join(directory, file.path));
    assert.equal(bytes.byteLength, file.size, `${file.path} matches its recorded size`);
    assert.equal(createHash("sha256").update(bytes).digest("hex"), file.sha256, `${file.path} matches its recorded SHA-256`);
  }
  return manifest;
}

/** One preserved open-mode cut, faulted at each backup stage in turn: the destination never
 *  survives unpublished, the attempt leaves nothing behind, and the SAME path retries clean. */
async function backupStageFaultScenario(): Promise<void> {
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), "cotal-backup-faults-stages-root-")));
  const home = realpathSync.native(mkdtempSync(join(tmpdir(), "cotal-backup-faults-stages-home-")));
  const port = await freePort();
  const server = `nats://127.0.0.1:${port}`;
  const space = "backup_faults_stages";
  const env = { ...process.env, COTAL_HOME: home };
  const run = (...args: string[]) => spawnSync(tsx, [cliPath, ...args], { cwd: root, env, encoding: "utf8", timeout: 240_000 });
  const must = (label: string, result: ReturnType<typeof run>) => {
    assert.equal(result.status, 0, `stages ${label}\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
  };
  const sourcePath = join(root, ".cotal", "nats");
  try {
    must("up", run("up", "--detach", "--open", "--server", server, "--space", space));
    must("seed registry", run("channels", "set", "preserved", "--desc", "survives every fault", "--space", space));
    must("preserve cut", run("down", "--preserve-state"));
    assert.equal(journalState(root), "ready");
    const sourceBefore = lstatSync(sourcePath, { bigint: true });

    for (const [stage, injected] of Object.entries(BACKUP_STAGES)) {
      const destination = join(root, `artifact-${stage}`);
      const faulted = spawnSync(tsx, [cliPath, "backup", "create", destination], {
        cwd: root,
        env: { ...env, COTAL_SMOKE_FAIL_BACKUP_STAGE: stage },
        encoding: "utf8",
        timeout: 240_000,
      });
      assert.notEqual(faulted.status, 0, `${stage} fault must fail the backup\nstdout:\n${faulted.stdout}`);
      assert.match(faulted.stderr, injected, `${stage} fault reports its injected failure`);
      assert.equal(journalState(root), "ready", `${stage} fault returns the maintenance journal to ready`);
      assert.equal(existsSync(destination), false, `${stage} fault leaves no unpublished artifact at the destination`);
      assert.deepEqual(attemptResidue(root), [], `${stage} fault leaves no clone, config, or broker residue in the attempts dir`);
      const sourceAfter = lstatSync(sourcePath, { bigint: true });
      assert.equal(sourceAfter.dev, sourceBefore.dev, `${stage} fault leaves the preserved source device unchanged`);
      assert.equal(sourceAfter.ino, sourceBefore.ino, `${stage} fault leaves the preserved source inode unchanged`);

      // The retry is the point: a faulted attempt must not poison its own destination path.
      must(`${stage} retry at the same destination`, run("backup", "create", destination));
      assertValidManifest(destination, space, "full");
      assert.equal(journalState(root), "ready", `${stage} retry leaves the cut ready`);
      assert.deepEqual(attemptResidue(root), [], `${stage} retry leaves no attempt residue`);
    }
    must("ordinary resume after every fault", run("up", "--detach", "--open", "--server", server, "--space", space));
    const listed = run("channels", "list", "--space", space);
    must("list registry after every fault", listed);
    assert.match(listed.stdout, /#preserved/, "the faulted attempts never touched the preserved registry");
    must("down", run("down"));
  } finally {
    run("down");
    rmSync(root, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  }
}

/** A restore installs every stream twice: once into the quarantine rehearsal, then into the real
 *  target from re-derived sanitized bytes. An exact-ID chunk-handoff timeout on the LAST stream of
 *  the order is injected into each pass in turn — the `target:` form only after quarantine has
 *  succeeded, so the earlier target streams and a live target broker already exist when it hits. */
const RESTORE_FAULTS = [
  { spec: (stream: string) => stream, pass: "quarantine", label: "bare spec, caught by the quarantine rehearsal" },
  { spec: (stream: string) => `target:${stream}`, pass: "target", label: "target pass, earlier target streams already installed" },
] as const;

/** An exact-ID chunk-handoff timeout on the LAST stream of the restored order: the whole attempt
 *  rolls back to the preserved source from either pass, and the replay without the fault completes
 *  to active with the seeded state intact and no duplicated messages. */
async function restoreExactIdTimeoutReplayScenario(): Promise<void> {
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), "cotal-backup-faults-replay-root-")));
  const home = realpathSync.native(mkdtempSync(join(tmpdir(), "cotal-backup-faults-replay-home-")));
  const artifact = join(root, "full-backup");
  const port = await freePort();
  const server = `nats://127.0.0.1:${port}`;
  const space = "backup_faults_replay";
  const env = { ...process.env, COTAL_HOME: home };
  const run = (...args: string[]) => spawnSync(tsx, [cliPath, ...args], { cwd: root, env, encoding: "utf8", timeout: 240_000 });
  const must = (label: string, result: ReturnType<typeof run>) => {
    assert.equal(result.status, 0, `replay ${label}\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
  };
  const sourcePath = join(root, ".cotal", "nats");
  const seeded = ["first seeded message", "second seeded message", "third seeded message"];
  try {
    must("up", run("up", "--detach", "--server", server, "--space", space));
    must("seed registry", run("channels", "set", "seeded", "--desc", "survives the replay", "--space", space));
    must("seed TASK durable", spawnSync(tsx, [taskSeedPath, root, server, space, "reviewer"], {
      cwd: join(worktree, "implementations", "cli"), env, encoding: "utf8", timeout: 30_000,
    }));
    const auth = loadSoleSpaceAuth(authDir(root));
    assert.ok(auth, "authenticated scenario has SpaceAuth");
    // Real messages on a message-class stream: without them the post-replay count comparison below
    // would be a vacuous 0 === 0 and could not witness a duplicated restore.
    const senderPath = join(root, "sender.creds");
    writeFileSync(senderPath, await mintCreds(auth, newIdentity(), "agent", {
      allowPublish: ["seeded"], allowSubscribe: ["seeded"],
    }), { mode: 0o600 });
    for (const text of seeded)
      must(`seed chat ${JSON.stringify(text)}`, run("send", "msg", "seeded", text, "--space", space, "--server", server, "--creds", senderPath));

    must("preserve cut", run("down", "--preserve-state"));
    must("full backup", run("backup", "create", artifact));
    const manifest = assertValidManifest(artifact, space, "full");
    const chat = manifest.streams.find((stream) => stream.stream === chatStream(space));
    assert.ok(chat, "full artifact records the chat stream");
    assert.equal(chat.state.messages, seeded.length, "the artifact records the seeded chat messages");

    const wanted = spaceBackupInventory(space).full;
    const last = wanted[wanted.length - 1]!;
    const sourceBefore = lstatSync(sourcePath, { bigint: true });
    for (const fault of RESTORE_FAULTS) {
      const failed = spawnSync(
        tsx,
        [cliPath, "up", "--restore", artifact, "--detach", "--server", server, "--space", space],
        { cwd: root, env: { ...env, COTAL_SMOKE_FAIL_RESTORE_STREAM: fault.spec(last) }, encoding: "utf8", timeout: 240_000 },
      );
      assert.notEqual(failed.status, 0, `${fault.label}: the injected timeout must fail the restore\nstdout:\n${failed.stdout}`);
      // The reported pass is asserted, not assumed: a spec that silently fell through to the other
      // pass would still fail the restore and satisfy every rollback check below, quietly proving
      // nothing about the pass this case exists to cover.
      assert.match(
        failed.stderr,
        new RegExp(`smoke-injected exact-ID chunk handoff timeout for ${last.replaceAll(".", "\\.")} \\(${fault.pass}\\)`),
        `${fault.label}: the timeout fires on the ${fault.pass} pass`,
      );
      assert.equal(journalState(root), "ready", `${fault.label}: the timed-out attempt returns the maintenance journal to ready`);
      assert.deepEqual(attemptResidue(root), [], `${fault.label}: leaves no staging, quarantine, sanitized, or broker residue`);
      // Same-path restore moves the preserved source aside before instantiating the target. A whole-
      // attempt rollback must put that EXACT store back: on the target pass the target already holds
      // the earlier restored streams, so an identity match here is what proves the populated target
      // was discarded rather than adopted.
      const sourceAfter = lstatSync(sourcePath, { bigint: true });
      assert.equal(sourceAfter.dev, sourceBefore.dev, `${fault.label}: the preserved source is back at its canonical path (device)`);
      assert.equal(sourceAfter.ino, sourceBefore.ino, `${fault.label}: the preserved source is back at its canonical path (inode)`);
      assert.deepEqual(
        readdirSync(join(root, ".cotal")).filter((name) => name.startsWith(".cotal-restore-fallback-")),
        [],
        `${fault.label}: the rollback retires its same-path fallback`,
      );
    }

    must("replay the whole attempt", run("up", "--restore", artifact, "--detach", "--server", server, "--space", space));
    const active = JSON.parse(readFileSync(join(root, ".cotal", "maintenance", "v1", "journal.json"), "utf8")) as {
      state: string;
      restore: { attemptId: string };
    };
    assert.equal(active.state, "active", "the replayed attempt commits to active");
    const listed = run("channels", "list", "--space", space);
    must("list replayed registry", listed);
    assert.match(listed.stdout, /#seeded/, "the replayed restore lists the seeded channel");

    // Re-cut the replayed mesh and re-snapshot it: a second artifact records the restored stream
    // state through the product's own snapshot authority, so message counts can be compared to the
    // artifact the replay was built from. A replay that installed over its own residue, or applied
    // a snapshot twice, shows up here as inflated counts.
    must("retire the replay fallback", run("clean", "restore-fallback", "--attempt", active.restore.attemptId, "--force"));
    must("re-cut the replayed mesh", run("down", "--preserve-state"));
    const verification = join(root, "verification-backup");
    must("verification backup", run("backup", "create", verification));
    const replayed = assertValidManifest(verification, space, "full");
    for (const stream of spaceBackupInventory(space).backedUp.filter((entry) => entry.class === "messages")) {
      const before = manifest.streams.find((entry) => entry.stream === stream.name);
      const after = replayed.streams.find((entry) => entry.stream === stream.name);
      assert.ok(before && after, `both artifacts record ${stream.name}`);
      assert.equal(after.state.messages, before.state.messages, `${stream.name} replays with no duplicate messages`);
    }
  } finally {
    run("down");
    rmSync(root, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  }
}

await backupStageFaultScenario();
await restoreExactIdTimeoutReplayScenario();
console.log("backup faults live smoke: ok");
