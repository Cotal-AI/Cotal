/**
 * `space delete` names a prepared space for what it is, and `space forget` and `help space delete`
 * say what applies. Deleting a space that is prepared and not running used to say "no registered
 * space has this exact name", `space forget` called a space started before "never started", and the
 * delete help described `-y` with the `add` text first. The `space` listing said "No spaces
 * registered" above the prepared space it listed, under a `SPACE  Project` header. `space forget
 * --yes` said `--yes` is taken by `space add` only, though `space delete` takes it too. A second
 * `space create` in the folder named no step for the space already there. `doctor auth --space`
 * for a prepared space told the user to run the same command in the space's root, also when run
 * there; it now names `cotal up` first, with the root quoted for a shell from another folder, and
 * still refuses AUTH_REQUIRED. Bare `doctor auth` in that root said the same; it names the space
 * this root prepared, and only that one, and its report stays partial.
 *
 * Driven through the built binary in a sandboxed HOME, XDG_CONFIG_HOME and COTAL_HOME, the 80-column
 * run on a real pty. No broker is started and nothing is deleted.
 *
 * Run: pnpm smoke:space-prepared-delete
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createSuite } from "@cotal-ai/smoke-kit";
import { ptySpawn, screen } from "./_console-pty.js";

const BIN = join(import.meta.dirname, "..", "..", "..", "bin", "dist", "cotal.js");
if (!existsSync(BIN)) {
  console.error(`✗ ${BIN} missing - build first: pnpm --filter cotal-ai... build`);
  process.exit(1);
}

interface Envelope { outcome?: string; target?: { root?: string; space?: string | null }; result?: { space?: string | null; credentialScope?: string }; error?: { code?: string; message?: string; remedy?: string } }

const { check, finish } = createSuite();
const home = mkdtempSync(join(tmpdir(), "cotal-prepared-delete-"));
const root = mkdtempSync(join(home, "project-"));
process.on("exit", () => rmSync(home, { recursive: true, force: true }));

const HOST_ENV = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith("COTAL_") && k !== "FORCE_COLOR" && k !== "NO_COLOR"));
const env = { ...HOST_ENV, HOME: home, USERPROFILE: home, XDG_CONFIG_HOME: join(home, ".config"), COTAL_HOME: join(home, ".cotal"), COTAL_SKIP_CONNECTOR_SEED: "1", NO_COLOR: "1" };
const run = (args: string[], cwd = root) => {
  const r = spawnSync(process.execPath, [BIN, ...args], { cwd, env, encoding: "utf8", timeout: 120_000 });
  let envelope: Envelope | undefined;
  try { envelope = JSON.parse(r.stdout ?? "") as Envelope; } catch { envelope = undefined; }
  return { status: r.status, stdout: r.stdout ?? "", stderr: r.stderr ?? "", envelope };
};
const shown = (r: ReturnType<typeof run>) => ({ status: r.status, stdout: r.stdout.slice(0, 900), stderr: r.stderr.slice(0, 600) });
const ptyEnv: Record<string, string> = {};
for (const [k, v] of Object.entries(env)) if (v !== undefined) ptyEnv[k] = v;
/** One run in `root` on an 80-column pty: its exit code and the screen it leaves. */
const at80 = async (args: string[]) => {
  const pty = ptySpawn(process.execPath, [BIN, ...args], { name: "xterm-256color", cols: 80, rows: 60, cwd: root, env: ptyEnv });
  let raw = "";
  pty.onData((d) => { raw += d; });
  const exitCode = await new Promise<number>((done) => pty.onExit((e) => done(e.exitCode)));
  return { exitCode, display: await screen(raw, 80, 60) };
};
/** Every line fits 80 columns, except one that is a single word, such as a long temporary root path,
 *  which no wrap can break. */
const fits80 = (display: string) => display.split("\n").every((line) => [...line].length <= 80 || !/\S\s+\S/.test(line.trim()));

const created = run(["space", "create", "b4b", "--root", root]);
check("rig: the space is prepared and not started", created.status === 0, shown(created));

// The listing shows the prepared space, so it does not also say that no space is registered, and its
// headers are in the same case as the registered table's.
const listing = run(["space"]);
check("the space listing names a prepared space without saying none is registered", listing.status === 0 && /Prepared, not started/.test(listing.stdout) && /\bb4b\b/.test(listing.stdout) && !/No spaces registered/.test(listing.stdout) && /No space has been started or registered yet/.test(listing.stdout), shown(listing));
check("the prepared table's headers are Space and Project", /^\s*Space\s+Project\s*$/m.test(listing.stdout) && !/SPACE/.test(listing.stdout), shown(listing));

// A space no `up` started holds no signing trust, so doctor auth refuses for it. Its step used to be
// to run the same command in the space's root, which is where it ran. The refusal stays; the step is
// to start the space first.
const DOCTOR_HERE = '"b4b" is prepared but not started; start it with `cotal up`, then run `cotal doctor auth --space b4b` again';
const cotalBefore = readdirSync(join(root, ".cotal")).sort();
const doctorJson = run(["doctor", "auth", "--space", "b4b", "--json"]);
check("doctor auth --space in a prepared space's root still refuses AUTH_REQUIRED, exit 2, with that root as its target",
  doctorJson.status === 2 && doctorJson.envelope?.error?.code === "AUTH_REQUIRED" && doctorJson.envelope.target?.root === realpathSync(root) && doctorJson.envelope.target?.space === "b4b", shown(doctorJson));
check("its step is to start the space, then run the same command again", doctorJson.envelope?.error?.remedy === DOCTOR_HERE, doctorJson.envelope?.error);
const doctorPlain = run(["doctor", "auth", "--space", "b4b"]);
const plainText = doctorPlain.stdout + doctorPlain.stderr;
check("the plain refusal prints that step under Next", doctorPlain.status === 2 && plainText.includes(`Next\n  ${DOCTOR_HERE}\n`) && !plainText.includes("in that space's root folder"), shown(doctorPlain));
const doctorAgain = run(["doctor", "auth", "--space", "b4b"]);
check("running it again in the same root gives the same refusal and writes nothing",
  doctorAgain.status === 2 && doctorAgain.stdout + doctorAgain.stderr === plainText && JSON.stringify(readdirSync(join(root, ".cotal")).sort()) === JSON.stringify(cotalBefore), shown(doctorAgain));
{
  const { exitCode, display } = await at80(["doctor", "auth", "--space", "b4b"]);
  check("on an 80-column terminal the refusal fits and names the same step", exitCode === 2 && fits80(display) && display.replace(/\s+/g, " ").includes(DOCTOR_HERE), { exitCode, display });
}

// Without --space the report is partial rather than a refusal, and its step was the same "run it in a
// space's root". It now names the space this root prepared; the outcome, exit and scope stay.
const BARE_HERE = '"b4b" is prepared but not started; start it with `cotal up`, then run `cotal doctor auth` again';
const bareJson = run(["doctor", "auth", "--json"]);
check("bare doctor auth in a prepared space's root stays partial, exit 4, with no space or credential scope established",
  bareJson.status === 4 && bareJson.envelope?.outcome === "partial" && bareJson.envelope.error?.code === "OPERATION_PARTIAL" && bareJson.envelope.target?.root === realpathSync(root)
    && bareJson.envelope.result?.space === null && bareJson.envelope.result?.credentialScope === "not-established", shown(bareJson));
check("its step is to start the space this root prepared, then run the same command again", bareJson.envelope?.error?.remedy === BARE_HERE, bareJson.envelope?.error);
const barePlain = run(["doctor", "auth"]);
const bareText = barePlain.stdout + barePlain.stderr;
check("the text report names that step", barePlain.status === 4 && bareText.includes(`↳ ${BARE_HERE}\n`) && !bareText.includes("in a space's root folder"), shown(barePlain));
const bareAgain = run(["doctor", "auth"]);
check("running it again gives the same report and writes nothing",
  bareAgain.status === 4 && bareAgain.stdout + bareAgain.stderr === bareText && JSON.stringify(readdirSync(join(root, ".cotal")).sort()) === JSON.stringify(cotalBefore), shown(bareAgain));
{
  const { exitCode, display } = await at80(["doctor", "auth"]);
  check("on an 80-column terminal the bare report fits and names the same step", exitCode === 4 && fits80(display) && display.replace(/\s+/g, " ").includes(BARE_HERE), { exitCode, display });
}
const bareFix = run(["doctor", "auth", "--fix", "--json"]);
check("bare doctor auth --fix there still refuses AUTH_REQUIRED, exit 2, naming no space, with the step for --fix",
  bareFix.status === 2 && bareFix.envelope?.error?.code === "AUTH_REQUIRED" && bareFix.envelope.target?.space === null
    && bareFix.envelope.error.remedy === '"b4b" is prepared but not started; start it with `cotal up`, then run `cotal doctor auth --fix` again', shown(bareFix));

// From another folder the step names the prepared root with --root, quoted so a shell reads it back
// as that folder.
const special = join(home, "it's $HOME d");
mkdirSync(special);
const createdSpecial = run(["space", "create", "b4d", "--root", special]);
check("rig: a second space is prepared in a folder whose name a shell would expand", createdSpecial.status === 0, shown(createdSpecial));
const doctorElsewhere = run(["doctor", "auth", "--space", "b4d", "--json"]);
const elsewhereStep = /^"b4d" is prepared but not started; start it with `cotal up --root (.+)`, then run `cotal doctor auth --space b4d` in that folder$/.exec(doctorElsewhere.envelope?.error?.remedy ?? "");
const shellRead = elsewhereStep ? spawnSync("/bin/sh", ["-c", `printf %s ${elsewhereStep[1]}`], { encoding: "utf8", env: { PATH: process.env.PATH, HOME: "/nonexistent" } }).stdout : undefined;
check("doctor auth --space from another folder refuses AUTH_REQUIRED and names cotal up --root for the prepared root",
  doctorElsewhere.status === 2 && doctorElsewhere.envelope?.error?.code === "AUTH_REQUIRED" && elsewhereStep !== null, shown(doctorElsewhere));
check("a shell reads that --root back as the prepared folder", shellRead !== undefined && existsSync(shellRead) && realpathSync(shellRead) === realpathSync(special), { remedy: doctorElsewhere.envelope?.error?.remedy, shellRead });

// Bare doctor auth names only the space its own root prepared: not another prepared space, not the
// selection, and none from a folder that holds no space.
const selected = run(["use", "b4d"]);
check("rig: the other prepared space is selected", selected.status === 0, shown(selected));
const bareOwn = run(["doctor", "auth", "--json"]);
check("bare doctor auth in the first root still names its own space, not the selected one", bareOwn.status === 4 && bareOwn.envelope?.error?.remedy === BARE_HERE, shown(bareOwn));
const bareSpecial = run(["doctor", "auth", "--json"], special);
check("in the second root it names that root's space, with no --root",
  bareSpecial.status === 4 && bareSpecial.envelope?.error?.remedy === '"b4d" is prepared but not started; start it with `cotal up`, then run `cotal doctor auth` again', shown(bareSpecial));
const noSpace = join(home, "no-space");
mkdirSync(noSpace);
const bareNone = run(["doctor", "auth", "--json"], noSpace);
check("control: from a folder that holds no space it keeps the general step and names neither",
  bareNone.status === 4 && bareNone.envelope?.error?.remedy === "run `cotal doctor auth` in a space's root folder; `cotal space` lists each space's root", shown(bareNone));
const cleared = run(["use", "--clear"]);
check("rig: the selection is cleared", cleared.status === 0, shown(cleared));

const doctorUnknown = run(["doctor", "auth", "--space", "nosuch", "--json"]);
check("control: a space nothing prepared or registered keeps the general step",
  doctorUnknown.status === 2 && doctorUnknown.envelope?.error?.code === "AUTH_REQUIRED" && doctorUnknown.envelope.error.remedy === "run `cotal doctor auth --space nosuch` in that space's root folder; `cotal space` lists each space's root", shown(doctorUnknown));

const preview = run(["space", "delete", "b4b", "--dry-run", "--json"]);
check("a delete preview of a prepared space refuses as unavailable, exit 2", preview.status === 2 && preview.envelope?.error?.code === "TARGET_UNAVAILABLE", shown(preview));
check("it says the space is prepared and not running", /"b4b" is prepared and not running/.test(preview.envelope?.error?.message ?? ""), preview.envelope?.error);
check("a space that never ran has no streams, so its remedy names only space forget", /no stack has run for it/.test(preview.envelope?.error?.remedy ?? "") && /cotal space forget b4b/.test(preview.envelope?.error?.remedy ?? "") && !/cotal up/.test(preview.envelope?.error?.remedy ?? ""), preview.envelope?.error);

const unknown = run(["space", "delete", "nosuch", "--dry-run", "--json"]);
check("control: a name nothing records is still not found, exit 2", unknown.status === 2 && unknown.envelope?.error?.code === "TARGET_NOT_FOUND", shown(unknown));

const help = run(["help", "space", "delete"]);
check("delete help describes -y without the add text first", help.status === 0 && /a delete must name the exact space/.test(help.stdout) && !/add: skip terminal confirmation/.test(help.stdout), shown(help));

// A second space in this folder named no step for the space already here, and told a caller who
// passed --root to pass --root.
const second = run(["space", "create", "b4c", "--root", root, "--json"]);
check("space create in a folder another space holds is CONFLICT, exit 2, naming the steps for that space",
  second.status === 2 && second.envelope?.error?.code === "CONFLICT"
    && Boolean(second.envelope.error.remedy?.startsWith('create "b4c" in another folder with --root <dir>; for "b4b", which uses this folder, start it with `cotal up` from '))
    && Boolean(second.envelope.error.remedy?.endsWith(", select it with `cotal use b4b`, or forget it with `cotal space forget b4b`")), second.envelope?.error);

// --yes belongs to space delete too; the refusal named space add alone.
const forgetYes = run(["space", "forget", "b4b", "--yes"]);
check("space forget --yes names space add and space delete as the commands that take it, exit 1",
  forgetYes.status === 1 && forgetYes.stderr.startsWith("✗ --yes is taken by `cotal space add` and `cotal space delete` only\n"), shown(forgetYes));

const forgot = run(["space", "forget", "b4b"]);
check("forget says the prepared space is not running", forgot.status === 0 && /prepared, not running/.test(forgot.stdout) && !/never started/.test(forgot.stdout), shown(forgot));

finish();
process.exit(process.exitCode ?? 0);
