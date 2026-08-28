import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";
import { assertSmokeSandboxDown, assertSmokeSandboxTargetDown, recordSmokeSandbox } from "@cotal-ai/smoke-kit";

const base = mkdtempSync(join(tmpdir(), "cotal-sandbox-guard-"));
const repo = join(import.meta.dirname, "..", "..", "..");
const root = join(base, "root");
const cotalHome = join(base, "home");
const xdgConfigHome = join(base, "config");
const anchor = recordSmokeSandbox({ root, cotalHome, xdgConfigHome });
const env = { COTAL_HOME: cotalHome, XDG_CONFIG_HOME: xdgConfigHome };
const failures: string[] = [];

function refuses(name: string, run: () => void, expected: RegExp): void {
  try {
    assert.throws(run, expected);
    console.log(`✓ ${name}`);
  } catch (error) {
    failures.push(name);
    console.error(`✗ ${name}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function permits(name: string, run: () => void): void {
  try {
    assert.doesNotThrow(run);
    console.log(`✓ ${name}`);
  } catch (error) {
    failures.push(name);
    console.error(`✗ ${name}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

try {
  assert.doesNotThrow(() => assertSmokeSandboxDown(anchor, ["down"], { cwd: root, env }));
  const foreign = join(base, "operator-checkout");
  const foreignHome = join(base, "operator-home");
  const foreignConfig = join(base, "operator-config");
  mkdirSync(join(foreign, ".cotal"), { recursive: true });
  mkdirSync(foreignHome, { recursive: true });
  mkdirSync(foreignConfig, { recursive: true });
  refuses(
    "foreign sandbox root is refused by identity",
    () => assertSmokeSandboxDown(anchor, ["down"], { cwd: foreign, env }),
    /observed root.*operator-checkout.*expected root.*root.*identity verdicts root=foreign/,
  );
  assert.throws(
    () => assertSmokeSandboxDown(anchor, ["down"], { cwd: root, env: { ...env, COTAL_HOME: foreignHome } }),
    /COTAL_HOME.*operator-home.*identity verdicts root=same, COTAL_HOME=foreign/,
  );
  assert.throws(
    () => assertSmokeSandboxDown(anchor, ["down"], { cwd: root, env: { ...env, XDG_CONFIG_HOME: foreignConfig } }),
    /XDG_CONFIG_HOME.*operator-config.*identity verdicts root=same, COTAL_HOME=same, XDG_CONFIG_HOME=foreign/,
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
  const marker = join(root, ".cotal");
  const recordedMarker = join(root, ".cotal-recorded");
  renameSync(marker, recordedMarker);
  refuses(
    "missing sandbox ownership marker is refused by identity",
    () => assertSmokeSandboxDown(anchor, ["down"], { cwd: root, env }),
    /identity verdicts root=same, COTAL_HOME=same, XDG_CONFIG_HOME=same, marker=missing/,
  );
  mkdirSync(marker);
  refuses(
    "replaced sandbox ownership marker is refused as foreign",
    () => assertSmokeSandboxDown(anchor, ["down"], { cwd: root, env }),
    /identity verdicts root=same, COTAL_HOME=same, XDG_CONFIG_HOME=same, marker=foreign/,
  );
  rmSync(marker, { recursive: true });
  renameSync(recordedMarker, marker);

  const alias = join(base, "root-alias");
  symlinkSync(root, alias, "dir");
  assert.doesNotThrow(() => assertSmokeSandboxDown(anchor, ["down"], { cwd: alias, env }));
  assert.doesNotThrow(() => assertSmokeSandboxDown(anchor, ["down"], { cwd: root + sep, env }));
  // Scoped to issue 884's destructive `down` verb only. This is not a general blessing of foreign cwd.
  assert.doesNotThrow(() => assertSmokeSandboxDown(anchor, ["status"], { cwd: foreign }));

  const space = "target";
  const meshes = join(cotalHome, "meshes");
  const meshFile = join(meshes, `space.${Buffer.from(space).toString("hex")}.json`);
  mkdirSync(meshes, { recursive: true });
  writeFileSync(meshFile, JSON.stringify({ space, root }));
  assert.doesNotThrow(() =>
    assertSmokeSandboxTargetDown(anchor, ["down", "web", "--space", space], { cwd: root, env }));
  permits(
    "target guard resolves a flag before the target",
    () => assertSmokeSandboxTargetDown(anchor, ["down", "--space", space, "web"], { cwd: root, env }),
  );
  permits(
    "target guard resolves equals-form space",
    () => assertSmokeSandboxTargetDown(anchor, ["down", "web", `--space=${space}`], { cwd: root, env }),
  );
  const operatorSpace = "operator";
  const operatorMeshFile = join(meshes, `space.${Buffer.from(operatorSpace).toString("hex")}.json`);
  writeFileSync(meshFile, JSON.stringify({ space, root: foreign }));
  writeFileSync(operatorMeshFile, JSON.stringify({ space: operatorSpace, root }));
  permits(
    "target guard uses the CLI parser's last space value",
    () => assertSmokeSandboxTargetDown(
      anchor,
      ["down", "web", "--space", space, "--space", operatorSpace],
      { cwd: root, env },
    ),
  );
  writeFileSync(meshFile, JSON.stringify({ space, root: foreign }));
  assert.throws(
    () => assertSmokeSandboxTargetDown(anchor, ["down", "web", "--space", space], { cwd: root, env }),
    /target-addressed cotal down: observed root.*operator-checkout.*expected root.*root/,
  );
  writeFileSync(meshFile, JSON.stringify({ space: "other", root }));
  writeFileSync(join(meshes, "legacy-target.json"), JSON.stringify({ space, root: foreign }));
  refuses(
    "target guard refuses a canonical record whose space field is not the requested space",
    () => assertSmokeSandboxTargetDown(anchor, ["down", "web", "--space", space], { cwd: root, env }),
    /target-addressed cotal down: observed space.*other.*expected space.*target/,
  );
  writeFileSync(meshFile, JSON.stringify({ space, root }));
  rmSync(join(meshes, "legacy-target.json"), { force: true });
  assert.throws(
    () => assertSmokeSandboxTargetDown(anchor, ["down", "web"], { cwd: root, env }),
    /must name a non-empty --space explicitly/,
  );
  const emptySpaceMeshFile = join(meshes, "space..json");
  writeFileSync(emptySpaceMeshFile, JSON.stringify({ space: "", root }));
  refuses(
    "target guard refuses a separate empty --space value",
    () => assertSmokeSandboxTargetDown(anchor, ["down", "web", "--space", ""], { cwd: root, env }),
    /must name a non-empty --space explicitly/,
  );
  refuses(
    "target guard refuses a repeated flag whose last space value is empty",
    () => assertSmokeSandboxTargetDown(anchor, ["down", "web", "--space=operator", "--space="], { cwd: root, env }),
    /must name a non-empty --space explicitly/,
  );
  const emptySpaceCells = [
    "target guard refuses a separate empty --space value",
    "target guard refuses a repeated flag whose last space value is empty",
  ];
  const emptySpaceFailures = emptySpaceCells.filter((name) => failures.includes(name));
  if (emptySpaceFailures.length === 0)
    console.log("✓ target guard refuses both empty-space argv forms");
  else {
    failures.push("target guard refuses both empty-space argv forms");
    console.error(`✗ target guard refuses both empty-space argv forms: ${emptySpaceFailures.join(", ")}`);
  }
  assert.throws(
    () => assertSmokeSandboxDown(anchor, ["down", "web"], { cwd: root, env }),
    /requires assertSmokeSandboxTargetDown/,
    "bare down web still requires the target guard",
  );
  assert.throws(
    () => assertSmokeSandboxDown(anchor, ["down", "--space", space, "web"], { cwd: root, env }),
    /requires assertSmokeSandboxTargetDown/,
    "generic guard refuses flag-before-target down web",
  );
  assert.throws(
    () => assertSmokeSandboxDown(anchor, ["down", "--unrecognized", "web"], { cwd: root, env }),
    /cannot classify arguments.*strict down parser/,
    "generic guard fails closed when down arguments cannot be classified",
  );

  const rootPackage = JSON.parse(readFileSync(join(repo, "package.json"), "utf8")) as {
    scripts?: { check?: string };
  };
  const checkSteps = (rootPackage.scripts?.check ?? "").split("&&").map((step) => step.trim());
  const guardStep = checkSteps.indexOf("pnpm smoke:sandbox-guard");
  const firstLiveStep = checkSteps.findIndex((step) => /pnpm smoke:[^ ]*(?::live|-live)(?:\s|$)/.test(step));
  assert.notEqual(guardStep, -1, "check reaches smoke:sandbox-guard");
  assert.ok(
    firstLiveStep === -1 || guardStep < firstLiveStep,
    "check reaches smoke:sandbox-guard before its first environment-dependent live suite",
  );

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
  assert.deepEqual(failures, [], `sandbox guard failed named cells:\n${failures.join("\n")}`);

  console.log("sandbox guard smoke: PASS");
} finally {
  rmSync(base, { recursive: true, force: true });
}
