/** Live full/registry backup, restore, isolation, checkpoint, and ordinary-resume lifecycle. */
import assert from "node:assert/strict";
import { spawn, spawnSync, type ChildProcess, type SpawnSyncReturns } from "node:child_process";
import { createHash } from "node:crypto";
import { createServer, type AddressInfo } from "node:net";
import { cpSync, existsSync, lstatSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { hostname } from "node:os";
import { createSpaceAuth, mintCreds, newIdentity, probeConnect, rotateSystemAccount, taskStream } from "@cotal-ai/core";
import {
  acquireMaintenanceLock,
  authDir,
  loadSpaceAuth,
  prepareAlternateRestore,
  readMaintenanceJournal,
  releaseMaintenanceLock,
  rollbackRestore,
  saveSpaceAuth,
  type ProcessOwner,
} from "@cotal-ai/workspace";
import {
  connectIsolatedBroker,
  createAttemptClone,
  startIsolatedBroker,
} from "../../implementations/cli/src/lib/isolated-broker.js";

const freePort = () => new Promise<number>((resolvePort, reject) => {
  const server = createServer();
  server.once("error", reject);
  server.listen(0, "127.0.0.1", () => {
    const port = (server.address() as AddressInfo).port;
    server.close((error) => error ? reject(error) : resolvePort(port));
  });
});

const occupy = async (port: number): Promise<ChildProcess> => {
  const child = spawn("nats-server", ["-p", String(port), "-a", "127.0.0.1"], { stdio: "ignore" });
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

interface Checkpoint { stream: string; name: string }

async function scenario(mode: "open" | "auth"): Promise<void> {
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), `cotal-backup-restore-${mode}-root-`)));
  const home = realpathSync.native(mkdtempSync(join(tmpdir(), `cotal-backup-restore-${mode}-home-`)));
  const artifact = join(root, "full-backup");
  const registryArtifact = join(root, "registry-backup");
  const port = await freePort();
  const server = `nats://127.0.0.1:${port}`;
  const space = `backup_live_${mode}`;
  const env = { ...process.env, COTAL_HOME: home };
  const run = (...args: string[]) => spawnSync(tsx, [cliPath, ...args], { cwd: root, env, encoding: "utf8", timeout: 240_000 });
  const must = (label: string, result: ReturnType<typeof run>) => {
    assert.equal(result.status, 0, `${mode} ${label}\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
  };

  try {
    must("up", run("up", "--detach", ...(mode === "open" ? ["--open"] : []), "--server", server, "--space", space));
    must("seed registry", run("channels", "set", "preserved", "--desc", "survives", "--space", space));
    if (mode === "auth") {
      must("seed TASK durable", spawnSync(tsx, [taskSeedPath, root, server, space, "reviewer"], {
        cwd: join(worktree, "implementations", "cli"), env, encoding: "utf8", timeout: 30_000,
      }));
    }
    must("preserve cut", run("down", "--preserve-state"));
    const ready = JSON.parse(readFileSync(join(root, ".cotal", "maintenance", "v1", "journal.json"), "utf8")) as { state: string };
    assert.equal(ready.state, "ready");

    if (mode === "auth") {
      const auth = loadSpaceAuth(authDir(root));
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
    const originalCheckpoints = JSON.parse(readFileSync(join(artifact, "checkpoints.json"), "utf8")) as Checkpoint[];
    if (mode === "auth") {
      assert.ok(originalCheckpoints.length >= 3, "authenticated backup captured Plane-3 and TASK checkpoints");
      assert.ok(originalCheckpoints.some((checkpoint) => checkpoint.stream === taskStream(space) && checkpoint.name === "svc_reviewer"));

      const authPath = join(root, ".cotal", "auth", "auth.json");
      const journalPath = join(root, ".cotal", "maintenance", "v1", "journal.json");
      const attemptsPath = join(root, ".cotal", "maintenance", "attempts");
      const originalAuthText = readFileSync(authPath, "utf8");
      const originalAuth = JSON.parse(originalAuthText) as Record<string, any>;
      const foreignAuth = await createSpaceAuth(`${space}_foreign`);
      const journalBefore = readFileSync(journalPath, "utf8");
      const sourceBefore = lstatSync(join(root, ".cotal", "nats"), { bigint: true });
      rmSync(attemptsPath, { recursive: true, force: true });
      assert.equal(existsSync(attemptsPath), false, "malformed-auth preflight begins without an attempts directory");
      const malformed: Array<[string, (auth: Record<string, any>) => void, RegExp]> = [
        ["public nkey", (auth) => { auth.account.pub = "not-an-account-key"; }, /invalid encoded key|valid account public nkey/],
        ["seed mismatch", (auth) => { auth.account.seed = auth.account.signingSeed; }, /account\.seed does not match account\.pub/],
        ["JWT", (auth) => { auth.account.jwt = "not-a-jwt"; }, /currently valid signed NATS JWT/],
        ["untrusted signer", (auth) => {
          auth.account.signingSeed = foreignAuth.account.signingSeed;
          auth.account.signingPub = foreignAuth.account.signingPub;
        }, /active account signing key is not trusted/],
        ["wrong space", (auth) => { auth.space = `${space}_wrong`; }, /does not match expected space/],
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

      const validBeforeDrift = loadSpaceAuth(authDir(root));
      assert.ok(validBeforeDrift);
      const rotatedSystem = await rotateSystemAccount(validBeforeDrift);
      assert.equal(rotatedSystem.account.pub, validBeforeDrift.account.pub);
      saveSpaceAuth(authDir(root), rotatedSystem);
      const driftedRoot = run("up", "--restore", artifact, "--detach", "--server", server, "--space", space);
      assert.notEqual(driftedRoot.status, 0, "valid root-chain drift must refuse a full restore");
      assert.match(driftedRoot.stderr, /authority fingerprint does not match current trust state/);
      assert.equal(readFileSync(journalPath, "utf8"), journalBefore, "root-chain drift leaves the ready journal byte-identical");
      const sourceAfterDrift = lstatSync(join(root, ".cotal", "nats"), { bigint: true });
      assert.equal(sourceAfterDrift.dev, sourceBefore.dev);
      assert.equal(sourceAfterDrift.ino, sourceBefore.ino);
      writeFileSync(authPath, originalAuthText);

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
    assert.notEqual(nestedArtifact.status, 0);
    assert.match(nestedArtifact.stderr, /artifact must not overlap the maintenance attempt directory/);
    rmSync(attemptArtifact, { recursive: true });
    const nestedTarget = run(
      "up", "--restore", artifact, "--store-dir", join(artifact, "target"), "--detach",
      "--server", server, "--space", space,
    );
    assert.notEqual(nestedTarget.status, 0);
    assert.match(nestedTarget.stderr, /target must not overlap the backup artifact/);
    if (mode === "open") {
      const occupied = await occupy(port);
      const blocked = run("up", "--detach", "--server", server, "--space", space);
      assert.notEqual(blocked.status, 0);
      assert.match(blocked.stderr, /refuses the (?:unproven )?occupied listener/);
      const degraded = JSON.parse(readFileSync(join(root, ".cotal", "maintenance", "v1", "journal.json"), "utf8")) as { state: string };
      assert.equal(degraded.state, "resume-degraded");
      await closeServer(occupied);
    }
    must("ordinary same-principal resume", run("up", "--detach", "--server", server, "--space", space));
    assert.equal(existsSync(join(root, ".cotal", "maintenance", "v1", "journal.json")), false, "ordinary resume retires and consumes maintenance state");
    must("preserve again for restore", run("down", "--preserve-state"));

    const restoreArtifact = mode === "open" ? registryArtifact : artifact;
    must("restore", run("up", "--restore", restoreArtifact, "--detach", "--server", server, "--space", space));
    const listed = run("channels", "list", "--space", space);
    must("list restored registry", listed);
    assert.match(listed.stdout, /#preserved/);
    const active = JSON.parse(readFileSync(join(root, ".cotal", "maintenance", "v1", "journal.json"), "utf8")) as {
      state: string;
      restore: { attemptId: string };
    };
    assert.equal(active.state, "active");
    must("down", run("down"));
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
    must("cleanup fallback", run("clean", "restore-fallback", "--attempt", active.restore.attemptId, "--force"));
    assert.equal(existsSync(join(root, ".cotal", "maintenance", "v1", "journal.json")), false, "fallback cleanup retires the restore journal");
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
  const env = { ...process.env, COTAL_HOME: home };
  const run = (...args: string[]) => spawnSync(tsx, [cliPath, ...args], { cwd: root, env, encoding: "utf8", timeout: 240_000 });
  let occupied: ChildProcess | undefined;
  try {
    assert.equal(run("up", "--detach", "--open", "--server", server, "--space", space).status, 0);
    assert.equal(run("down", "--preserve-state").status, 0);
    assert.equal(run("backup", "create", artifact, "--only", "registry").status, 0);
    occupied = await occupy(port);
    const blocked = run("up", "--restore", artifact, "--detach", "--server", server, "--space", space);
    assert.notEqual(blocked.status, 0);
    assert.match(blocked.stderr, /refuses the (?:unproven )?occupied listener/);
    const journal = JSON.parse(readFileSync(join(root, ".cotal", "maintenance", "v1", "journal.json"), "utf8")) as { state: string };
    assert.equal(journal.state, "degraded");
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
  const env = { ...process.env, COTAL_HOME: home };
  const run = (...args: string[]) => spawnSync(tsx, [cliPath, ...args], { cwd: root, env, encoding: "utf8", timeout: 240_000 });
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
  const env = { ...process.env, COTAL_HOME: home };
  const run = (...args: string[]) => spawnSync(tsx, [cliPath, ...args], { cwd: root, env, encoding: "utf8", timeout: 240_000 });
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
  const env = { ...process.env, COTAL_HOME: home };
  const run = (...args: string[]) => spawnSync(tsx, [cliPath, ...args], { cwd: root, env, encoding: "utf8", timeout: 240_000 });
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
  const env = { ...process.env, COTAL_HOME: home };
  const run = (...args: string[]) => spawnSync(tsx, [cliPath, ...args], { cwd: root, env, encoding: "utf8", timeout: 240_000 });
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
  const env = { ...process.env, COTAL_HOME: home };
  const run = (...args: string[]) => spawnSync(tsx, [cliPath, ...args], { cwd: root, env, encoding: "utf8", timeout: 240_000 });
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
  const env = { ...process.env, COTAL_HOME: home };
  const run = (...args: string[]) => spawnSync(tsx, [cliPath, ...args], { cwd: root, env, encoding: "utf8", timeout: 240_000 });
  const pidPath = join(root, ".cotal", "nats.pid");
  const journalPath = join(root, ".cotal", "maintenance", "v1", "journal.json");
  let foreign: ChildProcess | undefined;
  try {
    assert.equal(run("up", "--detach", "--open", "--server", server, "--space", space).status, 0);
    assert.equal(run("channels", "set", "preserved", "--desc", "listener probe", "--space", space).status, 0);
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
    assert.notEqual(refusedBackup.status, 0, "backup refuses a pidless listener immediately before cloning");
    assert.match(refusedBackup.stderr, /recorded NATS endpoint .* no listener/);
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
  const env = { ...process.env, COTAL_HOME: home };
  const run = (...args: string[]) => spawnSync(tsx, [cliPath, ...args], { cwd: root, env, encoding: "utf8", timeout: 240_000 });
  const journalPath = join(root, ".cotal", "maintenance", "v1", "journal.json");
  try {
    assert.equal(run("up", "--detach", "--open", "--server", server, "--space", space).status, 0);
    const interrupted = spawnSync(tsx, [cliPath, "down", "--preserve-state"], {
      cwd: root,
      env: { ...env, COTAL_SMOKE_EXIT_AFTER_PRESERVATION_MANAGER_COMMIT: "1" },
      encoding: "utf8",
      timeout: 240_000,
    });
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
    const env = { ...process.env, COTAL_HOME: home };
    const run = (...args: string[]) => spawnSync(tsx, [cliPath, ...args], { cwd: root, env, encoding: "utf8", timeout: 240_000 });
    const journalPath = join(root, ".cotal", "maintenance", "v1", "journal.json");
    assert.equal(run("up", "--detach", "--open", "--server", server, "--space", space).status, 0, `${suffix} up`);
    const mgrPid = Number(readFileSync(join(root, ".cotal", "manager.pid"), "utf8").trim());
    const crashed = spawnSync(tsx, [cliPath, "down", "--preserve-state"],
      { cwd: root, env: { ...env, [hook]: "1" }, encoding: "utf8", timeout: 240_000 });
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
  const env = { ...process.env, COTAL_HOME: home };
  const run = (...args: string[]) => spawnSync(tsx, [cliPath, ...args], { cwd: root, env, encoding: "utf8", timeout: 240_000 });
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
    assert.match(refusedUp.stderr, /restore attempt race-live is in progress/);
    const refusedRestore = run("up", "--restore", artifact, "--detach", "--server", server, "--space", space);
    assert.notEqual(refusedRestore.status, 0, "repeated restore refuses a live attempt");
    assert.match(refusedRestore.stderr, /restore attempt race-live is in progress/);
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
  const env = { ...process.env, COTAL_HOME: home };
  const run = (...args: string[]) => spawnSync(tsx, [cliPath, ...args], { cwd: root, env, encoding: "utf8", timeout: 240_000 });
  const must = (label: string, result: ReturnType<typeof run>) => {
    assert.equal(result.status, 0, `cycle ${label}\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
  };
  try {
    must("up", run("up", "--detach", "--server", server, "--space", space));
    must("seed registry", run("channels", "set", "cycled", "--desc", "survives two cycles", "--space", space));
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
    const listed = run("channels", "list", "--space", space);
    must("list twice-restored registry", listed);
    assert.match(listed.stdout, /#cycled/);
    must("down", run("down"));
  } finally {
    run("down");
    rmSync(root, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  }
}

await missingPidfileListenerScenario();
await preservationCommitCrashScenario();
await preservationStopCrashRecoveryScenario();
await restoreClaimRaceScenario();
await backupRestoreCycleScenario();
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
