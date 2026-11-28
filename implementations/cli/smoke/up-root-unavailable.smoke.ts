/**
 * `cotal up --root` on a path it cannot start in names why, and only offers to prepare a directory
 * that has no `.cotal` of its own. A regular file where a prepared project used to be, which used to
 * be told to prepare that same path, is named as a file and given the step that moves it aside and
 * restores the folder, or forgets and prepares the space again elsewhere. A directory this account
 * cannot enter is given the step that restores access. Each refuses TARGET_UNAVAILABLE, exit 2, and
 * leaves the file and the preparation as they were.
 *
 * Driven through the built binary in a sandboxed HOME, XDG_CONFIG_HOME and COTAL_HOME. Nothing is
 * started; the address passed has no broker and is never dialed.
 *
 * Run: pnpm smoke:up-root-unavailable
 */
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createSuite, freePort } from "@cotal-ai/smoke-kit";

const BIN = join(import.meta.dirname, "..", "..", "..", "bin", "dist", "cotal.js");
if (!existsSync(BIN)) {
  console.error(`✗ ${BIN} missing - build first: pnpm --filter cotal-ai... build`);
  process.exit(1);
}

interface Envelope { error?: { code?: string; message?: string; remedy?: string } }
const { check, finish } = createSuite();
const home = realpathSync(mkdtempSync(join(tmpdir(), "cotal-up-root-")));
const locked = join(home, "locked");
process.on("exit", () => { if (existsSync(locked)) chmodSync(locked, 0o700); rmSync(home, { recursive: true, force: true }); });

const HOST_ENV = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith("COTAL_") && k !== "FORCE_COLOR" && k !== "NO_COLOR"));
const cotalHome = join(home, ".cotal");
const env = { ...HOST_ENV, HOME: home, USERPROFILE: home, XDG_CONFIG_HOME: join(home, ".config"), COTAL_HOME: cotalHome, COTAL_SKIP_CONNECTOR_SEED: "1", DO_NOT_TRACK: "1", NO_COLOR: "1" };
const elsewhere = join(home, "elsewhere");
mkdirSync(elsewhere, { mode: 0o700 });
const run = (args: string[]) => {
  const r = spawnSync(process.execPath, [BIN, ...args], { cwd: elsewhere, env, encoding: "utf8", timeout: 120_000 });
  let envelope: Envelope | undefined;
  try { envelope = JSON.parse(r.stdout ?? "") as Envelope; } catch { envelope = undefined; }
  return { status: r.status, stdout: r.stdout ?? "", stderr: r.stderr ?? "", envelope };
};
const shown = (r: ReturnType<typeof run>) => ({ status: r.status, stdout: r.stdout.slice(0, 900), stderr: r.stderr.slice(0, 900) });
const server = `nats://127.0.0.1:${await freePort()}`;
const up = (root: string) => run(["up", "--root", root, "--server", server, "--json"]);
const prepareAdvice = "prepare it with `cotal space create";

const project = join(home, "lab");
mkdirSync(project, { mode: 0o700 });
const created = run(["space", "create", "lab", "--root", project, "--json"]);
check("the space is prepared", created.status === 0, shown(created));
const record = join(cotalHome, "prepared", readdirSync(join(cotalHome, "prepared"))[0] ?? "");
const preparedBefore = readFileSync(record);
renameSync(project, `${project}.saved`);
const replacement = "replacement file\n";
writeFileSync(project, replacement);

const obstructed = up(project);
check("up --root at a file that replaced a prepared project names the file and the ways back",
  obstructed.status === 2 && obstructed.envelope?.error?.code === "TARGET_UNAVAILABLE" &&
    obstructed.envelope.error.message?.includes(`--root ${project} is not a directory: a file occupies the project path`) === true &&
    obstructed.envelope.error.remedy?.includes(`move ${project} aside and restore the original project folder`) === true &&
    obstructed.envelope.error.remedy.includes("cotal space forget lab") && !obstructed.envelope.error.remedy.includes(prepareAdvice), shown(obstructed));
const plain = run(["up", "--foreground", "--root", project, "--server", server]);
check("the terminal refusal does not tell the user to prepare the obstructed path",
  plain.status === 2 && plain.stderr.includes("a file occupies the project path") && !plain.stderr.includes(prepareAdvice), shown(plain));
check("the refusals leave the replacement file and the preparation untouched",
  readFileSync(project, "utf8") === replacement && readFileSync(record).equals(preparedBefore));

const stray = join(home, "stray");
writeFileSync(stray, "notes\n");
const unrecorded = up(stray);
check("a file no space was prepared at is named as a file without startup or preparation advice",
  unrecorded.status === 2 && unrecorded.envelope?.error?.code === "TARGET_UNAVAILABLE" &&
    unrecorded.envelope.error.message?.includes("a file occupies the project path") === true &&
    unrecorded.envelope.error.remedy?.includes(`move ${stray} aside`) === true && !unrecorded.envelope.error.remedy.includes(prepareAdvice), shown(unrecorded));

if (process.getuid?.() !== 0) {
  mkdirSync(locked, { mode: 0o000 });
  const denied = up(locked);
  check("a directory this account cannot enter is told to restore access, not to prepare it",
    denied.status === 2 && denied.envelope?.error?.code === "TARGET_UNAVAILABLE" &&
      denied.envelope.error.message?.includes(`--root ${locked} could not be accessed`) === true &&
      denied.envelope.error.remedy?.includes(`restore this account's access to ${locked}`) === true && !denied.envelope.error.remedy.includes(prepareAdvice), shown(denied));
}

const blocked = join(home, "blocked project");
mkdirSync(blocked);
const marker = join(blocked, ".cotal");
writeFileSync(marker, replacement);
const blockedMarker = up(blocked);
check("a file occupying .cotal is not told to prepare over that file",
  blockedMarker.status === 2 && blockedMarker.envelope?.error?.code === "TARGET_UNAVAILABLE" &&
    blockedMarker.envelope.error.message?.includes(`the .cotal entry in ${blocked} is not a project directory`) === true &&
    blockedMarker.envelope.error.remedy?.includes("another prepared project") === true && !blockedMarker.envelope.error.remedy.includes(prepareAdvice) &&
    readFileSync(marker, "utf8") === replacement && readFileSync(record).equals(preparedBefore), shown(blockedMarker));

const unprepared = up(elsewhere);
check("an unprepared directory keeps the prepare-and-retry step",
  unprepared.status === 2 && unprepared.envelope?.error?.code === "TARGET_UNAVAILABLE" &&
    unprepared.envelope.error.message?.includes("--root must name an existing prepared local project") === true &&
    unprepared.envelope.error.remedy?.includes(prepareAdvice) === true && !existsSync(join(elsewhere, ".cotal")), shown(unprepared));

finish();
