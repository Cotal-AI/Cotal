/**
 * `history clear` keeps the refusal contract and its docs match the CLI.
 *
 * The `--yes` refusal suggests `history clear --dry-run`. For a space that was prepared but not
 * started, that dry run used to print a bare one-line target error and exit 1, because the `clear`
 * subcommand declared no structured output and so missed the kernel's classified refusal. It is now
 * a standard `TARGET_UNAVAILABLE` refusal, exit 2, with a JSON envelope. A registered space whose
 * broker is not running still previews, which shows the dry run connects nowhere.
 *
 * docs/cli.md used to document `history clear --force`, which the CLI refuses. The page and the help
 * now both name `--yes` and `--dry-run`.
 *
 * Driven through the built binary in a sandboxed COTAL_HOME. No broker is started.
 *
 * Run: pnpm smoke:history-clear-surface
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chatStream } from "@cotal-ai/core";
import { createSuite, freePort } from "@cotal-ai/smoke-kit";
import { recordMesh } from "@cotal-ai/workspace";

const REPO = join(import.meta.dirname, "..", "..", "..");
const BIN = join(REPO, "bin", "dist", "cotal.js");
if (!existsSync(BIN)) {
  console.error(`✗ ${BIN} missing - build first: pnpm --filter cotal-ai... build`);
  process.exit(1);
}

interface Envelope {
  outcome: string;
  target: { space?: string } | null;
  result: { kind?: string; streams?: string[]; purged?: boolean } | null;
  error?: { code: string; message: string; remedy?: string };
}

const { check, finish } = createSuite();
const home = mkdtempSync(join(tmpdir(), "cotal-history-clear-"));
const root = realpathSync(mkdtempSync(join(home, "project-")));
const otherRoot = realpathSync(mkdtempSync(join(home, "other-")));
mkdirSync(join(otherRoot, ".cotal"), { mode: 0o700 });
mkdirSync(join(home, ".cotal"), { mode: 0o700 });
process.on("exit", () => rmSync(home, { recursive: true, force: true }));
// Set before recordMesh: the registry is written under COTAL_HOME, never under ~/.cotal.
process.env.COTAL_HOME = join(home, ".cotal");

const HOST_ENV = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith("COTAL_") && k !== "FORCE_COLOR" && k !== "NO_COLOR"));
const env = { ...HOST_ENV, HOME: home, USERPROFILE: home, XDG_CONFIG_HOME: join(home, ".config"), COTAL_HOME: join(home, ".cotal"), COTAL_SKIP_CONNECTOR_SEED: "1", NO_COLOR: "1" };
const run = (args: string[]) => {
  const r = spawnSync(process.execPath, [BIN, ...args], { cwd: root, env, encoding: "utf8", timeout: 120_000 });
  let envelope: Envelope | undefined;
  try { envelope = JSON.parse(r.stdout ?? "") as Envelope; } catch { envelope = undefined; }
  return { status: r.status, stdout: r.stdout ?? "", stderr: r.stderr ?? "", envelope };
};
const shown = (r: ReturnType<typeof run>) => ({ status: r.status, stdout: r.stdout.slice(0, 900), stderr: r.stderr.slice(0, 600) });

const prepared = run(["space", "create", "hcdry", "--root", "."]);
check("fixture: the space is prepared and not started", prepared.status === 0, shown(prepared));

const plain = run(["history", "clear", "--dry-run", "--plain"]);
check("dry run on a prepared space is refused, exit 2", plain.status === 2, shown(plain));
check("the refusal is the standard report, not a bare target line", !plain.stderr.startsWith("✗") && plain.stderr.includes("Request refused") && plain.stderr.includes("TARGET_UNAVAILABLE"), shown(plain));
check("the refusal names the prepared space", plain.stderr.includes('"hcdry" is prepared but not started'), shown(plain));

const json = run(["history", "clear", "--dry-run", "--json"]);
check("json: the refusal envelope is TARGET_UNAVAILABLE", json.status === 2 && json.envelope?.outcome === "refused" && json.envelope.error?.code === "TARGET_UNAVAILABLE", shown(json));
check("json: the remedy says how to start the space", /cotal up/.test(json.envelope?.error?.remedy ?? ""), json.envelope?.error);

// A registered space at a port with nothing listening: the preview still answers.
const port = await freePort();
recordMesh({ space: "hcother", server: `nats://127.0.0.1:${port}`, root: otherRoot, mode: "open", ts: new Date().toISOString() });
const preview = run(["history", "clear", "--dry-run", "--space", "hcother", "--json"]);
check("control: a registered space previews without a broker, exit 0", preview.status === 0 && preview.envelope?.outcome === "ok" && preview.envelope.result?.kind === "history-clear-preview", shown(preview));
check("control: the preview names its space and chat stream and purges nothing", preview.envelope?.target?.space === "hcother" && (preview.envelope.result?.streams ?? []).includes(chatStream("hcother")) && preview.envelope.result?.purged === false, preview.envelope);
const previewPlain = run(["history", "clear", "--dry-run", "--space", "hcother", "--plain"]);
check("control: the plain preview begins with Mesh: <space>", previewPlain.status === 0 && previewPlain.stdout.split("\n")[0] === "Mesh: hcother", shown(previewPlain));

const force = run(["history", "clear", "--force"]);
check("the old --force spelling is a usage refusal, exit 1, and names --yes", force.status === 1 && `${force.stdout}${force.stderr}`.includes("cotal history clear --yes"), shown(force));

const help = run(["history", "clear", "--help"]);
check("help for history clear lists --yes, --dry-run and its structured outputs", help.status === 0 && help.stdout.includes("--yes") && help.stdout.includes("--dry-run") && help.stdout.includes("Structured output: json, plain"), help.stdout.slice(0, 1600));

const docs = readFileSync(join(REPO, "docs", "cli.md"), "utf8");
const section = docs.slice(docs.indexOf("\n## history\n"), docs.indexOf("\n## console\n"));
const clearLine = section.split("\n").find((line) => line.startsWith("cotal history clear")) ?? "";
check("docs: the history synopsis names --yes and --dry-run for clear", clearLine.includes("--yes") && clearLine.includes("--dry-run") && !clearLine.includes("--force"), clearLine);
check("docs: the history flag table has no --force row", !section.includes("| `--force` |"), section.slice(0, 400));

// Scripts, examples and other smokes that still pass the removed spelling would be refused at run time.
const REMOVED = [/history clear --force/, /"clear",(?:\s*\.\.\.\w+,)?\s*"--force"/];
const scanned: string[] = [];
const walk = (dir: string): void => {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name === "dist" || entry.name.startsWith(".")) continue;
    const path = join(dir, entry.name);
    if (entry.isDirectory()) walk(path);
    else if (/\.(?:ts|mjs|js|sh)$/.test(entry.name) && path !== import.meta.filename) scanned.push(path);
  }
};
for (const dir of ["examples", "scripts", "bin/smoke", ...readdirSync(join(REPO, "implementations")).map((name) => `implementations/${name}/smoke`)])
  if (existsSync(join(REPO, dir))) walk(join(REPO, dir));
const stale = scanned.filter((path) => REMOVED.some((pattern) => pattern.test(readFileSync(path, "utf8")))).map((path) => path.slice(REPO.length + 1));
check("no script, example or smoke passes the removed history clear --force", scanned.length > 0 && stale.length === 0, stale);

finish();
process.exit(process.exitCode ?? 0);
