/**
 * `cotal auth mint` persona diagnostics keep the resolved `--space`, even when mint targeted the
 * space with `--server` while another space is selected via `cotal use`.
 * A refused symlink output also gives an argument that can be pasted into a POSIX shell.
 *
 * Hermetic (no broker, no network). Run: pnpm smoke:mint-persona-space
 */
import nodeAssert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createSpaceAuth, registry } from "@cotal-ai/core";
import { countedAssert, emitSentinel } from "@cotal-ai/smoke-kit";

if (process.argv[2] === "mint-child") {
  await import("../src/index.js");
  await import("@cotal-ai/auth");
  const { runCli } = await import("../src/command.js");
  await runCli(registry, process.argv.slice(3));
  process.exit(process.exitCode ?? 0);
}

const counted = countedAssert(nodeAssert);
const assert: typeof nodeAssert = counted.assert;
const cells = counted.cells;

const scratch = realpathSync(mkdtempSync(join(tmpdir(), "cotal-mint-persona-space-")));
const home = join(scratch, "home");
const project = join(scratch, "endpoint-audit");
const otherProject = join(scratch, "reference-audit");
const hyphenProject = join(scratch, "hyphen-audit");
mkdirSync(home, { recursive: true });
mkdirSync(join(project, ".cotal", "agents"), { recursive: true });
mkdirSync(join(otherProject, ".cotal", "agents"), { recursive: true });
mkdirSync(join(hyphenProject, ".cotal", "agents"), { recursive: true });

const envKeys = ["HOME", "USERPROFILE", "XDG_CONFIG_HOME", "COTAL_HOME", "NO_COLOR", "DO_NOT_TRACK"] as const;
const savedEnv = Object.fromEntries(envKeys.map((k) => [k, process.env[k]]));
const prevCwd = process.cwd();

process.env.HOME = home;
process.env.USERPROFILE = home;
process.env.XDG_CONFIG_HOME = join(home, "xdg");
process.env.COTAL_HOME = join(home, ".cotal");
process.env.NO_COLOR = "1";
process.env.DO_NOT_TRACK = "1";

const {
  authDir,
  isCommandFailure,
  recordMesh,
  saveSpaceAuth,
  setCurrent,
} = await import("@cotal-ai/workspace");
const { mint } = await import("../src/commands/mint.js");
const { persona } = await import("../src/commands/persona.js");

function checkSymlinkOutput(): void {
  const real = join(scratch, "export's → $HOME"), link = join(scratch, "export-link");
  mkdirSync(real, { mode: 0o700 });
  symlinkSync(real, link);
  const out = join(real, "issued.creds");
  const nodeArgs = [...process.execArgv, process.argv[1]!, "mint-child", "auth", "mint", "issued", "--space", "endpoint-audit", "--plain", "--out"];
  const env = { ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("COTAL_"))),
    COTAL_HOME: process.env.COTAL_HOME };
  const options = { env, encoding: "utf8" as const, timeout: 30_000 };
  const refused = spawnSync(process.execPath, [...nodeArgs, join(link, "issued.creds")], options);
  assert.equal(refused.status, 2, refused.stderr);
  assert.match(refused.stderr, /^\s*Code:\s+PERMISSION_DENIED$/m);
  assert.deepEqual(readdirSync(real), [], "the symlink refusal writes nothing");
  const suggested = /^\s*name the --out file by a path with no symbolic link in it, such as (`+)(.+?)\1 if that folder is yours$/m.exec(refused.stderr)?.[2];
  assert.ok(suggested, "mint names the physical --out argument in its Next line");
  const retry = spawnSync("/bin/sh", ["-c", `exec "$@" ${suggested}`, "sh", process.execPath, ...nodeArgs], options);
  assert.equal(retry.status, 0, retry.stderr);
  assert.deepEqual(readdirSync(real), ["issued.creds"]);
  assert.equal(statSync(out).mode & 0o777, 0o600);
}

try {
  const endpointServer = "nats://127.0.0.1:47100";
  const otherServer = "nats://127.0.0.1:47101";
  const hyphenServer = "nats://127.0.0.1:47102";

  saveSpaceAuth(authDir(project), await createSpaceAuth("endpoint-audit"));
  saveSpaceAuth(authDir(otherProject), await createSpaceAuth("reference-audit"));
  saveSpaceAuth(authDir(hyphenProject), await createSpaceAuth("-audit"));

  recordMesh({ space: "endpoint-audit", server: endpointServer, root: project, mode: "auth", ts: new Date().toISOString(), origin: "manual" });
  recordMesh({ space: "reference-audit", server: otherServer, root: otherProject, mode: "auth", ts: new Date().toISOString(), origin: "manual" });
  recordMesh({ space: "-audit", server: hyphenServer, root: hyphenProject, mode: "auth", ts: new Date().toISOString(), origin: "manual" });

  writeFileSync(join(project, ".cotal", "agents", "reviewagent.md"), "---\nrole: [unterminated\n---\nAudit persona.\n");
  writeFileSync(join(project, ".cotal", "agents", "roleagent.md"), "---\nname: roleagent\nrole: bad role\n---\nRole with space.\n");
  writeFileSync(join(hyphenProject, ".cotal", "agents", "hyphenagent.md"), "---\nrole: [unterminated\n---\nHyphen space.\n");

  setCurrent("reference-audit");
  process.chdir(project);
  if (process.platform !== "win32") checkSymlinkOutput();

  // Control: bare `cotal persona show reviewagent` resolves the selected space (`reference-audit`).
  let bareShowErr: unknown;
  try {
    await persona({ values: { plain: true }, positionals: ["show", "reviewagent"], raw: [] });
  } catch (err) {
    bareShowErr = err;
  }
  assert.ok(isCommandFailure(bareShowErr), "bare persona show without --space refuses when missing from selected space");
  assert.equal(bareShowErr.code, "TARGET_NOT_FOUND");

  // 1. Mint via `--server` targeting `endpoint-audit` while `reference-audit` is selected.
  let unreadableErr: unknown;
  try {
    await mint({ values: { server: endpointServer, plain: true }, positionals: ["reviewagent"], raw: [] });
  } catch (err) {
    unreadableErr = err;
  }
  assert.ok(isCommandFailure(unreadableErr), "mint with unreadable persona must refuse");
  assert.equal(unreadableErr.code, "SCHEMA_INVALID");
  assert.equal(
    unreadableErr.remedy,
    "see what is wrong with it with `cotal persona show reviewagent --space endpoint-audit`, then fix it and mint again",
  );

  // Following the suggested `--space endpoint-audit` flag diagnoses the exact broken file.
  let targetedShowErr: unknown;
  try {
    await persona({ values: { space: "endpoint-audit", plain: true }, positionals: ["show", "reviewagent"], raw: [] });
  } catch (err) {
    targetedShowErr = err;
  }
  assert.ok(isCommandFailure(targetedShowErr), "targeted persona show diagnoses invalid YAML in endpoint-audit");
  assert.equal(targetedShowErr.code, "SCHEMA_INVALID");
  assert.ok(targetedShowErr.message.includes("reviewagent.md"));

  // 2. Mint with invalid role keeps `--space endpoint-audit` in `cotal persona edit`.
  let badRoleErr: unknown;
  try {
    await mint({ values: { server: endpointServer, plain: true }, positionals: ["roleagent"], raw: [] });
  } catch (err) {
    badRoleErr = err;
  }
  assert.ok(isCommandFailure(badRoleErr), "mint with invalid role must refuse");
  assert.equal(badRoleErr.code, "SCHEMA_INVALID");
  assert.equal(
    badRoleErr.remedy,
    "give it such a role with `cotal persona edit roleagent --space endpoint-audit`, then mint again",
  );

  // 3. A resolved space name starting with `-` uses `--space=...` so the option parser does not choke.
  process.chdir(hyphenProject);
  let hyphenErr: unknown;
  try {
    await mint({ values: { server: hyphenServer, plain: true }, positionals: ["hyphenagent"], raw: [] });
  } catch (err) {
    hyphenErr = err;
  }
  assert.ok(isCommandFailure(hyphenErr), "mint in hyphenated space must refuse");
  assert.equal(
    hyphenErr.remedy,
    "see what is wrong with it with `cotal persona show hyphenagent --space=-audit`, then fix it and mint again",
  );

  emitSentinel({ passed: cells(), failed: 0 });
} finally {
  process.chdir(prevCwd);
  for (const k of envKeys) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
  rmSync(scratch, { recursive: true, force: true });
}
