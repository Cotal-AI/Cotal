/** Hermetic CLI backup artifact and maintenance-grammar smoke. */
import nodeAssert from "node:assert/strict";
import { countedAssert, emitSentinel } from "@cotal-ai/smoke-kit";
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { createServer, type AddressInfo } from "node:net";
import { join } from "node:path";
import { ArtifactFileFault, createArtifactWriter, inspectBackupArtifact, stageArtifact } from "../src/lib/backup-artifact.js";
import { backupRead } from "../src/commands/backup-read.js";
import { down } from "../src/commands/down.js";
import { clean } from "../src/commands/clean.js";
import { backup, backupComplete, chunkQueue, isStoppedKvWatcher } from "../src/commands/backup.js";
import { upComplete } from "../src/commands/up.js";
import { createAttemptClone, ensurePrivateAttemptsDir } from "../src/lib/isolated-broker.js";
import { isManagerCommitResult, isManagerFinalizeResult, movedFolderRefusal, prepareRestore, preservedSourceState } from "../src/lib/restore.js";
import { authorityFingerprint } from "../src/lib/maintenance-files.js";
import { assertEndpointUnreachable } from "../src/lib/endpoint-cut.js";
import { consumerConfigFromCheckpoint, createSpaceAuth, dmStream, rotateSystemAccount, taskStream } from "@cotal-ai/core";
import { acquireMaintenanceLock, authDir, beginMaintenanceCut, completeMaintenanceCut, ensureStoreIdentity, isCommandFailure, readMaintenanceJournal, recordPreservationManagerCommit, releaseMaintenanceLock, saveSpaceAuth, writeMaintenanceResumeDocument } from "@cotal-ai/workspace";
import { DeliverPolicy, type ConsumerInfo } from "@nats-io/jetstream";
const counted = countedAssert(nodeAssert);
const assert: typeof nodeAssert = counted.assert;
const cells = counted.cells;

const root = mkdtempSync(join(tmpdir(), "cotal-backup-cli-"));
try {
  const destination = join(root, "artifact");
  const writer = createArtifactWriter(destination);
  const snapshot = await writer.writeFile("stream-a.snap", "snapshot", new Uint8Array([1, 2, 3]), "CHAT_demo");
  const checkpoints = await writer.writeFile("checkpoints.json", "checkpoints", "[]\n");
  writer.publish({
    space: "demo",
    selection: "registry",
    mode: "open",
    source: { path: join(root, "source"), dev: "1", ino: "2", generation: "00000000-0000-4000-8000-000000000000" },
    streams: [{
      stream: "CHAT_demo",
      snapshot: snapshot.path,
      config: {},
      state: { messages: 0, bytes: 0, first_seq: 0, last_seq: 0, consumer_count: 0 },
    }],
    checkpoints: checkpoints.path,
  }, [snapshot, checkpoints]);
  // POSIX mode bits only: on Windows the create mode is a no-op (Node honors just the read-only
  // bit) and privacy comes from the NTFS ACL `createArtifactWriter` sets via `hardenPrivate`, which
  // fails closed — reaching here at all is the win32 proof. `icacls` output is not asserted.
  if (process.platform !== "win32") {
    assert.equal(statSync(destination).mode & 0o777, 0o700);
    for (const file of ["stream-a.snap", "checkpoints.json", "manifest.json"])
      assert.equal(statSync(join(destination, file)).mode & 0o777, 0o600, `${file} is private`);
  }
  assert.throws(() => createArtifactWriter(destination), /already exists/);
  const originalManifest = readFileSync(join(destination, "manifest.json"), "utf8");

  const stagingParent = join(root, "staging");
  mkdirSync(stagingParent, { mode: 0o700 });
  const staged = stageArtifact(destination, stagingParent);
  assert.deepEqual(readFileSync(join(staged.directory, "stream-a.snap")), Buffer.from([1, 2, 3]));
  staged.cleanup();
  // Hashes cannot show a consistent rewrite, so verify and staging refuse an artifact another local
  // account could write, name each such path, and leave no staging directory behind.
  if (process.platform !== "win32") {
    const directory = realpathSync(destination);
    const manifestPath = join(directory, "manifest.json");
    chmodSync(directory, 0o702);
    chmodSync(manifestPath, 0o602);
    const exposed = (error: unknown) => isCommandFailure(error) && error.code === "PERMISSION_DENIED"
      && error.message === `the backup artifact is not protected against other local writers: ${directory} and ${manifestPath} are writable by every local account`
      && error.remedy === `chmod o-w ${directory} ${manifestPath}`;
    assert.throws(() => backupRead({ positionals: ["verify", directory], values: {}, raw: [] }), exposed, "verify refuses an artifact others can write");
    assert.throws(() => stageArtifact(directory, stagingParent), exposed, "staging refuses an artifact others can write");
    assert.deepEqual(readdirSync(stagingParent), [], "a refused staging leaves no staging directory");
    chmodSync(directory, 0o700);
    chmodSync(manifestPath, 0o600);
  }

  writeFileSync(join(destination, "extra"), "x");
  assert.throws(() => stageArtifact(destination, stagingParent), (error: unknown) => error instanceof ArtifactFileFault && error.file === "extra" && error.fault === "undeclared");
  rmSync(join(destination, "extra"));
  writeFileSync(join(destination, "stream-a.snap"), "changed");
  assert.throws(() => stageArtifact(destination, stagingParent), (error: unknown) => error instanceof ArtifactFileFault && error.file === "stream-a.snap" && error.fault === "mismatch");
  // `backup verify` names the failing file and its fault, so an operator knows which copy is damaged.
  const verifyFault = (file: string | null, fault: string, text: RegExp) => (error: unknown) => {
    const target = isCommandFailure(error) ? error.target as { file?: unknown; fault?: unknown } : undefined;
    return isCommandFailure(error) && error.code === "SCHEMA_INVALID" && text.test(error.message) && target?.file === file && target.fault === fault;
  };
  assert.throws(() => backupRead({ positionals: ["verify", realpathSync(destination)], values: {}, raw: [] }),
    verifyFault("stream-a.snap", "mismatch", /^backup artifact file stream-a\.snap does not match its declared size and SHA-256/));
  writeFileSync(join(destination, "stream-a.snap"), Buffer.from([1, 9, 3]));
  assert.throws(() => backupRead({ positionals: ["verify", realpathSync(destination)], values: {}, raw: [] }),
    verifyFault("stream-a.snap", "mismatch", /stream-a\.snap does not match/), "a same-size flipped byte is a named mismatch");
  rmSync(join(destination, "stream-a.snap"));
  assert.throws(() => backupRead({ positionals: ["verify", realpathSync(destination)], values: {}, raw: [] }),
    verifyFault("stream-a.snap", "missing", /^backup artifact is missing its declared file stream-a\.snap/));
  // An interrupted create leaves snapshots with no manifest: verify names it an incomplete artifact.
  const partial = join(root, "partial-artifact");
  mkdirSync(partial);
  writeFileSync(join(partial, "stream-0123456789abcdef01234567.snap"), Buffer.from([1, 2, 3]));
  assert.throws(() => backupRead({ positionals: ["verify", realpathSync(partial)], values: {}, raw: [] }), (error: unknown) =>
    isCommandFailure(error) && error.code === "SCHEMA_INVALID" && error.message === `${realpathSync(partial)} has no manifest.json, so it is an incomplete artifact, as an interrupted backup create leaves one; nothing in it was checked`
      && (error.target as { fault?: unknown }).fault === "manifest-missing" && (error.remedy ?? "").includes("cotal backup recover <attempt> --yes"));
  // A folder that holds nothing a create writes, or a file, is not an artifact, not an interrupted one.
  const plain = join(root, "not-a-backup");
  mkdirSync(plain);
  writeFileSync(join(root, "a-file"), "x");
  for (const [mode, path, text] of [["inspect", plain, "holds no manifest.json and no file a backup create writes"], ["verify", plain, "holds no manifest.json and no file a backup create writes"], ["inspect", join(root, "a-file"), "is not a folder"]] as const)
    assert.throws(() => backupRead({ positionals: [mode, realpathSync(path)], values: {}, raw: [] }), (error: unknown) =>
      isCommandFailure(error) && error.code === "TARGET_NOT_FOUND" && error.message === `${realpathSync(path)} is not a backup artifact: it ${text}; nothing in it was checked` && !(error.remedy ?? "").includes("recover"));
  // A path that names nothing says whether its folder or the artifact is missing, as restore does.
  for (const [mode, path, missing] of [["verify", join(root, "no-such-folder", "artifact"), "folder"], ["inspect", join(root, "no-such-artifact"), "artifact"]] as const)
    assert.throws(() => backupRead({ positionals: [mode, path], values: {}, raw: [] }), (error: unknown) =>
      isCommandFailure(error) && error.code === "TARGET_NOT_FOUND" && error.outcome === "refused" && (error.target as { missing?: unknown }).missing === missing
        && error.message.endsWith("; nothing was checked") && error.message.includes(missing === "folder" ? `there is no folder ${join(root, "no-such-folder")}` : "holds no backup artifact no-such-artifact"), `${mode} names the missing ${missing}`);
  writeFileSync(join(destination, "stream-a.snap"), Buffer.from([1, 2, 3]));
  // A path through a linked folder names the artifact create published there, and verify reads it at
  // its real path, as restore stages it.
  const linkParent = mkdtempSync(join(tmpdir(), "cotal-backup-cli-link-"));
  try {
    symlinkSync(realpathSync(root), join(linkParent, "via"));
    const throughLink = inspectBackupArtifact(join(linkParent, "via", "artifact"), true);
    assert.equal(throughLink.directory, realpathSync(destination), "verify through a linked folder reads the artifact at its real path");
    assert.equal(throughLink.integrity, "matched-declared-sizes-and-sha256", "and its files match");
  } finally { rmSync(linkParent, { recursive: true, force: true }); }
  const traversing = JSON.parse(originalManifest) as { checkpoints: string };
  traversing.checkpoints = "../checkpoints.json";
  writeFileSync(join(destination, "manifest.json"), `${JSON.stringify(traversing)}\n`);
  // Verify and staging name the same fault for each artifact that cannot be restored, and never
  // print a declared name that is not a plain file name.
  const verify = () => backupRead({ positionals: ["verify", realpathSync(destination)], values: {}, raw: [] });
  const stageFault = (file: string | null, fault: string) => (error: unknown) => error instanceof ArtifactFileFault && error.file === file && error.fault === fault;
  assert.throws(() => stageArtifact(destination, stagingParent), stageFault(null, "invalid-name"));
  assert.throws(verify, verifyFault(null, "invalid-name", /^backup manifest declares a file name that is not a plain name in the artifact folder.*; the name was not printed/), "verify names a traversing file name as its fault");
  writeFileSync(join(destination, "manifest.json"), `${"[".repeat(100_000)}${"]".repeat(100_000)}`);
  assert.throws(verify, verifyFault("manifest.json", "manifest-invalid", /^backup artifact manifest\.json is not a valid cotal-space-backup\/v1 manifest: it is not a JSON object/), "verify names a deeply nested manifest as invalid");
  const inventory = (edit: (manifest: { space: string; files: { path: string }[]; streams: { stream: string }[] }) => void) => {
    const manifest = JSON.parse(originalManifest) as { space: string; files: { path: string }[]; streams: { stream: string }[] };
    edit(manifest);
    writeFileSync(join(destination, "manifest.json"), `${JSON.stringify(manifest)}\n`);
  };
  inventory((manifest) => manifest.files.push({ ...manifest.files[0]! }));
  assert.throws(verify, verifyFault("manifest.json", "manifest-invalid", /: it declares a file more than once;/), "verify names a duplicate file record");
  assert.throws(() => stageArtifact(destination, stagingParent), stageFault("manifest.json", "manifest-invalid"));
  inventory((manifest) => { manifest.streams[0]!.stream = "CHAT_other"; });
  assert.throws(verify, verifyFault("manifest.json", "manifest-invalid", /: its stream records do not match its snapshot files;/), "verify names a stream record that matches no snapshot");
  inventory((manifest) => { manifest.space = "s".repeat(300); });
  assert.throws(verify, verifyFault("manifest.json", "manifest-invalid", /: it names an invalid space;/), "verify names an invalid space");
  assert.throws(() => stageArtifact(destination, stagingParent), stageFault("manifest.json", "manifest-invalid"));
  writeFileSync(join(destination, "manifest.json"), " ".repeat(1024 * 1024 + 1));
  assert.throws(verify, verifyFault("manifest.json", "manifest-too-large", /larger than its 1 MiB limit/), "verify names an oversized manifest and its limit");
  writeFileSync(join(destination, "manifest.json"), originalManifest);
  if (process.platform !== "win32") {
    const outsideManifest = join(root, "outside-manifest.json");
    writeFileSync(outsideManifest, originalManifest);
    rmSync(join(destination, "manifest.json"));
    symlinkSync(outsideManifest, join(destination, "manifest.json"));
    assert.throws(verify, verifyFault("manifest.json", "manifest-not-regular", /manifest\.json is not a regular file/), "verify names a linked manifest");
    assert.throws(() => stageArtifact(destination, stagingParent), stageFault("manifest.json", "manifest-not-regular"));
    rmSync(join(destination, "manifest.json"));
    writeFileSync(join(destination, "manifest.json"), originalManifest);
    const external = join(root, "external.snap");
    writeFileSync(external, Buffer.from([1, 2, 3]));
    rmSync(join(destination, "stream-a.snap"));
    symlinkSync(external, join(destination, "stream-a.snap"));
    assert.throws(() => stageArtifact(destination, stagingParent), stageFault("stream-a.snap", "not-regular"));
    assert.throws(verify, verifyFault("stream-a.snap", "not-regular", /^backup artifact file stream-a\.snap is not a regular file/), "verify names a linked snapshot");
    // A FIFO is refused before it is opened, so verify does not wait for a writer.
    rmSync(join(destination, "stream-a.snap"));
    execFileSync("mkfifo", [join(destination, "stream-a.snap")]);
    assert.throws(verify, verifyFault("stream-a.snap", "not-regular", /stream-a\.snap is not a regular file/), "verify names a FIFO snapshot");
    rmSync(join(destination, "stream-a.snap"));
    writeFileSync(join(destination, "stream-a.snap"), Buffer.from([1, 2, 3]));

    const redirectedRoot = join(root, "redirected-root");
    const redirected = join(root, "redirected-maintenance");
    mkdirSync(redirectedRoot);
    mkdirSync(redirected);
    symlinkSync(redirected, join(redirectedRoot, ".cotal"));
    assert.throws(() => ensurePrivateAttemptsDir(redirectedRoot), /not a real directory/);
  }

  // The maintenance-attempt tree holds the store clone, quarantine, sanitized snapshots, and the
  // broker `.conf` (plaintext creds) — the crown jewels. Assert privacy the way the boundary is
  // actually enforced per platform: POSIX mode bits, and on win32 the NTFS ACL, since mode bits are
  // a no-op there and privacy comes from hardenPrivate's icacls grant (mirrors secret-fs.smoke.ts).
  const isWin = process.platform === "win32";
  const winUser = isWin ? execFileSync("whoami", { encoding: "utf8" }).trim() : "";
  const assertPrivateDir = (dir: string, label: string): void => {
    if (!isWin) {
      assert.equal(statSync(dir).mode & 0o777, 0o700, `${label} is 0700`);
      return;
    }
    const acl = execFileSync("icacls", [dir], { encoding: "utf8" });
    assert.ok(!/\bEveryone\b/i.test(acl) && !/\bAuthenticated Users\b/i.test(acl) && !/\\Users:/i.test(acl),
      `${label} ACL strips Everyone / Authenticated Users / Users`);
    assert.ok(/\\SYSTEM:/i.test(acl) && /\\Administrators:/i.test(acl) && acl.toLowerCase().includes(winUser.toLowerCase()),
      `${label} ACL grants owner + SYSTEM + Administrators`);
  };

  {
    // realpath-canonical root: ensurePrivateAttemptsDir refuses a non-canonical path, and macOS
    // tmpdir is /var → /private/var symlinked.
    mkdirSync(join(root, "priv-maint"));
    const privRoot = realpathSync.native(join(root, "priv-maint"));
    const attempts = ensurePrivateAttemptsDir(privRoot);
    // Every level of the tree, not just the leaf — a permissive .cotal or maintenance parent would
    // expose the attempts subtree by inheritance on win32.
    assertPrivateDir(join(privRoot, ".cotal"), ".cotal");
    assertPrivateDir(join(privRoot, ".cotal", "maintenance"), "maintenance");
    assertPrivateDir(attempts.path, "attempts");

    // A clone copies the whole store; the clone root and its bytes must be private too.
    const sourceStore = join(root, "priv-source-store");
    mkdirSync(sourceStore);
    writeFileSync(join(sourceStore, "stream.dat"), Buffer.from([7, 8, 9]));
    const clone = createAttemptClone(privRoot, sourceStore, "priv-attempt");
    assertPrivateDir(clone.path, "attempt clone");
    assert.deepEqual(readFileSync(join(clone.path, "stream.dat")), Buffer.from([7, 8, 9]));
    clone.cleanup();
    assert.ok(!existsSync(clone.path), "clone cleanup removes the clone");
  }

  const queue = chunkQueue();
  const iterator = queue.iterable[Symbol.asyncIterator]();
  const waiting = iterator.next();
  let accepted = false;
  const pushed = queue.push(new Uint8Array([9])).then(() => { accepted = true; });
  assert.deepEqual((await waiting).value, new Uint8Array([9]));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(accepted, false, "snapshot chunk is not accepted before the sink asks for the next chunk");
  const finished = iterator.next();
  await pushed;
  queue.close();
  assert.equal((await finished).done, true);

  const watcher = {
    name: "oc_test",
    push_bound: false,
    config: {
      name: "oc_test",
      deliver_policy: "last_per_subject",
      ack_policy: "none",
      max_deliver: 1,
      filter_subject: "$KV.bucket.>",
      replay_policy: "instant",
      flow_control: true,
      deliver_subject: "_INBOX_test",
      idle_heartbeat: 30_000_000_000,
      inactive_threshold: 300_000_000_000,
      num_replicas: 1,
      metadata: { "_nats.req.level": "0" },
    },
  } as unknown as ConsumerInfo;
  assert.equal(isStoppedKvWatcher("KV_bucket", watcher), true);
  assert.equal(isStoppedKvWatcher("KV_bucket", {
    ...watcher,
    config: { ...watcher.config, deliver_policy: "all" },
  }), true);
  assert.equal(isStoppedKvWatcher("KV_bucket", {
    ...watcher,
    config: {
      ...watcher.config,
      max_deliver: -1,
      headers_only: true,
      idle_heartbeat: 5_000_000_000,
      inactive_threshold: undefined,
      num_replicas: 0,
    },
  }), true);
  assert.equal(isStoppedKvWatcher("KV_bucket", { ...watcher, push_bound: true }), false);
  assert.equal(isStoppedKvWatcher("KV_bucket", {
    ...watcher,
    config: { ...watcher.config, inactive_threshold: 1 },
  }), false);

  // A named down is a service stop, which takes no whole-stack flag and drops none.
  await assert.rejects(
    () => down({ positionals: ["nats"], values: { "preserve-state": true }, raw: [] }),
    { code: "USAGE_INVALID", message: /named down accepts only space, instance, confirmation, preview and presentation flags/ },
  );
  await assert.rejects(
    () => down({ positionals: [], values: { "store-dir": root }, raw: [] }),
    /only valid with down --preserve-state/,
  );
  assert.deepEqual(backupComplete(["--only", ""]).items.map((item) => item.value), ["full", "registry"]);
  assert.deepEqual(upComplete(["--restore-only", ""]).items.map((item) => item.value), ["registry"]);
  assert.equal(isManagerCommitResult({
    attemptId: "restore-1",
    state: "awaitingFinalize",
    durableCommitToken: "a".repeat(64),
  }, "restore-1"), true);
  assert.equal(isManagerCommitResult(undefined, "restore-1"), false);
  assert.equal(isManagerCommitResult({}, "restore-1"), false);
  assert.equal(isManagerCommitResult({
    attemptId: "restore-2",
    state: "awaitingFinalize",
    durableCommitToken: "a".repeat(64),
  }, "restore-1"), false);
  assert.equal(isManagerCommitResult({ attemptId: "restore-1", state: "awaitingCommit" }, "restore-1"), false);
  assert.equal(isManagerCommitResult({
    attemptId: "restore-1",
    state: "active",
    durableCommitToken: "a".repeat(64),
  }, "restore-1"), false);
  assert.equal(isManagerCommitResult({
    attemptId: "restore-1",
    state: "awaitingFinalize",
    durableCommitToken: "short",
  }, "restore-1"), false);
  assert.equal(isManagerFinalizeResult({ attemptId: "restore-1", state: "active" }, "restore-1"), true);
  assert.equal(isManagerFinalizeResult({ attemptId: "restore-1", state: "awaitingFinalize" }, "restore-1"), false);

  const trustRoot = join(root, "trust-root");
  mkdirSync(trustRoot);
  const originalAuth = await createSpaceAuth("root_chain_drift");
  saveSpaceAuth(authDir(trustRoot), originalAuth);
  const originalFingerprint = await authorityFingerprint(trustRoot, originalAuth.space, "auth");
  const rotatedSystem = await rotateSystemAccount(originalAuth);
  assert.equal(rotatedSystem.account.pub, originalAuth.account.pub, "system rotation retains the data account");
  saveSpaceAuth(authDir(trustRoot), rotatedSystem);
  const rotatedFingerprint = await authorityFingerprint(trustRoot, originalAuth.space, "auth");
  assert.equal(rotatedFingerprint.account, originalFingerprint.account);
  assert.notEqual(
    rotatedFingerprint.authoritySha256,
    originalFingerprint.authoritySha256,
    "authority commitment changes when the validated operator/system root changes under the same data account",
  );

  const taskCheckpoint = consumerConfigFromCheckpoint("checkpoint_space", {
    stream: taskStream("checkpoint_space"),
    name: "svc_reviewer",
    ackFloorStreamSequence: 4,
    creationLowerBound: 1,
    streamState: { messages: 5, first_seq: 1, last_seq: 5 },
  });
  assert.equal(taskCheckpoint.deliver_policy, DeliverPolicy.All);
  assert.equal(taskCheckpoint.opt_start_seq, undefined, "TASK restore uses the core-owned WorkQueue policy");
  assert.throws(
    () => consumerConfigFromCheckpoint("checkpoint_space", {
      stream: dmStream("checkpoint_space"),
      name: "dm_owner-actor",
      ackFloorStreamSequence: 6,
      creationLowerBound: 1,
      streamState: { messages: 5, first_seq: 1, last_seq: 5 },
    }),
    /ACK floor exceeds snapshot last sequence/,
    "checkpoint cursors cannot escape their bound snapshot state",
  );

  const listener = createServer();
  await new Promise<void>((resolveListen, rejectListen) => {
    listener.once("error", rejectListen);
    listener.listen(0, "127.0.0.1", resolveListen);
  });
  const endpoint = `nats://127.0.0.1:${(listener.address() as AddressInfo).port}`;
  await assert.rejects(
    assertEndpointUnreachable(endpoint),
    /to have no listener/,
    "a live listener is authoritative even without a pidfile or NATS handshake",
  );
  await new Promise<void>((resolveClose, rejectClose) => listener.close((error) => error ? rejectClose(error) : resolveClose()));
  await assertEndpointUnreachable(endpoint);

  // A restore with no preserved cut to restore into refuses before the maintenance lock, and leaves
  // the folder as it found it, so a later `up` there finds no state to start from.
  const bare = join(root, "bare-folder");
  mkdirSync(bare);
  await assert.rejects(
    prepareRestore(bare, { restore: destination }),
    (error: unknown) => isCommandFailure(error) && error.outcome === "refused" && error.code === "LIFECYCLE_BLOCKED" && error.message.endsWith("found none") && (error.remedy ?? "").includes("cotal down --preserve-state"),
    "a restore with no maintenance journal is a refusal that names the preserve",
  );
  assert.equal(existsSync(join(bare, ".cotal")), false, "the refused restore created no .cotal state");

  // `backup create` refuses before any claim with a reason and a next step, and the refusal leaves no
  // maintenance state. A destination that already exists is a conflict, not a failed creation.
  const previousCwd = process.cwd(), previousHome = process.env.COTAL_HOME;
  const createRoot = join(root, "create-root");
  mkdirSync(join(createRoot, ".cotal"), { recursive: true });
  process.env.COTAL_HOME = join(root, "create-home");
  process.chdir(createRoot);
  try {
    await assert.rejects(
      backup({ positionals: ["create", join(root, "create-artifact")], values: {}, raw: [] }),
      (error: unknown) => isCommandFailure(error) && error.outcome === "refused" && error.code === "LIFECYCLE_BLOCKED" && error.message.includes("records none") && (error.remedy ?? "").includes("cotal down --preserve-state"),
      "a create with no preserved cut says so and names the preserve",
    );
    assert.equal(existsSync(join(createRoot, ".cotal", "maintenance")), false, "that refusal created no maintenance state");
    const createStore = join(createRoot, ".cotal", "nats");
    mkdirSync(createStore, { recursive: true });
    const createLock = acquireMaintenanceLock(createRoot);
    const createResume = writeMaintenanceResumeDocument(createLock, { version: 1, inventory: { agents: [] }, launch: { runtime: "pty" } });
    beginMaintenanceCut(createLock, { attemptId: "cut-create", space: "create", mode: "open", sourcePath: createStore, resume: createResume, launch: { server: "nats://127.0.0.1:4222" } });
    releaseMaintenanceLock(createLock);
    const existingArtifact = join(root, "create-existing");
    mkdirSync(existingArtifact);
    await assert.rejects(
      backup({ positionals: ["create", existingArtifact], values: {}, raw: [] }),
      (error: unknown) => isCommandFailure(error) && error.outcome === "refused" && error.code === "CONFLICT" && error.message.includes("already exists"),
      "a create into an existing directory is a conflict refusal",
    );
    assert.equal(readMaintenanceJournal(createRoot)?.state, "cut-intent", "the conflict claimed nothing");
    await assert.rejects(
      backup({ positionals: ["create", join(root, "create-artifact")], values: {}, raw: [] }),
      (error: unknown) => isCommandFailure(error) && error.code === "LIFECYCLE_BLOCKED" && error.message.endsWith("maintenance state is cut-intent") && (error.target as { space?: string }).space === "create",
      "a create on an unfinished cut names its state and space",
    );
    // A recover or cleanup refusal shows the id format and why it found nothing to act on.
    await assert.rejects(
      backup({ positionals: ["recover", "00000000-0000-4000-8000-000000000000"], values: {}, raw: [] }),
      (error: unknown) => isCommandFailure(error) && error.code === "USAGE_INVALID" && error.message.includes("restore-<uuid>") && (error.remedy ?? "").includes("cotal status"),
      "a recover given a bare uuid shows the restore-<uuid> form",
    );
    await assert.rejects(
      backup({ positionals: ["recover", "backup-00000000-0000-4000-8000-000000000000"], values: {}, raw: [] }),
      (error: unknown) => isCommandFailure(error) && error.code === "TARGET_NOT_FOUND" && error.message.includes("names that backup attempt"),
      "recover takes an interrupted create's backup-<uuid> and says when the root holds no such claim",
    );
    await assert.rejects(
      backup({ positionals: ["cleanup-fallback", "backup-00000000-0000-4000-8000-000000000000"], values: {}, raw: [] }),
      (error: unknown) => isCommandFailure(error) && error.code === "USAGE_INVALID" && error.message.includes("restore-<uuid>"),
      "cleanup-fallback takes only a restore attempt",
    );
    await assert.rejects(
      backup({ positionals: ["cleanup-fallback", "restore-00000000-0000-4000-8000-000000000000"], values: {}, raw: [] }),
      (error: unknown) => isCommandFailure(error) && error.code === "TARGET_NOT_FOUND" && (error.remedy ?? "").includes("finds nothing to do"),
      "a cleanup-fallback on a root with no restore attempt says why it found nothing",
    );
  } finally {
    process.chdir(previousCwd);
    if (previousHome === undefined) delete process.env.COTAL_HOME;
    else process.env.COTAL_HOME = previousHome;
  }

  // `clean store` and `clean all` refuse a root that holds a preserved cut. `backup recover` and
  // `cleanup-fallback` take no preserve- id, so the refusal names the step status shows for the cut.
  {
    const cleanRoot = join(root, "clean-root"), cleanStore = join(cleanRoot, ".cotal", "nats"), server = "nats://127.0.0.1:43247";
    mkdirSync(cleanStore, { recursive: true });
    const lock = acquireMaintenanceLock(cleanRoot);
    try {
      const resume = writeMaintenanceResumeDocument(lock, { version: 1, inventory: { agents: [] }, launch: { runtime: "pty" } });
      beginMaintenanceCut(lock, { attemptId: "preserve-clean", space: "clean", mode: "open", sourcePath: cleanStore, resume, launch: { server } });
      const managerCommit = { operation: "commitPreservation" as const, attemptId: "preserve-clean", state: "preserved" as const };
      recordPreservationManagerCommit(lock, managerCommit);
      completeMaintenanceCut(lock, { attemptId: "preserve-clean", observedAt: new Date().toISOString(), managerCommit, stopped: { manager: true, broker: true, localProcesses: true }, listener: { endpoint: server, unreachable: true } });
    } finally { releaseMaintenanceLock(lock); }
    process.chdir(cleanRoot);
    try {
      for (const target of ["store", "all"])
        await assert.rejects(clean({ positionals: [target], values: { force: true }, raw: [] }), (error: unknown) =>
          isCommandFailure(error) && error.code === "LIFECYCLE_BLOCKED" && error.message === `clean ${target} is refused while this root holds maintenance attempt preserve-clean (state ready); nothing was removed`
            && / or resume with bare .*up; once the root holds no maintenance state and its mesh is stopped, run .*clean (store|all) --force again$/.test(error.remedy ?? ""),
        `clean ${target} on a preserved cut names the step status shows for it`);
      assert.ok(existsSync(cleanStore) && readMaintenanceJournal(cleanRoot)?.state === "ready", "the refused clean removed nothing and kept the cut");
    } finally { process.chdir(previousCwd); }
  }

  // A preserved store is found where its journal recorded it, moved with its folder, or missing.
  {
    const before = join(root, "moved-before"), after = join(root, "moved-after");
    mkdirSync(join(before, ".cotal", "nats"), { recursive: true });
    const source = ensureStoreIdentity(join(before, ".cotal", "nats")), recordedRoot = realpathSync(before);
    assert.deepEqual(preservedSourceState(before, source), { state: "present" }, "a store at its recorded path is present");
    execFileSync("mv", [before, after]);
    const moved = preservedSourceState(after, source);
    assert.ok(moved.state === "moved" && moved.recordedRoot === recordedRoot && moved.store === realpathSync(join(after, ".cotal", "nats")), "a store that moved with its folder names the folder it was recorded in");
    if (moved.state === "moved") {
      const refusal = movedFolderRefusal(after, "demo", source.path, moved, "run cotal up");
      assert.ok(refusal.code === "CONFLICT" && refusal.message.includes(`moved from ${recordedRoot}`) && refusal.remedy === `move this folder back to ${recordedRoot}, then run cotal up there`, "the moved refusal names the old folder and the step that works there");
    }
    rmSync(join(after, ".cotal", "nats"), { recursive: true });
    mkdirSync(join(after, ".cotal", "nats"));
    ensureStoreIdentity(join(after, ".cotal", "nats"));
    assert.deepEqual(preservedSourceState(after, source), { state: "missing" }, "another store in the new folder is not the moved one");
  }

  console.log("backup CLI smoke: ok");
} finally {
  rmSync(root, { recursive: true, force: true });
}
emitSentinel({ passed: cells(), failed: 0 });
