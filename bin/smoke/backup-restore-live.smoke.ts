/** Live full/registry backup, restore, isolation, checkpoint, and ordinary-resume lifecycle, the runs a restore of an older backup rolled back, the `up -f` refusal while a restore is active, and the refusal of any `up` while its broker runs. */
import assert from "node:assert/strict";
import { spawn, spawnSync, type ChildProcess, type SpawnSyncReturns } from "node:child_process";
import { createHash } from "node:crypto";
import { cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, readlinkSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { hostname } from "node:os";
import { createSpaceAuth, mintCreds, newIdentity, probeConnect, rotateSystemAccount, taskStream } from "@cotal-ai/core";
import {
  acquireMaintenanceLock,
  authDir,
  canonicalLocalProcessPath,
  MANAGER_PIDFILE,
  brokerAuthPath,
  loadSoleSpaceAuth,
  prepareAlternateRestore,
  readMaintenanceJournal,
  releaseMaintenanceLock,
  rollbackRestore,
  saveSpaceAuth,
  spaceAccountPath,
  type ProcessOwner,
} from "@cotal-ai/workspace";
import {
  connectIsolatedBroker,
  createAttemptClone,
  startIsolatedBroker,
} from "../../implementations/cli/src/lib/isolated-broker.js";
import { assertSmokeSandboxDown, freePort, recordSmokeSandbox, SMOKE_BROKER_TOKEN, teardownOnSignal, type SmokeSandboxAnchor } from "@cotal-ai/smoke-kit";

const occupy = async (port: number): Promise<ChildProcess> => {
  const child = spawn("nats-server", ["-p", String(port), "-a", "127.0.0.1", "-sd", mkdtempSync(join(tmpdir(), SMOKE_BROKER_TOKEN))], { stdio: "ignore" });
  teardownOnSignal(child);
  for (let i = 0; i < 50; i++) {
    if ((await probeConnect(`nats://127.0.0.1:${port}`, { timeoutMs: 200 })).ok) return child;
    await new Promise((resolveWait) => setTimeout(resolveWait, 100));
  }
  child.kill("SIGTERM");
  throw new Error(`occupying nats-server did not start on ${port}`);
};

const closeServer = (child: ChildProcess) => new Promise<void>((resolveClose) => {
  if (child.exitCode !== null || child.signalCode !== null) return resolveClose();
  child.once("exit", () => resolveClose());
  child.kill("SIGTERM");
});

const waitUntil = async (predicate: () => boolean | Promise<boolean>, label: string, timeoutMs = 30_000) => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((resolveWait) => setTimeout(resolveWait, 100));
  }
  throw new Error(`timed out waiting for ${label}`);
};

const worktree = resolve(import.meta.dirname, "..", "..");
const cliPath = join(worktree, "bin", "cotal.ts");
const taskSeedPath = join(worktree, "implementations", "cli", "smoke", "seed-task-durable.ts");
const tsx = join(worktree, "node_modules", ".bin", "tsx");

function sandboxRun(root: string, home: string): {
  run: (...args: string[]) => SpawnSyncReturns<string>;
  env: NodeJS.ProcessEnv;
  sandbox: SmokeSandboxAnchor;
} {
  const configDir = join(home, "xdg");
  const sandbox = recordSmokeSandbox({ root, cotalHome: home, xdgConfigHome: configDir });
  const env = { ...process.env, COTAL_HOME: home, XDG_CONFIG_HOME: configDir, COTAL_SKIP_CONNECTOR_SEED: "1" };
  const run = (...args: string[]) => {
    const options = { cwd: root, env, encoding: "utf8" as const, timeout: 240_000 };
    assertSmokeSandboxDown(sandbox, args, options);
    return spawnSync(tsx, [cliPath, ...args], options);
  };
  return { run, env, sandbox };
}

interface Checkpoint { stream: string; name: string }

async function scenario(mode: "open" | "auth"): Promise<void> {
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), `cotal-backup-restore-${mode}-root-`)));
  const home = realpathSync.native(mkdtempSync(join(tmpdir(), `cotal-backup-restore-${mode}-home-`)));
  const artifact = join(root, "full-backup");
  const registryArtifact = join(root, "registry-backup");
  const port = await freePort();
  const server = `nats://127.0.0.1:${port}`;
  const space = `backup_live_${mode}`;
  const { run, env } = sandboxRun(root, home);
  const must = (label: string, result: ReturnType<typeof run>) => {
    assert.equal(result.status, 0, `${mode} ${label}\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
  };

  try {
    must("up", run("up", "--detach", ...(mode === "open" ? ["--open"] : []), "--server", server, "--space", space));
    must("seed registry", run("channel", "set", "preserved", "--desc", "survives", "--space", space));
    if (mode === "auth") {
      must("seed TASK durable", spawnSync(tsx, [taskSeedPath, root, server, space, "reviewer"], {
        cwd: join(worktree, "implementations", "cli"), env, encoding: "utf8", timeout: 30_000,
      }));
    }
    must("preserve cut", run("down", "--preserve-state"));
    const ready = JSON.parse(readFileSync(join(root, ".cotal", "maintenance", "v1", "journal.json"), "utf8")) as { state: string };
    assert.equal(ready.state, "ready");

    if (mode === "auth") {
      const auth = loadSoleSpaceAuth(authDir(root));
      assert.ok(auth, "static scenario retained its SpaceAuth");
      const clone = createAttemptClone(root, join(root, ".cotal", "nats"), `isolation-${Date.now()}`);
      const broker = await startIsolatedBroker({
        root,
        storeDir: clone.path,
        space,
        mode: "auth",
        auth,
        deadline: new Date(Date.now() + 60_000),
        label: "backup",
        initialScope: { profile: "backup", scope: { operation: "inspect", selection: "full" } },
      });
      try {
        const normalCreds = await mintCreds(auth, newIdentity(), "operator");
        assert.deepEqual(
          await probeConnect(broker.server, { creds: normalCreds, timeoutMs: 2_000 }),
          { ok: false, reason: "auth-required" },
          "a normal retained DATA-account credential cannot connect to the isolated listener",
        );
        const maintenance = await connectIsolatedBroker(broker, broker.initialLogin);
        await maintenance.request("$JS.API.STREAM.NAMES", "{}", { timeout: 2_000 });
        await maintenance.drain();
        const retired = broker.initialLogin!;
        await broker.addLogin({ profile: "backup", scope: { operation: "inspect", selection: "registry" } });
        await assert.rejects(
          connectIsolatedBroker(broker, retired),
          /authorization|authentication/i,
          "a prior maintenance phase is retired when the next exact principal is installed",
        );
      } finally {
        await broker.stop();
        clone.cleanup();
      }
    }

    must("full backup", run("backup", "create", artifact));
    must("registry backup", run("backup", "create", registryArtifact, "--only", "registry"));
    assert.ok(existsSync(join(artifact, "manifest.json")));
    // A full artifact of an authenticated space restores only where its trust state survives, and says so.
    const trustBound = (dir: string) => (JSON.parse(run("backup", "inspect", dir, "--json").stdout) as { result: { trustBound: boolean } }).result.trustBound;
    assert.equal(trustBound(artifact), mode === "auth", `a full ${mode} artifact says whether it is bound to this root's trust state`);
    assert.equal(trustBound(registryArtifact), false, "a registry artifact is not bound to this root's trust state");
    const originalCheckpoints = JSON.parse(readFileSync(join(artifact, "checkpoints.json"), "utf8")) as Checkpoint[];
    if (mode === "auth") {
      assert.ok(originalCheckpoints.length >= 3, "authenticated backup captured Plane-3 and TASK checkpoints");
      assert.ok(originalCheckpoints.some((checkpoint) => checkpoint.stream === taskStream(space) && checkpoint.name === "svc_reviewer"));

      const authPath = spaceAccountPath(authDir(root), space);
      const brokerPath = brokerAuthPath(authDir(root));
      const journalPath = join(root, ".cotal", "maintenance", "v1", "journal.json");
      const attemptsPath = join(root, ".cotal", "maintenance", "attempts");
      const originalAuthText = readFileSync(authPath, "utf8");
      const originalBrokerText = readFileSync(brokerPath, "utf8");
      const originalAuth = JSON.parse(originalAuthText) as Record<string, any>;
      const foreignAuth = await createSpaceAuth(`${space}_foreign`);
      const journalBefore = readFileSync(journalPath, "utf8");
      const sourceBefore = lstatSync(join(root, ".cotal", "nats"), { bigint: true });
      rmSync(attemptsPath, { recursive: true, force: true });
      assert.equal(existsSync(attemptsPath), false, "malformed-auth preflight begins without an attempts directory");
      const malformed: Array<[string, (auth: Record<string, any>) => void, RegExp]> = [
        ["public nkey", (auth) => { auth.account.pub = "not-an-account-key"; }, /invalid encoded key|valid account public nkey/],
        ["seed mismatch", (auth) => { auth.account.seed = auth.account.signingSeed; }, /account\.seed does not match account\.pub/],
        ["JWT", (auth) => { auth.account.jwt = "not-a-jwt"; }, /store values are corrupt, mismatched, or outside one broker\/account trust chain/],
        ["untrusted signer", (auth) => {
          auth.account.signingSeed = foreignAuth.account.signingSeed;
          auth.account.signingPub = foreignAuth.account.signingPub;
        }, /active account signing key is not trusted/],
        ["wrong space", (auth) => { auth.space = `${space}_wrong`; }, /tenant list is not fully readable/],
      ];
      try {
        for (const [label, corrupt, expected] of malformed) {
          const auth = structuredClone(originalAuth);
          corrupt(auth);
          writeFileSync(authPath, `${JSON.stringify(auth, null, 2)}\n`);
          const refused = run(
            "up", "--restore", registryArtifact, "--restore-only", "registry", "--detach",
            "--server", server, "--space", space,
          );
          assert.notEqual(refused.status, 0, `${label} registry-only restore must fail auth preflight`);
          assert.match(refused.stderr, expected, `${label} reports the trust validation failure`);
          assert.equal(readFileSync(journalPath, "utf8"), journalBefore, `${label} leaves the ready journal byte-identical`);
          const sourceAfter = lstatSync(join(root, ".cotal", "nats"), { bigint: true });
          assert.equal(sourceAfter.dev, sourceBefore.dev, `${label} leaves source device unchanged`);
          assert.equal(sourceAfter.ino, sourceBefore.ino, `${label} leaves source inode unchanged`);
          assert.equal(existsSync(attemptsPath), false, `${label} creates no attempt layout or staged artifact`);
        }
      } finally {
        writeFileSync(authPath, originalAuthText);
      }

      // A copy whose file no longer matches its manifest is refused as backup verify refuses it, by name.
      const tampered = join(root, "full-backup-tampered");
      cpSync(artifact, tampered, { recursive: true });
      const snapshot = readdirSync(tampered).find((name) => name.endsWith(".snap"))!;
      writeFileSync(join(tampered, snapshot), "X", { flag: "a" });
      for (const command of ["verify", "restore"]) {
        const refused = run("backup", command, tampered, "--json");
        const envelope = JSON.parse(refused.stdout) as { error?: { code?: string }; target?: { file?: string; fault?: string } };
        assert.equal(refused.status, 1, `backup ${command} of a tampered copy exits 1: ${refused.stderr}`);
        assert.equal(envelope.error?.code, "SCHEMA_INVALID", `backup ${command} of a tampered copy is SCHEMA_INVALID`);
        assert.equal(envelope.target?.file, snapshot, `backup ${command} of a tampered copy names the file`);
        assert.equal(envelope.target?.fault, "mismatch", `backup ${command} of a tampered copy names the fault`);
      }
      assert.equal(readFileSync(journalPath, "utf8"), journalBefore, "a tampered restore leaves the ready journal byte-identical");
      assert.equal(existsSync(attemptsPath) && readdirSync(attemptsPath).length > 0, false, "a tampered restore leaves no staged copy");
      rmSync(tampered, { recursive: true, force: true });

      const validBeforeDrift = loadSoleSpaceAuth(authDir(root));
      assert.ok(validBeforeDrift);
      const rotatedSystem = await rotateSystemAccount(validBeforeDrift);
      assert.equal(rotatedSystem.account.pub, validBeforeDrift.account.pub);
      saveSpaceAuth(authDir(root), rotatedSystem);
      const driftedRoot = run("up", "--restore", artifact, "--detach", "--server", server, "--space", space);
      assert.equal(driftedRoot.status, 2, "valid root-chain drift refuses a full restore with exit 2, not an unknown outcome");
      assert.match(driftedRoot.stderr, /authority fingerprint does not match current trust state/);
      assert.match(driftedRoot.stderr, /CONFLICT/, "root-chain drift is a CONFLICT refusal");
      assert.ok(driftedRoot.stderr.includes(`its channel registry still restores here with cotal backup restore ${artifact} --only registry`), `its Next names the registry restore, which does not check the trust state\n${driftedRoot.stderr}`);
      assert.equal(readFileSync(journalPath, "utf8"), journalBefore, "root-chain drift leaves the ready journal byte-identical");
      const sourceAfterDrift = lstatSync(join(root, ".cotal", "nats"), { bigint: true });
      assert.equal(sourceAfterDrift.dev, sourceBefore.dev);
      assert.equal(sourceAfterDrift.ino, sourceBefore.ino);
      // The rotation at :186 rewrote broker.json (new system account); the split persists trust as
      // broker.json + account.<hex>.json, so restoring only the account file would leave the drifted
      // system account in place and pre-empt the state-drift case below with an authority-fingerprint
      // refusal. Restore both halves to the pre-rotation trust.
      writeFileSync(authPath, originalAuthText);
      writeFileSync(brokerPath, originalBrokerText);

      const stateDriftArtifact = join(root, "state-drift-backup");
      cpSync(artifact, stateDriftArtifact, { recursive: true });
      const checkpointPath = join(stateDriftArtifact, "checkpoints.json");
      const driftedCheckpoints = JSON.parse(readFileSync(checkpointPath, "utf8")) as Array<Checkpoint & {
        streamState: { messages: number; first_seq: number; last_seq: number };
      }>;
      assert.ok(driftedCheckpoints[0], "full artifact has a checkpoint to bind to stream state");
      driftedCheckpoints[0].streamState.last_seq += 1;
      const checkpointBytes = `${JSON.stringify(driftedCheckpoints, null, 2)}\n`;
      writeFileSync(checkpointPath, checkpointBytes);
      const driftedManifestPath = join(stateDriftArtifact, "manifest.json");
      const driftedManifest = JSON.parse(readFileSync(driftedManifestPath, "utf8")) as {
        files: Array<{ path: string; size: number; sha256: string }>;
      };
      const checkpointRecord = driftedManifest.files.find((file) => file.path === "checkpoints.json");
      assert.ok(checkpointRecord);
      checkpointRecord.size = Buffer.byteLength(checkpointBytes);
      checkpointRecord.sha256 = createHash("sha256").update(checkpointBytes).digest("hex");
      writeFileSync(driftedManifestPath, `${JSON.stringify(driftedManifest, null, 2)}\n`);
      const refusedStateDrift = run("up", "--restore", stateDriftArtifact, "--detach", "--server", server, "--space", space);
      assert.notEqual(refusedStateDrift.status, 0, "checkpoint state drift must fail before store mutation");
      assert.match(refusedStateDrift.stderr, /does not match its snapshot stream state/);
      assert.equal(readFileSync(journalPath, "utf8"), journalBefore);
      const sourceAfterStateDrift = lstatSync(join(root, ".cotal", "nats"), { bigint: true });
      assert.equal(sourceAfterStateDrift.dev, sourceBefore.dev);
      assert.equal(sourceAfterStateDrift.ino, sourceBefore.ino);
    }

    const attemptArtifact = join(root, ".cotal", "maintenance", "attempts", "nested-artifact");
    cpSync(artifact, attemptArtifact, { recursive: true });
    const nestedArtifact = run("up", "--restore", attemptArtifact, "--detach", "--server", server, "--space", space);
    assert.equal(nestedArtifact.status, 1, `an artifact in the maintenance folder is a usage refusal\n${nestedArtifact.stderr}`);
    assert.ok(nestedArtifact.stderr.includes(`the restore artifact ${realpathSync(attemptArtifact)} is inside this root's maintenance folder ${realpathSync(join(root, ".cotal", "maintenance"))}, where it stages its attempt; nothing was restored`), `it names the artifact and the folder\n${nestedArtifact.stderr}`);
    rmSync(attemptArtifact, { recursive: true });
    const nestedTarget = run(
      "up", "--restore", artifact, "--store-dir", join(artifact, "target"), "--detach",
      "--server", server, "--space", space,
    );
    assert.notEqual(nestedTarget.status, 0);
    assert.match(nestedTarget.stderr, /target must not overlap the backup artifact/);
    // An explicit store that already exists, or whose parent is missing, is a usage refusal before
    // anything is staged, and the preserved cut stays as it was.
    const cutState = readMaintenanceJournal(root)?.state;
    const existingStore = join(root, "existing-store");
    mkdirSync(existingStore);
    for (const [label, storeDir, named] of [["existing", existingStore, existingStore], ["parentless", join(root, "missing-parent", "store"), join(root, "missing-parent")]] as const) {
      const refused = run("backup", "restore", artifact, "--store-dir", storeDir, "--json");
      const envelope = JSON.parse(refused.stdout) as { error?: { code?: string; message?: string } };
      assert.equal(refused.status, 1, `${mode} ${label} --store-dir\n${refused.stdout}${refused.stderr}`);
      assert.equal(envelope.error?.code, "USAGE_INVALID");
      assert.ok(envelope.error?.message?.includes(named), envelope.error?.message);
      assert.equal(readMaintenanceJournal(root)?.state, cutState, `${mode} ${label} --store-dir left the preserved cut unchanged`);
    }
    rmSync(existingStore, { recursive: true });
    if (mode === "open") {
      // Another process on the recorded address is refused before the resume or the restore journals
      // or starts anything, so the cut stays ready for the run after it leaves.
      const occupied = await occupy(port);
      const blocked = run("up", "--detach", "--server", server, "--space", space);
      assert.equal(blocked.status, 2, `${blocked.stdout}${blocked.stderr}`);
      assert.match(blocked.stderr, /to have no listener; the resumed broker needs that address, so nothing was started/);
      assert.equal(readMaintenanceJournal(root)?.state, "ready", "a refused resume leaves the cut ready");
      const blockedRestore = run("backup", "restore", artifact, "--json");
      const envelope = JSON.parse(blockedRestore.stdout) as { error?: { code?: string } };
      assert.equal(blockedRestore.status, 2, `${blockedRestore.stdout}${blockedRestore.stderr}`);
      assert.equal(envelope.error?.code, "CONFLICT");
      assert.equal(readMaintenanceJournal(root)?.state, "ready", "a refused restore leaves the cut ready");
      await closeServer(occupied);
    }
    must("ordinary same-principal resume", run("up", "--detach", "--server", server, "--space", space));
    assert.equal(existsSync(join(root, ".cotal", "maintenance", "v1", "journal.json")), false, "ordinary resume retires and consumes maintenance state");
    must("preserve again for restore", run("down", "--preserve-state"));

    // A restore into the preserved store's own path moves it aside whole, so a file in it that no
    // Cotal store writes is refused before anything moves.
    {
      const store = realpathSync(join(root, ".cotal", "nats"));
      writeFileSync(join(store, "notes.txt"), "kept");
      const refused = run("backup", "restore", artifact, "--json");
      assert.equal(refused.status, 2, `${mode} a restore over a foreign file is refused\n${refused.stdout}${refused.stderr}`);
      const envelope = JSON.parse(refused.stdout) as { error?: { code?: string; message?: string } };
      assert.equal(envelope.error?.code, "CONFLICT");
      assert.ok(envelope.error?.message?.includes(`the preserved store ${store} also holds notes.txt, which no Cotal store writes; a restore into it moves that store aside whole, so nothing was restored`), envelope.error?.message);
      assert.ok(readFileSync(join(store, "notes.txt"), "utf8") === "kept" && readMaintenanceJournal(root)?.state === "ready", `${mode} the refused restore keeps the file and the cut`);
      rmSync(join(store, "notes.txt"));
    }
    const restoreArtifact = mode === "open" ? registryArtifact : artifact;
    const restored = run("up", "--restore", restoreArtifact, "--detach", "--server", server, "--space", space);
    must("restore", restored);
    const listed = run("channel", "--space", space);
    must("list restored registry", listed);
    assert.match(listed.stdout, /#preserved/);
    const active = JSON.parse(readFileSync(join(root, ".cotal", "maintenance", "v1", "journal.json"), "utf8")) as {
      state: string;
      restore: { attemptId: string; selection?: string; previousSource?: { identity: { path: string } } };
      launch?: { previousCutNewer?: boolean };
    };
    assert.equal(active.state, "active");
    assert.equal(active.restore.selection, restoreArtifact === registryArtifact ? "registry" : "full", `${mode} restore journals its selection`);
    // Both artifacts predate the cut this restore replaced, which was preserved after the resume
    // above. So each restore leaves something only in the store it set aside: the registry restore
    // every other stream, and the full restore what that resume wrote.
    assert.equal(active.launch?.previousCutNewer, true, `${mode} restore journals that the cut it replaced is newer than its artifact`);
    const leftOut = restoreArtifact === registryArtifact ? "chat and DM history and workflow runs" : "newer chat and DM history and workflow runs";
    // The receipt names the restore attempt and the cleanup that retires it, with --discard-history.
    assert.ok(restored.stdout.includes(`✓ restored the backup ${restoreArtifact === registryArtifact ? "registry" : "in full"} as restore attempt ${active.restore.attemptId}`), `${mode} up --restore names its attempt\n${restored.stdout}`);
    const cleanupNext = restored.stdout.split("\n").find((line) => line.startsWith("next: ")) ?? "";
    assert.ok(cleanupNext.includes(`cotal backup cleanup-fallback ${active.restore.attemptId} --yes --discard-history`) && cleanupNext.includes(`the only copy of the ${leftOut} it left out`), `${mode} up --restore names the cleanup that retires it\n${restored.stdout}`);
    // A registry restore says history starts empty and names the store that holds its only copy.
    if (restoreArtifact === registryArtifact) {
      assert.match(restored.stdout, /channel settings only, so chat and DM history and workflow runs start empty/, `${mode} registry restore names the empty history\n${restored.stdout}`);
      const previous = active.restore.previousSource?.identity.path;
      assert.ok(previous && restored.stdout.includes(`The previous store at ${previous} holds the only copy of them. \`cotal backup cleanup-fallback ${active.restore.attemptId}\` deletes it only with --discard-history.`), `${mode} registry restore names the previous store\n${restored.stdout}`);
    } else {
      assert.doesNotMatch(restored.stdout, /history start empty/);
      const previous = active.restore.previousSource?.identity.path;
      assert.ok(previous && restored.stdout.includes("This backup was made before the state it replaced was preserved, so the chat and DM history and workflow runs written after it are not restored.") && restored.stdout.includes(`The previous store at ${previous} holds the only copy of the ${leftOut}.`), `${mode} full restore of an older artifact names the newer history it left out\n${restored.stdout}`);
    }
    // `up -f` boots a fresh mesh, so it refuses while the restore is active and names the way out.
    const manifest = join(root, "cotal.yaml");
    writeFileSync(manifest, `apiVersion: cotal/v1\nkind: Mesh\nspace: ${space}\nbroker:\n  servers: ${server}\n${mode === "open" ? "  auth: false\n" : ""}channels:\n  general:\n    subscribe: []\n`);
    const running = run("up", "-f", "cotal.yaml");
    assert.equal(running.status, 2, `${mode} up -f while the restored stack runs refuses, exit 2\n${running.stdout}\n${running.stderr}`);
    assert.match(running.stderr, /Code: +CONFLICT/);
    assert.ok(running.stderr.includes(`stop the restored stack with cotal down, retire the restore with cotal backup cleanup-fallback ${active.restore.attemptId} --yes --discard-history, which deletes the previous store and the ${leftOut} only it holds, then run cotal up -f cotal.yaml again`), `${mode} up -f names the way out\n${running.stderr}`);
    // Any other `up` over the restored broker refuses before it touches the journal, which stays active.
    for (const args of [["up"], ["up", "--server", server]]) {
      const again = run(...args);
      assert.equal(again.status, 2, `${mode} ${args.join(" ")} while the restored stack runs refuses, exit 2\n${again.stdout}\n${again.stderr}`);
      assert.ok(/Code: +CONFLICT/.test(again.stderr) && again.stderr.includes("stop the restored stack with cotal down, then run cotal up again"), `${mode} ${args.join(" ")} names the way out\n${again.stderr}`);
      assert.equal((JSON.parse(readFileSync(join(root, ".cotal", "maintenance", "v1", "journal.json"), "utf8")) as { state: string }).state, "active", `${mode} ${args.join(" ")} leaves the restore journal active`);
    }
    // `status` names the same cleanup for the attempt it shows under Maintenance.
    const status = run("status", "--space", space);
    const statusNext = status.stdout.split("\n").find((line) => line.includes(`cotal backup cleanup-fallback ${active.restore.attemptId}`)) ?? "";
    assert.ok(statusNext.includes("--discard-history") && statusNext.includes(`the only copy of the ${leftOut} it left out`), `${mode} status names the cleanup that retires the restore\n${status.stdout}`);
    must("down", run("down"));
    const stopped = run("up", "-f", "cotal.yaml");
    assert.equal(stopped.status, 2, `${mode} up -f after the restored stack stopped refuses, exit 2\n${stopped.stdout}\n${stopped.stderr}`);
    assert.match(stopped.stderr, /Code: +LIFECYCLE_BLOCKED/);
    assert.ok(stopped.stderr.includes(`retire the restore with cotal backup cleanup-fallback ${active.restore.attemptId} --yes --discard-history, which deletes the previous store and the ${leftOut} only it holds, then run cotal up -f cotal.yaml again`), `${mode} up -f names the cleanup\n${stopped.stderr}`);
    rmSync(manifest);
    if (mode === "open") {
      // The committed journal survives the broker's death; a later bare `up` relaunches over the
      // exact recorded active target (a different --store-dir is refused) without retiring it.
      must("later startup after committed restore broker shutdown", run("up", "--detach", "--open", "--server", server, "--space", space));
      assert.equal(
        (JSON.parse(readFileSync(join(root, ".cotal", "maintenance", "v1", "journal.json"), "utf8")) as { state: string }).state,
        "active",
      );
      must("later down", run("down"));
    }
    {
      // The previous store holds the only copy of what the restore left out, so the preview warns and
      // both cleanup commands refuse to delete it without --discard-history.
      const previous = active.restore.previousSource!.identity.path;
      const preview = run("backup", "cleanup-fallback", active.restore.attemptId, "--dry-run", "--json");
      must("cleanup-fallback preview", preview);
      assert.ok((JSON.parse(preview.stdout) as { warnings: { code: string }[] }).warnings.some((w) => w.code === "HISTORY_ONLY_IN_PREVIOUS_STORE"), `${mode} preview warns about the only copy\n${preview.stdout}`);
      // The attempt row names a restore attempt, not a full restore.
      const previewText = run("backup", "cleanup-fallback", active.restore.attemptId, "--dry-run");
      assert.ok(previewText.status === 0 && /Restore attempt:\s+restore-/.test(previewText.stdout) && !previewText.stdout.includes("Full restore attempt"), `${mode} the preview labels the attempt as a restore attempt\n${previewText.stdout}`);
      const kept = run("backup", "cleanup-fallback", active.restore.attemptId, "--yes", "--json");
      assert.equal(kept.status, 1, `${mode} cleanup-fallback without --discard-history refuses\n${kept.stdout}\n${kept.stderr}`);
      assert.match(kept.stdout, /"code":"USAGE_INVALID"/);
      const keptPlain = run("backup", "cleanup-fallback", active.restore.attemptId, "--yes");
      assert.ok(keptPlain.status === 1 && keptPlain.stderr.includes(`only copy of the ${leftOut} it left out, and cleanup deletes it only with --discard-history; nothing was deleted`) && !keptPlain.stderr.includes("Usage"), `${mode} the refusal names --discard-history without the command help\n${keptPlain.stderr}`);
      assert.ok(existsSync(previous), `${mode} cleanup-fallback without --discard-history keeps the previous store`);
      // Without --force, each restore verb names the command to run with its attempt.
      const unforced = run("clean", "restore-fallback", "--attempt", active.restore.attemptId, "--discard-history");
      assert.ok(unforced.status === 1 && unforced.stderr.includes(`cotal clean restore-fallback --attempt ${active.restore.attemptId} --force --discard-history`), `${mode} clean restore-fallback without --force names the command with its attempt\n${unforced.stderr}`);
      const unnamed = run("clean", "restore-attempt");
      assert.ok(unnamed.status === 1 && unnamed.stderr.includes("cotal clean restore-attempt --attempt <id> --force"), `${mode} clean restore-attempt without --force or an attempt names --attempt <id>\n${unnamed.stderr}`);
      const keptByClean = run("clean", "restore-fallback", "--attempt", active.restore.attemptId, "--force");
      assert.ok(keptByClean.status === 1 && keptByClean.stderr.includes(`holds the only copy of the ${leftOut} it left out; nothing was deleted`) && keptByClean.stderr.includes(`cotal clean restore-fallback --attempt ${active.restore.attemptId} --force --discard-history`) && !keptByClean.stderr.includes("Usage"), `${mode} clean restore-fallback without --discard-history refuses, naming the flag without the command help\n${keptByClean.stdout}\n${keptByClean.stderr}`);
      assert.ok(existsSync(previous), `${mode} clean restore-fallback without --discard-history keeps the previous store`);
      // A file put into the previous store after the restore is no store's, so neither cleanup deletes
      // that store until it is moved out.
      writeFileSync(join(previous, "notes.txt"), "kept");
      const foreign = run("backup", "cleanup-fallback", active.restore.attemptId, "--yes", "--discard-history", "--json");
      assert.ok(foreign.status === 2 && (JSON.parse(foreign.stdout) as { error?: { code?: string } }).error?.code === "CONFLICT", `${mode} cleanup-fallback over a foreign file is refused\n${foreign.stdout}${foreign.stderr}`);
      const foreignByClean = run("clean", "restore-fallback", "--attempt", active.restore.attemptId, "--force", "--discard-history");
      assert.ok(foreignByClean.status === 2 && foreignByClean.stderr.includes(`the previous store ${previous} also holds notes.txt, which no Cotal store writes; nothing was deleted`)
        && foreignByClean.stderr.includes(`move it out of ${previous}, then run cotal clean restore-fallback --attempt ${active.restore.attemptId} --force --discard-history again`), `${mode} clean restore-fallback names the file and the way out\n${foreignByClean.stderr}`);
      assert.equal(readFileSync(join(previous, "notes.txt"), "utf8"), "kept", `${mode} the refused cleanups keep the file`);
      renameSync(join(previous, "notes.txt"), join(root, "notes.txt"));
      must("cleanup fallback", run("clean", "restore-fallback", "--attempt", active.restore.attemptId, "--force", "--discard-history"));
      assert.equal(existsSync(previous), false, `${mode} --discard-history deletes the previous store`);
      assert.equal(readFileSync(join(root, "notes.txt"), "utf8"), "kept", `${mode} the moved file survives the cleanup`);
      rmSync(join(root, "notes.txt"));
    }
    assert.equal(existsSync(join(root, ".cotal", "maintenance", "v1", "journal.json")), false, "fallback cleanup retires the restore journal");
    // A repeat finds no record of the attempt, because the cleanup retired it, and says so by name.
    const repeated = run("clean", "restore-fallback", "--attempt", active.restore.attemptId, "--force", "--discard-history");
    assert.ok(repeated.status === 2 && /Code: +TARGET_NOT_FOUND/.test(repeated.stderr) && repeated.stderr.includes(`no maintenance record at this root names restore attempt ${active.restore.attemptId}; nothing was deleted`) &&
      repeated.stderr.includes("a completed restore-fallback retires its journal, so the restore has settled"), `${mode} a repeated clean restore-fallback says the restore settled\n${repeated.stderr}`);
  } finally {
    run("down");
    rmSync(root, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  }
}

async function occupiedRestoreScenario(): Promise<void> {
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), "cotal-occupied-restore-root-")));
  const home = realpathSync.native(mkdtempSync(join(tmpdir(), "cotal-occupied-restore-home-")));
  const artifact = join(root, "registry-backup");
  const port = await freePort();
  const server = `nats://127.0.0.1:${port}`;
  const space = "backup_occupied_restore";
  const { run } = sandboxRun(root, home);
  let occupied: ChildProcess | undefined;
  try {
    assert.equal(run("up", "--detach", "--open", "--server", server, "--space", space).status, 0);
    assert.equal(run("down", "--preserve-state").status, 0);
    assert.equal(run("backup", "create", artifact, "--only", "registry").status, 0);
    occupied = await occupy(port);
    // The restore probes the address its broker will bind before anything moves, so another listener
    // there is refused and the cut stays ready.
    const blocked = run("up", "--restore", artifact, "--detach", "--server", server, "--space", space);
    assert.equal(blocked.status, 2, `${blocked.stdout}${blocked.stderr}`);
    assert.match(blocked.stderr, /to have no listener; the restored broker needs that address, so the preserved cut was not changed/);
    const journal = JSON.parse(readFileSync(join(root, ".cotal", "maintenance", "v1", "journal.json"), "utf8")) as { state: string };
    assert.equal(journal.state, "ready");
    assert.equal(existsSync(join(root, ".cotal", "nats.pid")), false);
  } finally {
    if (occupied) await closeServer(occupied).catch(() => {});
    run("down");
    rmSync(root, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  }
}

async function restoreReentryScenario(
  detached: boolean,
  authenticated = false,
  injection: "listener-bind" | "resume-preserved" | "resume-commit" | "resume-finalize" = "listener-bind",
): Promise<void> {
  const label = `${authenticated ? "auth" : "open"}-${detached ? "detached" : "foreground"}-${injection}`;
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), `cotal-restore-reentry-${label}-root-`)));
  const home = realpathSync.native(mkdtempSync(join(tmpdir(), `cotal-restore-reentry-${label}-home-`)));
  const artifact = join(root, "registry-backup");
  const port = await freePort();
  const server = `nats://127.0.0.1:${port}`;
  const space = `backup_reentry_${label}`;
  const { run, env } = sandboxRun(root, home);
  const journalPath = join(root, ".cotal", "maintenance", "v1", "journal.json");
  try {
    assert.equal(run("up", "--detach", ...(authenticated ? [] : ["--open"]), "--server", server, "--space", space).status, 0);
    assert.equal(run("down", "--preserve-state").status, 0);
    assert.equal(run("backup", "create", artifact, "--only", "registry").status, 0);

    const failureEnv = {
      ...env,
      ...(injection === "listener-bind"
        ? { COTAL_SMOKE_EXIT_AFTER_RESTORE_LISTENER_BIND: "1" }
        : injection === "resume-preserved"
          ? { COTAL_SMOKE_EXIT_AFTER_RESUME_PRESERVED: "1" }
          : injection === "resume-commit"
            ? { COTAL_SMOKE_EXIT_AFTER_RESUME_COMMIT: "1" }
            : { COTAL_SMOKE_EXIT_AFTER_RESUME_FINALIZE: "1" }),
    };
    const first = spawnSync(
      tsx,
      [cliPath, "up", "--restore", artifact, ...(detached ? ["--detach"] : []), "--server", server, "--space", space],
      { cwd: root, env: failureEnv, stdio: "ignore", timeout: 240_000 },
    );
    assert.equal(first.status, { "listener-bind": 86, "resume-preserved": 88, "resume-commit": 89, "resume-finalize": 91 }[injection],
      `${label} injected restore startup must stop at the requested boundary`);
    await waitUntil(async () => {
      const probe = await probeConnect(server, { timeoutMs: 250 });
      return probe.ok || (authenticated && !probe.ok && probe.reason === "auth-required");
    }, `${label} restore listener readiness`);
    const interrupted = JSON.parse(readFileSync(journalPath, "utf8")) as {
      state: string;
      listenerProof?: { serverName: string; serverNonce: string; processOwner: { pid: number }; target: { path: string } };
    };
    assert.equal(interrupted.state, injection === "resume-commit" || injection === "resume-finalize"
      ? "manager-committed"
      : "commit-intent");
    assert.ok(interrupted.listenerProof, `${label} listener proof is durable before coordinator loss`);
    assert.ok(interrupted.listenerProof.serverName.endsWith(`-${interrupted.listenerProof.serverNonce}`));
    assert.equal(interrupted.listenerProof.target.path, join(root, ".cotal", "nats"));

    const recovered = run("up", ...(detached ? ["--detach"] : []), "--server", server, "--space", space);
    assert.equal(recovered.status, 0, `${label} proven listener re-entry\nstdout:\n${recovered.stdout}\nstderr:\n${recovered.stderr}`);
    const active = JSON.parse(readFileSync(journalPath, "utf8")) as {
      state: string;
      listenerProof?: { processOwner: { pid: number } };
      details?: {
        managerCommit?: { attemptId?: string; state?: string; durableCommitToken?: string };
        managerFinalize?: { attemptId?: string; state?: string; durableCommitToken?: string };
      };
      restore?: { attemptId: string };
    };
    assert.equal(active.state, "active");
    assert.equal(active.listenerProof?.processOwner.pid, interrupted.listenerProof.processOwner.pid);
    assert.equal(active.details?.managerCommit?.attemptId, active.restore?.attemptId);
    assert.equal(active.details?.managerCommit?.state, "awaitingFinalize");
    assert.match(active.details?.managerCommit?.durableCommitToken ?? "", /^[a-f0-9]{64}$/);
    assert.deepEqual(active.details?.managerFinalize, {
      attemptId: active.restore?.attemptId,
      state: "active",
      durableCommitToken: active.details?.managerCommit?.durableCommitToken,
    });
    assert.equal(run("down").status, 0);
  } finally {
    run("down");
    rmSync(root, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  }
}

async function ordinaryResumeReentryScenario(injection: "resume-commit" | "resume-finalize"): Promise<void> {
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), `cotal-ordinary-reentry-${injection}-root-`)));
  const home = realpathSync.native(mkdtempSync(join(tmpdir(), `cotal-ordinary-reentry-${injection}-home-`)));
  const port = await freePort();
  const server = `nats://127.0.0.1:${port}`;
  const space = `backup_ordinary_${injection}`;
  const { run, env } = sandboxRun(root, home);
  const journalPath = join(root, ".cotal", "maintenance", "v1", "journal.json");
  try {
    assert.equal(run("up", "--detach", "--open", "--server", server, "--space", space).status, 0);
    assert.equal(run("down", "--preserve-state").status, 0);
    const interrupted = spawnSync(
      tsx,
      [cliPath, "up", "--detach", "--server", server, "--space", space],
      {
        cwd: root,
        env: {
          ...env,
          ...(injection === "resume-commit"
            ? { COTAL_SMOKE_EXIT_AFTER_RESUME_COMMIT: "1" }
            : { COTAL_SMOKE_EXIT_AFTER_RESUME_FINALIZE: "1" }),
        },
        encoding: "utf8",
        timeout: 240_000,
      },
    );
    assert.equal(interrupted.status, injection === "resume-commit" ? 89 : 91,
      `${injection} ordinary resume interruption\nstdout:\n${interrupted.stdout}\nstderr:\n${interrupted.stderr}`);
    const committed = JSON.parse(readFileSync(journalPath, "utf8")) as {
      state: string;
      managerCommit?: { state?: string; durableCommitToken?: string };
    };
    assert.equal(committed.state, "resume-committed");
    assert.equal(committed.managerCommit?.state, "awaitingFinalize");
    assert.match(committed.managerCommit?.durableCommitToken ?? "", /^[a-f0-9]{64}$/);

    const recovered = run("up", "--detach", "--server", server, "--space", space);
    assert.equal(recovered.status, 0,
      `${injection} ordinary resume recovery\nstdout:\n${recovered.stdout}\nstderr:\n${recovered.stderr}`);
    assert.equal(existsSync(journalPath), false, "finalized ordinary resume retires and consumes maintenance state");
    assert.equal(run("down").status, 0);
  } finally {
    run("down");
    rmSync(root, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  }
}

async function deadBoundListenerReplacementScenario(): Promise<void> {
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), "cotal-dead-listener-replacement-root-")));
  const home = realpathSync.native(mkdtempSync(join(tmpdir(), "cotal-dead-listener-replacement-home-")));
  const artifact = join(root, "registry-backup");
  const port = await freePort();
  const server = `nats://127.0.0.1:${port}`;
  const space = "backup_dead_listener_replacement";
  const { run, env } = sandboxRun(root, home);
  const journalPath = join(root, ".cotal", "maintenance", "v1", "journal.json");
  try {
    assert.equal(run("up", "--detach", "--open", "--server", server, "--space", space).status, 0);
    assert.equal(run("down", "--preserve-state").status, 0);
    assert.equal(run("backup", "create", artifact, "--only", "registry").status, 0);
    const interrupted = spawnSync(
      tsx,
      [cliPath, "up", "--restore", artifact, "--detach", "--server", server, "--space", space],
      { cwd: root, env: { ...env, COTAL_SMOKE_EXIT_AFTER_RESTORE_LISTENER_BIND: "1" }, encoding: "utf8", timeout: 240_000 },
    );
    assert.equal(interrupted.status, 86);
    const first = JSON.parse(readFileSync(journalPath, "utf8")) as {
      listenerProof: { serverNonce: string; processOwner: { pid: number } };
    };
    process.kill(first.listenerProof.processOwner.pid, "SIGTERM");
    await waitUntil(async () => !(await probeConnect(server, { timeoutMs: 200 })).ok, "dead bound listener shutdown");

    const recovered = run("up", "--detach", "--server", server, "--space", space);
    assert.equal(recovered.status, 0, `dead listener replacement\nstdout:\n${recovered.stdout}\nstderr:\n${recovered.stderr}`);
    const active = JSON.parse(readFileSync(journalPath, "utf8")) as {
      state: string;
      listenerProof: { serverNonce: string; processOwner: { pid: number } };
      listenerReplacements: Array<{ proof: { serverNonce: string; processOwner: { pid: number } } }>;
    };
    assert.equal(active.state, "active");
    assert.notEqual(active.listenerProof.serverNonce, first.listenerProof.serverNonce);
    assert.notEqual(active.listenerProof.processOwner.pid, first.listenerProof.processOwner.pid);
    assert.equal(active.listenerReplacements.length, 1);
    assert.equal(active.listenerReplacements[0]?.proof.serverNonce, first.listenerProof.serverNonce);
    assert.equal(run("down").status, 0);
  } finally {
    run("down");
    rmSync(root, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  }
}

async function unboundRestoreReentryScenario(detached: boolean): Promise<void> {
  const label = detached ? "detached" : "foreground";
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), `cotal-restore-unbound-${label}-root-`)));
  const home = realpathSync.native(mkdtempSync(join(tmpdir(), `cotal-restore-unbound-${label}-home-`)));
  const artifact = join(root, "registry-backup");
  const port = await freePort();
  const server = `nats://127.0.0.1:${port}`;
  const space = `backup_unbound_${label}`;
  const { run, env } = sandboxRun(root, home);
  const journalPath = join(root, ".cotal", "maintenance", "v1", "journal.json");
  const pidPath = join(root, ".cotal", "nats.pid");
  let listenerPid: number | undefined;
  try {
    assert.equal(run("up", "--detach", "--open", "--server", server, "--space", space).status, 0);
    assert.equal(run("down", "--preserve-state").status, 0);
    assert.equal(run("backup", "create", artifact, "--only", "registry").status, 0);
    const first = spawnSync(
      tsx,
      [cliPath, "up", "--restore", artifact, ...(detached ? ["--detach"] : []), "--server", server, "--space", space],
      { cwd: root, env: { ...env, COTAL_SMOKE_EXIT_AFTER_RESTORE_LISTENER_SPAWN: "1" }, encoding: "utf8", timeout: 240_000 },
    );
    assert.equal(first.status, 87, `${label} coordinator exits in the spawn-to-bind window\nstdout:\n${first.stdout}\nstderr:\n${first.stderr}`);
    listenerPid = Number(readFileSync(pidPath, "utf8"));
    await waitUntil(async () => (await probeConnect(server, { timeoutMs: 250 })).ok, `${label} unbound listener readiness`);
    const interrupted = JSON.parse(readFileSync(journalPath, "utf8")) as { state: string; listenerProof?: unknown };
    assert.equal(interrupted.state, "commit-intent");
    assert.equal(interrupted.listenerProof, undefined, "spawn-to-bind crash has no invented proof");

    const refused = run("up", ...(detached ? ["--detach"] : []), "--server", server, "--space", space);
    assert.notEqual(refused.status, 0);
    assert.match(refused.stderr, /re-entry has no bound listener proof/);
    assert.equal((JSON.parse(readFileSync(journalPath, "utf8")) as { state: string }).state, "degraded");
  } finally {
    if (listenerPid) {
      try { process.kill(listenerPid, "SIGTERM"); } catch { /* already gone */ }
      await waitUntil(async () => !(await probeConnect(server, { timeoutMs: 200 })).ok, `${label} unbound listener shutdown`).catch(() => {});
    }
    run("down");
    rmSync(root, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  }
}

async function boundForeignListenerScenario(): Promise<void> {
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), "cotal-bound-foreign-root-")));
  const home = realpathSync.native(mkdtempSync(join(tmpdir(), "cotal-bound-foreign-home-")));
  const artifact = join(root, "registry-backup");
  const port = await freePort();
  const server = `nats://127.0.0.1:${port}`;
  const space = "backup_bound_foreign";
  const { run, env } = sandboxRun(root, home);
  const journalPath = join(root, ".cotal", "maintenance", "v1", "journal.json");
  let foreign: ChildProcess | undefined;
  try {
    assert.equal(run("up", "--detach", "--open", "--server", server, "--space", space).status, 0);
    assert.equal(run("down", "--preserve-state").status, 0);
    assert.equal(run("backup", "create", artifact, "--only", "registry").status, 0);
    const failed = spawnSync(
      tsx,
      [cliPath, "up", "--restore", artifact, "--detach", "--server", server, "--space", space],
      { cwd: root, env: { ...env, COTAL_SMOKE_FAIL_AFTER_RESTORE_LISTENER_READY: "1" }, stdio: "ignore", timeout: 240_000 },
    );
    assert.notEqual(failed.status, 0);
    const degraded = JSON.parse(readFileSync(journalPath, "utf8")) as {
      listenerProof: { serverNonce: string; processOwner: { pid: number; id: string } };
    };
    process.kill(degraded.listenerProof.processOwner.pid, "SIGTERM");
    await waitUntil(async () => !(await probeConnect(server, { timeoutMs: 200 })).ok, "bound listener shutdown");
    foreign = await occupy(port);
    const refused = run("up", "--detach", "--server", server, "--space", space);
    assert.notEqual(refused.status, 0);
    assert.match(refused.stderr, /occupied foreign listener/);
    const unchanged = JSON.parse(readFileSync(journalPath, "utf8")) as { state: string; listenerReplacements?: unknown };
    assert.equal(unchanged.state, "degraded");
    assert.equal(unchanged.listenerReplacements, undefined, "foreign listener refusal does not retire the recorded dead proof");
    await closeServer(foreign);
    foreign = undefined;
    const recovered = run("up", "--detach", "--server", server, "--space", space);
    assert.equal(recovered.status, 0, `degraded dead-listener replacement\nstdout:\n${recovered.stdout}\nstderr:\n${recovered.stderr}`);
    const active = JSON.parse(readFileSync(journalPath, "utf8")) as { state: string; listenerReplacements?: unknown[] };
    assert.equal(active.state, "active");
    assert.equal(active.listenerReplacements?.length, 1, "degraded dead owner is retired before fresh activation");
    assert.equal(run("down").status, 0);
  } finally {
    if (foreign) await closeServer(foreign).catch(() => {});
    run("down");
    rmSync(root, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  }
}

async function missingPidfileListenerScenario(): Promise<void> {
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), "cotal-missing-pid-listener-root-")));
  const home = realpathSync.native(mkdtempSync(join(tmpdir(), "cotal-missing-pid-listener-home-")));
  const artifact = join(root, "registry-backup");
  const port = await freePort();
  const server = `nats://127.0.0.1:${port}`;
  const space = "backup_missing_pid_listener";
  const { run } = sandboxRun(root, home);
  const pidPath = join(root, ".cotal", "nats.pid");
  const journalPath = join(root, ".cotal", "maintenance", "v1", "journal.json");
  let foreign: ChildProcess | undefined;
  try {
    assert.equal(run("up", "--detach", "--open", "--server", server, "--space", space).status, 0);
    assert.equal(run("channel", "set", "preserved", "--desc", "listener probe", "--space", space).status, 0);
    const brokerPid = Number(readFileSync(pidPath, "utf8"));
    rmSync(pidPath);
    const refusedCut = run("down", "--preserve-state");
    assert.notEqual(refusedCut.status, 0, "a pidless live broker cannot become a ready cut");
    assert.match(refusedCut.stderr, /recorded NATS endpoint .* no listener/);
    // The manager's commitment is journaled BEFORE any stop, so the failed cut parks at the
    // durable cut-committed boundary and the retry below recovers without a live manager.
    assert.equal((JSON.parse(readFileSync(journalPath, "utf8")) as { state: string }).state, "cut-committed");
    process.kill(brokerPid, "SIGTERM");
    await waitUntil(async () => (await probeConnect(server, { timeoutMs: 200 })).ok === false, "pidless broker shutdown");
    const finished = run("down", "--preserve-state");
    assert.equal(finished.status, 0, `cut retry with stopped manager\nstdout:\n${finished.stdout}\nstderr:\n${finished.stderr}`);
    assert.equal((JSON.parse(readFileSync(journalPath, "utf8")) as { state: string }).state, "ready");

    foreign = await occupy(port);
    const refusedBackup = run("backup", "create", artifact, "--only", "registry");
    assert.equal(refusedBackup.status, 2, "backup refuses a pidless listener immediately before cloning, exit 2");
    assert.match(refusedBackup.stderr, /recorded NATS endpoint .* no listener; a process there may still be changing the preserved store, so nothing was copied/);
    assert.match(refusedBackup.stderr, /CONFLICT/, "it is a CONFLICT, as restore and resume refuse it");
    assert.ok(refusedBackup.stderr.includes(`stop the process that listens on ${server}, then run cotal backup create ${artifact} --only registry again`), `its Next says to stop that process and names the same create\n${refusedBackup.stderr}`);
    assert.equal(existsSync(artifact), false, "listener refusal happens before artifact creation");
    await closeServer(foreign);
    foreign = undefined;
  } finally {
    if (foreign) await closeServer(foreign).catch(() => {});
    run("down");
    rmSync(root, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  }
}

async function preservationCommitCrashScenario(): Promise<void> {
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), "cotal-preserve-commit-crash-root-")));
  const home = realpathSync.native(mkdtempSync(join(tmpdir(), "cotal-preserve-commit-crash-home-")));
  const port = await freePort();
  const server = `nats://127.0.0.1:${port}`;
  const space = "backup_preserve_commit_crash";
  const { run, env, sandbox } = sandboxRun(root, home);
  const journalPath = join(root, ".cotal", "maintenance", "v1", "journal.json");
  try {
    assert.equal(run("up", "--detach", "--open", "--server", server, "--space", space).status, 0);
    const interruptOptions = {
      cwd: root,
      env: { ...env, COTAL_SMOKE_EXIT_AFTER_PRESERVATION_MANAGER_COMMIT: "1" },
      encoding: "utf8" as const,
      timeout: 240_000,
    };
    assertSmokeSandboxDown(sandbox, ["down", "--preserve-state"], interruptOptions);
    const interrupted = spawnSync(tsx, [cliPath, "down", "--preserve-state"], interruptOptions);
    assert.equal(interrupted.status, 90);
    assert.equal((JSON.parse(readFileSync(journalPath, "utf8")) as { state: string }).state, "cut-committed");
    const recovered = run("down", "--preserve-state");
    assert.equal(recovered.status, 0, `post-manager-commit cut recovery\nstdout:\n${recovered.stdout}\nstderr:\n${recovered.stderr}`);
    assert.equal((JSON.parse(readFileSync(journalPath, "utf8")) as { state: string }).state, "ready");
  } finally {
    run("down");
    rmSync(root, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  }
}

/** The coordinator dies in the window between the manager stopping its children and the cut-committed
 *  journal write, THEN the manager dies. The commit-intent marker lets recovery finish the cut forward
 *  instead of deleting it and losing the retained inventory. A crash one step EARLIER (before the
 *  marker, genuinely pre-commit) must still abort — proving the recovery is surgical, not eager. */
async function preservationStopCrashRecoveryScenario(): Promise<void> {
  const alive = (pid: number): boolean => { try { process.kill(pid, 0); return true; } catch (e) { return (e as NodeJS.ErrnoException).code === "EPERM"; } };
  const bootAndCrash = async (suffix: string, hook: string): Promise<{ root: string; home: string; server: string; space: string; run: (...a: string[]) => SpawnSyncReturns<string>; journalPath: string }> => {
    const root = realpathSync.native(mkdtempSync(join(tmpdir(), `cotal-preserve-stop-${suffix}-root-`)));
    const home = realpathSync.native(mkdtempSync(join(tmpdir(), `cotal-preserve-stop-${suffix}-home-`)));
    const port = await freePort();
    const server = `nats://127.0.0.1:${port}`;
    const space = `backup_preserve_stop_${suffix}`;
    const { run, env, sandbox } = sandboxRun(root, home);
    const journalPath = join(root, ".cotal", "maintenance", "v1", "journal.json");
    assert.equal(run("up", "--detach", "--open", "--server", server, "--space", space).status, 0, `${suffix} up`);
    const mgrPid = Number(readFileSync(canonicalLocalProcessPath(MANAGER_PIDFILE, { root, space }), "utf8").trim());
    const crashOptions = { cwd: root, env: { ...env, [hook]: "1" }, encoding: "utf8" as const, timeout: 240_000 };
    assertSmokeSandboxDown(sandbox, ["down", "--preserve-state"], crashOptions);
    const crashed = spawnSync(tsx, [cliPath, "down", "--preserve-state"], crashOptions);
    assert.equal((JSON.parse(readFileSync(journalPath, "utf8")) as { state: string }).state, "cut-intent", `${suffix} parked at cut-intent`);
    if (alive(mgrPid)) process.kill(mgrPid, "SIGKILL");
    await waitUntil(() => !alive(mgrPid), `${suffix} manager dead`);
    return { root, home, server, space, run, journalPath };
  };

  // Case A — the fix: crash AFTER the manager committed (children stopped). Recovery must NOT delete
  // the journal; it finishes the cut forward to ready with the inventory intact.
  const a = await bootAndCrash("commit", "COTAL_SMOKE_EXIT_AFTER_MANAGER_STOP_BEFORE_JOURNAL");
  try {
    const recovered = a.run("down", "--preserve-state");
    assert.equal(recovered.status, 0, `stop-window cut recovery\nstdout:\n${recovered.stdout}\nstderr:\n${recovered.stderr}`);
    assert.equal(existsSync(a.journalPath), true, "the preserved cut journal survives recovery (not deleted)");
    assert.equal((JSON.parse(readFileSync(a.journalPath, "utf8")) as { state: string }).state, "ready");
  } finally {
    a.run("down");
    rmSync(a.root, { recursive: true, force: true });
    rmSync(a.home, { recursive: true, force: true });
  }

  // Case B — surgical: crash BEFORE the commit-intent marker (genuinely pre-commit, nothing stopped).
  // Recovery must still abort, not finish forward.
  const b = await bootAndCrash("precommit", "COTAL_SMOKE_EXIT_AFTER_CUT_INTENT_BEFORE_COMMIT");
  try {
    const aborted = b.run("down", "--preserve-state");
    assert.notEqual(aborted.status, 0, "a genuinely pre-commit crash still aborts, not finishes forward");
    assert.match(aborted.stderr, /lost its manager before commit; the cut intent was aborted/);
    assert.equal(existsSync(b.journalPath), false, "the pre-commit cut is abandoned (nothing was stopped)");
  } finally {
    b.run("down");
    rmSync(b.root, { recursive: true, force: true });
    rmSync(b.home, { recursive: true, force: true });
  }
}

/** Command races against a pre-commit restore: a live claim refuses ordinary up, repeated restore,
 *  and explicit rollback; a provably stale claim is recoverable by the explicit clean command. */
async function restoreClaimRaceScenario(): Promise<void> {
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), "cotal-restore-claim-race-root-")));
  const home = realpathSync.native(mkdtempSync(join(tmpdir(), "cotal-restore-claim-race-home-")));
  const artifact = join(root, "registry-backup");
  const port = await freePort();
  const server = `nats://127.0.0.1:${port}`;
  const space = "backup_claim_race";
  const { run } = sandboxRun(root, home);
  try {
    assert.equal(run("up", "--detach", "--open", "--server", server, "--space", space).status, 0);
    assert.equal(run("down", "--preserve-state").status, 0);
    assert.equal(run("backup", "create", artifact, "--only", "registry").status, 0);

    // A live attempt: this smoke process is the recorded (alive) coordinator.
    const liveCoordinator: ProcessOwner = {
      pid: process.pid, host: hostname(), startedAt: new Date().toISOString(), id: "race-live-coordinator",
    };
    let lock = acquireMaintenanceLock(root);
    prepareAlternateRestore(lock, {
      attemptId: "race-live", targetPath: join(root, "race-target"),
      claim: { deadline: new Date(Date.now() + 600_000).toISOString(), coordinator: liveCoordinator },
    });
    releaseMaintenanceLock(lock);
    const refusedUp = run("up", "--detach", "--server", server, "--space", space);
    assert.notEqual(refusedUp.status, 0, "ordinary up refuses a live restore attempt");
    assert.match(refusedUp.stderr, /restore attempt race-live holds this root until [^,]+, and its restore process \d+ is still running/);
    const refusedRestore = run("up", "--restore", artifact, "--detach", "--server", server, "--space", space);
    assert.notEqual(refusedRestore.status, 0, "repeated restore refuses a live attempt");
    assert.match(refusedRestore.stderr, /restore attempt race-live holds this root until [^,]+, and its restore process \d+ is still running/);
    const refusedClean = run("clean", "restore-attempt", "--attempt", "race-live", "--force");
    assert.notEqual(refusedClean.status, 0, "explicit rollback refuses a live claim");
    assert.match(refusedClean.stderr, /claim is still live/);
    assert.equal(
      (JSON.parse(readFileSync(join(root, ".cotal", "maintenance", "v1", "journal.json"), "utf8")) as { state: string }).state,
      "restore-ready",
      "every refusal preserves the live attempt untouched",
    );
    lock = acquireMaintenanceLock(root);
    rollbackRestore(lock, { asCoordinator: liveCoordinator });
    releaseMaintenanceLock(lock);

    // A stale attempt: elapsed deadline, provably dead coordinator; the explicit command recovers.
    lock = acquireMaintenanceLock(root);
    prepareAlternateRestore(lock, {
      attemptId: "race-stale", targetPath: join(root, "race-target"),
      claim: {
        deadline: new Date(1).toISOString(),
        coordinator: { pid: 999_999, host: hostname(), startedAt: new Date(0).toISOString(), id: "race-dead-coordinator" },
      },
    });
    releaseMaintenanceLock(lock);
    const recovered = run("clean", "restore-attempt", "--attempt", "race-stale", "--force");
    assert.equal(recovered.status, 0, `stale attempt recovery\nstdout:\n${recovered.stdout}\nstderr:\n${recovered.stderr}`);
    assert.equal(readMaintenanceJournal(root)?.state, "ready", "explicit stale rollback returns the cut to ready");
    const resumed = run("up", "--detach", "--server", server, "--space", space);
    assert.equal(resumed.status, 0, `ordinary resume after recovery\nstdout:\n${resumed.stdout}\nstderr:\n${resumed.stderr}`);
    assert.equal(run("down").status, 0);
  } finally {
    run("down");
    rmSync(root, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  }
}

/** The migrated checkpoint shape passes backup validation again: backup → restore → backup → restore. */
async function backupRestoreCycleScenario(): Promise<void> {
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), "cotal-backup-cycle-root-")));
  const home = realpathSync.native(mkdtempSync(join(tmpdir(), "cotal-backup-cycle-home-")));
  const port = await freePort();
  const server = `nats://127.0.0.1:${port}`;
  const space = "backup_cycle";
  const { run, env } = sandboxRun(root, home);
  const must = (label: string, result: ReturnType<typeof run>) => {
    assert.equal(result.status, 0, `cycle ${label}\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
  };
  try {
    must("up", run("up", "--detach", "--server", server, "--space", space));
    must("seed registry", run("channel", "set", "cycled", "--desc", "survives two cycles", "--space", space));
    must("seed TASK durable", spawnSync(tsx, [taskSeedPath, root, server, space, "reviewer"], {
      cwd: join(worktree, "implementations", "cli"), env, encoding: "utf8", timeout: 30_000,
    }));
    const first = join(root, "cycle-backup-1");
    must("preserve cut 1", run("down", "--preserve-state"));
    const sourceDigest = (dir: string): string => {
      const hash = createHash("sha256");
      const walk = (path: string): void => {
        for (const name of readdirSync(path).sort()) {
          const child = join(path, name);
          const stat = lstatSync(child);
          if (stat.isDirectory()) walk(child);
          else hash.update(`${child}\n`).update(readFileSync(child)).update("\n");
        }
      };
      walk(dir);
      return hash.digest("hex");
    };
    const sourceStore = join(root, ".cotal", "nats");
    const untouched = sourceDigest(sourceStore);
    must("backup 1", run("backup", "create", first));
    assert.equal(sourceDigest(sourceStore), untouched, "backup never changes a byte of the preserved source store");
    must("restore 1", run("up", "--restore", first, "--detach", "--server", server, "--space", space));
    const journalPath = join(root, ".cotal", "maintenance", "v1", "journal.json");
    const restored = JSON.parse(readFileSync(journalPath, "utf8")) as { state: string; restore: { attemptId: string } };
    assert.equal(restored.state, "active");
    must("retire restore 1", run("clean", "restore-fallback", "--attempt", restored.restore.attemptId, "--force"));
    const second = join(root, "cycle-backup-2");
    must("preserve cut 2", run("down", "--preserve-state"));
    must("backup 2", run("backup", "create", second));
    const firstCheckpoints = JSON.parse(readFileSync(join(first, "checkpoints.json"), "utf8")) as Checkpoint[];
    const secondCheckpoints = JSON.parse(readFileSync(join(second, "checkpoints.json"), "utf8")) as Checkpoint[];
    assert.ok(secondCheckpoints.length >= firstCheckpoints.length, "restored durables validate as backup input again");
    assert.ok(secondCheckpoints.some((checkpoint) => checkpoint.stream === taskStream(space) && checkpoint.name === "svc_reviewer"));
    must("restore 2", run("up", "--restore", second, "--detach", "--server", server, "--space", space));
    const listed = run("channel", "--space", space);
    must("list twice-restored registry", listed);
    assert.match(listed.stdout, /#cycled/);
    must("down", run("down"));
  } finally {
    run("down");
    rmSync(root, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  }
}

/** A full restore of a backup made before a run's checkpoint was answered rolls the run back. It names
 *  the run and the reopened step in its receipt, in `status` and in the cleanup preview, reads the
 *  set-aside store only from a clone it removes, and the step accepts an answer again. */
async function rolledBackRunsScenario(): Promise<void> {
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), "cotal-backup-rolled-back-root-")));
  const home = realpathSync.native(mkdtempSync(join(tmpdir(), "cotal-backup-rolled-back-home-")));
  const port = await freePort();
  const server = `nats://127.0.0.1:${port}`;
  const space = "backup_rolled_back";
  const { run } = sandboxRun(root, home);
  const must = (label: string, result: ReturnType<typeof run>) => {
    assert.equal(result.status, 0, `rolled back ${label}\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
    return result;
  };
  const opens = async (runId: string, step: RegExp): Promise<void> => {
    for (const until = Date.now() + 60_000; Date.now() < until; await new Promise((done) => setTimeout(done, 250)))
      if (step.test(run("run", "show", runId, "--space", space).stdout)) return;
    assert.fail(`run ${runId} never opened ${step}\n${run("run", "show", runId, "--space", space).stdout}`);
  };
  try {
    must("up", run("up", "--detach", "--server", server, "--space", space));
    writeFileSync(join(root, "zahlung.js"), 'const z = await checkpoint("zahlung", "Bezahlen?");\nconst v = await checkpoint("versand", "Versenden?");\n');
    const runId = (JSON.parse(must("start", run("run", "start", "zahlung.js", "--space", space, "--json")).stdout) as { result?: { result?: { runId?: string } } }).result?.result?.runId ?? "";
    assert.match(runId, /^run-/);
    await opens(runId, /\/checkpoint:zahlung#0\s+Bezahlen\?/);
    must("preserve before the answer", run("down", "--preserve-state"));
    const artifact = join(root, "before-answer");
    must("backup", run("backup", "create", artifact));
    must("resume", run("up", "--detach", "--server", server, "--space", space));
    must("answer", run("run", "answer", runId, "/checkpoint:zahlung#0", "--value", '"ja"', "--space", space));
    await opens(runId, /\/checkpoint:versand#0\s+Versenden\?/);
    must("preserve after the answer", run("down", "--preserve-state"));
    const restored = must("restore", run("backup", "restore", artifact, "--json"));
    const note = `Run ${runId} went back to where this backup left it: /checkpoint:zahlung#0 was answered after that and is open again. That answer is only in the previous store.`;
    const rows = [{ run: runId, reopened: ["/checkpoint:zahlung#0"] }];
    const warning = (JSON.parse(restored.stdout) as { warnings: { code: string; message: string; target: { rolledBackRuns?: unknown } }[] }).warnings.find((entry) => entry.code === "NEWER_HISTORY_NOT_RESTORED");
    assert.ok(warning?.message.includes(note), `the receipt names the rolled-back run and its reopened step\n${restored.stdout}`);
    assert.deepEqual(warning?.target.rolledBackRuns, rows);
    const journal = JSON.parse(readFileSync(join(root, ".cotal", "maintenance", "v1", "journal.json"), "utf8")) as { restore: { attemptId: string }; launch: { rolledBackRuns?: unknown } };
    assert.deepEqual(journal.launch.rolledBackRuns, rows, "the restore journals the run it rolled back");
    const attemptId = journal.restore.attemptId;
    assert.ok(!readdirSync(join(root, ".cotal", "maintenance", "attempts")).some((name) => name.startsWith(`${attemptId}-clone`)), "the clone of the set-aside store is removed");
    const status = must("status", run("status", "--space", space));
    assert.ok(status.stdout.includes(note), `status names the rolled-back run\n${status.stdout}`);
    const preview = must("cleanup preview", run("backup", "cleanup-fallback", attemptId, "--dry-run"));
    assert.ok(preview.stdout.includes(note), `the cleanup preview names the rolled-back run\n${preview.stdout}`);
    // The reopened step is open again and accepts an answer.
    await opens(runId, /\/checkpoint:zahlung#0\s+Bezahlen\?/);
    must("answer again", run("run", "answer", runId, "/checkpoint:zahlung#0", "--value", '"nein"', "--space", space));
    must("down", run("down"));
  } finally {
    run("down");
    rmSync(root, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  }
}

/** A store moved behind a link, `.cotal/nats` -> another disk, and an artifact written through a
 *  linked folder. The cut records the store by its real path, so a default restore is a same-path
 *  restore there, not an alternate target equal to the source, and verify reads the linked artifact
 *  path at its real path, as create and restore do. */
async function linkedStoreScenario(): Promise<void> {
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), "cotal-backup-linked-root-")));
  const home = realpathSync.native(mkdtempSync(join(tmpdir(), "cotal-backup-linked-home-")));
  const server = `nats://127.0.0.1:${await freePort()}`;
  const space = "backup_linked";
  const { run } = sandboxRun(root, home);
  const must = (label: string, result: ReturnType<typeof run>) => {
    assert.equal(result.status, 0, `linked ${label}\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
  };
  const store = join(root, "disk2", "nats");
  try {
    mkdirSync(store, { recursive: true, mode: 0o700 });
    mkdirSync(join(root, ".cotal"), { recursive: true, mode: 0o700 });
    symlinkSync(store, join(root, ".cotal", "nats"));
    must("up", run("up", "--detach", "--server", server, "--space", space));
    must("seed registry", run("channel", "set", "linked", "--desc", "restored behind a link", "--space", space));
    must("preserve cut", run("down", "--preserve-state"));
    mkdirSync(join(root, "bkreal"), { mode: 0o700 });
    symlinkSync(join(root, "bkreal"), join(root, "bklink"));
    const artifact = join(root, "bklink", "one");
    must("backup through a linked folder", run("backup", "create", artifact));
    const verified = run("backup", "verify", artifact, "--json");
    must("verify through the linked folder", verified);
    assert.equal(JSON.parse(verified.stdout).result.directory, join(root, "bkreal", "one"), "verify reads the linked artifact at its real path");
    must("default restore onto the linked store", run("backup", "restore", artifact));
    assert.equal(readlinkSync(join(root, ".cotal", "nats")), store, "the restore leaves .cotal/nats linking to the store");
    const journal = JSON.parse(readFileSync(join(root, ".cotal", "maintenance", "v1", "journal.json"), "utf8")) as { state: string; restore: { method: string; targetPath: string } };
    assert.equal(journal.state, "active");
    assert.equal(journal.restore.method, "same-path", "a default restore onto a linked store replaces it in place");
    assert.equal(journal.restore.targetPath, store);
    const listed = run("channel", "--space", space);
    must("list the restored registry", listed);
    assert.match(listed.stdout, /#linked/);
    must("down", run("down"));
  } finally {
    run("down");
    rmSync(root, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  }
}

await missingPidfileListenerScenario();
await linkedStoreScenario();
await preservationCommitCrashScenario();
await preservationStopCrashRecoveryScenario();
await restoreClaimRaceScenario();
await backupRestoreCycleScenario();
await rolledBackRunsScenario();
await scenario("open");
await scenario("auth");
await occupiedRestoreScenario();
await restoreReentryScenario(true);
await restoreReentryScenario(false);
await restoreReentryScenario(true, true);
await restoreReentryScenario(true, false, "resume-preserved");
await restoreReentryScenario(true, false, "resume-commit");
await restoreReentryScenario(true, false, "resume-finalize");
await ordinaryResumeReentryScenario("resume-commit");
await ordinaryResumeReentryScenario("resume-finalize");
await deadBoundListenerReplacementScenario();
await unboundRestoreReentryScenario(true);
await unboundRestoreReentryScenario(false);
await boundForeignListenerScenario();
console.log("backup/restore live smoke: ok");
