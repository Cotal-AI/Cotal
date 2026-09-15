/**
 * JOIN DENIAL GUIDANCE SMOKE (#1576).
 *
 * THE REPORTED HARM, NARROWLY. When the delivery daemon's responder is not bound, a durable join is
 * denied by the broker and surfaces as a PERMISSION error. The message named credentials and nothing
 * else, so an operator holding valid, unexpired credentials pursued the credential hypothesis: the
 * surface did not merely omit the cause, it actively pointed away from it.
 *
 * THIS CELL CROSSES THE DOOR, on the principle `join-dial-entry.smoke.ts` states: driving the real
 * `join` command entry point rather than hand-calling a private renderer, because "the test depends
 * on this code" and "the shipped path reaches this code" are different claims and only the second
 * one is what an operator gets. The message is asserted as the command actually prints it.
 *
 * THE FIXTURE IS THE REPORTED CONDITION, NOT A SUBSTITUTE FOR IT: a real `nats-server` with real
 * space auth, and a credential minted for a DIFFERENT space, so the broker itself issues the
 * permission denial. Nothing here fakes an error string.
 *
 * AND THE PAIRED CONTROL MATTERS AS MUCH AS THE ASSERTION. A message that named the daemon on EVERY
 * failure would pass a one-sided test while making every unrelated join failure misleading, so the
 * unprovisioned case is asserted to be unchanged: it still says `cotal up`, and must NOT blame the
 * responder. Credentials stay the first cause because they usually are.
 */
import assert from "node:assert/strict";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createConnection, createServer } from "node:net";
import { tmpdir } from "node:os";
import { join as pjoin, resolve } from "node:path";
import { createSpaceAuth, mintCreds, mintLifecycleUid, newIdentity, serverConfig, setupSpaceStreams } from "@cotal-ai/core";
import { saveSpaceAuth } from "@cotal-ai/workspace";
import { emitSentinel, killAndAwaitExit, teardownOnSignal } from "@cotal-ai/smoke-kit";

const WT = resolve(import.meta.dirname, "..", "..", "..");
const CLI = pjoin(WT, "bin", "cotal.ts");
const TSX = pjoin(WT, "node_modules", ".bin", "tsx");
const SPACE = "join-guidance";
const root = mkdtempSync(pjoin(tmpdir(), "cotal-joinguid-root-"));
const home = mkdtempSync(pjoin(tmpdir(), "cotal-joinguid-home-"));
mkdirSync(pjoin(root, ".cotal"), { recursive: true });

let pass = 0, fail = 0;
const check = (name: string, cond: boolean, extra?: unknown) => {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ FAIL: ${name}`, extra === undefined ? "" : String(extra).slice(0, 400)); }
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const strip = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, "");

const env = { ...process.env };
for (const k of Object.keys(env)) if (k.startsWith("COTAL_")) delete env[k];
env.COTAL_HOME = home;
env.XDG_CONFIG_HOME = pjoin(home, "xdg");
env.COTAL_SKIP_CONNECTOR_SEED = "1";
env.COTAL_NO_PROMPT = "1";

async function freePort(): Promise<number> {
  const s = createServer();
  await new Promise<void>((r) => s.listen(0, "127.0.0.1", r));
  const a = s.address();
  assert.ok(a && typeof a === "object");
  await new Promise<void>((r) => s.close(() => r()));
  return a.port;
}
async function portOpen(port: number): Promise<boolean> {
  return new Promise((res) => {
    const sock = createConnection({ host: "127.0.0.1", port });
    const done = (v: boolean) => { sock.destroy(); res(v); };
    sock.once("connect", () => done(true));
    sock.once("error", () => done(false));
    sock.setTimeout(250, () => done(false));
  });
}
function cli(...args: string[]): { status: number | null; text: string } {
  const r = spawnSync(TSX, [CLI, ...args], { cwd: root, env, encoding: "utf8", timeout: 90_000 });
  return { status: r.status, text: strip(`${r.stdout ?? ""}${r.stderr ?? ""}`) };
}

const port = await freePort();
const server = `nats://127.0.0.1:${port}`;
let broker: ChildProcess | undefined;
// Declared out here, not in the `try`, because the `finally` releases it: a `const` inside the block
// is not in scope there, and a suite that fails to compile proves nothing about broker ownership.
let releaseBroker: (() => void) | undefined;
try {
  // ONE space, one operator. A second independently-created space cannot share this broker (the
  // product refuses to compose trust across operators, correctly), so the denial is produced the way
  // a real unauthorized joiner produces it: a credential from THIS broker whose profile does not
  // carry the durable-join authority.
  const auth = await createSpaceAuth(SPACE);
  saveSpaceAuth(pjoin(root, ".cotal", "auth"), auth);
  writeFileSync(
    pjoin(root, "server.conf"),
    serverConfig(auth, [auth], { transport: { kind: "plaintext" }, port, storeDir: pjoin(root, "js") }),
  );
  broker = spawn("nats-server", ["-c", pjoin(root, "server.conf")], { stdio: "ignore" });
  // OWN the broker, do not just unwind it. The `finally` below is correct and still runs on the
  // normal path, but it never runs when this process is SIGNALLED, and a killed suite then leaves a
  // broker reparented to init holding a port and a JetStream store. That is the second defect named
  // in `broker-teardown.ts`, and it is the one a tool timeout produces: the wrapper dies, the child
  // does not. `root` is passed as the owned path because the store dir lives at `root/js`, so the
  // signal path removes the same tree the normal path does.
  releaseBroker = teardownOnSignal(broker, root);
  for (let i = 0; i < 120 && !(await portOpen(port)); i++) await sleep(50);
  check("fixture auth broker started", await portOpen(port));
  await setupSpaceStreams({ servers: server, space: SPACE, creds: await mintCreds(auth, newIdentity(), "provisioner") });

  // A REAL credential, correctly signed by this broker's operator, whose profile does NOT carry the
  // authority a durable join needs. The broker itself issues the permission denial: the same class
  // the reported incident produced when the responder was unbound. Nothing here fakes an error.
  const foreign = pjoin(root, "foreign.creds");
  writeFileSync(foreign, await mintCreds(auth, newIdentity(), "observer"), { mode: 0o600 });

  // `--creds` is lifecycle-paired (SPEC 13.1), so the uid is minted and passed: without it the CLI
  // refuses BEFORE dialing and the cell would grade an argument error rather than a broker denial.
  const uid = mintLifecycleUid();
  const denied = cli("join", "--space", SPACE, "--server", server, "--creds", foreign, "--lifecycle-uid", uid, "--name", "probe", "--channel", "general");
  const out = denied.text;

  // CELL 1: the denial is still a single human sentence, not a raw stack.
  check("CELL: a denied join renders as guidance, not a raw broker stack",
    /not authorized to join/.test(out) && !/at Object\.|at process\./.test(out), out);

  // CELL 2: THE FIX. The delivery daemon is named as a possible cause.
  check("CELL: the denial NAMES the delivery daemon as a possible cause",
    /DELIVERY DAEMON/i.test(out), out);
  check("CELL: it tells the operator HOW to check that cause",
    /status --components/.test(out), out);

  // CELL 3: credentials are still named FIRST, because they usually are the cause. A fix that
  // replaced one single-cause message with a different single-cause message would be no better.
  check("CELL: credentials remain named as a cause (both hypotheses, not a swap)",
    /--creds\/--token|join link/.test(out), out);
  const credsIdx = out.search(/credentials are wrong or missing/);
  const daemonIdx = out.search(/DELIVERY DAEMON/);
  check("CELL: credentials are offered BEFORE the daemon (likeliest cause first)",
    credsIdx >= 0 && daemonIdx >= 0 && credsIdx < daemonIdx, { credsIdx, daemonIdx });

  // CELL 4: PAIRED CONTROL, the other direction. A DIFFERENT failure class must NOT blame the
  // responder; a message that named the daemon on every failure would pass every cell above while
  // making unrelated failures misleading.
  //
  // The control used here is a plain credential REJECTION (an account this broker does not know),
  // which is the nearest neighbour to the denial above: same command, same flags, same broker, and
  // only the credential's standing varies. An unprovisioned-space control was tried first and was
  // NOT usable, because a space whose account the broker has never seen is rejected at the door and
  // never reaches the provisioning check, so it would have graded a different message than its name
  // claimed.
  const strangerSpace = "join-stranger";
  const strangerAuth = await createSpaceAuth(strangerSpace);
  const strangerCreds = pjoin(root, "stranger.creds");
  writeFileSync(strangerCreds, await mintCreds(strangerAuth, newIdentity(), "agent", { lifecycleUid: uid }), { mode: 0o600 });
  const unprov = cli("join", "--space", strangerSpace, "--server", server, "--creds", strangerCreds, "--lifecycle-uid", uid, "--name", "probe", "--channel", "general");
  const unprovOut = unprov.text;
  check("REFUSE CONTROL: an unrelated credential failure does NOT blame the delivery responder",
    !/DELIVERY DAEMON/i.test(unprovOut), unprovOut);
  check("REFUSE CONTROL: it still gives that failure's own remedy (creds), so it is not a silent pass",
    /credentials rejected|check your creds|--creds/i.test(unprovOut), unprovOut);

  console.log(fail === 0
    ? `\nJOIN DENIAL GUIDANCE SMOKE OK ✅  (${pass} passed, ${fail} failed)`
    : `\nJOIN DENIAL GUIDANCE SMOKE FAILED ❌  (${pass} passed, ${fail} failed)`);
  emitSentinel({ passed: pass, failed: fail });
  process.exitCode = fail === 0 ? 0 : 1;
} finally {
  // Wait for the broker to actually exit before removing its tree: a graceful shutdown keeps
  // flushing JetStream state to disk, which races the recursive removal below and fails it with
  // ENOTEMPTY after every cell has passed.
  if (broker !== undefined) await killAndAwaitExit(broker);
  rmSync(root, { recursive: true, force: true });
  rmSync(home, { recursive: true, force: true });
  // Released LAST, once the paths are gone, so the signal backstop stays armed for the whole window
  // in which there is still something to clean up.
  releaseBroker?.();
}
