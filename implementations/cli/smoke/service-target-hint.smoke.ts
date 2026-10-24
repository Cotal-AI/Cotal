/**
 * `cotal service` with no space to resolve is refused with a remedy that names a flag the command
 * accepts. It used to say "or pass `--server`", which `service` refuses as an unknown option, and
 * its JSON message carried the text renderer's "✗ " mark with no separate remedy.
 *
 * `service add --file` for another space, under the name of a service the selected space already
 * has, is refused for naming the other space. It used to be refused as "already exists", with a next
 * step that removed the selected space's service.
 *
 * Driven through the built binary in a sandboxed COTAL_HOME, from a folder that is not a project and
 * from two prepared projects. No broker is started.
 *
 * Run: pnpm smoke:service-target-hint
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
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
process.on("exit", () => rmSync(home, { recursive: true, force: true }));

const HOST_ENV = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith("COTAL_") && k !== "FORCE_COLOR" && k !== "NO_COLOR"));
const env = { ...HOST_ENV, HOME: home, USERPROFILE: home, XDG_CONFIG_HOME: join(home, ".config"), COTAL_HOME: join(home, ".cotal"), COTAL_SKIP_CONNECTOR_SEED: "1", NO_COLOR: "1" };
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
  const other = run(["service", "add", "tick", "--file", forB, "--json"], b);
  let refusal: { error?: { code?: string; message?: string; remedy?: string } } | undefined;
  try { refusal = JSON.parse(other.stdout) as typeof refusal; } catch { refusal = undefined; }
  check("add --file for sb under sa's service name names both spaces, SCHEMA_INVALID exit 1",
    other.status === 1 && refusal?.error?.code === "SCHEMA_INVALID" && refusal.error.message === 'service definition: the definition names space "sb", and the selected space is "sa"' && refusal.error.remedy === undefined, shown(other));
  const list = run(["service", "--space", "sa", "--json"], b);
  check("sa keeps its service tick", list.status === 0 && list.stdout.includes('"name":"tick"'), shown(list));
  const again = run(["service", "add", "tick", "--file", forA, "--json"], a);
  check("control: a file for sa under its existing name is still refused as already existing",
    again.status === 2 && again.stdout.includes('"code":"CONFLICT"') && again.stdout.includes("this service definition already exists"), shown(again));
}

finish();
process.exit(process.exitCode ?? 0);
