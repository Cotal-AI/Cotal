/**
 * `cotal up` refuses an invalid flag value or combination as usage, exit 1, before anything runs.
 * `--max-sessions 0`, `--max-sessions abc` and an unknown `--restore-only` value used to exit 3,
 * "Outcome unconfirmed", which tells a script the run may have had an effect.
 *
 * Driven through the built binary in a sandboxed HOME, XDG_CONFIG_HOME and COTAL_HOME, from an empty
 * folder outside them. Nothing is started; each refusal comes from validation. A `--server` that no
 * local broker can serve, a host name included, is refused the same way in an unprepared and a
 * prepared folder, as the short classified report with an example on the port passed. In the home
 * folder, whose `.cotal` holds the machine's own records, `up` refuses CONFLICT and writes nothing
 * there, and `down` there finds no stack to stop.
 *
 * Run: pnpm smoke:up-usage-refusal
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
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
  { args: ["--restore", join(folder, "nonexistent"), "--restore-only", "full"], message: /--restore-only takes registry/ },
  { args: ["--restore-only", "registry"], message: /require --restore/ },
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
// With no stack there, down says there is nothing to stop.
const homeDown = run(["down", "--yes"], home);
check("down --yes in a home with no stack is TARGET_NOT_FOUND, nothing to stop", homeDown.status === 2 && /there is no stack at this folder's root, so there is nothing to stop/.test(homeDown.stderr), shown(homeDown));

finish();
process.exit(process.exitCode ?? 0);
