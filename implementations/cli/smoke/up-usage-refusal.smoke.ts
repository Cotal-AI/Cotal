/**
 * `cotal up` refuses an invalid flag value or combination as usage, exit 1, before anything runs.
 * `--max-sessions 0`, `--max-sessions abc` and an unknown `--restore-only` value used to exit 3,
 * "Outcome unconfirmed", which tells a script the run may have had an effect. `--dry-run` without
 * `-f` used to start a real stack. A `--max-file-store` below 67108865, one byte more than the 64 MiB
 * the space's membership bucket reserves, is refused the same way.
 *
 * The same holds where `up` would otherwise start something it cannot stand behind. A prepared root
 * given an option the controller stack has no route for refuses UNSUPPORTED instead of starting the
 * legacy launcher. A broker address another program holds refuses CONFLICT instead of launching a
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
 * there, and `down` and `down --dry-run` there find no stack. In a prepared folder whose broker store
 * this account cannot write, `up` refuses PERMISSION_DENIED naming the store and the `chmod` that
 * fixes it, where the broker used to exit naming the cause only in its log, and status names the same
 * step in place of `cotal up`. A `server.conf` that is a symlink, and a trust record this account
 * cannot read, are refused PERMISSION_DENIED the same way, each naming its path and its step. Every broker address the cells after
 * those use is held by a loopback listener that never answers NATS, so a regression still cannot
 * start a broker there. On Linux, two cells hold one by a client connection's local end instead,
 * open and then in TIME-WAIT, with nothing listening, and need the refusal to say which.
 *
 * Run: pnpm smoke:up-usage-refusal
 */
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { connect, createServer, type AddressInfo } from "node:net";
import { accessSync, chmodSync, constants, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createSuite } from "@cotal-ai/smoke-kit";

const BIN = join(import.meta.dirname, "..", "..", "..", "bin", "dist", "cotal.js");
if (!existsSync(BIN)) {
  console.error(`✗ ${BIN} missing - build first: pnpm --filter cotal-ai... build`);
  process.exit(1);
}

interface Envelope { outcome?: string; error?: { code?: string; message?: string; remedy?: string } }
const { readStackJournal, writeStackJournal } = await import("../src/lib/stack-journal.js");

const { check, finish } = createSuite();
const home = mkdtempSync(join(tmpdir(), "cotal-up-usage-home-"));
const folder = mkdtempSync(join(tmpdir(), "cotal-up-usage-cwd-"));
const roots = ["unprepared", "journal"].map((name) => realpathSync(mkdtempSync(join(tmpdir(), `cotal-up-usage-${name}-`))));
const [unprepared, journalRoot] = roots as [string, string];
process.on("exit", () => { for (const dir of [home, folder, ...roots]) rmSync(dir, { recursive: true, force: true }); });

const HOST_ENV = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith("COTAL_") && k !== "FORCE_COLOR" && k !== "NO_COLOR"));
const env = { ...HOST_ENV, HOME: home, USERPROFILE: home, XDG_CONFIG_HOME: join(home, ".config"), COTAL_HOME: join(home, ".cotal"), COTAL_SKIP_CONNECTOR_SEED: "1", NO_COLOR: "1" };
const run = (args: string[], cwd = folder) => {
  const r = spawnSync(process.execPath, [BIN, ...args], { cwd, env, encoding: "utf8", timeout: 120_000 });
  let envelope: Envelope | undefined;
  try { envelope = JSON.parse(r.stdout ?? "") as Envelope; } catch { envelope = undefined; }
  return { status: r.status, stdout: r.stdout ?? "", stderr: r.stderr ?? "", envelope };
};
const shown = (r: ReturnType<typeof run>) => ({ status: r.status, stdout: r.stdout.slice(0, 900), stderr: r.stderr.slice(0, 900) });

const cases: { args: string[]; message: RegExp }[] = [
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
const homeDown = run(["down", "--yes"], home);
check("down --yes in a home with no stack is TARGET_NOT_FOUND, nothing to stop, and names `cotal up` in a project", homeDown.status === 2 && /there is no stack at this folder's root, and this machine has no stack started or registered, so there is nothing to stop/.test(homeDown.stderr) && homeDown.stderr.includes("run `cotal up` in a project"), shown(homeDown));
const homePreview = run(["down", "--dry-run", "--json"], home);
check("down --dry-run in a home with no stack is TARGET_NOT_FOUND, nothing to preview, and names `cotal up` in a project", homePreview.status === 2 && homePreview.envelope?.error?.code === "TARGET_NOT_FOUND" && /no stack started or registered, so there is nothing to preview/.test(homePreview.envelope.error.message ?? "") && homePreview.envelope.error.remedy === "run `cotal up` in a project", shown(homePreview));

// A loopback listener that accepts and never answers NATS holds every broker address below.
const holder = createServer((socket) => socket.on("error", () => {}));
const held = await new Promise<number>((resolve) => holder.listen(0, "127.0.0.1", () => resolve((holder.address() as AddressInfo).port)));
const started = (root: string) => existsSync(join(root, ".cotal", "nats.pid"));
try {
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
} finally {
  holder.close();
}

finish();
process.exit(process.exitCode ?? 0);
