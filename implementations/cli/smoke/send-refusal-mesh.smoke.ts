/**
 * A classified `send` refusal on a resolved space names that space. `send -t <absent>` used to print
 * its TARGET_NOT_FOUND report with no `Mesh:` line and a JSON target without `space`, although the
 * space was resolved and connected before the recipient was looked up. The same lookup serves
 * `--mention`. The refusal also says what to run next, in `error.remedy` and the human report.
 * A `--creds` credential that may not read presence used to wait out a five-second Direct Get
 * timeout and exit 3 with an unknown `timeout`; it is refused with `PERMISSION_DENIED`.
 * A broker publish denial proves nothing was stored for any destination. Explicit credential
 * refusals give a recovery command and report the channel grants known from the file (#7536).
 * A `--server` nothing answers at used to be reported as the space's mesh recorded at its root but
 * not running, with `cotal up` as the Next, and in a folder with no space as a `main` mesh recorded
 * there. `send` and `history` now name the address that did not answer and, from the space's root or
 * with `--space`, the broker recorded for it, and the space's history is unchanged.
 * A first send to an open space that runs elsewhere used to exit 3 `OPERATION_UNKNOWN` with nothing
 * stored, because the one-shot sender consumes nothing and so never created the space's streams
 * (#7045). It now creates them, as a chat session does. A space this machine started whose streams
 * are gone still refuses `TARGET_UNAVAILABLE`.
 *
 * Starts one static-auth broker and one open broker owned by this suite, registers the auth space
 * under a sandboxed COTAL_HOME, and drives the built binary from the space's root.
 *
 * Run: pnpm smoke:send-refusal-mesh
 */
import { spawn, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chatStream, CotalEndpoint, createSpaceAuth, DEFAULT_SPACE, dmStream, isReachable, mintCreds, mintLifecycleUid, newIdentity, provisionAgent, seedChannelRegistry, serverConfig, setupSpaceStreams, taskStream } from "@cotal-ai/core";
import { SMOKE_BROKER_TOKEN, awaitBrokerReady, createSuite, freePort, killAndAwaitExit, teardownOnSignal } from "@cotal-ai/smoke-kit";
import { authDir, recordMesh, saveSpaceAuth } from "@cotal-ai/workspace";
import { jetstreamManager } from "@nats-io/jetstream";
import { connect, credsAuthenticator } from "@nats-io/transport-node";

const BIN = join(import.meta.dirname, "..", "..", "..", "bin", "dist", "cotal.js");
if (!existsSync(BIN)) {
  console.error(`✗ ${BIN} missing - build first: pnpm --filter cotal-ai... build`);
  process.exit(1);
}

interface Envelope {
  outcome: string;
  target: { space?: string; name?: string; post?: string[] | null } | null;
  result?: { stored?: boolean };
  error?: { code: string; message?: string; remedy?: string };
}

const { check, finish } = createSuite();
const space = `sendref-${randomUUID().slice(0, 8)}`;
const absent = `nobody-${randomUUID().slice(0, 8)}`;
const dir = mkdtempSync(join(tmpdir(), SMOKE_BROKER_TOKEN));
const home = join(dir, "home");
const root = join(dir, "project");
mkdirSync(join(root, ".cotal"), { recursive: true, mode: 0o700 });
mkdirSync(join(home, ".cotal"), { recursive: true, mode: 0o700 });
// Set before recordMesh: the registry is written under COTAL_HOME, never under ~/.cotal.
process.env.COTAL_HOME = join(home, ".cotal");

const auth = await createSpaceAuth(space);
saveSpaceAuth(authDir(root), auth);
const port = await freePort();
const servers = `nats://127.0.0.1:${port}`;
writeFileSync(join(dir, "server.conf"), serverConfig(auth, [auth], { transport: { kind: "plaintext" }, port, storeDir: join(dir, "js") }));
const broker = spawn("nats-server", ["-c", join(dir, "server.conf")], { stdio: "ignore" });
const releaseBroker = teardownOnSignal(broker, dir);
const openPort = await freePort();
const openServers = `nats://127.0.0.1:${openPort}`;
const openBroker = spawn("nats-server", ["-a", "127.0.0.1", "-p", String(openPort), "-js", "-sd", join(dir, "open-js")], { stdio: "ignore" });
const releaseOpenBroker = teardownOnSignal(openBroker, dir);

const HOST_ENV = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith("COTAL_") && k !== "FORCE_COLOR" && k !== "NO_COLOR"));
const env = { ...HOST_ENV, HOME: home, USERPROFILE: home, XDG_CONFIG_HOME: join(home, ".config"), COTAL_HOME: join(home, ".cotal"), COTAL_SKIP_CONNECTOR_SEED: "1", NO_COLOR: "1" };
const run = (args: string[], cwd = root) => {
  const r = spawnSync(process.execPath, [BIN, ...args], { cwd, env, encoding: "utf8", timeout: 60_000 });
  let envelope: Envelope | undefined;
  try { envelope = JSON.parse(r.stdout ?? "") as Envelope; } catch { envelope = undefined; }
  return { status: r.status, stdout: r.stdout ?? "", stderr: r.stderr ?? "", envelope };
};
const shown = (r: ReturnType<typeof run>) => ({ status: r.status, stdout: r.stdout.slice(0, 600), stderr: r.stderr.slice(0, 600) });
const firstLine = (text: string) => text.split("\n")[0];
const credsPath = (label: string) => join(dir, `${label}.creds`);
let issuer: CotalEndpoint | undefined;
let recipient: CotalEndpoint | undefined;
let inspector: Awaited<ReturnType<typeof connect>> | undefined;

try {
  await awaitBrokerReady(() => isReachable(servers), { servers, attempts: 25, delayMs: 200 });
  const provisioner = newIdentity();
  const provisionerCreds = await mintCreds(auth, provisioner, "provisioner");
  await setupSpaceStreams({ servers, space, creds: provisionerCreds });
  await seedChannelRegistry({ servers, space, creds: provisionerCreds, file: { channels: { general: {}, "--audit": {} } } });
  recordMesh({ space, server: servers, root, mode: "auth", ts: new Date().toISOString() });

  for (const style of [[], ["--plain"]]) {
    const label = style.length ? "plain" : "text";
    const r = run(["send", "-t", absent, "hello", "--space", space, ...style]);
    check(`${label}: an absent recipient is refused, exit 2`, r.status === 2 && r.stderr.includes("TARGET_NOT_FOUND"), shown(r));
    check(`${label}: the refusal begins with Mesh: <space>`, firstLine(r.stderr) === `Mesh: ${space}`, shown(r));
    check(`${label}: the refusal says what to run next`, r.stderr.includes(`cotal who --all --space ${space}`), shown(r));
  }

  const json = run(["send", "-t", absent, "hello", "--space", space, "--json"]);
  check("json: the refusal envelope is TARGET_NOT_FOUND", json.status === 2 && json.envelope?.outcome === "refused" && json.envelope.error?.code === "TARGET_NOT_FOUND", shown(json));
  check("json: the envelope target carries the resolved space and the name", json.envelope?.target?.space === space && json.envelope.target.name === absent, json.envelope?.target);
  check("json: the envelope alone reports the refusal, with nothing on stderr", json.stderr === "", shown(json));
  check("json: the remedy names who to list", json.envelope?.error?.remedy?.includes(`cotal who --all --space ${space}`) === true, json.envelope?.error);

  const mention = run(["send", "-c", "general", "--mention", absent, "hello", "--space", space, "--json"]);
  check("mention: an absent mention is refused with the resolved space", mention.status === 2 && mention.envelope?.error?.code === "TARGET_NOT_FOUND" && mention.envelope.target?.space === space, shown(mention));

  const probeCreds = join(dir, "probe.creds");
  writeFileSync(probeCreds, await mintCreds(auth, newIdentity(), "probe"), { mode: 0o600 });
  const denied = run(["send", "-c", "general", "hello", "--creds", probeCreds, "--server", servers, "--space", space, "--json"]);
  check("creds: a credential that may not read presence is refused PERMISSION_DENIED before publishing", denied.status === 2 && denied.envelope?.error?.code === "PERMISSION_DENIED" && denied.envelope.target?.space === space && denied.envelope.error.message?.includes("may not read the presence") === true, shown(denied));

  // A --server nothing answers at names that address. The space's own broker still answers and is
  // only named, never tried in its place, so nothing reaches its history.
  const kept = run(["send", "-c", "general", "kept", "--space", space]);
  const history = () => (JSON.parse(run(["history", "general", "--space", space, "--json"]).stdout) as { result?: { items?: { text?: string }[] } }).result?.items?.map((m) => m.text).join("|");
  const before = history();
  const closed = `nats://127.0.0.1:${await freePort()}`;
  const unanswered = `nothing answered at ${closed}, the broker address --server named`;
  for (const args of [["send", "-c", "general", "x", "--server", closed], ["history", "general", "--server", closed], ["send", "-c", "general", "x", "--space", space, "--server", closed]]) {
    const r = run([...args, "--json"]);
    check(`${args.slice(0, 2).join(" ")}${args.includes("--space") ? " --space" : ""} --server <closed>: refused TARGET_UNAVAILABLE, exit 2, naming that address and the space's recorded broker`,
      r.status === 2 && r.envelope?.error?.code === "TARGET_UNAVAILABLE" && r.envelope.error.message === unanswered
        && r.envelope.error.remedy === `check that address, or drop --server to reach "${space}" at ${servers}, where it is recorded`, shown(r));
  }
  const empty = mkdtempSync(join(dir, "empty-"));
  const bare = run(["send", "-c", "general", "x", "--server", closed, "--json"], empty);
  check("from a folder with no space, it names that address and no recorded mesh",
    bare.status === 2 && bare.envelope?.error?.code === "TARGET_UNAVAILABLE" && bare.envelope.error.message === unanswered
      && bare.envelope.error.remedy === "check that address and that a broker runs there" && !bare.stdout.includes("recorded at"), shown(bare));
  check("the space's history is unchanged", kept.status === 0 && before === "kept" && history() === before, { kept: shown(kept), before, after: history() });

  // The CLI resolves a real direct recipient and reaches the broker's message publish ACL on all
  // three routes. Stream counts and sequence frontiers detect both stored sends and consumed ones.
  issuer = new CotalEndpoint({ servers, space, creds: provisionerCreds, channels: [], consume: false, watchPresence: false, registerPresence: false, card: { name: "issuer", kind: "endpoint" } });
  await issuer.start();
  const listener = newIdentity();
  const lifecycleUid = mintLifecycleUid();
  const listenerCreds = await provisionAgent(issuer, auth, listener, { lifecycleUid, role: "reviewer", subscribe: [], allowSubscribe: [], durableMembership: false });
  recipient = new CotalEndpoint({
    servers, space, creds: listenerCreds, lifecycleUid,
    channels: [], consume: false, card: { name: "alice", role: "reviewer", kind: "agent", id: listener.id },
  });
  await recipient.start();
  inspector = await connect({ servers, authenticator: credsAuthenticator(new TextEncoder().encode(provisionerCreds)), inboxPrefix: `_INBOX_${provisioner.id}` });
  const jsm = await jetstreamManager(inspector);
  const state = async (stream: string) => {
    const { messages, last_seq } = (await jsm.streams.info(stream)).state;
    return { messages, last_seq };
  };
  for (const [label, flags] of [
    ["observer", ["--profile", "observer"]], ["admin", ["--profile", "admin"]],
    ["readonly", ["--allow-subscribe", "general", "--no-persona"]], ["poster", ["--allow-publish", "general", "--no-persona"]],
  ] as const) {
    const r = run(["auth", "mint", label, "--space", space, ...flags, "--out", credsPath(label), "--json"]);
    if (r.status !== 0) throw new Error(`auth mint ${label} failed: ${JSON.stringify(shown(r))}`);
  }
  const generalMint = `cotal auth mint <label> --space ${space} --allow-publish general --no-persona --out <file>`;
  for (const [flag, destination, stream] of [
    ["-t", "alice", dmStream(space)], ["-r", "reviewer", taskStream(space)], ["-c", "general", chatStream(space)],
  ] as const) {
    const prior = await state(stream);
    const args = ["send", flag, destination, "acl probe", "--space", space];
    for (const label of flag === "-c" ? ["observer", "admin", "readonly"] : ["observer"]) {
      for (const style of ["text", "json"]) {
        const r = run([...args, "--creds", credsPath(label), ...(style === "json" ? ["--json"] : [])]);
        const detail = style === "json" ? r.envelope?.error : { code: r.stderr.includes("PERMISSION_DENIED") ? "PERMISSION_DENIED" : undefined, message: r.stderr, remedy: r.stderr };
        check(`${style} ${flag} with ${label}: refused exit 2 with a credential remedy`, r.status === 2 && detail?.code === "PERMISSION_DENIED"
          && detail.message?.includes("it was not stored") === true && detail.remedy?.includes("cotal send") === true && detail.remedy.includes("without --creds")
          && (style !== "json" || r.envelope?.outcome === "refused" && r.envelope.target?.space === space), shown(r));
        if (flag === "-c") {
          const profile = label === "readonly" ? "agent" : label;
          check(`${style} channel with ${label}: names its profile, empty post grant and least-privilege mint`, detail?.remedy?.includes(`Credential profile: ${profile}`) === true
            && detail.remedy.includes(`may post to no channel in ${space}`) && detail.remedy.includes(generalMint)
            && (style !== "json" || r.envelope?.target?.post?.length === 0), shown(r));
        }
        const after = await state(stream);
        check(`${style} ${flag} with ${label}: neither broker count nor sequence advanced`, after.messages === prior.messages && after.last_seq === prior.last_seq, { prior, after });
      }
    }
    const control = run([...args, ...(flag === "-c" ? ["--creds", credsPath("poster")] : []), "--json"]);
    const after = await state(stream);
    check(`authorized ${flag}: shipped send stores once and confirms storage`, control.status === 0 && control.envelope?.result?.stored === true
      && after.messages === prior.messages + 1 && after.last_seq === prior.last_seq + 1, { reply: shown(control), prior, after });
  }
  const auditSend = ["send", "--channel=--audit", "acl probe", "--space", space, "--json"];
  const chatBefore = await state(chatStream(space));
  const limited = run([...auditSend, "--creds", credsPath("poster")]);
  const chatDenied = await state(chatStream(space));
  check("a different channel grant remains visible and the mint names the attempted channel", limited.status === 2 && limited.envelope?.error?.code === "PERMISSION_DENIED"
    && limited.envelope.error.remedy?.includes("#general") === true && limited.envelope.error.remedy.includes("--allow-publish=--audit")
    && JSON.stringify(limited.envelope.target?.post) === '["general"]'
    && chatDenied.messages === chatBefore.messages && chatDenied.last_seq === chatBefore.last_seq, shown(limited));
  const minted = run(["auth", "mint", "audit_poster", "--space", space, "--allow-publish=--audit", "--no-persona", "--out", credsPath("audit_poster"), "--json"]);
  if (minted.status !== 0) throw new Error(`auth mint audit_poster failed: ${JSON.stringify(shown(minted))}`);
  const recovered = run([...auditSend, "--creds", credsPath("audit_poster")]);
  const chatAfter = await state(chatStream(space));
  check("the channel mint remedy produces a credential that stores on the requested channel", recovered.status === 0 && recovered.envelope?.result?.stored === true
    && chatAfter.messages === chatBefore.messages + 1 && chatAfter.last_seq === chatBefore.last_seq + 1, { reply: shown(recovered), chatBefore, chatAfter });

  // #7045: an open space that runs elsewhere gets its streams from its first participant, and a
  // one-shot send may be that participant. The space is not registered and its broker is open.
  await awaitBrokerReady(() => isReachable(openServers), { servers: openServers, attempts: 25, delayMs: 200 });
  const openSpace = `sendopen-${randomUUID().slice(0, 8)}`;
  const first = run(["send", "-c", "general", "first-open", "--space", openSpace, "--server", openServers, "--json"]);
  check("open: the first send to a never-used open space is stored, exit 0", first.status === 0 && first.envelope?.outcome === "ok", shown(first));
  const openHistory = run(["history", "general", "--space", openSpace, "--server", openServers, "--json"]);
  const openTexts = (JSON.parse(openHistory.stdout || "{}") as { result?: { items?: { text?: string }[] } }).result?.items?.map((m) => m.text).join("|");
  check("open: its history holds that message", openHistory.status === 0 && openTexts === "first-open", shown(openHistory));

  const openRoot = join(dir, "open-project");
  mkdirSync(join(openRoot, ".cotal"), { recursive: true, mode: 0o700 });
  recordMesh({ space: openSpace, server: openServers, root: openRoot, mode: "open", ts: new Date().toISOString() });
  const alias = run(["send", "-c", "general", "wrong-space", "--server", `nats://localhost:${openPort}`, "--json"], openRoot);
  const openInspector = await connect({ servers: openServers });
  try {
    const streamNames: string[] = [];
    const openJsm = await jetstreamManager(openInspector);
    for await (const name of openJsm.streams.names()) streamNames.push(name);
    check("open: an unmatched loopback host inside the registered project refuses without creating a chat stream for main",
      alias.status === 2 && alias.envelope?.error?.code === "TARGET_NOT_FOUND" && alias.envelope.error.message?.includes(`${openSpace} (${openServers})`) === true
        && streamNames.includes(chatStream(openSpace)) && !streamNames.includes(chatStream(DEFAULT_SPACE)), { reply: shown(alias), streamNames });
  } finally {
    await openInspector.close();
  }

  // The distinction the remedy above depends on stays: on a space this machine started, absent
  // streams mean the space was deleted, so a send refuses rather than create them again.
  const hereSpace = `sendhere-${randomUUID().slice(0, 8)}`;
  const hereRoot = join(dir, "here");
  mkdirSync(join(hereRoot, ".cotal"), { recursive: true, mode: 0o700 });
  recordMesh({ space: hereSpace, server: openServers, root: hereRoot, mode: "open", ts: new Date().toISOString() });
  const gone = run(["send", "-c", "general", "never-stored", "--space", hereSpace, "--json"], hereRoot);
  check("open: a space this machine started whose streams are gone still refuses TARGET_UNAVAILABLE, exit 2", gone.status === 2 && gone.envelope?.error?.code === "TARGET_UNAVAILABLE" && gone.envelope.error.message?.includes(`the streams of ${hereSpace} are not on its broker`) === true, shown(gone));
} catch (error) {
  check("scenario completed", false, (error as Error).stack ?? String(error));
} finally {
  for (const result of await Promise.allSettled([recipient?.stop(), issuer?.stop(), inspector?.close()])) {
    if (result.status === "rejected") check("fixture connections closed", false, result.reason);
  }
  await killAndAwaitExit(broker);
  await killAndAwaitExit(openBroker);
  releaseBroker();
  releaseOpenBroker();
  rmSync(dir, { recursive: true, force: true });
}

finish();
process.exit(process.exitCode ?? 0);
