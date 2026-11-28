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
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createSuite } from "@cotal-ai/smoke-kit";
import { shellPath, spaceSegment } from "@cotal-ai/workspace";
import { ptySpawn, screen } from "./_console-pty.js";

const BIN = join(import.meta.dirname, "..", "..", "..", "bin", "dist", "cotal.js");
if (!existsSync(BIN)) {
  console.error(`✗ ${BIN} missing - build first: pnpm --filter cotal-ai... build`);
  process.exit(1);
}

interface Envelope { command?: string; outcome?: string; target?: { root?: string; space?: string | null }; result?: { space?: string | null; credentialScope?: string; repair?: { attempted?: boolean } }; warnings?: { code: string }[]; error?: { code?: string; message?: string; remedy?: string } }

const { check, finish } = createSuite();
const home = mkdtempSync(join(tmpdir(), "cotal-prepared-delete-"));
const root = mkdtempSync(join(home, "project-"));
process.on("exit", () => rmSync(home, { recursive: true, force: true }));

const HOST_ENV = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith("COTAL_") && k !== "FORCE_COLOR" && k !== "NO_COLOR"));
const env = { ...HOST_ENV, HOME: home, USERPROFILE: home, XDG_CONFIG_HOME: join(home, ".config"), COTAL_HOME: join(home, "registry"), COTAL_SKIP_CONNECTOR_SEED: "1", NO_COLOR: "1" };
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

const empty = run(["space"]);
check("rig: no spaces are registered or prepared", empty.status === 0 && empty.stdout.includes("No spaces registered."), shown(empty));
const seeded = mkdtempSync(join(home, "seeded-"));
mkdirSync(join(seeded, ".cotal"), { mode: 0o700 });
writeFileSync(join(seeded, ".cotal", "channels.json"), '{"channels":{}}\n');
const unknownStep = 'Unknown space "b4b". Run `cotal space` to check the name. For a new local space, run `cotal space create b4b` in its project folder, then run `cotal up` there.';
const unknownPlain = run(["doctor", "auth", "--space", "b4b", "--plain"], seeded);
check("doctor auth --space for an unknown space gives preparation guidance instead of a root",
  unknownPlain.status === 2 && `${unknownPlain.stdout}${unknownPlain.stderr}`.includes(`Next\n  ${unknownStep}\n`), shown(unknownPlain));
const noScope = run(["doctor", "auth", "--plain"], seeded);
check("bare doctor auth in a never-started project lists where to find a space root",
  noScope.status === 4 && noScope.stderr.includes("`cotal space` lists each space's root") && !noScope.stderr.includes("server-open.conf"), shown(noScope));

const created = run(["space", "create", "b4b", "--root", root]);
check("rig: the space is prepared and not started", created.status === 0, shown(created));

for (const verb of ["describe", "invoke"]) {
  const operation = [verb, "manager", ...(verb === "invoke" ? ["status", "--args", "{}"] : []), "--space", "b4b"];
  const plain = run(["ep", ...operation, "--plain"]);
  const message = '"b4b" is prepared but not started';
  const remedy = `start it with \`cotal up\` in ${realpathSync(root)}`;
  check(`ep ${verb} in a prepared space names the project and startup step`, plain.status === 2 && plain.stdout === "" &&
    /Code:\s+TARGET_UNAVAILABLE/.test(plain.stderr) && plain.stderr.includes(message) && plain.stderr.includes(`Next\n  ${remedy}`), shown(plain));
  for (const prefix of [["endpoint"], []]) {
    const json = run([...prefix, ...operation, "--json"], home);
    const report = json.envelope;
    check(`${[...prefix, verb].join(" ")} refuses before requesting a contract and names the prepared target`, json.status === 2 && json.stderr === "" &&
      report?.outcome === "refused" && report.error?.code === "TARGET_UNAVAILABLE" && report.error.message === message &&
      report.error.remedy === remedy && report.target?.space === "b4b" && report.target.root === realpathSync(root), shown(json));
  }
}

const server = "nats://127.0.0.1:43842";
const roster = run(["ps", "--space", "b4b", "--server", server, "--json"], home);
check("a prepared roster lookup keeps the root, space and loopback port on the first start",
  roster.status === 2 && roster.envelope?.error?.code === "TARGET_UNAVAILABLE" &&
  roster.envelope.error.remedy === `start it with \`cotal up --root ${shellPath(realpathSync(root))} --space b4b --server ${shellPath(server)}\``, shown(roster));
const remoteRoster = run(["ps", "--space", "b4b", "--server", "nats://broker.example.test:43842", "--json"], home);
check("a remote dial address is not a first local start command",
  remoteRoster.status === 2 && remoteRoster.envelope?.error?.remedy?.includes("no recorded broker") === true && !remoteRoster.stdout.includes("cotal up"), shown(remoteRoster));
const beforeMint = readdirSync(join(root, ".cotal")).sort();
const out = join(home, "alice.creds");
const mint = run(["auth", "mint", "alice", "--server", server, "--out", out, "--json"]);
check("mint with an explicit broker refuses and names the first start at that address",
  mint.status === 2 && mint.envelope?.outcome === "refused" && mint.envelope.target?.space === "b4b" &&
  mint.envelope.error?.code === "AUTH_REQUIRED" && mint.envelope.error.remedy === `start it with \`cotal up --server ${server}\` to create the local static signing trust`, shown(mint));
const bareMint = run(["auth", "mint", "alice", "--out", out, "--json"]);
check("mint without a broker still refuses and explains that startup creates signing trust",
  bareMint.status === 2 && bareMint.envelope?.error?.code === "TARGET_UNAVAILABLE" &&
  bareMint.envelope.error.remedy === "start it with `cotal up` to create the local static signing trust", shown(bareMint));
const callerMint = run(["auth", "mint", "alice", "--server", server, "--endpoint", "com.example.caller", "--out", out, "--json"]);
check("endpoint mint shares the prepared startup remedy and neither mint writes anything",
  callerMint.status === 2 && callerMint.envelope?.error?.code === "AUTH_REQUIRED" &&
  callerMint.envelope.error.remedy === mint.envelope?.error?.remedy && !existsSync(out) && !existsSync(`${out}.issuance.json`) &&
  JSON.stringify(readdirSync(join(root, ".cotal")).sort()) === JSON.stringify(beforeMint), shown(callerMint));
const unprepared = run(["auth", "mint", "alice", "--server", server, "--out", out, "--json"], home);
check("a root that was not prepared gets no startup remedy",
  unprepared.status === 2 && unprepared.envelope?.error?.code === "AUTH_REQUIRED" && unprepared.envelope.error.remedy === undefined, shown(unprepared));
const remoteMint = run(["auth", "mint", "alice", "--server", "nats://nats.example.test:43842", "--json"]);
check("mint does not pass a remote dial address to local startup",
  remoteMint.status === 2 && remoteMint.envelope?.error?.code === "AUTH_REQUIRED" &&
  remoteMint.envelope.error.remedy === bareMint.envelope?.error?.remedy, shown(remoteMint));

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
  doctorJson.status === 2 && doctorJson.stderr === "" && doctorJson.envelope?.command === "doctor auth" && doctorJson.envelope.outcome === "refused"
    && doctorJson.envelope.error?.code === "AUTH_REQUIRED" && doctorJson.envelope.target?.root === realpathSync(root) && doctorJson.envelope.target?.space === "b4b", shown(doctorJson));
check("its step is to start the space, then run the same command again", doctorJson.envelope?.error?.remedy === DOCTOR_HERE, doctorJson.envelope?.error);
const doctorEmptySpace = run(["doctor", "auth", "--space=", "--json"]);
check("doctor auth with an empty --space names the subcommand in its USAGE_INVALID refusal",
  doctorEmptySpace.status === 1 && doctorEmptySpace.stderr === "" && doctorEmptySpace.envelope?.command === "doctor auth"
    && doctorEmptySpace.envelope.outcome === "refused" && doctorEmptySpace.envelope.error?.code === "USAGE_INVALID", shown(doctorEmptySpace));
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
{
  const record = join(env.COTAL_HOME, "prepared", `${spaceSegment("b4b")}.json`);
  const saved = readFileSync(record);
  writeFileSync(record, "{\n");
  try {
    const plain = run(["doctor", "auth", "--plain"]);
    const json = run(["doctor", "auth", "--json"]);
    const step = json.envelope?.error?.remedy ?? "";
    check("bare doctor auth gives the damaged prepared record's recovery as its primary step in text and JSON",
      plain.status === 4 && json.status === 4 && json.envelope?.warnings?.some(({ code }) => code === "PREPARED_RECORD_SKIPPED") === true &&
      step.includes(record) && step.includes("`cotal space forget b4b`") && plain.stderr.includes(`-> ${step}`) &&
      !step.includes("server-open.conf") && readFileSync(record, "utf8") === "{\n", { plain: shown(plain), json: shown(json) });
    const named = run(["doctor", "auth", "--space", "b4b", "--json"]);
    check("named doctor auth keeps the damaged record refusal and its recovery",
      named.status === 1 && named.envelope?.error?.code === "SCHEMA_INVALID" && named.envelope.error.remedy === "remove it with `cotal space forget b4b`", shown(named));
  } finally { writeFileSync(record, saved); }
}
const bareJson = run(["doctor", "auth", "--json"]);
check("bare doctor auth in a prepared space's root stays partial, exit 4, with no space or credential scope established",
  bareJson.status === 4 && bareJson.envelope?.command === "doctor auth" && bareJson.envelope.outcome === "partial" && bareJson.envelope.error?.code === "OPERATION_PARTIAL" && bareJson.envelope.target?.root === realpathSync(root)
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

{
  const seed = join(realpathSync(root), ".cotal", "channels.json");
  writeFileSync(seed, '{"channels":\n');
  const status = run(["status", "--space", "b4b", "--plain"]);
  const ps = run(["ps", "--space", "b4b", "--json"]);
  const doctor = run(["doctor", "auth", "--space", "b4b", "--json"], home);
  const up = run(["up", "--foreground", "--space", "b4b", "--server", server]);
  const repair = `fix or remove ${seed}`;
  const doctorStep = doctor.envelope?.error?.remedy ?? "";
  check("status keeps the prepared verdict and replaces bare first-start advice with channel seed repair",
    status.status === 0 && status.stdout.includes('"b4b" is prepared but not started') && status.stdout.includes(`First start blocked: the channels file ${seed}`) && status.stdout.includes(repair) && !status.stdout.includes("start it with"), shown(status));
  check("ps keeps TARGET_UNAVAILABLE and names the same channel seed repair",
    ps.status === 2 && ps.envelope?.error?.code === "TARGET_UNAVAILABLE" && ps.envelope.error.message?.includes(`First start blocked: the channels file ${seed}`) === true && ps.envelope.error.remedy === repair, shown(ps));
  check("doctor keeps AUTH_REQUIRED and puts the repair before startup at the named root",
    doctor.status === 2 && doctor.envelope?.error?.code === "AUTH_REQUIRED" && doctorStep.includes(`First ${repair}, then start it with \`cotal up --root ${realpathSync(root)}\``), shown(doctor));
  check("up refuses the same malformed default seed before startup",
    up.status === 1 && up.stderr.includes(`the channels file ${seed} is not valid JSON`), shown(up));
  rmSync(seed);
  const repaired = run(["doctor", "auth", "--space", "b4b", "--json"]);
  check("once the malformed seed is removed, doctor offers the regular first start",
    repaired.status === 2 && repaired.envelope?.error?.remedy === DOCTOR_HERE, shown(repaired));
}

if (typeof process.getuid === "function" && process.getuid() !== 0) {
  const store = join(realpathSync(root), ".cotal", "nats");
  mkdirSync(store, { mode: 0o500 });
  try {
    const diagnosis = run(["doctor", "auth", "--plain"]);
    const fix = run(["doctor", "auth", "--fix", "--space", "b4b", "--json"]);
    const repair = `chmod -R u+w ${store}`;
    const diagnosisText = diagnosis.stdout + diagnosis.stderr;
    check("bare doctor auth stays partial and names the store repair before the first start",
      diagnosis.status === 4 && diagnosisText.includes(`the broker store ${store} is not writable`) &&
      ["cotal", "pnpm cotal"].some((launcher) => diagnosisText.includes(`${repair}, then start it with \`${launcher} up\``)), shown(diagnosis));
    check("doctor auth --fix keeps AUTH_REQUIRED, names the store repair, and leaves its mode unchanged",
      fix.status === 2 && fix.envelope?.error?.code === "AUTH_REQUIRED" &&
      fix.envelope.error.remedy?.includes(`${repair}, then start it with \`cotal up\``) === true &&
      (statSync(store).mode & 0o777) === 0o500, shown(fix));
  } finally {
    chmodSync(store, 0o700);
    rmSync(store, { recursive: true });
  }
}

// From another folder the step names the prepared root with --root, quoted so a shell reads it back
// as that folder.
const special = join(home, "it's $HOME d");
mkdirSync(special);
const createdSpecial = run(["space", "create", "b4d", "--root", special]);
check("rig: a second space is prepared in a folder whose name a shell would expand", createdSpecial.status === 0, shown(createdSpecial));
const mintElsewhere = run(["auth", "mint", "alice", "--space", "b4d", "--server", server, "--json"]);
const mintRoot = /^start it with `cotal up --server nats:\/\/127\.0\.0\.1:43842 --root (.+)` to create the local static signing trust$/.exec(mintElsewhere.envelope?.error?.remedy ?? "");
const mintPath = mintRoot ? spawnSync("/bin/sh", ["-c", `printf %s ${mintRoot[1]}`], { encoding: "utf8" }).stdout : undefined;
check("mint for a named prepared space elsewhere gives a shell-quoted startup root",
  mintElsewhere.status === 2 && mintElsewhere.envelope?.error?.code === "TARGET_UNAVAILABLE" && mintPath === special, shown(mintElsewhere));
const doctorElsewhere = run(["doctor", "auth", "--space", "b4d", "--json"]);
const elsewhereStep = /^"b4d" is prepared but not started; start it with `cotal up --root (.+)`, then run `cotal doctor auth --space b4d` in that folder$/.exec(doctorElsewhere.envelope?.error?.remedy ?? "");
const shellRead = elsewhereStep ? spawnSync("/bin/sh", ["-c", `printf %s ${elsewhereStep[1]}`], { encoding: "utf8", env: { PATH: process.env.PATH, HOME: "/nonexistent" } }).stdout : undefined;
check("doctor auth --space from another folder refuses AUTH_REQUIRED and names cotal up --root for the prepared root",
  doctorElsewhere.status === 2 && doctorElsewhere.envelope?.error?.code === "AUTH_REQUIRED" && elsewhereStep !== null, shown(doctorElsewhere));
check("a shell reads that --root back as the prepared folder", shellRead !== undefined && existsSync(shellRead) && realpathSync(shellRead) === realpathSync(special), { remedy: doctorElsewhere.envelope?.error?.remedy, shellRead });

if (process.platform !== "win32" && process.getuid?.() !== 0) {
  const control = join(realpathSync(special), ".cotal");
  const before = readdirSync(control).sort();
  const mode = statSync(control).mode & 0o777;
  chmodSync(control, 0o500);
  try {
    const verdict = '"b4d" is prepared but not started';
    const up = run(["up", "--open", "--space", "b4d", "--server", server, "--json"], special);
    const problem = up.envelope?.error?.message?.replace("; nothing was started or written", "") ?? "";
    const remedy = up.envelope?.error?.remedy ?? "";
    check("up refuses a prepared root whose control directory cannot be written",
      up.status === 2 && up.envelope?.error?.code === "PERMISSION_DENIED" && problem.includes(`${control} does not grant this account both write and search access`) && remedy.includes("chmod u+wx "), shown(up));
    const status = run(["status", "--space", "b4d", "--plain"], special);
    check("status keeps the prepared verdict and names the permission repair before startup",
      status.status === 0 && status.stdout.includes(verdict) && status.stdout.includes(`First start blocked: ${problem}. ${remedy}`) && !status.stdout.includes("start it with"), shown(status));
    const ps = run(["ps", "--space", "b4d", "--json"], special);
    check("ps keeps TARGET_UNAVAILABLE and gives the same repair as up",
      ps.status === 2 && ps.envelope?.error?.code === "TARGET_UNAVAILABLE" && ps.envelope.error.message === `${verdict}. First start blocked: ${problem}` && ps.envelope.error.remedy === remedy, shown(ps));
    const doctor = run(["doctor", "auth", "--plain"], special);
    check("bare doctor stays partial and puts the permission repair before startup",
      doctor.status === 4 && doctor.stderr.includes(`${verdict}; ${problem}. First ${remedy}, then start it with`), shown(doctor));
    const namedDoctor = run(["doctor", "auth", "--space", "b4d", "--json"]);
    check("named doctor keeps AUTH_REQUIRED and diagnoses the prepared root from elsewhere",
      namedDoctor.status === 2 && namedDoctor.envelope?.error?.code === "AUTH_REQUIRED" && namedDoctor.envelope.error.remedy?.startsWith(`${verdict}; ${problem}. First ${remedy}, then start it with`) === true, shown(namedDoctor));
    check("diagnostics do not change the control directory mode or add entries",
      (statSync(control).mode & 0o777) === 0o500 && JSON.stringify(readdirSync(control).sort()) === JSON.stringify(before));
  } finally {
    chmodSync(control, mode);
  }
}

{
  const control = join(realpathSync(special), ".cotal");
  const saved = `${control}.saved`;
  const before = readdirSync(control).sort();
  renameSync(control, saved);
  writeFileSync(control, "sentinel\n", { mode: 0o600 });
  const verdict = '"b4d" is prepared but not started';
  const problem = `\`${control}\` is a regular file, not a directory`;
  const repair = "move the file aside and restore the original .cotal directory";
  const target = ["--space", "b4d", "--plain"];
  try {
    const blocked = run(["doctor", "auth", ...target]);
    const next = blocked.stderr.split("Next\n")[1] ?? "";
    check("doctor auth from another folder names the regular file and puts restoration before startup",
      blocked.status === 2 && /Code:\s+AUTH_REQUIRED/.test(blocked.stderr) &&
      ["cotal", "pnpm cotal"].some((launcher) => next.includes(`${problem}. First ${repair}, then start it with \`${launcher} up --root `)), shown(blocked));
    const status = run(["status", ...target]);
    check("status keeps the prepared verdict and gives the file repair in Next",
      status.status === 0 && status.stdout.includes(verdict) && (status.stdout.split("Next\n")[1] ?? "").includes(`${problem}. ${repair}`) && !status.stdout.includes("start it with"), shown(status));
    const ps = run(["ps", ...target]);
    check("ps names the regular file and gives the repair without blaming permissions",
      ps.status === 2 && /Code:\s+TARGET_UNAVAILABLE/.test(ps.stderr) && ps.stderr.includes(problem) && (ps.stderr.split("Next\n")[1] ?? "").includes(repair), shown(ps));
    const components = run(["status", "--components", "--space", "b4d"]);
    const health = components.stdout.split("Component Health")[1] ?? "";
    check("component health still refuses and names the file and repair",
      components.status === 3 && /target\s+refused/.test(health) && health.includes(problem) && health.includes(repair), shown(components));
    check("diagnostics leave both the obstructing file and the saved directory intact",
      lstatSync(control, { throwIfNoEntry: false })?.isFile() === true && readFileSync(control, "utf8") === "sentinel\n" &&
      lstatSync(saved, { throwIfNoEntry: false })?.isDirectory() === true && JSON.stringify(readdirSync(saved).sort()) === JSON.stringify(before));
  } finally {
    rmSync(control);
    renameSync(saved, control);
  }
  for (const [command, code] of [["status", 0], ["ps", 2]] as const) {
    const restored = run([command, ...target]);
    const text = restored.stdout + restored.stderr;
    check(`${command} returns to first-start guidance after the directory is restored`,
      restored.status === code && text.includes(verdict) && ["cotal", "pnpm cotal"].some((launcher) => text.includes(`start it with \`${launcher} up\` in ${special}`)), shown(restored));
  }
}

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
check("an unknown space keeps the JSON refusal code and gives preparation guidance even in another space's root",
  doctorUnknown.status === 2 && doctorUnknown.envelope?.error?.code === "AUTH_REQUIRED" && doctorUnknown.envelope.error.remedy === unknownStep.replaceAll("b4b", "nosuch"), shown(doctorUnknown));

const preview = run(["space", "delete", "b4b", "--dry-run", "--json"]);
check("a delete preview of a prepared space refuses as unavailable, exit 2", preview.status === 2 && preview.envelope?.error?.code === "TARGET_UNAVAILABLE", shown(preview));
check("it says the space is prepared and not running", /"b4b" is prepared and not running/.test(preview.envelope?.error?.message ?? ""), preview.envelope?.error);
check("a space that never ran has no streams, so its remedy names only space forget", /no stack has run for it/.test(preview.envelope?.error?.remedy ?? "") && /cotal space forget b4b/.test(preview.envelope?.error?.remedy ?? "") && !/cotal up/.test(preview.envelope?.error?.remedy ?? ""), preview.envelope?.error);

const damagedRoot = mkdtempSync(join(home, "damaged-"));
const damagedCreate = run(["space", "create", "damaged", "--root", damagedRoot]);
check("rig: create a prepared record to damage", damagedCreate.status === 0, shown(damagedCreate));
const record = join(env.COTAL_HOME, "prepared", `space.${Buffer.from("damaged").toString("hex")}.json`);
writeFileSync(record, "{");
for (const flags of [["--dry-run"], []]) {
  const deletion = run(["space", "delete", "damaged", ...flags, "--json"]);
  const error = deletion.envelope?.error;
  check(`delete ${flags.join(" ") || "apply"} names the damaged file and its recovery without contacting a broker`,
    deletion.status === 1 && error?.code === "SCHEMA_INVALID" && error.message?.includes(record) === true && error.message.includes("no broker was contacted") &&
    error.remedy?.includes("cotal space forget damaged") === true && readFileSync(record, "utf8") === "{", shown(deletion));
}
const forgetDamaged = run(["space", "forget", "damaged", "--json"]);
check("the recovery command removes the damaged record", forgetDamaged.status === 0 && !existsSync(record), shown(forgetDamaged));

const unknown = run(["space", "delete", "nosuch", "--dry-run", "--json"]);
check("control: a name nothing records is still not found, exit 2", unknown.status === 2 && unknown.envelope?.error?.code === "TARGET_NOT_FOUND", shown(unknown));
const addedOffline = run(["space", "add", "offline", "--server", server, "--root", noSpace, "--force"]);
const manualConflict = run(["space", "create", "new-local", "--plain"], noSpace);
check("space create at a manual registration's root points to its broker host and exact registration",
  addedOffline.status === 0 && manualConflict.status === 2 && /Code: +CONFLICT/.test(manualConflict.stderr) &&
    manualConflict.stderr.includes('to create "new-local", choose another folder with --root <dir>') &&
    manualConflict.stderr.includes("space show offline --plain`") && !manualConflict.stderr.includes("space forget") &&
    !/`(?:pnpm )?cotal up`/.test(manualConflict.stderr), shown(manualConflict));
const offline = run(["space", "delete", "offline", "--dry-run", "--json"]);
check("a failed deletion preview names the recorded broker and how to inspect its registration",
  addedOffline.status === 0 && offline.status === 2 && offline.envelope?.error?.code === "TARGET_UNAVAILABLE" &&
    offline.envelope.error.message?.includes(server) === true && offline.envelope.error.message.includes("no alternate address or identity was tried") &&
    offline.envelope.error.remedy === "inspect the registration with `cotal space show offline`", shown(offline));
const offlineShown = run(["space", "show", "offline", "--plain"]);
check("the recorded registration is still visible and its broker is unreachable",
  offlineShown.status === 0 && offlineShown.stdout.includes(server) && offlineShown.stdout.includes("unreachable"), shown(offlineShown));
check("rig: remove the offline manual registration", run(["space", "forget", "offline"]).status === 0);
const unknownApply = run(["space", "delete", "no-such-space", "--plain"]);
const unknownPreview = run(["space", "delete", "no-such-space", "--dry-run", "--plain"]);
check("noninteractive apply of a missing name gives the same refusal as dry-run without asking for confirmation",
  unknownApply.status === 2 && unknownPreview.status === 2 && unknownApply.stderr === unknownPreview.stderr
    && /Code: +TARGET_NOT_FOUND/.test(unknownApply.stderr) && unknownApply.stderr.includes("no broker was contacted"),
  { apply: shown(unknownApply), preview: shown(unknownPreview) });

const help = run(["help", "space", "delete"]);
check("delete help describes -y without the add text first", help.status === 0 && /a delete must name the exact space/.test(help.stdout) && !/add: skip terminal confirmation/.test(help.stdout), shown(help));

// A second space in this folder named no step for the space already here, and told a caller who
// passed --root to pass --root.
const second = run(["space", "create", "b4c", "--root", root, "--json"]);
check("space create in a folder another space holds is CONFLICT, exit 2, naming the steps for that space",
  second.status === 2 && second.envelope?.error?.code === "CONFLICT"
    && second.envelope.error.remedy === 'inspect what uses this folder with `cotal space show b4b --json`; to create "b4c", choose another folder with --root <dir>', second.envelope?.error);

// --yes belongs to space delete too; the refusal named space add alone.
const forgetYes = run(["space", "forget", "b4b", "--yes"]);
check("space forget --yes names space add and space delete as the commands that take it, exit 1",
  forgetYes.status === 1 && forgetYes.stderr.startsWith("✗ --yes is taken by `cotal space add` and `cotal space delete` only\n"), shown(forgetYes));

const forgot = run(["space", "forget", "b4b"]);
check("forget says the prepared space is not running", forgot.status === 0 && /prepared, not running/.test(forgot.stdout) && !/never started/.test(forgot.stdout), shown(forgot));

// Two open registrations in one folder need a space name, not a change of directory.
const workshop = mkdtempSync(join(home, "workshop-"));
const workshops = ["workshop-a", "workshop-b"];
for (const [i, space] of workshops.entries()) {
  const added = run(["space", "add", space, "--mode", "open", "--server", `nats://127.0.0.1:${43026 + i}`, "--root", ".", "--force", "--yes"], workshop);
  check(`rig: ${space} is registered open at the shared root`, added.status === 0, shown(added));
}
const sharedConflict = run(["space", "create", "new-local", "--json"], workshop);
const sharedRemedy = sharedConflict.envelope?.error?.remedy ?? "";
check("a shared manual root names each registration in the JSON remedy without suggesting local startup",
  sharedConflict.status === 2 && sharedConflict.envelope?.error?.code === "CONFLICT" &&
    workshops.every((space) => sharedRemedy.includes(`\`cotal space show ${space} --json\``)) &&
    !sharedRemedy.includes("`cotal up`") && !sharedRemedy.includes("space forget"), shown(sharedConflict));
const unchecked = run(["doctor", "auth", "--space", "workshop-a", "--json"], workshop);
check("doctor keeps the local open-space no-op and warns that the mode was not checked",
  unchecked.status === 0 && unchecked.envelope?.outcome === "no-op" && unchecked.envelope.result?.credentialScope === "open-space" &&
  unchecked.envelope.result.repair?.attempted === false && unchecked.envelope.warnings?.some(w => w.code === "MODE_NOT_CHECKED") === true, shown(unchecked));
const child = join(workshop, "subdir"), sibling = `${workshop}-other`;
for (const dir of [child, sibling]) mkdirSync(dir, { mode: 0o700 });
const nested = run(["doctor", "auth", "--space", "workshop-a", "--json"], child);
check("doctor from a subfolder reports the named open registration's root and keeps the unchecked warning without creating .cotal",
  nested.status === 0 && nested.envelope?.target?.root === realpathSync(workshop) && nested.envelope?.result?.credentialScope === "open-space" &&
  nested.envelope.result.repair?.attempted === false && nested.envelope.warnings?.some(w => w.code === "MODE_NOT_CHECKED") === true &&
  [workshop, child].every(dir => !existsSync(join(dir, ".cotal"))), shown(nested));
const elsewhere = run(["doctor", "auth", "--space", "workshop-a", "--json"], sibling);
check("doctor refuses a named open registration from a sibling with a shared path prefix",
  elsewhere.status === 2 && elsewhere.envelope?.error?.code === "AUTH_REQUIRED", shown(elsewhere));
for (const fix of [[], ["--fix"]]) {
  const command = ["doctor", "auth", ...fix];
  const bare = run([...command, "--plain"], workshop);
  check(`${command.join(" ")} refuses ambiguity and names both choices instead of another directory`,
    bare.status === 2 && /TARGET_AMBIGUOUS/.test(bare.stderr) && workshops.every((space) => bare.stderr.includes(space))
      && bare.stderr.includes(`cotal ${command.join(" ")} --space workshop-a`) && !bare.stderr.includes("in a space's root folder"), shown(bare));
  for (const space of workshops) {
    const explicit = run([...command, "--space", space, "--plain"], workshop);
    check(`${command.join(" ")} --space ${space} reports the unchecked mode without claiming what the broker enforces`,
      explicit.status === 0 && explicit.stdout.includes("Credential check skipped") && explicit.stdout.replace(/\s+/g, " ").includes(`Space: ${space}`) &&
      !explicit.stdout.includes("authenticates no one") && explicit.stderr.includes(`cotal space show ${space}`), shown(explicit));
  }
}

{
  const record = join(env.COTAL_HOME, "meshes", `${spaceSegment("workshop-a")}.json`);
  writeFileSync(record, '{"space":\n');
  const recovery = "restore the record from backup, or remove it with `cotal space forget workshop-a`";
  const barePlain = run(["doctor", "auth", "--plain"], workshop);
  const namedPlain = run(["doctor", "auth", "--plain", "--space", "workshop-a"], workshop);
  check("doctor gives the same damaged registration refusal in plain output with and without --space",
    barePlain.status === 1 && namedPlain.status === 1 && namedPlain.stderr === barePlain.stderr &&
    namedPlain.stderr.includes(record) && namedPlain.stderr.includes("SCHEMA_INVALID") && namedPlain.stderr.includes(recovery), [barePlain, namedPlain].map(shown));
  const bareJson = run(["doctor", "auth", "--json"], workshop);
  const namedJson = run(["doctor", "auth", "--json", "--space", "workshop-a"], workshop);
  check("doctor gives the same damaged registration refusal in JSON with and without --space",
    bareJson.status === 1 && namedJson.status === 1 && namedJson.stdout === bareJson.stdout &&
    namedJson.envelope?.outcome === "refused" && namedJson.envelope.error?.code === "SCHEMA_INVALID" &&
    namedJson.envelope.error.message?.includes(record) === true && namedJson.envelope.error.remedy === recovery, [bareJson, namedJson].map(shown));
}

finish();
process.exit(process.exitCode ?? 0);
