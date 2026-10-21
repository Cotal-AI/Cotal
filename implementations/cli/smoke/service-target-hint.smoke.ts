/**
 * `cotal service` with no space to resolve is refused with a remedy that names a flag the command
 * accepts. It used to say "or pass `--server`", which `service` refuses as an unknown option, and
 * its JSON message carried the text renderer's "✗ " mark with no separate remedy.
 *
 * Driven through the built binary in a sandboxed COTAL_HOME with an empty registry, from a folder
 * that is not a project. No broker is started.
 *
 * Run: pnpm smoke:service-target-hint
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
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
const run = (args: string[]) => {
  const r = spawnSync(process.execPath, [BIN, ...args], { cwd: neutral, env, encoding: "utf8", timeout: 120_000 });
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

finish();
process.exit(process.exitCode ?? 0);
