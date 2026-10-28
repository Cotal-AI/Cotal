/** Broker-only auth starts name their missing local renewal owner and the stored expiry windows. */
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { credsClaims } from "@cotal-ai/core";
import { deliveryCredsKey, membershipRwCredsKey } from "@cotal-ai/workspace";
import { assertSmokeSandboxDown, createSuite, freePort, recordSmokeSandbox, SMOKE_BROKER_TOKEN } from "@cotal-ai/smoke-kit";

const suite = createSuite();
const bin = resolve(import.meta.dirname, "../../../bin/dist/cotal.js");
const sandbox = mkdtempSync(join(tmpdir(), `${SMOKE_BROKER_TOKEN}no-manager-credential-warning-`));
const inherited = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("COTAL_") && key !== "FORCE_COLOR"));
const code = "DAEMON_CREDENTIAL_RENEWAL_UNOWNED";
let clean = true;
type Envelope = { warnings?: { code: string; message: string }[]; result?: { instances?: { observedProcess?: string }[] } };

try {
  for (const scenario of ["legacy-auth", "controller-auth", "legacy-open", "controller-open", "controller-managed"] as const) {
    const root = join(sandbox, scenario), home = join(root, "home"), xdg = join(root, "xdg");
    for (const dir of [root, home, xdg]) mkdirSync(dir, { recursive: true, mode: 0o700 });
    const env = { ...inherited, HOME: home, USERPROFILE: home, COTAL_HOME: home, XDG_CONFIG_HOME: xdg, XDG_STATE_HOME: join(root, "state"), XDG_CACHE_HOME: join(root, "cache"), COTAL_SKIP_CONNECTOR_SEED: "1", COTAL_TELEMETRY: "off", NO_COLOR: "1" };
    const space = `cred-warning-${randomUUID().slice(0, 8)}`;
    const anchor = recordSmokeSandbox({ root, cotalHome: home, xdgConfigHome: xdg });
    const run = (...args: string[]) => {
      const options = { cwd: root, env, encoding: "utf8" as const, timeout: 90_000 };
      assertSmokeSandboxDown(anchor, args, options);
      const child = spawnSync(process.execPath, [bin, ...args], options);
      let envelope: Envelope | undefined;
      try { envelope = JSON.parse(child.stdout) as Envelope; } catch { envelope = undefined; }
      return { status: child.status, text: child.stdout + child.stderr, envelope };
    };
    const controller = scenario.startsWith("controller"), open = scenario.endsWith("open"), managed = scenario.endsWith("managed");
    let started = false;
    try {
      if (controller) {
        const prepared = run("space", "create", space, "--root", root);
        suite.check(`${scenario}: native space preparation succeeds`, prepared.status === 0, prepared.text);
      }
      const port = await freePort();
      if (port === 4222) throw new Error("default broker port is not an owned fixture port");
      const args = ["up", "--space", space, "--server", `nats://127.0.0.1:${port}`, "--detach", ...(managed ? [] : ["--no-manager"]), ...(open ? ["--open"] : []), ...(controller ? ["--json"] : [])];
      const up = run(...args);
      started = true;
      suite.check(`${scenario}: shipped CLI starts the owned stack`, up.status === 0, up.text);
      const expected = !open && !managed;
      const warning = controller ? up.envelope?.warnings?.find((w) => w.code === code)?.message : up.text;
      suite.check(`${scenario}: warning is limited to broker-only authenticated starts`, expected ? warning?.includes("--no-manager starts no local daemon-credential renewal owner") === true : !up.text.includes(code) && !up.text.includes("no local daemon-credential renewal owner"), up.text);
      if (expected) {
        for (const [name, key] of [["delivery.creds", deliveryCredsKey(space, { injected: false, root })], ["membership-rw.creds", membershipRwCredsKey(space, { injected: false, root })]] as const) {
          const exp = credsClaims(readFileSync(join(root, ".cotal", key), "utf8")).exp;
          suite.check(`${scenario}: ${name} warning quotes the stored expiry`, typeof exp === "number" && warning?.includes(`${name}: expires ${new Date(exp * 1000).toISOString()}`) === true, warning);
        }
        suite.check(`${scenario}: warning preserves same-store ownership and names diagnosis`, warning?.includes("Unless a manager renews this same secret store") === true && warning.includes("cotal doctor auth"), warning);
        const refresh = run("up", "--space", space, "--no-manager", ...(controller ? ["--plain"] : []));
        suite.check(`${scenario}: live refresh repeats the warning on the caller's receipt`, refresh.status === 0 && refresh.text.includes("no local daemon-credential renewal owner") && refresh.text.includes("membership-rw.creds: expires"), refresh.text);
      }
    } finally {
      const down = started ? run("down", "--yes") : undefined;
      const inventory = controller && started ? run("service", "--space", space, "--json") : undefined;
      const stopped = !started || down?.status === 0 && (!controller || inventory?.status === 0 && inventory.envelope?.result?.instances?.every((row) => row.observedProcess === "gone" || row.observedProcess === "previous-boot") === true);
      suite.check(`${scenario}: native cleanup confirms the owned stack stopped`, stopped, down?.text);
      clean &&= stopped;
    }
  }
} finally {
  if (clean) rmSync(sandbox, { recursive: true, force: true });
  else console.error(`Retained owned fixture for inspection: ${sandbox}`);
}
suite.finish();
process.exit(process.exitCode ?? 0);
