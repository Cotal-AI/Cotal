import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { pathToFileURL } from "node:url";
import { eventChannel, mintLifecycleUid, principalKey, type CotalEndpoint, type SpaceAuth } from "@cotal-ai/core";
import { workspaceSecretStore } from "@cotal-ai/workspace";
import { openAuthorityClient } from "../src/authority-client.js";
import { findManagedActor } from "../src/ledger.js";
import { openLifecycleRegistry } from "../src/lifecycle-registry.js";
import { cotalAuthProvider } from "@cotal-ai/auth";
import { ensureRootCredential, ROOT_CREDENTIAL_TTL_MS } from "../src/root-credential.js";

/** Model only the native application; spawn, bearer exchange and broker admission stay live. */
export async function foregroundRootExpiry({ root, dir, space, server, owner, auth, env, observer, childProgram }: {
  root: string; dir: string; space: string; server: string; owner: string; auth: SpaceAuth;
  env: NodeJS.ProcessEnv; observer: CotalEndpoint; childProgram: string;
}): Promise<void> {
  const actor = "expiry_fixture", replacement = "expiry_replacement";
  const uid = mintLifecycleUid(), store = workspaceSecretStore(root);
  const token = join(root, "foreground-root-fixture.token");
  const { actorToken } = await cotalAuthProvider.grantAgent({ store, dir, space, owner, actor,
    scope: [], allowSubscribe: ["general"], allowPublish: [eventChannel({ owner, actor })], parent: `${owner}.cli`,
    lifecycleUid: uid, custody: { kind: "foreground" } });
  writeFileSync(token, actorToken, { mode: 0o600, flag: "wx" });
  const admin = await openAuthorityClient({ server, space, dataAccount: { pub: auth.account.pub, signingSeed: auth.account.signingSeed! },
    label: "foreground-root-fixture", grants: id => ({ publish: [">"], subscribe: [`_INBOX_${id}.>`] }), log: () => {} });
  const expiredAt = Date.now() - 1000;
  try {
    // Mint the fixture's root with an explicit time; no clock or persisted record is rewritten.
    const registry = await openLifecycleRegistry(admin.nc, space);
    await ensureRootCredential(registry, { owner, actor, lifecycleUid: uid, managerInstance: "foreground",
      now: () => expiredAt - ROOT_CREDENTIAL_TTL_MS });
  } finally { await admin.close(); }

  const cli = resolve(import.meta.dirname, "../../../bin/dist/cotal.js");
  const corePath = resolve(import.meta.dirname, "../../../packages/core/dist/index.js");
  const core = pathToFileURL(corePath).href;
  const preload = join(root, "foreground-root-connector.mjs");
  const persona = join(root, "foreground-root-persona.md");
  writeFileSync(preload, `import { eventChannel, registry } from ${JSON.stringify(core)};
registry.register({kind:"connector",name:"expiry-fixture",eventChannel,
  buildLaunch:o=>({command:process.execPath,args:["-e",${JSON.stringify(childProgram)}],env:{
    HOME:process.env.HOME,PATH:process.env.PATH,TMPDIR:process.env.TMPDIR,COTAL_HOME:process.env.COTAL_HOME,
    CORE_DIST:${JSON.stringify(corePath)},COTAL_SPACE:o.space,COTAL_SERVERS:o.servers,COTAL_NAME:o.name,
    COTAL_OWNER:o.userAuth.owner,COTAL_ACTOR:o.userAuth.actor,COTAL_BEARER_CMD:JSON.stringify(o.userAuth.bearerCmd),
    COTAL_SENTINEL_CREDS:o.userAuth.sentinelCredsPath,COTAL_LIFECYCLE_UID:o.lifecycleUid,
  }})});`);
  writeFileSync(persona, `---\nname: ${actor}\nsubscribe: [general]\nallowSubscribe: [general]\nallowPublish: []\n---\nFixture for foreground root expiry.\n`);
  const run = (args: string[]) => {
    const child = spawn(process.execPath, ["--import", preload, cli, ...args], { cwd: root, env, stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    child.stdout.on("data", (chunk: Buffer) => { out = (out + chunk.toString()).slice(-8192); });
    child.stderr.on("data", (chunk: Buffer) => { out = (out + chunk.toString()).slice(-8192); });
    const timer = setTimeout(() => child.kill("SIGTERM"), 25_000);
    const kill = setTimeout(() => child.kill("SIGKILL"), 32_000);
    const closed = new Promise<number | null>((ok, fail) => { child.once("error", fail); child.once("close", ok); })
      .finally(() => { clearTimeout(timer); clearTimeout(kill); });
    return { child, closed, output: () => out };
  };
  try {
    const refused = run(["agent-bearer", "--dir", dir, "--space", space, "--owner", owner, "--actor", actor, "--token-file", token]);
    assert.equal(await refused.closed, 1, refused.output());
    assert.ok(refused.output().includes(`expired at ${new Date(expiredAt).toISOString()} (UTC).`), refused.output());
    assert.ok(refused.output().includes("End this foreground launch. In the original `cotal spawn` command, change `--name` to `<new_name>`, or add `--name <new_name>` if it had none. Rerun the command to start a new agent. The old name stays taken, and no command in this release frees it. The old agent's permissions don't move. Messages to its old name and direct messages already queued for it won't reach the new agent."), refused.output());
  } finally {
    // Mirror foreground exit's owned grant cleanup; this deliberately does not retire the alias.
    await cotalAuthProvider.revokeAgent({ dir, owner, actor, lifecycleUid: uid, actorToken });
    rmSync(token, { force: true });
  }
  const launch = ["spawn", "--file", persona, "--harness", "expiry-fixture", "--space", space];
  const same = run([...launch, "--name", actor]);
  assert.equal(await same.closed, 1, same.output());
  assert.match(same.output(), /active at uid.*takeover barrier/s);
  const fresh = run([...launch, "--name", replacement]);
  try {
    const id = principalKey(owner, replacement).key;
    const joined = () => observer.getRoster().some(p => p.card.id === id && p.status !== "offline");
    const deadline = Date.now() + 20_000;
    while (!joined() && fresh.child.exitCode === null && fresh.child.signalCode === null && Date.now() < deadline) await sleep(100);
    assert.ok(joined(), fresh.output());
    const grant = findManagedActor(dir, owner, replacement);
    assert.ok(grant?.lifecycleUid && grant.lifecycleUid !== uid);
    assert.equal(grant.parent, `${owner}.cli`);
    assert.deepEqual(grant.scope, []);
    assert.deepEqual(grant.allowSubscribe, ["general"]);
    assert.deepEqual(grant.allowPublish, [eventChannel({ owner, actor: replacement })]);
  } finally {
    fresh.child.kill("SIGTERM");
    await fresh.closed;
  }
}
