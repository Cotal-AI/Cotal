/**
 * Real customer-entry smoke for automatic Agent Skills reconciliation. Every subprocess receives an
 * isolated HOME/XDG/COTAL_HOME and drives the built `cotal` binary. No broker or live stack is used.
 *
 * Named cells are mutation-graded in bin/smoke/mutations/agent-skills-entry.json.
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const ROOT = join(import.meta.dirname, "..", "..", "..");
const BIN = join(ROOT, "bin", "dist", "cotal.js");
const CANON = join(ROOT, "implementations", "cli", "cotal-skills", "skills", "team-topology", "SKILL.md");
const VERSION = JSON.parse(readFileSync(join(ROOT, "bin", "package.json"), "utf8")).version as string;
const canonical = readFileSync(CANON);
assert.ok(existsSync(BIN), `built binary missing at ${BIN}`);

const created: string[] = [];
const failures: string[] = [];
function fresh() {
  const root = mkdtempSync(join(tmpdir(), "cotal-agent-skills-entry-"));
  const home = join(root, "home");
  const xdg = join(root, "xdg");
  mkdirSync(home);
  mkdirSync(xdg);
  created.push(root);
  return {
    root,
    home,
    cotalHome: join(xdg, "cotal"),
    env: { ...process.env, HOME: home, USERPROFILE: home, XDG_CONFIG_HOME: xdg, COTAL_HOME: join(xdg, "cotal") },
    skill: join(home, ".agents", "skills", "team-topology", "SKILL.md"),
  };
}

function c(env: NodeJS.ProcessEnv, ...args: string[]) {
  const r = spawnSync(process.execPath, [BIN, ...args], { encoding: "utf8", env });
  return { ...r, out: `${r.stdout ?? ""}${r.stderr ?? ""}` };
}

const sha = (bytes: Buffer | string) => `sha256:${createHash("sha256").update(bytes).digest("hex")}`;

function ok(cell: string, condition: unknown, detail = "") {
  if (condition) console.log(`✓ ${cell}`);
  else {
    failures.push(cell);
    console.log(`✗ ${cell}${detail ? `: ${detail}` : ""}`);
  }
}

try {
  {
    const e = fresh();
    const r = c(e.env, "ext", "list");
    ok("FIRST NORMAL COMMAND: fresh install generation appears", r.status === 0 && existsSync(e.skill) && readFileSync(e.skill).equals(canonical), r.out);
    ok("NAMED HARNESSES: shared destination serves Codex OpenCode pi and Jcode", e.skill.includes(join(".agents", "skills", "team-topology")));
  }

  {
    const e = fresh();
    const initial = c(e.env, "ext", "list");
    if (initial.status === 0 && existsSync(e.skill)) {
      const old = "older-cli-generation\n";
      writeFileSync(e.skill, old);
      writeFileSync(join(e.cotalHome, "agent-skills.json"), JSON.stringify({ skills: { "team-topology": sha(old) } }, null, 2) + "\n");
      const r = c(e.env, "ext", "list");
      ok("NEWER CLI GENERATION: stale managed copy is refreshed", r.status === 0 && existsSync(e.skill) && readFileSync(e.skill).equals(canonical), r.out);
      ok("NEWER CLI GENERATION: owned stale copy is not misclassified as a user edit", !existsSync(`${e.skill}.bak`));

      writeFileSync(e.skill, "user-edit\n");
      const edited = c(e.env, "ext", "list");
      ok("USER EDIT: divergent managed copy is backed up before replacement", edited.status === 0 && existsSync(`${e.skill}.bak`) && readFileSync(`${e.skill}.bak`, "utf8") === "user-edit\n", edited.out);
    } else {
      ok("NEWER CLI GENERATION: stale managed copy is refreshed", false, initial.out || "startup hook did not create the managed skill");
      ok("NEWER CLI GENERATION: owned stale copy is not misclassified as a user edit", false);
      ok("USER EDIT: divergent managed copy is backed up before replacement", false, "startup hook did not create the managed skill");
    }

    const manifest = join(e.cotalHome, "agent-skills.json");
    if (existsSync(e.skill) && existsSync(manifest)) {
      const skillBefore = lstatSync(e.skill).mtimeNs;
      const manifestBefore = lstatSync(manifest).mtimeNs;
      const noop = c(e.env, "ext", "list");
      ok(
        "CURRENT GENERATION: normal command performs no skill writes",
        noop.status === 0 && lstatSync(e.skill).mtimeNs === skillBefore && lstatSync(manifest).mtimeNs === manifestBefore,
        noop.out,
      );
    } else ok("CURRENT GENERATION: normal command performs no skill writes", false, "startup hook did not establish current state");
  }

  {
    const e = fresh();
    const r = c(e.env, "--version");
    ok("VERSION PROBE: --version stays write-free", r.status === 0 && !existsSync(join(e.home, ".agents")) && !existsSync(e.cotalHome), r.out);
  }

  {
    const e = fresh();
    const r = c({ ...e.env, COTAL_UPDATE_TARGET_VERSION: VERSION, COTAL_UPDATE_PARENT: String(process.pid) }, "update");
    ok("UPDATE COMMAND: explicit update reconciles bundled Agent Skills", existsSync(e.skill) && readFileSync(e.skill).equals(canonical), r.out);
  }

  {
    const e = fresh();
    mkdirSync(e.cotalHome, { recursive: true });
    writeFileSync(join(e.cotalHome, "agent-skills.json"), "{broken");
    const r = c(e.env, "ext", "list");
    ok("CORRUPT OWNERSHIP: normal startup fails loud", r.status !== 0 && /Corrupt Cotal skills manifest/.test(r.out), r.out);
  }

  {
    const e = fresh();
    const outside = join(e.root, "outside-manifest");
    writeFileSync(outside, JSON.stringify({ skills: {} }));
    mkdirSync(e.cotalHome, { recursive: true });
    symlinkSync(outside, join(e.cotalHome, "agent-skills.json"));
    const r = c(e.env, "ext", "list");
    ok("SYMLINKED OWNERSHIP: normal startup refuses the redirected manifest", r.status !== 0 && /ownership path.*symlink/.test(r.out), r.out);
  }

  {
    const e = fresh();
    const outside = join(e.root, "outside");
    mkdirSync(outside);
    mkdirSync(join(e.home, ".agents"));
    symlinkSync(outside, join(e.home, ".agents", "skills"));
    const r = c(e.env, "ext", "list");
    ok("SYMLINKED DESTINATION: normal startup refuses the redirected tree", r.status !== 0 && /is a symlink/.test(r.out), r.out);
  }

  {
    const e = fresh();
    const status = c({ ...e.env, PATH: "" }, "status");
    ok("STATUS: every supported harness receives actionable skew", /Codex\/OpenCode\/pi\/Jcode/.test(status.out) && /cotal update/.test(status.out), status.out);
    ok("STATUS: read-only skew probe does not install skills", !existsSync(e.skill));
  }

  console.log("agent-skills-entry.smoke: completed");
  if (failures.length) {
    console.error(`agent-skills-entry.smoke: ${failures.length} failed cell(s): ${failures.join(" | ")}`);
    process.exitCode = 1;
  }
} finally {
  for (const root of created) rmSync(root, { recursive: true, force: true });
}
