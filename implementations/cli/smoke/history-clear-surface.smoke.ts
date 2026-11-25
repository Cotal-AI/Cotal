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
import { spawn, spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chatStream, dmStream, isReachable } from "@cotal-ai/core";
import { assertSmokeSandboxDown, awaitBrokerReady, createSuite, freePort, killAndAwaitExit, recordSmokeSandbox, withDeadline } from "@cotal-ai/smoke-kit";
import { findMesh, recordMesh } from "@cotal-ai/workspace";
import { readDocument } from "@cotal-ai/docs-content";
import { execWords } from "../src/lib/exec-words.js";

const REPO = join(import.meta.dirname, "..", "..", "..");
const BIN = join(REPO, "bin", "dist", "cotal.js");
if (!existsSync(BIN)) {
  console.error(`✗ ${BIN} missing - build first: pnpm --filter cotal-ai... build`);
  process.exit(1);
}

interface Envelope {
  outcome: string;
  target: { space?: string; broker?: string } | null;
  result: { kind?: string; streams?: string[]; items?: { channel: string; text: string }[]; purged?: boolean; acknowledged?: { stream: string; purged: number }[]; authorization?: string; retainedCounts?: string } | null;
  error?: { code: string; message: string; remedy?: string };
}

const { check, finish } = createSuite();
const home = mkdtempSync(join(tmpdir(), "cotal-history-clear-"));
const root = realpathSync(mkdtempSync(join(home, "project-")));
const otherRoot = realpathSync(mkdtempSync(join(home, "other-")));
mkdirSync(join(otherRoot, ".cotal"), { mode: 0o700 });
mkdirSync(join(home, ".cotal"), { mode: 0o700 });
mkdirSync(join(home, "runtime"), { mode: 0o700 });
process.on("exit", () => rmSync(home, { recursive: true, force: true }));
// Set before recordMesh: the registry is written under COTAL_HOME, never under ~/.cotal.
process.env.COTAL_HOME = join(home, ".cotal");

const HOST_ENV = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith("COTAL_") && k !== "FORCE_COLOR" && k !== "NO_COLOR"));
const env = { ...HOST_ENV, HOME: home, USERPROFILE: home, XDG_CONFIG_HOME: join(home, ".config"), XDG_RUNTIME_DIR: join(home, "runtime"), COTAL_HOME: join(home, ".cotal"), COTAL_SKIP_CONNECTOR_SEED: "1", DO_NOT_TRACK: "1", NO_COLOR: "1" };
const run = (args: string[], cwd = root, cliEnv: NodeJS.ProcessEnv = env) => {
  const r = spawnSync(process.execPath, [BIN, ...args], { cwd, env: cliEnv, encoding: "utf8", timeout: 120_000 });
  let envelope: Envelope | undefined;
  try { envelope = JSON.parse(r.stdout ?? "") as Envelope; } catch { envelope = undefined; }
  return { status: r.status, stdout: r.stdout ?? "", stderr: r.stderr ?? "", envelope };
};
const shown = (r: ReturnType<typeof run>) => ({ status: r.status, stdout: r.stdout.slice(0, 900), stderr: r.stderr.slice(0, 600) });

const directUp = ["up", "--foreground", "--open", "--no-manager"];
const directPreview = ["history", "clear", "--dry-run", "--dms", "--json"];

function checkSavedPreviews(cwd: string, space: string, server: string, cliEnv: typeof env): void {
  for (const [label, target] of [
    ["explicit broker control", ["--space", space, "--server", server]],
    ["named space", ["--space", space]],
    ["local project", []],
  ] as const) {
    const plan = run([...directPreview, ...target], cwd, cliEnv);
    const e = plan.envelope;
    check(`directly stopped ${space} previews its saved broker offline (${label})`, plan.status === 0 && e?.outcome === "ok"
      && e.target?.space === space && e.target.broker === server && e.result?.kind === "history-clear-preview"
      && e.result.streams?.join(",") === [chatStream(space), dmStream(space)].join(",")
      && e.result.authorization === "not-checked" && e.result.retainedCounts === "not-checked" && e.result.purged === false, shown(plan));
  }
}

function checkDirectRefusals(cwd: string, space: string): void {
  const wrong = run([...directPreview, "--space", "not-volume"], cwd);
  check("the saved broker is not a preview target for a different space", wrong.status === 2 && wrong.envelope?.error?.code === "TARGET_NOT_FOUND", shown(wrong));
  const confirm = run(["history", "clear", "--yes", "--space", space, "--json"], cwd);
  check("a confirmed clear still refuses the stopped direct target", confirm.status === 2 && confirm.envelope?.error?.code === "TARGET_UNAVAILABLE", shown(confirm));

  const linked = mkdtempSync(join(home, "linked-project-"));
  symlinkSync(join(cwd, ".cotal"), join(linked, ".cotal"), "junction");
  const foreign = run([...directPreview, "--space", space], linked);
  check("a link to another project's records does not name a local stopped preview target", foreign.status === 2
    && foreign.envelope?.error?.code === "TARGET_UNAVAILABLE", shown(foreign));

  const copied = mkdtempSync(join(home, "copied-project-"));
  mkdirSync(join(copied, ".cotal"), { mode: 0o700 });
  for (const file of ["stack-home.json", "server-open.conf", "native-ready-target.json"]) copyFileSync(join(cwd, ".cotal", file), join(copied, ".cotal", file));
  const copy = run([...directPreview, "--space", space], copied);
  check("copied native records cannot name a stopped preview target in another project", copy.status === 2
    && copy.envelope?.error?.code === "TARGET_UNAVAILABLE", shown(copy));
}

interface DirectProject {
  cwd: string;
  env: typeof env;
  tls?: { cert: string; key: string };
}

function findProjectMesh(space: string, cotalHome: string): ReturnType<typeof findMesh> {
  const current = process.env.COTAL_HOME;
  process.env.COTAL_HOME = cotalHome;
  try { return findMesh(space); }
  finally {
    if (current === undefined) delete process.env.COTAL_HOME;
    else process.env.COTAL_HOME = current;
  }
}

async function checkDirectStopPreview(space: string, { cwd, env: projectEnv, tls }: DirectProject): Promise<string | undefined> {
  const server = `${tls ? "tls" : "nats"}://127.0.0.1:${await freePort()}`;
  const childEnv = tls ? { ...projectEnv, NODE_EXTRA_CA_CERTS: tls.cert } : projectEnv;
  const launch = [...directUp, "--space", space, "--server", server, ...(tls ? ["--tls-cert", tls.cert, "--tls-key", tls.key] : [])];
  const anchor = recordSmokeSandbox({ root: cwd, cotalHome: childEnv.COTAL_HOME, xdgConfigHome: childEnv.XDG_CONFIG_HOME });
  const up = spawn(process.execPath, [BIN, ...launch], { cwd, env: childEnv, stdio: ["ignore", "pipe", "pipe"] });
  const closed = new Promise<number | null>((resolve, reject) => { up.once("close", resolve); up.once("error", reject); });
  let output = "";
  up.stdout.on("data", (data) => { output += data; });
  up.stderr.on("data", (data) => { output += data; });
  const reachable = () => isReachable(server, { timeoutMs: 300 });
  try {
    await awaitBrokerReady(async () => findProjectMesh(space, childEnv.COTAL_HOME)?.server === server && await reachable(),
      { servers: server, attempts: 120, delayMs: 250, output: () => output });
    const downArgs = ["down", "--yes"];
    assertSmokeSandboxDown(anchor, downArgs, { cwd, env: childEnv });
    const down = run(downArgs, cwd, childEnv);
    const exited = down.status === 0 ? await withDeadline(closed, 15_000, "foreground up after down") : undefined;
    const offline = down.status === 0 && exited === 0 && findProjectMesh(space, childEnv.COTAL_HOME) === undefined && !await reachable();
    check(`direct down stops the foreground broker and removes the registration for ${space}`, offline, { ...shown(down), exited });
    if (!offline) return;
    checkSavedPreviews(cwd, space, server, childEnv);
    return server;
  } finally {
    await killAndAwaitExit(up);
    await closed;
  }
}

async function checkFailedStartPreview(cwd: string, space: string, server: string, label: string): Promise<void> {
  mkdirSync(join(cwd, ".cotal"), { recursive: true, mode: 0o700 });
  const store = join(cwd, "broken-store");
  mkdirSync(store, { recursive: true, mode: 0o700 });
  writeFileSync(join(store, "jetstream"), "a regular file, not a store directory");
  const up = run([...directUp, "--space", space, "--server", server, "--store-dir", store], cwd);
  const failed = up.status === 5 && existsSync(join(cwd, ".cotal", "server-open.conf")) && findMesh(space) === undefined
    && !await isReachable(server, { timeoutMs: 300 });
  check(`${label} leaves a rendered config but no registered or reachable broker`, failed, shown(up));
  if (!failed) return;
  for (const target of [[], ["--space", space]]) {
    const plan = run([...directPreview, ...target], cwd);
    check(`${label} cannot name a preview target (${target.length ? "named space" : "local project"})`,
      plan.status === 2 && plan.envelope?.error?.code === "TARGET_UNAVAILABLE", shown(plan));
  }
}

const directRoot = () => realpathSync(mkdtempSync(join(home, "direct-project-")));
const nativeRoot = directRoot();
const priorBroker = await checkDirectStopPreview("volume", { cwd: nativeRoot, env });
if (priorBroker) {
  checkDirectRefusals(nativeRoot, "volume");
  await checkFailedStartPreview(nativeRoot, "volume", priorBroker, "failed restart on the same address");
}
await checkFailedStartPreview(directRoot(), "hcfailed", `nats://127.0.0.1:${await freePort()}`, "failed first start");
const [cert, key] = [join(home, "broker.pem"), join(home, "broker.key")];
const pki = spawnSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", key, "-out", cert,
  "-days", "2", "-subj", "/CN=127.0.0.1", "-addext", "subjectAltName=IP:127.0.0.1"], { cwd: home, env, encoding: "utf8" });
check("TLS fixture has a loopback certificate", pki.status === 0, { status: pki.status, error: pki.error?.message, stderr: pki.stderr?.slice(-500) });
if (pki.status === 0) await checkDirectStopPreview("hctls", { cwd: directRoot(), env, tls: { cert, key } });

if (process.platform === "linux") {
  const segments = Array.from({ length: 11 }, (_, i) => String(i).padEnd(200, "x"));
  const cwd = join(home, "long-project", ...segments);
  const cotalHome = join(home, "long-home", ...segments);
  check("long-path fixture exceeds 4096 bytes only when home and project are combined",
    [cwd, cotalHome].every((path) => Buffer.byteLength(path) < 4096) && Buffer.byteLength(cwd) + Buffer.byteLength(cotalHome) > 4096);
  const offline = await checkDirectStopPreview("hclong", { cwd, env: { ...env, COTAL_HOME: cotalHome } });
  if (offline) {
    const owner = join(cwd, ".cotal", "stack-home.json");
    const expected = JSON.stringify({ home: cotalHome });
    check("native down keeps the legacy owner record bounded and free of preview fields",
      Buffer.byteLength(expected) < 4096 && readFileSync(owner, "utf8") === expected);
    const foreign = run([...directPreview, "--space", "hclong"], cwd);
    check("a different Cotal home cannot use the long-path preview receipt", foreign.status === 2
      && foreign.envelope?.error?.code === "TARGET_UNAVAILABLE", shown(foreign));
  }
}

function checkJsonClearRemedy(server: string): void {
  const target = ["--space", "hcdry", "--server", server];
  const clear = ["history", "clear", ...target];
  const count = (expected: number): void => {
    const read = run(["history", "general", ...target, "--json"]);
    check(`history read finds ${expected} retained posts`, read.status === 0 && read.envelope?.result?.items?.length === expected, shown(read));
  };
  count(1);
  const refusal = run([...clear, "--json"]);
  check("unconfirmed JSON clear refuses without prompting", refusal.status === 1 && refusal.stderr === ""
    && refusal.envelope?.outcome === "refused" && refusal.envelope.error?.code === "USAGE_INVALID", shown(refusal));
  count(1);
  const preview = [...clear, "--dry-run", "--json"];
  const confirm = [...clear, "--yes", "--json"];
  const printed = [...(refusal.envelope?.error?.remedy ?? "").matchAll(/`([^`]+)`/g)].map((match) => match[1]);
  const matches = printed.length === 2 && printed[0] === `cotal ${preview.join(" ")}` && printed[1] === `cotal ${confirm.join(" ")}`;
  check("both suggested commands keep the broker target and JSON format", matches, shown(refusal));
  if (!matches) return;
  const plan = run(preview);
  check("the suggested preview writes JSON without purging", plan.status === 0 && plan.envelope?.outcome === "ok"
    && plan.envelope.result?.kind === "history-clear-preview" && plan.envelope.result.purged === false, shown(plan));
  count(1);
  const receipt = run(confirm);
  const ack = receipt.envelope?.result?.acknowledged;
  check("the first confirmed purge writes the JSON acknowledgement and count", receipt.status === 0 && receipt.envelope?.outcome === "ok"
    && receipt.envelope.result?.kind === "history-clear" && ack?.length === 1 && ack[0]?.stream === chatStream("hcdry") && ack[0].purged === 1, shown(receipt));
  count(0);
}

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
  checkJsonClearRemedy(server);
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
const plainClear = run(["history", "clear", "--space", "hcother", "--creds", "unused purger.creds", "--dms", "--plain"]);
const plainCommand = "cotal history clear --space hcother --creds 'unused purger.creds' --dms";
check("both plain suggestions keep the quoted credential path, DM scope and plain format", plainClear.status === 1
  && plainClear.stderr.includes(`\`${plainCommand} --dry-run --plain\``)
  && plainClear.stderr.includes(`\`${plainCommand} --yes --plain\``), shown(plainClear));
for (const [separator, label] of [[" ", "space"], ["\t", "tab"]] as const) {
  const clear = ["history", "clear", "--space", "hcother", `--creds=-unused${separator}purger.creds`, "--dms"];
  const refusal = run([...clear, "--json"]);
  const commands = [...(refusal.envelope?.error?.remedy ?? "").matchAll(/`([^`]+)`/g)].map((match) => execWords(match[1]!));
  const expected = ["--dry-run", "--yes"].map((action) => ["cotal", ...clear, action, "--json"]);
  const matches = refusal.status === 1 && refusal.envelope?.error?.code === "USAGE_INVALID" && JSON.stringify(commands) === JSON.stringify(expected);
  check(`both JSON suggestions preserve a dash-prefixed credential path with a ${label}`, matches, shown(refusal));
  if (matches && commands[0]) {
    const plan = run(commands[0].slice(1));
    check(`the printed preview with a ${label} in its credential path round-trips`, plan.status === 0 && plan.envelope?.outcome === "ok"
      && plan.envelope.target?.space === "hcother" && plan.envelope.result?.kind === "history-clear-preview"
      && plan.envelope.result.streams?.join(",") === [chatStream("hcother"), dmStream("hcother")].join(","), shown(plan));
  }
}

for (const [separator, label] of [["\t", "tab"], ["\u2028", "line separator"]] as const) {
  for (const format of [[], ["--plain"]]) {
    const refusal = run(["history", "clear", "--space", "hcother", `--creds=-unused${separator}purger.creds`, "--dms", ...format]);
    check(`${format[0] ?? "rich"} refusal with a ${label} keeps the original arguments without printing an altered command`,
      refusal.status === 1 && refusal.stdout === "" && refusal.stderr.includes("keep all arguments in your original command")
      && refusal.stderr.includes("`--dry-run` to preview") && refusal.stderr.includes("`--yes` instead to confirm")
      && !refusal.stderr.includes("purger.creds") && !refusal.stderr.includes(separator), shown(refusal));
  }
}
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
