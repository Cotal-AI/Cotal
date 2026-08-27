import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";
import { assertSmokeSandboxDown, assertSmokeSandboxTargetDown, recordSmokeSandbox } from "@cotal-ai/smoke-kit";

const base = mkdtempSync(join(tmpdir(), "cotal-sandbox-guard-"));
const root = join(base, "root");
const cotalHome = join(base, "home");
const xdgConfigHome = join(base, "config");
const anchor = recordSmokeSandbox({ root, cotalHome, xdgConfigHome });
const env = { COTAL_HOME: cotalHome, XDG_CONFIG_HOME: xdgConfigHome };

try {
  assert.doesNotThrow(() => assertSmokeSandboxDown(anchor, ["down"], { cwd: root, env }));
  assert.throws(
    () => assertSmokeSandboxDown(anchor, ["down"], { cwd: join(base, "foreign"), env }),
    /observed root.*foreign.*expected root.*root/,
  );
  assert.throws(
    () => assertSmokeSandboxDown(undefined, ["down"], { cwd: root, env }),
    /expected root "<missing anchor>"/,
  );
  assert.throws(
    () => assertSmokeSandboxDown(anchor, ["down"], { cwd: root }),
    /COTAL_HOME "<missing>".*XDG_CONFIG_HOME "<missing>"/,
  );
  assert.throws(
    () => assertSmokeSandboxDown(anchor, ["down"], { cwd: root, env: process.env }),
    /COTAL_HOME .* expected .*XDG_CONFIG_HOME .* expected/,
  );

  const alias = join(base, "root-alias");
  symlinkSync(root, alias, "dir");
  assert.doesNotThrow(() => assertSmokeSandboxDown(anchor, ["down"], { cwd: alias, env }));
  assert.doesNotThrow(() => assertSmokeSandboxDown(anchor, ["down"], { cwd: root + sep, env }));
  assert.doesNotThrow(() => assertSmokeSandboxDown(anchor, ["status"], { cwd: join(base, "foreign") }));

  const space = "target";
  const meshes = join(cotalHome, "meshes");
  const meshFile = join(meshes, `space.${Buffer.from(space).toString("hex")}.json`);
  mkdirSync(meshes, { recursive: true });
  writeFileSync(meshFile, JSON.stringify({ space, root }));
  assert.doesNotThrow(() =>
    assertSmokeSandboxTargetDown(anchor, ["down", "web", "--space", space], { cwd: root, env }, space));
  writeFileSync(meshFile, JSON.stringify({ space, root: join(base, "foreign") }));
  assert.throws(
    () => assertSmokeSandboxTargetDown(anchor, ["down", "web", "--space", space], { cwd: root, env }, space),
    /target-addressed cotal down: observed root.*foreign.*expected root.*root/,
  );
  assert.throws(
    () => assertSmokeSandboxTargetDown(anchor, ["down", "web"], { cwd: root, env }, space),
    /must name --space "target" explicitly/,
  );

  const repo = join(import.meta.dirname, "..", "..", "..");
  const semanticDownOnly = new Set([
    "implementations/runtime/smoke/mesh-wait.smoke.ts",
    "packages/lang/smoke/engine.smoke.ts",
  ]);
  const files: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === "node_modules" || entry.name === ".git") continue;
      const path = join(dir, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (entry.name.endsWith(".smoke.ts")) files.push(path);
    }
  };
  walk(repo);
  const unguarded: string[] = [];
  for (const file of files) {
    const relative = file.slice(repo.length + 1);
    const source = readFileSync(file, "utf8");
    if (!source.includes('"down"') && !source.includes("'down'")) continue;
    if (semanticDownOnly.has(relative)) continue;
    const guardCalls = [...source.matchAll(/assertSmokeSandboxDown\s*\(/g)];
    if (guardCalls.length < 1) unguarded.push(`${relative}: no shared guard call`);
    for (const match of source.matchAll(/^(.*(?:spawnSync|spawn)\(.*["']down["'].*)$/gm)) {
      const before = source.slice(0, match.index).split("\n").slice(-5).join("\n");
      if (!before.includes("assertSmokeSandboxDown"))
        unguarded.push(`${relative}:${source.slice(0, match.index).split("\n").length}: raw down spawn is not immediately guarded`);
    }
  }
  assert.deepEqual(unguarded, [], `unguarded smoke cotal down call sites:\n${unguarded.join("\n")}`);

  console.log("sandbox guard smoke: PASS");
} finally {
  rmSync(base, { recursive: true, force: true });
}
