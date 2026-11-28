/** Credential joins diagnose missing read grants and mismatched lifecycles (#6009).
 * Runs the published command entry with credentials minted by `auth mint --provision`,
 * against a real authenticated broker and bound delivery responder. */
import { strict as assert } from "node:assert";
import { spawn, type ChildProcess } from "node:child_process";
import { createRequire } from "node:module";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import {
  CotalEndpoint, PLUGIN_CHANNEL_ROOT, createSpaceAuth, mintCreds, mintLifecycleUid,
  newIdentity, seedChannelRegistry, setupSpaceStreams,
} from "@cotal-ai/core";
import { authDir, recordMesh, removeMesh, saveSpaceAuth } from "@cotal-ai/workspace";
import { emitSentinel, freePort, killAndAwaitExit } from "@cotal-ai/smoke-kit";
import { bootBroker } from "../../manager/smoke/_boot-broker.js";
import { startEnabledPluginSpace } from "../../../packages/core/smoke/fixtures/enabled-plugin-space.js";
import { cotalPty, clean, type Pty } from "./_console-pty.js";

const tree = resolve(import.meta.dirname, "../../..");
const dir = mkdtempSync(join(tmpdir(), "join-creds-grants-"));
const project = join(dir, "project");
mkdirSync(project);
const space = "join-creds-grants";
const env = { ...process.env };
for (const key of Object.keys(env)) if (key.startsWith("COTAL_")) delete env[key];
Object.assign(env, { COTAL_HOME: join(dir, "home"), XDG_CONFIG_HOME: join(dir, "xdg"), COTAL_SKIP_CONNECTOR_SEED: "1", COTAL_NO_PROMPT: "1", COTAL_TELEMETRY: "off" });
// The parent also writes only this fixture's registry.
process.env.COTAL_HOME = env.COTAL_HOME;
const tsxLoader = pathToFileURL(createRequire(import.meta.url).resolve("tsx")).href;
const children = new Set<ChildProcess>();
const terminals = new Set<Pty>();
function cli(...args: string[]) {
  const proc = spawn(process.execPath, ["--import", tsxLoader, join(tree, "bin/cotal.ts"), ...args], { cwd: project, env, stdio: ["ignore", "pipe", "pipe"] });
  children.add(proc);
  let text = "";
  proc.stdout.on("data", (b: Buffer) => { text += b.toString(); });
  proc.stderr.on("data", (b: Buffer) => { text += b.toString(); });
  const exited = new Promise<number | null>((resolve, reject) => {
    proc.once("error", reject);
    proc.once("close", (code) => { children.delete(proc); resolve(code); });
  });
  return { proc, exited, output: () => text.replace(/\x1b\[[0-9;]*m/g, "") };
}
async function until(cond: () => boolean, ms = 30_000) {
  const deadline = Date.now() + ms;
  while (!cond() && Date.now() < deadline) await new Promise((r) => setTimeout(r, 50));
  assert.ok(cond(), "CLI did not reach a terminal or ready state before its deadline");
}
let passed = 0;
function check(name: string, condition: boolean, detail?: string) {
  assert.ok(condition, `${name}${detail ? `: ${detail}` : ""}`);
  passed++;
  console.log(`  ✓ ${name}`);
}

async function checkEnabledJoin(): Promise<void> {
  const fixture = await startEnabledPluginSpace();
  const { space, servers, channel, hiddenChannel } = fixture;
  try {
    await fixture.startDelivery();
    const { creds, lifecycleUid } = await fixture.mintAgent({ read: [channel], post: [channel] });
    const file = join(dir, "isolated-join.creds");
    writeFileSync(file, creds, { mode: 0o600 });
    const args = ["join", "--space", space, "--server", servers, "--creds", file, "--lifecycle-uid", lifecycleUid, "--name", "plugin-reader"];
    const accepted = cli(...args, "--channel", channel);
    try {
      await until(() => accepted.output().includes("holding presence") || accepted.proc.exitCode !== null);
      check("an explicit scoped credential joins the named isolated plugin channel",
        accepted.proc.exitCode === null && accepted.output().includes("holding presence"), accepted.output());
    } finally {
      await killAndAwaitExit(accepted.proc);
      await accepted.exited;
    }
    const denied = cli(...args, "--channel", hiddenChannel);
    check("the same credential cannot join the other isolated channel", await denied.exited === 2 &&
      denied.output().includes("PERMISSION_DENIED") && denied.output().includes(`does not grant read access to #${hiddenChannel}`) &&
      !denied.output().includes("cotal auth mint"), denied.output());

    const old = await fixture.mintAgent({ legacy: true, read: [fixture.chatChannel, hiddenChannel], post: [fixture.chatChannel, hiddenChannel] });
    const oldFile = join(dir, "enabled-legacy-join.creds");
    writeFileSync(oldFile, old.creds, { mode: 0o600 });
    const oldArgs = ["join", "--space", space, "--server", servers, "--creds", oldFile, "--lifecycle-uid", old.lifecycleUid];
    const unmapped = cli(...oldArgs, "--channel", hiddenChannel);
    check("a legacy CHAT grant cannot join an isolated destination", await unmapped.exited === 2 &&
      unmapped.output().includes("PERMISSION_DENIED") && unmapped.output().includes(`does not grant read access to #${hiddenChannel}`), unmapped.output());
    const ordinary = cli(...oldArgs, "--channel", fixture.chatChannel);
    try {
      await until(() => ordinary.output().includes("holding presence") || ordinary.proc.exitCode !== null);
      check("the pre-activation credential still joins ordinary CHAT", ordinary.proc.exitCode === null && ordinary.output().includes("holding presence"), ordinary.output());
    } finally {
      await killAndAwaitExit(ordinary.proc);
      await ordinary.exited;
    }
    await fixture.writeProjection({});
    const unreadable = cli(...args, "--channel", channel);
    check("explicit join refuses an unreadable projection before holding presence", await unreadable.exited === 2 &&
      unreadable.output().includes("PERMISSION_DENIED") && unreadable.output().includes("This credential cannot see plugin channels.") &&
      !unreadable.output().includes("holding presence") && !unreadable.output().includes("cotal auth mint"), unreadable.output());
    await fixture.writeProjection({ enabled: true, epoch: 1 });
    await checkBareStaticJoin(fixture);
  } finally {
    await fixture.close();
  }
}

async function checkBareStaticJoin(fixture: Awaited<ReturnType<typeof startEnabledPluginSpace>>): Promise<void> {
  const { space, servers, channel, chatChannel, auth } = fixture;
  const root = join(dir, space);
  mkdirSync(root);
  saveSpaceAuth(authDir(root), auth);
  recordMesh({ space, server: servers, root, mode: "auth", ts: new Date().toISOString() });
  const args = ["join", "--space", space, "--name", "static-seat"];
  try {
    const reader = cli(...args, "--channel", channel);
    try {
      await until(() => reader.output().includes("holding presence") || reader.proc.exitCode !== null);
      check("bare static join self-mints a seat on the admitted plugin channel", reader.proc.exitCode === null && reader.output().includes("holding presence"), reader.output());
      const author = await fixture.mintAgent({ post: [channel] });
      const file = join(dir, "static-join-plugin-author.creds");
      writeFileSync(file, author.creds, { mode: 0o600 });
      const text = "isolated post delivered to self-minted terminal seat";
      const post = cli("send", "--space", space, "--creds", file, "-c", channel, text);
      check("the scoped writer stores the isolated post", await post.exited === 0, post.output());
      await until(() => reader.output().includes(text) || reader.proc.exitCode !== null);
      check("the bare static seat receives the scoped isolated post", reader.proc.exitCode === null && reader.output().includes(text), reader.output());
    } finally {
      await killAndAwaitExit(reader.proc);
      await reader.exited;
    }

    await fixture.writeAuthority({ version: 1, enabled: true, epoch: "bad" });
    const refused = cli(...args, "--channel", channel);
    check("bare static join refuses a malformed leader row before holding presence", await refused.exited === 2 &&
      refused.output().includes("PERMISSION_DENIED") && refused.output().includes("This credential cannot see plugin channels.") &&
      !refused.output().includes("holding presence") && !refused.output().includes("cotal auth mint"), refused.output());

    const ordinary = cli(...args, "--channel", chatChannel);
    try {
      await until(() => ordinary.output().includes("holding presence") || ordinary.proc.exitCode !== null);
      check("bare static join still admits ordinary CHAT with a malformed plugin leader row",
        ordinary.proc.exitCode === null && ordinary.output().includes("holding presence"), ordinary.output());
    } finally {
      await killAndAwaitExit(ordinary.proc);
      await ordinary.exited;
    }
  } finally {
    removeMesh(space);
  }
}

const auth = await createSpaceAuth(space);
const broker = await bootBroker(auth);
let daemon: CotalEndpoint | undefined;
try {
  saveSpaceAuth(authDir(project), auth);
  recordMesh({ space, server: broker.servers, root: project, mode: "auth", ts: new Date().toISOString() });
  const provisioner = await mintCreds(auth, newIdentity(), "provisioner");
  await setupSpaceStreams({ servers: broker.servers, space, creds: provisioner });
  await seedChannelRegistry({ servers: broker.servers, space, creds: provisioner, file: { channels: { general: {}, "review.code": {}, "-general": {} } } });
  daemon = new CotalEndpoint({ space, servers: broker.servers, creds: await mintCreds(auth, newIdentity(), "delivery"), consume: false, registerPresence: false, card: { name: "delivery", kind: "endpoint" } });
  daemon.on("error", () => {});
  await daemon.start();
  const lease = await daemon.acquireDeliveryLease(0);
  await daemon.startPlane3((owner, uid) => daemon!.aclForOwner(owner, uid));
  await daemon.markDeliveryLeaseReady(0, lease);
  check("delivery responder has bound and marked its lease ready", true);

  async function mint(name: string, ...grants: string[]) {
    const file = join(dir, `${name}.creds`);
    const run = cli("auth", "mint", name, "--space", space, "--provision", "--role", "reviewer", ...grants, "--out", file);
    await until(() => run.proc.exitCode !== null);
    const code = await run.exited;
    check(`${name}: real auth mint --provision succeeds`, code === 0, run.output());
    const uid = /^\s*Lifecycle:\s+(\S+)/m.exec(run.output())?.[1];
    assert.ok(uid, "mint did not report its lifecycle UID");
    return { file, uid };
  }
  async function refused(name: string, file: string, uid: string, expected: RegExp, channel = "general") {
    const run = cli("join", "--space", space, "--creds", file, "--lifecycle-uid", uid, "--name", name, "--channel", channel);
    await until(() => run.proc.exitCode !== null);
    const code = await run.exited;
    const out = run.output();
    console.log(`${name}: exit ${code}\n${out}`);
    check(`${name}: classified permission refusal`, code === 2 && /Code: +PERMISSION_DENIED/.test(out), out);
    check(`${name}: names the specific cause and remedy`, expected.test(out), out);
    check(`${name}: does not blame delivery or leak a broker permission error`, !/DELIVERY DAEMON|Permissions Violation|at Object\./i.test(out), out);
  }

  const empty = await mint("no_read");
  await refused("no-read", empty.file, empty.uid, /does not grant read access to #general[\s\S]*--allow-subscribe general/);
  const allowed = await mint("allowed", "--allow-subscribe", "general", "--allow-publish", "general");
  const wrongUid = mintLifecycleUid();
  await refused("wrong-uid", allowed.file, wrongUid, new RegExp(`does not grant inbox access for lifecycle ${wrongUid}[\\s\\S]*lifecycle UID.*mint`));
  const other = await mint("other_channel", "--allow-subscribe", "review.>");
  await refused("other-channel", other.file, other.uid, /does not grant read access to #general[\s\S]*--allow-subscribe general/);

  async function joins(name: string, file: string, uid: string, channel: string) {
    const run = cli("join", "--space", space, "--creds", file, "--lifecycle-uid", uid, "--name", name, `--channel=${channel}`);
    await until(() => run.output().includes("holding presence") || run.proc.exitCode !== null);
    check(`${name}: matching lifecycle and read grant join successfully`, run.proc.exitCode === null && run.output().includes("holding presence"), run.output());
    await killAndAwaitExit(run.proc);
    await run.exited;
  }

  // #10691: the missing read-grant refusal's Next is a complete owner mint that writes a private
  // file for the guest (space + --out), not a standing credential under the space's project.
  {
    const denied = cli("join", "--space", space, "--creds", empty.file, "--lifecycle-uid", empty.uid, "--name", "no_read_fix", "--channel", "general");
    const code = await denied.exited;
    const out = denied.output();
    const advice = /`cotal auth mint (<name> [^`]+)`/.exec(out)?.[1];
    assert.ok(advice?.includes(`--provision --allow-subscribe general --space ${space} --no-persona --out <file>`), out);
    check("no-read: the remedy mints to a private file in the named space", code === 2 && /Code: +PERMISSION_DENIED/.test(out), out);
    const granted = join(dir, "no-read-repair.creds");
    const repair = cli("auth", "mint", ...advice!.split(" ").map((arg) => arg === "<name>" ? "no_read_repair" : arg === "<file>" ? granted : arg));
    check("no-read: the printed remedy mints a private file the guest can join with", await repair.exited === 0 &&
      new RegExp(`Private file: +${granted.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`).test(repair.output()), repair.output());
    const grantedUid = /^\s*Lifecycle:\s+(\S+)/m.exec(repair.output())?.[1];
    assert.ok(grantedUid && grantedUid !== empty.uid, repair.output());
    check("no-read: the remedy writes no standing credential under the label", !existsSync(join(project, ".cotal", "auth", "creds", `space.${Buffer.from(space).toString("hex")}`, "no_read_repair.creds")), repair.output());
    await joins("no-read-repair", granted, grantedUid, "general");
  }
  const truncated = join(dir, "truncated.creds");
  writeFileSync(truncated, readFileSync(other.file, "utf8").split("\n").slice(0, 2).join("\n") + "\n", { mode: 0o600 });
  const absent = join(dir, "absent.creds");
  for (const [kind, file, exitCode, code, diagnosis, firstStep, channel, subscribe] of [
    ["truncated", truncated, 1, "SCHEMA_INVALID", "no complete NATS user JWT block", "pass the complete credential file", "review.code", "--allow-subscribe review.code"],
    ["absent", absent, 2, "TARGET_NOT_FOUND", `creds file not found: ${absent}`, "check the path", "review.code", "--allow-subscribe review.code"],
    ["dash_channel", absent, 2, "TARGET_NOT_FOUND", `creds file not found: ${absent}`, "check the path", "-general", "--allow-subscribe=-general"],
  ] as const) {
    const attempt = cli("join", "--space", space, "--creds", file, "--lifecycle-uid", other.uid, `--channel=${channel}`);
    const status = await attempt.exited;
    const output = attempt.output();
    check(`${kind} file: join diagnoses the file and explains how to pair the replacement`, status === exitCode &&
      new RegExp(`Code: +${code}`).test(output) && output.includes(diagnosis) && output.includes(firstStep) &&
      output.includes("--lifecycle-uid set to the new UID that mint reports"), output);
    const advice = /`cotal auth mint (<name> [^`]+)`/.exec(output)?.[1];
    assert.ok(advice && advice.includes(`--provision ${subscribe} --space ${space} --no-persona --out <file>`), output);
    const repaired = join(dir, `${kind}-repair.creds`);
    const mint = cli("auth", "mint", ...advice.split(" ").map((arg) => arg === "<name>" ? `${kind}_repair` : arg === "<file>" ? repaired : arg));
    check(`${kind} file: the suggested command mints a replacement`, await mint.exited === 0, mint.output());
    const replacementUid = /^\s*Lifecycle:\s+(\S+)/m.exec(mint.output())?.[1];
    assert.ok(replacementUid && replacementUid !== other.uid, mint.output());
    await joins(`${kind}-repair`, repaired, replacementUid, channel);
  }

  const foreign = join(dir, "foreign.creds"), foreignUid = mintLifecycleUid();
  const foreignAuth = await createSpaceAuth("elsewhere");
  writeFileSync(foreign, await mintCreds(foreignAuth, newIdentity(), "agent", {
    lifecycleUid: foreignUid, allowSubscribe: ["general"], allowPublish: ["general"], role: "reviewer",
  }), { mode: 0o600 });
  const foreignRoot = join(dir, "elsewhere");
  mkdirSync(foreignRoot);
  const foreignServer = `nats://127.0.0.1:${await freePort()}`;
  recordMesh({ space: "elsewhere", server: foreignServer, root: foreignRoot, mode: "auth", ts: new Date().toISOString() });
  const foreignArgs = ["join", "--creds", foreign, "--lifecycle-uid", foreignUid, "--name", "foreign"];
  const foreignEmpty = join(dir, "foreign-empty.creds");
  const foreignWildcard = join(dir, "foreign-wildcard.creds");
  for (const [file, read] of [[foreignEmpty, []], [foreignWildcard, ["review.>"]]] as const) {
    writeFileSync(file, await mintCreds(foreignAuth, newIdentity(), "agent", {
      lifecycleUid: foreignUid, allowSubscribe: [...read], allowPublish: [],
    }), { mode: 0o600 });
  }
  for (const [name, file, channel, flags] of [
    ["cross_repair", foreign, "general", "--allow-subscribe general --allow-publish general --role reviewer"],
    ["cross_read_only", foreignEmpty, "general", "--allow-subscribe general --allow-publish ''"],
    ["cross_dash", foreignEmpty, "-general", "--allow-subscribe=-general --allow-publish ''"],
    ["cross_wildcard", foreignWildcard, "review.code", "--allow-subscribe 'review.>' --allow-publish ''"],
  ] as const) {
    const rejected = cli("join", "--creds", file, "--lifecycle-uid", foreignUid, "--name", name, "--space", space, `--channel=${channel}`);
    const code = await rejected.exited;
    const out = rejected.output();
    check(`${name}: wrong-space join names both spaces and how to use the original file`, code === 2 &&
      /Code: +PERMISSION_DENIED/.test(out) && out.includes(`Space:   ${space}`) &&
      out.includes(`is a credential for space "elsewhere", not "${space}"`) && out.includes("use it with --space elsewhere"), out);
    const replacementArgs = /`(?:pnpm )?cotal auth mint (<label> [^`]+)`/.exec(out)?.[1];
    assert.ok(replacementArgs?.includes(`--space ${space} --provision ${flags} --no-persona`), out);
    check(`${name}: the remedy names the owner-approved read grant and lifecycle pairing`,
      out.includes(`ask the owner of "${space}" to mint a replacement with read access to the landing channel`) &&
      out.includes("join with the lifecycle UID that mint reports"), out);
    const crossRepair = join(dir, `${name}.creds`);
    const crossMint = cli("auth", "mint", ...replacementArgs!.split(" ").map((arg) => arg === "<label>" ? name : arg === "<file>" ? crossRepair : arg.replace(/^'|'$/g, "")));
    check(`${name}: the printed remedy mints a replacement`, await crossMint.exited === 0, crossMint.output());
    const crossUid = /^\s*Lifecycle:\s+(\S+)/m.exec(crossMint.output())?.[1];
    assert.ok(crossUid && crossUid !== foreignUid, crossMint.output());
    await joins(name, crossRepair, crossUid, channel);
  }

  // Use the broker's exact numeric address in the link so DNS and address family cannot change the result.
  const wrongLink = cli(...foreignArgs, "--link", `${broker.servers.replace(/^nats:/, "cotal:")}/elsewhere`);
  check("a link to the wrong broker reports the registered address and how to drop the link", await wrongLink.exited === 2 &&
    /Code: +PERMISSION_DENIED/.test(wrongLink.output()) && wrongLink.output().includes(`registered here at ${foreignServer}`) &&
    wrongLink.output().includes("--space elsewhere without --link"), wrongLink.output());
  const unnamed = cli(...foreignArgs, "--server", broker.servers);
  check("a broker without a named target does not get a guessed replacement space", await unnamed.exited === 2 &&
    unnamed.output().includes('is a credential for space "elsewhere"') && !/Space:|auth mint/.test(unnamed.output()), unnamed.output());

  await joins("allowed", allowed.file, allowed.uid, "general");
  // Read grants alone suffice for joining, and wildcard coverage must not be mistaken for denial.
  await joins("wildcard", other.file, other.uid, "review.code");
  const legacyChannel = `${PLUGIN_CHANNEL_ROOT}.linear.legacy`;
  const legacy = await mint("legacy_plugin_name", "--allow-subscribe", legacyChannel, "--allow-publish", legacyChannel);
  await joins("legacy-plugin-name", legacy.file, legacy.uid, legacyChannel);
  const whoami = cli("whoami", "--creds", legacy.file, "--json");
  check("whoami succeeds for the credential that joined the legacy channel", await whoami.exited === 0, whoami.output());
  const identity = JSON.parse(whoami.output()).result;
  check("whoami reports only the legacy channel's read and post grants", JSON.stringify(identity.read) === JSON.stringify([legacyChannel]) &&
    JSON.stringify(identity.post) === JSON.stringify([legacyChannel]) && identity.dms === "own", whoami.output());
  await refused("legacy no-read", other.file, other.uid, /does not grant read access to #ext\.linear\.legacy/, legacyChannel);
  const bareOff = cli("join", "--space", space, "--name", "bare-off", "--channel", legacyChannel);
  try {
    await until(() => bareOff.output().includes("holding presence") || bareOff.proc.exitCode !== null);
    check("bare static join keeps an ext name on ordinary CHAT when activation is off",
      bareOff.proc.exitCode === null && bareOff.output().includes("holding presence"), bareOff.output());
  } finally {
    await killAndAwaitExit(bareOff.proc);
    await bareOff.exited;
  }
  await checkEnabledJoin();
  const unpaired = cli("join", "--space", space, "--creds", allowed.file);
  await until(() => unpaired.proc.exitCode !== null);
  check("missing lifecycle explains pairing and the provisioning mint", await unpaired.exited === 1 && /lifecycle-paired/.test(unpaired.output()) && /--lifecycle-uid/.test(unpaired.output()) && /auth mint.*--provision/.test(unpaired.output()), unpaired.output());

  // #7531: observer and admin credentials refuse PERMISSION_DENIED (exit 2) before lifecycle pairing or binding,
  // naming the required provisioned agent credential rather than demanding --lifecycle-uid, blaming delivery, or printing dm-durable-missing.
  for (const profile of ["observer", "admin"] as const) {
    const profFile = join(dir, `${profile}.creds`);
    const minted = cli("auth", "mint", `fixed_${profile}`, "--space", space, "--profile", profile, "--out", profFile);
    await until(() => minted.proc.exitCode !== null);
    check(`#7531 fixture: auth mint --profile ${profile} succeeds`, await minted.exited === 0, minted.output());
    for (const [label, extra] of [["without --lifecycle-uid", []], ["with --lifecycle-uid", ["--lifecycle-uid", wrongUid, "--channel", "general"]]] as const) {
      const attempt = cli("join", "--space", space, "--creds", profFile, "--name", `try_${profile}`, ...extra);
      await until(() => attempt.proc.exitCode !== null);
      const code = await attempt.exited;
      const out = attempt.output();
      check(`#7531: ${profile} credential ${label} refuses PERMISSION_DENIED naming agent mint`,
        code === 2 &&
          /Code: +PERMISSION_DENIED/.test(out) &&
          out.includes(`an ${profile}-profile credential cannot join as a mesh participant`) &&
          out.includes("cotal auth mint <name> --provision --allow-subscribe general --out <file>") &&
          !/lifecycle-paired|DELIVERY DAEMON|dm-durable-missing/i.test(out),
        out);
    }
  }
  const unprovisioned = join(dir, "unprovisioned.creds");
  const mintOnly = cli("auth", "mint", "unprovisioned", "--space", space, "--allow-subscribe", "general,review.>", "--allow-publish", "general", "--out", unprovisioned);
  check("mint without provisioning succeeds", await mintOnly.exited === 0, mintOnly.output());
  const uid = /^\s*Lifecycle:\s+(\S+)/m.exec(mintOnly.output())?.[1];
  assert.ok(uid, "mint did not report its lifecycle UID");
  const missing = cli("join", "--space", space, "--creds", unprovisioned, "--lifecycle-uid", uid, "--name", "unprovisioned", "--channel", "review.code");
  const missingCode = await missing.exited;
  check("unprovisioned join names lifecycle and provisioning remedy", missingCode === 2 && /TARGET_NOT_FOUND/.test(missing.output()) && missing.output().includes(uid) && /auth mint.*--provision/.test(missing.output()), missing.output());
  check("unprovisioned join hides raw durable error", !/dm-durable-missing|DmDurableMissingError/.test(missing.output()), missing.output());
  const command = /`cotal auth mint (<name> --provision [^`]+)`/.exec(missing.output())?.[1];
  assert.ok(command?.includes("--allow-subscribe review.code"), missing.output());
  const replacement = join(dir, "replacement.creds");
  const repair = cli("auth", "mint", ...command!.split(" ").map((arg) => arg === "<name>" ? "replacement" : arg === "<file>" ? replacement : arg));
  check("the exact missing-inbox remedy mints a replacement for the chosen channel", await repair.exited === 0, repair.output());
  const repairedUid = /^\s*Lifecycle:\s+(\S+)/m.exec(repair.output())?.[1];
  assert.ok(repairedUid, repair.output());
  await joins("replacement", replacement, repairedUid, "review.code");
  check("the remedy explains how to preserve additional grants", missing.output().includes("replace `--allow-subscribe review.code` with `--identity <original-file>`"), missing.output());

  function terminal(name: string, file: string, uid: string, channel = "general") {
    const terminalEnv = { ...env };
    delete terminalEnv.COTAL_NO_PROMPT;
    const proc = cotalPty(["join", "--space", space, "--creds", file, "--lifecycle-uid", uid, "--name", name, "--channel", channel], {
      cwd: project, env: Object.fromEntries(Object.entries(terminalEnv).filter((entry): entry is [string, string] => entry[1] !== undefined)),
    });
    terminals.add(proc);
    let text = "", code: number | undefined;
    proc.onData((chunk) => { text += chunk; });
    proc.onExit((result) => { code = result.exitCode; terminals.delete(proc); });
    return { proc, output: () => clean(text), code: () => code };
  }
  const readOnly = await mint("read_only", "--allow-subscribe", "general");
  const reader = terminal("reader", readOnly.file, readOnly.uid);
  await until(() => reader.output().includes("Commands:") || reader.code() !== undefined);
  check("read-only join does not invite broadcasting", /read-only.*#general/i.test(reader.output()) && !reader.output().includes("Type to broadcast"), reader.output());
  reader.proc.write("read-only forbidden post\r");
  await until(() => reader.output().includes("nothing was sent") || reader.code() !== undefined);
  check("read-only broadcast names missing publish grant and mint remedy", /--allow-subscribe general.*--allow-publish general/.test(reader.output()) && !/Permissions Violation/.test(reader.output()), reader.output());
  reader.proc.write("/who\r");
  await until(() => reader.output().includes("Roster:"));
  check("read-only session keeps roster command available", reader.code() === undefined, reader.output());

  const writer = terminal("writer", allowed.file, allowed.uid);
  await until(() => writer.output().includes("Commands:") || writer.code() !== undefined);
  check("publish-capable join advertises broadcasting", writer.output().includes("Type to broadcast"), writer.output());
  writer.proc.write("permitted writer post\r");
  await until(() => reader.output().includes("permitted writer post"));
  check("writer post reaches read-only reader", /#general writer.*permitted writer post/.test(reader.output()), reader.output());
  const history = cli("history", "general", "--space", space);
  check("history read succeeds", await history.exited === 0, history.output());
  check("only authorized broadcast is stored", history.output().includes("permitted writer post") && !history.output().includes("read-only forbidden post"), history.output());
  reader.proc.write("/dm writer hello privately\r");
  await until(() => writer.output().includes("hello privately"));
  check("read-only reader can still send a DM", /\(DM\).*reader.*hello privately/.test(writer.output()), writer.output());
  reader.proc.write("/quit\r");
  writer.proc.write("/quit\r");
  await until(() => reader.code() !== undefined && writer.code() !== undefined);
  check("both interactive sessions quit successfully", reader.code() === 0 && writer.code() === 0);

  const family = await mint("family", "--allow-subscribe", "review.>", "--allow-publish", "review.code");
  const follower = terminal("follower", family.file, family.uid, "review.>");
  await until(() => follower.output().includes("Commands:") || follower.code() !== undefined);
  check("family join announces that broadcasts need a concrete channel", follower.output().includes("Broadcasts need a concrete channel") && !follower.output().includes("Type to broadcast"), follower.output());
  follower.proc.write("not a broadcast target\r");
  await until(() => follower.output().includes("Nothing was sent.") || follower.code() !== undefined);
  check("broadcast to a family is refused without suggesting a credential change", follower.output().includes("Nothing was sent.") && !follower.output().includes("auth mint"), follower.output());
  follower.proc.write("/quit\r");
  await until(() => follower.code() !== undefined);
  check("interactive family join quits successfully", follower.code() === 0, follower.output());
  emitSentinel({ passed, failed: 0 });
} finally {
  for (const terminal of terminals) terminal.kill();
  for (const child of children) await killAndAwaitExit(child);
  await daemon?.stop();
  await broker.stop();
  rmSync(dir, { recursive: true, force: true });
}
