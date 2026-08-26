import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { shortSocketHome } from "../src/private-state.js";
import { jcodeConnector } from "../src/extension.js";

let pass = 0;
const check = (name: string, condition: boolean, actual?: unknown): void => {
  assert.ok(condition, `${name}${actual === undefined ? "" : ` — ${JSON.stringify(actual)}`}`);
  pass++;
  console.log(`  ✓ ${name}`);
};

const root = mkdtempSync(join(tmpdir(), "cotal-jcode-security-"));
const tsx = fileURLToPath(new URL("../node_modules/.bin/tsx", import.meta.url));
const esbuild = fileURLToPath(new URL("../node_modules/.bin/esbuild", import.meta.url));
const privateState = fileURLToPath(new URL("../src/private-state.ts", import.meta.url));
const host = fileURLToPath(new URL("../src/host-main.ts", import.meta.url));
const fakeDir = join(root, "bin");
const fake = join(fakeDir, "jcode");
const canary = "AUTH_BYTES_CANARY=do-not-log-this";

try {
  // The production bug exists only in a privileged connector: root can chmod an attacker-owned
  // 0700 directory. Bundle the exact source under test, then run it as root in the public Node
  // image that GitHub-hosted runners can pull anonymously. No locally-built Cotal image is needed.
  if (process.platform === "win32") {
    check("foreign-owner short socket directory check skipped on Windows", true);
  } else if (process.getuid?.() !== 0) {
    const bundledPrivateState = join(root, "private-state.cjs");
    const bundle = spawnSync(esbuild, [privateState, "--bundle", "--platform=node", "--format=cjs", `--outfile=${bundledPrivateState}`], { encoding: "utf8" });
    check("foreign-owner probe bundles the exact private-state source", bundle.status === 0, { status: bundle.status, stdout: bundle.stdout, stderr: bundle.stderr });
    writeFileSync(
      join(root, "foreign-owner-probe.cjs"),
      `const { shortSocketHome } = require("/proof/private-state.cjs");
const home = process.argv[2];
try {
  shortSocketHome(home);
  console.log("ADOPTED_FOREIGN_OWNER");
  process.exitCode = 1;
} catch (error) {
  if (/owned by uid/.test(String(error?.message))) console.log("REFUSED_FOREIGN_OWNER");
  else throw error;
}
`,
    );
    const rootProbe = spawnSync("docker", [
      "run", "--rm", "--entrypoint", "sh", "-u", "0:0", "-v", `${root}:/proof:ro`, "node:24-slim", "-c",
      [
        "set -eu",
        "home=$(mktemp -d /tmp/jcode-owned-home.XXXXXX)",
        `socket=/tmp/jc-$(node -e 'const c=require("node:crypto");const p=require("node:path");console.log(c.createHash("sha256").update(p.resolve(process.argv[1])).digest("hex").slice(0,12))' "$home")`,
        "mkdir -m 700 \"$socket\"",
        "chown 1001:1001 \"$socket\"",
        "set +e; node /proof/foreign-owner-probe.cjs \"$home\"; rc=$?; set -e",
        "rm -rf \"$socket\" \"$home\"",
        "exit \"$rc\"",
      ].join("; "),
    ], { encoding: "utf8" });
    check(
      "root connector refuses a foreign-owned deterministic socket directory",
      rootProbe.status === 0 && /REFUSED_FOREIGN_OWNER/.test(rootProbe.stdout) && !/ADOPTED_FOREIGN_OWNER/.test(rootProbe.stdout),
      { status: rootProbe.status, stdout: rootProbe.stdout, stderr: rootProbe.stderr },
    );
  } else {
    check("root connector refuses a foreign-owned deterministic socket directory", false, "run this suite from a non-root parent so it can create the foreign UID directory");
  }

  // The connector's buildLaunch refuses Windows before host startup because the Harness API bridge
  // is Unix-socket-only. The POSIX ownership guard must not invent a later Windows-only failure.
  const platform = Object.getOwnPropertyDescriptor(process, "platform");
  Object.defineProperty(process, "platform", { value: "win32" });
  try {
    let connectorRefused = false;
    try {
      jcodeConnector.buildLaunch({ space: "security", name: "windowsseat" });
    } catch (error) {
      connectorRefused = /not supported on Windows/.test(String((error as Error).message));
    }
    check("connector rejects unsupported Windows before the Unix socket host can start", connectorRefused);
    const windowsHome = join(root, "windows-managed-home");
    mkdirSync(windowsHome, { recursive: true, mode: 0o700 });
    const short = shortSocketHome(windowsHome);
    check("short socket helper does not add a Windows ownership refusal before connector preflight", short.jcodeHome.includes("/tmp/jc-"), short.jcodeHome);
    short.dispose();
  } finally {
    Object.defineProperty(process, "platform", platform!);
  }

  mkdirSync(fakeDir, { recursive: true, mode: 0o700 });
  // The SDK captures this exact child stderr and puts it in its launch error. host-main must never
  // render the caught message or stack, or an upstream auth failure can disclose the bytes.
  writeFileSync(fake, `#!/bin/sh\nprintf '%s\\n' '${canary}' >&2\nexit 1\n`);
  chmodSync(fake, 0o755);
  const hostHome = join(root, "host-home");
  const ambientEnv: NodeJS.ProcessEnv = { ...process.env };
  for (const key of Object.keys(ambientEnv)) if (key.startsWith("COTAL_")) delete ambientEnv[key];
  const hostEnv = {
    ...ambientEnv,
    PATH: `${fakeDir}:${ambientEnv.PATH ?? ""}`,
    COTAL_SPACE: "security",
    COTAL_NAME: "stderrcanary",
    COTAL_ID: "stderrcanary",
    COTAL_SERVERS: "nats://127.0.0.1:1",
    COTAL_SUBSCRIBE: "team",
    COTAL_ALLOW_SUBSCRIBE: "team",
    COTAL_ALLOW_PUBLISH: "team",
    COTAL_JCODE_HOME: hostHome,
    COTAL_JCODE_TUI: "0",
    COTAL_CONTROL_SOCKET: join(root, "control.sock"),
    COTAL_CONTROL_TOKEN: "jcode-security-control-token",
  };
  const result = spawnSync(tsx, [host], { cwd: root, env: hostEnv, encoding: "utf8" });
  // Render failures as named assertions instead of throwing inside check's condition. mutation-proof
  // needs the canary assertion to print even when a mutant makes the first safe-diagnostic check red.
  const safeCode = result.status === 1 && /startup_failed/.test(result.stderr);
  const noCanary = result.status === 1 && !result.stderr.includes(canary);
  check("host launch failure reports the safe SDK startup code", safeCode, { status: result.status, stderr: result.stderr });
  check("host launch failure never prints captured Jcode child stderr canary", noCanary, { status: result.status, stderr: result.stderr });

  console.log(`\nJCODE SECURITY SMOKE PASSED (${pass} checks)`);
} finally {
  rmSync(root, { recursive: true, force: true });
}
