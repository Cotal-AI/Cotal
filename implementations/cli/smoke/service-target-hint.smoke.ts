/**
 * `cotal service` with no space to resolve is refused with a remedy that names a flag the command
 * accepts. It used to say "or pass `--server`", which `service` refuses as an unknown option, and
 * its JSON message carried the text renderer's "✗ " mark with no separate remedy.
 *
 * `service add --file` for another space, under the name of a service the selected space already
 * has, is refused for naming the other space. It used to be refused as "already exists", with a next
 * step that removed the selected space's service.
 *
 * `service add --file` of a broker definition whose server is no broker address is refused, quoting
 * it, before anything is saved. It used to be saved, and only its start refused.
 *
 * `service add --preset broker` in a prepared, unstarted space saves into that space. The preset's own
 * `--server` and `--root` used to select the target, so it went to "main", or with `--space` it was
 * refused as not started.
 *
 * `help service remove` lists `--instance`, which `remove` takes. It used to leave it out.
 *
 * Driven through the built binary in a sandboxed COTAL_HOME, from a folder that is not a project and
 * from two prepared projects. No broker is started.
 *
 * `service logs` on a log this account cannot read is refused PERMISSION_DENIED with a chmod step,
 * and `--follow` ends with that refusal as its error record.
 *
 * Run: pnpm smoke:service-target-hint
 */
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createSuite } from "@cotal-ai/smoke-kit";

const BIN = join(import.meta.dirname, "..", "..", "..", "bin", "dist", "cotal.js");
if (!existsSync(BIN)) {
  console.error(`✗ ${BIN} missing - build first: pnpm --filter cotal-ai... build`);
  process.exit(1);
}

const { check, finish } = createSuite();
const home = mkdtempSync(join(tmpdir(), "cotal-service-hint-"));
const neutral = join(home, "neutral");
mkdirSync(neutral);
process.on("exit", (code) => { if (code === 0) rmSync(home, { recursive: true, force: true }); });

const HOST_ENV = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith("COTAL_") && k !== "FORCE_COLOR" && k !== "NO_COLOR"));
const env = { ...HOST_ENV, HOME: home, USERPROFILE: home, XDG_CONFIG_HOME: join(home, ".config"), COTAL_HOME: join(home, ".cotal"), COTAL_SKIP_CONNECTOR_SEED: "1", DO_NOT_TRACK: "1", COTAL_TELEMETRY: "off", NO_COLOR: "1" };
const run = (args: string[], cwd = neutral) => {
  const r = spawnSync(process.execPath, [BIN, ...args], { cwd, env, encoding: "utf8", timeout: 120_000 });
  return { status: r.status, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
};
const shown = (r: ReturnType<typeof run>) => ({ status: r.status, stdout: r.stdout.slice(0, 900), stderr: r.stderr.slice(0, 600) });

const json = run(["service", "--json"]);
let envelope: { outcome?: string; error?: { code?: string; message?: string; remedy?: string } } | undefined;
try { envelope = JSON.parse(json.stdout) as typeof envelope; } catch { envelope = undefined; }
check("service --json with no space is one TARGET_NOT_FOUND refusal, exit 2", json.status === 2 && envelope?.outcome === "refused" && envelope.error?.code === "TARGET_NOT_FOUND", shown(json));
check("its message carries no text-renderer mark", typeof envelope?.error?.message === "string" && !envelope.error.message.includes("✗"), envelope?.error);
check("its remedy is reported apart from the message", typeof envelope?.error?.remedy === "string" && !envelope.error.message?.includes(envelope.error.remedy), envelope?.error);
check("the remedy names --space, a flag service accepts", /--space/.test(envelope?.error?.remedy ?? ""), envelope?.error);
check("the remedy does not name --server, which service refuses", !/--server/.test(json.stdout), envelope?.error);

const text = run(["service"]);
check("the text refusal names --space and not --server", text.status === 2 && /--space/.test(text.stderr) && !/--server/.test(text.stderr), shown(text));
check("the text refusal carries one mark, not two", !/✗\s*✗/.test(text.stderr), shown(text));

const refused = run(["service", "--server", "nats://127.0.0.1:4222"]);
check("control: service does refuse --server as an unknown option", refused.status === 1 && /Unknown option '--server'/.test(refused.stderr), shown(refused));

// remove takes --instance to forget one stopped instance record; its help did not list it.
const removeHelp = run(["help", "service", "remove"]);
check("help service remove lists --instance <full-id> in its usage and options",
  removeHelp.status === 0 && /cotal service remove <name> \[--instance <full-id>\] \[--yes\]/.test(removeHelp.stdout) && /^ +--instance <full-id> +select one full owned service instance ID/m.test(removeHelp.stdout), shown(removeHelp));

// Space a holds a service tick and is selected; a definition file for space b uses the same name.
{
  const definition = (space: string, cwd: string) => {
    const path = join(home, `${space}.json`);
    writeFileSync(path, JSON.stringify({ schemaVersion: 1, space, launch: { type: "process", executable: "/bin/sleep", args: ["300"], cwd }, readiness: { type: "process", timeoutMs: 5000 } }));
    return path;
  };
  const [a, b] = [join(home, "a"), join(home, "b")];
  for (const dir of [a, b]) mkdirSync(dir);
  const [forA, forB] = [definition("sa", a), definition("sb", b)];
  check("rig: prepare sa with a service tick, prepare sb, select sa",
    run(["space", "create", "sa"], a).status === 0 && run(["service", "add", "tick", "--file", forA], a).status === 0 && run(["space", "create", "sb"], b).status === 0 && run(["use", "sa"], b).status === 0);
  // From a folder that is no space's project, where the selection applies; in b, b's own space is the
  // target, and the file names it.
  const other = run(["service", "add", "tick", "--file", forB, "--json"]);
  let refusal: { error?: { code?: string; message?: string; remedy?: string } } | undefined;
  try { refusal = JSON.parse(other.stdout) as typeof refusal; } catch { refusal = undefined; }
  check("add --file for sb under sa's service name names both spaces, SCHEMA_INVALID exit 1",
    other.status === 1 && refusal?.error?.code === "SCHEMA_INVALID" && refusal.error.message === 'service definition: the definition names space "sb", and the selected space is "sa"' && refusal.error.remedy === undefined, shown(other));
  const list = run(["service", "--space", "sa", "--json"], b);
  check("sa keeps its service tick", list.status === 0 && list.stdout.includes('"name":"tick"'), shown(list));
  const again = run(["service", "add", "tick", "--file", forA, "--json"], a);
  check("control: a file for sa under its existing name is still refused as already existing",
    again.status === 2 && again.stdout.includes('"code":"CONFLICT"') && again.stdout.includes("this service definition already exists"), shown(again));

  const config = join(a, ".cotal", "broker.conf");
  writeFileSync(config, "", { mode: 0o600 });
  const broker = join(home, "broker.json");
  writeFileSync(broker, JSON.stringify({ schemaVersion: 1, space: "sa", launch: { type: "adapter", adapter: "nats-broker", options: { root: a, config, binary: realpathSync("/bin/sleep"), server: "hallo welt" } }, readiness: { type: "adapter", timeoutMs: 30_000 } }));
  const word = run(["service", "add", "word", "--file", broker, "--json"], a);
  let wordRefusal: { error?: { code?: string; message?: string; remedy?: string } } | undefined;
  try { wordRefusal = JSON.parse(word.stdout) as typeof wordRefusal; } catch { wordRefusal = undefined; }
  check('add --file of a broker definition whose server is "hallo welt" is SCHEMA_INVALID, exit 1, quoting it',
    word.status === 1 && wordRefusal?.error?.code === "SCHEMA_INVALID" && wordRefusal.error.message === `the definition's launch.options.server "hallo welt": the broker address must be one nats:// or tls:// URL; nothing was saved`, shown(word));
  const kept = run(["service", "--space", "sa", "--json"], a);
  check("...and saves nothing", kept.status === 0 && !kept.stdout.includes('"name":"word"'), shown(kept));

  // A preset's own --server and --root describe the service. They used to pick the target too, so in
  // this prepared, unstarted space the add went to "main", and with --space it was refused as not started.
  const presetArgs = ["--preset", "broker", "--root", a, "--config", config, "--binary", realpathSync("/bin/sleep"), "--server", "nats://127.0.0.1:4999"];
  for (const [name, extra] of [["viafolder", []], ["viaspace", ["--space", "sa"]]] as const) {
    const added = run(["service", "add", name, ...presetArgs, ...extra, "--json"], a);
    check(`service add --preset broker ${extra.length ? "with --space sa" : "in sa's folder"} saves into sa`, added.status === 0 && added.stdout.includes('"target":{"space":"sa"'), shown(added));
  }
  const listed = run(["service", "--space", "sa", "--json"], a);
  check("...and sa lists both", listed.status === 0 && listed.stdout.includes('"name":"viafolder"') && listed.stdout.includes('"name":"viaspace"'), shown(listed));
}

// `service logs` on a log this account cannot read is a refusal with the step that opens it again. It
// used to end OPERATION_UNKNOWN with the raw EACCES and no remedy, though it only reads.
if (process.platform !== "win32" && process.getuid?.() !== 0) {
  const l = join(home, "l"), path = join(home, "printer.json");
  mkdirSync(l);
  writeFileSync(path, JSON.stringify({ schemaVersion: 1, space: "sl", launch: { type: "process", executable: "/bin/sh", args: ["-c", "echo tick; exec sleep 300"], cwd: l }, readiness: { type: "process", timeoutMs: 5000 } }));
  const started = run(["space", "create", "sl"], l).status === 0 && run(["service", "add", "printer", "--file", path], l).status === 0 ? run(["service", "start", "printer", "--json"], l) : undefined;
  let instanceId: string | undefined;
  try { instanceId = (JSON.parse(started?.stdout ?? "") as { result?: { instanceId?: string } }).result?.instanceId; } catch { instanceId = undefined; }
  const log = join(home, ".cotal", "services", Buffer.from("sl").toString("hex"), "instances", `${Buffer.from(instanceId ?? "").toString("hex")}.log`);
  check("rig: a started process service writes its log", started?.status === 0 && existsSync(log), started && shown(started));
  try {
    chmodSync(log, 0o000);
    const closed = run(["service", "logs", "printer", "--json"], l);
    let closedEnvelope: { outcome?: string; error?: { code?: string; message?: string; remedy?: string } } | undefined;
    try { closedEnvelope = JSON.parse(closed.stdout) as typeof closedEnvelope; } catch { closedEnvelope = undefined; }
    const step = `chmod u+rw ${log}`;
    check("service logs on a log it cannot read is PERMISSION_DENIED, exit 2, naming the log and chmod u+rw",
      closed.status === 2 && closedEnvelope?.outcome === "refused" && closedEnvelope.error?.code === "PERMISSION_DENIED" && closedEnvelope.error.message === `the log ${log} cannot be read by this account (EACCES); nothing was read or changed` && closedEnvelope.error.remedy === `make it readable by you, for example with ${step}`, shown(closed));
    // --follow used to end OPERATION_FAILED, exit 5, "the bounded private log read failed", with no
    // file, cause or step.
    const followed = run(["service", "logs", "printer", "--follow", "--json"], l);
    let records: { type?: string; data?: { code?: string; message?: string; remedy?: string; reason?: string } }[] = [];
    try { records = followed.stdout.trim().split("\n").map((line) => JSON.parse(line) as (typeof records)[number]); } catch { records = []; }
    const failed = records.find((r) => r.type === "error")?.data;
    check("logs --follow on it ends with one PERMISSION_DENIED error record naming the log, cause and chmod u+rw, exit 2",
      followed.status === 2 && failed?.code === "PERMISSION_DENIED" && failed.message === closedEnvelope?.error?.message && failed.remedy === closedEnvelope?.error?.remedy && records.at(-1)?.type === "end" && records.at(-1)?.data?.reason === "read-failed", shown(followed));
    const opened = spawnSync("sh", ["-c", step], { cwd: l, encoding: "utf8" }), reread = run(["service", "logs", "printer"], l);
    check("running that step reads the log again", opened.status === 0 && reread.status === 0 && reread.stdout.includes("tick"), shown(reread));
  } finally {
    if (existsSync(log)) chmodSync(log, 0o600);
    const stopped = run(["service", "stop", "printer", "--yes"], l);
    check("the fixture's process service is stopped", stopped.status === 0, shown(stopped));
  }
}

finish();
process.exit(process.exitCode ?? 0);
