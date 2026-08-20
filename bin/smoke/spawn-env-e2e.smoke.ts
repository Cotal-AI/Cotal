/**
 * spawn.env END TO END - the composed operator path, not its pieces.
 *
 * WHAT NOTHING ELSE COVERED. Every layer of this feature had a test and the COMPOSITION had none.
 * `launchEnv` is unit-tested, the connectors are tested against hand-built opts, `env-isolate` spawns
 * real pty and tmux children from a spec it builds itself, and the config layering is tested through
 * `loadCotalConfig`. Nobody had ever watched a real config file on disk confine a real child process.
 * `spawn.env` is the headline of this change and its containment was inferred rather than observed.
 *
 * So this drives the whole chain and asks the operating system what happened: a config file written
 * to the real operator path, read by the real loader, resolved by the same `spawnEnvAllow` the CLI
 * and the manager call, handed to a real connector's `buildLaunch`, and used to start an actual
 * process that reports the environment it actually received.
 *
 * THE EXPECTATION COMES FROM THE CONFIG THIS SUITE WROTE, NEVER FROM `envAllow`. That is not a
 * stylistic choice. The first version branched on `envAllow` to decide what to assert, so breaking
 * the resolution made the confined arm quietly take the inherit branch and pass: it derived its
 * expectation from the value under test. Both controls below survived it. The rule is that a cell
 * may read the input the operator supplied and the output the OS produced, and nothing in between.
 *
 * THIS GRADES `dist/`, NOT `src/`. `bin/` resolves the workspace packages to their builds, so a
 * source edit is invisible here until it is built. That is the right target for a composition test,
 * since the built artifact is what ships, but it means a mutation against `src` proves nothing about
 * this suite and must be made against the build.
 *
 * Proven to fail, twice, against the artifacts that actually execute:
 *   - `spawnEnvAllow` forced to `undefined`  -> 6 failures, every connector, resolution + containment
 *   - one connector dropping `envAllow`      -> 1 failure, naming that connector, others still green
 *
 * Run: pnpm smoke:spawn-env-e2e
 */
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadCotalConfig, spawnEnvAllow } from "@cotal-ai/core";
import { registry, type Connector, type LaunchOpts } from "@cotal-ai/core";
import "@cotal-ai/connector-claude-code";
import "@cotal-ai/connector-opencode";
import "@cotal-ai/connector-codex";

const ALLOWED = "E2E_ALLOWED_7f21", DENIED = "E2E_DENIED_7f21";
const box = mkdtempSync(join(tmpdir(), "cotal-e2e-"));
const creds = join(box, "a.creds");
writeFileSync(creds, "-----BEGIN NATS USER JWT-----\nx\n------END NATS USER JWT------\n");

// The operator's actual shell state. This is the input, not a fixture.
process.env[ALLOWED] = "allowed-value-7f21";
process.env[DENIED] = "denied-value-7f21";
process.env.COTAL_ROLE = "PARENT-ROLE-MUST-NOT-CROSS";   // a per-session name held by the parent

function realConfigRoot(spawnBlock: unknown | undefined): string {
  const c = mkdtempSync(join(box, "cfg-"));
  const xdg = join(c, "xdg"); mkdirSync(join(xdg, "cotal"), { recursive: true });
  process.env.XDG_CONFIG_HOME = xdg;
  if (spawnBlock !== undefined)
    writeFileSync(join(xdg, "cotal", "config.json"), JSON.stringify({ spawn: spawnBlock }));
  const root = join(c, "space"); mkdirSync(join(root, ".cotal"), { recursive: true });
  return root;
}

/** Spawn a REAL process with the connector's env and ask the OS what it got. */
function childEnv(env: Record<string, string>): Record<string, string> {
  const r = spawnSync(process.execPath, ["-e", 'console.log("ENV " + JSON.stringify(process.env))'],
    { env, encoding: "utf8" });
  if (r.status !== 0) throw new Error(`child failed: ${r.stderr}`);
  const line = r.stdout.split("\n").find((l) => l.startsWith("ENV "));
  if (!line) throw new Error("child produced no report");
  return JSON.parse(line.slice(4));
}

let fail = 0;
const ck = (label: string, cond: boolean, extra = "") => {
  console.log(`${cond ? "  ✓" : "  ✗"} ${label}${cond ? "" : "  <- " + extra}`); if (!cond) fail++;
};

for (const connectorName of ["claude", "opencode", "codex"]) {
  console.log(`\n=== ${connectorName} ===`);
  const connector = registry.resolve<Connector>("connector", connectorName);

  for (const [mode, block] of [["DEFAULT (no spawn block)", undefined],
                               ["CONFINED (spawn.env allow-list)", { env: [ALLOWED] }]] as const) {
    const root = realConfigRoot(block);
    const cfg = loadCotalConfig(root);                 // real loader, real file
    const envAllow = spawnEnvAllow(cfg);               // real caller-side resolution
    const opts = { space: "e2e", name: "seat", role: "worker", id: "AGENTIDPLACEHOLDER",
      lifecycleUid: "lc-1", creds, servers: "nats://127.0.0.1:14999",
      subscribe: ["general"], allowSubscribe: ["general"], allowPublish: ["general"],
      workspaceRoot: root, envAllow } as LaunchOpts;
    const spec = connector.buildLaunch(opts);          // real connector
    const got = childEnv((spec.env ?? {}) as Record<string, string>);  // REAL process

    console.log(` ${mode}  (envAllow=${envAllow === undefined ? "undefined" : JSON.stringify(envAllow)})`);
    // The expectation comes from the CONFIG FILE THIS TEST WROTE, never from `envAllow`. Branching on
    // envAllow would derive the expectation from the value under test: break the resolution and the
    // confined arm would silently take the inherit branch and pass. Measured, not hypothetical - the
    // first version of this file did exactly that and survived its own control.
    if (block === undefined) {
      ck("operator's allowed var reached the real child", got[ALLOWED] === "allowed-value-7f21", String(got[ALLOWED]));
      ck("operator's other var reached it too (inherit means inherit)", got[DENIED] === "denied-value-7f21", String(got[DENIED]));
    } else {
      ck("config declared an allow-list, so it must have RESOLVED", envAllow !== undefined, "spawnEnvAllow returned undefined for a config that declares spawn.env");
      ck("allow-listed var reached the real child", got[ALLOWED] === "allowed-value-7f21", String(got[ALLOWED]));
      ck("NON-listed var was confined out", got[DENIED] === undefined, String(got[DENIED]));
    }
    ck("parent's COTAL_ROLE did NOT cross", got.COTAL_ROLE !== "PARENT-ROLE-MUST-NOT-CROSS", String(got.COTAL_ROLE));
    ck("child got its OWN role", got.COTAL_ROLE === "worker", String(got.COTAL_ROLE));
    ck("HOME forwarded in both modes (the documented cost)", typeof got.HOME === "string" && got.HOME.length > 0);
  }
}
console.log(fail === 0 ? "\nE2E OK" : `\nE2E FAILED: ${fail}`);
process.exit(fail === 0 ? 0 : 1);
