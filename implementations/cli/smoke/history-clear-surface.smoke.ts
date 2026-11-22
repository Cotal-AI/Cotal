/**
 * `history clear` keeps the refusal contract and its docs match the CLI.
 *
 * The `--yes` refusal suggests `history clear --dry-run`. For a space that was prepared but not
 * started, that dry run used to print a bare one-line target error and exit 1, because the `clear`
 * subcommand declared no structured output and so missed the kernel's classified refusal. It is now
 * a standard `TARGET_UNAVAILABLE` refusal, exit 2, with a JSON envelope. A registered space whose
 * broker is not running still previews, which shows the dry run connects nowhere.
 *
 * docs/cli-messaging.mdx used to document `history clear --force`, which the CLI refuses. The page and the help
 * now both name `--yes` and `--dry-run`.
 *
 * Driven through the built binary in a sandboxed COTAL_HOME, with a broker started and stopped to
 * check that the saved address still works for an offline preview.
 *
 * Run: pnpm smoke:history-clear-surface
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chatStream, dmStream } from "@cotal-ai/core";
import { assertSmokeSandboxDown, createSuite, freePort, recordSmokeSandbox } from "@cotal-ai/smoke-kit";
import { recordMesh } from "@cotal-ai/workspace";
import { readDocument } from "@cotal-ai/docs-content";

const REPO = join(import.meta.dirname, "..", "..", "..");
const BIN = join(REPO, "bin", "dist", "cotal.js");
if (!existsSync(BIN)) {
  console.error(`✗ ${BIN} missing - build first: pnpm --filter cotal-ai... build`);
  process.exit(1);
}

interface Envelope {
  outcome: string;
  target: { space?: string; broker?: string } | null;
  result: { kind?: string; streams?: string[]; items?: { channel: string; text: string }[]; purged?: boolean; authorization?: string; retainedCounts?: string } | null;
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
const env = { ...HOST_ENV, HOME: home, USERPROFILE: home, XDG_CONFIG_HOME: join(home, ".config"), COTAL_HOME: join(home, ".cotal"), COTAL_SKIP_CONNECTOR_SEED: "1", DO_NOT_TRACK: "1", NO_COLOR: "1" };
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

const server = `nats://127.0.0.1:${await freePort()}`;
const anchor = recordSmokeSandbox({ root, cotalHome: env.COTAL_HOME, xdgConfigHome: env.XDG_CONFIG_HOME });
const stopArgs = ["down", "--space", "hcdry", "--yes", "--json"];
const stop = () => {
  assertSmokeSandboxDown(anchor, stopArgs, { cwd: root, env });
  return run(stopArgs);
};
try {
  const up = run(["up", "--open", "--no-manager", "--server", server, "--json"]);
  check("fixture: the prepared project starts a broker", up.status === 0, shown(up));
  const explicit = ["--space", "hcunregistered", "--server", server];
  const openPreview = run(["history", "clear", ...explicit, "--dry-run", "--json"]);
  check("an explicit open target can be previewed without registering it", openPreview.status === 0
    && openPreview.envelope?.target?.space === "hcunregistered" && openPreview.envelope.target.broker === server
    && openPreview.envelope.result?.streams?.join(",") === chatStream("hcunregistered")
    && openPreview.envelope.result.authorization === "not-checked" && openPreview.envelope.result.retainedCounts === "not-checked"
    && openPreview.envelope.result.purged === false, shown(openPreview));
  const openClear = run(["history", "clear", ...explicit, "--yes", "--json"]);
  check("the confirmed clear accepts the same unregistered target", openClear.status === 0 && openClear.envelope?.outcome === "no-op"
    && openClear.envelope.target?.space === openPreview.envelope?.target?.space, shown(openClear));
  const limitTarget = ["history", "limit", "--space", "hcdry", "--json"];
  const limit = run(limitTarget);
  check("history limit reads the broker address from the local space records", limit.status === 0 && limit.envelope?.target?.broker === server, shown(limit));
  for (const [flag, value] of [["--server", server], ["--creds", "unused.creds"]] as const) {
    const override = run([...limitTarget, flag, value]);
    check(`history limit refuses ${flag} even with a local space`, override.status === 1 && override.envelope?.error?.code === "USAGE_INVALID", shown(override));
  }
  const sent = run(["send", "-c", "general", "hello retained history", "--space", "hcdry", "--json"]);
  check("fixture: a channel message is stored", sent.status === 0, shown(sent));
  const read = run(["history", "general", "--space", "hcdry", "--limit", "10", "--grep", "hello", "--json"]);
  check("omitting only --force reads the requested channel with its filters intact", read.status === 0
    && read.envelope?.result?.items?.some((item) => item.channel === "general" && item.text === "hello retained history") === true, shown(read));
  const down = stop();
  check("fixture: down completes the stop", down.status === 0 && down.envelope?.outcome === "ok", shown(down));
  for (const args of [[], ["--space", "hcdry"], ["--space", "hcdry", "--server", server]]) {
    const stopped = run(["history", "clear", "--dry-run", "--dms", "--json", ...args]);
    const e = stopped.envelope;
    check(`stopped space previews its recorded broker and both streams offline (${args.join(" ") || "local project"})`,
      stopped.status === 0 && e?.target?.space === "hcdry" && e.target.broker === server
        && e.result?.streams?.join(",") === [chatStream("hcdry"), dmStream("hcdry")].join(",")
        && e.result.authorization === "not-checked" && e.result.retainedCounts === "not-checked" && e.result.purged === false, shown(stopped));
  }
} finally {
  stop();
}

// A registered space at a port with nothing listening: the preview still answers.
const port = await freePort();
recordMesh({ space: "hcother", server: `nats://127.0.0.1:${port}`, root: otherRoot, mode: "open", ts: new Date().toISOString() });
const preview = run(["history", "clear", "--dry-run", "--space", "hcother", "--json"]);
check("control: a registered space previews without a broker, exit 0", preview.status === 0 && preview.envelope?.outcome === "ok" && preview.envelope.result?.kind === "history-clear-preview", shown(preview));
check("control: the preview names its space and chat stream and purges nothing", preview.envelope?.target?.space === "hcother" && (preview.envelope.result?.streams ?? []).includes(chatStream("hcother")) && preview.envelope.result?.purged === false, preview.envelope);
const previewPlain = run(["history", "clear", "--dry-run", "--space", "hcother", "--plain"]);
check("control: the plain preview begins with Mesh: <space>", previewPlain.status === 0 && previewPlain.stdout.split("\n")[0] === "Mesh: hcother", shown(previewPlain));
const offlineExplicit = run(["history", "clear", "--dry-run", "--space", "hcoffline", "--server", `nats://127.0.0.1:${port}`, "--dms", "--json"]);
check("an unregistered explicit target previews both streams without a reachable broker", offlineExplicit.status === 0
  && offlineExplicit.envelope?.result?.streams?.join(",") === [chatStream("hcoffline"), dmStream("hcoffline")].join(",")
  && offlineExplicit.envelope.result.purged === false, shown(offlineExplicit));

for (const [args, guidance] of [
  [["general"], "Omit --force"],
  [["general", "--space", "hcdry", "--limit", "10", "--grep", "hello"], "Omit --force"],
  [["clear", "--space", "hcother", "--dms"], "Replace --force with --yes"],
  [["clear", "--space", "hcother", "--dms", "--dry-run"], "Omit --force"],
  [["clear", "--space", "hcother", "--dms", "--yes"], "Omit --force"],
  [["limit", "--space", "hcother"], "Omit --force"],
  [["limit", "--space", "hcother", "--per-sender", "10"], "Replace --force with --yes"],
] as const) {
  const force = run(["history", ...args, "--force", "--json"]);
  check(`history ${args.join(" ")}: --force refuses without changing the operation`,
    force.status === 1 && force.stderr === "" && force.envelope?.outcome === "refused"
      && force.envelope.error?.code === "USAGE_INVALID"
      && force.envelope.error.message === `--force is not supported. ${guidance} and keep the other arguments.`, shown(force));
}

const plainRead = run(["history", "general", "--force", "--plain"]);
const plainRefusal = plainRead.stderr.split("\n\n", 1)[0] ?? "";
check("plain history read refusal tells the user to omit --force", plainRead.status === 1
  && plainRefusal.includes("Omit --force and keep the other arguments.") && !plainRefusal.includes("--yes"), shown(plainRead));

const scopedClear = run(["history", "clear", "general", "--force", "--json"]);
check("an invalid selective clear does not suggest confirmation", scopedClear.status === 1
  && scopedClear.envelope?.error?.message.includes("history clear takes no channel") === true
  && !scopedClear.stdout.includes("--yes"), shown(scopedClear));

const rootHelp = run(["history", "--help"]);
const forceHelp = rootHelp.stdout.split("\n").find((line) => line.trimStart().startsWith("--force ")) ?? "";
check("history help tells reads and previews to omit --force", rootHelp.status === 0 && forceHelp.includes("Omit it from reads and previews") && !forceHelp.includes("--yes"), shown(rootHelp));

const help = run(["history", "clear", "--help"]);
check("help for history clear lists --yes, --dry-run and its structured outputs", help.status === 0 && help.stdout.includes("--yes") && help.stdout.includes("--dry-run") && help.stdout.includes("Structured output: json, plain"), help.stdout.slice(0, 1600));

const docs = (await readDocument(join(REPO, "docs", "cli-messaging.mdx"))).markdown;
const start = docs.indexOf("\n## history\n");
const section = docs.slice(start, docs.indexOf("\n## ", start + 1));
const clearLine = section.split("\n").find((line) => line.startsWith("cotal history clear")) ?? "";
check("docs: the history synopsis names --yes and --dry-run for clear", clearLine.includes("--yes") && clearLine.includes("--dry-run") && !clearLine.includes("--force"), clearLine);
check("docs: the history flag table has no --force row", !section.includes("| `--force` |"), section.slice(0, 400));
const overrideRow = section.split("\n").find((line) => line.startsWith("|") && line.includes("`--server <url>`"));
check("docs: broker and credential overrides are scoped to history reads and clear", overrideRow !== undefined && overrideRow.includes("`--creds <path>`")
  && overrideRow.includes("Reads and `clear` only"), overrideRow);

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
