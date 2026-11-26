import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { delimiter, dirname, isAbsolute } from "node:path";
import { globalConfigDir, type Command, type ParsedArgs } from "@cotal-ai/core";
import { canonicalRoot, CommandFailure, findMesh, findPreparedSpace, homeCotalDir, releaseMaintenanceLock, rootControlProblem, spaceFlag } from "@cotal-ai/workspace";
import { preflightRuntime } from "../ext-loader.js";
import { foregroundHolder } from "../lib/foreground-hold.js";
import { DAEMON_NODE_FLAGS, isNpx, isPnpmDlx, selfArgv } from "../lib/self-exec.js";
import { serviceDefinitionStore } from "../lib/service-definitions.js";
import { observeServiceProcess, processServiceHost, serviceInstances } from "../lib/service-instances.js";
import { renderLaunchdStackUnit } from "../lib/service-launchd-unit.js";
import { renderSystemdStackUnit } from "../lib/service-systemd-unit.js";
import { acquireStackOperationLock, readStackJournal, STACK_ADAPTER, STACK_DEFINITION, STACK_ROLES, stackMaintenanceFence, stackNeverStarted, stackRecordedWithoutManager } from "../lib/stack-journal.js";
import { holdForegroundStack } from "./hold-foreground-stack.js";
import { pinExistingStore, refuseForegroundStackHolder, stackUp } from "./stack-up.js";
import { controllerStackNative, recordedBrokerTransport } from "./up-manifest.js";
import { preparedUpRoot } from "./up-target.js";

function nativePlatform(): "linux" | "darwin" {
  if (process.platform === "linux" || process.platform === "darwin") return process.platform;
  throw new CommandFailure("refused", "UNSUPPORTED", "stack units require Linux systemd or a macOS LaunchAgent; no unit was rendered or started");
}

function stackTarget(root: string, space: string) {
  const target = { root, space };
  const journal = readStackJournal(root)?.journal;
  if (!journal || journal.space !== space || stackNeverStarted(journal) || !journal.broker?.storeIdentity)
    throw new CommandFailure("refused", "TARGET_UNAVAILABLE", "this project does not have a recorded controller stack for the named space with a known broker store", { target, remedy: "start and stop the local stack with its original store before generating a unit" });
  const mesh = findMesh(space);
  const owner = mesh ?? findPreparedSpace(space);
  if (!owner || canonicalRoot(owner.root) !== root || mesh && (mesh.origin !== "up" || mesh.server !== journal.server) ||
      !journal.recovery || canonicalRoot(journal.recovery.home) !== canonicalRoot(homeCotalDir()))
    throw new CommandFailure("refused", "CONFLICT", "the space is not recorded at this project under this Cotal home; no alternate stack was selected", { target });
  if (journal.mode === "user" || stackMaintenanceFence(root, journal).fenced)
    throw new CommandFailure("refused", "UNSUPPORTED", "stack units support static-auth and open stacks without a pending recovery; no interactive login or recovery was substituted", { target });
  const store = pinExistingStore(journal.broker.storeDir, target);
  const recorded = journal.broker.storeIdentity;
  if (store.path !== recorded.path || store.dev !== recorded.dev || store.ino !== recorded.ino || store.birthtimeNs !== recorded.birthtimeNs)
    throw new CommandFailure("refused", "CONFLICT", "the recorded broker store was replaced; no unit opened a substitute store", { target });
  return { journal, store };
}

function stackBinding({ journal, store }: ReturnType<typeof stackTarget>, runtime: string | null): string {
  const { machine, uid } = processServiceHost();
  return createHash("sha256").update(JSON.stringify([machine, uid, journal.root, canonicalRoot(homeCotalDir()), journal.space, journal.server, journal.mode, store, runtime])).digest("hex");
}

function stackUnitKey(root: string, space: string, controlHome: string): string {
  return createHash("sha256").update(JSON.stringify([root, space, controlHome])).digest("hex");
}

function managerRuntime(root: string, space: string): string {
  const launch = serviceDefinitionStore(space).read(STACK_DEFINITION.manager)?.record.value.launch;
  if (launch?.type !== "adapter" || launch.adapter !== STACK_ADAPTER.manager || launch.options.root !== root || typeof launch.options.runtime !== "string" || launch.options.launch !== undefined)
    throw new CommandFailure("refused", "UNSUPPORTED", "no ordinary saved stack manager runtime could be established; a manifest launch or default runtime was not substituted", { target: { root, space } });
  return launch.options.runtime;
}

function requireStoppedMembers(space: string): void {
  for (const role of STACK_ROLES) {
    const held = serviceInstances(space, STACK_DEFINITION[role]).find(({ record }) => !["gone", "previous-boot", "foreign-pid"].includes(observeServiceProcess(record.value)));
    if (held) throw new CommandFailure("refused", "LIFECYCLE_BLOCKED", `the ${role} member is still running or its process could not be resolved; the unit did not adopt it`, { target: { space, instanceId: held.name }, remedy: "stop the existing stack with `cotal down --yes` from its project before starting the unit" });
  }
}

const unitFlags = [{ ...spaceFlag, description: "the recorded local space (required)" }, { name: "root", type: "string", value: "<dir>", description: "the recorded project folder (required)" }] as const;

function unitTarget(args: ParsedArgs) {
  if (typeof args.values.space !== "string" || !args.values.space || typeof args.values.root !== "string" || !args.values.root)
    throw new CommandFailure("refused", "USAGE_INVALID", "a stack unit needs both --space and --root; no current space or folder was assumed");
  const root = preparedUpRoot(args.values.root), space = args.values.space;
  const control = rootControlProblem(root);
  if (control) throw new CommandFailure("refused", "CONFLICT", control.message, { target: { root, space } });
  return { root, space };
}

function bootNote(platform: "linux" | "darwin", name: string): string {
  if (platform === "darwin") return `Save as ${name} in ~/Library/LaunchAgents. A LaunchAgent starts at login, not at boot before login.`;
  const uid = String(process.getuid!());
  const linger = spawnSync("loginctl", ["show-user", uid, "--property=Linger", "--value", "--no-ask-password", "--no-pager"], { encoding: "utf8", timeout: 2000, maxBuffer: 4096 });
  const value = linger.status === 0 && !linger.signal && !linger.error ? linger.stdout.trim() : "";
  const boot = value === "yes" ? "Linger is enabled. Once enabled, this unit can start without login."
    : `${value === "no" ? "Linger is disabled." : "Linger could not be determined."} Boot without login is not established. Check with loginctl show-user ${uid} --property=Linger.`;
  return `Save as ${name} in the systemd user unit directory. ${boot}`;
}

export const stackUnit: Command = {
  kind: "command", name: "stack-unit", group: "Services", reads: true, prepareMeshTarget: false,
  summary: "print an OS service definition that restarts one recorded local stack after failure",
  usage: "cotal stack-unit --space <space> --root <dir>", flags: unitFlags,
  async run(args) {
    const platform = nativePlatform();
    const { root, space } = unitTarget(args);
    const stack = stackTarget(root, space);
    const stopped = stack.journal.operation.kind === "down" && stack.journal.operation.phase === "completed";
    const started = stack.journal.operation.kind === "up" && stack.journal.operation.phase === "completed";
    if (!stopped && !started) throw new CommandFailure("refused", "LIFECYCLE_BLOCKED", "generate a unit only after this stack has completed an up or down", { target: { root, space } });
    const cli = selfArgv();
    if (cli.length !== 2 || !isAbsolute(cli[0]!) || !isAbsolute(cli[1]!) || !cli[1]!.endsWith(".js") || isNpx() || isPnpmDlx())
      throw new CommandFailure("refused", "UNSUPPORTED", "a stack unit needs a durable compiled Cotal entry; no transient launcher was recorded");
    const searchPath = process.env.PATH ?? "";
    const configHome = dirname(globalConfigDir()), controlHome = canonicalRoot(homeCotalDir());
    if (!isAbsolute(configHome) || !searchPath.split(delimiter).every(isAbsolute))
      throw new CommandFailure("refused", "USAGE_INVALID", "the stack unit needs an absolute config home and absolute PATH entries; no relative environment was copied");
    const noManager = stackRecordedWithoutManager(stack.journal);
    const binding = stackBinding(stack, noManager ? null : managerRuntime(root, space));
    const argv = [cli[0]!, ...DAEMON_NODE_FLAGS, cli[1]!, "__stack-unit", "--root", root, "--space", space, "--binding", binding, ...(noManager ? ["--no-manager"] : [])];
    const env = { COTAL_HOME: controlHome, XDG_CONFIG_HOME: configHome, PATH: searchPath };
    const key = stackUnitKey(root, space, controlHome), label = `ai.cotal.stack.${key}`;
    const source = platform === "linux" ? renderSystemdStackUnit(argv, env) : renderLaunchdStackUnit(label, argv, root, env);
    const name = platform === "linux" ? `cotal-stack-${key}.service` : `${label}.plist`;
    process.stderr.write(`${bootNote(platform, name)} No service was installed or started.\n`);
    process.stdout.write(source);
  },
};

export const stackUnitEntry: Command = {
  kind: "command", name: "__stack-unit", hidden: true, prepareMeshTarget: false, keepsStartupNotice: true,
  summary: "run a recorded stack in the foreground of a native supervisor",
  flags: [...unitFlags, { name: "binding", type: "string" }, { name: "no-manager", type: "boolean" }],
  async run(args) {
    nativePlatform();
    const { root, space } = unitTarget(args);
    if (typeof args.values.binding !== "string" || !/^[0-9a-f]{64}$/.test(args.values.binding) || !isAbsolute(process.env.COTAL_HOME ?? ""))
      throw new CommandFailure("refused", "USAGE_INVALID", "the native entry requires its recorded stack binding and an explicit Cotal home");
    const noManager = args.values["no-manager"] === true;
    process.chdir(root);
    const lock = acquireStackOperationLock(root, "foreground up");
    let released = false;
    const release = () => { if (!released) { releaseMaintenanceLock(lock); released = true; } };
    try {
      const stack = stackTarget(root, space);
      const runtime = noManager ? null : managerRuntime(root, space);
      if (stackBinding(stack, runtime) !== args.values.binding)
        throw new CommandFailure("refused", "CONFLICT", "the supervisor's recorded stack binding changed; no alternative project, store or runtime was started", { target: { root, space } });
      const holder = foregroundHolder(root);
      if (holder !== undefined) refuseForegroundStackHolder(root, space, holder, noManager);
      requireStoppedMembers(space);
      await holdForegroundStack(root, space, async () => {
        try {
          if (runtime !== null) await preflightRuntime(runtime);
          const { journal, writeReceipt } = await stackUp({ maintenanceLock: lock, root, space, server: stack.journal.server,
            mode: stack.journal.mode, runtime: runtime ?? "pty", noManager, transport: recordedBrokerTransport(root), foreground: true,
            supervisedStore: stack.store, presentation: "rich" }, controllerStackNative());
          writeReceipt();
          return journal;
        } finally { release(); }
      }, { supervised: true });
    } finally { release(); }
  },
};
