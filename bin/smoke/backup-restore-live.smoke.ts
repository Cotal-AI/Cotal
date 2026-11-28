/** Live full/registry backup, restore, isolation, checkpoint, and ordinary-resume lifecycle, the disaster restore of a lost custom store, the bare `up` that reopens a restored store its record no longer names, the runs a restore of an older backup rolled back, the other account a restore leaves in the store it set aside, the `up -f` refusal while a restore is active, and the refusal of any `up` while its broker runs. */
import assert from "node:assert/strict";
import { spawn, spawnSync, type ChildProcess, type SpawnSyncReturns } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, readlinkSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, relative, resolve } from "node:path";
import { hostname } from "node:os";
import { aclBucket, channelBucket, chatStream, commitAcl, createSpaceAuth, dmDurableConfig, dmStream, eventPayloadStream, mintCreds, mintLifecycleUid, newIdentity, openAclRegistry, probeConnect, readAcl, rotateSystemAccount, standaloneConnectOpts, taskStream, type PersistentConsumerCheckpoint, type SpaceAuth } from "@cotal-ai/core";
import { canonicalBackupStreamConfig, downloadStreamSnapshot, openRecordsBucket, pluginFanoutDurableConfig, recordsBucket, spacePluginStreams } from "@cotal-ai/core";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { DeliverPolicy, jetstream, jetstreamManager, type JetStreamManager } from "@nats-io/jetstream";
import { connect, type NatsConnection } from "@nats-io/transport-node";
import type { BackupManifest } from "../../implementations/cli/src/lib/backup-artifact.js";
import {
  acquireMaintenanceLock,
  authDir,
  canonicalLocalProcessPath,
  identityPinPath,
  MANAGER_PIDFILE,
  brokerAuthPath,
  loadSoleSpaceAuth,
  prepareAlternateRestore,
  readMaintenanceJournal,
  releaseMaintenanceLock,
  resolveOnPath,
  rollbackRestore,
  saveSpaceAuth,
  shellPath,
  spaceAccountPath,
  verifyIdentityPin,
  writePidPair,
  type ProcessOwner,
} from "@cotal-ai/workspace";
import {
  connectIsolatedBroker,
  createAttemptClone,
  startIsolatedBroker,
} from "../../implementations/cli/src/lib/isolated-broker.js";
import { assertSmokeSandboxDown, freePort, recordSmokeSandbox, SMOKE_BROKER_TOKEN, teardownOnSignal, type SmokeSandboxAnchor } from "@cotal-ai/smoke-kit";
import { openSigned } from "../../packages/core/smoke/_snapshot-ack.js";
import { PLUGIN_CHANNEL_ROOT, PLUGIN_FANOUT_DURABLE, pluginChannelSubject } from "../../packages/core/src/plugin-channel-route.js";
import { PLUGIN_CHANNEL_SPACE_STATE_KEY, pluginChannelSpaceStateSubject } from "../../packages/core/src/plugin-channel-space-state.js";

process.env.DO_NOT_TRACK = "1";

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

async function disconnectedMcpInbox(root: string, env: NodeJS.ProcessEnv, server: string, space: string): Promise<string> {
  const client = new Client({ name: "backup-smoke", version: "1" });
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [join(worktree, "bin", "dist", "cotal.js"), "mcp", "--space", space],
    cwd: root,
    env: Object.fromEntries(Object.entries(env).filter((entry): entry is [string, string] => entry[1] !== undefined)),
  });
  try {
    await client.connect(transport);
    const reply = await client.callTool({ name: "cotal_connect", arguments: { name: "reader" } });
    assert.ok(!reply.isError, JSON.stringify(reply));
  } finally {
    await client.close();
  }
  const nc = await connect({ servers: server });
  try {
    const inboxes = await (await jetstreamManager(nc)).consumers.list(dmStream(space)).next();
    assert.equal(inboxes.length, 1, "the disconnected seat left its inbox at the cut");
    assert.equal(inboxes[0].config.inactive_threshold, 600_000_000_000);
    return inboxes[0].name;
  } finally {
    await nc.close();
  }
}

async function withDmManager<T>(server: string, auth: SpaceAuth | undefined, read: (jsm: JetStreamManager) => Promise<T>): Promise<T> {
  const creds = auth && await mintCreds(auth, newIdentity(), "provisioner");
  const nc = await connect({ servers: server, ...standaloneConnectOpts({ creds, tls: false }) });
  try {
    return await read(await jetstreamManager(nc));
  } finally {
    await nc.close();
  }
}

async function assertRestoredDm(server: string, checkpoint: PersistentConsumerCheckpoint, auth?: SpaceAuth): Promise<void> {
  const { config } = await withDmManager(server, auth, (jsm) => jsm.consumers.info(checkpoint.stream, checkpoint.name));
  assert.equal(config.inactive_threshold, auth ? undefined : 600_000_000_000, "the restored DM inbox has the space's expiry policy");
  assert.equal(config.deliver_policy, DeliverPolicy.StartSequence);
  assert.equal(config.opt_start_seq, Math.max(checkpoint.ackFloorStreamSequence + 1, checkpoint.creationLowerBound, checkpoint.streamState.first_seq || 1));
}

async function seedAuthenticatedDm(root: string, server: string, space: string): Promise<{ auth: SpaceAuth; name: string }> {
  const auth = loadSoleSpaceAuth(authDir(root));
  assert.ok(auth);
  const inbox = await withDmManager(server, auth, (jsm) => jsm.consumers.add(dmStream(space), dmDurableConfig(space, "local", "reader", mintLifecycleUid())));
  return { auth, name: inbox.name };
}

async function checkOpenFullRestore(root: string, server: string, artifact: string, checkpoint: PersistentConsumerCheckpoint, run: ReturnType<typeof sandboxRun>["run"]): Promise<void> {
  const mustRun = (...args: string[]) => {
    const result = run(...args);
    assert.equal(result.status, 0, `${args.join(" ")}\n${result.stdout}${result.stderr}`);
  };
  mustRun("backup", "restore", artifact);
  await assertRestoredDm(server, checkpoint);
  const fullRestore = readMaintenanceJournal(root);
  assert.ok(fullRestore?.state === "active");
  mustRun("backup", "cleanup-fallback", fullRestore.restore.attemptId, "--discard-history", "--yes");
  mustRun("down", "--preserve-state");
}

function assertOverlappingRestoreTarget(root: string, artifact: string, run: ReturnType<typeof sandboxRun>["run"], target: string, overlap: "backup artifact" | "preserved source store"): void {
  const journal = join(root, ".cotal", "maintenance", "v1", "journal.json");
  const manifest = join(artifact, "manifest.json");
  const attempts = join(root, ".cotal", "maintenance", "attempts");
  const journalBefore = readFileSync(journal);
  const manifestBefore = readFileSync(manifest);
  const attemptsBefore = readdirSync(attempts).sort();
  const message = `restore target must not overlap the ${overlap}. No restore started.`;
  const remedy = `choose an absent \`--store-dir\` path outside the ${overlap}`;
  const plain = run("backup", "restore", artifact, "--store-dir", target, "--plain");
  const up = run("up", "--restore", artifact, "--store-dir", target, "--detach");
  for (const result of [plain, up]) {
    assert.equal(result.status, 1, `${result.stdout}${result.stderr}`);
    assert.ok(result.stderr.includes(message), result.stderr);
    assert.ok(result.stderr.includes(remedy), result.stderr);
    assert.doesNotMatch(result.stderr, /Outcome unconfirmed|cotal status/);
  }
  const json = run("backup", "restore", artifact, "--store-dir", target, "--json");
  assert.equal(json.status, 1, `${json.stdout}${json.stderr}`);
  const envelope = JSON.parse(json.stdout);
  assert.equal(envelope.outcome, "refused");
  assert.equal(envelope.error.code, "USAGE_INVALID");
  assert.ok(envelope.error.message.includes(message), json.stdout);
  assert.ok(envelope.error.remedy.includes(remedy), json.stdout);
  assert.equal(envelope.target.storeDir, target);
  assert.equal(existsSync(target), false);
  assert.deepEqual(readFileSync(journal), journalBefore);
  assert.deepEqual(readFileSync(manifest), manifestBefore);
  assert.deepEqual(readdirSync(attempts).sort(), attemptsBefore);
}

async function scenario(mode: "open" | "auth"): Promise<void> {
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), `cotal-backup-restore-${mode}-root-`)));
  const home = realpathSync.native(mkdtempSync(join(tmpdir(), `cotal-backup-restore-${mode}-home-`)));
  const artifact = join(root, "full-backup");
  const maintenance = join(root, ".cotal", "maintenance");
  const registryArtifact = join(mode === "open" ? maintenance : root, "registry-backup");
  const port = await freePort();
  const server = `nats://127.0.0.1:${port}`;
  const space = `backup_live_${mode}`;
  const { run, env } = sandboxRun(root, home);
  const launcher = resolveOnPath("cotal", env) ? "cotal" : "pnpm cotal";
  const must = (label: string, result: ReturnType<typeof run>) => {
    assert.equal(result.status, 0, `${mode} ${label}\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
  };
  const payload = (action: "seed" | "full" | "empty") => must(`payload ${action}`, spawnSync(tsx,
    [join(worktree, "implementations/cli/smoke/backup-event-payload.ts"), root, server, space, action, mode],
    { cwd: join(worktree, "implementations/cli"), env, encoding: "utf8", timeout: 30_000 }));

  try {
    must("up", run("up", "--detach", ...(mode === "open" ? ["--open"] : []), "--server", server, "--space", space));
    const openDmName = mode === "open" ? await disconnectedMcpInbox(root, env, server, space) : undefined;
    const authDm = mode === "auth" ? await seedAuthenticatedDm(root, server, space) : undefined;
    must("seed registry", run("channel", "set", "preserved", "--desc", "survives", "--space", space));
    payload("seed");
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
    if (mode === "open") {
      must("verify registry backup inside maintenance", run("backup", "verify", registryArtifact, "--plain"));
      const cold = mkdtempSync(join(tmpdir(), "cotal-backup-restore-cold-"));
      try {
        const project = join(cold, "project"), config = join(cold, "config");
        mkdirSync(project);
        const cleanEnv = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.toUpperCase().startsWith("COTAL_")));
        const refused = spawnSync(tsx, [cliPath, "backup", "restore", registryArtifact, "--plain"], {
          cwd: project, encoding: "utf8", timeout: 30_000,
          env: { ...cleanEnv, COTAL_HOME: join(cold, "home"), XDG_CONFIG_HOME: config, COTAL_ALLOW_CHECKOUT_SEED: "1", npm_config_offline: "true" },
        });
        const output = `${refused.stdout}\n${refused.stderr}`;
        assert.equal(refused.status, 2, output);
        assert.match(output, /restore requires stable ready maintenance state, found none/);
        assert.match(output, /LIFECYCLE_BLOCKED/);
        assert.deepEqual(readdirSync(project), [], "a refused restore leaves the project empty");
        assert.equal(existsSync(join(config, "cotal")), false, "a refused restore leaves connector configuration untouched");
      } finally {
        rmSync(cold, { recursive: true, force: true });
      }
    }
    assert.ok(existsSync(join(artifact, "manifest.json")));
    const fullManifest = JSON.parse(readFileSync(join(artifact, "manifest.json"), "utf8")) as BackupManifest;
    assert.equal(fullManifest.format, "cotal-space-backup/v3");
    assert.equal(fullManifest.streams.find((entry) => entry.stream === eventPayloadStream(space))?.state.messages, 1);
    const registryManifest = JSON.parse(readFileSync(join(registryArtifact, "manifest.json"), "utf8")) as BackupManifest;
    assert.ok(!registryManifest.streams.some((entry) => entry.stream === eventPayloadStream(space)));
    // A full artifact of an authenticated space restores only where its trust state survives, and says so.
    const trustBound = (dir: string) => (JSON.parse(run("backup", "inspect", dir, "--json").stdout) as { result: { trustBound: boolean } }).result.trustBound;
    assert.equal(trustBound(artifact), mode === "auth", `a full ${mode} artifact says whether it is bound to this root's trust state`);
    assert.equal(trustBound(registryArtifact), false, "a registry artifact is not bound to this root's trust state");
    const originalCheckpoints = JSON.parse(readFileSync(join(artifact, "checkpoints.json"), "utf8")) as PersistentConsumerCheckpoint[];
    const dmCheckpoint = originalCheckpoints.find(({ stream, name }) => stream === dmStream(space) && name === (openDmName ?? authDm?.name));
    assert.ok(dmCheckpoint, "full backup checkpointed the test DM inbox");
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
      const tampered = join(root, "full backup 'tampered'");
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
        if (command === "restore") {
          const remedy = JSON.parse(refused.stdout).error?.remedy as string;
          const commandText = /`(cotal backup verify .*?)`/.exec(remedy)?.[1];
          assert.ok(commandText, "restore verification remedy includes the artifact directory");
          const verified = spawnSync("sh", ["-c", commandText.replace(/^cotal /, '"$COTAL_TEST_TSX" "$COTAL_TEST_CLI" ') + " --json"], { cwd: root, env: { ...env, COTAL_TEST_TSX: tsx, COTAL_TEST_CLI: cliPath }, encoding: "utf8" });
          assert.equal(verified.status, 1, "the printed verify command reports damaged integrity");
          assert.equal(JSON.parse(verified.stdout).target?.fault, "mismatch", "the printed command checks the quoted artifact, not usage");
        }
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
      assert.ok(driftedRoot.stderr.includes(`its channel registry still restores here with \`cotal backup restore ${artifact} --only registry\``), `its Next names the registry restore, which does not check the trust state\n${driftedRoot.stderr}`);
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

    const attempts = join(maintenance, "attempts");
    const journalDir = join(maintenance, "v1");
    const lock = join(maintenance, "lock.json");
    const reaper = join(maintenance, "lock-reaper.json");
    for (const [path, relation] of [
      [join(attempts, "nested-artifact"), `is inside this root's maintenance attempt directory ${attempts}, where it stages its attempt`],
      [join(journalDir, "nested-artifact"), `is inside this root's maintenance journal directory ${journalDir}`],
      [lock, "is this root's maintenance lock path"],
      [reaper, "is this root's maintenance lock recovery path"],
    ]) {
      cpSync(artifact, path, { recursive: true });
      try {
        const message = `the restore artifact ${path} ${relation}; nothing was restored`;
        const refused = run("up", "--restore", path, "--detach", "--server", server, "--space", space);
        assert.equal(refused.status, 1, refused.stderr);
        assert.ok(refused.stderr.includes(message), refused.stderr);
        if (path === lock && mode === "open") {
          const json = run("backup", "restore", path, "--json");
          assert.equal(json.status, 1, json.stdout + json.stderr);
          const envelope = JSON.parse(json.stdout);
          assert.equal(envelope.outcome, "refused");
          assert.equal(envelope.error.code, "USAGE_INVALID");
          assert.equal(envelope.target.overlaps, lock);
        }
        const files = readdirSync(artifact).sort();
        assert.deepEqual(readdirSync(path).sort(), files, "refusal leaves every artifact file in place");
        for (const file of files) assert.deepEqual(readFileSync(join(path, file)), readFileSync(join(artifact, file)), `${file} is unchanged`);
      } finally {
        rmSync(path, { recursive: true, force: true });
      }
    }
    assertOverlappingRestoreTarget(root, artifact, run, join(artifact, "target"), "backup artifact");
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
    if (mode === "open") {
      const linkedStore = join(root, "linked-store");
      symlinkSync(existingStore, linkedStore);
      for (const args of [["backup", "restore", artifact, "--plain"], ["up", "--restore", artifact, "--detach"]]) {
        const refused = run(...args, "--store-dir", linkedStore);
        assert.equal(refused.status, 1, `${refused.stdout}${refused.stderr}`);
        assert.ok(refused.stderr.includes(`the --store-dir path ${linkedStore} is a link to ${existingStore}`), refused.stderr);
        assert.ok(refused.stderr.includes("name a real path for `--store-dir` that does not exist yet, inside an existing writable directory; the restore creates it"), refused.stderr);
        assert.equal(readMaintenanceJournal(root)?.state, cutState);
        assert.deepEqual(readdirSync(existingStore), []);
      }
      rmSync(linkedStore);
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
    if (mode === "open") await checkOpenFullRestore(root, server, artifact, dmCheckpoint, run);
    // Adapt real CLI snapshots to the precise v2 inventory. This is not an old-producer artifact.
    // A v3 with that missing stream must refuse; the same bytes declared as v2 must restore.
    if (mode === "auth") {
      const legacyArtifact = join(root, "legacy-v2-backup");
      cpSync(artifact, legacyArtifact, { recursive: true });
      const legacy = structuredClone(fullManifest);
      const removed = legacy.streams.find((entry) => entry.stream === eventPayloadStream(space));
      assert.ok(removed);
      legacy.streams = legacy.streams.filter((entry) => entry !== removed);
      legacy.files = legacy.files.filter((entry) => entry.path !== removed.snapshot);
      rmSync(join(legacyArtifact, removed.snapshot));
      writeFileSync(join(legacyArtifact, "manifest.json"), `${JSON.stringify(legacy, null, 2)}\n`);
      const missingPayload = run("backup", "restore", legacyArtifact, "--json");
      assert.notEqual(missingPayload.status, 0);
      assert.match(missingPayload.stdout + missingPayload.stderr, /stream inventory does not match its selection/);
      assert.equal(readMaintenanceJournal(root)?.state, "ready");
      legacy.format = "cotal-space-backup/v2";
      writeFileSync(join(legacyArtifact, "manifest.json"), `${JSON.stringify(legacy, null, 2)}\n`);
      must("verify adapted v2 artifact", run("backup", "verify", legacyArtifact));
      must("restore adapted v2 artifact", run("backup", "restore", legacyArtifact));
      payload("empty");
      const legacyJournal = readMaintenanceJournal(root);
      assert.ok(legacyJournal?.state === "active");
      must("retire adapted v2 restore", run("backup", "cleanup-fallback", legacyJournal.restore.attemptId, "--discard-history", "--yes"));
      must("send after legacy restore", run("send", "-c", "preserved", "history-after-backup", "--space", space));
      must("preserve after adapted v2 restore", run("down", "--preserve-state"));
    }
    const restored = run("up", "--restore", restoreArtifact, "--detach", "--server", server, "--space", space);
    must("restore", restored);
    assert.ok(existsSync(join(restoreArtifact, "manifest.json")), "restore leaves the original artifact in place");
    if (authDm) await assertRestoredDm(server, dmCheckpoint, authDm.auth);
    payload(mode === "open" ? "empty" : "full");
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
    // above. The registry restore leaves out the payload stream and the full restore leaves out
    // the post sent after the legacy restore.
    assert.equal(active.launch?.previousCutNewer, true, `${mode} restore journals that the cut it replaced is newer than its artifact`);
    const leftOut = restoreArtifact === registryArtifact ? "chat and DM history and workflow runs" : "newer space state";
    // The receipt previews cleanup and names the separate consent that deletion needs.
    assert.ok(restored.stdout.includes(`✓ restored the backup ${restoreArtifact === registryArtifact ? "registry" : "in full"} as restore attempt ${active.restore.attemptId}`), `${mode} up --restore names its attempt\n${restored.stdout}`);
    const cleanupNext = restored.stdout.split("\n").find((line) => line.startsWith("next: ")) ?? "";
    assert.ok(cleanupNext.includes(`\`${launcher} backup cleanup-fallback ${active.restore.attemptId} --dry-run\``) && cleanupNext.includes(`requires --discard-history and removes the only copy of the ${leftOut} it left out`), `${mode} up --restore previews cleanup and names the retained data\n${restored.stdout}`);
    // A registry restore says history starts empty and names the store that holds its only copy.
    if (restoreArtifact === registryArtifact) {
      assert.match(restored.stdout, /channel settings only, so chat and DM history and workflow runs start empty/, `${mode} registry restore names the empty history\n${restored.stdout}`);
      const previous = active.restore.previousSource?.identity.path;
      assert.ok(previous && restored.stdout.includes(`The previous store at ${previous} holds the only copy of them. \`${launcher} backup cleanup-fallback ${active.restore.attemptId}\` deletes it only with --discard-history.`), `${mode} registry restore names the previous store\n${restored.stdout}`);
    } else {
      assert.doesNotMatch(restored.stdout, /history start empty/);
      const previous = active.restore.previousSource?.identity.path;
      assert.ok(previous && restored.stdout.includes("Later changes to channel settings, access grants, membership, history limits, message history, and workflow runs are not restored.") && restored.stdout.includes(`The previous store at ${previous} holds the only copy of the ${leftOut}.`), `${mode} full restore of an older artifact names the newer state it left out\n${restored.stdout}`);
    }
    // `up -f` boots a fresh mesh, so it refuses while the restore is active and names the way out.
    const manifest = join(root, "cotal.yaml");
    writeFileSync(manifest, `apiVersion: cotal/v1\nkind: Mesh\nspace: ${space}\nbroker:\n  servers: ${server}\n${mode === "open" ? "  auth: false\n" : ""}channels:\n  general:\n    subscribe: []\n`);
    const running = run("up", "-f", "cotal.yaml");
    assert.equal(running.status, 2, `${mode} up -f while the restored stack runs refuses, exit 2\n${running.stdout}\n${running.stderr}`);
    assert.match(running.stderr, /Code: +CONFLICT/);
    const conditionalCleanup = ["cotal", "pnpm cotal"].map((cli) => `retire the restore with \`${cli} backup cleanup-fallback ${active.restore.attemptId}\` only if you choose to discard the ${leftOut} held only in the previous store (deletion requires --discard-history)`);
    assert.ok(conditionalCleanup.some((step) => running.stderr.includes(step)), `${mode} up -f names the separate choice\n${running.stderr}`);
    // Any other `up` over the restored broker refuses before it touches the journal, which stays active.
    for (const args of [["up"], ["up", "--server", server]]) {
      const again = run(...args);
      assert.equal(again.status, 2, `${mode} ${args.join(" ")} while the restored stack runs refuses, exit 2\n${again.stdout}\n${again.stderr}`);
      assert.ok(/Code: +CONFLICT/.test(again.stderr) && again.stderr.includes("stop the restored stack with `cotal down`, then run `cotal up` again"), `${mode} ${args.join(" ")} names the way out\n${again.stderr}`);
      assert.equal((JSON.parse(readFileSync(join(root, ".cotal", "maintenance", "v1", "journal.json"), "utf8")) as { state: string }).state, "active", `${mode} ${args.join(" ")} leaves the restore journal active`);
    }
    // `status` names the same cleanup for the attempt it shows under Maintenance.
    const status = run("status", "--space", space);
    const statusNext = status.stdout.split("\n").find((line) => line.includes(`cotal backup cleanup-fallback ${active.restore.attemptId}`)) ?? "";
    assert.ok(statusNext.includes("--dry-run`") && statusNext.includes(`requires --discard-history and removes the only copy of the ${leftOut} it left out`), `${mode} status previews cleanup and names the retained data\n${status.stdout}`);
    must("down", run("down", "--yes"));
    const stopped = run("up", "-f", "cotal.yaml");
    assert.equal(stopped.status, 2, `${mode} up -f after the restored stack stopped refuses, exit 2\n${stopped.stdout}\n${stopped.stderr}`);
    assert.match(stopped.stderr, /Code: +LIFECYCLE_BLOCKED/);
    assert.ok(conditionalCleanup.some((step) => stopped.stderr.includes(step)), `${mode} up -f names the separate choice\n${stopped.stderr}`);
    rmSync(manifest);
    if (mode === "open") {
      // The committed journal survives the broker's death; a later bare `up` relaunches over the
      // exact recorded active target (a different --store-dir is refused) without retiring it.
      must("later startup after committed restore broker shutdown", run("up", "--detach", "--open", "--server", server, "--space", space));
      assert.equal(
        (JSON.parse(readFileSync(join(root, ".cotal", "maintenance", "v1", "journal.json"), "utf8")) as { state: string }).state,
        "active",
      );
      must("later down", run("down", "--yes"));
    }
    {
      // The previous store holds the only copy of what the restore left out, so the preview warns and
      // both cleanup commands refuse to delete it without --discard-history.
      const previous = active.restore.previousSource!.identity.path;
      const journalPath = join(root, ".cotal", "maintenance", "v1", "journal.json");
      const journalBefore = readFileSync(journalPath, "utf8");
      const wrongAttempt = "restore-00000000-0000-4000-8000-000000000000";
      for (const flags of [[], ["--discard-history"]]) {
        const wrong = run("backup", "cleanup-fallback", wrongAttempt, "--yes", "--json", ...flags);
        assert.equal(wrong.status, 2, wrong.stdout + wrong.stderr);
        const { error } = JSON.parse(wrong.stdout);
        assert.equal(error.code, "TARGET_NOT_FOUND");
        assert.ok(error.remedy.includes(`\`cotal backup cleanup-fallback ${active.restore.attemptId} --dry-run${flags.length ? " --discard-history" : ""}\``), wrong.stdout);
        assert.ok(error.remedy.includes(`requires --discard-history and removes the only copy of the ${leftOut} it left out`), wrong.stdout);
        assert.doesNotMatch(error.remedy, /--yes/);
      }
      const otherStore = join(root, ".cotal", "not-the-fallback");
      mkdirSync(otherStore, { mode: 0o700 });
      writeFileSync(join(otherStore, "marker"), "kept");
      const wrongStore = run("clean", "restore-fallback", "--attempt", active.restore.attemptId, "--force", "--discard-history", "--store-dir", "./.cotal/not-the-fallback");
      assert.ok(wrongStore.status === 1 && wrongStore.stderr.includes("does not take --store-dir") && wrongStore.stderr.includes("Remove --store-dir and its value"), `${mode} cleanup refuses the store path\n${wrongStore.stdout}${wrongStore.stderr}`);
      assert.ok(lstatSync(join(previous, "jetstream")).isDirectory());
      assert.equal(readFileSync(journalPath, "utf8"), journalBefore);
      assert.equal(readFileSync(join(otherStore, "marker"), "utf8"), "kept");
      const { run: runElsewhere } = sandboxRun(join(home, "other-project"), home);
      const wrongFolder = runElsewhere("clean", "restore-fallback", "--attempt", active.restore.attemptId, "--force");
      assert.equal(wrongFolder.status, 2, `${mode} cleanup from another project refuses\n${wrongFolder.stderr}`);
      assert.match(wrongFolder.stderr, /Code: +TARGET_NOT_FOUND/);
      assert.match(wrongFolder.stderr, /Check that you are in the original project folder and verify the attempt ID/);
      assert.doesNotMatch(wrongFolder.stderr, /has settled/);
      assert.ok(existsSync(previous), `${mode} cleanup from another project keeps the previous store`);
      const preview = run("backup", "cleanup-fallback", active.restore.attemptId, "--dry-run", "--json");
      must("cleanup-fallback preview", preview);
      assert.ok((JSON.parse(preview.stdout) as { warnings: { code: string }[] }).warnings.some((w) => w.code === "HISTORY_ONLY_IN_PREVIOUS_STORE"), `${mode} preview warns about the only copy\n${preview.stdout}`);
      // The attempt row names a restore attempt, not a full restore.
      const previewText = run("backup", "cleanup-fallback", active.restore.attemptId, "--dry-run");
      assert.ok(previewText.status === 0 && /Restore attempt:\s+restore-/.test(previewText.stdout) && !previewText.stdout.includes("Full restore attempt"), `${mode} the preview labels the attempt as a restore attempt\n${previewText.stdout}`);
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
      const cleanupRetry = `backup cleanup-fallback ${active.restore.attemptId} --yes`;
      const foreignWithoutConsent = run("backup", "cleanup-fallback", active.restore.attemptId, "--yes", "--plain");
      assert.equal(foreignWithoutConsent.status, 2, foreignWithoutConsent.stderr);
      assert.match(foreignWithoutConsent.stderr, /Code: +CONFLICT/);
      assert.ok(foreignWithoutConsent.stderr.includes(`holds the only copy of the ${leftOut} it left out. Keep that store`), foreignWithoutConsent.stderr);
      assert.ok(["cotal", "pnpm cotal"].some((cli) => foreignWithoutConsent.stderr.includes(`move it out of ${previous}, then run \`${cli} ${cleanupRetry}\` again`)), foreignWithoutConsent.stderr);
      assert.doesNotMatch(foreignWithoutConsent.stderr, /--discard-history/);
      const foreign = run("backup", "cleanup-fallback", active.restore.attemptId, "--yes", "--discard-history", "--json");
      assert.equal(foreign.status, 2, foreign.stdout + foreign.stderr);
      const foreignError = (JSON.parse(foreign.stdout) as { error?: { code?: string; remedy?: string } }).error;
      assert.equal(foreignError?.code, "CONFLICT");
      assert.ok(foreignError.remedy?.includes(`\`cotal ${cleanupRetry} --discard-history\` again`), foreign.stdout);
      const foreignByClean = run("clean", "restore-fallback", "--attempt", active.restore.attemptId, "--force", "--discard-history");
      assert.ok(foreignByClean.status === 2 && foreignByClean.stderr.includes(`the previous store ${previous} also holds notes.txt, which no Cotal store writes; nothing was deleted`)
        && foreignByClean.stderr.includes(`move it out of ${previous}, then run \`cotal clean restore-fallback --attempt ${active.restore.attemptId} --force --discard-history\` again`), `${mode} clean restore-fallback names the file and the way out\n${foreignByClean.stderr}`);
      assert.equal(readFileSync(join(previous, "notes.txt"), "utf8"), "kept", `${mode} the refused cleanups keep the file`);
      assert.equal(readFileSync(journalPath, "utf8"), journalBefore);
      renameSync(join(previous, "notes.txt"), join(root, "notes.txt"));
      const kept = run("backup", "cleanup-fallback", active.restore.attemptId, "--yes", "--json");
      assert.equal(kept.status, 1, `${mode} cleanup-fallback without --discard-history refuses\n${kept.stdout}\n${kept.stderr}`);
      assert.match(kept.stdout, /"code":"USAGE_INVALID"/);
      const keptPlain = run("backup", "cleanup-fallback", active.restore.attemptId, "--yes");
      assert.ok(keptPlain.status === 1 && keptPlain.stderr.includes(`only copy of the ${leftOut} it left out, and cleanup deletes it only with --discard-history; nothing was deleted`) && !keptPlain.stderr.includes("Usage"), `${mode} the refusal names --discard-history without the command help\n${keptPlain.stderr}`);
      assert.ok(existsSync(join(previous, "jetstream")), `${mode} cleanup-fallback without --discard-history keeps the previous store`);
      must("cleanup fallback", run("clean", "restore-fallback", "--attempt", active.restore.attemptId, "--force", "--discard-history"));
      assert.equal(existsSync(previous), false, `${mode} --discard-history deletes the previous store`);
      assert.equal(readFileSync(join(root, "notes.txt"), "utf8"), "kept", `${mode} the moved file survives the cleanup`);
      rmSync(join(root, "notes.txt"));
    }
    assert.equal(existsSync(join(root, ".cotal", "maintenance", "v1", "journal.json")), false, "fallback cleanup retires the restore journal");
    const repeated = run("clean", "restore-fallback", "--attempt", active.restore.attemptId, "--force", "--discard-history");
    assert.ok(repeated.status === 2 && /Code: +TARGET_NOT_FOUND/.test(repeated.stderr) && repeated.stderr.includes(`no maintenance record at this root names restore attempt ${active.restore.attemptId}; nothing was deleted`), `${mode} a repeated clean restore-fallback refuses without a matching record\n${repeated.stderr}`);
    assert.doesNotMatch(repeated.stderr, /has settled/);
  } finally {
    run("down", "--yes");
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
    run("down", "--yes");
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
    assert.equal(run("down", "--yes").status, 0);
  } finally {
    run("down", "--yes");
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
    assert.equal(run("down", "--yes").status, 0);
  } finally {
    run("down", "--yes");
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
    assert.equal(run("down", "--yes").status, 0);
  } finally {
    run("down", "--yes");
    rmSync(root, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  }
}

async function uninterruptedUnreadableRestore(): Promise<void> {
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), "cotal-restore-unreadable-full-root-")));
  const home = realpathSync.native(mkdtempSync(join(tmpdir(), "cotal-restore-unreadable-full-home-")));
  const artifact = join(root, "registry-backup");
  const port = await freePort();
  const server = `nats://127.0.0.1:${port}`;
  const space = "backup_unreadable_full";
  const { run, env, sandbox } = sandboxRun(root, home);
  const journalPath = join(root, ".cotal", "maintenance", "v1", "journal.json");
  const unreadable = { ...env, COTAL_SMOKE_UNREADABLE_PROCESSES: "1" };
  try {
    assert.equal(run("up", "--detach", "--open", "--server", server, "--space", space).status, 0);
    assert.equal(run("down", "--preserve-state").status, 0);
    assert.equal(run("backup", "create", artifact, "--only", "registry").status, 0);
    const restored = spawnSync(tsx, [cliPath, "up", "--restore", artifact, "--detach", "--server", server, "--space", space], {
      cwd: root, env: unreadable, encoding: "utf8", timeout: 240_000,
    });
    assert.equal(restored.status, 0, `first restore finishes when process command lines cannot be read\nstdout:\n${restored.stdout}\nstderr:\n${restored.stderr}`);
    const active = JSON.parse(readFileSync(journalPath, "utf8")) as { state: string; listenerProof?: { processOwner: { pid: number } } };
    assert.equal(active.state, "active");
    assert.ok(active.listenerProof, "the uninterrupted first restore bound its listener");
    assert.equal((await probeConnect(server, { timeoutMs: 250 })).ok, true, "the restored listener accepts a connection");
    assert.equal(run("down", "--yes").status, 0);
  } finally {
    assertSmokeSandboxDown(sandbox, ["down", "--yes"], { cwd: root, env });
    run("down", "--yes");
    await waitUntil(async () => !(await probeConnect(server, { timeoutMs: 200 })).ok, "first restore port release");
    rmSync(root, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  }
}

async function firstUnreadableRestoreScenario(pin: "match" | "mismatch"): Promise<void> {
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), "cotal-restore-unreadable-root-")));
  const home = realpathSync.native(mkdtempSync(join(tmpdir(), "cotal-restore-unreadable-home-")));
  const artifact = join(root, "registry-backup");
  const port = await freePort();
  const server = `nats://127.0.0.1:${port}`;
  const space = "backup_unreadable_first";
  const { run, env } = sandboxRun(root, home);
  const journalPath = join(root, ".cotal", "maintenance", "v1", "journal.json");
  const unreadable = { ...env, COTAL_SMOKE_UNREADABLE_PROCESSES: "1" };
  const pidPath = join(root, ".cotal", "nats.pid");
  let listenerPid: number | undefined;
  let unrelated: ChildProcess | undefined;
  try {
    assert.equal(run("up", "--detach", "--open", "--server", server, "--space", space).status, 0);
    assert.equal(run("down", "--preserve-state").status, 0);
    assert.equal(run("backup", "create", artifact, "--only", "registry").status, 0);
    const spawned = spawnSync(tsx, [cliPath, "up", "--restore", artifact, "--detach", "--server", server, "--space", space], {
      cwd: root, env: { ...unreadable, COTAL_SMOKE_EXIT_AFTER_RESTORE_LISTENER_SPAWN: "1" }, encoding: "utf8", timeout: 240_000,
    });
    assert.equal(spawned.status, 87, `first restore passed the unreadable process scan and spawned\nstdout:\n${spawned.stdout}\nstderr:\n${spawned.stderr}`);
    listenerPid = Number(readFileSync(pidPath, "utf8"));
    await waitUntil(async () => (await probeConnect(server, { timeoutMs: 250 })).ok, "published unbound listener");
    const published = verifyIdentityPin(pidPath);
    assert.equal(published.kind, "match", "the published pid belongs to the listener");
    if (pin === "match") {
      const refused = spawnSync(tsx, [cliPath, "up", "--detach", "--server", server, "--space", space], {
        cwd: root, env: unreadable, encoding: "utf8", timeout: 240_000,
      });
      assert.equal(refused.status, 3, refused.stderr);
      assert.match(refused.stderr, /OPERATION_UNKNOWN/);
      assert.match(refused.stderr, new RegExp(`Published listener pid ${listenerPid} matches the recorded creation time`));
      assert.equal(readSpawnJournal(journalPath).state, "degraded");
      assert.equal((await probeConnect(server, { timeoutMs: 250 })).ok, true, "the refusal leaves the published listener running");
    }
    process.kill(listenerPid, "SIGTERM");
    await waitUntil(() => { try { process.kill(listenerPid!, 0); return false; } catch { return true; } }, "published listener exit");
    await waitUntil(async () => !(await probeConnect(server, { timeoutMs: 200 })).ok, "published listener port release");
    listenerPid = undefined;
    if (pin === "mismatch") {
      unrelated = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
      assert.ok(unrelated.pid);
      writePidPair(pidPath, unrelated.pid, { tokenAt: () => "1" });
      assert.equal(verifyIdentityPin(pidPath).kind, "mismatch", "the recorded pid is now used by another process");
    }
    const recovered = spawnSync(tsx, [cliPath, "up", "--detach", "--server", server, "--space", space], {
      cwd: root, env: unreadable, encoding: "utf8", timeout: 240_000,
    });
    assert.equal(recovered.status, 0, `retry starts once the published listener is dead\nstdout:\n${recovered.stdout}\nstderr:\n${recovered.stderr}`);
    assert.equal((JSON.parse(readFileSync(journalPath, "utf8")) as { state: string }).state, "active");
    if (unrelated?.pid !== undefined) process.kill(unrelated.pid, 0);
    assert.equal(run("down", "--yes").status, 0);
  } finally {
    run("down", "--yes");
    if (unrelated) await closeServer(unrelated);
    if (listenerPid !== undefined) {
      try { process.kill(listenerPid, "SIGTERM"); } catch { /* already gone */ }
      await waitUntil(() => { try { process.kill(listenerPid!, 0); return false; } catch { return true; } }, "unreadable listener exit");
    }
    await waitUntil(async () => !(await probeConnect(server, { timeoutMs: 200 })).ok, "unreadable listener port release");
    rmSync(root, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  }
}

interface SpawnJournal {
  state: string;
  restore?: { attemptId?: string };
  launch?: { serverName?: string; listenerSpawn?: string };
  listenerProof?: unknown;
}

function readSpawnJournal(journalPath: string): SpawnJournal {
  return JSON.parse(readFileSync(journalPath, "utf8")) as SpawnJournal;
}

function namedListenerPids(serverName: string): number[] {
  const listed = spawnSync("ps", ["-axww", "-o", "pid=", "-o", "args="], { encoding: "utf8" });
  if (listed.status !== 0) return [];
  const pids: number[] = [];
  for (const line of String(listed.stdout ?? "").split("\n")) {
    if (!line.includes("nats-server") || !line.includes(`--name ${serverName}`)) continue;
    const pid = Number(line.trim().split(/\s+/)[0]);
    if (Number.isInteger(pid) && pid > 0) pids.push(pid);
  }
  return pids;
}

interface FrozenUnpublished {
  root: string;
  home: string;
  env: NodeJS.ProcessEnv;
  sandbox: SmokeSandboxAnchor;
  server: string;
  space: string;
  serverName: string;
  listenerPid: number;
  journalPath: string;
  pidPath: string;
}

async function releaseFrozenRestore(held: {
  root?: string; home?: string; env?: NodeJS.ProcessEnv; sandbox?: SmokeSandboxAnchor; server?: string; serverName?: string; journalPath?: string;
}): Promise<void> {
  try {
    if (held.sandbox && held.root && held.env) {
      assertSmokeSandboxDown(held.sandbox, ["down", "--yes"], { cwd: held.root, env: held.env });
      spawnSync(tsx, [cliPath, "down", "--yes"], { cwd: held.root, env: held.env, encoding: "utf8", timeout: 240_000 });
    }
    const attemptId = held.journalPath && existsSync(held.journalPath) ? readSpawnJournal(held.journalPath).restore?.attemptId : undefined;
    const name = attemptId ? `${attemptId}-` : held.serverName;
    if (name) {
      for (const pid of namedListenerPids(name)) {
        try { process.kill(pid, "SIGKILL"); } catch { /* already gone */ }
      }
      await waitUntil(() => namedListenerPids(name).length === 0, "frozen listener exit");
    }
    if (held.server)
      await waitUntil(async () => !(await probeConnect(held.server ?? "", { timeoutMs: 200 })).ok, "frozen listener port release");
  } finally {
    if (held.root) rmSync(held.root, { recursive: true, force: true });
    if (held.home) rmSync(held.home, { recursive: true, force: true });
  }
}

/** Spawn the restore listener, freeze it before it listens, and exit before its pid is published. */
async function crashBeforePidPublish(label: string, prior?: "rearm" | "replace"): Promise<FrozenUnpublished> {
  const held: {
    root?: string; home?: string; env?: NodeJS.ProcessEnv; sandbox?: SmokeSandboxAnchor; server?: string; serverName?: string; journalPath?: string;
  } = {};
  let ready = false;
  try {
    held.root = realpathSync.native(mkdtempSync(join(tmpdir(), `cotal-restore-${label}-root-`)));
    held.home = realpathSync.native(mkdtempSync(join(tmpdir(), `cotal-restore-${label}-home-`)));
    const started = sandboxRun(held.root, held.home);
    held.env = started.env;
    held.sandbox = started.sandbox;
    const artifact = join(held.root, "registry-backup");
    const port = await freePort();
    held.server = `nats://127.0.0.1:${port}`;
    const journalPath = join(held.root, ".cotal", "maintenance", "v1", "journal.json");
    held.journalPath = journalPath;
    const pidPath = join(held.root, ".cotal", "nats.pid");
    assert.equal(started.run("up", "--detach", "--open", "--server", held.server, "--space", label).status, 0);
    assert.equal(started.run("down", "--preserve-state").status, 0);
    assert.equal(started.run("backup", "create", artifact, "--only", "registry").status, 0);
    const args = ["--detach", "--server", held.server, "--space", label];
    const restoreArgs = ["--restore", artifact];
    if (prior) {
      const hook = prior === "rearm" ? "COTAL_SMOKE_EXIT_AFTER_RESTORE_LISTENER_SPAWN" : "COTAL_SMOKE_EXIT_AFTER_RESTORE_LISTENER_BIND";
      const first = spawnSync(tsx, [cliPath, "up", ...restoreArgs, ...args], {
        cwd: held.root, env: { ...held.env, [hook]: "1" }, encoding: "utf8", timeout: 240_000,
      });
      assert.equal(first.status, prior === "rearm" ? 87 : 86, first.stderr);
      const firstPid = Number(readFileSync(pidPath, "utf8"));
      process.kill(firstPid, "SIGTERM");
      await waitUntil(() => verifyIdentityPin(pidPath).kind === "gone", "prior published listener exit");
      assert.equal(Number(readFileSync(pidPath, "utf8")), firstPid, "prior listener left a stale pidfile");
    }
    const spawned = spawnSync(tsx, [cliPath, "up", ...(prior ? [] : restoreArgs), ...args], {
      cwd: held.root,
      env: { ...held.env, COTAL_SMOKE_EXIT_BEFORE_RESTORE_LISTENER_PID: "1", COTAL_SMOKE_UNREADABLE_PROCESSES: "1" },
      encoding: "utf8",
      timeout: 240_000,
    });
    assert.equal(spawned.status, 87, `restore exited before the pid publish\nstdout:\n${spawned.stdout}\nstderr:\n${spawned.stderr}`);
    const journal = readSpawnJournal(journalPath);
    held.serverName = journal.launch?.serverName ?? "";
    assert.equal(journal.launch?.listenerSpawn, "started");
    assert.equal(journal.listenerProof, undefined);
    assert.notEqual(held.serverName, "");
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 1000));
    assert.equal((await probeConnect(held.server, { timeoutMs: 250 })).ok, false, "the frozen listener is not serving");
    assert.equal(existsSync(pidPath), false, "the pid was not published");
    assert.equal(existsSync(identityPinPath(pidPath)), false, "the pid pin was not published");
    const pids = namedListenerPids(held.serverName);
    assert.equal(pids.length, 1, `expected one frozen listener, found ${pids.join(", ")}`);
    const listenerPid = pids[0];
    if (listenerPid === undefined) throw new Error("frozen listener pid missing");
    ready = true;
    return {
      root: held.root, home: held.home, env: held.env, sandbox: held.sandbox, server: held.server, space: label,
      serverName: held.serverName, listenerPid, journalPath, pidPath,
    };
  } finally {
    if (!ready) await releaseFrozenRestore(held);
  }
}

async function unpublishedUnreadableRestoreScenario(prior?: "rearm" | "replace"): Promise<void> {
  const crashed = await crashBeforePidPublish(`backup_unpublished_${prior ?? "first"}`, prior);
  try {
    const refused = spawnSync(tsx, [cliPath, "up", "--detach", "--server", crashed.server, "--space", crashed.space], {
      cwd: crashed.root,
      env: { ...crashed.env, COTAL_SMOKE_UNREADABLE_PROCESSES: "1" },
      encoding: "utf8",
      timeout: 240_000,
    });
    assert.equal(refused.status, 3, refused.stderr);
    assert.match(refused.stderr, /OPERATION_UNKNOWN/);
    assert.match(refused.stderr, /cannot show that no listener it started still runs/);
    assert.match(refused.stderr, /process command lines were not read/);
    assert.match(refused.stderr, /No listener PID was published/);
    assert.match(refused.stderr, /does not start another listener/);
    assert.match(refused.stderr, new RegExp(`--name ${crashed.serverName}`));
    assert.equal(existsSync(crashed.pidPath), false, "the refusal published no listener");
    const attemptId = readSpawnJournal(crashed.journalPath).restore?.attemptId;
    assert.ok(attemptId);
    assert.deepEqual(namedListenerPids(`${attemptId}-`), [crashed.listenerPid]);
    const blocked = readSpawnJournal(crashed.journalPath);
    assert.equal(blocked.state, "degraded");
    assert.equal(blocked.launch?.listenerSpawn, "started");
  } finally {
    await releaseFrozenRestore(crashed);
  }
}

async function oldJournalUnreadableRestoreScenario(): Promise<void> {
  const crashed = await crashBeforePidPublish("backup_unreadable_old_journal");
  try {
    const journal = readSpawnJournal(crashed.journalPath);
    delete journal.launch?.listenerSpawn;
    writeFileSync(crashed.journalPath, `${JSON.stringify(journal)}\n`);
    const refused = spawnSync(tsx, [cliPath, "up", "--detach", "--server", crashed.server, "--space", crashed.space], {
      cwd: crashed.root,
      env: { ...crashed.env, COTAL_SMOKE_UNREADABLE_PROCESSES: "1" },
      encoding: "utf8",
      timeout: 240_000,
    });
    assert.equal(refused.status, 3, refused.stderr);
    assert.match(refused.stderr, /OPERATION_UNKNOWN/);
    assert.match(refused.stderr, /does not say whether a listener was spawned/);
    assert.match(refused.stderr, new RegExp(`--name starts with ${journal.restore?.attemptId}`));
    assert.equal(existsSync(crashed.pidPath), false, "the old journal published no listener");
    assert.deepEqual(namedListenerPids(crashed.serverName), [crashed.listenerPid]);
  } finally {
    await releaseFrozenRestore(crashed);
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
    assert.match(refused.stderr, /re-entry has no bound listener proof, and process \d+ started for it still runs/);
    assert.equal((JSON.parse(readFileSync(journalPath, "utf8")) as { state: string }).state, "degraded");

    // #7127: once no process of the attempt runs, bare up starts its listener and recovers forward,
    // from the degraded record the refusal left.
    if (!detached) return;
    process.kill(listenerPid, "SIGTERM");
    await waitUntil(async () => !(await probeConnect(server, { timeoutMs: 200 })).ok, `${label} unbound listener stop`);
    await waitUntil(async () => { try { process.kill(listenerPid!, 0); return false; } catch { return true; } }, `${label} unbound listener exit`);
    listenerPid = undefined;
    const recovered = run("up", "--detach", "--server", server, "--space", space);
    assert.equal(recovered.status, 0, `${label} bare up recovers an unbound restore forward\nstdout:\n${recovered.stdout}\nstderr:\n${recovered.stderr}`);
    const active = JSON.parse(readFileSync(journalPath, "utf8")) as { state: string; listenerProof?: { serverName: string } };
    assert.equal(active.state, "active", "the recovered restore is active");
    assert.ok(active.listenerProof, "the recovered restore bound its listener");
    assert.equal(run("down", "--yes").status, 0);
  } finally {
    if (listenerPid) {
      try { process.kill(listenerPid, "SIGTERM"); } catch { /* already gone */ }
      await waitUntil(async () => !(await probeConnect(server, { timeoutMs: 200 })).ok, `${label} unbound listener shutdown`).catch(() => {});
    }
    run("down", "--yes");
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
    const listenerPid = degraded.listenerProof.processOwner.pid;
    process.kill(listenerPid, "SIGTERM");
    // nats-server 2.15 refuses connections before it releases its port, so the port is free for the
    // foreign listener only once that process has exited.
    await waitUntil(() => { try { process.kill(listenerPid, 0); return false; } catch { return true; } }, "bound listener exit");
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
    assert.equal(run("down", "--yes").status, 0);
  } finally {
    if (foreign) await closeServer(foreign).catch(() => {});
    run("down", "--yes");
    rmSync(root, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  }
}

async function missingPidfileListenerScenario(): Promise<void> {
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), "cotal-missing-pid-listener-root-")));
  const home = realpathSync.native(mkdtempSync(join(tmpdir(), "cotal-missing-pid-listener-home-")));
  const artifact = "./registry's `retry` backup";
  const store = "-jetstream store";
  const port = await freePort();
  const server = `nats://127.0.0.1:${port}`;
  const space = "backup_missing_pid_listener";
  const { run, env } = sandboxRun(root, home);
  const pidPath = join(root, ".cotal", "nats.pid");
  const journalPath = join(root, ".cotal", "maintenance", "v1", "journal.json");
  let foreign: ChildProcess | undefined;
  try {
    assert.equal(run("up", "--detach", "--open", "--server", server, "--space", space, `--store-dir=${store}`).status, 0);
    assert.equal(run("channel", "set", "preserved", "--desc", "listener probe", "--space", space).status, 0);
    const brokerPid = Number(readFileSync(pidPath, "utf8"));
    rmSync(pidPath);
    const refusedCut = run("down", "--preserve-state", `--store-dir=${store}`);
    assert.notEqual(refusedCut.status, 0, "a pidless live broker cannot become a ready cut");
    assert.match(refusedCut.stderr, /recorded NATS endpoint .* no listener/);
    // The manager's commitment is journaled BEFORE any stop, so the failed cut parks at the
    // durable cut-committed boundary and the retry below recovers without a live manager.
    assert.equal((JSON.parse(readFileSync(journalPath, "utf8")) as { state: string }).state, "cut-committed");
    process.kill(brokerPid, "SIGTERM");
    await waitUntil(async () => (await probeConnect(server, { timeoutMs: 200 })).ok === false, "pidless broker shutdown");
    const finished = run("down", "--preserve-state", `--store-dir=${store}`);
    assert.equal(finished.status, 0, `cut retry with stopped manager\nstdout:\n${finished.stdout}\nstderr:\n${finished.stderr}`);
    assert.equal((JSON.parse(readFileSync(journalPath, "utf8")) as { state: string }).state, "ready");

    foreign = await occupy(port);
    const refusedBackup = run("backup", "create", artifact, "--only", "registry", `--store-dir=${store}`);
    assert.equal(refusedBackup.status, 2, "backup refuses a pidless listener immediately before cloning, exit 2");
    assert.match(refusedBackup.stderr, /recorded NATS endpoint .* no listener; a process there may still be changing the preserved store, so nothing was copied/);
    assert.match(refusedBackup.stderr, /CONFLICT/, "it is a CONFLICT, as restore and resume refuse it");
    assert.ok(refusedBackup.stderr.includes(`stop the process that listens on ${server}, then run`), refusedBackup.stderr);
    const retry = /then run (`{2,})((?:pnpm )?cotal backup create .+?)\1 again/.exec(refusedBackup.stderr)?.[2];
    assert.ok(retry, `its Next encloses the whole command, including the path's backticks\n${refusedBackup.stderr}`);
    assert.equal(existsSync(join(root, artifact)), false, "listener refusal happens before artifact creation");
    assert.equal(readMaintenanceJournal(root)?.state, "ready");
    await closeServer(foreign);
    foreign = undefined;
    const copied = spawnSync("sh", ["-c", `cotal() { "$COTAL_TEST_TSX" "$COTAL_TEST_CLI" "$@"; }; pnpm() { "$@"; }\n${retry}`], {
      cwd: root, env: { ...env, COTAL_TEST_TSX: tsx, COTAL_TEST_CLI: cliPath }, encoding: "utf8", timeout: 240_000,
    });
    assert.equal(copied.status, 0, `the printed retry publishes the backup\n${copied.stdout}${copied.stderr}`);
    const manifest = JSON.parse(readFileSync(join(root, artifact, "manifest.json"), "utf8")) as BackupManifest;
    assert.equal(manifest.selection, "registry", "the printed retry keeps the requested selection");
    const verified = run("backup", "verify", artifact);
    assert.equal(verified.status, 0, `${verified.stdout}${verified.stderr}`);
  } finally {
    if (foreign) await closeServer(foreign).catch(() => {});
    run("down", "--yes");
    rmSync(root, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  }
}

async function undisplayableBackupRetryScenario(): Promise<void> {
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), "cotal-backup-retry-root-")));
  const home = realpathSync.native(mkdtempSync(join(tmpdir(), "cotal-backup-retry-home-")));
  const port = await freePort();
  const server = `nats://127.0.0.1:${port}`;
  const store = "./jetstream\u200d store";
  const cases = [
    { artifact: "./retry\u200b backup", flags: [] },
    { artifact: "./retry backup", flags: ["--store-dir", store, "--plain"] },
  ];
  const { run } = sandboxRun(root, home);
  const must = (result: SpawnSyncReturns<string>) => assert.equal(result.status, 0, `${result.stdout}${result.stderr}`);
  try {
    must(run("up", "--detach", "--open", "--server", server, "--space", "backup_undisplayable_retry", "--store-dir", store));
    must(run("down", "--preserve-state", "--store-dir", store));
    const journal = join(root, ".cotal", "maintenance", "v1", "journal.json");
    const ready = readFileSync(journal, "utf8");
    assert.equal(readMaintenanceJournal(root)?.state, "ready");
    const occupied = await occupy(port);
    try {
      for (const { artifact, flags } of cases) {
        const refused = run("backup", "create", artifact, "--only", "registry", ...flags);
        assert.equal(refused.status, 2, `${refused.stdout}${refused.stderr}`);
        assert.match(refused.stderr, /Code: +CONFLICT/);
        const next = refused.stderr.split("\nNext\n")[1] ?? "";
        assert.match(next, /stop the process .* then rerun your original backup command from the same folder/);
        assert.doesNotMatch(next, /`+cotal backup create /, "no command names a changed path");
        assert.equal(readFileSync(journal, "utf8"), ready);
        assert.equal(existsSync(join(root, artifact)), false);
      }
    } finally {
      await closeServer(occupied);
    }
    for (const { artifact, flags } of cases) {
      must(run("backup", "create", artifact, "--only", "registry", ...flags));
      must(run("backup", "verify", artifact));
    }
  } finally {
    run("down", "--yes");
    rmSync(root, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  }
}

/** #7049: a preserved custom store that is lost is rebuilt at the path its cut records. With
 *  `--accept-missing-source` and no `--store-dir`, the restore chose `.cotal/nats` and failed
 *  `OPERATION_UNKNOWN` before staging. Another `--store-dir` is refused before staging. */
async function missingCustomSourceScenario(): Promise<void> {
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), "cotal-missing-custom-source-root-")));
  const home = realpathSync.native(mkdtempSync(join(tmpdir(), "cotal-missing-custom-source-home-")));
  const artifact = join(root, "space-backup");
  const store = join(root, "custom store");
  const saved = join(root, "saved-source");
  const server = `nats://127.0.0.1:${await freePort()}`;
  const space = "backup_missing_custom_source";
  const { run } = sandboxRun(root, home);
  const must = (label: string, result: ReturnType<typeof run>) => {
    assert.equal(result.status, 0, `${label}\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
  };
  try {
    must("up on a custom store", run("up", "--detach", "--open", "--server", server, "--space", space, "--store-dir", store));
    must("send a message to keep", run("send", "-c", "preserved", "history-before-backup", "--space", space));
    must("down --preserve-state", run("down", "--preserve-state"));
    must("backup create", run("backup", "create", artifact));
    const cotalDir = join(root, ".cotal");
    const maintenance = join(cotalDir, "maintenance");
    const attempts = join(maintenance, "attempts");
    for (const path of [maintenance, cotalDir]) {
      const refused = run("up", "--restore", path, "--detach");
      assert.equal(refused.status, 1, refused.stderr);
      assert.ok(refused.stderr.includes(`the restore artifact ${path} holds this root's maintenance attempt directory ${attempts}, where it stages its attempt; nothing was restored`), refused.stderr);
    }
    assertOverlappingRestoreTarget(root, artifact, run, join(store, "new"), "preserved source store");
    renameSync(store, saved);
    const elsewhere = run("backup", "restore", artifact, "--accept-missing-source", "--store-dir", join(root, "elsewhere"), "--json");
    assert.equal(elsewhere.status, 1, `another --store-dir is a usage refusal\n${elsewhere.stdout}${elsewhere.stderr}`);
    assert.match(elsewhere.stdout, /rebuilds it at its recorded path/);
    assert.equal(readMaintenanceJournal(root)?.state, "ready", "the refusal left the preserved cut ready");
    const restored = run("backup", "restore", artifact, "--accept-missing-source", "--json");
    assert.equal(restored.status, 0, `a consented restore with no --store-dir rebuilds the recorded store\n${restored.stdout}${restored.stderr}`);
    assert.equal((JSON.parse(restored.stdout) as { result: { store: string } }).result.store, store);
    const kept = JSON.parse(run("history", "preserved", "--space", space, "--json").stdout) as { result: { items: { text: string }[] } };
    assert.deepEqual(kept.result.items.map((item) => item.text), ["history-before-backup"], "the restored store serves the retained message");
    must("down", run("down", "--yes"));
    const active = readMaintenanceJournal(root);
    assert.equal(active?.state, "active");
    assert.equal(active.restore.target.path, store);
    const wrong = run("up", "--detach", "--store-dir", saved);
    assert.notEqual(wrong.status, 0, wrong.stdout);
    assert.ok(wrong.stderr.replace(/\s+/g, " ").includes(`ordinary startup after restore must use the recorded active target store ${store}`), wrong.stderr);
    must("bare up before retiring the restore journal", run("up", "--detach"));
    const history = run("history", "preserved", "--space", space, "--json");
    must("history after bare up", history);
    assert.deepEqual(JSON.parse(history.stdout).result.items, kept.result.items);
    assert.equal(existsSync(join(root, ".cotal", "nats")), false, "the restart did not open the default store");
    assert.deepEqual(readMaintenanceJournal(root), active, "the restart leaves the active journal unchanged");
  } finally {
    run("down", "--yes");
    rmSync(root, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  }
}

/** A registry disaster restore starts history and runs empty, but cleanup only retires its journal. */
async function missingRegistrySourceGuidanceScenario(): Promise<void> {
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), "cotal-registry-disaster-root-")));
  const home = realpathSync.native(mkdtempSync(join(tmpdir(), "cotal-registry-disaster-home-")));
  const { run } = sandboxRun(root, home);
  const server = `nats://127.0.0.1:${await freePort()}`;
  const store = join(root, "donor store"), saved = join(root, "saved store"), artifact = join(root, "registry backup");
  const succeeds = (result: ReturnType<typeof run>): string => {
    assert.equal(result.status, 0, `${result.stdout}${result.stderr}`);
    return result.stdout;
  };
  try {
    succeeds(run("up", "--detach", "--open", "--server", server, "--space", "registry_disaster", "--store-dir", store));
    succeeds(run("down", "--preserve-state", "--store-dir", store, "--yes"));
    succeeds(run("backup", "create", artifact, "--only", "registry", "--plain"));
    renameSync(store, saved);
    const restored = succeeds(run("up", "--restore", artifact, "--accept-missing-source", "--detach"));
    assert.match(restored, /No previous store was retained\./);
    const journal = readMaintenanceJournal(root);
    assert.equal(journal?.state, "active");
    const attempt = journal.restore.attemptId;

    const status = succeeds(run("status", "--plain"));
    const preserve = run("down", "--preserve-state", "--yes");
    assert.equal(preserve.status, 2, `${preserve.stdout}${preserve.stderr}`);
    assert.match(preserve.stderr, /LIFECYCLE_BLOCKED/);
    for (const output of [restored, status, preserve.stderr]) {
      assert.ok(["cotal", "pnpm cotal"].some((cli) => output.includes(`\`${cli} backup cleanup-fallback ${attempt} --yes\``)), output);
      assert.match(output, /chat and DM history and workflow runs start empty/i);
      assert.doesNotMatch(output, /--discard-history|deletes the previous store/);
    }
    const preview = succeeds(run("backup", "cleanup-fallback", attempt, "--dry-run", "--plain"));
    assert.match(preview, /Previous source:\s+none retained/);
    for (const flags of [[], ["--discard-history"]]) {
      const unconfirmed = run("backup", "cleanup-fallback", attempt, "--json", ...flags);
      assert.equal(unconfirmed.status, 1, unconfirmed.stdout + unconfirmed.stderr);
      const { error } = JSON.parse(unconfirmed.stdout);
      assert.equal(error.code, "USAGE_INVALID");
      assert.match(error.message, /requires --yes/);
      assert.equal(error.remedy, `review it with \`cotal backup cleanup-fallback ${attempt} --dry-run\`, then run \`cotal backup cleanup-fallback ${attempt} --yes${flags.length ? " --discard-history" : ""}\``);
      assert.deepEqual(readMaintenanceJournal(root), journal);
    }
    assert.match(succeeds(run("backup", "cleanup-fallback", attempt, "--yes", "--plain")), /Completed restore journal retired/);
    assert.equal(readMaintenanceJournal(root), undefined);
    assert.ok(existsSync(join(store, "jetstream")) && existsSync(join(saved, "jetstream")));
  } finally {
    run("down", "--yes");
    rmSync(root, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  }
}

/** #7017: after a registry restore into another store, `down` and the cleanup that retires the
 *  previous store, the bare `up` the stop receipt names reopens the restored store. The space is not
 *  named after its folder, so `down` dropped the record that named that store and only the broker
 *  config its last start rendered names it. A root whose auth and open configs name two stores that
 *  hold data still refuses `CONFLICT`, because which one to reopen is the operator's choice. */
async function restoredStoreRestartScenario(): Promise<void> {
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), "cotal-restored-store-restart-root-")));
  const home = realpathSync.native(mkdtempSync(join(tmpdir(), "cotal-restored-store-restart-home-")));
  const twoStores = realpathSync.native(mkdtempSync(join(tmpdir(), "cotal-two-stores-root-")));
  const twoHome = realpathSync.native(mkdtempSync(join(tmpdir(), "cotal-two-stores-home-")));
  const artifact = join(root, "registry-backup");
  const blocked = join(root, "owner's store parent");
  const parent = join(blocked, "child");
  const store = join(parent, "registry-target");
  const server = `nats://127.0.0.1:${await freePort()}`;
  const space = "backup_restored_store_restart";
  const { run, env } = sandboxRun(root, home);
  const { run: runTwo } = sandboxRun(twoStores, twoHome);
  const must = (label: string, result: ReturnType<typeof run>) => {
    assert.equal(result.status, 0, `${label}\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
  };
  try {
    must("up", run("up", "--detach", "--open", "--server", server, "--space", space));
    must("seed registry", run("channel", "set", "preserved", "--desc", "survives", "--space", space));
    must("down --preserve-state", run("down", "--preserve-state"));
    must("registry backup", run("backup", "create", artifact, "--only", "registry"));
    mkdirSync(parent, { recursive: true, mode: 0o700 });
    if (process.platform !== "win32" && process.getuid?.() !== 0) {
      const alias = join(root, "alias");
      symlinkSync(relative(root, parent), alias);
      await assertRestoreStorePreflight(run, { root, artifact, store, blocked, server, aliasedStore: join(alias, basename(store)) });
      await assertRestoreStoreRechecks(env, { root, artifact, store, blocked, server });
      const journal = join(root, ".cotal", "maintenance", "v1", "journal.json");
      const ready = readFileSync(journal, "utf8");
      chmodSync(parent, 0o500);
      try {
        for (const args of [["backup", "restore", artifact, "--plain"], ["up", "--restore", artifact, "--detach", "--space", space]]) {
          const refused = run(...args, "--store-dir", store);
          assert.equal(refused.status, 2, refused.stderr);
          assert.match(refused.stderr, /PERMISSION_DENIED/);
          const report = refused.stderr.replace(/\s+/g, " ");
          assert.ok(report.includes(`this account cannot write ${parent}`), refused.stderr);
          assert.match(report, /make the parent directory writable by this account or choose a path under a writable parent/);
          assert.match(report, /Leave the store directory absent/);
          assert.equal(existsSync(store), false);
          assert.equal(readFileSync(journal, "utf8"), ready);
        }
      } finally { chmodSync(parent, 0o700); }
    }
    const restored = run("backup", "restore", artifact, "--only", "registry", "--store-dir", store, "--json");
    must("registry restore into another store", restored);
    const { attemptId, store: restoredStore } = (JSON.parse(restored.stdout) as { result: { attemptId: string; store: string } }).result;
    assert.equal(restoredStore, store, "the restore serves the named store");
    const stopped = run("down", "--yes");
    must("down", stopped);
    assert.ok(["cotal", "pnpm cotal"].some((cli) => stopped.stdout.split("\n").some((line) => line.trim().startsWith(`${cli} up `) && line.includes("Start it again"))), `the stop receipt names a bare restart command\n${stopped.stdout}`);
    must("cleanup-fallback", run("backup", "cleanup-fallback", attemptId, "--yes", "--discard-history"));
    assert.equal(existsSync(join(root, ".cotal", "nats", "jetstream")), false, "the cleanup left the default store without data");
    const started = run("up");
    must("the bare up the stop receipt names", started);
    assert.ok(started.stdout.includes(`reopening ${store}, the store this root's last broker served`), `bare up says it reopens the restored store\n${started.stdout}`);
    const shown = run("channel", "show", "preserved", "--space", space, "--json");
    must("channel show", shown);
    assert.equal((JSON.parse(shown.stdout) as { result: { registry: { channels: Record<string, { description?: string }> } } }).result.registry.channels.preserved?.description, "survives", "the reopened store serves the restored registry");
    assert.equal(existsSync(join(root, ".cotal", "nats", "jetstream")), false, "bare up did not open the empty default store");
    must("down after the reopen", run("down", "--yes"));

    const twoServer = `nats://127.0.0.1:${await freePort()}`;
    must("auth up on store-a", runTwo("up", "--detach", "--no-manager", "--server", twoServer, "--space", "backup_two_stores", "--store-dir", join(twoStores, "store-a")));
    must("down store-a", runTwo("down", "--yes"));
    mkdirSync(join(twoStores, "store-b"));
    must("open up on store-b", runTwo("up", "--detach", "--no-manager", "--open", "--server", twoServer, "--space", "backup_two_stores", "--store-dir", join(twoStores, "store-b")));
    must("down store-b", runTwo("down", "--yes"));
    const ambiguous = runTwo("up", "--no-manager");
    assert.ok(ambiguous.status === 2 && /Code: +CONFLICT/.test(ambiguous.stderr) && ambiguous.stderr.includes("this start names no store"), `two stores with data still refuse a bare up\n${ambiguous.stdout}\n${ambiguous.stderr}`);
    assert.equal(existsSync(join(twoStores, ".cotal", "nats", "jetstream")), false, "the refusal started nothing on the default store");
  } finally {
    runTwo("down", "--yes");
    run("down", "--yes");
    for (const dir of [root, home, twoStores, twoHome]) rmSync(dir, { recursive: true, force: true });
  }
}

async function assertRestoreStorePreflight(run: ReturnType<typeof sandboxRun>["run"], paths: {
  root: string; artifact: string; store: string; blocked: string; server: string; aliasedStore: string;
}): Promise<void> {
  const { root, artifact, store, blocked, server, aliasedStore } = paths;
  const maintenance = join(root, ".cotal", "maintenance");
  const journal = join(maintenance, "v1", "journal.json");
  const resume = join(maintenance, "v1", "resume.json");
  const attempts = join(maintenance, "attempts");
  const snapshot = () => [readFileSync(journal), readFileSync(resume), existsSync(attempts) ? readdirSync(attempts).sort() : null];
  const before = snapshot();
  const loop = join(root, "loop"), finalLink = join(root, "final-link"), dangling = join(root, "dangling");
  symlinkSync("loop", loop);
  symlinkSync(dirname(store), finalLink);
  symlinkSync("missing-parent", dangling);
  const cases = [
    { destination: store, code: "PERMISSION_DENIED", status: 2, native: "EACCES" },
    { destination: aliasedStore, code: "PERMISSION_DENIED", status: 2, native: "EACCES" },
    { destination: finalLink, code: "PERMISSION_DENIED", status: 2, native: "EACCES" },
    { destination: join(loop, "registry-target"), code: "USAGE_INVALID", status: 1, native: "ELOOP" },
    { destination: loop, code: "USAGE_INVALID", status: 1, native: "ELOOP" },
    { destination: join(root, "x".repeat(1024)), code: "USAGE_INVALID", status: 1, native: "ENAMETOOLONG" },
    { destination: join(dangling, basename(store)), code: "USAGE_INVALID", status: 1, native: undefined },
  ];
  chmodSync(blocked, 0o600);
  try {
    for (const args of [["backup", "restore", artifact], ["up", "--restore", artifact, "--detach"]]) {
      for (const { destination, code, status, native } of cases) {
        const refused = run(...args, "--store-dir", destination, "--json");
        assert.equal(refused.status, status, `${refused.stdout}${refused.stderr}`);
        const { outcome, error, target } = JSON.parse(refused.stdout);
        assert.equal(outcome, "refused");
        assert.equal(error.code, code);
        assert.equal(error.cause?.code, native);
        assert.match(error.message, /no restore was started/);
        assert.equal(target.storeDir, destination);
        if (native === "EACCES") {
          assert.equal(target.path, blocked);
          assert.ok(error.message.includes(`cannot search ${blocked}`), error.message);
          assert.ok(error.remedy.includes(`chmod u+x ${shellPath(blocked)}`), error.remedy);
          assert.match(error.remedy, /choose a new store path/);
        } else if (native === undefined) assert.equal(target.path, dangling);
        assert.deepEqual(snapshot(), before, "preflight refusal leaves the preserved cut untouched");
        assert.equal((await probeConnect(server, { timeoutMs: 500 })).ok, false);
      }
    }
  } finally { chmodSync(blocked, 0o700); }
  const accessibleLink = run("backup", "restore", artifact, "--store-dir", finalLink, "--json");
  assert.equal(accessibleLink.status, 1, accessibleLink.stdout);
  assert.equal(JSON.parse(accessibleLink.stdout).target.linkTarget, dirname(store));
  assert.deepEqual(snapshot(), before);
  assert.equal(existsSync(store), false, "the blocked restore did not create a store");
}

async function assertRestoreStoreRechecks(env: NodeJS.ProcessEnv, paths: {
  root: string; artifact: string; store: string; blocked: string; server: string;
}): Promise<void> {
  const { root, artifact, store, blocked, server } = paths;
  const maintenance = join(root, ".cotal", "maintenance");
  const snapshot = () => [
    readFileSync(join(maintenance, "v1", "journal.json")),
    readFileSync(join(maintenance, "v1", "resume.json")),
    readdirSync(maintenance, { recursive: true }).sort(),
  ];
  const before = snapshot();
  const hook = join(root, "change-store-search.cjs");
  // Change the mode immediately before the actual syscall so this does not depend on race timing.
  writeFileSync(hook, `
    const fs = require("node:fs");
    const { statSync, lstatSync } = fs, realpath = fs.realpathSync.native;
    const store = ${JSON.stringify(store)}, parent = ${JSON.stringify(dirname(store))};
    const step = process.env.RESTORE_STORE_CHECK;
    let checkedTarget = false;
    const deny = () => {
      fs.chmodSync(${JSON.stringify(blocked)}, 0o600);
      console.error("changed search access at " + step);
    };
    fs.statSync = (path, options) => {
      if (step === "parent-stat" && path === parent && options?.throwIfNoEntry === false) deny();
      if (step === "launch-stat" && path === ${JSON.stringify(join(store, "jetstream"))}) deny();
      return statSync(path, options);
    };
    fs.lstatSync = (path, options) => {
      if (path === store && options?.throwIfNoEntry === false) {
        if (step === "target-lstat") deny();
        checkedTarget = true;
      }
      return lstatSync(path, options);
    };
    fs.realpathSync.native = (path, options) => {
      if (step === "parent-realpath" && checkedTarget && path === parent) deny();
      return realpath(path, options);
    };
    require("node:module").syncBuiltinESMExports();
  `);
  try {
    for (const step of ["parent-stat", "target-lstat", "parent-realpath", "launch-stat"]) {
      const args = step === "launch-stat" ? ["up", "--restore", artifact, "--detach"] : ["backup", "restore", artifact, "--plain"];
      const refused = spawnSync(process.execPath, ["--require", hook, "--import", import.meta.resolve("tsx"), cliPath, ...args, "--store-dir", store], {
        cwd: root, env: { ...env, RESTORE_STORE_CHECK: step }, encoding: "utf8", timeout: 30_000,
      });
      chmodSync(blocked, 0o700);
      const output = `${refused.stdout}\n${refused.stderr}`;
      assert.ok(output.includes(`changed search access at ${step}`), output);
      assert.equal(refused.status, 2, output);
      assert.match(output, /PERMISSION_DENIED/);
      assert.match(output, /no restore was started/);
      assert.ok(output.replace(/\s+/g, " ").includes(`cannot search ${blocked}`), output);
      assert.deepEqual(snapshot(), before, "the recheck leaves the preserved cut untouched");
      assert.equal(existsSync(store), false, "the recheck did not create a store");
      assert.equal((await probeConnect(server, { timeoutMs: 500 })).ok, false);
    }
  } finally { chmodSync(blocked, 0o700); rmSync(hook); }
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
    const committed = readFileSync(journalPath, "utf8");
    assert.equal(JSON.parse(committed).state, "cut-committed");
    for (const flags of [[], ["--no-manager"]]) {
      const blocked = run("up", ...flags);
      assert.equal(blocked.status, 2, blocked.stderr);
      assert.match(blocked.stderr, /LIFECYCLE_BLOCKED/);
      assert.match(blocked.stderr, /finish the stop with `cotal down --preserve-state`/);
      assert.equal(readFileSync(journalPath, "utf8"), committed);
    }
    const recovered = run("down", "--preserve-state");
    assert.equal(recovered.status, 0, `post-manager-commit cut recovery\nstdout:\n${recovered.stdout}\nstderr:\n${recovered.stderr}`);
    assert.equal((JSON.parse(readFileSync(journalPath, "utf8")) as { state: string }).state, "ready");
  } finally {
    run("down", "--yes");
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
    spawnSync(tsx, [cliPath, "down", "--preserve-state"], crashOptions);
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
    a.run("down", "--yes");
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
    b.run("down", "--yes");
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
    const wrongStore = run("clean", "restore-attempt", "--attempt", "race-stale", "--force", "--store-dir", "./other-store");
    assert.ok(wrongStore.status === 1 && wrongStore.stderr.includes("does not take --store-dir"), `rollback refuses the store path\n${wrongStore.stdout}${wrongStore.stderr}`);
    assert.equal(readMaintenanceJournal(root)?.state, "restore-ready");
    const recovered = run("clean", "restore-attempt", "--attempt", "race-stale", "--force");
    assert.equal(recovered.status, 0, `stale attempt recovery\nstdout:\n${recovered.stdout}\nstderr:\n${recovered.stderr}`);
    assert.match(recovered.stdout, /retry with `cotal up --restore <dir>` \(replace <dir> with the backup directory/, "rollback names the required backup directory for a retry");
    assert.equal(readMaintenanceJournal(root)?.state, "ready", "explicit stale rollback returns the cut to ready");
    const resumed = run("up", "--detach", "--server", server, "--space", space);
    assert.equal(resumed.status, 0, `ordinary resume after recovery\nstdout:\n${resumed.stdout}\nstderr:\n${resumed.stderr}`);
    assert.equal(run("down", "--yes").status, 0);
  } finally {
    run("down", "--yes");
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
    must("down", run("down", "--yes"));
  } finally {
    run("down", "--yes");
    rmSync(root, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  }
}

async function emptyNewerCutScenario(): Promise<void> {
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), "cotal-backup-empty-cut-root-")));
  const home = realpathSync.native(mkdtempSync(join(tmpdir(), "cotal-backup-empty-cut-home-")));
  const { run } = sandboxRun(root, home);
  const server = `nats://127.0.0.1:${await freePort()}`;
  const space = "backup_empty_cut";
  const artifact = join(root, "backup");
  const target = join(root, "restored-store");
  const must = (...args: string[]) => {
    const result = run(...args);
    assert.equal(result.status, 0, `${args.join(" ")}\n${result.stdout}${result.stderr}`);
    return result;
  };
  const restoreWithConsentGuard = (destination: string) => {
    must("down", "--preserve-state", "--yes");
    const cut = readMaintenanceJournal(root);
    assert.ok(cut?.state === "ready");
    const older = must("backup", "restore", artifact, "--store-dir", destination, "--plain");
    assert.match(older.stdout + older.stderr, /--discard-history/);
    const restored = readMaintenanceJournal(root);
    assert.ok(restored?.state === "active");
    assert.equal(restored.launch.previousCutNewer, true);
    const cleanup = ["backup", "cleanup-fallback", restored.restore.attemptId];
    assert.match(must(...cleanup, "--dry-run", "--json").stdout, /HISTORY_ONLY_IN_PREVIOUS_STORE/);
    const refused = run(...cleanup, "--yes", "--plain");
    assert.equal(refused.status, 1, refused.stdout + refused.stderr);
    assert.match(refused.stderr, /USAGE_INVALID/);
    assert.ok(existsSync(cut.source.path) && existsSync(destination), "the refusal keeps both stores");
    assert.deepEqual(readMaintenanceJournal(root), restored, "the refusal keeps the active journal");
    return cleanup;
  };
  const chatLimit = () => {
    const { result } = JSON.parse(must("history", "limit", "--space", space, "--json").stdout) as {
      result: { streams: { stream: string; holds: { maxAgeMs: number | null; perSubject: number | null } }[] };
    };
    return result.streams.find(({ stream }) => stream === chatStream(space))?.holds;
  };
  const fallbackGrant = async (write = false) => {
    const nc = await connect({ servers: server, maxReconnectAttempts: 0 });
    try {
      const acl = await openAclRegistry(nc, space);
      const principal = "local.fallback-only", uid = "a".repeat(26);
      if (write) await commitAcl(acl, principal, uid, ["general"]);
      return (await readAcl(acl, principal, uid))?.record.allowSubscribe;
    } finally {
      await nc.close();
    }
  };
  try {
    must("up", "--detach", "--open", "--server", server, "--space", space);
    const initialLimit = chatLimit();
    assert.ok(initialLimit && initialLimit.maxAgeMs !== 120_000);
    must("down", "--preserve-state", "--yes");
    must("backup", "create", artifact);
    must("up", "--detach");
    must("down", "--preserve-state", "--yes");
    const cut = readMaintenanceJournal(root);
    assert.ok(cut?.state === "ready");
    const manifest = JSON.parse(readFileSync(join(artifact, "manifest.json"), "utf8")) as BackupManifest;
    assert.ok(Date.parse(cut.cut.intentAt) > Date.parse(manifest.createdAt), "the empty cut is newer than its artifact");
    assert.equal(manifest.streams.find(({ stream }) => stream === `KV_${channelBucket(space)}`)?.state.messages, 1, "the positive case compares the stored default");
    assert.equal(manifest.streams.find(({ stream }) => stream === `KV_${aclBucket(space)}`)?.state.last_seq, 0, "the artifact has no grants");

    const restored = must("backup", "restore", artifact, "--store-dir", target, "--plain");
    assert.match(restored.stdout, /The previous store held no additional backed-up state for the restored space\./);
    assert.doesNotMatch(restored.stdout + restored.stderr, /only copy|--discard-history/);
    const active = readMaintenanceJournal(root);
    assert.ok(active?.state === "active");
    assert.equal(active.launch.previousCutNewer, false, "only a verified empty newer cut clears the history guard");
    const cleanup = ["backup", "cleanup-fallback", active.restore.attemptId];
    const preview = must(...cleanup, "--dry-run", "--json");
    assert.doesNotMatch(preview.stdout, /HISTORY_ONLY_IN_PREVIOUS_STORE/);
    assert.ok(existsSync(cut.source.path), "the preview leaves the fallback intact");
    must(...cleanup, "--yes");
    assert.ok(!existsSync(cut.source.path) && existsSync(target), "cleanup removes only the fallback");
    assert.equal(readMaintenanceJournal(root), undefined, "cleanup retires the restore journal");

    must("history", "limit", "--max-age", "2m", "--yes", "--space", space);
    assert.equal(chatLimit()?.maxAgeMs, 120_000, "the newer cut holds the changed limit without any messages");
    const limitCleanup = restoreWithConsentGuard(join(root, "restored-with-original-limit"));
    assert.deepEqual(chatLimit(), initialLimit, "the restored store holds the older policy");
    must(...limitCleanup, "--yes", "--discard-history");

    assert.deepEqual(await fallbackGrant(true), ["general"], "the cut holds a grant written after the artifact");
    const grantCleanup = restoreWithConsentGuard(join(root, "restored-without-new-grant"));
    assert.equal(await fallbackGrant(), undefined, "the restored store has no such grant");
    must(...grantCleanup, "--yes", "--discard-history");

    must("channel", "set", "fallback-only", "--desc", "setting created after backup", "--space", space);
    assert.match(must("channel", "--space", space).stdout, /#fallback-only/);
    restoreWithConsentGuard(join(root, "restored-without-new-settings"));
    assert.doesNotMatch(must("channel", "--space", space).stdout, /#fallback-only/);
  } finally {
    run("down", "--yes");
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
    must("down", run("down", "--yes"));
  } finally {
    run("down", "--yes");
    rmSync(root, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  }
}

/** A store that holds an open mesh's account beside the static space's, after both ran in one root. A
 *  static backup holds one account, so its restore says the open account's streams stay only in the
 *  store it set aside, `status` and the cleanup preview name them, and the cleanup refuses without
 *  --discard-history and keeps them. */
async function otherAccountScenario(): Promise<void> {
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), "cotal-backup-other-account-root-")));
  const home = realpathSync.native(mkdtempSync(join(tmpdir(), "cotal-backup-other-account-home-")));
  const server = `nats://127.0.0.1:${await freePort()}`;
  const space = "backup_other_account";
  const { run } = sandboxRun(root, home);
  const must = (label: string, result: ReturnType<typeof run>) => {
    assert.equal(result.status, 0, `other account ${label}\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
    return result;
  };
  try {
    must("static up", run("up", "--detach", "--server", server, "--space", space));
    must("static down", run("down", "--yes"));
    must("open up", run("up", "--detach", "--open", "--server", server, "--space", space));
    must("open send", run("send", "-c", "general", "open-account-marker", "--space", space));
    must("open down", run("down", "--yes"));
    must("static up again", run("up", "--detach", "--server", server, "--space", space));
    must("preserve cut", run("down", "--preserve-state"));
    const artifact = join(root, "static-backup");
    must("backup", run("backup", "create", artifact));
    const restored = must("restore", run("backup", "restore", artifact, "--json"));
    const journal = JSON.parse(readFileSync(join(root, ".cotal", "maintenance", "v1", "journal.json"), "utf8")) as { restore: { attemptId: string; previousSource: { identity: { path: string } } }; launch: { otherAccounts?: unknown } };
    const attemptId = journal.restore.attemptId, previous = journal.restore.previousSource.identity.path;
    const messages = join(previous, "jetstream", "$G", "streams", `CHAT_${space}`, "msgs");
    const kept = () => existsSync(messages) && readdirSync(messages).some((name) => readFileSync(join(messages, name)).includes("open-account-marker"));
    assert.ok(kept(), "the open account's message is in the store the restore set aside");
    assert.equal(existsSync(join(root, ".cotal", "nats", "jetstream", "$G")), false, "the restored store holds only the static account");
    assert.deepEqual(journal.launch.otherAccounts, ["$G"], "the restore journals the other account in the store it set aside");
    const receipt = JSON.parse(restored.stdout) as { result: { previousStore: string | null }; warnings: { code: string; target: unknown }[] };
    assert.equal(receipt.result.previousStore, previous, `the receipt names the store that holds the open account\n${restored.stdout}`);
    assert.deepEqual(receipt.warnings.find((warning) => warning.code === "OTHER_ACCOUNTS_NOT_RESTORED")?.target, { space, previousStore: previous, otherAccounts: ["$G"] }, `the receipt says the open account is not restored\n${restored.stdout}`);
    const status = must("status", run("status", "--space", space));
    assert.ok(["cotal", "pnpm cotal"].some((cli) => status.stdout.includes(`\`${cli} backup cleanup-fallback ${attemptId} --dry-run\``)) && status.stdout.includes("requires --discard-history and removes the only copy of the streams of account $G"), `status previews cleanup and names the consent it needs\n${status.stdout}`);
    const preview = JSON.parse(must("cleanup preview", run("backup", "cleanup-fallback", attemptId, "--dry-run", "--json")).stdout) as { warnings: { code: string; target: { otherAccounts?: string[] } }[] };
    assert.deepEqual(preview.warnings.find((warning) => warning.code === "HISTORY_ONLY_IN_PREVIOUS_STORE")?.target.otherAccounts, ["$G"], "the cleanup preview names the open account");
    const refused = run("backup", "cleanup-fallback", attemptId, "--yes", "--json");
    assert.ok(refused.status === 1 && (JSON.parse(refused.stdout) as { error?: { code?: string } }).error?.code === "USAGE_INVALID", `cleanup without --discard-history refuses\n${refused.stdout}${refused.stderr}`);
    assert.ok(kept(), "the refused cleanup keeps the open account's message");
    must("down", run("down", "--yes"));
  } finally {
    run("down", "--yes");
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
    must("down", run("down", "--yes"));
  } finally {
    run("down", "--yes");
    rmSync(root, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  }
}

/** A prepared controller root cannot make the preserved cut that backup or restore needs. */
function preparedBackupGuidance(): void {
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), "cotal-backup-prepared-root-")));
  const home = realpathSync.native(mkdtempSync(join(tmpdir(), "cotal-backup-prepared-home-")));
  const { run } = sandboxRun(root, home);
  try {
    const space = "docs-backup-retry";
    const prepared = run("space", "create", space, "--root", ".");
    assert.equal(prepared.status, 0, prepared.stderr);
    for (const args of [
      ["backup", "restore", "./space-backup", "--plain"],
      ["up", "--restore", "./space-backup", "--plain"],
    ] as const) {
      const restore = run(...args);
      assert.equal(restore.status, 2, restore.stderr);
      assert.match(restore.stderr, /LIFECYCLE_BLOCKED/);
      assert.match(restore.stderr, /restore requires stable ready maintenance state, found none/);
      assert.match(restore.stderr, /run `cotal space show` to inspect this prepared space/);
      assert.match(restore.stderr, /does not support preservation or restore in this release/);
      assert.doesNotMatch(restore.stderr, /down --preserve-state/);
    }
    assert.equal(existsSync(join(root, ".cotal", "maintenance")), false);
    const selected = run("use", space);
    assert.equal(selected.status, 0, selected.stderr);
    const backup = run("backup", "create", "./space-backup", "--only", "registry", "--plain");
    assert.equal(backup.status, 2, backup.stderr);
    assert.match(backup.stderr, /LIFECYCLE_BLOCKED/);
    assert.match(backup.stderr, /run `cotal space show` to inspect this prepared space/);
    assert.match(backup.stderr, /does not support preservation or backup in this release/);
    assert.doesNotMatch(backup.stderr, /down --preserve-state/);
    const shown = run("space", "show", "--json");
    assert.equal(shown.status, 0, shown.stderr);
    assert.equal(JSON.parse(shown.stdout).result.kind, "prepared-space", shown.stdout);
    assert.equal(existsSync(join(root, "space-backup")), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  }
}

async function addPluginSnapshot(nc: NatsConnection, history: string, original: string, artifact: string): Promise<void> {
  cpSync(original, artifact, { recursive: true });
  const manifestPath = join(artifact, "manifest.json");
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as BackupManifest;
  const chunks: Buffer[] = [];
  const { config, state } = await downloadStreamSnapshot(nc, history, {
    deliverSubject: "_INBOX_plugin_backup_fixture.snapshot",
    onChunk: (chunk) => { chunks.push(Buffer.from(chunk)); },
  });
  const path = "plugin-history.snap";
  const bytes = Buffer.concat(chunks);
  writeFileSync(join(artifact, path), bytes, { mode: 0o600 });
  manifest.streams.push({ stream: history, snapshot: path, config, state });
  manifest.files.push({ path, kind: "snapshot", stream: history, size: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") });
  writeFileSync(manifestPath, JSON.stringify(manifest));
}

async function pluginHistoryScenario(): Promise<void> {
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), "cotal-plugin-backup-root-")));
  const home = realpathSync.native(mkdtempSync(join(tmpdir(), "cotal-plugin-backup-home-")));
  const { env, sandbox } = sandboxRun(root, home);
  const server = `nats://127.0.0.1:${await freePort()}`;
  const space = "plugin_history_backup";
  const [history] = spacePluginStreams(space);
  const artifact = join(root, "plugin-backup");
  const run = (...args: string[]) => {
    const options = { cwd: root, env, encoding: "utf8" as const, timeout: 240_000 };
    assertSmokeSandboxDown(sandbox, args, options);
    return spawnSync(process.execPath, [join(worktree, "bin", "dist", "cotal.js"), ...args], options);
  };
  const must = (...args: string[]) => {
    const result = run(...args);
    assert.equal(result.status, 0, `${args.join(" ")}\n${result.stdout}\n${result.stderr}`);
    return result;
  };
  try {
    must("up", "--detach", "--server", server, "--space", space);
    const older = join(root, "before-plugin-history");
    must("down", "--preserve-state");
    must("backup", "create", older, "--json");
    must("up", "--detach");
    const auth = loadSoleSpaceAuth(authDir(root));
    assert.ok(auth);
    must("send", "-c", "general", "keep this chat post", "--json");
    const provisioner = newIdentity(), author = newIdentity();
    const subject = pluginChannelSubject(space, provisioner.id, author.id, `${PLUGIN_CHANNEL_ROOT}.alpha.work`);
    const records = recordsBucket(space);
    const bearing = join(root, "artifact-with-plugin-history");
    const fixture = () => openSigned(server, auth, "plugin_backup_fixture", {
      pub: { allow: ["$JS.API.INFO", `$JS.API.STREAM.CREATE.${history}`, `$JS.API.STREAM.INFO.${history}`,
        `$JS.API.STREAM.INFO.KV_${records}`, `$JS.API.STREAM.INFO.${chatStream(space)}`, `$JS.API.CONSUMER.CREATE.${history}.>`,
        `$JS.API.CONSUMER.INFO.${history}.${PLUGIN_FANOUT_DURABLE}`, `$JS.API.STREAM.SNAPSHOT.${history}`, `$JS.SNAPSHOT.ACK.${history}.>`, pluginChannelSpaceStateSubject(space), subject] },
      sub: { allow: ["_INBOX_plugin_backup_fixture.>"] },
    });
    const seed = await fixture();
    try {
      const manager = await jetstreamManager(seed);
      await manager.streams.add(canonicalBackupStreamConfig(space, history!));
      await manager.consumers.add(history!, pluginFanoutDurableConfig(space));
      const published = await jetstream(seed).publish(subject, new Uint8Array([42]));
      assert.equal(published.stream, history);
      await addPluginSnapshot(seed, history!, older, bearing);
    } finally { await seed.close(); }
    const refusesWith = (reason: RegExp, ...args: string[]) => {
      const result = run(...args);
      assert.notEqual(result.status, 0, `${args.join(" ")} unexpectedly succeeded`);
      assert.match(`${result.stdout}\n${result.stderr}`, reason);
    };
    must("down", "--preserve-state");
    const journal = join(root, ".cotal", "maintenance", "v1", "journal.json");
    const attempts = join(root, ".cotal", "maintenance", "attempts");
    const readAttempts = () => existsSync(attempts) ? readdirSync(attempts).sort() : null;
    const stamp = (path: string) => {
      if (!existsSync(path)) return null;
      const { dev, ino, mtimeNs } = lstatSync(path, { bigint: true });
      return { dev, ino, mtimeNs };
    };
    const before = readFileSync(journal), beforeJournalStamp = stamp(journal);
    const beforeAttempts = readAttempts(), beforeAttemptsStamp = stamp(attempts);
    const assertUnchanged = () => {
      assert.deepEqual(readFileSync(journal), before, "the preserved journal is byte-identical");
      assert.deepEqual(stamp(journal), beforeJournalStamp, "the journal was not written or replaced");
      assert.deepEqual(readAttempts(), beforeAttempts, "restore refusal leaves no new clone or staging file");
      assert.deepEqual(stamp(attempts), beforeAttemptsStamp, "restore refusal never creates scratch entries");
    };
    const refusedArtifact = /the backup contains plugin channel history, but the destination does not have plugin channels enabled/;
    refusesWith(refusedArtifact, "backup", "restore", bearing, "--plain");
    assertUnchanged();
    refusesWith(refusedArtifact, "backup", "restore", bearing, "--only", "registry", "--plain");
    assertUnchanged();
    must("up", "--detach");
    const stateWriter = await fixture();
    try {
      const recordsKv = await openRecordsBucket(stateWriter, space);
      await recordsKv.put(PLUGIN_CHANNEL_SPACE_STATE_KEY, JSON.stringify({ version: 1, epoch: "invalid", enabled: false }));
      refusesWith(/could not read plugin channel state in records store .*invalid or unsupported plugin channel space state/s, "history", "clear", "--yes", "--plain");
      await recordsKv.put(PLUGIN_CHANNEL_SPACE_STATE_KEY, JSON.stringify({ version: 1, epoch: 1, enabled: true }));
    } finally { await stateWriter.close(); }
    const refuses = (...args: string[]) => {
      const result = run(...args);
      const output = result.stdout + result.stderr;
      assert.notEqual(result.status, 0, `${args.join(" ")} unexpectedly succeeded`);
      assert.match(output, /this release does not support enabled plugin channels/);
      assert.doesNotMatch(output, /could not read plugin channel state/);
    };
    refuses("history", "limit", "--plain");
    refuses("history", "limit", "--per-sender", "50", "--yes", "--plain");
    refuses("history", "clear", "--yes", "--plain");
    refuses("clean", "history", "--force");
    refusesWith(/plugin channel state is unsupported or could not be verified.*no delete request was submitted/s, "space", "delete", space, "--dry-run", "--plain");
    const reader = await fixture();
    try {
      const manager = await jetstreamManager(reader);
      assert.equal((await manager.streams.info(history!)).state.messages, 1);
      assert.equal((await manager.streams.info(chatStream(space))).state.messages, 1);
    } finally { await reader.close(); }
    must("down", "--preserve-state");
    const preserved = readMaintenanceJournal(root);
    assert.ok(preserved?.state === "ready");
    refuses("backup", "create", artifact, "--plain");
    assert.equal(existsSync(artifact), false);
    refuses("backup", "restore", older, "--plain");
    const rolledBack = readMaintenanceJournal(root);
    assert.ok(rolledBack?.state === "ready");
    assert.deepEqual(rolledBack.source, preserved.source);
    assert.ok(!readdirSync(attempts).some((name) => name.endsWith("-clone")), "the previous-store inspection clone was removed");
    must("up", "--detach");
    const afterRestore = await fixture();
    try {
      const manager = await jetstreamManager(afterRestore);
      assert.equal((await manager.streams.info(history!)).state.messages, 1);
      assert.equal((await manager.streams.info(chatStream(space))).state.messages, 1);
    } finally { await afterRestore.close(); }
    console.log("plugin history: enabled state was refused and the previous store reopened with both posts after rollback");
  } finally {
    run("down", "--yes");
    rmSync(root, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  }
}

async function legacyMissingRecordsScenario(): Promise<void> {
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), "cotal-legacy-records-root-")));
  const home = realpathSync.native(mkdtempSync(join(tmpdir(), "cotal-legacy-records-home-")));
  const { env, sandbox } = sandboxRun(root, home);
  const space = "legacy_missing_records";
  const server = `nats://127.0.0.1:${await freePort()}`;
  const run = (...args: string[]) => {
    const options = { cwd: root, env, encoding: "utf8" as const, timeout: 240_000 };
    assertSmokeSandboxDown(sandbox, args, options);
    return spawnSync(process.execPath, [join(worktree, "bin", "dist", "cotal.js"), ...args], options);
  };
  const must = (...args: string[]) => {
    const result = run(...args);
    assert.equal(result.status, 0, `${args.join(" ")}\n${result.stdout}\n${result.stderr}`);
    return result;
  };
  try {
    must("up", "--detach", "--server", server, "--space", space);
    const auth = loadSoleSpaceAuth(authDir(root));
    assert.ok(auth);
    const records = `KV_${recordsBucket(space)}`;
    const fixture = await openSigned(server, auth, "legacy_records_fixture", {
      pub: { allow: ["$JS.API.INFO", `$JS.API.STREAM.DELETE.${records}`] },
      sub: { allow: ["_INBOX_legacy_records_fixture.>"] },
    });
    try { assert.equal(await (await jetstreamManager(fixture)).streams.delete(records), true); }
    finally { await fixture.close(); }
    must("history", "limit", "--json");
    must("history", "clear", "--yes", "--json");
    must("clean", "history", "--force");
    must("down", "--preserve-state");
    const artifact = join(root, "missing-records-backup");
    const backup = run("backup", "create", artifact, "--plain");
    assert.notEqual(backup.status, 0);
    assert.ok(`${backup.stdout}\n${backup.stderr}`.includes(`space backup inventory mismatch: missing [${records}]`), backup.stderr);
    assert.equal(existsSync(artifact), false);
    assert.equal(readMaintenanceJournal(root)?.state, "ready");
    console.log("plugin history: a missing legacy records store still allows local retention and both chat purges");
  } finally {
    try { run("down", "--yes"); }
    finally {
      rmSync(root, { recursive: true, force: true });
      rmSync(home, { recursive: true, force: true });
    }
  }
}

// BEGIN authenticated restore resource parity cell
async function authenticatedRestoreResourceParity(): Promise<void> {
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), "cotal-restore-resources-root-")));
  const home = realpathSync.native(mkdtempSync(join(tmpdir(), "cotal-restore-resources-home-")));
  const { env, sandbox } = sandboxRun(root, home);
  const server = `nats://127.0.0.1:${await freePort()}`;
  const space = "restore_resource_parity";
  const artifact = join(root, "backup");
  const preload = join(home, "restore-resources.cjs");
  const trace = join(home, "restore-resources.log");
  writeFileSync(preload, `
const fs = require('node:fs');
const cp = require('node:child_process');
const { basename, dirname } = require('node:path');
const attempts = ${JSON.stringify(join(root, ".cotal", "maintenance", "attempts"))};
const emit = event => fs.appendFileSync(${JSON.stringify(trace)}, event + '\\n');
const mkdir = fs.mkdirSync;
fs.mkdirSync = function(path, ...args) {
  const result = mkdir.call(this, path, ...args);
  if (typeof path === 'string' && dirname(path) === attempts && path.endsWith('-clone')) emit('clone');
  return result;
};
const spawn = cp.spawn;
cp.spawn = function(file, args, ...options) {
  const child = spawn.call(this, file, args, ...options);
  if (child.pid && /^nats-server(?:\\.exe)?$/.test(basename(file))) {
    const config = Array.isArray(args) && args.includes('-c') ? args[args.indexOf('-c') + 1] : undefined;
    emit(config && dirname(config) === attempts ? 'isolated' : 'listener');
  }
  return child;
};
require('node:module').syncBuiltinESMExports();
`);
  const run = (args: string[], observe = false) => {
    const options = { cwd: root, env: observe ? { ...env, NODE_OPTIONS: `--require=${preload}` } : env, encoding: "utf8" as const, timeout: 240_000 };
    assertSmokeSandboxDown(sandbox, args, options);
    return spawnSync(process.execPath, [join(worktree, "bin", "dist", "cotal.js"), ...args], options);
  };
  const must = (args: string[], observe = false) => {
    const result = run(args, observe);
    assert.equal(result.status, 0, `${args.join(" ")}\n${result.stdout}\n${result.stderr}`);
  };
  const restore = (label: string, clones: number, isolated: number) => {
    writeFileSync(trace, "");
    must(["backup", "restore", artifact, "--plain"], true);
    const events = readFileSync(trace, "utf8").trim().split("\n");
    const counts = { clones: events.filter((event) => event === "clone").length, isolated: events.filter((event) => event === "isolated").length, listeners: events.filter((event) => event === "listener").length };
    console.log(`AUTH_RESTORE_RESOURCES ${label} ${JSON.stringify(counts)}`);
    assert.deepEqual(counts, { clones, isolated, listeners: 1 });
    const active = readMaintenanceJournal(root);
    assert.ok(active?.state === "active");
    return active.restore.attemptId;
  };
  try {
    must(["up", "--detach", "--server", server, "--space", space]);
    must(["down", "--preserve-state"]);
    must(["backup", "create", artifact, "--plain"]);
    const first = restore("same-cut", 0, 2);
    must(["backup", "cleanup-fallback", first, "--yes"]);
    must(["down", "--preserve-state"]);
    restore("newer-cut", 1, 3);
  } finally {
    run(["down", "--yes"]);
    rmSync(root, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  }
}
// END authenticated restore resource parity cell

await authenticatedRestoreResourceParity();
if (process.argv.includes("--restore-resource-parity-only")) process.exit(0);
await pluginHistoryScenario();
await legacyMissingRecordsScenario();
if (process.argv.includes("--plugin-history-only")) process.exit(0);
preparedBackupGuidance();
await missingPidfileListenerScenario();
await undisplayableBackupRetryScenario();
await linkedStoreScenario();
await missingCustomSourceScenario();
await missingRegistrySourceGuidanceScenario();
await restoredStoreRestartScenario();
await preservationCommitCrashScenario();
await preservationStopCrashRecoveryScenario();
await restoreClaimRaceScenario();
await backupRestoreCycleScenario();
await emptyNewerCutScenario();
await rolledBackRunsScenario();
await otherAccountScenario();
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
await uninterruptedUnreadableRestore();
await firstUnreadableRestoreScenario("match");
await firstUnreadableRestoreScenario("mismatch");
await unpublishedUnreadableRestoreScenario();
await unpublishedUnreadableRestoreScenario("rearm");
await unpublishedUnreadableRestoreScenario("replace");
await oldJournalUnreadableRestoreScenario();
await boundForeignListenerScenario();
console.log("backup/restore live smoke: ok");
