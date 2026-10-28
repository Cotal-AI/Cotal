/**
 * `cotal up` refuses an invalid flag value or combination as usage, exit 1, before anything runs.
 * `--max-sessions 0`, `--max-sessions abc` and an unknown `--restore-only` value used to exit 3,
 * "Outcome unconfirmed", which tells a script the run may have had an effect. `--dry-run` without
 * `-f` used to start a real stack. A `--max-file-store` below 67108865, one byte more than the 64 MiB
 * the space's membership bucket reserves, is refused the same way.
 *
 * The same holds where `up` would otherwise start something it cannot stand behind. A prepared root
 * given an option the controller stack has no route for refuses UNSUPPORTED instead of starting the
 * legacy launcher, while a stopped root that launcher registered with no prepared record keeps it for
 * that option. A broker address another program holds refuses CONFLICT instead of launching a
 * broker that exits on its bind. `up -f` on a root that holds a controller stack refuses CONFLICT
 * instead of starting a manifest stack beside it. An empty `--store-dir`, which used to open the
 * default store, and one that starts with a `~` no shell expanded, which made a folder named `~`,
 * refuse USAGE_INVALID on `up` and `clean`, the second naming the absolute path.
 *
 * Driven through the built binary in a sandboxed HOME, XDG_CONFIG_HOME and COTAL_HOME, from empty
 * folders outside them. Nothing is started; each refusal comes from validation. A `--server` that no
 * local broker can serve, a host name included, is refused the same way in an unprepared and a
 * prepared folder, as the short classified report with an example on the port passed. In the home
 * folder, whose `.cotal` holds the machine's own records, `up` refuses CONFLICT and writes nothing
 * there, and `down` and `down --dry-run` there find no stack. A fresh folder under the home makes its
 * own `.cotal` on a bare `up`, and removes it when a later check refuses, under a home that holds a
 * stack as well, leaving that home's records as they were, while `up -f` there refuses CONFLICT and
 * writes nothing. A bare `up` in a new project
 * names its space after the folder: two sibling folders get their own names, `--space` and a project
 * above the folder keep theirs, and a folder name that is no valid space name, a name another folder
 * holds, or a selection whose folder was moved refuses before anything is written. A bare `up` whose
 * folder names a space that runs from another folder refuses CONFLICT naming `cotal up --space <name>`
 * and the `cotal down` in that folder. In a prepared folder whose broker store
 * this account cannot write, `up` refuses PERMISSION_DENIED naming the store and the `chmod` that
 * fixes it, where the broker used to exit naming the cause only in its log, and status names the same
 * step in place of `cotal up`. A `server.conf` that is a symlink, and a trust record this account
 * cannot read, are refused PERMISSION_DENIED the same way, each naming its path and its step. Every broker address the cells after
 * those use is held by a loopback listener that never answers NATS, so a regression still cannot
 * start a broker there. On Linux, two cells hold one by a client connection's local end instead,
 * open and then in TIME-WAIT, with nothing listening, and need the refusal to say which.
 * A refusal that names the whole fix, such as a nats:// address where the root's recorded policy or
 * --tls-cert serves TLS, prints no help after it. Those cells need `openssl` on PATH.
 * `up -f` binds one local broker, so a comma-separated address list, from `broker.servers`, from
 * `--server`, or beside `broker.host`, refuses `USAGE_INVALID` and names that source. A single
 * address from each source prints the dry-run plan, and `topology view -f` still accepts the list.
 * Those cells use ports no local broker can serve, so a regression starts nothing.
 *
 * Run: pnpm smoke:up-usage-refusal
 */
import { spawn, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { connect, createServer, type AddressInfo } from "node:net";
import { accessSync, chmodSync, constants, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { assertSmokeSandboxDown, createSuite, freePort, recordSmokeSandbox, type SmokeSandboxAnchor } from "@cotal-ai/smoke-kit";

const BIN = join(import.meta.dirname, "..", "..", "..", "bin", "dist", "cotal.js");
if (!existsSync(BIN)) {
  console.error(`✗ ${BIN} missing - build first: pnpm --filter cotal-ai... build`);
  process.exit(1);
}

interface Envelope { outcome?: string; target?: { root?: string; space?: string; heldBy?: string }; error?: { code?: string; message?: string; remedy?: string } }
const { readStackJournal, writeStackJournal } = await import("../src/lib/stack-journal.js");

const { check, finish } = createSuite();
const home = mkdtempSync(join(tmpdir(), "cotal-up-usage-home-"));
const folder = mkdtempSync(join(tmpdir(), "cotal-up-usage-cwd-"));
const roots = ["unprepared", "journal"].map((name) => realpathSync(mkdtempSync(join(tmpdir(), `cotal-up-usage-${name}-`))));
const [unprepared, journalRoot] = roots as [string, string];
process.on("exit", () => { for (const dir of [home, folder, ...roots]) rmSync(dir, { recursive: true, force: true }); });

const HOST_ENV = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith("COTAL_") && k !== "FORCE_COLOR" && k !== "NO_COLOR"));
const env = { ...HOST_ENV, HOME: home, USERPROFILE: home, XDG_CONFIG_HOME: join(home, ".config"), COTAL_HOME: join(home, ".cotal"), COTAL_SKIP_CONNECTOR_SEED: "1", NO_COLOR: "1" };
const anchors = new Map<string, SmokeSandboxAnchor>();
/** Record `at`, which already holds its `.cotal`, as a root a down may run in. */
const sandbox = (at: string) => anchors.set(at, recordSmokeSandbox({ root: at, cotalHome: env.COTAL_HOME, xdgConfigHome: env.XDG_CONFIG_HOME }));
const run = (args: string[], cwd = folder) => {
  assertSmokeSandboxDown(anchors.get(cwd), args, { cwd, env });
  const r = spawnSync(process.execPath, [BIN, ...args], { cwd, env, encoding: "utf8", timeout: 120_000 });
  let envelope: Envelope | undefined;
  try { envelope = JSON.parse(r.stdout ?? "") as Envelope; } catch { envelope = undefined; }
  return { status: r.status, stdout: r.stdout ?? "", stderr: r.stderr ?? "", envelope };
};
const shown = (r: ReturnType<typeof run>) => ({ status: r.status, stdout: r.stdout.slice(0, 900), stderr: r.stderr.slice(0, 900) });

const cases: { args: string[]; message: RegExp }[] = [
  { args: ["-d", "--foreground"], message: /choose --foreground or --detach, not both/ },
  { args: ["--max-sessions", "0"], message: /--max-sessions must be a positive integer/ },
  { args: ["--max-sessions", "abc"], message: /--max-sessions must be a positive integer/ },
  { args: ["--max-file-store", "0"], message: /--max-file-store must be a positive integer/ },
  { args: ["--max-file-store", "1"], message: /--max-file-store 1 is below 67108865 bytes, the least the space's streams start on: its membership bucket reserves 67108864 bytes/ },
  { args: ["--max-file-store", "50000000"], message: /--max-file-store 50000000 is below 67108865 bytes/ },
  { args: ["--max-file-store", "67108864"], message: /--max-file-store 67108864 is below 67108865 bytes/ },
  { args: ["--restore", join(folder, "nonexistent"), "--restore-only", "full"], message: /--restore-only takes registry/ },
  { args: ["--restore-only", "registry"], message: /require --restore/ },
  // Without -f there is no plan to print, and the launch used to start a real stack.
  { args: ["--dry-run"], message: /--dry-run previews a manifest launch and needs -f/ },
  { args: ["--server", "nats://127.0.0.1:1", "--dry-run"], message: /--dry-run previews a manifest launch and needs -f/ },
];
for (const { args, message } of cases) {
  const json = run(["up", ...args, "--json"]);
  check(`up ${args.join(" ")} --json is one USAGE_INVALID refusal, exit 1`, json.status === 1 && json.envelope?.outcome === "refused" && json.envelope.error?.code === "USAGE_INVALID" && message.test(json.envelope.error.message ?? ""), shown(json));
  const text = run(["up", ...args]);
  check(`up ${args.join(" ")} prints the error and the help on stderr, nothing on stdout, exit 1`, text.status === 1 && text.stdout === "" && message.test(text.stderr) && /Usage/.test(text.stderr), shown(text));
}

const servers: { server: string; message: RegExp; example: string }[] = [
  { server: "http://127.0.0.1:43131", message: /--server must be a nats:\/\/ or tls:\/\/ URL/, example: "--server nats://127.0.0.1:43131" },
  { server: "nats://localhost:43131", message: /--server names the host localhost/, example: "--server nats://127.0.0.1:43131" },
  { server: "tls://broker.example:4443", message: /--server names the host broker\.example/, example: "--server tls://127.0.0.1:4443" },
  { server: "nats://127.0.0.1", message: /--server names no port/, example: "--server nats://127.0.0.1:<port>" },
  { server: "nats://127.0.0.1:43131/path", message: /--server must be one broker URL without a path, query or fragment/, example: "--server nats://127.0.0.1:43131" },
  { server: "nats://127.0.0.1:43131?a=1", message: /--server must be one broker URL without a path, query or fragment/, example: "--server nats://127.0.0.1:43131" },
  { server: "nats://127.0.0.1:43131#a", message: /--server must be one broker URL without a path, query or fragment/, example: "--server nats://127.0.0.1:43131" },
];
for (const { server, message, example } of servers) {
  const text = run(["up", "--server", server]);
  check(`up --server ${server} is the classified USAGE_INVALID report with no help, exit 1, giving ${example}`, text.status === 1 && text.stdout === "" && message.test(text.stderr) && /Code:\s+USAGE_INVALID/.test(text.stderr) && text.stderr.includes(example) && !/Usage|Options/.test(text.stderr), shown(text));
}

// An empty --store-dir used to open the default store, and a ~ no shell expanded made a folder named ~.
const storeDirs = [
  { value: "", message: "--store-dir is empty; the command did not run", remedy: "name the store directory, or omit --store-dir to use the default store" },
  ...["~", "~/stores/x"].map((value) => ({ value, message: `--store-dir ${JSON.stringify(value)} starts with ~, which no shell expanded, so it names a folder called ~ in ${realpathSync(folder)}; the command did not run`, remedy: `name the absolute path: --store-dir ${join(home, value.slice(2))}` })),
];
for (const { value, message, remedy } of storeDirs) {
  const json = run(["up", "--store-dir", value, "--json"]);
  check(`up --store-dir ${JSON.stringify(value)} --json is one USAGE_INVALID refusal, exit 1, with its remedy`, json.status === 1 && json.envelope?.error?.code === "USAGE_INVALID" && json.envelope.error.message === message && json.envelope.error.remedy === remedy, shown(json));
  const clean = run(["clean", "store", "--dry-run", "--store-dir", value]);
  check(`clean store --store-dir ${JSON.stringify(value)} refuses the same way, exit 1, with no help`, clean.status === 1 && clean.stderr.includes(message) && clean.stderr.includes(remedy) && !/Usage|Options/.test(clean.stderr), shown(clean));
}

check("nothing was written in the folder", readdirSync(folder).length === 0, readdirSync(folder));

const prepared = mkdtempSync(join(tmpdir(), "cotal-up-usage-prepared-"));
process.on("exit", () => rmSync(prepared, { recursive: true, force: true }));
const created = run(["space", "create", "upusage", "--root", prepared, "--json"]);
check("space create prepares a folder", created.status === 0, shown(created));
const named = run(["up", "--server", "nats://localhost:43131", "--json"], prepared);
check("in a prepared folder a host name is the same USAGE_INVALID refusal, exit 1, naming 127.0.0.1", named.status === 1 && named.envelope?.error?.code === "USAGE_INVALID" && /names the host localhost/.test(named.envelope.error.message ?? "") && named.stdout.includes("--server nats://127.0.0.1:43131"), shown(named));
check("it wrote no stack journal", !existsSync(join(prepared, ".cotal", "stack-controller.json")), readdirSync(join(prepared, ".cotal")));
// A broker store this account cannot write is named before anything starts; the broker named it only
// in its own log. Status names the same step in place of starting the space.
if (process.platform !== "win32" && process.getuid?.() !== 0) {
  const jetstream = join(prepared, ".cotal", "nats", "jetstream");
  mkdirSync(jetstream, { recursive: true, mode: 0o700 });
  chmodSync(jetstream, 0o500);
  const blocked = run(["up", "--server", "nats://127.0.0.1:1", "--json"], prepared), status = run(["status", "--json"], prepared);
  chmodSync(jetstream, 0o700);
  const step = `make it writable by you, for example with chmod -R u+w ${jetstream}`;
  check("up over a broker store it cannot write refuses PERMISSION_DENIED, exit 2, naming the store and chmod",
    blocked.status === 2 && blocked.envelope?.error?.code === "PERMISSION_DENIED" && blocked.envelope.error.message === `the broker store ${jetstream} is not writable by this account (EACCES), so the broker cannot start JetStream there; nothing was started or written` && blocked.stdout.includes(step), shown(blocked));
  check("it wrote no stack journal there either", !existsSync(join(prepared, ".cotal", "stack-controller.json")));
  const hints = (JSON.parse(status.stdout || "{}") as { result?: { hints?: string[] } }).result?.hints ?? [];
  check("status there names the store and the same step, not cotal up",
    hints.includes(`the broker store ${jetstream} is not writable by this account (EACCES), so the broker cannot start JetStream there; ${step}`) && !hints.some((hint) => hint.includes("start it with `cotal up`")), shown(status));
  // A folder this account cannot open is refused the same way, where up used to crash on it with a raw
  // EACCES stack. The store hides its jetstream then, so it is the folder named. u+w would leave it shut.
  const store = dirname(jetstream);
  for (const [closed, mode] of [[store, 0o000], [jetstream, 0o000]] as const) {
    chmodSync(closed, mode);
    const shut = run(["up", "--server", "nats://127.0.0.1:1", "--json"], prepared), shutStatus = run(["status", "--json"], prepared);
    const shutStep = `make it readable and writable by you, for example with chmod -R u+rwX ${closed}`;
    const shutHints = (JSON.parse(shutStatus.stdout || "{}") as { result?: { hints?: string[] } }).result?.hints ?? [];
    check(`up over ${closed === store ? "a store" : "a jetstream folder"} it cannot open refuses PERMISSION_DENIED, exit 2, naming it and chmod -R u+rwX, and status names the same step`,
      shut.status === 2 && shut.envelope?.error?.code === "PERMISSION_DENIED" && shut.envelope.error.message === `the broker store ${closed} is not readable or writable by this account (EACCES), so the broker cannot start JetStream there; nothing was started or written` && shut.stdout.includes(shutStep) && !shut.stderr.includes("node:fs") &&
        shutHints.some((hint) => hint.includes(shutStep)), shown(shut));
    spawnSync("chmod", ["-R", "u+rwX", closed]);
    check(`running that step verbatim opens ${closed === store ? "the store" : "the jetstream folder"} again`, (() => { try { accessSync(jetstream, constants.R_OK | constants.W_OK | constants.X_OK); return true; } catch { return false; } })());
  }
  // A root whose name a shell would split or substitute, here a backtick and a space, is quoted in the
  // step, so the step pasted into a shell changes that folder and nothing else.
  const quoteParent = mkdtempSync(join(tmpdir(), "cotal-up-usage-quote-"));
  process.on("exit", () => rmSync(quoteParent, { recursive: true, force: true }));
  const odd = join(quoteParent, "W`q d"), oddJetstream = join(odd, ".cotal", "nats", "jetstream");
  mkdirSync(odd);
  run(["space", "create", "upquote", "--root", odd, "--json"]);
  mkdirSync(oddJetstream, { recursive: true, mode: 0o700 });
  chmodSync(oddJetstream, 0o500);
  const quoted = run(["up", "--server", "nats://127.0.0.1:1", "--json"], odd);
  const command = `chmod -R u+w '${oddJetstream}'`;
  check("the step quotes a store path holding a backtick and a space",
    quoted.status === 2 && quoted.envelope?.error?.code === "PERMISSION_DENIED" && quoted.envelope.error.remedy === `make it writable by you, for example with ${command}`, shown(quoted));
  const ran = spawnSync("sh", ["-c", command], { cwd: odd, encoding: "utf8" });
  check("that step run by a shell makes the store writable", ran.status === 0 && (() => { try { accessSync(oddJetstream, constants.W_OK | constants.X_OK); return true; } catch { return false; } })(), { status: ran.status, stderr: ran.stderr });
}

// A broker configuration up cannot write, such as a symlink in its place, and a trust record it
// cannot read are each refused by name before anything starts, where up used to exit 3 saying started
// members were kept. The first refused up has already written the space's trust in this folder.
if (process.platform !== "win32" && process.getuid?.() !== 0) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "cotal-up-usage-conf-")));
  process.on("exit", () => rmSync(root, { recursive: true, force: true }));
  const createdConf = run(["space", "create", "upconf", "--root", root, "--json"]);
  const conf = join(root, ".cotal", "auth", "server.conf"), outside = join(root, "outside.txt");
  writeFileSync(outside, "# not a broker configuration\n");
  mkdirSync(join(root, ".cotal", "auth"), { recursive: true, mode: 0o700 });
  symlinkSync(outside, conf);
  const linked = run(["up", "--server", "nats://127.0.0.1:1", "--json"], root);
  check("up over a server.conf that is a symlink refuses PERMISSION_DENIED, exit 2, naming it and the mv that moves it aside",
    createdConf.status === 0 && linked.status === 2 && linked.envelope?.error?.code === "PERMISSION_DENIED" && (linked.envelope.error.message ?? "").includes(`the broker configuration ${conf} is a symlink, so up cannot write it`)
      && linked.envelope.error.remedy === `move it aside, as mv ${conf} ${conf}.old does, then run cotal up again, which writes it from the space's trust`, shown(linked));
  check("the link and the file it names are left as they were", lstatSync(conf).isSymbolicLink() && readFileSync(outside, "utf8") === "# not a broker configuration\n");
  const trust = join(root, ".cotal", "auth", "broker.json");
  check("rig: that up wrote the space's trust record", existsSync(trust));
  chmodSync(trust, 0o000);
  const unreadable = run(["up", "--server", "nats://127.0.0.1:1", "--json"], root);
  chmodSync(trust, 0o600);
  check("up over a trust record this account cannot read refuses PERMISSION_DENIED, exit 2, with the chmod that makes it readable",
    unreadable.status === 2 && unreadable.envelope?.error?.code === "PERMISSION_DENIED" && (unreadable.envelope.error.message ?? "").includes(`the space's trust record ${trust} cannot be read by this account (EACCES)`)
      && unreadable.envelope.error.remedy === `make it readable by you again, as chmod 600 ${trust} does, then run cotal up again; it holds the space's keys, so keep it`, shown(unreadable));
}

// Port 1 cannot be bound, so a regression here starts no usable broker.
const homeUp = run(["up", "--server", "nats://127.0.0.1:1", "--json"], home);
check("up in the home folder is one CONFLICT refusal, exit 2, naming a project folder", homeUp.status === 2 && homeUp.envelope?.error?.code === "CONFLICT" && /is your home folder/.test(homeUp.envelope.error.message ?? "") && /space create <space> --root <dir>/.test(homeUp.stdout), shown(homeUp));
check("it wrote no persona, pidfile or store in the home's .cotal", !existsSync(join(home, ".cotal", "agents")) && !existsSync(join(home, ".cotal", "nats.pid")) && !existsSync(join(home, ".cotal", "nats")), existsSync(join(home, ".cotal")) ? readdirSync(join(home, ".cotal")) : []);
// With no stack there and none started or registered on this machine, down and its preview say
// there is nothing to stop or preview, and name `cotal up` in a project as status does.
sandbox(home);
const homeDown = run(["down", "--yes"], home);
check("down --yes in a home with no stack is TARGET_NOT_FOUND, nothing to stop, and names `cotal up` in a project", homeDown.status === 2 && /there is no stack at this folder's root, and this machine has no stack started or registered, so there is nothing to stop/.test(homeDown.stderr) && homeDown.stderr.includes("run `cotal up` in a project"), shown(homeDown));
const homePreview = run(["down", "--dry-run", "--json"], home);
check("down --dry-run in a home with no stack is TARGET_NOT_FOUND, nothing to preview, and names `cotal up` in a project", homePreview.status === 2 && homePreview.envelope?.error?.code === "TARGET_NOT_FOUND" && /no stack started or registered, so there is nothing to preview/.test(homePreview.envelope.error.message ?? "") && homePreview.envelope.error.remedy === "run `cotal up` in a project", shown(homePreview));

// A fresh folder under the home, whose only .cotal above it is the home's, becomes its own project
// root on a bare up, also under a home that holds a stack. A run refused before it writes there leaves
// the folder as it was. A manifest start there still needs a prepared folder.
if (process.platform !== "win32") {
  mkdirSync(join(home, ".cotal"), { recursive: true, mode: 0o700 });
  const nested = join(home, "Desktop", "fresh");
  mkdirSync(nested, { recursive: true, mode: 0o755 });
  const nestedRecords = join(realpathSync(nested), ".cotal");
  const homeWrites = () => ["agents", "nats", "auth"].filter((name) => existsSync(join(home, ".cotal", name)));
  const runtimeUp = run(["up", "--runtime", "nosuch", "--server", "nats://127.0.0.1:1"], nested);
  check("a bare up in a fresh folder under the home makes the folder's own .cotal and reaches its own checks", runtimeUp.status === 2 && /Code:\s+DEPENDENCY_UNAVAILABLE/.test(runtimeUp.stderr) && runtimeUp.stderr.includes(`made ${nestedRecords} for this folder's records; the machine's home .cotal was not used`), shown(runtimeUp));
  check("that refused up removed the .cotal it made and wrote nothing in the home's", !existsSync(nestedRecords) && homeWrites().length === 0, homeWrites());
  const inherited = "this folder inherits the machine's home .cotal; up did not start a stack in that home root";
  const prepare = "prepare this folder with cotal space create <space> --root ., then run cotal up again from this folder";
  const manifestUp = run(["up", "-f", "cotal.yaml", "--json"], nested);
  check("up -f there still refuses CONFLICT, exit 2, naming space create and up from the folder, and writes nothing", manifestUp.status === 2 && manifestUp.envelope?.error?.code === "CONFLICT" && manifestUp.envelope.error.message === inherited && manifestUp.envelope.error.remedy === prepare && !existsSync(nestedRecords), shown(manifestUp));
  const { findMesh, recordMesh, removeMesh } = await import("@cotal-ai/workspace");
  process.env.COTAL_HOME = join(home, ".cotal");
  recordMesh({ space: "homestack", server: "nats://127.0.0.1:1", root: home, mode: "auth", ts: new Date().toISOString() });
  const homeEntry = JSON.stringify(findMesh("homestack"));
  const holdsUp = run(["up", "--runtime", "nosuch", "--server", "nats://127.0.0.1:1", "--json"], nested);
  const holdsManifest = run(["up", "-f", "cotal.yaml", "--json"], nested);
  const homeAfter = JSON.stringify(findMesh("homestack"));
  removeMesh("homestack");
  delete process.env.COTAL_HOME;
  check("under a home that holds a stack, a bare up there starts the folder's own space and reaches its own checks",
    holdsUp.status === 2 && holdsUp.envelope?.error?.code === "DEPENDENCY_UNAVAILABLE" && holdsUp.envelope.target?.space === "fresh" && holdsUp.envelope.target.root === realpathSync(nested), shown(holdsUp));
  check("it removed the .cotal it made and left the home's registration and records as they were", !existsSync(nestedRecords) && homeAfter === homeEntry && homeWrites().length === 0, { homeEntry, homeAfter, writes: homeWrites() });
  check("up -f there still refuses CONFLICT the same way", holdsManifest.status === 2 && holdsManifest.envelope?.error?.code === "CONFLICT" && holdsManifest.envelope.error.message === inherited && holdsManifest.envelope.error.remedy === prepare && !existsSync(nestedRecords), shown(holdsManifest));
}

// A bare up in a new project names its space after the folder. `--runtime nosuch` stops each start
// at its runtime check, after the space is resolved and before anything is started.
if (process.platform !== "win32") {
  const desktop = realpathSync(join(home, "Desktop"));
  const project = (...names: string[]) => { const dir = join(desktop, ...names); mkdirSync(dir, { recursive: true, mode: 0o755 }); return dir; };
  const records = (dir: string) => existsSync(join(dir, ".cotal"));
  const probe = ["--runtime", "nosuch", "--server", "nats://127.0.0.1:1", "--json"];
  const resolved = (r: ReturnType<typeof run>, space: string) => r.status === 2 && r.envelope?.error?.code === "DEPENDENCY_UNAVAILABLE" && r.envelope.target?.space === space;
  const named = "up names a new project's space after its folder, and";
  for (const name of ["alpha", "beta"]) {
    const dir = project(name);
    const sibling = run(["up", ...probe], dir);
    check(`a bare up in the sibling folder ${name} starts the space ${name} and leaves the folder as it was when refused`, resolved(sibling, name) && !records(dir), shown(sibling));
  }
  const spaced = project("My Project");
  const invalid = run(["up", "--server", "nats://127.0.0.1:1", "--json"], spaced);
  check("a folder name that is no valid space name refuses USAGE_INVALID, exit 1, naming --space, and writes nothing",
    invalid.status === 1 && invalid.envelope?.error?.code === "USAGE_INVALID" && invalid.envelope.target?.space === undefined && invalid.envelope.error.remedy === "name the space with cotal up --space <name>"
      && invalid.envelope.error.message === `${named} the folder name "My Project" cannot be one: a space name is 1 to 64 letters, digits, underscores or hyphens, which \`cotal up\` needs to start it; nothing was started or written` && !records(spaced), shown(invalid));
  const invalidText = run(["up", "--server", "nats://127.0.0.1:1"], spaced);
  check("its text form is the refusal and the --space step, without the help", invalidText.status === 1 && invalidText.stdout === ""
    && invalidText.stderr === `✗ ${invalid.envelope?.error?.message}\n  name the space with cotal up --space <name>\n` && !records(spaced), shown(invalidText));
  const override = run(["up", "--space", "custom", ...probe], spaced);
  check("--space names the space there", resolved(override, "custom") && !records(spaced), shown(override));
  const { recordMesh, removeMesh } = await import("@cotal-ai/workspace");
  process.env.COTAL_HOME = join(home, ".cotal");
  const gammaRoot = realpathSync(folder);
  recordMesh({ space: "gamma", server: "nats://127.0.0.1:1", root: gammaRoot, mode: "auth", ts: new Date().toISOString() });
  const registered = run(["up", "--server", "nats://127.0.0.1:1", "--json"], project("gamma"));
  removeMesh("gamma");
  delete process.env.COTAL_HOME;
  check("a folder name another folder registered refuses CONFLICT, exit 2, naming --space, and writes nothing",
    registered.status === 2 && registered.envelope?.error?.code === "CONFLICT" && registered.envelope.target?.heldBy === gammaRoot
      && registered.envelope.error.message === `${named} "gamma" is already registered at nats://127.0.0.1:1 for ${gammaRoot}; nothing was started or written`
      && registered.envelope.error.remedy === "name this folder's space with cotal up --space <name>, naming one this machine does not use; cotal space lists the names in use" && !records(join(desktop, "gamma")), shown(registered));
  const deltaHome = realpathSync(mkdtempSync(join(tmpdir(), "cotal-up-usage-delta-")));
  process.on("exit", () => rmSync(deltaHome, { recursive: true, force: true }));
  const preparedDelta = run(["space", "create", "delta", "--root", "."], deltaHome);
  const prepared = run(["up", "--server", "nats://127.0.0.1:1", "--json"], project("delta"));
  check("a folder name another folder prepared refuses CONFLICT the same way and writes nothing",
    preparedDelta.status === 0 && prepared.status === 2 && prepared.envelope?.error?.code === "CONFLICT" && prepared.envelope.error.message === `${named} "delta" is already prepared for ${deltaHome}; nothing was started or written` && !records(join(desktop, "delta")), shown(prepared));
  const ancestor = project("proj");
  const preparedProj = run(["space", "create", "projspace", "--root", "."], ancestor);
  const below = run(["up", ...probe], project("proj", "sub"));
  check("in a folder of a prepared project, a bare up runs that project's space and writes nothing in the folder",
    preparedProj.status === 0 && resolved(below, "projspace") && below.envelope?.target?.root === ancestor && !records(join(ancestor, "sub")), shown(below));
  const source = project("moved");
  const preparedMoved = run(["space", "create", "moved", "--root", "."], source);
  const selected = run(["use", "moved"], source);
  rmSync(source, { recursive: true });
  const afterMove = run(["up", "--server", "nats://127.0.0.1:1", "--json"], project("epsilon"));
  check("while the selected space's folder no longer exists, a bare up refuses TARGET_UNAVAILABLE and does not start the folder's name",
    preparedMoved.status === 0 && selected.status === 0 && afterMove.status === 2 && afterMove.envelope?.error?.code === "TARGET_UNAVAILABLE"
      && afterMove.envelope.error.message === `the selected space "moved" is prepared in ${source}, which no longer exists, and this folder names no space, so up did not start "epsilon" here` && !records(join(desktop, "epsilon")), shown(afterMove));
  for (const space of ["delta", "projspace", "moved"]) run(["space", "forget", space]);
}

// A loopback listener that accepts and never answers NATS holds every broker address below.
const holder = createServer((socket) => socket.on("error", () => {}));
const held = await new Promise<number>((resolve) => holder.listen(0, "127.0.0.1", () => resolve((holder.address() as AddressInfo).port)));
const started = (root: string) => existsSync(join(root, ".cotal", "nats.pid"));
try {
  // A refusal that names the address to pass is the whole fix, so no help follows it and scrolls the
  // fix away: a nats:// address where the root's recorded policy or --tls-cert serves TLS, and a
  // tls:// address with no TLS to serve.
  {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "cotal-up-usage-tls-")));
    roots.push(root);
    mkdirSync(join(root, ".cotal"));
    const [cert, key] = [join(root, "c.pem"), join(root, "k.pem")];
    const minted = spawnSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", key, "-out", cert, "-days", "2", "-subj", "/CN=127.0.0.1", "-addext", "subjectAltName=IP:127.0.0.1"], { encoding: "utf8" });
    check("openssl mints the certificate the TLS refusals are given", minted.status === 0 && existsSync(cert), { status: minted.status, stderr: minted.stderr?.slice(0, 400) });
    const policyFile = join(root, ".cotal", "broker-policy.json");
    const policy = JSON.stringify({ version: 1, transport: { kind: "tls-required", certFile: cert, keyFile: key } });
    writeFileSync(policyFile, policy);
    const plainRoot = realpathSync(mkdtempSync(join(tmpdir(), "cotal-up-usage-plain-")));
    roots.push(plainRoot);
    mkdirSync(join(plainRoot, ".cotal"));
    for (const { label, args, cwd, message, remedy } of [
      { label: "a nats:// --server in a root whose recorded policy serves TLS", args: ["--server", `nats://127.0.0.1:${held}`], cwd: root, message: `this root serves the broker over TLS (${policyFile}), so --server must be a tls:// address`, remedy: `pass --server tls://127.0.0.1:${held}` },
      { label: "a nats:// --server with --tls-cert", args: ["--server", `nats://127.0.0.1:${held}`, "--tls-cert", cert, "--tls-key", key], cwd: plainRoot, message: "--tls-cert serves the broker over TLS, so --server must be a tls:// address", remedy: `pass --server tls://127.0.0.1:${held}` },
      { label: "a tls:// --server with no TLS configured", args: ["--server", `tls://127.0.0.1:${held}`], cwd: plainRoot, message: "--server names a tls:// address, but no TLS certificate and key are configured", remedy: "serve TLS with --tls-cert <cert.pem> --tls-key <key.pem>, or use a nats:// address" },
    ]) {
      const r = run(["up", ...args], cwd);
      check(`up refuses ${label} with its fix and no help, exit 1`, r.status === 1 && r.stdout === "" && r.stderr.includes(message) && r.stderr.includes(remedy) && !/Usage|Options/.test(r.stderr), shown(r));
    }
    check("the refusals leave the recorded policy as it was and start no broker", readFileSync(policyFile, "utf8") === policy && !started(root) && !started(plainRoot), readdirSync(join(root, ".cotal")));
  }
  if (process.platform !== "win32" && process.getuid?.() !== 0) {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "cotal-up-usage-read-")));
    roots.push(root);
    const store = join(root, ".cotal", "nats");
    run(["space", "create", "readstore", "--root", root, "--json"]);
    mkdirSync(join(store, "jetstream"), { recursive: true, mode: 0o700 });
    chmodSync(store, 0o300);
    try {
      const closed = run(["up", "--server", `nats://127.0.0.1:${held}`, "--json"], root), status = run(["status", "--json"], root);
      const step = `make it readable and writable by you, for example with chmod -R u+rwX ${store}`;
      const hints = (JSON.parse(status.stdout || "{}") as { result?: { hints?: string[] } }).result?.hints ?? [];
      check("a writable store root without read access is refused by name before a stack journal is written",
        closed.status === 2 && closed.envelope?.error?.code === "PERMISSION_DENIED" && closed.envelope.error.message === `the broker store ${store} is not readable by this account (EACCES), so the broker cannot open its store; nothing was started or written` && closed.envelope.error.remedy === step && !existsSync(join(root, ".cotal", "stack-controller.json")), shown(closed));
      check("status names the same read-access step instead of another up", hints.some((hint) => hint.includes(step)) && !hints.some((hint) => hint.includes("start it with `cotal up`")), shown(status));
    } finally { chmodSync(store, 0o700); }
  }
  const rotate = run(["up", "--server", `nats://127.0.0.1:${held}`, "--rotate-sys", "--json"], prepared);
  check("a prepared root refuses an option the controller stack has no route for, UNSUPPORTED, exit 2, naming it and why",
    rotate.status === 2 && rotate.envelope?.outcome === "refused" && rotate.envelope.error?.code === "UNSUPPORTED"
      && /prepared for a controller-owned stack, which has no route for --rotate-sys/.test(rotate.envelope.error.message ?? "") && /run cotal up without --rotate-sys; a first start mints the space's \$SYS creds/.test(rotate.envelope.error.remedy ?? ""), shown(rotate));
  const tls = run(["up", "--server", `tls://127.0.0.1:${held}`, "--tls-cert", join(prepared, "c.pem"), "--tls-key", join(prepared, "k.pem"), "--json"], prepared);
  const tlsRoute = /serve TLS from a manifest whose broker\.servers names a tls:\/\/ address, with cotal up -f <cotal\.yaml> --tls-cert <cert\.pem> --tls-key <key\.pem>/;
  check("…and names both TLS options, the tls:// address and the -f route that serves TLS", tls.status === 2 && tls.envelope?.error?.code === "UNSUPPORTED" && /no route for --tls-cert, --tls-key and --server tls:\/\//.test(tls.envelope.error.message ?? "") && tlsRoute.test(tls.envelope.error.remedy ?? ""), shown(tls));
  // Each TLS form refuses the same way first, so no refusal sends it to another form that refuses too.
  const plainTls = run(["up", "--server", `nats://127.0.0.1:${held}`, "--tls-cert", join(prepared, "c.pem"), "--tls-key", join(prepared, "k.pem"), "--json"], prepared);
  check("…a nats:// address with the TLS pair refuses that way, not by naming tls://", plainTls.status === 2 && plainTls.envelope?.error?.code === "UNSUPPORTED" && /no route for --tls-cert and --tls-key/.test(plainTls.envelope.error.message ?? "") && tlsRoute.test(plainTls.envelope.error.remedy ?? ""), shown(plainTls));
  const bareTls = run(["up", "--server", `tls://127.0.0.1:${held}`, "--json"], prepared);
  check("…and a tls:// address alone refuses that way, not by asking for --tls-cert", bareTls.status === 2 && bareTls.envelope?.error?.code === "UNSUPPORTED" && /no route for --server tls:\/\//.test(bareTls.envelope.error.message ?? "") && tlsRoute.test(bareTls.envelope.error.remedy ?? ""), shown(bareTls));
  check("…without starting the legacy launcher or the controller stack", !started(prepared) && !existsSync(join(prepared, ".cotal", "stack-controller.json")), readdirSync(join(prepared, ".cotal")));
  // A root the legacy launcher started keeps it for such an option: its `up` registered the space in
  // user mode with no prepared record, as a stack stopped without `down` leaves it. Under --json that
  // launcher refuses before it starts anything, so the message tells the two routes apart.
  {
    const legacy = realpathSync(mkdtempSync(join(tmpdir(), "cotal-up-usage-legacy-")));
    roots.push(legacy);
    mkdirSync(join(legacy, ".cotal"), { mode: 0o700 });
    const { recordMesh, removeMesh } = await import("@cotal-ai/workspace");
    process.env.COTAL_HOME = join(home, ".cotal");
    recordMesh({ space: "legacyface", server: `nats://127.0.0.1:${held}`, root: legacy, mode: "user", origin: "up", ts: new Date().toISOString() });
    const face = run(["up", "--space", "legacyface", "--user-auth", "--idp", "https://idp.example.test/api/auth", "--server", `nats://127.0.0.1:${held}`, "--exchange-public-port", String(await freePort()), "--exchange-public-url", "https://mesh.example.test", "--json"], legacy);
    const plainUp = run(["up", "--space", "legacyface", "--user-auth", "--idp", "https://idp.example.test/api/auth", "--server", `nats://127.0.0.1:${held}`, "--json"], legacy);
    removeMesh("legacyface");
    delete process.env.COTAL_HOME;
    const launcher = /retained native launcher, which has no structured or plain receipt/;
    check("a stopped root the legacy launcher registered with no prepared record keeps that launcher for the public face, not UNSUPPORTED for a prepared root",
      face.status === 2 && face.envelope?.error?.code === "UNSUPPORTED" && launcher.test(face.envelope.error.message ?? "") && !started(legacy) && !existsSync(join(legacy, ".cotal", "stack-controller.json")), shown(face));
    check("…and an up that names no legacy-only option there takes that launcher too, writing no stack journal into the root",
      plainUp.status === 2 && plainUp.envelope?.error?.code === "UNSUPPORTED" && launcher.test(plainUp.envelope.error.message ?? "") && !started(legacy) && !existsSync(join(legacy, ".cotal", "stack-controller.json")), shown(plainUp));
  }

  const bind = run(["up", "--server", `nats://127.0.0.1:${held}`], unprepared);
  check("the legacy route refuses a held address CONFLICT, exit 2, naming the address, and launches nothing",
    bind.status === 2 && /CONFLICT/.test(bind.stderr) && new RegExp(`another process holds the broker address 127\\.0\\.0\\.1:${held}`).test(bind.stderr) && !started(unprepared), shown(bind));

  // A port nothing listens on can still refuse the bind: an open client connection's local end holds
  // it, and after that client closes first, its TIME-WAIT holds it for up to a minute. The refusal
  // says which, and a TIME-WAIT's next step is to wait, since no process holds it. Only Linux's
  // kernel table shows it.
  if (process.platform === "linux") {
    const states = (port: number) => ["/proc/net/tcp", "/proc/net/tcp6"].flatMap((table) => readFileSync(table, "utf8").split("\n").slice(1))
      .map((row) => row.trim().split(/\s+/)).filter(([, local]) => local && Number.parseInt(local.slice(local.lastIndexOf(":") + 1), 16) === port).map(([, , , state]) => state);
    const peer = createServer((socket) => socket.on("end", () => socket.end()).on("error", () => {}));
    const at = await new Promise<number>((resolve) => peer.listen(0, "127.0.0.1", () => resolve((peer.address() as AddressInfo).port)));
    const client = connect(at, "127.0.0.1");
    await once(client, "connect");
    const port = client.localPort!;
    const open = run(["up", "--server", `nats://127.0.0.1:${port}`, "--json"], prepared);
    const openLegacy = run(["up", "--server", `nats://127.0.0.1:${port}`], unprepared);
    check("a port an open connection holds with no listener refuses CONFLICT on both routes, saying so and naming no process to stop",
      open.status === 2 && open.envelope?.error?.code === "CONFLICT"
        && (open.envelope.error.message ?? "").includes(`nothing listens at the stack's broker address 127.0.0.1:${port}, but an open connection's local end holds its port (bind failed: address already in use)`)
        && (open.envelope.error.remedy ?? "").includes(`close the connection that holds 127.0.0.1:${port} and run cotal up again`) && !(open.envelope.error.remedy ?? "").includes("stop the process")
        && openLegacy.status === 2 && openLegacy.stderr.includes(`nothing listens at the broker address 127.0.0.1:${port}, but an open connection's local end holds its port`) && !started(unprepared), { open: shown(open), legacy: shown(openLegacy) });
    client.end();
    await once(client, "close");
    peer.close();
    const waiting = states(port);
    check("after the client closed first, its port is in TIME-WAIT with no listener", waiting.length > 0 && waiting.every((state) => state === "06"), waiting);
    const timeWait = run(["up", "--server", `nats://127.0.0.1:${port}`, "--json"], prepared);
    const timeWaitLegacy = run(["up", "--server", `nats://127.0.0.1:${port}`], unprepared);
    check("a port in TIME-WAIT with no listener refuses CONFLICT on both routes, saying so, with waiting as the next step",
      timeWait.status === 2 && timeWait.envelope?.error?.code === "CONFLICT"
        && (timeWait.envelope.error.message ?? "").includes(`nothing listens at the stack's broker address 127.0.0.1:${port}, but a closed connection in TIME-WAIT still holds its port (bind failed: address already in use)`)
        && (timeWait.envelope.error.remedy ?? "").includes("wait up to a minute for the TIME-WAIT to clear and run cotal up again") && !(timeWait.envelope.error.remedy ?? "").includes("stop the process")
        && timeWaitLegacy.status === 2 && timeWaitLegacy.stderr.includes(`nothing listens at the broker address 127.0.0.1:${port}, but a closed connection in TIME-WAIT still holds its port`) && !started(unprepared), { timeWait: shown(timeWait), legacy: shown(timeWaitLegacy) });
  }

  // The scheme's case and a bare trailing slash are not part of the address: a prepared root records
  // one spelling, so a later up in the other is not refused as another address.
  const spelled = realpathSync(mkdtempSync(join(tmpdir(), "cotal-up-usage-spelled-")));
  process.on("exit", () => rmSync(spelled, { recursive: true, force: true }));
  const spelledCreated = run(["space", "create", "upusagespelled", "--root", spelled, "--json"]);
  const upper = run(["up", "--server", `NATS://127.0.0.1:${held}/`, "--json"], spelled);
  let recorded: string | undefined;
  try { recorded = readStackJournal(spelled)?.journal.server; } catch { recorded = undefined; }
  const heldBroker = new RegExp(`another process holds the stack's broker address 127\\.0\\.0\\.1:${held}`);
  check("a prepared root records --server NATS://127.0.0.1:<port>/ as nats://127.0.0.1:<port>, refused only for the held address",
    spelledCreated.status === 0 && upper.status === 2 && heldBroker.test(upper.envelope?.error?.message ?? "") && recorded === `nats://127.0.0.1:${held}`, { recorded, up: shown(upper) });
  const plain = run(["up", "--server", `nats://127.0.0.1:${held}`, "--json"], spelled);
  check("…so --server nats://127.0.0.1:<port> there is the recorded address, not refused as another one",
    plain.status === 2 && plain.envelope?.error?.code === "CONFLICT" && heldBroker.test(plain.envelope.error.message ?? "") && !/recorded at/.test(plain.envelope.error.message ?? ""), shown(plain));
  check("…and neither started a broker", !started(spelled), readdirSync(join(spelled, ".cotal")));

  const now = new Date().toISOString();
  mkdirSync(join(journalRoot, ".cotal"), { mode: 0o700 });
  writeStackJournal(journalRoot, undefined, {
    schemaVersion: 1, kind: "cotal-stack-controller", root: journalRoot, space: "upusagejournal", server: `nats://127.0.0.1:${held}`, mode: "auth",
    members: (["broker", "auth", "delivery", "manager"] as const).map((role) => role === "auth" ? { role, definition: `stack-${role}`, instanceId: null, state: "not-attempted" as const } : { role, definition: `stack-${role}`, instanceId: randomUUID(), state: "stopped" as const }),
    operation: { id: randomUUID(), kind: "down", phase: "completed", recordedAt: now, withAgents: false }, updatedAt: now,
  });
  writeFileSync(join(journalRoot, "cotal.yaml"), `apiVersion: cotal/v1\nkind: Mesh\nspace: upusagejournal\nbroker:\n  servers: nats://127.0.0.1:${held}\nchannels:\n  general:\n    subscribe: []\n`);
  for (const args of [["up", "-f", "cotal.yaml"], ["up", "-f", "cotal.yaml", "--dry-run"]]) {
    const beside = run(args, journalRoot);
    check(`${args.join(" ")} on a root that holds a controller stack refuses CONFLICT, exit 2, naming team deploy and team boot`,
      beside.status === 2 && /CONFLICT/.test(beside.stderr) && /holds the controller stack of space upusagejournal/.test(beside.stderr)
        && /cotal team deploy cotal\.yaml/.test(beside.stderr) && /cotal team boot cotal\.yaml/.test(beside.stderr) && !started(journalRoot), shown(beside));
  }

  // A bare up whose folder names a space that runs from another folder names a separate space for
  // this folder, and the stop for the other one in its own folder. The folder's account names main,
  // as one does after an earlier `up --space main` there. A child process that sends the broker's
  // greeting stands in for the other folder's broker, since `run` blocks this process while up probes it.
  const other = realpathSync(mkdtempSync(join(tmpdir(), "cotal-up-usage-other-")));
  const legacy = realpathSync(mkdtempSync(join(tmpdir(), "cotal-up-usage-legacy-")));
  process.on("exit", () => { for (const dir of [other, legacy]) rmSync(dir, { recursive: true, force: true }); });
  const { createBrokerAuth, createSpaceAccountAuth } = await import("@cotal-ai/core");
  const { authDir, saveBrokerAuth, saveSpaceAccountAuth } = await import("@cotal-ai/workspace");
  const broker = await createBrokerAuth("upusagelegacy");
  saveBrokerAuth(authDir(legacy), broker);
  saveSpaceAccountAuth(authDir(legacy), await createSpaceAccountAuth(broker, "main"));
  const greeter = spawn(process.execPath, ["-e", `require("node:net").createServer((s) => { s.on("error", () => {}); s.write('INFO {"server_id":"other","proto":1}\\r\\n'); }).listen(0, "127.0.0.1", function () { console.log(this.address().port); });`], { stdio: ["ignore", "pipe", "inherit"] });
  const greeting = Number((await once(greeter.stdout!, "data"))[0].toString().trim());
  const { recordMesh, removeMesh } = await import("@cotal-ai/workspace");
  process.env.COTAL_HOME = join(home, ".cotal");
  recordMesh({ space: "main", server: `nats://127.0.0.1:${greeting}`, root: other, mode: "auth", origin: "up", ts: now });
  const inUse = run(["up", "--server", `nats://127.0.0.1:${await freePort()}`], legacy);
  // A regression that took the name over started a stack, which is stopped before the cell fails.
  if (started(legacy)) { sandbox(legacy); run(["down", "--yes"], legacy); }
  removeMesh("main");
  delete process.env.COTAL_HOME;
  greeter.kill();
  check("a bare up whose folder names a space that runs from another folder refuses CONFLICT, exit 2, naming cotal up --space <name> and the down in that folder",
    inUse.status === 2 && /Code:\s+CONFLICT/.test(inUse.stderr) && inUse.stderr.includes(`space "main" is already in use by a mesh at nats://127.0.0.1:${greeting} (${other})`)
      && inUse.stderr.includes(`start a separate space in this folder with cotal up --space <name>, naming one no other folder uses, or stop "main" first with cotal down in ${other}`), shown(inUse));

  // THE SAME SPACE, RUNNING FROM THIS VERY PROJECT, started again at another address. The refusal
  // above belongs to a name another folder holds; here the folder IS that space's project, so the
  // offer to start a separate space in it names the project it is already in. A subfolder of the
  // project resolves to the same root, which is where `up` there reaches this branch at all.
  const inner = join(legacy, "inner");
  mkdirSync(inner, { recursive: true });
  const greeterHere = spawn(process.execPath, ["-e", `require("node:net").createServer((s) => { s.on("error", () => {}); s.write('INFO {"server_id":"here","proto":1}\\r\\n'); }).listen(0, "127.0.0.1", function () { console.log(this.address().port); });`], { stdio: ["ignore", "pipe", "inherit"] });
  const here = Number((await once(greeterHere.stdout!, "data"))[0].toString().trim());
  process.env.COTAL_HOME = join(home, ".cotal");
  recordMesh({ space: "main", server: `nats://127.0.0.1:${here}`, root: legacy, mode: "auth", origin: "up", ts: now });
  const elsewhereAddress = `nats://127.0.0.1:${await freePort()}`;
  const ownProject = run(["up", "--server", elsewhereAddress], legacy);
  const subfolder = run(["up", "--server", elsewhereAddress], inner);
  if (started(legacy)) { sandbox(legacy); run(["down", "--yes"], legacy); }
  removeMesh("main");
  delete process.env.COTAL_HOME;
  greeterHere.kill();
  for (const [where, r] of [["its own project root", ownProject], ["a subfolder of that project", subfolder]] as const)
    check(`up --server naming another address, run from ${where} of a space that runs there, refuses CONFLICT, exit 2, naming the address it runs at and the bare up that reaches it`,
      r.status === 2 && /Code:\s+CONFLICT/.test(r.stderr)
        && r.stderr.includes(`space "main" already runs from this project at nats://127.0.0.1:${here}, and this start names ${elsewhereAddress}`)
        && r.stderr.includes(`run cotal up here with no --server or --host to reach the mesh at nats://127.0.0.1:${here}, or stop it first with cotal down in ${legacy}`)
        && !r.stderr.includes("start a separate space in this folder"), shown(r));
} finally {
  holder.close();
}

// up -f binds one address. A comma-separated list used to reach `new URL` whole and exit 3 with
// "Invalid URL", naming neither the source nor the rule. Ports 1 and 2 cannot be bound.
{
  const root = realpathSync(mkdtempSync(join(tmpdir(), "cotal-up-usage-oneaddr-")));
  roots.push(root);
  mkdirSync(join(root, ".cotal"), { mode: 0o700 });
  const list = "nats://127.0.0.1:1,nats://127.0.0.1:2";
  const manifest = (name: string, broker: string) => writeFileSync(join(root, name), `apiVersion: cotal/v1\nkind: Mesh\nspace: oneaddr\nbroker: { ${broker}, auth: false }\nchannels:\n  general: { description: Open coordination. }\n`);
  manifest("list.yaml", `servers: "${list}"`);
  manifest("host-list.yaml", `host: 127.0.0.1, servers: "${list}"`);
  manifest("single.yaml", `servers: "nats://127.0.0.1:1"`);
  manifest("host-single.yaml", `host: 127.0.0.1, servers: "nats://127.0.0.1:1"`);
  const wrote = () => readdirSync(join(root, ".cotal")).join(",");
  const before = wrote();
  // `up -f --json` is refused before the manifest is read, so the text form is the route that reaches
  // this check. It names the field the operator wrote and stops before the URL parse.
  for (const { label, args, source } of [
    { label: "a broker.servers list", args: ["up", "-f", "list.yaml"], source: "broker.servers" },
    { label: "a --server list", args: ["up", "-f", "single.yaml", "--server", list], source: "--server" },
    { label: "a broker.host beside a list", args: ["up", "-f", "host-list.yaml"], source: "broker.servers" },
  ]) {
    const r = run(args, root);
    check(`up -f with ${label} refuses exit 1, naming ${source} and the one-address rule, with no help`,
      r.status === 1 && r.stdout === "" && !/Invalid URL|Usage|Options/.test(r.stderr)
        && r.stderr === `✗ ${source} names more than one broker address, and up -f binds one; nothing was started or written\n  name one address in ${source}\n`, shown(r));
  }
  for (const { label, args } of [
    { label: "one broker.servers address", args: ["up", "-f", "single.yaml", "--dry-run"] },
    { label: "one --server address", args: ["up", "-f", "single.yaml", "--server", "nats://127.0.0.1:2", "--dry-run"] },
    { label: "broker.host beside one address", args: ["up", "-f", "host-single.yaml", "--dry-run"] },
  ]) {
    const r = run(args, root);
    check(`up -f --dry-run with ${label} prints the plan and exits 0`, r.status === 0 && /Dry run - nothing was changed/.test(r.stdout) && r.stderr === "", shown(r));
  }
  const view = run(["topology", "view", "-f", "list.yaml"], root);
  check("topology view -f accepts the two-address list and exits 0", view.status === 0 && view.stdout.includes(list), shown(view));
  check("the one-address refusals and their controls wrote nothing under .cotal", wrote() === before, wrote());
}

finish();
process.exit(process.exitCode ?? 0);
