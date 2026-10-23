/**
 * `space delete` names a prepared space for what it is, and `space forget` and `help space delete`
 * say what applies. Deleting a space that is prepared and not running used to say "no registered
 * space has this exact name", `space forget` called a space started before "never started", and the
 * delete help described `-y` with the `add` text first.
 *
 * Driven through the built binary in a sandboxed HOME, XDG_CONFIG_HOME and COTAL_HOME. No broker is
 * started and nothing is deleted.
 *
 * Run: pnpm smoke:space-prepared-delete
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createSuite } from "@cotal-ai/smoke-kit";

const BIN = join(import.meta.dirname, "..", "..", "..", "bin", "dist", "cotal.js");
if (!existsSync(BIN)) {
  console.error(`✗ ${BIN} missing - build first: pnpm --filter cotal-ai... build`);
  process.exit(1);
}

interface Envelope { outcome?: string; error?: { code?: string; message?: string; remedy?: string } }

const { check, finish } = createSuite();
const home = mkdtempSync(join(tmpdir(), "cotal-prepared-delete-"));
const root = mkdtempSync(join(home, "project-"));
process.on("exit", () => rmSync(home, { recursive: true, force: true }));

const HOST_ENV = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith("COTAL_") && k !== "FORCE_COLOR" && k !== "NO_COLOR"));
const env = { ...HOST_ENV, HOME: home, USERPROFILE: home, XDG_CONFIG_HOME: join(home, ".config"), COTAL_HOME: join(home, ".cotal"), COTAL_SKIP_CONNECTOR_SEED: "1", NO_COLOR: "1" };
const run = (args: string[]) => {
  const r = spawnSync(process.execPath, [BIN, ...args], { cwd: root, env, encoding: "utf8", timeout: 120_000 });
  let envelope: Envelope | undefined;
  try { envelope = JSON.parse(r.stdout ?? "") as Envelope; } catch { envelope = undefined; }
  return { status: r.status, stdout: r.stdout ?? "", stderr: r.stderr ?? "", envelope };
};
const shown = (r: ReturnType<typeof run>) => ({ status: r.status, stdout: r.stdout.slice(0, 900), stderr: r.stderr.slice(0, 600) });

const created = run(["space", "create", "b4b", "--root", root]);
check("rig: the space is prepared and not started", created.status === 0, shown(created));

const preview = run(["space", "delete", "b4b", "--dry-run", "--json"]);
check("a delete preview of a prepared space refuses as unavailable, exit 2", preview.status === 2 && preview.envelope?.error?.code === "TARGET_UNAVAILABLE", shown(preview));
check("it says the space is prepared and not running", /"b4b" is prepared and not running/.test(preview.envelope?.error?.message ?? ""), preview.envelope?.error);
check("a space that never ran has no streams, so its remedy names only space forget", /no stack has run for it/.test(preview.envelope?.error?.remedy ?? "") && /cotal space forget b4b/.test(preview.envelope?.error?.remedy ?? "") && !/cotal up/.test(preview.envelope?.error?.remedy ?? ""), preview.envelope?.error);

const unknown = run(["space", "delete", "nosuch", "--dry-run", "--json"]);
check("control: a name nothing records is still not found, exit 2", unknown.status === 2 && unknown.envelope?.error?.code === "TARGET_NOT_FOUND", shown(unknown));

const help = run(["help", "space", "delete"]);
check("delete help describes -y without the add text first", help.status === 0 && /a delete must name the exact space/.test(help.stdout) && !/add: skip terminal confirmation/.test(help.stdout), shown(help));

const forgot = run(["space", "forget", "b4b"]);
check("forget says the prepared space is not running", forgot.status === 0 && /prepared, not running/.test(forgot.stdout) && !/never started/.test(forgot.stdout), shown(forgot));

finish();
process.exit(process.exitCode ?? 0);
