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
  permits(
    "explicit destructive down retains the same exact sandbox identity guard",
    () => assertSmokeSandboxDown(anchor, ["down", "--with-agents"], { cwd: root, env }),
  );
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
  refuses(
    "explicit destructive down still refuses a foreign sandbox root",
    () => assertSmokeSandboxDown(anchor, ["down", "--with-agents"], { cwd: foreign, env }),
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
    "implementations/runtime/smoke/mesh-monitor.smoke.ts",
    "packages/lang/smoke/engine.smoke.ts",
  ]);

  /** Keep line numbers. Drop comments and templates so `down` inside a string is not a CLI verb. */
  const codeOf = (source: string): string => {
    let out = "";
    let i = 0;
    const blank = (from: number, to: number): void => {
      for (let j = from; j < to; j++) out += source[j] === "\n" ? "\n" : " ";
    };
    while (i < source.length) {
      const c = source[i];
      const n = source[i + 1];
      if (c === "/" && n === "/") {
        const start = i;
        i += 2;
        while (i < source.length && source[i] !== "\n") i++;
        blank(start, i);
        continue;
      }
      if (c === "/" && n === "*") {
        const start = i;
        i += 2;
        while (i < source.length && !(source[i] === "*" && source[i + 1] === "/")) i++;
        i = Math.min(source.length, i + 2);
        blank(start, i);
        continue;
      }
      if (c === "`") {
        const start = i;
        i++;
        while (i < source.length) {
          if (source[i] === "\\") { i += 2; continue; }
          if (source[i] === "`") { i++; break; }
          i++;
        }
        blank(start, i);
        continue;
      }
      if (c === '"' || c === "'") {
        out += c;
        i++;
        while (i < source.length) {
          if (source[i] === "\\") { out += source[i] + (source[i + 1] ?? ""); i += 2; continue; }
          out += source[i];
          if (source[i] === c) { i++; break; }
          i++;
        }
        continue;
      }
      out += c;
      i++;
    }
    return out;
  };

  const lineOf = (source: string, index: number): number => source.slice(0, index).split("\n").length;
  const windowBefore = (source: string, index: number): string =>
    source.slice(0, index).split("\n").slice(-5).join("\n");

  const extractFunctions = (source: string): Map<string, string> => {
    const fns = new Map<string, string>();
    const header =
      /(?:function\s+([A-Za-z_][\w]*)\s*\(|const\s+([A-Za-z_][\w]*)\s*=\s*(?:async\s*)?(?:\(|[A-Za-z_][\w]*\s*=>))/g;
    let match: RegExpExecArray | null;
    while ((match = header.exec(source))) {
      const name = match[1] ?? match[2];
      if (!name) continue;
      let i = match.index + match[0].length;
      const fromArrow = match[0].endsWith("=>");
      if (!fromArrow) {
        let depth = 1;
        while (i < source.length && depth > 0) {
          if (source[i] === "(") depth++;
          else if (source[i] === ")") depth--;
          i++;
        }
        while (i < source.length && /\s/.test(source[i])) i++;
        if (source[i] === ":") {
          i++;
          let paren = 0;
          let brace = 0;
          let angle = 0;
          while (i < source.length) {
            const ch = source[i];
            if (ch === "=" && source[i + 1] === ">" && paren === 0 && brace === 0 && angle === 0) break;
            if (ch === "{" && paren === 0 && brace === 0 && angle === 0) break;
            if (ch === "(") paren++;
            else if (ch === ")") paren--;
            else if (ch === "{") brace++;
            else if (ch === "}") brace--;
            else if (ch === "<") angle++;
            else if (ch === ">") angle--;
            i++;
          }
        }
        while (i < source.length && source[i] !== "{" && !(source[i] === "=" && source[i + 1] === ">")) i++;
        if (source[i] === "=" && source[i + 1] === ">") {
          i += 2;
          while (i < source.length && /\s/.test(source[i])) i++;
        }
      } else {
        while (i < source.length && /\s/.test(source[i])) i++;
      }
      if (source[i] === "{") {
        let depth = 1;
        const start = i;
        i++;
        while (i < source.length && depth > 0) {
          if (source[i] === "{") depth++;
          else if (source[i] === "}") depth--;
          i++;
        }
        fns.set(name, source.slice(start, i));
      } else {
        const start = i;
        while (i < source.length && source[i] !== ";" && source[i] !== "\n") i++;
        fns.set(name, source.slice(start, i));
      }
    }
    return fns;
  };

  const spawnsImmediatelyGuarded = (body: string): boolean => {
    const spawns = [...body.matchAll(/\b(?:spawnSync|spawn)\s*\(/g)];
    if (spawns.length === 0) return false;
    return spawns.every((spawn) => windowBefore(body, spawn.index ?? 0).includes("assertSmokeSandboxDown"));
  };

  const wrapperReachesSpawn = (name: string, fns: Map<string, string>, seen = new Set<string>()): boolean => {
    if (name === "spawn" || name === "spawnSync") return true;
    if (seen.has(name)) return false;
    seen.add(name);
    const body = fns.get(name);
    if (!body) return false;
    if (/\b(?:spawnSync|spawn)\s*\(/.test(body)) return true;
    for (const callee of body.matchAll(/\b([A-Za-z_][\w]*)\s*\(/g)) {
      if (callee[1] && wrapperReachesSpawn(callee[1], fns, seen)) return true;
    }
    return false;
  };

  const wrapperGuardsDown = (name: string, fns: Map<string, string>, seen = new Set<string>()): boolean => {
    if (name === "assertSmokeSandboxDown" || name === "assertSmokeSandboxTargetDown") return true;
    if (seen.has(name)) return false;
    seen.add(name);
    const body = fns.get(name);
    if (!body) return false;
    if (/\b(?:spawnSync|spawn)\s*\(/.test(body)) return spawnsImmediatelyGuarded(body);
    for (const callee of body.matchAll(/\b([A-Za-z_][\w]*)\s*\(/g)) {
      const next = callee[1];
      if (next && wrapperGuardsDown(next, fns, seen)) return true;
    }
    return false;
  };

  const callNameAt = (source: string, downIndex: number): { name: string; callStart: number } | undefined => {
    let i = downIndex;
    let paren = 0;
    let bracket = 0;
    let brace = 0;
    while (i > 0) {
      i--;
      const ch = source[i];
      if (ch === ")") paren++;
      else if (ch === "]") bracket++;
      else if (ch === "}") brace++;
      else if (ch === "(") {
        if (paren === 0 && bracket === 0 && brace === 0) {
          const before = source.slice(0, i).match(/([A-Za-z_][\w]*)\s*$/);
          if (!before || before.index === undefined) return undefined;
          return { name: before[1]!, callStart: before.index };
        }
        paren--;
      } else if (ch === "[") {
        if (bracket > 0) bracket--;
      } else if (ch === "{") {
        if (brace === 0) return undefined;
        brace--;
      }
    }
    return undefined;
  };

  type DownSite = { name: string; callStart: number; index: number };
  const unclassifiedDown = (relative: string, code: string, index: number): string =>
    `${relative}:${lineOf(code, index)}: unclassified down site, cannot prove a guard`;

  /**
   * Issue 1282 shape 1: a down literal bound to an identifier makes every argument-position
   * use of that identifier a down site, under the same call resolution and guard rules.
   * Only single-assignment string constants resolve; a name assigned twice or bound from an
   * expression is reported as unclassified when the file cannot prove a guard either.
   */
  const downVerbSites = (
    code: string,
    relative: string,
    fns: Map<string, string>,
    guardCalls: number,
    findings: string[],
  ): DownSite[] => {
    const sites: DownSite[] = [];
    for (const decl of code.matchAll(/\b(?:const|let|var)\s+([A-Za-z_][\w]*)\s*=\s*([^;\n]*)/g)) {
      const name = decl[1]!;
      const init = (decl[2] ?? "").trim();
      const exact = init === "\"down\"" || init === "'down'";
      const mentionsDown = /["']down["']/.test(init.replace(/(?<=[\[,(]\s*)["']down["']/g, ""));
      if (!exact && !mentionsDown) continue;
      if (decl.index === undefined) continue;
      const decls = [...code.matchAll(new RegExp(`\\b(?:const|let|var)\\s+${name}\\s*=`, "g"))].length;
      const assigns = [...code.matchAll(new RegExp(`\\b${name}\\s*=(?![=>])`, "g"))].length;
      if (!exact || decls !== 1 || assigns !== 1) {
        if (guardCalls < 1) findings.push(unclassifiedDown(relative, code, decl.index));
        continue;
      }
      for (const use of code.matchAll(new RegExp(`(?<=[\\[,(]\\s*)${name}\\b`, "g"))) {
        if (use.index === undefined) continue;
        const call = callNameAt(code, use.index);
        if (!call) {
          if (guardCalls < 1) findings.push(unclassifiedDown(relative, code, use.index));
          continue;
        }
        if (call.name === "assertSmokeSandboxDown" || call.name === "assertSmokeSandboxTargetDown") continue;
        sites.push({ ...call, index: use.index });
      }
    }
    return sites;
  };

  /**
   * Issue 1282: the walk root is a parameter so a scratch probe tree is scanned exactly like
   * the repo. A matched site the backwards walk cannot classify is reported unless the file
   * itself proves a shared guard call; it is never silently dropped.
   */
  const scanDownSites = (scanRoot: string): string[] => {
    const files: string[] = [];
    const walk = (dir: string): void => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        if (entry.name === "node_modules" || entry.name === ".git") continue;
        const path = join(dir, entry.name);
        if (entry.isDirectory()) walk(path);
        else if (entry.name.endsWith(".smoke.ts")) files.push(path);
      }
    };
    walk(scanRoot);
    const findings: string[] = [];
    const downArg = /(?<=[\[,(]\s*)["']down["']/g;
    for (const file of files) {
      const relative = file.slice(scanRoot.length + 1);
      const source = readFileSync(file, "utf8");
      const code = codeOf(source);
      if (semanticDownOnly.has(relative)) continue;
      const guardCalls = [...source.matchAll(/assertSmokeSandboxDown\s*\(/g)].length;
      const fns = extractFunctions(code);
      const cliSites = [...code.matchAll(downArg)].flatMap((site): DownSite[] => {
        if (site.index === undefined) return [];
        const call = callNameAt(code, site.index);
        if (!call) {
          if (guardCalls < 1) findings.push(unclassifiedDown(relative, code, site.index));
          return [];
        }
        if (call.name === "assertSmokeSandboxDown" || call.name === "assertSmokeSandboxTargetDown") return [];
        return [{ ...call, index: site.index }];
      });
      const verbSites = downVerbSites(code, relative, fns, guardCalls, findings);
      const downSites = [...cliSites, ...verbSites];
      if (downSites.length === 0) continue;
      if (guardCalls < 1) findings.push(`${relative}: no shared guard call`);
      for (const site of downSites) {
        const line = lineOf(code, site.index);
        if (site.name === "spawn" || site.name === "spawnSync") {
          if (!windowBefore(code, site.callStart).includes("assertSmokeSandboxDown"))
            findings.push(`${relative}:${line}: raw down spawn is not immediately guarded`);
          continue;
        }
        if (wrapperReachesSpawn(site.name, fns) && !wrapperGuardsDown(site.name, fns))
          findings.push(`${relative}:${line}: down wrapper call is not immediately guarded`);
      }
    }
    return findings;
  };

  const shape1Root = join(base, "scan-shape1");
  mkdirSync(shape1Root, { recursive: true });
  writeFileSync(
    join(shape1Root, "probe.smoke.ts"),
    `import { spawnSync } from "node:child_process";
function runCli(args: string[]): void {
  spawnSync("cotal", args, { encoding: "utf8" });
}
const verb = "down";
runCli([verb]);
`,
  );
  assert.deepEqual(
    scanDownSites(shape1Root),
    ["probe.smoke.ts: no shared guard call", "probe.smoke.ts:6: down wrapper call is not immediately guarded"],
    "shape 1 verb constant must be scanned as a down site",
  );

  const shape2Root = join(base, "scan-shape2");
  mkdirSync(shape2Root, { recursive: true });
  writeFileSync(
    join(shape2Root, "probe.smoke.ts"),
    `import { spawnSync } from "node:child_process";
function runCli(args: string[]): void {
  spawnSync("cotal", args, { encoding: "utf8" });
}
const args = ["down"];
runCli(args);
`,
  );
  assert.deepEqual(
    scanDownSites(shape2Root),
    ["probe.smoke.ts:5: unclassified down site, cannot prove a guard"],
    "shape 2 bound argv must be reported as unclassified",
  );

  const unguarded = scanDownSites(repo);
  assert.deepEqual(unguarded, [], `unguarded smoke cotal down call sites:\n${unguarded.join("\n")}`);
  assert.deepEqual(failures, [], `sandbox guard failed named cells:\n${failures.join("\n")}`);

  console.log("sandbox guard smoke: PASS");
} finally {
  rmSync(base, { recursive: true, force: true });
}
