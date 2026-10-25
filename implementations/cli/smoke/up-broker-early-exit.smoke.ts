/**
 * A `nats-server` that the retained launcher starts and that exits before it answers fails `up` as
 * OPERATION_FAILED, exit 5. The failure names the file, the exit code or signal Node observed, and
 * the broker log, and its next step is to read that log, then fix the file or take it off PATH.
 *
 * Driven through the built CLI: `up -d --server` in an unprepared root, which runs the retained
 * launcher. The `nats-server` first on PATH is a stand-in script in a protected folder. It answers
 * `--version`, records every other call, writes one line to its output and then exits 1, or stops
 * itself with SIGTERM. Nothing ever binds the port, and nothing is left running.
 *
 * `up --foreground` with the stand-in that exits 1 ends with exit 5, a failed run, not the broker's
 * own 1, and its line says the mesh was not recorded, as `cotal meshes` confirms.
 *
 * Run: pnpm smoke:up-broker-early-exit
 */
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { createSuite, freePort, skipSuite, SMOKE_BROKER_TOKEN } from "@cotal-ai/smoke-kit";
import { assertScratchHeld, makeScratch } from "../../../bin/smoke/_scratch.js";

if (process.platform === "win32") skipSuite("the stand-in nats-server is a POSIX shell script");
const scratch = makeScratch(`${SMOKE_BROKER_TOKEN}broker-early-exit-`);
const suite = createSuite();
const cli = resolve(import.meta.dirname, "../../../bin/dist/cotal.js");
const home = join(scratch, "home");
const inherited = { ...process.env };
for (const key of Object.keys(inherited)) if (key.startsWith("COTAL_")) delete inherited[key];
/** One line, without colour, so a wrapped report reads as it was written. */
const flat = (text: string) => text.replace(/\x1b\[[0-9;]*m/g, "").replace(/\s+/g, " ");
const envFor = (bin: string) => ({ ...inherited, HOME: home, COTAL_HOME: join(home, ".cotal"), XDG_CONFIG_HOME: join(home, "config"), TMPDIR: scratch, PATH: `${bin}:/usr/bin:/bin`, COTAL_SKIP_CONNECTOR_SEED: "1", COTAL_TELEMETRY: "off", DO_NOT_TRACK: "1" });

try {
  for (const [mode, ending, exit] of [["code", "exit 1", "exited with code 1"], ["signal", "kill -TERM $$", "was stopped by SIGTERM"]] as const) {
    const root = join(scratch, `project-${mode}`), bin = join(scratch, `bin-${mode}`), ran = join(scratch, `ran-${mode}`);
    mkdirSync(root);
    mkdirSync(bin, { mode: 0o755 });
    chmodSync(bin, 0o755);
    const fake = join(bin, "nats-server");
    writeFileSync(fake, `#!/bin/sh\nif [ "$1" = --version ]; then echo "nats-server: v2.14.0"; exit 0; fi\necho "$*" >> '${ran}'\necho "stand-in nats-server: not a broker" >&2\n${ending}\n`, { mode: 0o755 });
    assertScratchHeld(root, "the project folder");
    const server = `nats://127.0.0.1:${await freePort()}`;
    const result = spawnSync(process.execPath, [cli, "up", "-d", "--server", server], { cwd: root, env: envFor(bin), encoding: "utf8", timeout: 120_000 });
    const output = flat(`${result.stdout}${result.stderr}`);
    const log = join(root, ".cotal", "nats.log");
    suite.check(`${mode}: the launcher ran the stand-in as the broker`, existsSync(ran) && readFileSync(ran, "utf8").startsWith("-c "), output);
    suite.check(`${mode}: up fails OPERATION_FAILED, exit 5, not unconfirmed`, result.status === 5 && output.includes("Request failed") && output.includes("OPERATION_FAILED") && !output.includes("OPERATION_UNKNOWN"), `${result.status} ${output}`);
    suite.check(`${mode}: the failure names the file, its observed exit and the log`, output.includes(`nats-server 2.14.0 on PATH at ${fake} ${exit} before it answered at ${server}; see ${log}`), output);
    suite.check(`${mode}: its next step is the log, then the file or PATH`, output.includes(`read ${log}, then fix ${fake} or take it off PATH so cotal uses its bundled nats-server, and run cotal up again`), output);
    suite.check(`${mode}: the log holds what the stand-in wrote`, existsSync(log) && readFileSync(log, "utf8").includes("stand-in nats-server: not a broker"), existsSync(log) ? readFileSync(log, "utf8") : "no log");
    suite.check(`${mode}: no broker pid record is left`, !existsSync(join(root, ".cotal", "nats.pid")));
  }
  const root = join(scratch, "fg");
  mkdirSync(root);
  assertScratchHeld(root, "the project folder");
  const env = envFor(join(scratch, "bin-code"));
  const foreground = spawnSync(process.execPath, [cli, "up", "--foreground", "--server", `nats://127.0.0.1:${await freePort()}`], { cwd: root, env, encoding: "utf8", timeout: 120_000 });
  const line = flat(foreground.stderr);
  suite.check("foreground: a broker that exits 1 ends up with exit 5, not its own 1", foreground.status === 5, `${foreground.status} ${line}`);
  suite.check("foreground: its line names the exit and says the mesh was not recorded", line.includes(`✗ nats-server exited unexpectedly (code 1); the mesh "fg" was not recorded;`) && !line.includes("stays recorded"), line);
  const meshes = spawnSync(process.execPath, [cli, "meshes"], { cwd: root, env, encoding: "utf8", timeout: 60_000 });
  suite.check("foreground: no record was written for it", meshes.status === 0 && flat(meshes.stdout).includes("no meshes registered"), flat(`${meshes.stdout}${meshes.stderr}`));
} finally {
  rmSync(scratch, { recursive: true, force: true });
  suite.finish();
}
