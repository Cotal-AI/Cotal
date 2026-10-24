/**
 * `cotal up` refuses an invalid flag value or combination as usage, exit 1, before anything runs.
 * `--max-sessions 0`, `--max-sessions abc` and an unknown `--restore-only` value used to exit 3,
 * "Outcome unconfirmed", which tells a script the run may have had an effect. `--dry-run` without
 * `-f` used to start a real stack. A `--max-file-store` below the 64 MiB the space's membership
 * bucket reserves is refused the same way.
 *
 * The same holds where `up` would otherwise start something it cannot stand behind. A prepared root
 * given an option the controller stack has no route for refuses UNSUPPORTED instead of starting the
 * legacy launcher. A broker address another program holds refuses CONFLICT instead of launching a
 * broker that exits on its bind. `up -f` on a root that holds a controller stack refuses CONFLICT
 * instead of starting a manifest stack beside it.
 *
 * Driven through the built binary in a sandboxed HOME, XDG_CONFIG_HOME and COTAL_HOME, from empty
 * folders outside them. Nothing is started; each refusal comes from validation. A `--server` that no
 * local broker can serve, a host name included, is refused the same way in an unprepared and a
 * prepared folder, as the short classified report with an example on the port passed. In the home
 * folder, whose `.cotal` holds the machine's own records, `up` refuses CONFLICT and writes nothing
 * there, and `down` and `down --dry-run` there find no stack. Every broker address the cells after
 * those use is held by a loopback listener that never answers NATS, so a regression still cannot
 * start a broker there.
 *
 * Run: pnpm smoke:up-usage-refusal
 */
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createServer, type AddressInfo } from "node:net";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createSuite } from "@cotal-ai/smoke-kit";

const BIN = join(import.meta.dirname, "..", "..", "..", "bin", "dist", "cotal.js");
if (!existsSync(BIN)) {
  console.error(`✗ ${BIN} missing - build first: pnpm --filter cotal-ai... build`);
  process.exit(1);
}

interface Envelope { outcome?: string; error?: { code?: string; message?: string; remedy?: string } }
const { writeStackJournal } = await import("../src/lib/stack-journal.js");

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
  { args: ["--max-file-store", "1"], message: /--max-file-store 1 is below 67108864 bytes \(64 MiB\), which the space's membership bucket reserves/ },
  { args: ["--max-file-store", "50000000"], message: /--max-file-store 50000000 is below 67108864 bytes/ },
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
];
for (const { server, message, example } of servers) {
  const text = run(["up", "--server", server]);
  check(`up --server ${server} is the classified USAGE_INVALID report with no help, exit 1, giving ${example}`, text.status === 1 && text.stdout === "" && message.test(text.stderr) && /Code:\s+USAGE_INVALID/.test(text.stderr) && text.stderr.includes(example) && !/Usage|Options/.test(text.stderr), shown(text));
}

check("nothing was written in the folder", readdirSync(folder).length === 0, readdirSync(folder));

const prepared = mkdtempSync(join(tmpdir(), "cotal-up-usage-prepared-"));
process.on("exit", () => rmSync(prepared, { recursive: true, force: true }));
const created = run(["space", "create", "upusage", "--root", prepared, "--json"]);
check("space create prepares a folder", created.status === 0, shown(created));
const named = run(["up", "--server", "nats://localhost:43131", "--json"], prepared);
check("in a prepared folder a host name is the same USAGE_INVALID refusal, exit 1, naming 127.0.0.1", named.status === 1 && named.envelope?.error?.code === "USAGE_INVALID" && /names the host localhost/.test(named.envelope.error.message ?? "") && named.stdout.includes("--server nats://127.0.0.1:43131"), shown(named));
check("it wrote no stack journal", !existsSync(join(prepared, ".cotal", "stack-controller.json")), readdirSync(join(prepared, ".cotal")));

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
  check("…and names both TLS options and the -f route", tls.status === 2 && tls.envelope?.error?.code === "UNSUPPORTED" && /no route for --tls-cert and --tls-key/.test(tls.envelope.error.message ?? "") && /cotal up -f <cotal\.yaml>, which takes them/.test(tls.envelope.error.remedy ?? ""), shown(tls));
  check("…without starting the legacy launcher or the controller stack", !started(prepared) && !existsSync(join(prepared, ".cotal", "stack-controller.json")), readdirSync(join(prepared, ".cotal")));

  const bind = run(["up", "--server", `nats://127.0.0.1:${held}`], unprepared);
  check("the legacy route refuses a held address CONFLICT, exit 2, naming the address, and launches nothing",
    bind.status === 2 && /CONFLICT/.test(bind.stderr) && new RegExp(`another process holds the broker address 127\\.0\\.0\\.1:${held}`).test(bind.stderr) && !started(unprepared), shown(bind));

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
