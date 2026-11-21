/**
 * A `manager` preset service started at the root of a `--no-manager` controller stack is named
 * where the stack reports its manager.
 *
 * `status` said such a stack had no manager while the preset's manager answered `ps`, and bare `up`
 * refused with the legacy pidfile cause, naming no way out. Now `status` names that service and its
 * instance on the Manager row and in `folder.managerService`, and bare `up` refuses
 * LIFECYCLE_BLOCKED, exit 2, naming the service, its instance and the exact `cotal svc stop` that
 * stops it. Once it is stopped, bare `up` starts the stack's own manager.
 *
 * Prepares a space at a sandboxed root (`space create`), starts it with `up --detach --no-manager`,
 * then saves and starts `service add mgr --preset manager --runtime pty` there. No agent is launched.
 * Teardown uses the preset's instance-pinned stop, then `cotal down --yes`. Uncertain cleanup keeps
 * the private roots for inspection rather than signalling raw pids or deleting live state.
 * Linux only, since the native manager child is. Needs `nats-server` on PATH.
 *
 * Run: pnpm smoke:no-manager-preset:live
 */
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SMOKE_BROKER_TOKEN, assertSmokeSandboxDown, createSuite, freePort, recordSmokeSandbox, skipSuite, type SmokeSandboxAnchor } from "@cotal-ai/smoke-kit";
import { readManagerSeatCap } from "@cotal-ai/workspace";

if (process.platform !== "linux") skipSuite("the native manager child is Linux-only");
const BIN = join(import.meta.dirname, "..", "..", "..", "bin", "dist", "cotal.js");
if (!existsSync(BIN)) {
  console.error(`✗ ${BIN} missing - build first: pnpm --filter cotal-ai... build`);
  process.exit(1);
}

type Envelope = {
  outcome?: string;
  error?: { code: string; message: string; remedy?: string };
  target?: { services?: { definition: string; instanceId: string }[] } | null;
  result?: Record<string, unknown>;
};
type Instance = { definition: string; instanceId: string; pid?: number; observedProcess?: string };

const { check, finish } = createSuite();
const home = mkdtempSync(join(tmpdir(), "cotal-no-manager-preset-"));
const root = realpathSync(mkdtempSync(join(tmpdir(), `${SMOKE_BROKER_TOKEN}no-manager-preset-root-`)));
const space = `nomgr-${randomUUID().slice(0, 8)}`;
const server = `nats://127.0.0.1:${await freePort()}`;
const HOST_ENV = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith("COTAL_") && k !== "FORCE_COLOR" && k !== "NO_COLOR"));
const env = { ...HOST_ENV, HOME: home, USERPROFILE: home, XDG_CONFIG_HOME: join(home, ".config"), COTAL_HOME: join(home, ".cotal"), COTAL_SKIP_CONNECTOR_SEED: "1", NO_COLOR: "1" };
let anchor: SmokeSandboxAnchor | undefined;
const cotal = (...words: string[]) => {
  const options = { cwd: root, env, encoding: "utf8" as const, timeout: 120_000 };
  assertSmokeSandboxDown(anchor, words, options);
  const r = spawnSync(process.execPath, [BIN, ...words], options);
  let parsed: Envelope | undefined;
  try { parsed = JSON.parse(r.stdout) as Envelope; } catch { parsed = undefined; }
  return { status: r.status, stdout: r.stdout ?? "", stderr: r.stderr ?? "", env: parsed };
};
const shown = (r: ReturnType<typeof cotal>) => ({ status: r.status, error: r.env?.error, stdout: r.stdout.slice(0, 1500), stderr: r.stderr.slice(0, 800) });
const instances = (): Instance[] => (cotal("service", "--space", space, "--json").env?.result?.instances as Instance[] | undefined) ?? [];
const running = (definition: string) => instances().find((row) => row.definition === definition && row.observedProcess === "running");

try {
  const prepared = cotal("space", "create", space, "--root", root);
  check("fixture: the space is prepared at the sandbox root", prepared.status === 0, shown(prepared));
  anchor = recordSmokeSandbox({ root, cotalHome: env.COTAL_HOME, xdgConfigHome: env.XDG_CONFIG_HOME });
  const up = cotal("up", "--detach", "--no-manager", "--server", server, "--space", space);
  check("fixture: a controller stack starts with --no-manager", up.status === 0 && existsSync(join(root, ".cotal", "stack-controller.json")), shown(up));
  const cap = () => readManagerSeatCap({ root, space });
  check("the broker-only stack has no saved manager seat cap", cap() === undefined, cap());
  const conflictingStore = (requestedCap: string) => cotal("up", "--space", space, "--seat-cap", requestedCap, "--store-dir", join(root, "wrong-store"), "--json");
  const refusedCap = conflictingStore("2");
  check("a conflicting store refuses without saving the requested seat cap",
    refusedCap.status === 2 && refusedCap.env?.error?.code === "CONFLICT" && refusedCap.env.error.message.includes("recorded broker inputs") && cap() === undefined, { refused: shown(refusedCap), seatCap: cap() });
  const added = cotal("service", "add", "mgr", "--preset", "manager", "--root", root, "--runtime", "pty", "--space", space);
  const started = cotal("service", "start", "mgr", "--space", space);
  const mgr = running("mgr");
  check("fixture: a manager preset service starts at that root", added.status === 0 && started.status === 0 && mgr !== undefined, { added: shown(added), started: shown(started) });
  const id = mgr?.instanceId ?? "<none>";

  const status = cotal("status", "--json");
  const folder = status.env?.result?.folder as { noManager?: boolean; managerService?: unknown } | undefined;
  check("status --json names that service as the folder's managerService",
    status.status === 0 && folder?.noManager === true && JSON.stringify(folder.managerService) === JSON.stringify({ definition: "mgr", instanceId: id }), shown(status));
  const text = cotal("status");
  check("status names it on the Manager row and does not say the stack has none",
    text.status === 0 && text.stdout.split("\n").some((line) => /^\s+Manager:\s+/.test(line) && line.trimEnd().endsWith(`● the mgr service · instance ${id} · outside this stack, which was started with --no-manager`))
      && !text.stdout.includes("bare `cotal up` adds it"), shown(text));

  const launcher = /^\s{2}(.+) <command> \[options\]$/m.exec(cotal().stdout)?.[1];
  const stop = `stop it with \`${launcher} svc stop mgr --instance ${id} --space ${space} --yes\``;
  const refused = cotal("up", "--json");
  check("bare up refuses LIFECYCLE_BLOCKED, exit 2, naming the service, its instance and its exact stop",
    refused.status === 2 && refused.env?.error?.code === "LIFECYCLE_BLOCKED"
      && refused.env.error.message.startsWith(`the mgr service of this space runs this root's manager (pid ${mgr?.pid}, instance ${id})`)
      && launcher !== undefined && refused.env.error.remedy === `${stop}, then run \`${launcher} up\` again`
      && JSON.stringify(refused.env.target?.services) === JSON.stringify([{ definition: "mgr", instanceId: id }]), shown(refused));
  const brokerOnly = cotal("up", "--no-manager", "--json");
  const retry = /then run `([^`]+)` again$/.exec(brokerOnly.env?.error?.remedy ?? "")?.[1];
  const expectedRetry = `${launcher} up --space ${space} --no-manager`;
  check("the broker-only refusal retains the selected space and --no-manager",
    brokerOnly.status === 2 && brokerOnly.env?.error?.code === "LIFECYCLE_BLOCKED"
      && launcher !== undefined && brokerOnly.env.error.remedy === `${stop}, then run \`${expectedRetry}\` again`, shown(brokerOnly));

  const stopped = cotal("svc", "stop", "mgr", "--instance", id, "--space", space, "--yes");
  check("the named stop stops the service", stopped.status === 0 && running("mgr") === undefined, shown(stopped));
  if (launcher !== undefined && retry === expectedRetry) {
    const retried = cotal(...retry.slice(launcher.length + 1).split(" "), "--json");
    check("the printed retry succeeds without starting the stack's manager", retried.status === 0 && running("stack-manager") === undefined, shown(retried));
  }
  const again = cotal("up", "--json");
  check("bare up starts the stack's own manager without saving the refused cap", again.status === 0 && running("stack-manager") !== undefined && cap() === undefined, shown(again));
  const after = cotal("status", "--json");
  const settled = after.env?.result?.folder as { noManager?: boolean; managerService?: unknown } | undefined;
  check("status no longer reads the stack as --no-manager", after.status === 0 && settled?.noManager === false && settled.managerService === null, shown(after));

  const down = cotal("down", "--yes");
  check("down --yes stops the stack", down.status === 0 && instances().every((row) => row.observedProcess !== "running"), shown(down));
  const capped = cotal("up", "--space", space, "--seat-cap", "3", "--json");
  check("a successful start records the cap its manager accepted", capped.status === 0 && cap() === 3, { started: shown(capped), seatCap: cap() });
  const downCapped = cotal("down", "--yes");
  check("the capped stack stops normally", downCapped.status === 0, shown(downCapped));
  const refusedReplacement = conflictingStore("2");
  check("a refused restart leaves the last accepted seat cap intact", refusedReplacement.status === 2 && refusedReplacement.env?.error?.code === "CONFLICT" && cap() === 3,
    { refused: shown(refusedReplacement), seatCap: cap() });
  const limited = cotal("up", "--no-manager", "--max-payload", "131072", "--json");
  check("fixture: restart the earlier manager's stack without a manager and with a lower payload", limited.status === 0 && running("stack-manager") === undefined, shown(limited));
  const limitedDown = cotal("down", "--yes");
  check("fixture: stop the broker-only stack again", limitedDown.status === 0, shown(limitedDown));
  const retire = cotal("down", "--with-agents", "--yes", "--json");
  const retirementPreview = cotal("down", "--with-agents", "--dry-run", "--json");
  check("an earlier manager keeps retirement guarded without telling the operator to restart at an incompatible payload",
    retire.status === 2 && retire.env?.error?.code === "LIFECYCLE_BLOCKED" && retire.env.error.message.includes("agents from an earlier manager may still be running")
      && retire.env.error.remedy?.includes("131072 bytes") === true && retire.env.error.remedy.includes("263168 bytes") && !retire.env.error.remedy.includes("`cotal up`")
      && retirementPreview.status === 0 && retirementPreview.env?.outcome === "no-op" && retirementPreview.stdout.includes(retire.env.error.message), { apply: shown(retire), preview: shown(retirementPreview) });
} catch (error) {
  check("scenario completed", false, (error as Error).stack ?? String(error));
} finally {
  // Before the anchor is written, no process-starting command has run.
  let clean = anchor === undefined, detail: unknown;
  if (anchor) try {
    const preset = running("mgr");
    if (preset) cotal("svc", "stop", "mgr", "--instance", preset.instanceId, "--space", space, "--yes");
    const stopped = cotal("down", "--yes");
    const inventory = cotal("service", "--space", space, "--json");
    const remaining = inventory.env?.result?.instances as Instance[] | undefined;
    clean = stopped.status === 0 && inventory.status === 0 && Array.isArray(remaining)
      && remaining.every((row) => row.observedProcess === "gone" || row.observedProcess === "previous-boot");
    detail = { stopped: shown(stopped), inventory: shown(inventory) };
  } catch (error) { detail = (error as Error).message; }
  check("fixture cleanup confirms the owned processes stopped before removing their roots", clean, detail);
  if (clean) {
    rmSync(home, { recursive: true, force: true });
    rmSync(root, { recursive: true, force: true });
  } else console.error(`Private fixture retained for inspection: ${home} and ${root}`);
}

finish();
process.exit(process.exitCode ?? 0);
