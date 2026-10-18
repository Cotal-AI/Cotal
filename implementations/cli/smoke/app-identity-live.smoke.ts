/**
 * `cotal app-identity`: the plumbing a Claude app conversation runs to open its own identity on a
 * local mesh, and to retire it.
 *
 * Live: a throwaway JWT-auth broker on an OS-assigned port, a mesh registered in a temp COTAL_HOME
 * with `cotal meshes add`, and the command run in-process with its stdout captured, because stdout
 * is the whole contract: one JSON line, never the credential.
 *
 * Needs `nats-server` on PATH, as the rest of smoke:ci does.
 * Run: pnpm smoke:app-identity:live
 */
import { strict as assert } from "node:assert";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";

const home = mkdtempSync(join(tmpdir(), "cotal-appid-smoke-home-"));
process.env.COTAL_HOME = home;
process.env.COTAL_NO_PROMPT = "1";
delete process.env.COTAL_DEFAULT_PERSONA;

const {
  createSpaceAuth, deprovisionAgent, mintCreds, mintLifecycleUid, newIdentity, provisionAgent, seedChannelRegistry,
  setupSpaceStreams, CotalEndpoint,
} = await import("@cotal-ai/core");
const { authDir, saveSpaceAuth } = await import("@cotal-ai/workspace");
const { meshes } = await import("../src/commands/meshes.js");
const { appIdentity } = await import("../src/commands/app-identity.js");
const { bootBroker } = await import("../../manager/smoke/_boot-broker.js");

let pass = 0;
const check = (name: string, cond: boolean, extra?: unknown) => {
  assert.ok(cond, `${name}${extra !== undefined ? ` — ${JSON.stringify(extra)}` : ""}`);
  pass++;
  console.log(`  ✓ ${name}`);
};
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Run `cotal app-identity …` in-process and return what it wrote to stdout and its exit code. */
async function run(positionals: string[], values: Record<string, unknown>): Promise<{ out: string; code: number; reply: any }> {
  const chunks: string[] = [];
  const write = process.stdout.write;
  process.stdout.write = ((chunk: string | Uint8Array) => (chunks.push(String(chunk)), true)) as typeof process.stdout.write;
  try {
    await appIdentity({ positionals, values, raw: [] } as never);
  } finally {
    process.stdout.write = write;
  }
  const code = Number(process.exitCode ?? 0);
  process.exitCode = 0;
  const out = chunks.join("");
  let reply: any;
  try {
    reply = JSON.parse(out);
  } catch {
    reply = undefined;
  }
  return { out, code, reply };
}

/** `cotal meshes …` in-process; it reports through console and process.exit. */
class ExitSignal extends Error {}
async function runMeshes(positionals: string[], values: Record<string, unknown>): Promise<number> {
  const [log, err, exit] = [console.log, console.error, process.exit];
  let code = 0;
  console.log = () => {};
  console.error = () => {};
  process.exit = ((c?: number) => { code = c ?? 0; throw new ExitSignal(); }) as never;
  try {
    await meshes({ positionals, values, raw: [] } as never);
  } catch (e) {
    if (!(e instanceof ExitSignal)) throw e;
  } finally {
    console.log = log; console.error = err; process.exit = exit;
  }
  return code;
}

const credDirs = () => readdirSync(tmpdir()).filter((n) => n.startsWith("cotal-app-identity-"));

const SPACE = "appmesh";
const root = mkdtempSync(join(tmpdir(), "cotal-appid-smoke-root-"));
mkdirSync(join(root, ".cotal"), { recursive: true });
const auth = await createSpaceAuth(SPACE);
const broker = await bootBroker(auth);
const cleanup: Array<() => Promise<void> | void> = [];
let brokerUp = true;

try {
  saveSpaceAuth(authDir(root), auth);
  const provisioner = await mintCreds(auth, newIdentity(), "provisioner");
  await setupSpaceStreams({ servers: broker.servers, space: SPACE, creds: provisioner });
  await seedChannelRegistry({ servers: broker.servers, space: SPACE, creds: provisioner, file: { channels: { general: {} } } });
  check("the mesh registers", (await runMeshes(["add", SPACE], { server: broker.servers, root })) === 0);

  // ── refusals that come before anything is made ───────────────────────────────────────────────
  const usage = await run(["open"], {});
  check("an unknown verb answers its usage as one JSON line", usage.code === 1 && usage.reply?.ok === false && /usage/.test(usage.reply.error), usage.out);
  const nameless = await run(["provision"], { space: SPACE });
  check("provision without a name is refused", nameless.code === 1 && /--name/.test(nameless.reply?.error), nameless.out);
  const before = credDirs().length;
  const noPersona = await run(["provision"], { space: SPACE, name: "claude_app" });
  check(
    "a mesh with no default persona is refused, naming where it looked",
    noPersona.code === 1 && noPersona.reply?.error?.includes(join(root, ".cotal", "agents")) && /cotal setup/.test(noPersona.reply.error),
    noPersona.out,
  );
  check("  and it made no credential directory", credDirs().length === before, credDirs());

  mkdirSync(join(root, ".cotal", "agents"), { recursive: true });
  writeFileSync(
    join(root, ".cotal", "agents", "default.md"),
    "---\nname: default\nrole: default\nsubscribe: [general]\nallowSubscribe: [general]\nallowPublish: [general]\n---\n\nA Claude app conversation.\n",
  );

  // ── provision: the launch env, the credential in a file, and nothing secret on stdout ────────
  const opened = await run(["provision"], { space: SPACE, name: "claude_app" });
  check("provision answers ok with one JSON line", opened.code === 0 && opened.reply?.ok === true && opened.out.endsWith("\n") && opened.out.trim().split("\n").length === 1, opened.out);
  const env: Record<string, string> = opened.reply.env;
  const retire = opened.reply.retire;
  check("the env names the mesh and the exact name asked for", env.COTAL_SPACE === SPACE && env.COTAL_SERVERS === broker.servers && env.COTAL_NAME === "claude_app", env);
  check(
    "the env carries the default persona's channels and role",
    env.COTAL_SUBSCRIBE === "general" && env.COTAL_ALLOW_SUBSCRIBE === "general" && env.COTAL_ALLOW_PUBLISH === "general" && env.COTAL_ROLE === "default",
    env,
  );
  const credsText = readFileSync(env.COTAL_CREDS, "utf8");
  check("the credential is a file the env names", /BEGIN NATS USER JWT/.test(credsText));
  check("  readable by its owner only", (statSync(env.COTAL_CREDS).mode & 0o777) === 0o600, (statSync(env.COTAL_CREDS).mode & 0o777).toString(8));
  check("  in a directory only its owner can enter", (statSync(dirname(env.COTAL_CREDS)).mode & 0o777) === 0o700);
  const jwt = credsText.split("\n").find((l) => l.startsWith("eyJ"));
  check("stdout carries no credential", !/NKEY SEED|BEGIN NATS/.test(opened.out) && !!jwt && !opened.out.includes(jwt), opened.out);
  check(
    "the retire reference matches what was provisioned",
    retire?.space === SPACE && retire.lifecycleUid === env.COTAL_LIFECYCLE_UID && retire.dir === dirname(env.COTAL_CREDS) && typeof retire.id === "string",
    retire,
  );

  // ── the identity works: it joins and a peer's DM reaches it ──────────────────────────────────
  const app = new CotalEndpoint({
    space: SPACE, servers: env.COTAL_SERVERS, creds: credsText, lifecycleUid: env.COTAL_LIFECYCLE_UID,
    card: { name: env.COTAL_NAME, kind: "agent", id: retire.id }, channels: ["general"],
  });
  const heard: string[] = [];
  app.on("message", (m: { parts?: Array<{ kind: string; text?: string }> }) => {
    for (const part of m?.parts ?? []) if (part.kind === "text" && part.text) heard.push(part.text);
  });
  await app.start();
  const stopApp = () => app.stop();
  cleanup.push(stopApp);
  const supervisor = new CotalEndpoint({
    space: SPACE, servers: broker.servers, creds: provisioner, card: { name: "prov", kind: "endpoint" },
    consume: false, watchPresence: false, registerPresence: false,
  });
  await supervisor.start();
  cleanup.push(() => supervisor.stop());
  const peerId = newIdentity();
  const peerUid = mintLifecycleUid();
  const peer = new CotalEndpoint({
    space: SPACE, servers: broker.servers, lifecycleUid: peerUid,
    creds: await provisionAgent(supervisor, auth, peerId, { subscribe: ["general"], allowSubscribe: ["general"], lifecycleUid: peerUid }),
    card: { name: "peer", kind: "agent", id: peerId.id }, channels: ["general"],
  });
  await peer.start();
  cleanup.push(() => peer.stop());
  await wait(300);
  await peer.unicast(app.ref().id, "hello from a peer");
  for (let i = 0; i < 40 && !heard.length; i++) await wait(100);
  check("the provisioned identity joins and receives a DM", heard.some((t) => t.includes("hello from a peer")), heard);

  // ── D1: a live name is taken, and asking for it makes nothing ────────────────────────────────
  const beforeTaken = credDirs().length;
  const second = await run(["provision"], { space: SPACE, name: "claude_app" });
  check("a second provision of a live name answers taken", second.code === 1 && second.reply?.ok === false && second.reply.taken === true, second.out);
  check("  and it made no credential directory", credDirs().length === beforeTaken, credDirs());
  const other = await run(["provision"], { space: SPACE, name: "claude_app_2" });
  check("another name provisions beside it", other.code === 0 && other.reply?.ok === true && other.reply.env.COTAL_NAME === "claude_app_2", other.out);
  check("  as an identity of its own", other.reply.retire.id !== retire.id && other.reply.env.COTAL_CREDS !== env.COTAL_CREDS);

  // ── retire: the credential directory and the broker footprint go ─────────────────────────────
  const foreign = mkdtempSync(join(tmpdir(), "not-an-app-identity-"));
  const refused = await run(["retire"], { space: SPACE, id: retire.id, "lifecycle-uid": retire.lifecycleUid, dir: foreign });
  check("retire refuses a directory provision did not make", refused.code === 1 && /refusing to remove/.test(refused.reply?.error), refused.out);
  check("  and leaves it in place", existsSync(foreign));
  // Raw, as a caller could pass it: `join` would normalize the climb away before retire saw it.
  const climbing = `${tmpdir()}/cotal-app-identity-/../${basename(foreign)}`;
  const climbed = await run(["retire"], { space: SPACE, id: retire.id, "lifecycle-uid": retire.lifecycleUid, dir: climbing });
  check("retire refuses a path that climbs out of a credential directory", climbed.code === 1 && /refusing to remove/.test(climbed.reply?.error), climbed.out);
  check("  and leaves what it names in place", existsSync(foreign));
  rmSync(foreign, { recursive: true, force: true });
  const elsewhere = join(root, "cotal-app-identity-elsewhere");
  mkdirSync(elsewhere);
  writeFileSync(join(elsewhere, "agent.creds"), "not provision's");
  const misplaced = await run(["retire"], { space: SPACE, id: retire.id, "lifecycle-uid": retire.lifecycleUid, dir: elsewhere });
  check("retire refuses a credential-named directory outside the temp directory", misplaced.code === 1 && /refusing to remove/.test(misplaced.reply?.error), misplaced.out);
  check("  and leaves its file in place", existsSync(join(elsewhere, "agent.creds")));
  const missing = await run(["retire"], { space: SPACE, id: retire.id });
  check("retire without the full reference is refused", missing.code === 1 && /--lifecycle-uid/.test(missing.reply?.error), missing.out);

  await stopApp();
  cleanup.splice(cleanup.indexOf(stopApp), 1);
  const retired = await run(["retire"], { space: SPACE, id: retire.id, "lifecycle-uid": retire.lifecycleUid, dir: retire.dir });
  check("retire answers ok", retired.code === 0 && retired.reply?.ok === true && retired.out.trim().split("\n").length === 1, retired.out);
  check("  and removed the credential directory", !existsSync(retire.dir));
  // A second deprovision of the same identity finds nothing left: the read-ACL row and both
  // durables were removed by retire, not by this call.
  const again = await deprovisionAgent({
    servers: broker.servers, space: SPACE, targetId: retire.id, lifecycleUid: retire.lifecycleUid,
    creds: await mintCreds(auth, newIdentity(), "deprovisioner", { deprovisionTarget: { principal: retire.id, lifecycleUid: retire.lifecycleUid } }),
  });
  check("  and removed its broker footprint", again.acls.absent === 1 && again.consumers.absent === 2 && again.deleted === 0, again);

  const otherRetired = await run(["retire"], { space: SPACE, ...other.reply.retire, "lifecycle-uid": other.reply.retire.lifecycleUid });
  check("the other identity retires on its own", otherRetired.code === 0 && !existsSync(other.reply.retire.dir), otherRetired.out);

  // ── a mesh that does not answer ──────────────────────────────────────────────────────────────
  for (const stop of cleanup.splice(0).reverse()) await stop();
  await broker.stop();
  brokerUp = false;
  const beforeDown = credDirs().length;
  const down = await run(["provision"], { space: SPACE, name: "claude_app" });
  check("a mesh that is not answering is refused by name", down.code === 1 && down.reply?.error?.includes(`"${SPACE}"`) && /not answering/.test(down.reply.error), down.out);
  check("  and it made no credential directory", credDirs().length === beforeDown, credDirs());
} finally {
  for (const stop of cleanup.reverse()) await Promise.resolve(stop()).catch(() => {});
  if (brokerUp) await broker.stop();
  rmSync(root, { recursive: true, force: true });
  rmSync(home, { recursive: true, force: true });
}

console.log(`\nAPP IDENTITY TESTS PASSED ✅  (${pass} checks)`);
process.exit(0);
