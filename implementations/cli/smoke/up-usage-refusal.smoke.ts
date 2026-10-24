/**
 * `cotal up` refuses an invalid flag value or combination as usage, exit 1, before anything runs.
 * `--max-sessions 0`, `--max-sessions abc` and an unknown `--restore-only` value used to exit 3,
 * "Outcome unconfirmed", which tells a script the run may have had an effect. `--dry-run` without
 * `-f` used to start a real stack. A `--max-file-store` below the 64 MiB the space's membership
 * bucket reserves is refused the same way.
 *
 * Driven through the built binary in a sandboxed HOME, XDG_CONFIG_HOME and COTAL_HOME, from an empty
 * folder outside them. Nothing is started; each refusal comes from validation. A `--server` that no
 * local broker can serve, a host name included, is refused the same way in an unprepared and a
 * prepared folder, as the short classified report with an example on the port passed. In the home
 * folder, whose `.cotal` holds the machine's own records, `up` refuses CONFLICT and writes nothing
 * there, and `down` and `down --dry-run` there find no stack. In a prepared folder whose broker store
 * this account cannot write, `up` refuses PERMISSION_DENIED naming the store and the `chmod` that
 * fixes it, where the broker used to exit naming the cause only in its log, and status names the same
 * step in place of `cotal up`.
 *
 * Run: pnpm smoke:up-usage-refusal
 */
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createSuite } from "@cotal-ai/smoke-kit";

const BIN = join(import.meta.dirname, "..", "..", "..", "bin", "dist", "cotal.js");
if (!existsSync(BIN)) {
  console.error(`✗ ${BIN} missing - build first: pnpm --filter cotal-ai... build`);
  process.exit(1);
}

interface Envelope { outcome?: string; error?: { code?: string; message?: string } }

const { check, finish } = createSuite();
const home = mkdtempSync(join(tmpdir(), "cotal-up-usage-home-"));
const folder = mkdtempSync(join(tmpdir(), "cotal-up-usage-cwd-"));
process.on("exit", () => { rmSync(home, { recursive: true, force: true }); rmSync(folder, { recursive: true, force: true }); });

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
}

// Port 1 cannot be bound, so a regression here starts no usable broker.
const homeUp = run(["up", "--server", "nats://127.0.0.1:1", "--json"], home);
check("up in the home folder is one CONFLICT refusal, exit 2, naming a project folder", homeUp.status === 2 && homeUp.envelope?.error?.code === "CONFLICT" && /is your home folder/.test(homeUp.envelope.error.message ?? "") && /space create <space> --root <dir>/.test(homeUp.stdout), shown(homeUp));
check("it wrote no persona, pidfile or store in the home's .cotal", !existsSync(join(home, ".cotal", "agents")) && !existsSync(join(home, ".cotal", "nats.pid")) && !existsSync(join(home, ".cotal", "nats")), existsSync(join(home, ".cotal")) ? readdirSync(join(home, ".cotal")) : []);
// With no stack there, down and its preview say there is nothing to stop or preview.
const homeDown = run(["down", "--yes"], home);
check("down --yes in a home with no stack is TARGET_NOT_FOUND, nothing to stop", homeDown.status === 2 && /there is no stack at this folder's root, so there is nothing to stop/.test(homeDown.stderr), shown(homeDown));
const homePreview = run(["down", "--dry-run", "--json"], home);
check("down --dry-run in a home with no stack is TARGET_NOT_FOUND, nothing to preview", homePreview.status === 2 && homePreview.envelope?.error?.code === "TARGET_NOT_FOUND" && /nothing to preview/.test(homePreview.envelope.error.message ?? ""), shown(homePreview));

finish();
process.exit(process.exitCode ?? 0);
