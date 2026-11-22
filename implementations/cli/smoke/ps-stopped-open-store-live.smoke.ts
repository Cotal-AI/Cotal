import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, realpathSync, statSync } from "node:fs";
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

const space = "foreground-open-store", server = `nats://127.0.0.1:${await freePort()}`;
const registration = join(env.COTAL_HOME, "meshes", `space.${spaceKey(space)}.json`);
const owner = spawn(process.execPath, [cli, "up", "--foreground", "--open", "--no-manager", "--space", space, "--server", server, "--store-dir", "./custom"], { cwd: project, env, stdio: ["ignore", "pipe", "pipe"] });
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

function ps(cwd: string, ...flags: string[]): string {
  const result = spawnSync(process.execPath, [cli, "ps", "--plain", ...flags], { cwd, env, encoding: "utf8", timeout: 30_000 });
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

const mode = statSync(jetstream).mode & 0o777;
chmodSync(jetstream, mode & ~0o222);
try {
  permission(ps(project));
  permission(ps(project, "--space", space, "--server", server));
  permission(ps(nested, "--space", space, "--server", `${server}/`));
  unavailable(ps(project, "--space", space, "--server", `nats://127.0.0.1:${await freePort()}`));
  unavailable(ps(project, "--space", "another-space", "--server", server));
  unavailable(ps(project, "--space", space, "--server", server.replace(/^nats:/, "tls:")));
  unavailable(ps(other, "--space", space, "--server", server));
} finally { chmodSync(jetstream, mode); }
unavailable(ps(project, "--space", space, "--server", server));
emitSentinel({ cells: 8, passed: 8, failed: 0 });
