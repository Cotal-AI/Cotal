/** Exercise the retained launcher through the built, shipped CLI on owned loopback brokers. */
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { canonicalLocalProcessPath, MANAGER_PIDFILE, probeLiveness } from "@cotal-ai/workspace";
import { assertSmokeSandboxDown, createSuite, freePort, recordSmokeSandbox, SMOKE_BROKER_TOKEN } from "@cotal-ai/smoke-kit";

const suite = createSuite();
const cli = resolve(import.meta.dirname, "../../../bin/dist/cotal.js");
const sandbox = mkdtempSync(join(tmpdir(), `${SMOKE_BROKER_TOKEN}control-plane-guidance-`));
const home = join(sandbox, "home");
const xdg = join(home, "xdg");
const inherited = { ...process.env };
for (const key of Object.keys(inherited)) if (key.startsWith("COTAL_")) delete inherited[key];
const env = { ...inherited, HOME: home, COTAL_HOME: home, XDG_CONFIG_HOME: xdg, COTAL_SKIP_CONNECTOR_SEED: "1", COTAL_TELEMETRY: "off" };
const plain = (text: string) => text.replace(/\x1b\[[0-9;]*m/g, "");
let cleaned = true;

try {
  for (const malformed of [true, false]) {
    const label = malformed ? "refused" : "clean";
    const space = `guidance-${label}`;
    const root = join(sandbox, label);
    const anchor = recordSmokeSandbox({ root, cotalHome: home, xdgConfigHome: xdg });
    const pidfile = canonicalLocalProcessPath(MANAGER_PIDFILE, { root, space });
    if (malformed) {
      mkdirSync(dirname(pidfile), { recursive: true });
      writeFileSync(pidfile, "garbage");
    }
    const run = (...args: string[]) => {
      const options = { cwd: root, env, encoding: "utf8" as const, timeout: 60_000 };
      assertSmokeSandboxDown(anchor, args, options);
      return spawnSync(process.execPath, [cli, ...args], options);
    };
    let brokerPid: number | undefined;
    try {
      // An unprepared root deliberately exercises the supported retained launcher. A fresh
      // prepared root uses controller members and would never reach this control-plane catch.
      const result = run("up", "--open", "--no-manager", "--detach", "--space", space,
        "--server", `nats://127.0.0.1:${await freePort()}`, "--store-dir", join(root, "store"));
      const output = plain(result.stdout + result.stderr);
      const brokerRecord = join(root, ".cotal", "nats.pid");
      if (existsSync(brokerRecord)) brokerPid = Number(readFileSync(brokerRecord, "utf8").trim());
      suite.check(`${label} startup reaches the real retained broker launcher`,
        brokerPid !== undefined && probeLiveness(brokerPid) === "alive" && /✓ running in the background: nats-server \(pid \d+\) - stop with: `cotal down`/.test(output), output);
      if (malformed) {
        suite.check("control-plane refusal keeps a nonzero exit", result.status === 1, output);
        suite.check("control-plane refusal preserves the cause and its own next step",
          output.includes(`! control plane degraded: the manager pidfile at ${pidfile} holds content that is not a pid ("garbage")`) &&
          output.includes(`NEXT: once \`cotal ps --space ${space}\` finds no manager running, remove that file and re-run.`), output);
        suite.check("control-plane refusal never appends the fixed supervise remedy",
          !output.includes("start one with: cotal supervise"), output);
        suite.check("control-plane refusal states the spawn and retirement consequence",
          output.includes("Spawn and retirement require a functioning control plane."), output);
        // `down` refuses that pidfile too, so Next removes it and runs the broker-only start again.
        const next = plain(result.stdout).trimEnd().split("\n");
        suite.check("a broker-only start's Next removes the pidfile and runs up --no-manager again, not a down that refuses it",
          JSON.stringify(next.slice(next.lastIndexOf("Next") + 1).map((line) => line.trim().split(/ {2,}/))) ===
            JSON.stringify([[`rm ${pidfile}`, `Remove the pidfile once \`cotal ps --space ${space}\` finds no manager running`], ["cotal up --no-manager", "Then refresh the stack without a manager"]]), output);
        rmSync(pidfile);
        const again = run("up", "--no-manager");
        const againOutput = plain(again.stdout + again.stderr);
        suite.check("that up --no-manager, once the pidfile is removed, refreshes the stack broker-only and exits 0",
          again.status === 0 && againOutput.includes("already running") && !existsSync(pidfile) && !againOutput.includes("control plane degraded"), againOutput);
        suite.check("control-plane refusal does not claim the manager or delivery daemon started",
          !/✓.*(?:manager|delivery daemon)/.test(output), output);
      } else {
        suite.check("clean broker-only startup exits successfully without degraded guidance",
          result.status === 0 && !output.includes("control plane degraded") && !output.includes("start one with: cotal supervise"), output);
      }
    } finally {
      // Only the fixture's own malformed bytes can be removed; never discard a successor's record.
      if (malformed && existsSync(pidfile) && readFileSync(pidfile, "utf8") === "garbage") rmSync(pidfile);
      const down = run("down");
      let stopped = brokerPid === undefined || probeLiveness(brokerPid) === "dead";
      for (let i = 0; !stopped && i < 100; i++) {
        await new Promise((r) => setTimeout(r, 50));
        stopped = probeLiveness(brokerPid!) === "dead";
      }
      suite.check(`${label} teardown stops its owned broker`, down.status === 0 && stopped, down.stdout + down.stderr);
      if (down.status !== 0 || !stopped) cleaned = false;
    }
  }
} finally {
  // A failed stop retains the private stores for inspection instead of unlinking live state.
  if (cleaned) rmSync(sandbox, { recursive: true, force: true });
  else console.error(`retained owned test stores: ${sandbox}`);
  suite.finish();
}
