/** The three artifact index stores through a real backup, a real restore and an authenticated teardown
 * (A1, the engineering review's E15). Every stream name is written out, never derived from the helper
 * the code under test uses, so a list that drops a store on both sides is still caught.
 *
 *  1. `cotal up` on an authenticated space creates the three stores by their literal names, and a row
 *     is written into each through the scoped `artifact-data` credential the daemon would hold.
 *  2. `cotal backup create` leaves them out: the manifest names none of them (their rows point at
 *     object bytes the backup does not carry, so restoring them would resurrect dangling rows).
 *  3. `cotal up --restore` brings each one back EMPTY with the fencing shape (allow_direct false, file
 *     storage, history 1, no byte cap), and `artifact-data` can write it again.
 *  4. An observer credential cannot delete an index store. The scoped `teardown` credential names
 *     STREAM.DELETE on each one by its literal name, and `deleteSpace` on it removes all three.
 *
 * Sandboxes COTAL_HOME and the project root. Needs nats-server on PATH.
 * Run: pnpm smoke:artifact-index-restore:live */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { jetstreamManager } from "@nats-io/jetstream";
import { Kvm } from "@nats-io/kv";
import { connect, credsAuthenticator, type NatsConnection } from "@nats-io/transport-node";
import { decode } from "@nats-io/jwt";
import { deleteSpace, idFromCreds, jwtFromCreds, mintCreds, mintLifecycleUid, newIdentity, type SpaceAuth } from "@cotal-ai/core";
import { authDir, loadSpaceAuth } from "@cotal-ai/workspace";
import { assertSmokeSandboxDown, emitSentinel, freePort, recordSmokeSandbox } from "@cotal-ai/smoke-kit";

const EXPECTED = 9;
const worktree = resolve(import.meta.dirname, "..", "..", "..");
const cliPath = join(worktree, "bin", "cotal.ts");
const tsx = join(worktree, "node_modules", ".bin", "tsx");
process.env.DO_NOT_TRACK = "1";

let passed = 0;
const check = (name: string, ok: unknown, detail?: unknown) => {
  assert.ok(ok, `${name}${detail === undefined ? "" : `\n${typeof detail === "string" ? detail : JSON.stringify(detail, null, 2)}`}`);
  passed++;
  console.log(`  ✓ ${name}`);
};

const root = realpathSync.native(mkdtempSync(join(tmpdir(), "cotal-artidx-restore-root-")));
const home = realpathSync.native(mkdtempSync(join(tmpdir(), "cotal-artidx-restore-home-")));
const space = "artidx_restore";
const literal = [`KV_cotal_artattach_${space}`, `KV_cotal_artpossess_${space}`, `KV_cotal_artreserve_${space}`];
const buckets = [`cotal_artattach_${space}`, `cotal_artpossess_${space}`, `cotal_artreserve_${space}`];
const configDir = join(home, "xdg");
const sandbox = recordSmokeSandbox({ root, cotalHome: home, xdgConfigHome: configDir });
const env = { ...process.env, COTAL_HOME: home, XDG_CONFIG_HOME: configDir, COTAL_SKIP_CONNECTOR_SEED: "1", NO_COLOR: "1" };
const run = (...args: string[]) => {
  const options = { cwd: root, env, encoding: "utf8" as const, timeout: 240_000 };
  assertSmokeSandboxDown(sandbox, args, options);
  return spawnSync(tsx, [cliPath, ...args], options);
};
const must = (label: string, r: ReturnType<typeof run>) => assert.equal(r.status, 0, `${label}\nstdout:\n${r.stdout}\nstderr:\n${r.stderr}`);
const port = await freePort();
const server = `nats://127.0.0.1:${port}`;

const dial = (creds: string): Promise<NatsConnection> =>
  connect({ servers: server, authenticator: credsAuthenticator(new TextEncoder().encode(creds)), inboxPrefix: `_INBOX_${idFromCreds(creds)}`, reconnect: false });
const auth = (): SpaceAuth => {
  const a = loadSpaceAuth(authDir(root), space);
  assert.ok(a, "the space's trust material is in the root");
  return a;
};
/** The index stores as the broker reports them, read on a provisioner credential (it holds STREAM.INFO). */
async function indexInfo(): Promise<Record<string, { messages: number; allowDirect: boolean; storage: string; history: number; maxBytes: number } | null>> {
  const nc = await dial(await mintCreds(auth(), newIdentity(), "provisioner"));
  try {
    const jsm = await jetstreamManager(nc);
    const out: Record<string, { messages: number; allowDirect: boolean; storage: string; history: number; maxBytes: number } | null> = {};
    for (const name of literal) {
      try {
        const { config, state } = await jsm.streams.info(name);
        out[name] = { messages: state.messages, allowDirect: config.allow_direct, storage: String(config.storage), history: config.max_msgs_per_subject, maxBytes: config.max_bytes };
      } catch { out[name] = null; }
    }
    return out;
  } finally { await nc.close(); }
}
/** Write one row into each index bucket through the scoped `artifact-data` credential. */
async function writeRows(tag: string): Promise<void> {
  const nc = await dial(await mintCreds(auth(), newIdentity(), "artifact-data"));
  try {
    const kvm = new Kvm(nc);
    for (const bucket of buckets) await (await kvm.open(bucket)).put(`row.${tag}`, JSON.stringify({ tag }));
  } finally { await nc.close(); }
}

try {
  // ---- 1. created by up, written through the scoped data credential ----
  // A manager runs: `down --preserve-state` takes its agent inventory.
  must("up", run("up", "--detach", "--server", server, "--space", space));
  const created = await indexInfo();
  check("cotal up creates the three index stores by their literal names", literal.every((name) => created[name] !== null), created);
  await writeRows("before-backup");
  const seeded = await indexInfo();
  check("the scoped artifact-data credential writes a row into each store", literal.every((name) => seeded[name]?.messages === 1), seeded);

  // ---- 2. the backup leaves them out ----
  must("preserve cut", run("down", "--preserve-state"));
  const artifact = join(root, "full-backup");
  must("backup", run("backup", "create", artifact));
  const manifest = JSON.parse(readFileSync(join(artifact, "manifest.json"), "utf8")) as { streams: { stream: string }[]; files: { path: string }[] };
  check("the backup manifest names no index store and carries no file for one",
    literal.every((name) => !manifest.streams.some((s) => s.stream === name)) && !manifest.files.some((f) => /artattach|artpossess|artreserve/.test(f.path)),
    manifest.streams.map((s) => s.stream));

  // ---- 3. the restore recreates them empty, with the fencing shape ----
  must("restore", run("up", "--restore", artifact, "--detach", "--server", server, "--space", space));
  const restored = await indexInfo();
  check("after up --restore each index store exists and is empty", literal.every((name) => restored[name] !== null && restored[name]!.messages === 0), restored);
  check("each restored store keeps the fencing shape: allow_direct false, file storage, history 1, no byte cap",
    literal.every((name) => restored[name]?.allowDirect === false && restored[name]?.storage === "file" && restored[name]?.history === 1 && restored[name]?.maxBytes === -1), restored);
  await writeRows("after-restore");
  const rewritten = await indexInfo();
  check("artifact-data writes the restored stores again", literal.every((name) => rewritten[name]?.messages === 1), rewritten);

  // ---- 4. teardown: only the scoped teardown profile deletes them ----
  const observer = await dial(await mintCreds(auth(), newIdentity(), "observer"));
  let observerRefused = "";
  try { await (await jetstreamManager(observer)).streams.delete(literal[0]!); } catch (e) { observerRefused = (e as Error).message; }
  finally { await observer.close().catch(() => {}); }
  const afterObserver = await indexInfo();
  check("an observer credential cannot delete an index store, and the store survives the attempt",
    /permission|authorization|violation|timeout/i.test(observerRefused) && afterObserver[literal[0]!] !== null, { observerRefused, afterObserver });
  // The teardown seam `down -f` and `space delete` share: `deleteSpace` on the scoped `teardown`
  // credential, which holds STREAM.DELETE on exactly the space's owned streams. Minted explicitly and
  // decoded, so the deletes below ride that one grant and nothing ambient. It runs against the restored
  // broker, the last state these stores were proven in.
  const teardown = await mintCreds(auth(), newIdentity(), "teardown", { lifecycleUid: mintLifecycleUid(), transferStreams: [] });
  const allowed = (decode(jwtFromCreds(teardown)!) as { nats?: { pub?: { allow?: string[] } } }).nats?.pub?.allow ?? [];
  check("the minted teardown credential holds STREAM.DELETE on each index store by its literal name",
    literal.every((name) => allowed.includes(`$JS.API.STREAM.DELETE.${name}`)), allowed.filter((s) => s.includes("DELETE")));
  let teardownError = "";
  try { await deleteSpace({ servers: server, creds: teardown, space }); } catch (e) { teardownError = (e as Error).message; }
  const afterDelete = await indexInfo().catch((e: unknown) => ({ error: (e as Error).message }));
  check("deleteSpace on the scoped teardown profile removes all three index stores",
    !("error" in afterDelete) && literal.every((name) => (afterDelete as Record<string, unknown>)[name] === null),
    { teardownError, afterDelete });
} finally {
  run("down", "--yes");
  if (passed === EXPECTED) {
    rmSync(root, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  } else console.log(`artifact-index-restore retained evidence: ${root} ${home}`);
}
if (passed !== EXPECTED) throw new Error(`expected ${EXPECTED} cells, ran ${passed}`);
console.log(`artifact-index-restore: ${passed} passed, 0 failed`);
emitSentinel({ cells: passed, passed, failed: 0 });
