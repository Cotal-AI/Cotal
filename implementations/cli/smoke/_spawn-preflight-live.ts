import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { assertSmokeSandboxDown, freePort, recordSmokeSandbox } from "@cotal-ai/smoke-kit";
import { repoRoot, wait } from "./_console-pty.js";

/** Real static-auth CLI launches with recording harnesses. No provider or service manager needed. */
export async function checkSpawnPreflight(check: (name: string, condition: boolean, detail?: unknown) => void): Promise<void> {
  const home = mkdtempSync(join(tmpdir(), "spf-"));
  const root = join(home, "project");
  const xdg = join(home, "xdg");
  const cotalHome = join(home, "cotal");
  const bins = join(home, "bin");
  mkdirSync(root);
  mkdirSync(bins);
  const env: NodeJS.ProcessEnv = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("COTAL_")));
  Object.assign(env, { HOME: home, COTAL_HOME: cotalHome, XDG_CONFIG_HOME: xdg, TMPDIR: home, COTAL_SKIP_CONNECTOR_SEED: "1", NO_COLOR: "1", PATH: `${bins}:${env.PATH}` });
  const anchor = recordSmokeSandbox({ root, cotalHome, xdgConfigHome: xdg });
  const piCalls = join(home, "pi-calls");
  for (const name of ["claude", "pi", "codex", "opencode"])
    writeFileSync(join(bins, name), `#!/bin/sh\nprintf '%s\\n' "$@" >> '${piCalls}'\nexit 0\n`, { mode: 0o700 });
  const badVersion = join(home, "bad-version");
  writeFileSync(join(bins, "uv"), `#!${process.execPath}
const fs = require("node:fs");
if (process.argv.includes("python")) {
  console.log(fs.existsSync(${JSON.stringify(badVersion)}) ? "9.0.0" : "0.20.1");
  process.exit(0);
}
const { controlKey, controlVersion } = JSON.parse(fs.readFileSync(process.env.COTAL_LAUNCH_MATERIAL, "utf8"));
const token = require("node:crypto").createHmac("sha256", controlKey).update("cotal-hermes-bridge/" + controlVersion).digest("base64url");
const socket = require("node:net").connect(process.env.COTAL_BRIDGE_SOCKET, () => {
  socket.write(JSON.stringify({ t: "subscribe", token }) + "\\n");
});
socket.on("error", () => process.exit(1));
socket.on("close", () => process.exit(0));
setInterval(() => {}, 60_000);
`, { mode: 0o700 });
  const prefix = join(xdg, "cotal", "extensions");
  mkdirSync(join(prefix, "node_modules", "@cotal-ai"), { recursive: true });
  const extensions = ["claude", "pi", "codex", "opencode", "hermes"].map((name) => {
    const pkg = name === "claude" ? "connector-claude-code" : name === "pi" ? "pi" : `connector-${name}`;
    const source = join(repoRoot, "extensions", pkg);
    symlinkSync(source, join(prefix, "node_modules", "@cotal-ai", pkg), "dir");
    return { pkg: `@cotal-ai/${pkg}`, version: JSON.parse(readFileSync(join(source, "package.json"), "utf8")).version, commands: [], provides: [{ kind: "connector", name }], connectors: [{ name, requires: [name === "hermes" ? "uv" : name], eventPlane: name !== "hermes", setup: null }] };
  });
  writeFileSync(join(prefix, "extensions.json"), JSON.stringify({ extensions }));
  const cli = (...args: string[]) => {
    const options = { cwd: root, env, encoding: "utf8" as const, timeout: 90_000 };
    assertSmokeSandboxDown(anchor, args, options);
    const result = spawnSync(process.execPath, [join(repoRoot, "bin", "dist", "cotal.js"), ...args], options);
    return { ...result, out: result.stdout + result.stderr };
  };
  const server = `nats://127.0.0.1:${await freePort()}`;
  const artifacts = () => readdirSync(home).filter((name) => /^(cotal-launch-|cotal-ctl-|cotal-hermes-)|\.sock$/.test(name)).sort();
  const before = artifacts();
  try {
    const prepared = cli("space", "create", "preflight-live");
    check("preflight regression space is prepared", prepared.status === 0, prepared.out);
    const up = cli("up", "-d", "--server", server);
    check("preflight regression static-auth stack starts", up.status === 0, up.out);
    const credsDir = join(root, ".cotal", "auth", "creds");
    const creds = () => existsSync(credsDir) ? JSON.stringify(readdirSync(credsDir, { recursive: true }).sort()) : "absent";
    const initialCreds = creds();
    const invalid: [string, string[], RegExp][] = [
      ["claude", ["--resume=-foo"], /cannot resume/], ["codex", ["--resume=abc"], /resum/], ["opencode", ["--resume=abc"], /resum/],
      ["pi", ["--resume=--help"], /cannot resume/], ["pi", ["--resume=-v"], /cannot resume/], ["pi", ["--prompt=-bad"], /initial prompt cannot start/],
      ["claude", ["--prompt", "   "], /prompt was given but it is empty/], ["pi", ["--opt", "offline=true"], /launch options.*not implemented/], ["claude", ["--variant", "high"], /model variants/],
    ];
    for (const [harness, flags, diagnostic] of invalid) {
      for (const preview of [true, false]) {
        const result = cli("spawn", "-H", harness, ...flags, ...(preview ? ["--dry-run", "--json"] : []));
        check(`${harness} ${flags.join(" ")} ${preview ? "preview" : "foreground"} refuses before credentials or a child`,
          result.status === 1 && diagnostic.test(result.out) && (preview ? /"code":\s*"USAGE_INVALID"/.test(result.stdout) : /^✗ /m.test(result.stderr))
          && !/wrote creds|retired creds|spawning .* on the mesh|OPERATION_UNKNOWN/.test(result.out) && creds() === initialCreds, result.out);
      }
    }
    check("invalid pi resumes never reach its argv", !existsSync(piCalls));
    const preview = cli("spawn", "-H", "pi", "--resume", "session-valid", "--dry-run");
    check("valid direct preview checks connector arguments without creating launch artifacts or session state", preview.status === 0
      && /Connector arguments:\s+checked/.test(preview.out)
      && JSON.stringify(artifacts()) === JSON.stringify(before) && !existsSync(join(root, ".cotal", "pi-sessions")), preview.out);
    const valid = cli("spawn", "-H", "pi", "--resume", "session-valid");
    check("valid pi resume still reaches the native harness as one fork argument", valid.status === 0
      && readFileSync(piCalls, "utf8").includes("--fork\nsession-valid\n"), valid.out);
    if (process.platform !== "win32" && process.getuid?.() !== 0) {
      const blocked = join(root, "noperm_dir");
      mkdirSync(blocked, { mode: 0 });
      try {
        const refusal = cli("spawn", "-d", "-H", "pi", "--cwd", blocked);
        check("unsearchable cwd is refused before execution with its path and EACCES", refusal.status === 2
          && /LIFECYCLE_BLOCKED/.test(refusal.out) && /EACCES/.test(refusal.out) && refusal.out.includes(blocked)
          && /not-executed/.test(refusal.out) && !/chdir\(2\)|OPERATION_FAILED/.test(refusal.out) && creds() === initialCreds, refusal.out);
      } finally { chmodSync(blocked, 0o700); }
    }
    for (const force of [false, true]) {
      const name = force ? "hermes_force" : "hermes_graceful";
      const launched = cli("spawn", "-d", "-H", "hermes", "--no-events", "--model", "test-model", "--name", name);
      check(`${name} starts and joins the real mesh`, launched.status === 0 && /Agent joined/.test(launched.out), launched.out);
      const stopped = cli("stop", name, ...(force ? ["--force"] : []));
      check(`${name} stop is acknowledged`, stopped.status === 0, stopped.out);
      for (let i = 0; i < 100 && JSON.stringify(artifacts()) !== JSON.stringify(before); i++) await wait(100);
      check(`${name} leaves no credential carrier, sockets or disposable profile`, JSON.stringify(artifacts()) === JSON.stringify(before), artifacts());
    }
    writeFileSync(badVersion, "unsupported");
    const failed = cli("spawn", "-d", "-H", "hermes", "--no-events", "--model", "test-model", "--name", "hermes_bad_version");
    check("Hermes startup failure is reported as failed execution", failed.status === 5 && /OPERATION_FAILED/.test(failed.out), failed.out);
    for (let i = 0; i < 100 && JSON.stringify(artifacts()) !== JSON.stringify(before); i++) await wait(100);
    check("Hermes startup failure leaves no material, sockets or disposable profile", JSON.stringify(artifacts()) === JSON.stringify(before), artifacts());
  } finally {
    const down = cli("down", "--yes");
    check("preflight regression stack stops", down.status === 0, down.out);
    rmSync(home, { recursive: true, force: true });
  }
}
