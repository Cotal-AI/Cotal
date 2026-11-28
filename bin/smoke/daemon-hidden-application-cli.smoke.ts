/**
 * The printed applications sentence, driven through the built CLI against a served daemon.
 *
 * The daemon holds a cached hosted-Manager refusal and one sign-in record. No network sign-in
 * happens. The sentence appears on `status` and on a non-local `setup` only while that record is
 * unexpired and the recorded unit pins this CLI. A second sign-in, an expired record, no unit, a
 * unit that pins another entry, and a local setup stay quiet. Once the unit gains this shell's folder and the cached row reads available,
 * the sentence is gone.
 *
 * Run: tsx bin/smoke/daemon-hidden-application-cli.smoke.ts
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { writeSecretFile } from "@cotal-ai/core";
import { peerCredentials } from "@cotal-ai/seat";
import { skipSuite } from "@cotal-ai/smoke-kit";
import { spaceSegment } from "@cotal-ai/workspace";
import { recordMesh, removeMesh } from "@cotal-ai/workspace";
import { daemonPaths } from "../daemon/endpoint.js";
import { refreshedDaemonPath } from "../daemon/install.js";
import { serveDaemon } from "../daemon/server.js";

if (process.platform !== "linux") skipSuite("daemon-hidden-application-cli: the built CLI reads the Linux service socket");

const root = mkdtempSync(join(tmpdir(), "cotal-hidden-cli-"));
const runtime = join(root, "run");
mkdirSync(runtime, { mode: 0o700 });
const home = join(root, "home");
const project = join(home, "project");
mkdirSync(project, { recursive: true, mode: 0o700 });
const saved = {
  HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE, XDG_RUNTIME_DIR: process.env.XDG_RUNTIME_DIR,
  XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME, COTAL_HOME: process.env.COTAL_HOME, PATH: process.env.PATH,
};
const bin = join(root, "apps");
mkdirSync(bin, { mode: 0o700 });
writeFileSync(join(bin, "aa-bin"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
process.env.HOME = home;
process.env.USERPROFILE = home;
process.env.XDG_RUNTIME_DIR = runtime;
process.env.XDG_CONFIG_HOME = join(home, ".config");
process.env.COTAL_HOME = join(home, ".cotal");
process.env.PATH = `${bin}${delimiter}${saved.PATH ?? ""}`;
mkdirSync(process.env.COTAL_HOME, { mode: 0o700 });
const manifest = join(process.env.XDG_CONFIG_HOME, "cotal", "extensions");
mkdirSync(join(manifest, "node_modules", "@fixture", "aa", "node_modules", "@cotal-ai"), { recursive: true, mode: 0o700 });
writeFileSync(join(manifest, "node_modules", "@fixture", "aa", "package.json"), JSON.stringify({ name: "@fixture/aa", version: "0.0.0", type: "module" }));
writeFileSync(join(manifest, "node_modules", "@fixture", "aa", "index.js"), `import { registry } from "@cotal-ai/core";
registry.register({ kind: "connector", name: "aa", requires: ["aa-bin"], buildLaunch: () => ({ command: "aa-bin", args: [] }) });
`);
const core = dirname(fileURLToPath(import.meta.resolve("@cotal-ai/core")));
symlinkSync(core, join(manifest, "node_modules", "@fixture", "aa", "node_modules", "@cotal-ai", "core"));
writeFileSync(join(manifest, "extensions.json"), JSON.stringify({ extensions: [{
  pkg: "@fixture/aa", version: "0.0.0", spec: "@fixture/aa@0.0.0",
  provides: [{ kind: "connector", name: "aa" }], commands: [],
  connectors: [{ name: "aa", requires: ["aa-bin"], eventPlane: false, setup: null }],
}] }));

const cli = join(fileURLToPath(new URL("..", import.meta.url)), "dist", "cotal.js");
const entry = realpathSync(cli);
const node = realpathSync(process.execPath);
const unitPath = join(root, "cotal-daemon.service");
const render = (file: string) => `[Service]\nEnvironment=COTAL_DAEMON_NATIVE_SERVICE=1\nEnvironment=PATH="/usr/bin:/bin"\nExecStart="${node}" "--max-semi-space-size=1" "${file}" daemon serve\n`;
const own = render(entry);
const foreign = render(join(dirname(entry), "cotal-program.js"));
const receipt = (source: string) => `${JSON.stringify({ v: 1, mechanism: "systemd-user", unit: "cotal-daemon.service", unitPath, unitSha256: createHash("sha256").update(source).digest("hex"), installedAt: new Date().toISOString() })}\n`;
const paths = daemonPaths();
const sessionFile = join(process.env.COTAL_HOME, "idp-sessions.json");
const session = (live: boolean, second = false) => JSON.stringify({ ver: 1, sessions: {
  "http://127.0.0.1:9": { token: "opaque-token", expiresAt: Math.floor(Date.now() / 1000) + (live ? 3600 : -60), sub: "user" },
  ...(second ? { "http://127.0.0.2:9": { token: "opaque-token-2", expiresAt: Math.floor(Date.now() / 1000) + 3600, sub: "user" } } : {}),
} }, null, 2);
const refusal = join(process.env.COTAL_HOME, "daemon", spaceSegment("seen"), "manager-refusal.json");
mkdirSync(join(refusal, ".."), { recursive: true, mode: 0o700 });
const reason = "aa harness needs aa-bin on PATH - not found";
writeFileSync(refusal, JSON.stringify({ space: "seen", state: "refused", restarts: 0, connectors: [{ agent: "aa", state: "unavailable", reason }] }), { mode: 0o600 });

const daemon = await serveDaemon({ paths, version: "0.0.0-hidden-cli", sessionDir: process.env.COTAL_HOME, peerUid: (sock) => peerCredentials(sock).uid });
let checks = 0;
const check = (name: string, value: unknown) => { assert.ok(value, name); checks++; console.log(`  ✓ ${name}`); };
const lineOf = (text: string, start: string) => text.split("\n").find((row) => row.includes(start)) ?? "";
const run = (args: string[]) => new Promise<{ code: number | null; out: string; err: string }>((resolve) => {
  const child = spawn(node, [cli, ...args], { cwd: project, env: { ...process.env, COTAL_SKIP_CONNECTOR_SEED: "1", DO_NOT_TRACK: "1", NO_COLOR: "1" }, stdio: ["ignore", "pipe", "pipe"] });
  let out = "", err = "";
  child.stdout.on("data", (chunk) => { out += chunk; });
  child.stderr.on("data", (chunk) => { err += chunk; });
  child.on("close", (code) => resolve({ code, out, err }));
});
const sentence = "the background service cannot see aa";
try {
  writeFileSync(unitPath, own, { mode: 0o600 });
  writeSecretFile(join(paths.state, "service-unit.json"), receipt(own));
  recordMesh({ space: "seen", server: "nats://127.0.0.1:4222", root: project, mode: "open", origin: "manual", ts: new Date().toISOString() });
  writeSecretFile(sessionFile, session(true));
  const status = await run(["status", "--plain"]);
  const statusLine = lineOf(status.out, "Agent applications:");
  check("status names the sentence while this installation holds one unexpired sign-in",
    status.code === 0 && statusLine.includes("aa") && statusLine.includes(sentence) && statusLine.includes("daemon setup"));
  const setup = await run(["setup", "--destination", "self-hosted", "--harness", "aa", "--project", project, "--space", "seen", "--no-input", "--plain"]);
  const setupLine = lineOf(setup.out, "application:");
  check("a non-local setup names the same sentence",
    setup.code === 0 && setupLine.includes("aa") && setupLine.includes(sentence) && setup.out.includes("daemon setup"));
  removeMesh("seen");
  const local = await run(["setup", "--destination", "local", "--harness", "aa", "--project", project, "--space", "home", "--no-input", "--plain"]);
  check("a local setup stays quiet", local.code === 0 && !local.out.includes(sentence) && !local.out.includes("daemon setup"));
  recordMesh({ space: "seen", server: "nats://127.0.0.1:4222", root: project, mode: "open", origin: "manual", ts: new Date().toISOString() });
  writeFileSync(unitPath, foreign, { mode: 0o600 });
  writeSecretFile(join(paths.state, "service-unit.json"), receipt(foreign));
  const other = await run(["status", "--plain"]);
  check("a unit recorded by another installation stays quiet", other.code === 0 && !other.out.includes(sentence));
  rmSync(join(paths.state, "service-unit.json"), { force: true });
  const none = await run(["status", "--plain"]);
  check("no recorded unit stays quiet", none.code === 0 && !none.out.includes(sentence));
  writeFileSync(unitPath, own, { mode: 0o600 });
  writeSecretFile(join(paths.state, "service-unit.json"), receipt(own));
  writeSecretFile(sessionFile, session(false));
  const expired = await run(["status", "--plain"]);
  check("an expired sign-in stays quiet", expired.code === 0 && !expired.out.includes(sentence));
  writeSecretFile(sessionFile, session(true, true));
  const several = await run(["status", "--plain"]);
  check("several sign-ins stay quiet", several.code === 0 && !several.out.includes(sentence));
  writeSecretFile(sessionFile, session(true));
  const narrow = readFileSync(unitPath, "utf8");
  const accountPath = `${bin}${delimiter}/usr/bin${delimiter}/bin`;
  const widened = refreshedDaemonPath("systemd-user", narrow, accountPath);
  if (!widened?.includes(bin)) throw new Error("the recorded unit did not gain this shell's application folder");
  writeFileSync(unitPath, widened, { mode: 0o600 });
  writeSecretFile(join(paths.state, "service-unit.json"), receipt(widened));
  writeFileSync(refusal, JSON.stringify({ space: "seen", state: "refused", restarts: 0, connectors: [{ agent: "aa", state: "available" }] }), { mode: 0o600 });
  const repaired = await run(["status", "--plain"]);
  const repairedLine = lineOf(repaired.out, "Agent applications:");
  check("the sentence is gone once the repaired unit's report says the application is available",
    repaired.code === 0 && repairedLine.includes("aa") && !repaired.out.includes(sentence) && readFileSync(unitPath, "utf8").includes(bin));
} finally {
  await daemon.close();
  rmSync(unitPath, { force: true });
  for (const [key, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[key]; else process.env[key] = value;
  }
  rmSync(root, { recursive: true, force: true });
}
console.log(`daemon-hidden-application-cli: ${checks} checks`);
