/**
 * A read installs nothing. Each read runs through the built binary in a fresh sandbox with the seed
 * gate live (no `COTAL_SKIP_CONNECTOR_SEED`). From a source checkout the gate refuses to seed, so a
 * read that still reached it would exit 1 with that refusal; a read must run past it and leave the
 * seed store and the extension manifest unwritten. A command that is not a read still meets the
 * gate. A read that would load a built-in installed at another version than the binary's names it
 * with `cotal ext seed` instead of importing it.
 *
 * Run: pnpm smoke:read-no-seed
 */
import { spawn, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { createSuite } from "@cotal-ai/smoke-kit";

const BIN = join(import.meta.dirname, "..", "..", "..", "bin", "dist", "cotal.js");
if (!existsSync(BIN)) {
  console.error(`✗ ${BIN} missing - build first: pnpm --filter cotal-ai... build`);
  process.exit(1);
}
const VERSION = (JSON.parse(readFileSync(join(import.meta.dirname, "..", "..", "..", "bin", "package.json"), "utf8")) as { version: string }).version;
const { check, finish } = createSuite();
const HOST_ENV = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith("COTAL_") && k !== "FORCE_COLOR" && k !== "NO_COLOR"));
const roots: string[] = [];
process.on("exit", () => {
  for (const dir of roots) rmSync(dir, { recursive: true, force: true });
});

/** A fresh home whose own `.cotal` stops the root walk, so no project above the temp dir is read. */
function sandbox() {
  const home = mkdtempSync(join(tmpdir(), "cotal-read-no-seed-"));
  roots.push(home);
  mkdirSync(join(home, ".cotal"));
  const xdg = join(home, ".config");
  const run = (args: string[], extraEnv: Record<string, string> = {}) => {
    const r = spawnSync(process.execPath, [BIN, ...args], {
      cwd: home,
      env: { ...HOST_ENV, HOME: home, USERPROFILE: home, XDG_CONFIG_HOME: xdg, COTAL_HOME: join(home, ".cotal"), ...extraEnv },
      encoding: "utf8",
      timeout: 120_000,
    });
    return { status: r.status, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
  };
  return { home, xdg, run };
}
const shown = (r: { status: number | null; stdout: string; stderr: string }) => ({ status: r.status, stdout: r.stdout.slice(0, 400), stderr: r.stderr.slice(0, 600) });
const GATE = /refusing to reconcile the operator-global seed store/;

// ── Reads run past the seed gate and write nothing ──────────────────────────────────────────────────
{
  const { xdg, run } = sandbox();
  const reads: { args: string[]; exit: number }[] = [
    { args: ["status", "--json"], exit: 0 },
    { args: ["ext", "--json"], exit: 0 },
    { args: ["ext", "list", "--json"], exit: 0 },
    { args: ["ext", "root"], exit: 0 },
    { args: ["runtimes", "--json"], exit: 0 },
    { args: ["docs", "--json"], exit: 0 },
    { args: ["config", "--json"], exit: 0 },
    { args: ["space", "--json"], exit: 0 },
    { args: ["ps", "--json"], exit: 2 },
    { args: ["models", "--json"], exit: 2 },
    { args: ["who", "--json"], exit: 2 },
  ];
  for (const { args, exit } of reads) {
    const r = run(args);
    check(`${args.filter((a) => a !== "--json").join(" ")} is a read: it runs past the seed gate, exit ${exit}`, r.status === exit && !GATE.test(r.stderr) && !/✓ added/.test(r.stderr), shown(r));
  }
  check("the reads wrote no seed store and no extension manifest",
    !existsSync(join(xdg, "cotal", "seed")) && !existsSync(join(xdg, "cotal", "extensions", "extensions.json")),
    { seed: existsSync(join(xdg, "cotal", "seed")), manifest: existsSync(join(xdg, "cotal", "extensions", "extensions.json")) });
  const human = run(["status"], { NO_COLOR: "1" });
  check("status on a fresh machine says no agent application is set up and points at cotal setup",
    human.status === 0 && /^ +Agent applications: +○ not set up · `cotal setup` adds one$/m.test(human.stdout) && /^Next\n +cotal setup +Set up an agent application/m.test(human.stdout), shown(human));
}

// ── A command that is not a read still meets the gate ───────────────────────────────────────────────
{
  const { run } = sandbox();
  for (const args of [["space", "forget", "nope"], ["ext", "add", "@acme/none"]]) {
    const r = run(args);
    check(`${args.join(" ")} is not a read: the seed gate runs first and refuses from a source checkout`, r.status === 1 && GATE.test(r.stderr), shown(r));
  }
}

// ── A read never loads a built-in installed at another version ──────────────────────────────────────
{
  const { home, xdg, run } = sandbox();
  const pkg = "@cotal-ai/connector-claude-code";
  const pkgDir = join(xdg, "cotal", "extensions", "node_modules", "@cotal-ai", "connector-claude-code");
  mkdirSync(pkgDir, { recursive: true });
  const marker = join(home, "imported");
  writeFileSync(join(pkgDir, "package.json"), JSON.stringify({ name: pkg, version: "0.0.1", type: "module", main: "index.js" }));
  writeFileSync(join(pkgDir, "index.js"), `import { writeFileSync } from "node:fs";\nwriteFileSync(${JSON.stringify(marker)}, "imported");\n`);
  writeFileSync(join(xdg, "cotal", "extensions", "extensions.json"), JSON.stringify({
    extensions: [{
      pkg, version: "0.0.1", spec: `${pkg}@0.0.1`, source: "seeded",
      provides: [{ kind: "connector", name: "claude" }, { kind: "connector-setup", name: "claude" }], commands: [],
      connectors: [{ name: "claude", requires: [], setup: { kind: "connector-setup", name: "claude" } }],
    }],
  }));
  const r = run(["status", "--json"]);
  let rows: { name: string; state: string; text: string }[] = [];
  try {
    rows = (JSON.parse(r.stdout) as { result: { machine: { integrations: typeof rows } } }).result.machine.integrations;
  } catch {
    rows = [];
  }
  const row = rows.find((i) => i.name === "claude setup");
  check("status names the older built-in and the command that brings it to this version",
    row?.state === "error" && row.text === `${pkg} is 0.0.1 and this cotal is ${VERSION} - run \`cotal ext seed\` to bring it to this version`, { status: r.status, rows });
  check("and never imported it", !existsSync(marker));
}

// A real ext add must preserve the declaration the lazy command's seed decision reads.
{
  const { home, xdg, run } = sandbox();
  const fixture = join(home, "read-extension");
  mkdirSync(fixture);
  writeFileSync(join(fixture, "package.json"), JSON.stringify({
    name: "read-cache-fixture", version: "1.0.0", type: "module", main: "index.js",
    peerDependencies: { "@cotal-ai/core": "*" },
  }));
  const core = pathToFileURL(join(import.meta.dirname, "..", "..", "..", "packages", "core", "dist", "index.js")).href;
  writeFileSync(join(fixture, "index.js"), `import { registry } from ${JSON.stringify(core)};
registry.register({ kind: "command", name: "inspect-read-cache", summary: "owned read fixture", reads: true,
  positionals: "[list | write]", subcommands: [{ name: "list", summary: "read list", reads: true }, { name: "write", summary: "non-read control" }],
  run: async () => console.log("fixture-read-ran") });
`);
  const added = run(["ext", "add", fixture], { COTAL_SKIP_CONNECTOR_SEED: "1" });
  check("control: real ext add caches the owned read extension", added.status === 0 && existsSync(join(xdg, "cotal", "extensions", "extensions.json")), shown(added));
  const bare = run(["inspect-read-cache"]);
  check("an installed bare read runs past the seed gate", bare.status === 0 && bare.stdout.trim() === "fixture-read-ran" && !GATE.test(bare.stderr), shown(bare));
  const sub = run(["inspect-read-cache", "list"]);
  check("an installed read subcommand runs past the seed gate", sub.status === 0 && sub.stdout.trim() === "fixture-read-ran" && !GATE.test(sub.stderr), shown(sub));
  const write = run(["inspect-read-cache", "write"]);
  check("an installed non-read subcommand still meets the seed gate", write.status === 1 && GATE.test(write.stderr) && !write.stdout.includes("fixture-read-ran"), shown(write));

  const cotalCfg = join(xdg, "cotal");
  const extDir = join(cotalCfg, "extensions");
  const manifestPath = join(extDir, "extensions.json");
  const installedPkg = join(extDir, "node_modules", "read-cache-fixture", "package.json");
  const lockPath = join(cotalCfg, ".extensions.lock");
  const exitTrace = join(home, "exit-trace.mjs");
  writeFileSync(
    exitTrace,
    `import { appendFileSync, existsSync } from "node:fs";
const out = process.env.REPRO_TRACE;
const lock = ${JSON.stringify(lockPath)};
const locks = () => ({ lockPresent: existsSync(lock), passPresent: existsSync(lock + ".update"), npmChildPresent: existsSync(lock + ".npm-child") });
const realExit = process.exit.bind(process);
process.exit = function (code) {
  const stack = (new Error().stack ?? "").split("\\n").slice(2, 9).map((s) => s.trim());
  appendFileSync(out, JSON.stringify({ event: "process.exit", code, ...locks(), stack }) + "\\n");
  return realExit(code);
};
process.on("exit", (code) => appendFileSync(out, JSON.stringify({ event: "exit", code, ...locks() }) + "\\n"));
`,
  );
  const readTrace = (file: string) =>
    existsSync(file)
      ? readFileSync(file, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l) as { event: string; code: number; lockPresent: boolean; passPresent: boolean; npmChildPresent: boolean; stack?: string[] })
      : [];

  // Pre-commit validation failure control: no process.exit from commands/ext, lock released.
  const badFixture = join(home, "bad-extension");
  mkdirSync(badFixture);
  writeFileSync(join(badFixture, "package.json"), JSON.stringify({ name: "bad-cache-fixture", version: "1.0.0", type: "module", main: "index.js" }));
  writeFileSync(join(badFixture, "index.js"), "export {};\n");
  const badTraceFile = join(home, "bad.trace.jsonl");
  const badAdd = spawnSync(process.execPath, ["--import", exitTrace, BIN, "ext", "add", badFixture], {
    cwd: home,
    env: { ...HOST_ENV, HOME: home, USERPROFILE: home, XDG_CONFIG_HOME: xdg, COTAL_HOME: join(home, ".cotal"), COTAL_SKIP_CONNECTOR_SEED: "1", REPRO_TRACE: badTraceFile },
    encoding: "utf8",
    timeout: 120_000,
  });
  const badEvents = readTrace(badTraceFile);
  const badFromExt = badEvents.filter((e) => e.event === "process.exit" && (e.stack ?? []).some((f) => /commands[\/\\]ext\.[jt]s/.test(f)));
  const badExit = badEvents.find((e) => e.event === "exit");
  check(
    "control: pre-commit validation failure rolls back and throws to runCli without calling process.exit in commands/ext",
    badAdd.status === 1
      && /bad-cache-fixture does not declare @cotal-ai\/core as a peerDependency/.test(badAdd.stderr ?? "")
      && badFromExt.length === 0
      && badExit?.lockPresent === false
      && !existsSync(join(extDir, "node_modules", "bad-cache-fixture")),
    { status: badAdd.status, stderr: badAdd.stderr, badEvents },
  );

  // #3904 failing case: SIGTERM during same-name update rolls back to 1.0.0, releases the lock in
  // addExtension's finally, and exits 130 without calling process.exit in commands/ext.
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
  const fixtureV2 = join(home, "read-extension-v2");
  mkdirSync(fixtureV2);
  writeFileSync(
    join(fixtureV2, "package.json"),
    JSON.stringify({
      name: "read-cache-fixture",
      version: "2.0.0",
      type: "module",
      main: "index.js",
      peerDependencies: { "@cotal-ai/core": "*" },
      scripts: { postinstall: 'node -e "setTimeout(() => {}, 2000)"' },
    }),
  );
  writeFileSync(join(fixtureV2, "index.js"), readFileSync(join(fixture, "index.js"), "utf8"));
  const sigtermTraceFile = join(home, "sigterm.trace.jsonl");
  let sigtermOut = "";
  let sigtermErr = "";
  const sigtermChild = spawn(process.execPath, ["--import", exitTrace, BIN, "ext", "add", fixtureV2], {
    cwd: home,
    env: { ...HOST_ENV, HOME: home, USERPROFILE: home, XDG_CONFIG_HOME: xdg, COTAL_HOME: join(home, ".cotal"), COTAL_SKIP_CONNECTOR_SEED: "1", REPRO_TRACE: sigtermTraceFile },
  });
  sigtermChild.stdout.on("data", (d) => (sigtermOut += d.toString()));
  sigtermChild.stderr.on("data", (d) => (sigtermErr += d.toString()));
  const sigtermDone = new Promise<number | null>((resolveClose) => sigtermChild.on("close", resolveClose));
  const sigtermDeadline = Date.now() + 15_000;
  while (!sigtermErr.includes("installing ") && Date.now() < sigtermDeadline) await sleep(20);
  sigtermChild.kill("SIGTERM");
  const sigtermStatus = await sigtermDone;
  const sigtermEvents = readTrace(sigtermTraceFile);
  const sigtermFromExt = sigtermEvents.filter((e) => e.event === "process.exit" && (e.stack ?? []).some((f) => /commands[\/\\]ext\.[jt]s/.test(f)));
  const sigtermExit = sigtermEvents.find((e) => e.event === "exit");
  check(
    "interrupted same-name ext add exits 130 after addExtension finally releases the lock without calling process.exit in commands/ext",
    sigtermStatus === 130
      && sigtermFromExt.length === 0
      && sigtermExit?.code === 130
      && sigtermExit.lockPresent === false
      && sigtermExit.passPresent === false
      && !sigtermOut.includes("✓ added read-cache-fixture@2.0.0"),
    { sigtermStatus, sigtermEvents, sigtermOut, sigtermErr },
  );
  const manifestAfterSigterm = JSON.parse(readFileSync(manifestPath, "utf8")) as { extensions: { pkg: string; version: string }[] };
  const installedAfterSigterm = (JSON.parse(readFileSync(installedPkg, "utf8")) as { version: string }).version;
  const leftoversAfterSigterm = readdirSync(cotalCfg).filter((n) => n.startsWith(".extensions.rollback-") || n.startsWith(".extensions.stage-") || n.startsWith(".extensions.lock"));
  check(
    "interrupted same-name ext add rolls back manifest and prefix to 1.0.0 and leaves no rollback dir or lock",
    manifestAfterSigterm.extensions.length === 1
      && manifestAfterSigterm.extensions[0]?.pkg === "read-cache-fixture"
      && manifestAfterSigterm.extensions[0]?.version === "1.0.0"
      && installedAfterSigterm === "1.0.0"
      && leftoversAfterSigterm.length === 0,
    { manifestAfterSigterm, installedAfterSigterm, leftoversAfterSigterm },
  );

  // Interrupted fresh staged add (SIGINT during npm install): cleans stageRoot and lock, exits 130.
  const freshInterrupted = join(home, "fresh-interrupted");
  mkdirSync(freshInterrupted);
  writeFileSync(
    join(freshInterrupted, "package.json"),
    JSON.stringify({
      name: "fresh-interrupted-fixture",
      version: "1.0.0",
      type: "module",
      main: "index.js",
      peerDependencies: { "@cotal-ai/core": "*" },
      scripts: { postinstall: 'node -e "setTimeout(() => {}, 2000)"' },
    }),
  );
  writeFileSync(join(freshInterrupted, "index.js"), `import { registry } from ${JSON.stringify(core)};\nregistry.register({ kind: "command", name: "fresh-interrupted-cmd", summary: "fresh", run: async () => {} });\n`);
  const sigintTraceFile = join(home, "sigint.trace.jsonl");
  let sigintOut = "";
  let sigintErr = "";
  const sigintChild = spawn(process.execPath, ["--import", exitTrace, BIN, "ext", "add", freshInterrupted], {
    cwd: home,
    env: { ...HOST_ENV, HOME: home, USERPROFILE: home, XDG_CONFIG_HOME: xdg, COTAL_HOME: join(home, ".cotal"), COTAL_SKIP_CONNECTOR_SEED: "1", REPRO_TRACE: sigintTraceFile },
  });
  sigintChild.stdout.on("data", (d) => (sigintOut += d.toString()));
  sigintChild.stderr.on("data", (d) => (sigintErr += d.toString()));
  const sigintDone = new Promise<number | null>((resolveClose) => sigintChild.on("close", resolveClose));
  const sigintDeadline = Date.now() + 15_000;
  while (!sigintErr.includes("installing ") && Date.now() < sigintDeadline) await sleep(20);
  sigintChild.kill("SIGINT");
  const sigintStatus = await sigintDone;
  const sigintEvents = readTrace(sigintTraceFile);
  const sigintFromExt = sigintEvents.filter((e) => e.event === "process.exit" && (e.stack ?? []).some((f) => /commands[\/\\]ext\.[jt]s/.test(f)));
  const sigintExit = sigintEvents.find((e) => e.event === "exit");
  const leftoversAfterSigint = readdirSync(cotalCfg).filter((n) => n.startsWith(".extensions.rollback-") || n.startsWith(".extensions.stage-") || n.startsWith(".extensions.lock"));
  check(
    "interrupted fresh staged ext add on SIGINT cleans stage dir and lock without calling process.exit in commands/ext",
    sigintStatus === 130
      && sigintFromExt.length === 0
      && sigintExit?.code === 130
      && sigintExit.lockPresent === false
      && !sigintOut.includes("✓ added fresh-interrupted-fixture@1.0.0")
      && !existsSync(join(extDir, "node_modules", "fresh-interrupted-fixture"))
      && leftoversAfterSigint.length === 0,
    { sigintStatus, sigintEvents, sigintOut, leftoversAfterSigint },
  );

  // Post-commit rollback snapshot removal failure: committed guard preserves 2.0.0 install and manifest.
  if (process.platform !== "win32") {
    const fixtureV2Commit = join(home, "read-extension-v2-commit");
    mkdirSync(fixtureV2Commit);
    writeFileSync(
      join(fixtureV2Commit, "package.json"),
      JSON.stringify({
        name: "read-cache-fixture",
        version: "2.0.0",
        type: "module",
        main: "index.js",
        peerDependencies: { "@cotal-ai/core": "*" },
        scripts: {
          postinstall: `node -e 'const fs = require("node:fs"); const path = require("node:path"); const cfg = ${JSON.stringify(cotalCfg)}; for (const d of fs.readdirSync(cfg).filter((n) => n.startsWith(".extensions.rollback-"))) fs.chmodSync(path.join(cfg, d, "extensions"), 0o555);'`,
        },
      }),
    );
    writeFileSync(join(fixtureV2Commit, "index.js"), readFileSync(join(fixture, "index.js"), "utf8"));
    const postCommit = run(["ext", "add", fixtureV2Commit], { COTAL_SKIP_CONNECTOR_SEED: "1" });
    const rollbackDirs = readdirSync(cotalCfg).filter((n) => n.startsWith(".extensions.rollback-"));
    const manifestAfterCommit = JSON.parse(readFileSync(manifestPath, "utf8")) as { extensions: { pkg: string; version: string }[] };
    const installedAfterCommit = (JSON.parse(readFileSync(installedPkg, "utf8")) as { version: string }).version;
    check(
      "post-commit rollback snapshot removal failure keeps the committed 2.0.0 install and manifest",
      postCommit.status === 1
        && /✓ added read-cache-fixture@2\.0\.0/.test(postCommit.stdout)
        && manifestAfterCommit.extensions[0]?.version === "2.0.0"
        && installedAfterCommit === "2.0.0"
        && rollbackDirs.length === 1,
      { postCommit: shown(postCommit), manifestAfterCommit, installedAfterCommit, rollbackDirs },
    );
    for (const d of rollbackDirs) {
      const ro = join(cotalCfg, d, "extensions");
      if (existsSync(ro)) chmodSync(ro, 0o755);
    }
  }
}

finish();
