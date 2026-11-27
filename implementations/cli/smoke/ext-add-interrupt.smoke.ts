/** `cotal ext add` over an installed extension, through the built CLI in a private prefix (#3904):
 *  an add interrupted while npm runs rolls back, exits 130 and never announces the version it
 *  rolled back; and an add whose rollback snapshot cannot be removed after it committed still
 *  reports the add. Never starts a connector or broker. Build the workspace first.
 *  Run: pnpm smoke:ext-add-interrupt
 */
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join, resolve } from "node:path";
import { emitSentinel } from "@cotal-ai/smoke-kit";
import { resolveOnPath } from "@cotal-ai/workspace";
import { writePluginFixture } from "../../../scripts/plugin-fixture.mjs";

const repo = resolve(import.meta.dirname, "../../..");
const binary = join(repo, "bin", "dist", "cotal.js");
const root = realpathSync(mkdtempSync(join(tmpdir(), "cotal-ext-interrupt-")));
const name = "cotal-ext-interrupt";
// A read-only directory does not stop root, and Windows does not refuse the removal the same way.
const readOnlyCell = process.platform !== "win32" && process.getuid?.() !== 0;
let passed = 0, failed = 0;
const check = (label: string, value: boolean, detail?: string): void => {
  if (value) passed++; else failed++;
  console.log(`  ${value ? "✓" : "✗"} ${label}${!value && detail ? `\n${detail}` : ""}`);
};
try {
  const home = join(root, "home"), xdg = join(root, "xdg");
  mkdirSync(join(root, ".cotal"), { recursive: true });
  mkdirSync(home, { mode: 0o700 });
  mkdirSync(xdg, { mode: 0o700 });
  for (const file of ["user.npmrc", "global.npmrc"]) writeFileSync(join(root, file), "");
  const held = join(root, "held"), release = join(root, "release");
  const env: NodeJS.ProcessEnv = {
    PATH: process.env.PATH, SystemRoot: process.env.SystemRoot,
    HOME: home, XDG_CONFIG_HOME: xdg, COTAL_HOME: join(home, ".cotal"),
    TMPDIR: root, TMP: root, TEMP: root, DO_NOT_TRACK: "1", COTAL_SKIP_CONNECTOR_SEED: "1",
    npm_config_cache: join(root, "npm-cache"), npm_config_userconfig: join(root, "user.npmrc"),
    npm_config_globalconfig: join(root, "global.npmrc"), npm_config_update_notifier: "false",
    EXT_INTERRUPT_HELD: held, EXT_INTERRUPT_RELEASE: release,
  };
  const realNpm = resolveOnPath("npm", process.env);
  assert.ok(realNpm, "real npm must be available before adding the test shim");
  const tools = join(root, "tools"), npmHold = join(root, "npm-hold.cjs");
  mkdirSync(tools);
  writeFileSync(npmHold, `const {existsSync,writeFileSync}=require('node:fs');
writeFileSync(process.env.EXT_INTERRUPT_HELD,'held');
const end=Date.now()+60000;
const wait=setInterval(()=>{if(existsSync(process.env.EXT_INTERRUPT_RELEASE)||Date.now()>=end)clearInterval(wait)},50);
`);
  const quote = (arg: string) => `'${arg.replaceAll("'", `'"'"'`)}'`;
  writeFileSync(join(tools, "npm"), `#!/bin/sh\n${quote(realNpm)} "$@" || exit $?\n[ "$1" != install ] || exec ${quote(process.execPath)} ${quote(npmHold)}\n`, { mode: 0o700 });
  writeFileSync(join(tools, "npm.cmd"), `@echo off\r\ncall "${realNpm}" %*\r\nif errorlevel 1 exit /b %errorlevel%\r\nif /i "%~1"=="install" "${process.execPath}" "${npmHold}"\r\n`);
  env.PATH = `${tools}${delimiter}${env.PATH ?? ""}`;
  const build = (version: string): string => {
    const dir = join(root, `ext-${version}`);
    const provider = { kind: "command", name: "interrupt-probe", summary: "fixture" };
    writePluginFixture(dir, { name, version, provides: [provider],
      factorySource: `export default host => host.register({ ...${JSON.stringify(provider)}, run: async () => {} });\n` });
    return dir;
  };
  const add = (dir: string) => spawnSync(process.execPath, [binary, "ext", "add", dir], { cwd: root, env, encoding: "utf8", timeout: 180_000 });
  const prefix = join(xdg, "cotal", "extensions");
  const recorded = (): string | undefined =>
    (JSON.parse(readFileSync(join(prefix, "extensions.json"), "utf8")) as { extensions: { pkg: string; version: string }[] }).extensions.find((e) => e.pkg === name)?.version;
  const installed = (): string => (JSON.parse(readFileSync(join(prefix, "node_modules", name, "package.json"), "utf8")) as { version: string }).version;

  writeFileSync(release, "");
  const first = add(build("1.0.0"));
  assert.equal(first.status, 0, `the first add failed: ${first.stderr.slice(-800)}`);
  check("1.0.0 is installed and recorded", recorded() === "1.0.0" && installed() === "1.0.0");

  // Interrupt the CLI before its npm subprocess exits. On Windows a parent kill is forceful,
  // so deliver the notification inside the CLI rather than asking the OS to terminate it.
  rmSync(release);
  rmSync(held);
  const v2 = build("2.0.0");
  const interrupt = join(root, "interrupt.cjs");
  writeFileSync(interrupt, `const {existsSync,writeFileSync}=require('node:fs');
const clock=setInterval(()=>{if(!existsSync(${JSON.stringify(held)}))return;clearInterval(clock);process.emit('SIGTERM');writeFileSync(${JSON.stringify(release)},'');},20);clock.unref();\n`);
  const nodeArgs = process.platform === "win32" ? ["--require", interrupt] : [];
  const child = spawn(process.execPath, [...nodeArgs, binary, "ext", "add", v2], { cwd: root, env, stdio: ["ignore", "pipe", "pipe"] });
  let out = "", err = "";
  child.stdout.on("data", (chunk) => { out += chunk; });
  child.stderr.on("data", (chunk) => { err += chunk; });
  const exited = new Promise<number | null>((done) => child.once("close", (code) => done(code)));
  for (const end = Date.now() + 120_000; !existsSync(held) && Date.now() < end;) await new Promise((r) => setTimeout(r, 50));
  assert.ok(existsSync(held), "real npm installed 2.0.0 and its wrapper is holding open");
  if (process.platform !== "win32") {
    child.kill("SIGTERM");
    writeFileSync(release, "");
  }
  const code = await exited;
  check("the interrupted add exits 130", code === 130, `exit ${code}\n${out.slice(-800)}${err.slice(-800)}`);
  check("the interrupted add never announces 2.0.0", !(out + err).includes(`added ${name}@2.0.0`), out);
  check("the prefix and manifest are back at 1.0.0", recorded() === "1.0.0" && installed() === "1.0.0");
  const again = add(v2);
  check("the next add takes the released lock and installs 2.0.0", again.status === 0 && recorded() === "2.0.0" && installed() === "2.0.0", again.stderr.slice(-800));
  check("the next add announces 2.0.0 once", again.stdout.split(`added ${name}@2.0.0`).length === 2, again.stdout);

  if (readOnlyCell) {
    // Promotion renames the live prefix whole into the rollback location, preserving its mode.
    const locked = join(prefix, "read-only");
    mkdirSync(join(locked, "inner"), { recursive: true });
    writeFileSync(join(locked, "inner", "file"), "");
    chmodSync(locked, 0o555);
    const v3 = add(build("3.0.0"));
    chmodSync(locked, 0o755);
    check("an add whose snapshot cannot be removed after its commit exits 0", v3.status === 0, v3.stderr.slice(-800));
    check("it announces 3.0.0 and records it", v3.stdout.includes(`added ${name}@3.0.0`) && recorded() === "3.0.0" && installed() === "3.0.0", v3.stdout);
    check("it names the snapshot it could not remove", /\.extensions\.rollback-/.test(v3.stderr), v3.stderr.slice(-800));
  }
} finally {
  spawnSync("chmod", ["-R", "u+w", root]);
  rmSync(root, { recursive: true, force: true });
}
assert.equal(passed + failed, readOnlyCell ? 9 : 6, "all expected interrupt and commit checks ran");
console.log(`ext-add-interrupt smoke: ${passed} passed, ${failed} failed`);
emitSentinel({ passed, failed });
process.exit(failed ? 1 : 0);
