/** A shared-address refusal names every blocker without changing the registry or stopping a REAL broker. */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync } from "node:fs";
import { createConnection } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { assertSmokeSandboxDown, freePort, recordSmokeSandbox, SMOKE_BROKER_TOKEN } from "@cotal-ai/smoke-kit";
import { findMesh, recordMesh, removeMesh } from "@cotal-ai/workspace";

const bin = join(import.meta.dirname, "../../../bin/dist/cotal.js");
const home = realpathSync(mkdtempSync(join(tmpdir(), `${SMOKE_BROKER_TOKEN}down-shared-`)));
const root = join(home, "project"), neighbor = join(home, "neighbor");
const xdg = join(home, "config"), runtime = join(home, "run"), cotalHome = join(home, "cotal");
for (const dir of [root, neighbor, xdg, runtime, cotalHome]) mkdirSync(dir, { mode: 0o700 });
process.env.COTAL_HOME = cotalHome;
const env = { PATH: process.env.PATH, TMPDIR: home, HOME: home, USERPROFILE: home, XDG_CONFIG_HOME: xdg, XDG_RUNTIME_DIR: runtime, COTAL_HOME: cotalHome, COTAL_SKIP_CONNECTOR_SEED: "1", NO_COLOR: "1" };
const port = await freePort();
const server = `nats://127.0.0.1:${port}`;
const space = "shared-owner", manual = "shared-neighbor", legacy = "\u2013json", catalog = "shared-catalog";
const escapedNames = [["join\u200der", "join\\u200der"], ["tab\tname", "tab\\tname"]] as const;
const blockers = [manual, legacy, catalog, ...escapedNames.map(([name]) => name)];
const journal = join(root, ".cotal", "stack-controller.json");
console.log(`Sandbox retained at ${home}`);

function cli(expected: number, ...args: string[]) {
  const options = { cwd: root, env, encoding: "utf8" as const, timeout: 60_000 };
  assertSmokeSandboxDown(anchor, args, options);
  const result = spawnSync(process.execPath, [bin, ...args], options);
  assert.ifError(result.error);
  assert.equal(result.status, expected, `${args.join(" ")}\n${result.stdout}\n${result.stderr}`);
  return result;
}

function listening(): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = createConnection({ host: "127.0.0.1", port });
    socket.once("connect", () => { socket.destroy(); resolve(true); });
    socket.once("error", () => resolve(false));
    socket.setTimeout(500, () => { socket.destroy(); resolve(false); });
  });
}

let anchor: ReturnType<typeof recordSmokeSandbox> | undefined;
try {
  cli(0, "space", "create", space);
  anchor = recordSmokeSandbox({ root, cotalHome, xdgConfigHome: xdg });
  cli(0, "up", "--detach", "--open", "--no-manager", "--server", server);
  assert.equal(await listening(), true);
  cli(0, "space", "add", manual, "--mode", "open", "--server", server, "--root", neighbor, "--force", "--yes");
  for (const name of blockers.slice(1)) {
    recordMesh({ space: name, root: neighbor, server, mode: "open", origin: name === catalog ? "catalog" : "manual", ts: new Date(0).toISOString() });
  }
  const registrations = blockers.map(findMesh);
  const journalBefore = readFileSync(journal, "utf8");

  const human = cli(2, "down", "--yes");
  const plain = cli(2, "down", "--yes", "--plain");
  assert.equal(human.stdout, "");
  assert.match(human.stderr, /^Next$/m);
  const { outcome, target, error } = JSON.parse(cli(2, "down", "--yes", "--json").stdout);
  assert.equal(outcome, "refused");
  assert.equal(error.code, "LIFECYCLE_BLOCKED");
  assert.equal(target.server, server);
  assert.deepEqual([...target.spaces].sort(), [...blockers].sort());
  for (const name of [manual, legacy, catalog, ...escapedNames.map(([, shown]) => shown)]) assert.ok(error.message.includes(`"${name}"`), error.message);
  assert.ok(human.stderr.includes(error.message), human.stderr);
  assert.ok(plain.stderr.includes(error.message), plain.stderr);
  const hints = [`space show -- ${manual}`, `space forget -- ${manual}`, `space show -- '${legacy}'`, `space forget -- '${legacy}'`,
    `space show -- ${catalog}`, " sync`", "space --json`", "down --yes", "whose spaces are not using the broker"];
  for (const hint of hints) {
    assert.ok(error.remedy.includes(hint) && human.stderr.includes(hint) && plain.stderr.includes(hint), plain.stderr);
  }
  assert.ok(!error.remedy.includes(`space forget -- ${catalog}`), error.remedy);
  for (const [name, shown] of escapedNames) {
    assert.ok(!error.remedy.includes(name) && !error.remedy.includes(shown), error.remedy);
    for (const output of [human.stderr, plain.stderr]) assert.ok(!output.includes(name), output);
  }
  const { result: preview } = JSON.parse(cli(0, "down", "--dry-run", "--json").stdout);
  assert.equal(preview.blockedBy.remedy, error.remedy);
  assert.equal(preview.signalled, false);
  assert.deepEqual(blockers.map(findMesh), registrations);
  assert.equal(readFileSync(journal, "utf8"), journalBefore);
  assert.equal(await listening(), true);

  cli(0, "space", "show", "--", manual);
  cli(0, "space", "show", "--", legacy);
  cli(0, "space", "forget", "--", manual);
  // The legacy name can be forgotten, but it cannot key a per-space preference.
  assert.match(cli(4, "space", "forget", "--", legacy).stderr, /per-space preferences were not removed/);
  assert.deepEqual([manual, legacy].map(findMesh), [undefined, undefined]);
  removeMesh(catalog);
  const escapedOnly = JSON.parse(cli(2, "down", "--yes", "--json").stdout);
  assert.deepEqual([...escapedOnly.target.spaces].sort(), escapedNames.map(([name]) => name).sort());
  assert.match(escapedOnly.error.remedy, /space --json`/);
  assert.doesNotMatch(escapedOnly.error.remedy, /space (show|forget)| sync`/);
  assert.equal(await listening(), true);
  const { result: { items } } = JSON.parse(cli(0, "space", "--json").stdout);
  for (const [name] of escapedNames) {
    assert.ok(items.some((row: { space: string; server: string }) => row.space === name && row.server === server));
    assert.equal(JSON.parse(cli(0, "space", "show", "--json", "--", name).stdout).result.space, name);
    cli(4, "space", "forget", "--", name);
    assert.equal(findMesh(name), undefined);
  }
  assert.equal(await listening(), true);
  cli(0, "down", "--yes");
  assert.equal(await listening(), false);
  console.log("PASS down-shared-broker: names all blockers and stops only after they are removed");
} finally {
  if (anchor && await listening()) {
    for (const name of blockers) removeMesh(name);
    cli(0, "down", "--yes");
    assert.equal(await listening(), false, "owned broker still listening after cleanup");
  }
}
