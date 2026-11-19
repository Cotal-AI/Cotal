/** The shipped updater must verify recorded units with and without an explicit Linux runtime. */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { skipSuite } from "@cotal-ai/smoke-kit";
import { SEEDED_EXTENSIONS } from "@cotal-ai/workspace";

if (process.platform !== "linux") skipSuite("daemon receipt without runtime: Linux runtime discovery only");
const repo = join(dirname(fileURLToPath(import.meta.url)), "../..");
const root = realpathSync(mkdtempSync(join(tmpdir(), "dnr-")));
const entry = join(repo, "bin/dist/cotal.js");
const version = JSON.parse(readFileSync(join(repo, "bin/package.json"), "utf8")).version as string;
const standard = `/run/user/${process.geteuid!()}`;
const preload = join(root, "runtime.mjs");
// Redirect only the runtime's filesystem lookups. Keep the real ownership and mode checks and
// let the native stand-in see the exact environment the shipped command would give systemctl.
writeFileSync(preload, `import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
const standard = ${JSON.stringify(standard)};
const { lstatSync } = fs;
fs.lstatSync = (path, ...args) => lstatSync(typeof path === 'string' && (path === standard || path.startsWith(standard + '/'))
  ? process.env.FIXTURE_RUNTIME + path.slice(standard.length) : path, ...args);
syncBuiltinESMExports();
`);
const bin = join(root, "bin");
mkdirSync(bin, { mode: 0o700 });
writeFileSync(join(bin, "systemctl"), `#!/bin/sh
printf '%s %s\\n' "$*" "\${XDG_RUNTIME_DIR-<unset>}" >> "$NATIVE_LOG"
[ "\${XDG_RUNTIME_DIR-}" = "$EXPECTED_RUNTIME" ] || exit 1
case "$*" in
  '--user show-environment') printf 'HOME=%s\\nXDG_CONFIG_HOME=%s\\n' "$HOME" "$XDG_CONFIG_HOME" ;;
  '--user --no-ask-password --no-pager show cotal-daemon.service --property=UnitFileState --value') echo disabled ;;
  *) exit 95 ;;
esac
`, { mode: 0o700 });
for (const tool of ["loginctl", "busctl"]) writeFileSync(join(bin, tool), "#!/bin/sh\nexit 95\n", { mode: 0o700 });

async function run(args: string[], env: NodeJS.ProcessEnv) {
  const child = spawn(process.execPath, args, { cwd: "/", env, stdio: ["ignore", "pipe", "pipe"] });
  let output = "";
  child.stdout.on("data", chunk => output += String(chunk));
  child.stderr.on("data", chunk => output += String(chunk));
  const timer = setTimeout(() => child.kill("SIGKILL"), 60_000);
  try {
    const code = await new Promise<number | null>((resolve, reject) => { child.once("error", reject); child.once("close", resolve); });
    return { code, output };
  } finally { clearTimeout(timer); }
}

const registry = createServer((_request, response) => response.end(JSON.stringify({ name: "cotal-ai", "dist-tags": { latest: version }, versions: { [version]: { name: "cotal-ai", version } } })));
await new Promise<void>(resolve => registry.listen(0, "127.0.0.1", resolve));
try {
  for (const kind of ["present", "dangling", "absent", "standard", "explicit", "unsafe", "self", "preinstall"] as const) {
    const directory = join(root, kind);
    for (const part of ["home", "cotal/daemon", "config", "cache", "data", "state", "tmp"]) mkdirSync(join(directory, part), { recursive: true, mode: 0o700 });
    const runtime = join(directory, "runtime");
    const nativeLog = join(directory, "native.log");
    const recorded = kind !== "present" && kind !== "dangling" && kind !== "absent";
    const receipt = join(directory, "cotal/daemon/service-unit.json");
    if (kind === "present") writeFileSync(receipt, "{}", { mode: 0o600 });
    if (kind === "dangling") symlinkSync(join(directory, "missing-receipt"), receipt);
    const env: NodeJS.ProcessEnv = {
      PATH: `${bin}:${process.env.PATH}`, HOME: join(directory, "home"), COTAL_HOME: join(directory, "cotal"),
      XDG_CONFIG_HOME: join(directory, "config"), XDG_CACHE_HOME: join(directory, "cache"),
      XDG_DATA_HOME: join(directory, "data"), XDG_STATE_HOME: join(directory, "state"), TMPDIR: join(directory, "tmp"),
      NODE_OPTIONS: `--import=${pathToFileURL(preload).href}`, FIXTURE_RUNTIME: runtime, NATIVE_LOG: nativeLog,
      npm_config_registry: `http://127.0.0.1:${(registry.address() as AddressInfo).port}`,
      COTAL_ALLOW_CHECKOUT_SEED: "1", COTAL_NO_UPDATE_CHECK: "1", DO_NOT_TRACK: "1", COTAL_TELEMETRY: "off", NO_COLOR: "1",
    };
    if (recorded) {
      mkdirSync(runtime, { mode: 0o700 });
      if (kind === "unsafe" || kind === "explicit") chmodSync(runtime, 0o755);
      if (kind === "explicit") {
        env.XDG_RUNTIME_DIR = join(directory, "explicit-runtime");
        mkdirSync(env.XDG_RUNTIME_DIR, { mode: 0o700 });
      }
      const unitDir = join(env.XDG_CONFIG_HOME!, "systemd/user");
      mkdirSync(unitDir, { recursive: true, mode: 0o700 });
      const unit = "cotal-daemon.service", unitPath = join(unitDir, unit);
      const bytes = `[Service]\nEnvironment=COTAL_DAEMON_NATIVE_SERVICE=1\nExecStart="${process.execPath}" "${entry}" daemon serve\nRestart=always\n`;
      writeFileSync(unitPath, bytes, { mode: 0o600 });
      writeFileSync(receipt, JSON.stringify({ v: 1, mechanism: "systemd-user", unit, unitPath, unitSha256: createHash("sha256").update(bytes).digest("hex"), installedAt: "2026-11-19T00:00:00.000Z" }), { mode: 0o600 });
      env.EXPECTED_RUNTIME = env.XDG_RUNTIME_DIR ?? standard;
      if (kind !== "unsafe" && kind !== "preinstall") {
        // Model a user who removed every built-in, so reconciliation needs no package archives.
        const seed = join(directory, "config/cotal/seed");
        mkdirSync(seed, { recursive: true, mode: 0o700 });
        writeFileSync(join(seed, "authority.json"), JSON.stringify({ everSeeded: Object.keys(SEEDED_EXTENSIONS) }), { mode: 0o600 });
        writeFileSync(join(seed, "witness.json"), JSON.stringify({ initialized: true, firstGeneration: version }), { mode: 0o600 });
      }
    }
    if (kind === "preinstall") {
      const request = { v: 1, nonce: "0".repeat(32), installedEntry: entry, daemonArgv: [process.execPath, entry, "daemon", "serve"], flags: {} };
      const { code, output } = await run([join(repo, "bin/dist/execution-preinstall.js"), JSON.stringify(request)], env);
      assert.equal(code, 0, output);
      assert.match(output, /"disposition":"restart-empty"/);
      assert.equal(readFileSync(nativeLog, "utf8"), `--user show-environment ${standard}\n`.repeat(2));
      console.log("PASS staged self-update admission uses the private standard runtime");
      continue;
    }
    const { code, output } = await run([entry, "update", ...(!recorded || kind === "self" ? ["--self"] : [])], env);
    if (kind === "present" || kind === "dangling") {
      assert.equal(code, 1, output);
      assert.match(output, /installed daemon preflight.*no installed unit recorded/);
      assert.doesNotMatch(output, /XDG_RUNTIME_DIR is not set/);
      assert.doesNotMatch(output, /Built-in connectors|wrote operator-global seed store payload/);
      assert.equal(existsSync(join(directory, "config/cotal/seed")), false, output);
      assert.equal(existsSync(join(directory, "config/cotal/extensions.json")), false, output);
    } else if (kind === "absent") {
      // The local registry serves version discovery, not package archives. Admission must reach
      // real seed writes, then fail on the intentionally unavailable Jcode package dependency.
      assert.equal(code, 1, output);
      assert.match(output, /ETARGET.*No matching version found for cotal-ai@\^1\.1\.0/s);
      assert.doesNotMatch(output, /installed daemon preflight/);
      assert.match(output, /wrote operator-global seed store payload/);
      assert.equal(existsSync(join(directory, "config/cotal/seed")), true, output);
    } else if (kind === "unsafe") {
      assert.notEqual(code, 0, output);
      assert.match(output, /has mode 0755, not 0700/);
      assert.equal(existsSync(nativeLog), false, output);
      assert.equal(existsSync(join(directory, "config/cotal/seed")), false, output);
    } else {
      assert.equal(code, 0, output);
      assert.match(output, /connectors reconciled/);
      const calls = readFileSync(nativeLog, "utf8").trimEnd().split("\n");
      assert.equal(calls[0], `--user show-environment ${env.EXPECTED_RUNTIME}`);
      assert.ok(calls.every(call => call.endsWith(` ${env.EXPECTED_RUNTIME}`)), calls.join("\n"));
      if (kind === "self") assert.match(output, /cotal-daemon.service: service is disabled; not started/);
    }
    console.log(`PASS real update runtime case: ${kind}`);
  }
} finally { await new Promise<void>((resolve, reject) => registry.close(error => error ? reject(error) : resolve())); }
