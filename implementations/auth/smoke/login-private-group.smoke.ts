/** Real public logout with physical service ancestors. No OS services or network. */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { privateGroupGap, shellPath, spaceKey } from "@cotal-ai/workspace";
import { saveIdpSession, loadIdpSession } from "../src/login.js";

const root = mkdtempSync(join(realpathSync.native(tmpdir()), "login-group-"));
const home = join(root, "home's space"), operator = join(home, ".cotal"), store = join(root, "private");
const units = join(home, ".config/systemd/user");
const idp = "https://identity.example.test/api/auth";
const service = `cotal-manager@${spaceKey("fixture")}.service`;
const env = { ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("COTAL_"))), HOME: home, COTAL_HOME: operator, XDG_CONFIG_HOME: join(home, "config"), COTAL_SKIP_CONNECTOR_SEED: "1" };
try {
  for (const key of ["XDG_CACHE_HOME", "XDG_DATA_HOME", "XDG_STATE_HOME", "XDG_RUNTIME_DIR", "TMPDIR"]) {
    const path = join(root, key.toLowerCase());
    mkdirSync(path, { mode: 0o700 });
    Object.assign(env, { [key]: path });
  }
  for (const dir of [operator, store, units, env.XDG_CONFIG_HOME]) mkdirSync(dir, { recursive: true, mode: 0o700 });
  const values: Record<string, string> = { MESH: "fixture", ROOT: root, WORKING_DIRECTORY: root, ENVIRONMENT_FILE: join(root, "manager.env"), ENTRY: `${process.execPath} --import tsx ${resolve("bin/cotal.ts")}`, PATH: process.env.PATH!, SPACE: "fixture", SERVER: "nats://127.0.0.1:4222", STATE_DIR: store };
  const render = (name: string) => readFileSync(resolve("bin/smoke/fixtures", name), "utf8").replace(/@([A-Z_]+)@/g, (_, key: string) => values[key]!);
  writeFileSync(values.ENVIRONMENT_FILE!, render("pre-cut-manager-unit.env"), { mode: 0o600 });
  writeFileSync(join(units, service), render("pre-cut-manager-unit.service"), { mode: 0o600 });
  const session = { token: "private-group-smoke-only", sub: "same-account", expiresAt: Date.now() + 60_000 };
  saveIdpSession(operator, idp, session); saveIdpSession(store, idp, session);
  const before = readFileSync(join(store, "idp-sessions.json"), "utf8");
  for (const path of [join(home, ".config"), join(home, ".config/systemd"), units]) chmodSync(path, 0o775);
  const read = (command: string, args: string[]) => {
    const result = spawnSync(command, args, { encoding: "utf8" });
    assert.equal(result.status, 0); return result.stdout;
  };
  const gap = privateGroupGap({ nameServices: () => readFileSync("/etc/nsswitch.conf", "utf8"), user: uid => read("getent", ["passwd", String(uid)]), group: gid => read("getent", ["group", String(gid)]), users: () => read("getent", ["passwd"]) }, process.getuid!(), process.getgid!());
  const acl = spawnSync("getfacl", ["--skip-base", "--absolute-names", "--", units], { encoding: "utf8" });
  const result = spawnSync(process.execPath, ["--import", "tsx", "bin/cotal.ts", "logout", "--idp", idp, "--local", "--plain"], { env, encoding: "utf8", timeout: 30_000 });
  assert.equal(result.status, 0, "public local logout succeeds independently of optional services");
  const output = result.stdout + result.stderr;
  assert.ok(!output.includes(session.token));
  if (gap === undefined && acl.status === 0 && acl.stdout === "") {
    assert.equal(loadIdpSession(store, idp), undefined, "proven private-group ancestors permit public logout to clear shared service session");
    console.log("PASS real CLI private-group ancestors clear shared service session");
  } else {
    assert.equal(readFileSync(join(store, "idp-sessions.json"), "utf8"), before);
    assert.match(output, /chmod g-w/, "unavailable private-group proof prints actionable mode-change remedy");
    assert.ok(output.includes(`chmod g-w ${shellPath(join(home, ".config"))}`), "remedy safely quotes the original path, not a proc descriptor");
    if (gap === undefined && (acl.error as NodeJS.ErrnoException | undefined)?.code === "ENOENT") assert.match(output, /install acl/, "missing getfacl names the acl package");
    console.log("PASS real CLI unavailable private-group proof safely skips with actionable remedy");
  }
} finally { rmSync(root, { recursive: true, force: true }); }
