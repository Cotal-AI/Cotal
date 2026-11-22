import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { emitSentinel, freePort, recordSmokeSandbox, SMOKE_BROKER_TOKEN } from "@cotal-ai/smoke-kit";
import { spaceKey, verifyIdentityPin, type ProcessIdentityRecord } from "@cotal-ai/workspace";
import { finishOwnedChild, observeOwnedChild, waitForOwnedChild } from "./_foreground-owned-child.js";

if (process.platform === "win32" || process.getuid?.() === 0) {
  console.log("SKIP ps-stopped-open-store: requires non-root POSIX permission checks");
  process.exit(0);
}

const cli = join(import.meta.dirname, "../../../bin/dist/cotal.js");
assert.ok(existsSync(cli), "build the shipped CLI first: pnpm --filter cotal-ai... build");
const root = realpathSync(mkdtempSync(join(tmpdir(), `${SMOKE_BROKER_TOKEN}ps-stopped-open-store-`)));
const home = join(root, "home"), project = join(root, "project"), nested = join(project, "nested"), other = join(root, "other");
const control = join(project, ".cotal"), jetstream = join(project, "custom", "jetstream");
const ambient = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("COTAL_")));
const env = {
  ...ambient, HOME: home, COTAL_HOME: join(home, "machine"), XDG_CONFIG_HOME: join(home, "config"),
  XDG_RUNTIME_DIR: join(home, "runtime"), XDG_DATA_HOME: join(home, "data"), XDG_CACHE_HOME: join(home, "cache"),
  XDG_STATE_HOME: join(home, "state"), COTAL_TELEMETRY: "off", COTAL_SKIP_CONNECTOR_SEED: "1", NO_COLOR: "1",
};
for (const path of [control, nested, join(other, ".cotal"), env.COTAL_HOME, env.XDG_CONFIG_HOME, env.XDG_RUNTIME_DIR])
  mkdirSync(path, { recursive: true, mode: 0o700 });
recordSmokeSandbox({ root: project, cotalHome: env.COTAL_HOME, xdgConfigHome: env.XDG_CONFIG_HOME });

const space = "foreground-open-store";

async function startAndStop(server: string, host: string): Promise<void> {
  const registration = join(env.COTAL_HOME, "meshes", `space.${spaceKey(space)}.json`);
  const args = [cli, "up", "--foreground", "--open", "--no-manager", "--space", space, "--server", server, "--host", host, "--store-dir", "./custom"];
  const owner = spawn(process.execPath, args, { cwd: project, env, stdio: ["ignore", "pipe", "pipe"] });
  const state = observeOwnedChild(owner);
  let output = "", broker: ProcessIdentityRecord | undefined;
  owner.stdout.on("data", (data: Buffer) => { output += data.toString(); });
  owner.stderr.on("data", (data: Buffer) => { output += data.toString(); });
  function collectBroker(): void {
    const pin = verifyIdentityPin(join(control, "nats.pid"));
    if (pin.kind === "match") broker = pin.record;
  }
  try {
    await waitForOwnedChild(() => {
      if (state.error || state.exited) throw state.error ?? new Error(output);
      collectBroker();
      return broker !== undefined && existsSync(registration) && existsSync(join(control, "agents", "default.md"));
    }, 30_000, "foreground open stack ready");
  } finally {
    await finishOwnedChild(owner, state, collectBroker, () => broker ? [broker] : [], "foreground open stack");
  }
  assert.equal(state.code, 143, output);
  assert.equal(existsSync(registration), false, "the stopped open stack has no registration");
  assert.equal(existsSync(join(control, "stack-controller.json")), false, "the stack has no controller journal");
}

function ps(cwd: string, ...flags: string[]): string {
  const result = spawnSync(process.execPath, [cli, "ps", ...flags], { cwd, env, encoding: "utf8", timeout: 30_000 });
  if (result.error) throw result.error;
  const text = `${result.stdout}${result.stderr}`;
  assert.equal(result.status, 2, text);
  return text;
}

function permission(text: string): void {
  assert.match(text, /PERMISSION_DENIED/);
  assert.ok(text.includes(`${jetstream} is not writable by this account (EACCES)`), text);
  assert.ok(text.includes(`chmod -R u+w ${jetstream}`), text);
}

function unavailable(text: string): void {
  assert.match(text, /TARGET_UNAVAILABLE/);
  assert.ok(!text.includes(jetstream), text);
}

function readOnlyStore(check: () => void): void {
  const mode = statSync(jetstream).mode & 0o777;
  chmodSync(jetstream, mode & ~0o222);
  try { check(); } finally { chmodSync(jetstream, mode); }
}

const port = await freePort(), otherPort = await freePort();
const server = `nats://127.0.0.1:${port}`;
await startAndStop(server, "127.0.0.1");
readOnlyStore(() => {
  permission(ps(project, "--plain"));
  permission(ps(project, "--plain", "--space", space, "--server", server));
  permission(ps(nested, "--plain", "--space", space, "--server", `${server}/`));
  unavailable(ps(project, "--plain", "--space", space, "--server", `nats://127.0.0.1:${otherPort}`));
  unavailable(ps(project, "--plain", "--space", "another-space", "--server", server));
  unavailable(ps(project, "--plain", "--space", space, "--server", server.replace(/^nats:/, "tls:")));
  unavailable(ps(other, "--plain", "--space", space, "--server", server));
});
unavailable(ps(project, "--plain", "--space", space, "--server", server));

const wildcardPort = await freePort();
const wildcardClient = `nats://127.0.0.${process.platform === "linux" ? 2 : 1}:${wildcardPort}`;
await startAndStop(wildcardClient, "0.0.0.0");
const configPath = join(control, "server-open.conf");
const config = readFileSync(configPath, "utf8");
assert.match(config, /^host: 0\.0\.0\.0$/m);
assert.ok(config.includes(`# client URL: ${JSON.stringify(wildcardClient)}\n`));
readOnlyStore(() => {
  permission(ps(project, "--plain", "--space", space, "--server", wildcardClient));
  const json = JSON.parse(ps(nested, "--json", "--space", space, "--server", wildcardClient));
  assert.equal(json.error?.code, "PERMISSION_DENIED");
  assert.equal(json.target?.root, project);
  assert.ok(json.error?.message.includes(jetstream));
  unavailable(ps(project, "--plain", "--space", space, "--server", `nats://0.0.0.0:${wildcardPort}`));
  const otherHost = process.platform === "linux" ? "127.0.0.1" : "localhost";
  unavailable(ps(project, "--plain", "--space", space, "--server", `nats://${otherHost}:${wildcardPort}`));
});
assert.equal(readFileSync(configPath, "utf8"), config, "ps leaves the retained configuration unchanged");
emitSentinel({ cells: 13, passed: 13, failed: 0 });
