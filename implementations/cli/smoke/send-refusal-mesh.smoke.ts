/**
 * A classified `send` refusal on a resolved space names that space. `send -t <absent>` used to print
 * its TARGET_NOT_FOUND report with no `Mesh:` line and a JSON target without `space`, although the
 * space was resolved and connected before the recipient was looked up. The same lookup serves
 * `--mention`. The refusal also says what to run next, in `error.remedy` and the human report.
 * A `--creds` credential that may not read presence used to wait out a five-second Direct Get
 * timeout and exit 3 with an unknown `timeout`; it is refused with `PERMISSION_DENIED`.
 * A `--server` nothing answers at used to be reported as the space's mesh recorded at its root but
 * not running, with `cotal up` as the Next, and in a folder with no space as a `main` mesh recorded
 * there. `send` and `history` now name the address that did not answer and, from the space's root or
 * with `--space`, the broker recorded for it, and the space's history is unchanged.
 *
 * Starts one static-auth broker owned by this suite, registers its space under a sandboxed
 * COTAL_HOME, and drives the built binary from the space's root.
 *
 * Run: pnpm smoke:send-refusal-mesh
 */
import { spawn, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createSpaceAuth, isReachable, mintCreds, newIdentity, serverConfig, setupSpaceStreams } from "@cotal-ai/core";
import { SMOKE_BROKER_TOKEN, awaitBrokerReady, createSuite, freePort, killAndAwaitExit, teardownOnSignal } from "@cotal-ai/smoke-kit";
import { authDir, recordMesh, saveSpaceAuth } from "@cotal-ai/workspace";

const BIN = join(import.meta.dirname, "..", "..", "..", "bin", "dist", "cotal.js");
if (!existsSync(BIN)) {
  console.error(`✗ ${BIN} missing - build first: pnpm --filter cotal-ai... build`);
  process.exit(1);
}

interface Envelope {
  outcome: string;
  target: { space?: string; name?: string } | null;
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

try {
  await awaitBrokerReady(() => isReachable(servers), { servers, attempts: 25, delayMs: 200 });
  await setupSpaceStreams({ servers, space, creds: await mintCreds(auth, newIdentity(), "provisioner") });
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

  const adminCreds = join(dir, "admin.creds");
  writeFileSync(adminCreds, await mintCreds(auth, newIdentity(), "admin"), { mode: 0o600 });
  const denied = run(["send", "-c", "general", "hello", "--creds", adminCreds, "--server", servers, "--space", space, "--json"]);
  check("creds: a credential that may not read presence is refused PERMISSION_DENIED with the space", denied.status === 2 && denied.envelope?.error?.code === "PERMISSION_DENIED" && denied.envelope.target?.space === space, shown(denied));

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
} catch (error) {
  check("scenario completed", false, (error as Error).stack ?? String(error));
} finally {
  await killAndAwaitExit(broker);
  releaseBroker();
  rmSync(dir, { recursive: true, force: true });
}

finish();
process.exit(process.exitCode ?? 0);
