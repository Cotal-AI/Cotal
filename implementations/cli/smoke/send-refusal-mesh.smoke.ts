/**
 * A classified `send` refusal on a resolved space names that space. `send -t <absent>` used to print
 * its TARGET_NOT_FOUND report with no `Mesh:` line and a JSON target without `space`, although the
 * space was resolved and connected before the recipient was looked up. The same lookup serves
 * `--mention`. The refusal also says what to run next, in `error.remedy` and the human report.
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
  error?: { code: string; remedy?: string };
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
const run = (args: string[]) => {
  const r = spawnSync(process.execPath, [BIN, ...args], { cwd: root, env, encoding: "utf8", timeout: 60_000 });
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
  check("json: stderr still has the human report with the Mesh line", firstLine(json.stderr) === `Mesh: ${space}`, shown(json));
  check("json: the remedy names who to list", json.envelope?.error?.remedy?.includes(`cotal who --all --space ${space}`) === true, json.envelope?.error);

  const mention = run(["send", "-c", "general", "--mention", absent, "hello", "--space", space, "--json"]);
  check("mention: an absent mention is refused with the resolved space", mention.status === 2 && mention.envelope?.error?.code === "TARGET_NOT_FOUND" && mention.envelope.target?.space === space, shown(mention));
} catch (error) {
  check("scenario completed", false, (error as Error).stack ?? String(error));
} finally {
  await killAndAwaitExit(broker);
  releaseBroker();
  rmSync(dir, { recursive: true, force: true });
}

finish();
process.exit(process.exitCode ?? 0);
