/** Live fault injection at every backup stage, and whole-attempt restore replay after an exact-ID
 *  chunk-handoff timeout. Both halves assert the same contract from opposite ends: a failed attempt
 *  publishes nothing, keeps nothing, and leaves the cut retryable at the SAME destination. A restore
 *  or create interrupted by Ctrl-C inside its claim names its recovery, which works once its
 *  processes are gone, before the claim deadline. A create into a missing folder and a restore of a
 *  missing path refuse TARGET_NOT_FOUND before any lock, and so are a destination inside the store
 *  and one in a folder this account cannot write. A `--store-dir` that is not the cut's store
 *  refuses CONFLICT naming both. */
import assert from "node:assert/strict";
import { spawn, spawnSync, type SpawnSyncReturns } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  chatStream,
  spaceBackupInventory,
  type SpaceBackupSelection,
} from "@cotal-ai/core";
import { acquireMaintenanceLock, authDir, loadSoleSpaceAuth, releaseMaintenanceLock } from "@cotal-ai/workspace";
import { assertSmokeSandboxDown, freePort, recordSmokeSandbox } from "@cotal-ai/smoke-kit";
import { BACKUP_MANIFEST_FORMAT, type BackupManifest } from "../../implementations/cli/src/lib/backup-artifact.js";

const worktree = resolve(import.meta.dirname, "..", "..");
const cliPath = join(worktree, "bin", "cotal.ts");
const taskSeedPath = join(worktree, "implementations", "cli", "smoke", "seed-task-durable.ts");
const tsx = join(worktree, "node_modules", ".bin", "tsx");
const tsxImport = import.meta.resolve("tsx");
const sleep = (ms: number) => new Promise((resolveWait) => setTimeout(resolveWait, ms));

/** Every `cotal backup create` stage the product can be told to throw at, with the message each
 *  injection reports. The list IS the assertion that no stage is silently unhooked. */
const BACKUP_STAGES = {
  initiation: /smoke-injected failure at snapshot initiation/,
  chunk: /smoke-injected failure at the first snapshot chunk/,
  close: /smoke-injected failure after snapshot close/,
  manifest: /smoke-injected failure before manifest publication/,
  // A full disk names its cause and directory, what was and was not written, and a retry.
  nospace: /ran out of disk space \(ENOSPC\) writing the backup in [^\n]*artifact-nospace; it removed the partial backup and published none, and the preserved cut is still ready/,
} as const;

const journalState = (root: string): string | undefined => {
  const path = join(root, ".cotal", "maintenance", "v1", "journal.json");
  if (!existsSync(path)) return undefined;
  return (JSON.parse(readFileSync(path, "utf8")) as { state: string }).state;
};

interface ClaimedJournal {
  state: string;
  restore?: { attemptId: string };
  listenerProof?: unknown;
  claim?: { attemptId?: string; deadline: string; owners: unknown[]; coordinator: { startedAt: string } };
}

const readJournal = (root: string): ClaimedJournal | undefined => {
  try { return JSON.parse(readFileSync(join(root, ".cotal", "maintenance", "v1", "journal.json"), "utf8")) as ClaimedJournal; }
  catch { return undefined; }
};

/** Status must offer the held attempt's recovery, not a start that the same claim refuses. */
function assertRecoveryNext(run: (...args: string[]) => ReturnType<typeof spawnSync>, recover: string): void {
  for (const flags of [[], ["--plain"], ["--json"]]) {
    const result = run("status", ...flags);
    assert.equal(result.status, 0, `status reads the held attempt\n${result.stdout}${result.stderr}`);
    const output = String(result.stdout);
    if (flags.includes("--json")) {
      const envelope = JSON.parse(output) as { result: { hints: string[]; maintenance: { next: string } } };
      assert.ok(envelope.result.hints[0]?.includes(recover), "JSON hints lead with recovery");
      assert.ok(envelope.result.hints.includes(envelope.result.maintenance.next), "JSON uses the journal's next step");
      assert.doesNotMatch(envelope.result.hints.join("\n"), /`cotal up\b/, "JSON offers no refused restart");
    } else {
      const next = output.split("\nNext\n")[1] ?? "";
      assert.ok(next.trimStart().split("\n")[0]?.includes(recover), `Next leads with recovery\n${output}`);
      assert.doesNotMatch(next, /cotal (?:up|setup|spawn|ps)\b/, "Next offers no ordinary actions while the claim holds");
    }
  }
}

/** Freeze `pid` with SIGSTOP once `claimed(journal)` holds while it holds no maintenance lock. A
 *  freeze that lands inside a locked step is thawed and tried again, so the commands run against
 *  the frozen attempt meet its claim rather than its lock. */
async function freezeUnlocked(root: string, pid: number, claimed: (journal: ClaimedJournal) => boolean): Promise<ClaimedJournal> {
  const lock = join(root, ".cotal", "maintenance", "lock.json");
  for (const until = Date.now() + 120_000; Date.now() < until; await sleep(10)) {
    const journal = readJournal(root);
    if (!journal || !claimed(journal) || existsSync(lock)) continue;
    process.kill(pid, "SIGSTOP");
    if (!existsSync(lock)) return readJournal(root)!;
    process.kill(pid, "SIGCONT");
  }
  throw new Error("the attempt never reached an unlocked claimed moment");
}

const attemptResidue = (root: string): string[] => {
  const attempts = join(root, ".cotal", "maintenance", "attempts");
  return existsSync(attempts) ? readdirSync(attempts) : [];
};

function assertAttemptsDestinationRefusal(root: string, run: (...args: string[]) => SpawnSyncReturns<string>): void {
  const attempts = join(root, ".cotal", "maintenance", "attempts");
  mkdirSync(attempts, { mode: 0o700, recursive: true });
  const destination = join(attempts, "forbidden");
  const journal = join(root, ".cotal", "maintenance", "v1", "journal.json");
  const journalBefore = readFileSync(journal);
  const attemptsBefore = attemptResidue(root).sort();
  const message = `the backup destination ${destination} overlaps the maintenance attempt directory ${attempts}. No backup was created.`;
  const remedy = `name a destination outside ${attempts}`;
  const plain = run("backup", "create", ".cotal/maintenance/attempts/forbidden", "--plain");
  assert.equal(plain.status, 1, plain.stderr);
  assert.match(plain.stderr, /Code:\s+USAGE_INVALID/);
  assert.ok(plain.stderr.includes(message) && plain.stderr.includes(remedy), plain.stderr);
  assert.doesNotMatch(plain.stderr, /LIFECYCLE_BLOCKED|before recovery|Usage:/);
  const json = run("backup", "create", destination, "--json");
  assert.equal(json.status, 1, `${json.stdout}${json.stderr}`);
  const envelope = JSON.parse(json.stdout);
  assert.equal(envelope.outcome, "refused");
  assert.equal(envelope.error.code, "USAGE_INVALID");
  assert.equal(envelope.error.message, message);
  assert.equal(envelope.error.remedy, remedy);
  assert.deepEqual(envelope.target, { directory: destination, attemptId: null, priorClaimAttemptId: null });
  const nested = join(attempts, "missing-parent", "backup");
  const missing = run("backup", "create", nested, "--json");
  const refusal = JSON.parse(missing.stdout);
  assert.equal(missing.status, 1);
  assert.equal(refusal.error.code, "USAGE_INVALID");
  assert.equal(refusal.error.remedy, remedy);
  assert.deepEqual(refusal.target, { directory: nested, attemptId: null, priorClaimAttemptId: null });
  assert.equal(existsSync(join(attempts, "missing-parent")), false);
  assert.deepEqual(readFileSync(journal), journalBefore);
  assert.deepEqual(attemptResidue(root).sort(), attemptsBefore);
  assert.equal(existsSync(destination), false);
  assert.equal(existsSync(join(root, ".cotal", "maintenance", "lock.json")), false);
}

function assertReservedMaintenanceDestinationRefusal(root: string, run: (...args: string[]) => SpawnSyncReturns<string>): void {
  const maintenance = join(root, ".cotal", "maintenance");
  const journalDir = join(maintenance, "v1");
  const lock = join(maintenance, "lock.json");
  const reaper = join(maintenance, "lock-reaper.json");
  const journal = join(journalDir, "journal.json");
  const journalBefore = readFileSync(journal);
  const attemptsBefore = attemptResidue(root).sort();
  const cases = [
    [".cotal/maintenance/v1/private-artifact", `is inside this root's maintenance journal directory ${journalDir}`, journalDir],
    [".cotal/maintenance/lock.json", "is this root's maintenance lock path", lock],
    [".cotal/maintenance/lock.json/nested", `is inside this root's maintenance lock path ${lock}`, lock],
    [".cotal/maintenance/lock-reaper.json", "is this root's maintenance lock recovery path", reaper],
  ] as const;
  for (const [relativePath, relation, reserved] of cases) {
    const destination = resolve(root, relativePath);
    const message = `the backup destination ${destination} ${relation}; nothing was written`;
    const remedy = `name a destination outside ${reserved}`;
    const plain = run("backup", "create", relativePath, "--only", "registry", "--plain");
    assert.equal(plain.status, 1, plain.stderr);
    assert.match(plain.stderr, /Code:\s+USAGE_INVALID/);
    assert.ok(plain.stderr.includes(message) && plain.stderr.includes(remedy), plain.stderr);
    const json = run("backup", "create", relativePath, "--json");
    assert.equal(json.status, 1, `${json.stdout}${json.stderr}`);
    const envelope = JSON.parse(json.stdout);
    assert.equal(envelope.outcome, "refused");
    assert.equal(envelope.error.code, "USAGE_INVALID");
    assert.equal(envelope.error.message, message);
    assert.equal(envelope.error.remedy, remedy);
    assert.deepEqual(envelope.target, { directory: destination, overlaps: reserved });
    assert.equal(existsSync(destination), false);
  }
  assert.deepEqual(readFileSync(journal), journalBefore);
  assert.deepEqual(attemptResidue(root).sort(), attemptsBefore);
  assert.equal(existsSync(lock), false);
  assert.equal(existsSync(reaper), false);
}

function assertMissingCleanupDestinationRefusal(root: string, run: (...args: string[]) => SpawnSyncReturns<string>): void {
  const auth = join(root, ".cotal", "auth");
  const journal = join(root, ".cotal", "maintenance", "v1", "journal.json");
  const journalBefore = readFileSync(journal);
  const attemptsBefore = attemptResidue(root).sort();
  const controlLink = join(root, "control-link");
  assert.equal(existsSync(auth), false, "the unprepared open space has no auth folder");
  symlinkSync(join(root, ".cotal"), controlLink, "junction");
  for (const [path, flag] of [[".cotal/auth/new", "--plain"], [join(controlLink, "auth", "nested", "new"), "--json"]] as const) {
    const result = run("backup", "create", path, flag);
    const output = result.stdout + result.stderr;
    assert.equal(result.status, 1, output);
    const remedy = `name a destination outside ${auth}`;
    if (flag === "--json") {
      const envelope = JSON.parse(result.stdout);
      assert.equal(envelope.error.code, "USAGE_INVALID");
      assert.equal(envelope.error.remedy, remedy);
      assert.deepEqual(envelope.target, { directory: path, removedBy: auth });
    } else {
      assert.match(output, /Code:\s+USAGE_INVALID/);
      assert.ok(output.includes(remedy), output);
    }
    assert.doesNotMatch(output, /create that folder first/);
  }
  assert.equal(existsSync(auth), false);
  assert.deepEqual(readFileSync(journal), journalBefore);
  assert.deepEqual(attemptResidue(root).sort(), attemptsBefore);
  assert.equal(existsSync(join(root, ".cotal", "maintenance", "lock.json")), false);
}

function assertBackupUsage(run: (...args: string[]) => SpawnSyncReturns<string>): void {
  const restore = run("backup", "restore", "--help");
  const refused = run("backup", "restore", "sample-backup", "--only", "full");
  assert.equal(restore.status, 0, restore.stderr);
  assert.equal(refused.status, 1, refused.stderr);
  assert.match(refused.stderr, /backup restore accepts only --only registry/);
  for (const help of [restore.stdout, refused.stderr]) {
    assert.match(help, /^\s+--only <selection>\s+/m);
    assert.match(help.replace(/\s+/g, " "), /Restore takes only registry and follows the artifact's selection if omitted/);
    assert.doesNotMatch(help, /<full\|registry>/);
  }
  const create = run("backup", "create", "--help");
  assert.equal(create.status, 0, create.stderr);
  assert.match(create.stdout, /\[--only full\|registry\]/);
  assert.match(create.stdout.replace(/\s+/g, " "), /create takes full \(default\) or registry/);

  const attempt = "restore-00000000-0000-4000-8000-000000000000";
  const cleanup = run("backup", "cleanup-fallback", attempt, "--store-dir", ".cotal/nats", "--yes", "--plain");
  assert.equal(cleanup.status, 1, cleanup.stderr);
  assert.match(cleanup.stderr, /backup cleanup-fallback does not accept --store-dir\. The full attempt ID alone selects its recorded fallback/);
  assert.match(cleanup.stderr, /Code:\s+USAGE_INVALID/);
  const recover = run("backup", "recover", attempt, "--discard-history", "--yes", "--plain");
  assert.equal(recover.status, 1, recover.stderr);
  assert.match(recover.stderr, /backup recover does not accept --discard-history/);
  assert.match(recover.stderr, /Code:\s+USAGE_INVALID/);
}

function assertArtifactSearchRefusal(root: string, folder: string, artifact: string, run: (...args: string[]) => SpawnSyncReturns<string>): void {
  const journal = join(root, ".cotal", "maintenance", "v1", "journal.json");
  const before = readFileSync(journal, "utf8");
  const attempts = attemptResidue(root).sort();
  chmodSync(folder, 0o600);
  try {
    for (const verb of ["inspect", "verify", "restore"]) {
      const denied = run("backup", verb, artifact, "--plain");
      assert.equal(denied.status, 2, denied.stderr);
      assert.match(denied.stderr, /Code:\s+PERMISSION_DENIED/);
      assert.ok(denied.stderr.includes(artifact) && denied.stderr.includes(`chmod u+x '${folder}'`), denied.stderr);
      assert.doesNotMatch(denied.stderr, /Outcome unconfirmed|cotal status/);
    }
    assert.equal(readFileSync(journal, "utf8"), before, "the refusal leaves the cut unchanged");
    assert.deepEqual(attemptResidue(root).sort(), attempts, "the refusal starts no restore attempt");
  } finally {
    chmodSync(folder, 0o700);
  }
}

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
  const configDir = join(home, "xdg");
  const sandbox = recordSmokeSandbox({ root, cotalHome: home, xdgConfigHome: configDir });
  const port = await freePort();
  const server = `nats://127.0.0.1:${port}`;
  const space = "backup_faults_stages";
  const env: NodeJS.ProcessEnv = { ...process.env, COTAL_HOME: home, XDG_CONFIG_HOME: configDir, COTAL_SKIP_CONNECTOR_SEED: "1" };
  // Follow-on assign: `cotal send` refuses without a complete identity in this process.
  env.COTAL_NAME = "cli";
  env.COTAL_ID = "cli_send";
  const run = (...args: string[]) => {
    const options = { cwd: root, env, encoding: "utf8" as const, timeout: 240_000 };
    assertSmokeSandboxDown(sandbox, args, options);
    return spawnSync(tsx, [cliPath, ...args], options);
  };
  const must = (label: string, result: ReturnType<typeof run>) => {
    assert.equal(result.status, 0, `stages ${label}\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
  };
  const sourcePath = join(root, ".cotal", "nats");
  try {
    assertBackupUsage(run);
    must("up", run("up", "--detach", "--open", "--server", server, "--space", space));
    must("seed registry", run("channel", "set", "preserved", "--desc", "survives every fault", "--space", space));
    must("preserve cut", run("down", "--preserve-state"));
    assert.equal(journalState(root), "ready");
    const sourceBefore = lstatSync(sourcePath, { bigint: true });

    if (process.getuid && process.getuid() !== 0) {
      const folder = join(root, "no search");
      const destination = join(folder, "archive");
      const journal = join(root, ".cotal", "maintenance", "v1", "journal.json");
      const before = readFileSync(journal, "utf8");
      mkdirSync(folder, { mode: 0o600 });
      const denied = run("backup", "create", destination, "--plain");
      assert.equal(denied.status, 2, denied.stderr);
      assert.match(denied.stderr, /Code:\s+PERMISSION_DENIED/);
      assert.ok(denied.stderr.includes(`cannot search ${folder}`), denied.stderr);
      assert.equal(readFileSync(journal, "utf8"), before, "the refusal leaves the cut unchanged");
      const command = /\nNext\n +make the path to that folder searchable with (`+)(chmod u\+x .+?)\1,/.exec(denied.stderr)?.[2];
      assert.ok(command, `Next shows a copyable chmod command\n${denied.stderr}`);
      must("apply the printed chmod", spawnSync("sh", ["-c", command], { cwd: root, env, encoding: "utf8", timeout: 10_000 }));
      assert.ok(!existsSync(destination), "the refusal writes no backup");
      must("create in the searchable folder", run("backup", "create", destination, "--only", "registry"));
      assertArtifactSearchRefusal(root, folder, destination, run);
      must("inspect the backup once search access is restored", run("backup", "inspect", destination));
      must("verify the backup in the searchable folder", run("backup", "verify", destination));
      console.log("backup destination search permission: ok");
    }

    // A path that names nothing is refused before any lock, saying whether its folder or the
    // artifact is missing.
    const nowhere = join(root, "no-such-folder", "artifact");
    const createMissing = run("backup", "create", nowhere, "--json");
    assert.equal(createMissing.status, 2, `a create into a missing folder refuses, exit 2\n${createMissing.stdout}${createMissing.stderr}`);
    const created = JSON.parse(createMissing.stdout) as { error?: { code?: string; message?: string }; target?: { missing?: string } };
    assert.equal(created.error?.code, "TARGET_NOT_FOUND", "a create into a missing folder is TARGET_NOT_FOUND");
    assert.equal(created.target?.missing, "folder", "it says the folder is missing");
    assert.match(created.error?.message ?? "", /there is no folder \S*no-such-folder to create the backup in/, "it names that folder");
    assertMissingCleanupDestinationRefusal(root, run);
    if (process.platform !== "win32") {
      const notFolder = join(root, "parent-file"), loop = join(root, "loop-a");
      writeFileSync(notFolder, "owned fixture");
      symlinkSync("loop-b", loop);
      symlinkSync("loop-a", join(root, "loop-b"));
      const journal = join(root, ".cotal", "maintenance", "v1", "journal.json");
      const prior = createHash("sha256").update(readFileSync(journal)).digest("hex");
      const dangling = join(root, "dangling-parent");
      symlinkSync("missing-storage", dangling);
      for (const destination of [join(dangling, "backup"), join(dangling, "nested", "backup")]) {
        const refused = run("backup", "create", destination, "--json");
        const reply = JSON.parse(refused.stdout);
        assert.equal(refused.status, 2);
        assert.equal(reply.error.code, "TARGET_NOT_FOUND");
        assert.equal(reply.target.link, dangling);
        assert.match(reply.error.remedy, /repair the linked folder/);
        assert.equal(createHash("sha256").update(readFileSync(journal)).digest("hex"), prior);
      }
      for (const [destination, code] of [[join(notFolder, "backup"), "ENOTDIR"], [join(loop, "backup"), "ELOOP"]] as const) {
        const refused = run("backup", "create", destination, "--json");
        const reply = JSON.parse(refused.stdout) as { error?: { code?: string; message?: string; cause?: { code?: string } }; target?: { directory?: string; folder?: string } };
        assert.ok(refused.status === 1 && reply.error?.code === "USAGE_INVALID" && reply.error.cause?.code === code && reply.target?.directory === destination, `an invalid destination traversal names ${code}, not the preserved cut\n${refused.stdout}${refused.stderr}`);
        assert.equal(createHash("sha256").update(readFileSync(journal)).digest("hex"), prior, "an invalid destination leaves the preservation journal unchanged");
      }
      const plain = run("backup", "create", join(notFolder, "backup"));
      assert.ok(plain.status === 1 && plain.stderr.includes("ENOTDIR") && !plain.stderr.includes("Usage"), `the path refusal prints no command help\n${plain.stderr}`);

      symlinkSync("self-loop", join(root, "self-loop"));
      const beforeAttempts = attemptResidue(root).sort();
      for (const path of [join(root, "self-loop", "backup"), join(loop, "backup")]) {
        for (const command of [["backup", "inspect", path], ["backup", "verify", path], ["backup", "restore", path], ["up", "--restore", path, "--detach"]]) {
          const refused = run(...command, "--plain");
          const output = refused.stdout + refused.stderr;
          assert.equal(refused.status, 1, `${command.join(" ")} refuses the loop\n${output}`);
          assert.match(output, /Code:\s+USAGE_INVALID/);
          assert.ok(output.includes(path) && output.includes("symbolic-link loop (ELOOP)") && output.includes("fix the symbolic link"), output);
          assert.doesNotMatch(output, /Outcome unconfirmed|cotal status/);
        }
      }
      assert.equal(createHash("sha256").update(readFileSync(journal)).digest("hex"), prior, "looped artifact paths leave the preservation journal unchanged");
      assert.deepEqual(attemptResidue(root).sort(), beforeAttempts, "looped artifact paths leave no restore attempt");
    }
    for (const [path, missing] of [[nowhere, "folder"], [join(root, "no-such-artifact"), "artifact"]] as const) {
      const restore = run("backup", "restore", path, "--json");
      assert.equal(restore.status, 2, `a restore of a missing ${missing} refuses, exit 2\n${restore.stdout}${restore.stderr}`);
      const restored = JSON.parse(restore.stdout) as { error?: { code?: string }; target?: { directory?: string; missing?: string } };
      assert.equal(restored.error?.code, "TARGET_NOT_FOUND", `a restore of a missing ${missing} is TARGET_NOT_FOUND`);
      assert.equal(restored.target?.missing, missing, `it says the ${missing} is missing`);
      assert.equal(restored.target?.directory, path, "it names the path");
    }
    // A file, an empty folder, a folder no create wrote and a folder that holds the preserved store are
    // refused before any lock, naming the path and what it is.
    const notArtifacts = join(root, "not-artifacts");
    mkdirSync(join(notArtifacts, "empty"), { recursive: true });
    mkdirSync(join(notArtifacts, "notes"));
    writeFileSync(join(notArtifacts, "notes", "notes.txt"), "x");
    writeFileSync(join(notArtifacts, "file.txt"), "x");
    const journalBytes = readFileSync(join(root, ".cotal", "maintenance", "v1", "journal.json"), "utf8");
    for (const [path, status, code, text] of [
      [join(notArtifacts, "file.txt"), 2, "TARGET_NOT_FOUND", `${realpathSync(join(notArtifacts, "file.txt"))} is not a backup artifact: it is a file; nothing was restored`],
      [join(notArtifacts, "empty"), 2, "TARGET_NOT_FOUND", `${realpathSync(join(notArtifacts, "empty"))} is not a backup artifact: it is an empty folder; nothing was restored`],
      [join(notArtifacts, "notes"), 2, "TARGET_NOT_FOUND", `${realpathSync(join(notArtifacts, "notes"))} is not a backup artifact: it holds no manifest.json and no file a backup create writes; nothing was restored`],
      [".", 1, "USAGE_INVALID", `the restore artifact ${realpathSync(root)} holds the preserved store ${realpathSync(sourcePath)} it would replace; nothing was restored`],
      [join(sourcePath, "jetstream"), 1, "USAGE_INVALID", `the restore artifact ${realpathSync(join(sourcePath, "jetstream"))} is inside the preserved store ${realpathSync(sourcePath)} it would replace; nothing was restored`],
    ] as const) {
      const restore = run("backup", "restore", path, "--json");
      const envelope = JSON.parse(restore.stdout) as { outcome?: string; error?: { code?: string; message?: string } };
      assert.ok(restore.status === status && envelope.outcome === "refused" && envelope.error?.code === code && envelope.error.message === text, `a restore of ${path} is refused ${code}, exit ${status}, saying what it is\n${restore.stdout}${restore.stderr}`);
      const plain = run("up", "--restore", path, "--detach");
      assert.ok(plain.status === status && plain.stderr.includes(text) && !plain.stderr.includes("Outcome unconfirmed") && !plain.stderr.includes("Usage"), `up --restore ${path} is refused the same way, with no command help\n${plain.stderr}`);
    }
    assert.equal(readFileSync(join(root, ".cotal", "maintenance", "v1", "journal.json"), "utf8"), journalBytes, "those refusals leave the journal as it was");
    // A destination inside the preserved store, or in a folder this account cannot write, is refused
    // before any lock with its cause in the message.
    const inside = run("backup", "create", join(sourcePath, "bk1"), "--json");
    const insideEnvelope = JSON.parse(inside.stdout) as { error?: { code?: string; message?: string } };
    assert.ok(inside.status === 1 && insideEnvelope.error?.code === "USAGE_INVALID" && (insideEnvelope.error.message ?? "").includes(`is inside the preserved store ${sourcePath}`), `a destination inside the store is a usage refusal\n${inside.stdout}${inside.stderr}`);
    const insidePlain = run("backup", "create", join(sourcePath, "bk1"));
    assert.ok(insidePlain.status === 1 && !insidePlain.stderr.includes("Usage"), `that refusal prints no command help\n${insidePlain.stderr}`);
    assertAttemptsDestinationRefusal(root, run);
    assertReservedMaintenanceDestinationRefusal(root, run);
    // So is one inside the space's material folder, which `clean all` removes with whatever it
    // holds, named directly or through a link outside `.cotal`.
    const material = readdirSync(join(root, ".cotal")).find((entry) => entry.startsWith("space."));
    assert.ok(material, "the open space keeps its material folder under .cotal");
    symlinkSync(join(root, ".cotal", material), join(root, "material-link"));
    for (const destination of [join(root, ".cotal", material, "bk"), join(root, "material-link", "bk2")]) {
      const cleaned = run("backup", "create", destination, "--json");
      const cleanedEnvelope = JSON.parse(cleaned.stdout) as { error?: { code?: string; message?: string } };
      assert.ok(cleaned.status === 1 && cleanedEnvelope.error?.code === "USAGE_INVALID" && (cleanedEnvelope.error.message ?? "").includes(`is inside ${join(root, ".cotal", material)}, which \`cotal clean all\` removes`), `a destination ${destination} that clean all removes is a usage refusal\n${cleaned.stdout}${cleaned.stderr}`);
      assert.ok(!existsSync(join(root, ".cotal", material, "bk")) && !existsSync(join(root, ".cotal", material, "bk2")), `that refusal writes nothing in ${material}`);
    }
    rmSync(join(root, "material-link"));
    if (process.getuid && process.getuid() !== 0) {
      const journal = join(root, ".cotal", "maintenance", "v1", "journal.json");
      for (const [folder, flags] of [["read only", []], ["operator's `archive` …", ["--plain"]]] as const) {
        const locked = join(root, folder);
        const destination = join(locked, "archive");
        mkdirSync(locked, { mode: 0o500 });
        const before = readFileSync(journal, "utf8");
        const denied = run("backup", "create", destination, ...flags);
        assert.equal(denied.status, 2, denied.stderr);
        assert.match(denied.stderr, /PERMISSION_DENIED/);
        assert.ok(denied.stderr.includes(`cannot write ${join(root, folder.replace("…", "..."))}`), "the refusal names the folder");
        assert.ok(!existsSync(destination), "the refusal writes no backup");
        assert.equal(readFileSync(journal, "utf8"), before, "the refusal leaves the cut unchanged");
        const command = /\nNext\n +make that folder writable with (`+)(chmod u\+w .+?)\1,/.exec(denied.stderr)?.[2];
        assert.ok(command, `Next shows a copyable chmod command\n${denied.stderr}`);
        must("apply the printed chmod", spawnSync("sh", ["-c", command], { cwd: root, env, encoding: "utf8", timeout: 10_000 }));
        assert.equal(lstatSync(locked).mode & 0o777, 0o700, "chmod changed the named folder");
        must("create in the repaired folder", run("backup", "create", destination));
        must("verify the backup in the repaired folder", run("backup", "verify", destination));
      }
      const invisible = join(root, "read\u200donly");
      mkdirSync(invisible, { mode: 0o500 });
      const denied = run("backup", "create", join(invisible, "archive"), "--plain");
      assert.equal(denied.status, 2, denied.stderr);
      assert.match(denied.stderr, /make that folder writable, or name a destination/);
    }
    // A --store-dir that is not the cut's store is a conflict naming both stores.
    const emptyStore = join(root, "empty-store");
    mkdirSync(emptyStore);
    const mismatched = run("backup", "create", join(root, "bkw"), "--store-dir", emptyStore, "--json");
    const mismatchedEnvelope = JSON.parse(mismatched.stdout) as { error?: { code?: string; message?: string } };
    assert.ok(mismatched.status === 2 && mismatchedEnvelope.error?.code === "CONFLICT" && (mismatchedEnvelope.error.message ?? "").includes(`--store-dir ${emptyStore} is not this cut's preserved store ${sourcePath}`), `a mismatched --store-dir is a conflict naming both stores\n${mismatched.stdout}${mismatched.stderr}`);
    assert.equal(journalState(root), "ready", "the refused create and restores leave the cut ready");
    assert.deepEqual(attemptResidue(root), [], "the refused create and restores leave nothing in the attempts dir");

    for (const [stage, injected] of Object.entries(BACKUP_STAGES)) {
      const noSpace = stage === "nospace";
      const destination = join(root, noSpace ? "disk`full\u2026 artifact-nospace" : `artifact-${stage}`);
      const faulted = spawnSync(tsx, [cliPath, "backup", "create", destination, ...(noSpace ? ["--plain"] : [])], {
        cwd: root,
        env: { ...env, COTAL_SMOKE_FAIL_BACKUP_STAGE: stage },
        encoding: "utf8",
        timeout: 240_000,
      });
      assert.notEqual(faulted.status, 0, `${stage} fault must fail the backup\nstdout:\n${faulted.stdout}`);
      assert.match(faulted.stderr, injected, `${stage} fault reports its injected failure`);
      if (!noSpace) {
        assert.match(faulted.stderr, new RegExp(`then run \`(?:pnpm )?cotal backup create \\S*artifact-${stage}\` again`), `${stage} fault names the same create as its next step`);
        assert.match(faulted.stderr, /the preserved cut is still ready; fix the cause in the native detail/, `${stage} fault says the cut is still ready`);
      }
      assert.equal(journalState(root), "ready", `${stage} fault returns the maintenance journal to ready`);
      assert.equal(existsSync(destination), false, `${stage} fault leaves no unpublished artifact at the destination`);
      assert.deepEqual(attemptResidue(root), [], `${stage} fault leaves no clone, config, or broker residue in the attempts dir`);
      const sourceAfter = lstatSync(sourcePath, { bigint: true });
      assert.equal(sourceAfter.dev, sourceBefore.dev, `${stage} fault leaves the preserved source device unchanged`);
      assert.equal(sourceAfter.ino, sourceBefore.ino, `${stage} fault leaves the preserved source inode unchanged`);

      if (noSpace) {
        assert.equal(faulted.status, 5, `disk-full failure exits 5\n${faulted.stderr}`);
        const next = faulted.stderr.split("\nNext\n")[1] ?? "";
        const retry = /then run (`{2,})((?:pnpm )?cotal backup create .+?)\1 again/.exec(next)?.[2];
        assert.ok(retry, `Next gives a copyable retry after freeing space\n${faulted.stderr}`);
        must("paste the disk-full retry", spawnSync("sh", ["-c", `cotal() { "$COTAL_TEST_TSX" "$COTAL_TEST_CLI" "$@"; }; pnpm() { "$@"; }\n${retry}`], {
          cwd: root, env: { ...env, COTAL_TEST_TSX: tsx, COTAL_TEST_CLI: cliPath }, encoding: "utf8", timeout: 240_000,
        }));
        must("verify at the original disk-full destination", run("backup", "verify", destination));
        assert.match(next, /free space on that disk/);
      } else {
        must(`${stage} retry at the same destination`, run("backup", "create", destination));
      }
      assertValidManifest(destination, space, "full");
      assert.equal(journalState(root), "ready", `${stage} retry leaves the cut ready`);
      assert.deepEqual(attemptResidue(root), [], `${stage} retry leaves no attempt residue`);
    }
    must("ordinary resume after every fault", run("up", "--detach", "--open", "--server", server, "--space", space));
    const listed = run("channel", "--space", space);
    must("list registry after every fault", listed);
    assert.match(listed.stdout, /#preserved/, "the faulted attempts never touched the preserved registry");
    must("down", run("down", "--yes"));
  } finally {
    run("down", "--yes");
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
  const configDir = join(home, "xdg");
  const sandbox = recordSmokeSandbox({ root, cotalHome: home, xdgConfigHome: configDir });
  const artifact = join(root, "full-backup");
  const port = await freePort();
  const server = `nats://127.0.0.1:${port}`;
  const space = "backup_faults_replay";
  const env: NodeJS.ProcessEnv = { ...process.env, COTAL_HOME: home, XDG_CONFIG_HOME: configDir, COTAL_SKIP_CONNECTOR_SEED: "1" };
  // Follow-on assign: `cotal send` refuses without a complete identity in this process.
  env.COTAL_NAME = "cli";
  env.COTAL_ID = "cli_send";
  const run = (...args: string[]) => {
    const options = { cwd: root, env, encoding: "utf8" as const, timeout: 240_000 };
    assertSmokeSandboxDown(sandbox, args, options);
    return spawnSync(tsx, [cliPath, ...args], options);
  };
  const must = (label: string, result: ReturnType<typeof run>) => {
    assert.equal(result.status, 0, `replay ${label}\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
  };
  const sourcePath = join(root, ".cotal", "nats");
  const seeded = ["first seeded message", "second seeded message", "third seeded message"];
  try {
    must("up", run("up", "--detach", "--server", server, "--space", space));
    must("seed registry", run("channel", "set", "seeded", "--desc", "survives the replay", "--space", space));
    must("seed TASK durable", spawnSync(tsx, [taskSeedPath, root, server, space, "reviewer"], {
      cwd: join(worktree, "implementations", "cli"), env, encoding: "utf8", timeout: 30_000,
    }));
    const auth = loadSoleSpaceAuth(authDir(root));
    assert.ok(auth, "authenticated scenario has SpaceAuth");
    // Real messages on a message-class stream: without them the post-replay count comparison below
    // would be a vacuous 0 === 0 and could not witness a duplicated restore. A one-shot send runs
    // on the credential this root records; an agent `--creds` file may not read the roster it needs.
    for (const text of seeded)
      must(`seed chat ${JSON.stringify(text)}`, run("send", "--channel", "seeded", text, "--space", space));

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
    const listed = run("channel", "--space", space);
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
    run("down", "--yes");
    rmSync(root, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  }
}

/** Ctrl-C inside a restore's claimed window. While the restore process lives, `backup restore`,
 *  `up` and `backup recover` refuse naming it and the claim deadline. Interrupted, it exits 130 and
 *  names its recovery, which works as soon as its brokers are gone, not after the deadline. */
async function interruptedRestoreScenario(): Promise<void> {
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), "cotal-backup-faults-int-restore-root-")));
  const home = realpathSync.native(mkdtempSync(join(tmpdir(), "cotal-backup-faults-int-restore-home-")));
  // Its own .cotal, so the CLI resolves this root and never a stray .cotal in a parent folder.
  mkdirSync(join(root, ".cotal"), { mode: 0o700 });
  const configDir = join(home, "xdg");
  const sandbox = recordSmokeSandbox({ root, cotalHome: home, xdgConfigHome: configDir });
  const artifact = join(root, "full-backup");
  const port = await freePort();
  const server = `nats://127.0.0.1:${port}`;
  const space = "backup_faults_int_restore";
  const env: NodeJS.ProcessEnv = { ...process.env, COTAL_HOME: home, XDG_CONFIG_HOME: configDir, COTAL_SKIP_CONNECTOR_SEED: "1" };
  const run = (...args: string[]) => {
    const options = { cwd: root, env, encoding: "utf8" as const, timeout: 240_000 };
    assertSmokeSandboxDown(sandbox, args, options);
    return spawnSync(tsx, [cliPath, ...args], options);
  };
  const must = (label: string, result: ReturnType<typeof run>) => {
    assert.equal(result.status, 0, `interrupted restore ${label}\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
  };
  try {
    must("up", run("up", "--detach", "--open", "--server", server, "--space", space));
    assert.ok(existsSync(join(root, ".cotal", "nats")), "up resolved this root");
    must("preserve cut", run("down", "--preserve-state"));
    must("full backup", run("backup", "create", artifact));

    // A create that meets another operation's maintenance lock names that operation, its process and
    // since when it holds the lock, waits for it, and names no attempt, because it journaled none.
    const contender = acquireMaintenanceLock(root, { operation: "backup create" });
    try {
      const lost = run("backup", "create", join(root, "contended"), "--json");
      const envelope = JSON.parse(lost.stdout) as { target?: { attemptId?: unknown; holderPid?: unknown; holderOperation?: unknown }; error?: { code?: string; message?: string; remedy?: string } };
      assert.equal(lost.status, 2, `a create that meets the lock refuses\n${lost.stdout}${lost.stderr}`);
      assert.ok(envelope.error?.code === "LIFECYCLE_BLOCKED" && envelope.error.message === `backup create is refused: a backup create, process ${process.pid}, has held this root's maintenance lock since ${contender.owner.startedAt}; nothing was changed`
        && envelope.error.remedy?.startsWith(`wait for process ${process.pid} to finish, then run \`cotal backup create ${join(root, "contended")}\` again`)
        && envelope.target?.holderPid === process.pid && envelope.target.holderOperation === "backup create" && !("attemptId" in envelope.target), `the losing create names the lock holder\n${lost.stdout}`);
    } finally { releaseMaintenanceLock(contender); }

    // Its own process group, as a terminal runs it, so the SIGINT below is the one Ctrl-C sends.
    const child = spawn(process.execPath, ["--import", tsxImport, cliPath, "backup", "restore", artifact], { cwd: root, env, detached: true, stdio: ["ignore", "ignore", "pipe"] });
    let stderr = "";
    child.stderr!.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });
    const exited = new Promise<number | null>((resolveExit) => child.once("exit", (code) => resolveExit(code)));
    const held = await freezeUnlocked(root, child.pid!, (journal) => journal.state === "restore-ready" && (journal.claim?.owners.length ?? 0) > 0);
    const attemptId = held.restore!.attemptId, deadline = held.claim!.deadline;
    const recover = `cotal backup recover ${attemptId} --yes`;
    for (const [label, args] of [
      ["backup restore", ["backup", "restore", artifact]],
      ["up", ["up", "--detach", "--open", "--server", server, "--space", space]],
      ["backup recover", ["backup", "recover", attemptId, "--yes"]],
      ["backup create", ["backup", "create", join(root, "during-restore")]],
    ] as const) {
      const refused = run(...args);
      assert.equal(refused.status, 2, `${label} refuses while the restore process lives\n${refused.stderr}`);
      assert.match(refused.stderr, /LIFECYCLE_BLOCKED/, `${label} is a known refusal`);
      assert.ok(refused.stderr.includes(`holds this root until ${deadline}, and its restore process ${child.pid} is still running, started at ${held.claim!.coordinator.startedAt}`), `${label} names the restore process, its start and the deadline\n${refused.stderr}`);
      assert.doesNotMatch(refused.stderr, /roll the pre-commit attempt back/, `${label} does not tell the operator to roll a live restore back`);
      assert.ok(refused.stderr.includes(recover), `${label} names the recovery\n${refused.stderr}`);
    }

    process.kill(-child.pid!, "SIGINT");
    process.kill(child.pid!, "SIGCONT");
    assert.equal(await exited, 130, `the interrupted restore exits 130\n${stderr}`);
    assert.ok(stderr.includes(`Interrupted: restore attempt ${attemptId} stopped before it committed`) && stderr.includes(recover), `the interrupt names what it left and its recovery\n${stderr}`);
    assert.equal(journalState(root), "restore-ready", "the interrupted restore leaves its pre-commit claim");
    assertRecoveryNext(run, recover);
    const legacy = run("clean", "restore-fallback", "--attempt", attemptId, "--force");
    assert.equal(legacy.status, 2, legacy.stderr);
    assert.ok(legacy.stderr.includes(`restore attempt ${attemptId} is still pre-commit`) && legacy.stderr.includes(recover), legacy.stderr);
    assert.equal(journalState(root), "restore-ready", "fallback cleanup does not advance a pre-commit attempt");
    // The brokers' watchdog stops them once the restore process is gone; recovery waits for that only.
    let recovered = run("backup", "recover", attemptId, "--yes");
    for (let i = 0; i < 50 && recovered.status !== 0; i++) { await sleep(200); recovered = run("backup", "recover", attemptId, "--yes"); }
    must("recover the interrupted restore", recovered);
    assert.ok(/Next\s+cotal up\s+Resume the space from its preserved state\s+cotal backup restore <directory>\s+Try the restore again/.test(recovered.stdout), `the recovery receipt names resume and a retried restore as its next steps\n${recovered.stdout}`);
    assert.ok(Date.now() < Date.parse(deadline), "recovery ran before the claim deadline");
    assert.equal(journalState(root), "ready", "recovery returns the cut to ready");
    // Send a real SIGTERM after publishing commit intent. Node can dispatch it only after the
    // synchronous preparation returns, so it exercises the handoff without racing a journal poll.
    const signalAtCommit = join(root, "signal-at-commit.cjs");
    const journalPath = join(root, ".cotal", "maintenance", "v1", "journal.json");
    writeFileSync(signalAtCommit, `
      const fs = require("node:fs");
      const rename = fs.renameSync;
      fs.renameSync = (from, to) => {
        rename(from, to);
        if (to !== ${JSON.stringify(journalPath)}) return;
        const journal = JSON.parse(fs.readFileSync(to, "utf8"));
        if (journal.state === "commit-intent" && !journal.listenerProof) {
          process.kill(process.pid, "SIGTERM");
        }
      };
      require("node:module").syncBuiltinESMExports();
    `);
    const committed = spawnSync(process.execPath,
      ["--require", signalAtCommit, "--import", tsxImport, cliPath, "up", "--foreground", "--restore", artifact, "--store-dir", join(root, "new store")],
      { cwd: root, env, encoding: "utf8", timeout: 240_000 });
    const intent = readJournal(root);
    assert.equal(intent?.state, "commit-intent", "SIGTERM leaves commit intent intact");
    assert.equal(intent.listenerProof, undefined, "the signal precedes the listener bind");
    assert.ok(intent.restore);
    assert.equal(committed.status, 143, `SIGTERM exits 143\n${committed.stderr}`);
    const launch = /^\s{2}(.+) <command> \[options\]$/m.exec(run().stdout)?.[1];
    assert.ok(launch);
    assert.ok(committed.stderr.includes(`Interrupted: restore attempt ${intent.restore.attemptId} committed before it stopped`) && committed.stderr.includes(`bare \`${launch} up\``), committed.stderr);
    assert.doesNotMatch(committed.stderr, /backup recover/);
    const resumed = spawn(process.execPath, ["--import", tsxImport, cliPath, "up"], { cwd: root, env, stdio: ["ignore", "ignore", "pipe"] });
    let resumeErrors = "";
    resumed.stderr!.on("data", (chunk: Buffer) => { resumeErrors += chunk.toString(); });
    const resumedExit = new Promise<number | null>((resolveExit) => resumed.once("close", resolveExit));
    const timeout = setTimeout(() => resumed.kill("SIGKILL"), 120_000);
    try {
      while (journalState(root) !== "active" && resumed.exitCode === null && resumed.signalCode === null) await sleep(50);
      assert.equal(journalState(root), "active", `bare up continues the committed restore\n${resumeErrors}`);
      assert.equal(readJournal(root)?.restore?.attemptId, intent.restore.attemptId);
      must("down", run("down", "--yes"));
      assert.equal(await resumedExit, 0, resumeErrors);
    } finally {
      clearTimeout(timeout);
      resumed.kill("SIGKILL");
      await resumedExit;
    }
  } finally {
    run("down", "--yes");
    rmSync(root, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  }
}

/** Ctrl-C inside a backup create's claimed window. While the backup process lives, another create,
 *  `up` and `backup recover` refuse naming it and the claim deadline. Interrupted, it exits 130 and
 *  names its partial artifact and recovery; `backup verify` calls that artifact incomplete, and
 *  `backup recover` removes it before the deadline so the same destination works again. */
async function interruptedCreateScenario(): Promise<void> {
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), "cotal-backup-faults-int-create-root-")));
  const home = realpathSync.native(mkdtempSync(join(tmpdir(), "cotal-backup-faults-int-create-home-")));
  // Its own .cotal, so the CLI resolves this root and never a stray .cotal in a parent folder.
  mkdirSync(join(root, ".cotal"), { mode: 0o700 });
  const configDir = join(home, "xdg");
  const sandbox = recordSmokeSandbox({ root, cotalHome: home, xdgConfigHome: configDir });
  const destination = join(root, "interrupted-backup");
  const store = join(root, "private store");
  const port = await freePort();
  const server = `nats://127.0.0.1:${port}`;
  const space = "backup_faults_int_create";
  const env: NodeJS.ProcessEnv = { ...process.env, COTAL_HOME: home, XDG_CONFIG_HOME: configDir, COTAL_SKIP_CONNECTOR_SEED: "1" };
  const run = (...args: string[]) => {
    const options = { cwd: root, env, encoding: "utf8" as const, timeout: 240_000 };
    assertSmokeSandboxDown(sandbox, args, options);
    return spawnSync(tsx, [cliPath, ...args], options);
  };
  const must = (label: string, result: ReturnType<typeof run>) => {
    assert.equal(result.status, 0, `interrupted create ${label}\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
  };
  try {
    must("up", run("up", "--detach", "--open", "--server", server, "--space", space, "--store-dir", store));
    assert.ok(existsSync(join(store, "jetstream")), "up opened the custom store");
    const wrongStore = run("down", "--preserve-state", "--yes", "--store-dir", "./different store", "--session-store", ".");
    assert.equal(wrongStore.status, 2, wrongStore.stderr);
    const option = wrongStore.stderr.match(/omit --store-dir, or pass (--store-dir .+)$/m)?.[1];
    assert.equal(option, `--store-dir '${store}'`, wrongStore.stderr);
    // Let the shell parse the printed option, then run the guarded CLI with those arguments.
    const parsed = spawnSync("sh", ["-c", `printf '%s\\n' ${option}`], { encoding: "utf8" });
    assert.equal(parsed.status, 0, parsed.stderr);
    must("preserve cut with the printed store option", run("down", "--preserve-state", "--yes", ...parsed.stdout.trimEnd().split("\n"), "--session-store", "."));

    // Its own process group, as a terminal runs it, so the SIGINT below is the one Ctrl-C sends.
    const child = spawn(process.execPath, ["--import", tsxImport, cliPath, "backup", "create", destination], { cwd: root, env, detached: true, stdio: ["ignore", "ignore", "pipe"] });
    let stderr = "";
    child.stderr!.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });
    const exited = new Promise<number | null>((resolveExit) => child.once("exit", (code) => resolveExit(code)));
    const held = await freezeUnlocked(root, child.pid!, (journal) => journal.state === "claimed" && (journal.claim?.owners.length ?? 0) > 0 && existsSync(destination));
    const attemptId = held.claim!.attemptId!, deadline = held.claim!.deadline;
    const recover = `cotal backup recover ${attemptId} --yes`;
    for (const [label, args] of [
      ["another backup create", ["backup", "create", join(root, "second-backup")]],
      ["up", ["up", "--detach", "--open", "--server", server, "--space", space]],
      ["backup recover", ["backup", "recover", attemptId, "--yes"]],
    ] as const) {
      const refused = run(...args);
      assert.equal(refused.status, 2, `${label} refuses while the backup process lives\n${refused.stderr}`);
      assert.match(refused.stderr, /LIFECYCLE_BLOCKED/, `${label} is a known refusal`);
      assert.ok(refused.stderr.includes(`holds this root until ${deadline}, and its backup process ${child.pid} is still running`), `${label} names the backup process and the deadline\n${refused.stderr}`);
      assert.ok(refused.stderr.includes(recover), `${label} names the recovery\n${refused.stderr}`);
    }

    process.kill(-child.pid!, "SIGINT");
    process.kill(child.pid!, "SIGCONT");
    assert.equal(await exited, 130, `the interrupted create exits 130\n${stderr}`);
    assert.ok(stderr.includes(`left a partial artifact at ${destination}`) && stderr.includes(recover), `the interrupt names its partial artifact and its recovery\n${stderr}`);
    assert.equal(journalState(root), "claimed", "the interrupted create leaves its claim");
    assertRecoveryNext(run, recover);
    const verified = run("backup", "verify", destination);
    assert.equal(verified.status, 1, `verify refuses the partial artifact\n${verified.stderr}`);
    assert.ok(verified.stderr.includes("has no manifest.json, so it is an incomplete artifact"), `verify calls the partial artifact incomplete\n${verified.stderr}`);
    assert.ok(verified.stderr.includes(recover), `verify names the owning attempt's recovery\n${verified.stderr}`);
    const parked = join(root, "parked-backup");
    renameSync(destination, parked);
    try {
      const empty = readdirSync(parked).length === 0;
      cpSync(parked, destination, { recursive: true });
      const replacement = run("backup", "verify", destination);
      assert.equal(replacement.status, empty ? 2 : 1, replacement.stderr);
      assert.match(replacement.stderr, empty ? /Code:\s+TARGET_NOT_FOUND/ : /verify another intact copy/);
      assert.doesNotMatch(replacement.stderr, /backup recover/);
    } finally {
      rmSync(destination, { recursive: true, force: true });
      renameSync(parked, destination);
    }
    const samePath = run("backup", "create", destination);
    assert.equal(samePath.status, 2, `a create at the partial artifact refuses\n${samePath.stderr}`);
    assert.ok(samePath.stderr.includes(`is the partial artifact of interrupted backup attempt ${attemptId}`) && samePath.stderr.includes(recover), `that refusal names the attempt and its recovery\n${samePath.stderr}`);
    // The broker's watchdog stops it once the backup process is gone; recovery waits for that only.
    let recovered = run("backup", "recover", attemptId, "--yes");
    for (let i = 0; i < 50 && recovered.status !== 0; i++) { await sleep(200); recovered = run("backup", "recover", attemptId, "--yes"); }
    must("recover the interrupted create", recovered);
    assert.ok(/Next\s+cotal backup create <directory>\s+Create a new backup from the preserved cut\s+cotal up\s+Resume the space/.test(recovered.stdout), `the release receipt names a new backup and resume as its next steps\n${recovered.stdout}`);
    assert.ok(Date.now() < Date.parse(deadline), "recovery ran before the claim deadline");
    assert.equal(journalState(root), "ready", "recovery returns the cut to ready");
    assert.equal(existsSync(destination), false, "recovery removed the partial artifact");
    assert.deepEqual(attemptResidue(root), [], "recovery leaves no clone or broker files");
    must("create at the same destination after recovery", run("backup", "create", destination));
    assertValidManifest(destination, space, "full");
    must("verify the completed backup", run("backup", "verify", destination));
    const copy = join(root, "copy-without-manifest");
    cpSync(destination, copy, { recursive: true });
    rmSync(join(copy, "manifest.json"));
    const incomplete = run("backup", "verify", copy);
    assert.equal(incomplete.status, 1, incomplete.stderr);
    assert.match(incomplete.stderr, /SCHEMA_INVALID/);
    assert.match(incomplete.stderr, /verify another intact copy/);
    assert.doesNotMatch(incomplete.stderr, /backup recover/);
    must("ordinary resume after recovery", run("up", "--detach", "--open", "--server", server, "--space", space));
    must("down", run("down", "--yes"));
  } finally {
    run("down", "--yes");
    rmSync(root, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  }
}

await backupStageFaultScenario();
await restoreExactIdTimeoutReplayScenario();
await interruptedRestoreScenario();
await interruptedCreateScenario();
console.log("backup faults live smoke: ok");
