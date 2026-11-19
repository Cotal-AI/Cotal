/** Broker-only auth starts name their missing local renewal owner and the stored expiry windows. */
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { credsClaims } from "@cotal-ai/core";
import { deliveryCredsKey, membershipRwCredsKey, resolveOnPath, webCredsKey } from "@cotal-ai/workspace";
import { assertSmokeSandboxDown, createSuite, freePort, recordSmokeSandbox, SMOKE_BROKER_TOKEN } from "@cotal-ai/smoke-kit";

const suite = createSuite();
const bin = resolve(import.meta.dirname, "../../../bin/dist/cotal.js");
const sandbox = mkdtempSync(join(tmpdir(), `${SMOKE_BROKER_TOKEN}no-manager-credential-warning-`));
const inherited = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("COTAL_") && key !== "FORCE_COLOR"));
const code = "DAEMON_CREDENTIAL_RENEWAL_UNOWNED";
let clean = true;
type Envelope = { warnings?: { code: string; message: string }[]; result?: { instances?: { definition?: string; observedProcess?: string }[] } };

try {
  const noNpm = join(sandbox, "bin");
  const nats = resolveOnPath("nats-server");
  if (process.platform !== "win32" && nats) {
    mkdirSync(noNpm);
    symlinkSync(process.execPath, join(noNpm, "node"));
    symlinkSync(nats, join(noNpm, "nats-server"));
    const git = resolveOnPath("git");
    if (git) symlinkSync(git, join(noNpm, "git"));
  }
  for (const scenario of ["legacy-auth", "controller-auth", "legacy-open", "controller-open", "controller-managed"] as const) {
    const root = join(sandbox, scenario), home = join(root, "home"), xdg = join(root, "xdg");
    for (const dir of [root, home, xdg]) mkdirSync(dir, { recursive: true, mode: 0o700 });
    const env = { ...inherited, HOME: home, USERPROFILE: home, COTAL_HOME: home, XDG_CONFIG_HOME: xdg, XDG_STATE_HOME: join(root, "state"), XDG_CACHE_HOME: join(root, "cache"), COTAL_SKIP_CONNECTOR_SEED: "1", COTAL_TELEMETRY: "off", NO_COLOR: "1" };
    const withoutNpm = existsSync(noNpm) && (scenario === "legacy-auth" || scenario === "controller-auth");
    const upEnv = withoutNpm ? { ...env, PATH: noNpm, COTAL_SKIP_CONNECTOR_SEED: undefined, COTAL_ALLOW_CHECKOUT_SEED: "1" } : env;
    const space = `cred-warning-${randomUUID().slice(0, 8)}`;
    const anchor = recordSmokeSandbox({ root, cotalHome: home, xdgConfigHome: xdg });
    const run = (...args: string[]) => {
      const options = { cwd: root, env: args[0] === "up" ? upEnv : env, encoding: "utf8" as const, timeout: 90_000 };
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
      if (withoutNpm) {
        suite.check(`${scenario}: broker-only startup without npm leaves the seed store and extension prefix absent`,
          !existsSync(join(xdg, "cotal", "seed")) && !existsSync(join(xdg, "cotal", "extensions")), up.text);
        const running = controller ? run("service", "--space", space, "--json").envelope?.result?.instances
          ?.filter((row) => row.observedProcess === "running").map((row) => row.definition).sort() : undefined;
        suite.check(`${scenario}: broker-only startup without npm starts broker and delivery only`,
          controller ? JSON.stringify(running) === JSON.stringify(["stack-broker", "stack-delivery"])
            : /running in the background: nats-server \(pid \d+\), delivery daemon - /.test(up.text), { running, text: up.text });
      }
      if (!open) {
        // The dashboard's `service start web` default: minted on every static `up`, without an expiry.
        const web = credsClaims(readFileSync(join(root, ".cotal", webCredsKey(space, { injected: false, root })), "utf8"));
        suite.check(`${scenario}: up provisions the space's web.creds with no expiry`, web.exp === undefined, web);
      }
      if (managed) {
        const doctor = run("doctor", "auth");
        suite.check("doctor lists the unbounded dashboard credential without counting a finding",
          doctor.status === 0 && doctor.text.includes("No local credential findings") &&
          /^\s*web\.creds +unbounded +.* +not reported\s*$/m.test(doctor.text), doctor.text);
      }
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
      if (withoutNpm && scenario === "legacy-auth") {
        const down = run("down", "--yes");
        suite.check("legacy-auth: stop the broker-only stack before testing a manager-backed start", down.status === 0, down.text);
        const managedUp = run("up", "--space", space, "--server", `nats://127.0.0.1:${port}`);
        suite.check("a manager-backed start without npm still fails loudly at connector seeding",
          managedUp.status === 5 && managedUp.text.includes("OPERATION_FAILED") && managedUp.text.includes("the connector seed failed") && managedUp.text.includes("npm is not on PATH"), managedUp.text);
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
