import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import * as p from "@clack/prompts";
import { registry, type Connector, type ConnectorAssist, type ConnectorSetupAction, type ConnectorSetupProvider, type ConnectorShareSetupInput, type ConnectorSkillsSetupInput, type FlagSpec, type FlagValues, type ParsedArgs, type RuntimeProvider } from "@cotal-ai/core";
import {
  CommandFailure,
  canonicalRoot,
  checkUserBundle,
  extensionPackageDir,
  findMesh,
  homeCotalDir,
  inputDisabledByFlag,
  jsonFlag,
  loadMeshes,
  manifestExtensionNames,
  meshFile,
  personaDir,
  plainFlag,
  preferenceSpaceProblem,
  preferencesPath,
  preparedSpaceAt,
  presentationOf,
  provenance,
  readPreferences,
  resolveOnPath,
  seedConnectorServers,
  writePreference,
  writeResult,
  type Cell,
  type OutputWarning,
  type Presentation,
  type Report,
} from "@cotal-ai/workspace";
import { OFFICIAL_RUNTIMES, OFFICIAL_RUNTIME_TOOLS, materializeExtension } from "../ext-loader.js";
import { agentSkillsHome, agentSkillsSkew, canonicalSkillsDir, installAgentSkills, type AgentSkillsResult } from "../lib/agent-skills.js";
import { cliVersion } from "../lib/version.js";
import { brand, brandBold, dim, note, splash } from "../lib/theme.js";
import { runSteps, type Step } from "../lib/steps.js";
import { abortIfCancel } from "../lib/cancel.js";
import { openSetupLog, type SetupLog } from "../lib/setup-log.js";
import { resolveNatsServer } from "../lib/nats-bin.js";
import { isOnboarded, markOnboarded } from "../lib/onboard.js";
import { cotalOnPath, displayCmd, isNpx } from "../lib/self-exec.js";
import { addExtension } from "./ext.js";
import { canPrompt } from "./meshes-wizard.js";
import { runtimeProviders } from "./runtimes.js";
import { addFromBundle, checkLocalSpace, checkSelfHostedSpace, recordLocalSpace, type LocalSpaceState, type SelfHostedSpace } from "./space-registration.js";

const ONBOARD_VERSION = "2";

/** `cotal setup`'s grammar. Setup configures and starts nothing: launching is `cotal up`, `cotal
 *  spawn` and `cotal web`. With a terminal it asks for each input no flag gave; without one, or with
 *  `--yes`, `--no-input` or `--json`, every input is a flag. */
export const setupFlags = [
  { name: "destination", type: "string", value: "<local|self-hosted>", description: "where the space runs: local (this machine starts it) or self-hosted (a space registered here); Cloud is in development" },
  { name: "harness", short: "H", type: "string", value: "<connector>", description: "the application your agents run in: its own setup runs, and `cotal spawn` in the space launches it" },
  { name: "project", type: "string", value: "<dir>", description: "the project folder: the space's root, whose .cotal/agents holds its personas" },
  { name: "space", type: "string", value: "<name>", description: "the space to prepare (local) or the registered space to use (self-hosted)" },
  { name: "runtime", type: "string", multiple: true, value: "<name>", description: "a runtime to set up besides the built-in pty: tmux, cmux, orca, herdr or an installed one (repeatable); none without it" },
  { name: "connection-file", type: "string", value: "<bundle.json>", description: "self-hosted: register the space from a connection bundle exported where it runs" },
  { name: "configure-only", type: "boolean", description: "write the preparation and start nothing (the default)" },
  { name: "full", type: "boolean", description: "the guided flow with the guided expert team (implies --demo)" },
  { name: "demo", type: "boolean", description: "also seed the guided expert team (david, sven, me)" },
  { name: "yes", short: "y", type: "boolean", description: "ask nothing: every input comes from the flags" },
  { name: "skills", type: "boolean", description: "reconcile Cotal skills through installed connector providers and ~/.agents/skills; no personas or onboard writes" },
  jsonFlag,
  plainFlag,
] as const satisfies readonly FlagSpec[];

type SetupValues = FlagValues<typeof setupFlags>;
type Destination = "local" | "self-hosted";

/** The inputs a script names as flags. */
const REQUIRED = ["destination", "harness", "project", "space"] as const;
const INPUTS = [...REQUIRED, "runtime", "connection-file", "configure-only", "json", "plain"] as const;

interface SetupInputs {
  readonly destination: Destination;
  readonly harness: string;
  /** The runtimes to set up besides the built-in `pty`. */
  readonly runtimes: readonly string[];
  /** Absolute. */
  readonly project: string;
  /** The folder does not exist yet, and the operator agreed on a terminal to create it. */
  readonly createProject: boolean;
  readonly space: string;
  readonly connectionFile?: string;
}

/** A connector-owned setup action that finished, and what it said. */
interface ActionRun {
  readonly connector: string;
  readonly action: string;
  readonly title: string;
  readonly detail: string | null;
}

interface ActionFailure {
  readonly connector: string;
  readonly action: string;
  readonly title: string;
  readonly message: string;
}

/** A runtime setup can offer, as this machine has it before setup writes. */
interface RuntimeChoice {
  readonly name: string;
  /** The package that provides it; null for the built-in `pty` and a provider this build registered. */
  readonly package: string | null;
  /** The host tools an official runtime drives, any one of which counts. Empty for `pty` and a
   *  third-party runtime, whose tools setup cannot know. */
  readonly tools: readonly string[];
  /** The tool found: the driver's override when it is set, else the first of `tools` on PATH; or null. */
  readonly found: string | null;
  readonly installed: boolean;
}

/** A runtime as setup left it. */
interface RuntimeSetup {
  readonly name: string;
  readonly package: string | null;
  /** The host tools it drives and the one found; null when setup cannot know them. */
  readonly tool: { readonly names: readonly string[]; readonly found: string | null } | null;
  readonly selected: boolean;
  /** `set-up`: installed before this run. `added`: installed by it. `left-out`: not installed. */
  readonly state: "built-in" | "set-up" | "added" | "left-out";
  /** A selected provider's own `available()` answer, as `cotal runtimes` reports it; null when it was not asked. */
  readonly reachable: boolean | null;
  /** Why a selected runtime was left out or did not load. */
  readonly error: string | null;
}

interface Problem {
  readonly message: string;
  readonly remedy: string;
}

interface Written {
  readonly what: string;
  readonly path: string;
}

interface SetupResult {
  readonly kind: "setup";
  readonly destination: Destination;
  readonly space: string;
  /** The project folder: the space's root, whose `.cotal/agents` holds its personas. */
  readonly project: string;
  /** How setup found the space: prepared or registered by this run, or already in place. */
  readonly spaceState: LocalSpaceState | "added" | "registered";
  readonly harness: {
    readonly name: string;
    /** Host tools the harness needs that are not on PATH; its own setup did not run. */
    readonly missing: readonly string[];
    readonly failed: ActionFailure | null;
  };
  /** Every connector-owned setup action that ran, in order. */
  readonly actions: readonly ActionRun[];
  /** Every runtime setup offers: `pty`, the official ones and each installed third-party one. */
  readonly runtimes: readonly RuntimeSetup[];
  /** Every file or folder setup wrote, in order. Empty when a rerun changed nothing. */
  readonly written: readonly Written[];
  /** The command that comes next, and the folder to run it in when that matters. */
  readonly next: { readonly command: string; readonly cwd: string | null };
}

interface SetupCancelled {
  readonly kind: "setup-cancelled";
}

const usage = (message: string, remedy?: string): CommandFailure => new CommandFailure("refused", "USAGE_INVALID", message, remedy ? { remedy } : {});
const SCRIPTED_FORM = "cotal setup --destination local --harness <connector> --project <dir> --space <name> [--runtime <name>]";

/**
 * `cotal setup` prepares a space for your agents and starts nothing. Its inputs are the
 * destination (a local space this machine starts, or a self-hosted one registered here), the
 * application (the connector your agents run in), the runtimes to set up besides the built-in
 * `pty`, the project folder (the space's root) and the space name. On a terminal it asks for each
 * one no flag gave and shows the answers before it writes; in a script every one is a flag, and a
 * missing one is refused before anything is written. It then prepares or registers the space,
 * seeds the default persona into the project's `.cotal/agents`, records the application as the
 * space's `harness` preference, runs the application's own setup actions, reconciles Cotal's
 * skills and sets up the chosen runtimes. A rerun with the same answers changes nothing.
 * `--skills` only reconciles skills.
 */
export async function setup(args: ParsedArgs): Promise<void> {
  const values = args.values as SetupValues;
  if (values.skills) {
    if (values.full || values.demo) throw new Error("--skills cannot be combined with --full or --demo");
    const other = INPUTS.find((flag) => values[flag] !== undefined);
    if (other) throw usage(`--skills reconciles skills only, so it takes no --${other}`);
    await runSkillsOnly();
    return;
  }
  const presentation = presentationOf(values);
  if (values.destination !== undefined) destinationOf(values.destination);
  const interactive = presentation === "rich" && !values.yes && canPrompt();
  const runtimes = runtimeChoices();
  const inputs = interactive ? await askInputs(values, runtimes) : scriptedInputs(values, runtimes);
  if (inputs === undefined) return cancelled(presentation, values.space);
  const plan = await planSetup(inputs, runtimes);
  await prepare(plan, { demo: Boolean(values.demo) || Boolean(values.full), interactive, presentation });
}

/** Skills-only write for the status card: let installed connectors reconcile their own harness,
 *  then reconcile `~/.agents/skills`. Does not seed personas, offer a global install, or write the
 *  onboarded stamp. */
async function runSkillsOnly(): Promise<void> {
  await reconcileConnectorSkills();
  seedAgentSkills();
}

/** A destination this cut can prepare. Cloud is in development, so it is refused before anything is
 *  written or any endpoint is contacted. */
function destinationOf(value: string): Destination {
  if (value === "local" || value === "self-hosted") return value;
  if (value === "cloud")
    throw new CommandFailure("refused", "UNSUPPORTED", "Cotal Cloud is in development, so setup cannot prepare a Cloud space yet", { remedy: "pass --destination local or --destination self-hosted" });
  throw usage(`--destination ${value} is not a destination: pass local or self-hosted`);
}

/** The inputs of a run that asks nothing: every one is a flag, and the project folder exists. No
 *  `--runtime` sets up no runtime beyond `pty`. */
function scriptedInputs(v: SetupValues, choices: readonly RuntimeChoice[]): SetupInputs {
  const missing = REQUIRED.filter((flag) => v[flag] === undefined);
  if (missing.length > 0) throw usage(`setup asks nothing here, so every input is a flag: pass ${missing.map((flag) => `--${flag}`).join(", ")}`, SCRIPTED_FORM);
  const project = resolve(v.project!);
  if (!isDir(project)) throw usage(`--project ${project} is not a directory`, "create the folder first, or pass an existing one");
  return { destination: destinationOf(v.destination!), harness: v.harness!, runtimes: runtimeFlags(v.runtime ?? [], choices), project, createProject: false, space: v.space!, ...(v["connection-file"] === undefined ? {} : { connectionFile: v["connection-file"] }) };
}

/**
 * Asks for each input no flag gave: destination, application, runtimes, then the project and
 * space. The answers are shown before anything is written. Change asks every question again with
 * the answers so far, and Cancel saves nothing.
 */
async function askInputs(v: SetupValues, choices: readonly RuntimeChoice[]): Promise<SetupInputs | undefined> {
  const runtimes = v.runtime === undefined ? undefined : runtimeFlags(v.runtime, choices);
  if (!isOnboarded()) splash();
  p.intro(brandBold("Set up Cotal"));
  const candidates = await harnessCandidates();
  let given: Partial<SetupInputs> = {
    ...(v.destination === undefined ? {} : { destination: destinationOf(v.destination) }),
    ...(v.harness === undefined ? {} : { harness: v.harness }),
    ...(runtimes === undefined ? {} : { runtimes }),
    ...(v.project === undefined ? {} : { project: resolve(v.project) }),
    ...(v.space === undefined ? {} : { space: v.space }),
    ...(v["connection-file"] === undefined ? {} : { connectionFile: v["connection-file"] }),
  };
  let again = false;
  for (;;) {
    const ask = <K extends keyof SetupInputs>(key: K): boolean => again || given[key] === undefined;
    const destination = ask("destination") ? await askDestination(given.destination) : given.destination!;
    const harness = ask("harness") ? await askHarness(candidates, given.harness) : given.harness!;
    const runtimes = ask("runtimes") ? await askRuntimes(choices, given.runtimes) : given.runtimes!;
    const place = destination === "local" ? await askLocal(given, ask) : await askSelfHosted(given, ask);
    const inputs: SetupInputs = { destination, harness, runtimes, ...place };
    note(
      [
        `destination  ${destination === "local" ? "Local" : "Self-hosted"}`,
        `application  ${harness}`,
        `runtimes     ${["pty", ...runtimes].join(", ")}`,
        `project      ${inputs.project}${inputs.createProject ? " (created on save)" : ""}`,
        `space        ${inputs.space}`,
        ...(inputs.connectionFile === undefined ? [] : [`registered   from ${inputs.connectionFile}`]),
      ].join("\n"),
      "Your setup",
    );
    const choice = abortIfCancel(
      await p.select({
        message: "Save it?",
        options: [
          { value: "save", label: "Save" },
          { value: "change", label: "Change an answer" },
          { value: "cancel", label: "Cancel", hint: "nothing is saved" },
        ],
        initialValue: "save",
      }),
    );
    if (choice === "save") return inputs;
    if (choice === "cancel") return undefined;
    given = inputs;
    again = true;
  }
}

async function askDestination(initial: Destination | undefined): Promise<Destination> {
  return abortIfCancel(
    await p.select<Destination | "cloud">({
      message: "Where does your space run?",
      options: [
        { value: "local", label: "Local", hint: "this machine starts it" },
        { value: "self-hosted", label: "Self-hosted", hint: "it runs on a server and is registered here" },
        { value: "cloud", label: "Cloud", hint: "in development", disabled: true },
      ],
      initialValue: initial ?? "local",
    }),
  ) as Destination;
}

async function askHarness(candidates: readonly SetupConnectorCandidate[], initial: string | undefined): Promise<string> {
  return abortIfCancel(
    await p.select({
      message: "Which application do your agents run in?",
      options: candidates.map((c) => ({ value: c.value, label: c.label, hint: c.hint })),
      initialValue: initial ?? candidates.find((c) => c.missing.length === 0)?.value ?? candidates[0]!.value,
    }),
  );
}

/** The runtimes to set up besides `pty`. Installed ones and those whose host tool is found start
 *  selected. A note lists every runtime's state first, because clack shows a hint only on the
 *  focused and selected rows, and a label is what the answer repeats. */
async function askRuntimes(choices: readonly RuntimeChoice[], initial: readonly string[] | undefined): Promise<string[]> {
  const offered = choices.filter((r) => r.name !== "pty");
  const width = Math.max(...choices.map((r) => r.name.length));
  note(choices.map((r) => `${r.name.padEnd(width)}  ${r.name === "pty" ? "built in, always set up" : runtimeState(r)}`).join("\n"), "Runtimes");
  return abortIfCancel(
    await p.multiselect({
      message: "Which runtimes do your agents run in?",
      options: offered.map((r) => ({ value: r.name, label: r.name, hint: runtimeState(r) })),
      initialValues: [...(initial ?? offered.filter((r) => r.installed || r.found !== null).map((r) => r.name))],
      required: false,
    }),
  );
}

/** Whether a runtime is set up, and its host tool or, for a third-party one, its package. */
function runtimeState(r: RuntimeChoice): string {
  const tool = r.tools.length === 0 ? r.package : r.found !== null ? `${r.found} found` : `${r.tools.join(" or ")} not on PATH`;
  return `${r.installed ? "set up" : "not set up"}${tool ? ` · ${tool}` : ""}`;
}

/** A local space: the project folder, which a terminal may create, and the space's name. */
async function askLocal(given: Partial<SetupInputs>, ask: (key: keyof SetupInputs) => boolean): Promise<Omit<SetupInputs, "destination" | "harness" | "runtimes">> {
  let project = given.project;
  let createProject = given.createProject ?? false;
  if (ask("project") || project === undefined) {
    for (;;) {
      project = resolve(abortIfCancel(await p.text({ message: "Project folder (the space's root)", initialValue: project ?? process.cwd(), validate: (s) => (s?.trim() ? undefined : "name a folder") })).trim());
      if (isDir(project)) {
        createProject = false;
        break;
      }
      if (existsSync(project)) {
        p.log.warn(`${project} is not a folder`);
        continue;
      }
      if (abortIfCancel(await p.confirm({ message: `${project} does not exist. Create it?`, initialValue: true }))) {
        createProject = true;
        break;
      }
    }
  }
  const root = project;
  const space = ask("space") || given.space === undefined
    ? abortIfCancel(await p.text({ message: "Space name", initialValue: given.space ?? localSpaceAt(root), validate: (s) => preferenceSpaceProblem(s ?? "") })).trim()
    : given.space;
  return { project: root, createProject, space };
}

/** The space a project folder already holds, else one named after the folder. */
function localSpaceAt(root: string): string {
  const here = preparedSpaceAt(root)?.space ?? loadMeshes().find((m) => m.origin === "up" && canonicalRoot(m.root) === canonicalRoot(root))?.space;
  if (here) return here;
  const named = basename(root).replace(/[^A-Za-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "");
  return named || "main";
}

const FROM_FILE = "\0file";

/** A self-hosted space: one registered here, whose root is the project, or one to register from a
 *  connection file into a project folder that exists. */
async function askSelfHosted(given: Partial<SetupInputs>, ask: (key: keyof SetupInputs) => boolean): Promise<Omit<SetupInputs, "destination" | "harness" | "runtimes">> {
  const registered = loadMeshes().filter((m) => m.origin === "manual" || m.origin === "catalog");
  let space = given.space;
  if (ask("space") || space === undefined) {
    const picked = registered.length === 0
      ? FROM_FILE
      : abortIfCancel(
          await p.select({
            message: "Which space?",
            options: [...registered.map((m) => ({ value: m.space, label: m.space, hint: `${m.server} · ${m.root}` })), { value: FROM_FILE, label: "Register one from a connection file" }],
            initialValue: space !== undefined && registered.some((m) => m.space === space) ? space : registered[0]!.space,
          }),
        );
    space = picked === FROM_FILE ? undefined : picked;
  }
  const entry = space === undefined ? undefined : findMesh(space);
  if (entry) return { project: given.project ?? entry.root, createProject: false, space: entry.space };
  const connectionFile = ask("connectionFile") || given.connectionFile === undefined
    ? resolve(abortIfCancel(await p.text({ message: "Connection file (exported where the space runs)", initialValue: given.connectionFile ?? "", validate: bundleProblem })).trim())
    : given.connectionFile;
  const project = ask("project") || given.project === undefined
    ? resolve(abortIfCancel(await p.text({ message: "Project folder (the space's root)", initialValue: given.project ?? process.cwd(), validate: (s) => (isDir(resolve(s?.trim() ?? "")) ? undefined : "name a folder that exists") })).trim())
    : given.project;
  return { project, createProject: false, space: space ?? bundleSpace(connectionFile), connectionFile };
}

function bundleProblem(file: string | undefined): string | undefined {
  try {
    const check = checkUserBundle(readFileSync(resolve(file?.trim() ?? ""), "utf8"));
    return check.ok ? undefined : check.message.replace(/^✗ /, "");
  } catch (e) {
    return `cannot read it (${(e as NodeJS.ErrnoException).code ?? (e as Error).message})`;
  }
}

function bundleSpace(file: string): string {
  const check = checkUserBundle(readFileSync(file, "utf8"));
  if (!check.ok) throw usage(check.message.replace(/^✗ /, ""));
  return check.value.space;
}

/** The applications setup can set up: every installed connector. */
async function harnessCandidates(): Promise<SetupConnectorCandidate[]> {
  const candidates = setupConnectorCandidates(await setupConnectorSurface());
  if (candidates.length === 0) throw new CommandFailure("refused", "DEPENDENCY_UNAVAILABLE", "no connector is installed, so there is no application to set up", { remedy: "run `cotal ext seed`" });
  return candidates;
}

/** The runtimes setup offers: `pty`, the official ones in a stable order, then each third-party one
 *  an installed extension provides. */
function runtimeChoices(): RuntimeChoice[] {
  const providers = runtimeProviders();
  const official = Object.keys(OFFICIAL_RUNTIMES).map((name): RuntimeChoice => {
    const tool = OFFICIAL_RUNTIME_TOOLS[name] ?? { names: [] };
    const override = tool.override === undefined ? undefined : process.env[tool.override]?.trim();
    return { name, package: OFFICIAL_RUNTIMES[name]!, tools: tool.names, found: override || (tool.names.find((bin) => resolveOnPath(bin)) ?? null), installed: providers.has(name) };
  });
  const others = [...providers].filter(([name]) => name !== "pty" && !(name in OFFICIAL_RUNTIMES)).map(([name, pkg]): RuntimeChoice => ({ name, package: pkg ?? null, tools: [], found: null, installed: true }));
  return [{ name: "pty", package: null, tools: [], found: null, installed: true }, ...official, ...others];
}

/** The `--runtime` names, checked before anything is written: each must be a runtime setup offers,
 *  and an official one needs its host tool found. `pty` is always set up, so naming it adds nothing. */
function runtimeFlags(names: readonly string[], choices: readonly RuntimeChoice[]): string[] {
  for (const name of names) {
    const choice = choices.find((r) => r.name === name);
    if (!choice) throw usage(`--runtime ${name} is not a runtime: pass ${choices.map((r) => r.name).join(", ")}`, "install a third-party runtime with `cotal ext add <package>` first");
    if (choice.tools.length > 0 && choice.found === null)
      throw new CommandFailure("refused", "DEPENDENCY_UNAVAILABLE", `the ${name} runtime drives ${choice.tools.join(" or ")}, which is not on PATH`, { remedy: `install ${choice.tools[0]}, then run the same setup again` });
  }
  return [...new Set(names)].filter((name) => name !== "pty");
}

interface SetupPlan {
  readonly inputs: SetupInputs;
  readonly runtimes: readonly RuntimeChoice[];
  readonly candidate: SetupConnectorCandidate;
  readonly space: { readonly kind: "local"; readonly state: LocalSpaceState } | SelfHostedSpace;
}

/** Every check setup makes before it writes: the space name, the application, the space at the
 *  destination, and for a local space the NATS server `cotal up` will run. */
async function planSetup(inputs: SetupInputs, runtimes: readonly RuntimeChoice[]): Promise<SetupPlan> {
  const target = { space: inputs.space };
  const problem = preferenceSpaceProblem(inputs.space);
  if (problem) throw usage(problem);
  const candidates = await harnessCandidates();
  const candidate = candidates.find((c) => c.value === inputs.harness);
  if (!candidate) throw usage(`no harness "${inputs.harness}"; known harnesses: ${candidates.map((c) => c.value).join(", ")}`);
  if (inputs.destination === "self-hosted") return { inputs, runtimes, candidate, space: checkSelfHostedSpace(inputs.space, inputs.project, inputs.connectionFile) };
  if (inputs.connectionFile !== undefined) throw usage("--connection-file registers a self-hosted space", "pass --destination self-hosted, or drop --connection-file");
  const state = checkLocalSpace(inputs.space, inputs.project, "--project", true);
  try {
    await resolveNatsServer();
  } catch (e) {
    throw new CommandFailure("refused", "DEPENDENCY_UNAVAILABLE", (e as Error).message.split("\n")[0]!, { target, remedy: "install nats-server and put it on PATH, or reinstall cotal-ai under Node 22 or newer" });
  }
  return { inputs, runtimes, candidate, space: { kind: "local", state } };
}

/**
 * Writes what the plan checked: the space, the personas, the `harness` preference, the
 * application's own setup actions, Cotal's skills and the chosen runtimes. A harness or runtime
 * whose host tool is missing, an action that does not finish, or a runtime that does not install or
 * answer leaves the rest saved and the result partial.
 */
async function prepare(plan: SetupPlan, opts: { demo: boolean; interactive: boolean; presentation: Presentation }): Promise<void> {
  const { inputs, candidate } = plan;
  const target = { space: inputs.space };
  const written: Written[] = [];
  const wrote = (what: string, path: string): void => {
    written.push({ what, path });
    provenance.wrote(what, path);
  };
  const warnings: OutputWarning[] = [];

  let spaceState: SetupResult["spaceState"];
  if (plan.space.kind === "add") {
    const added = await addFromBundle(inputs.space, { file: plan.space.file, root: inputs.project, yes: !opts.interactive }, opts.interactive);
    if (added === undefined) return cancelled(opts.presentation, inputs.space);
    warnings.push(...added.warnings);
    written.push({ what: "space registration", path: meshFile(inputs.space) });
    spaceState = "added";
  } else if (plan.space.kind === "registered") {
    spaceState = "registered";
  } else {
    if (inputs.createProject) {
      mkdirSync(inputs.project, { recursive: true });
      wrote("project folder", inputs.project);
    }
    if (plan.space.state === "created") wrote("prepared space", recordLocalSpace(inputs.space, inputs.project).file);
    spaceState = plan.space.state;
  }

  const agents = personaDir(inputs.project);
  const defaultPersona = join(agents, "default.md");
  const seeded = reconcileDefaultAgent(defaultPersona);
  if (seeded !== "unchanged") wrote(seeded === "seeded" ? "default persona" : "updated default persona permissions", defaultPersona);
  if (opts.demo) {
    for (const [name, body] of Object.entries(DEMO_AGENTS)) writeDemoAgent(join(agents, `${name}.md`), body, wrote);
  }
  if (writePreference({ space: inputs.space }, "harness", inputs.harness, readPreferences().revision).changed) wrote(`harness preference of ${inputs.space}`, preferencesPath());

  const narrate = opts.presentation === "rich";
  const log = openSetupLog(join(inputs.project, ".cotal", "setup.log"));
  const actions = actionRunner(narrate, opts.interactive, log);
  if (candidate.missing.length === 0) {
    const provider = await availableSetupProvider(candidate.connector);
    if (provider?.connector) await actions.run(candidate.value, actionStep(provider.connector, undefined));
    // Resolved again because the connector action can change what is on PATH, and a provider whose
    // executables are gone must not write.
    const share = (await availableSetupProvider(candidate.connector))?.mcpServers;
    if (share) await actions.run(candidate.value, actionStep(share, connectorShareInput(candidate.connector)));
  }
  // A connector's skills action runs for every connector whose harness is present, so someone using
  // that harness gets Cotal's skills even without joining the mesh through it.
  for (const other of setupConnectorCandidates(await setupConnectorSurface())) {
    if (other.missing.length > 0) continue;
    const skills = (await availableSetupProvider(other.connector))?.skills;
    if (skills) await actions.run(other.value, actionStep(skills, connectorSkillsInput()));
  }
  if (agentSkillsSkew().some((s) => s.state !== "current")) {
    const skills = seedAgentSkills(log);
    written.push({ what: "cross-vendor skills", path: agentSkillsHome() });
    if (narrate) p.log.success(`Installed ${skills.installed.length} cross-vendor skill${skills.installed.length !== 1 ? "s" : ""} to ~/.agents/skills; read by Codex, Cursor, OpenCode, Gemini CLI, and Windsurf`);
    for (const b of skills.backedUp) warnings.push({ code: "SKILL_BACKED_UP", target, message: `your edited ${b.name} skill was backed up to ${b.path} before it was refreshed` });
  }
  const runtimes = await setUpRuntimes(plan.runtimes, inputs.runtimes, narrate, wrote);
  if (!isOnboarded()) {
    markOnboarded(ONBOARD_VERSION);
    wrote("onboarded stamp", join(homeCotalDir(), "onboarded.json"));
  }
  if (narrate) await offerGlobalInstall(!opts.interactive);

  const failed = actions.failed ?? null;
  const local = inputs.destination === "local" && spaceState !== "started";
  const result: SetupResult = {
    kind: "setup",
    destination: inputs.destination,
    space: inputs.space,
    project: inputs.project,
    spaceState,
    harness: { name: candidate.value, missing: candidate.missing, failed },
    actions: actions.ran,
    runtimes: runtimes.rows,
    written,
    next: local ? { command: `${displayCmd()} up`, cwd: inputs.project } : { command: `${displayCmd()} spawn --space ${inputs.space}`, cwd: null },
  };
  const problems: Problem[] = [
    ...(candidate.missing.length > 0
      ? [{ message: `${candidate.value} needs ${candidate.missing.join(", ")} on PATH, so its own setup did not run`, remedy: `install ${candidate.missing.join(", ")}, then run the same setup again` }]
      : failed
        ? [{ message: `${failed.title} did not finish (${failed.message})`, remedy: "fix it, then run the same setup again" }]
        : []),
    ...runtimes.problems,
  ];
  const partial = problems.length === 0
    ? undefined
    : { message: `${problems.map((x) => x.message).join("; ")}; the rest is saved`, remedy: [...new Set(problems.map((x) => x.remedy))].join("; ") };
  if (opts.interactive) p.outro(brand(partial ? "Saved, with a step left to finish." : "Saved."));
  writeResult(opts.presentation, { command: "setup", target, result, warnings, ...(partial ? { partial } : { noOp: written.length === 0 && actions.ran.length === 0 }) }, setupView);
}

/**
 * Sets up each selected runtime. An official one that is not installed is added the way `ext add`
 * adds it, at this cotal's version, when its host tool is on PATH; then each selected provider is
 * asked whether it answers. A runtime left unselected is never removed: `ext remove` does that.
 */
async function setUpRuntimes(
  choices: readonly RuntimeChoice[],
  selected: readonly string[],
  narrate: boolean,
  wrote: (what: string, path: string) => void,
): Promise<{ rows: RuntimeSetup[]; problems: Problem[] }> {
  const rows: RuntimeSetup[] = [];
  const problems: Problem[] = [];
  for (const r of choices) {
    const tool = r.tools.length === 0 ? null : { names: r.tools, found: r.found };
    const row = { name: r.name, package: r.package, tool };
    if (r.name === "pty") {
      rows.push({ ...row, selected: true, state: "built-in", reachable: null, error: null });
      continue;
    }
    if (!selected.includes(r.name)) {
      rows.push({ ...row, selected: false, state: r.installed ? "set-up" : "left-out", reachable: null, error: null });
      continue;
    }
    let state: "set-up" | "added" = "set-up";
    if (!r.installed && r.package !== null) {
      if (r.found === null) {
        rows.push({ ...row, selected: true, state: "left-out", reachable: null, error: `${r.tools.join(" or ")} not on PATH` });
        problems.push({ message: `the ${r.name} runtime needs ${r.tools.join(" or ")} on PATH, so it is not set up`, remedy: `install ${r.tools[0]}, then run the same setup again` });
        continue;
      }
      try {
        // With --json or --plain, stdout carries the result alone.
        await addExtension(`${r.package}@${cliVersion()}`, r.package, false, narrate ? console.log : (line) => console.error(line));
      } catch (e) {
        const error = (e as Error).message;
        rows.push({ ...row, selected: true, state: "left-out", reachable: null, error });
        problems.push({ message: `the ${r.name} runtime did not install (${error.split("\n")[0]})`, remedy: "fix it, then run the same setup again" });
        continue;
      }
      wrote(`${r.name} runtime`, extensionPackageDir(r.package));
      state = "added";
    }
    try {
      const reachable = (await materializeExtension<RuntimeProvider>({ kind: "runtime", name: r.name })).available();
      rows.push({ ...row, selected: true, state, reachable, error: null });
      if (!reachable)
        problems.push({ message: `the ${r.name} runtime is set up but does not answer here`, remedy: `${r.tools.length > 0 ? `make sure ${r.tools.join(" or ")} works here, then ` : ""}see \`cotal runtimes\`` });
    } catch (e) {
      const error = (e as Error).message;
      rows.push({ ...row, selected: true, state, reachable: null, error });
      problems.push({ message: `the ${r.name} runtime did not load (${error.split("\n")[0]})`, remedy: r.package === null ? "see `cotal runtimes`" : `reinstall it with \`cotal ext add ${r.package}\`` });
    }
  }
  return { rows, problems };
}

/** Runs connector-owned setup actions in order and stops at the first that does not finish. The rich
 *  presentation narrates each one, with the recovery menu on a terminal; the others run quietly. */
function actionRunner(narrate: boolean, interactive: boolean, log: SetupLog) {
  const ran: ActionRun[] = [];
  let failed: ActionFailure | undefined;
  return {
    ran,
    get failed() {
      return failed;
    },
    async run(connector: string, step: Step): Promise<void> {
      if (failed) return;
      let error: string | undefined;
      let detail: string | null = null;
      const tracked: Step = {
        ...step,
        async run() {
          try {
            const d = await step.run();
            detail = d ?? null;
            error = undefined;
            return d;
          } catch (e) {
            error = (e as Error).message;
            throw e;
          }
        },
      };
      let finished: boolean;
      if (narrate) finished = await runSteps([tracked], log, { yes: !interactive, assists: connectorAssists });
      else {
        try {
          await tracked.run();
          log.line(`${step.name}: ok${detail ? ` · ${detail}` : ""}`);
          finished = true;
        } catch {
          log.line(`${step.name}: FAILED · ${error}`);
          finished = false;
        }
      }
      if (finished) ran.push({ connector, action: step.name, title: step.title, detail });
      else failed = { connector, action: step.name, title: step.title, message: error ?? "stopped before it finished" };
    },
  };
}

function cancelled(presentation: Presentation, space: string | undefined): void {
  const target = space === undefined ? null : { space };
  const result: SetupCancelled = { kind: "setup-cancelled" };
  writeResult(presentation, { command: "setup", target, result, noOp: true, warnings: [{ code: "USER_CANCELLED", target, message: "nothing was saved" }] }, () => ({
    sections: [{ blocks: [{ kind: "lines", lines: [{ text: "nothing was saved", tone: "hint" }] }] }],
  }));
}

const SPACE_STATE: Record<SetupResult["spaceState"], string> = {
  created: "prepared by this setup",
  prepared: "already prepared",
  started: "already started here",
  added: "registered by this setup",
  registered: "already registered",
};

function setupView(r: SetupResult): Report {
  const unready = r.runtimes.filter((x) => x.selected && (x.state === "left-out" || x.error !== null || x.reachable === false)).map((x) => x.name);
  const head: Cell = r.harness.missing.length > 0 || r.harness.failed
    ? { text: `saved ${r.space}; ${r.harness.name} is not set up yet`, tone: "waiting", mark: "!" }
    : unready.length > 0
      ? { text: `set up ${r.space} for ${r.harness.name}; the ${unready.join(", ")} runtime${unready.length === 1 ? " is" : "s are"} not ready`, tone: "waiting", mark: "!" }
      : r.written.length > 0 || r.actions.length > 0
        ? { text: `set up ${r.space} for ${r.harness.name}`, tone: "ok", mark: "✓" }
        : { text: `${r.space} is already set up for ${r.harness.name}`, tone: "ok", mark: "✓" };
  const leftOut = r.runtimes.filter((x) => !x.selected && x.state === "left-out").map((x) => x.name);
  const application: Cell = r.harness.missing.length > 0
    ? { text: `${r.harness.name} · ${r.harness.missing.join(", ")} not on PATH`, tone: "failed" }
    : r.harness.failed
      ? { text: `${r.harness.name} · ${r.harness.failed.title} did not finish`, tone: "failed" }
      : r.harness.name;
  const fields: [string, Cell][] = [
    ["destination", r.destination],
    ["project", r.project],
    ["space", `${r.space} · ${SPACE_STATE[r.spaceState]}`],
    ["application", application],
    ...r.runtimes.filter((x) => x.selected || x.state !== "left-out").map((x): [string, Cell] => ["runtime", runtimeCell(x)]),
    ...(leftOut.length === 0 ? [] : [["not set up", leftOut.join(", ")] as [string, Cell]]),
    ...r.actions.map((a): [string, Cell] => ["ran", `${a.title}${a.detail ? ` · ${a.detail}` : ""}`]),
    ...r.written.map((w): [string, Cell] => ["wrote", `${w.what}: ${w.path}`]),
  ];
  const next: Cell = { text: r.next.cwd === null ? `next: ${r.next.command}` : `next: ${r.next.command}   (in ${r.next.cwd})`, tone: "hint" };
  return { sections: [{ blocks: [{ kind: "lines", lines: [head] }, { kind: "fields", rows: fields }, { kind: "lines", lines: [next] }] }] };
}

function runtimeCell(r: RuntimeSetup): Cell {
  if (r.state === "built-in") return `${r.name} · built in`;
  if (r.state === "left-out") return { text: `${r.name} · not set up: ${r.error}`, tone: "failed" };
  const state = r.state === "added" ? "added" : "already set up";
  if (r.error !== null) return { text: `${r.name} · ${state} · did not load`, tone: "failed" };
  if (r.reachable === false) return { text: `${r.name} · ${state} · does not answer`, tone: "waiting" };
  return `${r.name} · ${state}${r.reachable ? " · answers" : ""}`;
}

function isDir(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

/** When run via `npx` without a global `cotal`, offer to install it so the user can just type
 *  `cotal`. Interactive: a Y/n prompt (default yes). Non-interactive (`--yes` / no TTY): takes the
 *  default and installs. Best-effort — `npm i -g` fails a lot (EACCES, nvm/fnm/volta), so on failure
 *  we warn with the manual command and continue; setup never aborts over a PATH convenience. */
export async function offerGlobalInstall(yes: boolean): Promise<void> {
  if (!isNpx() || cotalOnPath()) return; // already have `cotal`, or not an npx run

  if (!yes && process.stdin.isTTY && !inputDisabledByFlag()) {
    const go = abortIfCancel(
      await p.confirm({ message: "Install `cotal` globally so you can just type `cotal`?", initialValue: true }),
    );
    if (!go) {
      p.log.info(`No problem - keep using ${dim("npx cotal-ai")}. Install later with ${dim("npm i -g cotal-ai")}.`);
      return;
    }
  }

  const pkg = `cotal-ai@${runningVersion() ?? "latest"}`;
  const s = p.spinner();
  s.start("Installing cotal globally");
  const r = spawnSync("npm", ["install", "-g", pkg], { encoding: "utf8" });
  if (r.status === 0) {
    s.stop("Installed - you can now run `cotal`");
  } else {
    s.stop("Couldn't install globally");
    const tail = `${r.stdout ?? ""}${r.stderr ?? ""}`.trim().split("\n").slice(-3).join("\n");
    p.log.warn(
      `${tail ? `${tail}\n\n` : ""}Install it yourself with ${dim("npm i -g cotal-ai")}, or keep using ${dim("npx cotal-ai")}.`,
    );
  }
}

/** The version of the running `cotal-ai` package (from the package.json next to the entry script),
 *  so a global install pins the same version npx just ran. Null if it can't be read. */
function runningVersion(): string | null {
  try {
    const pkg = JSON.parse(readFileSync(join(process.argv[1], "..", "..", "package.json"), "utf8"));
    return typeof pkg.version === "string" ? pkg.version : null;
  } catch {
    return null;
  }
}

/** Pick which agent connectors to set up. Detected ones are pre-checked (= the "all"
 *  default). Non-interactive / --yes selects all detected without prompting. */
export interface SetupConnectorCandidate {
  connector: Connector;
  value: string;
  label: string;
  hint: string;
  missing: string[];
}

/** Every connector on the setup surface becomes a choice. Its OWN declarations drive the hints —
 *  `requires` for readiness, `setup` for whether it runs connector-owned setup at all, `pluginRoot`
 *  for how that reads — and connector names never gate membership. Exported for the genericity smoke. */
export function setupConnectorCandidates(
  connectors: readonly Connector[],
  pathProbe: (bin: string) => boolean = (bin) => !!resolveOnPath(bin),
): SetupConnectorCandidate[] {
  return [...connectors]
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((connector) => {
      const missing = (connector.requires ?? []).filter((bin) => !pathProbe(bin));
      return {
        connector,
        value: connector.name,
        label: connector.name,
        missing,
        hint: missing.length
          ? `${missing.join(", ")} not on PATH`
          : connector.setup
            ? connector.pluginRoot
              ? "installs a plugin"
              : "runs its own setup"
            : "ready at spawn",
      };
    });
}

/** Materialize every connector advertised by the registry or installed manifest. Exported so the
 *  fail-loud smoke reaches the same discovery boundary as guided setup. */
export async function setupConnectorSurface(): Promise<Connector[]> {
  const names = new Set(registry.all<Connector>("connector").map((connector) => connector.name));
  for (const name of manifestExtensionNames("connector")) names.add(name);
  return Promise.all([...names].sort().map((name) =>
    materializeExtension<Connector>({ kind: "connector", name })
  ));
}

/** Resolve a connector's declared setup provider from the CONNECTOR the surface produced, never
 * from a name this file knows. A connector that declares none simply owns no setup; a DECLARED
 * provider that is missing or broken fails loud, because the base CLI never substitutes a built-in
 * harness implementation. Exported for the fail-loud smoke. */
export async function connectorSetupProvider(connector: Connector): Promise<ConnectorSetupProvider | null> {
  if (!connector.setup) return null;
  return materializeExtension<ConnectorSetupProvider>(connector.setup);
}

/** A connector's setup provider when its executables are on PATH, or null when the connector
 * declares none or they are absent. Neither is a failure of guided setup: the cross-vendor skills
 * drop still reconciles. */
async function availableSetupProvider(connector: Connector): Promise<ConnectorSetupProvider | null> {
  const provider = await connectorSetupProvider(connector);
  return provider && setupProviderAvailable(provider) ? provider : null;
}

/** One connector-owned setup action as a narrated step. Generic over the action's input so the
 * compiler checks each call site's pairing of an action with the input it hands it. `NoInfer` infers
 * `I` from the action alone: inferring it from the input too widens it to accept a dropped
 * (`undefined`) input. */
function actionStep<I>(setup: ConnectorSetupAction<I>, input: NoInfer<I>): Step {
  return {
    name: setup.name,
    title: setup.title,
    explain: setup.explain,
    context: [...(setup.context ?? [])],
    async run() { return setup.run(input); },
  };
}

/** The generic Cotal inputs every connector-owned skills installer receives. Nothing in it names a
 * harness: the provider decides how its own harness consumes the cross-vendor skills. */
function connectorSkillsInput(): ConnectorSkillsSetupInput {
  return { skillsDir: canonicalSkillsDir(), version: cliVersion(), stateDir: homeCotalDir() };
}

/** The cotal config write a connector's share action makes, bound to that connector's section. */
function connectorShareInput(connector: Connector): ConnectorShareSetupInput {
  return { seed: (servers) => seedConnectorServers(connector.name, servers) };
}

async function reconcileConnectorSkills(): Promise<void> {
  for (const connector of await setupConnectorSurface()) {
    const provider = await availableSetupProvider(connector);
    if (provider?.skills) await provider.skills.run(connectorSkillsInput());
  }
}

/** The debug handoffs a failed step may offer: every connector on the setup surface whose provider
 * declares one and whose executables are present. Resolved when a step fails, never earlier. */
async function connectorAssists(): Promise<ConnectorAssist[]> {
  const assists: ConnectorAssist[] = [];
  for (const connector of await setupConnectorSurface()) {
    const provider = await availableSetupProvider(connector);
    if (provider?.assist) assists.push(provider.assist);
  }
  return assists;
}

/** Pure availability rule for connector-owned setup actions. No executable means no harness write;
 * the caller still continues to the cross-vendor Agent Skills reconcile. */
export function setupProviderAvailable(provider: Pick<ConnectorSetupProvider, "requires">): boolean {
  return !(provider.requires?.some((command) => !resolveOnPath(command)) ?? false);
}

/** Reconcile Cotal's authored skills into the cross-vendor `~/.agents/skills` directory that Codex,
 *  Cursor, OpenCode, Gemini CLI, and Windsurf/Devin all read. Unlike the Claude Code plugin, these
 *  harnesses have no remote install/update path, so `cotal setup` reconciles the files (install/refresh,
 *  back up a user's edited copy, remove a retired Cotal skill) and `cotal status` reports skew. Idempotent;
 *  a re-run after an upgrade brings a deployed install current. */
function seedAgentSkills(log?: SetupLog): AgentSkillsResult {
  const r = installAgentSkills();
  provenance.wrote("cross-vendor skills", agentSkillsHome());
  log?.line(
    `agent-skills: installed ${r.installed.join(", ")}` +
      (r.backedUp.length ? `; backed up ${r.backedUp.map((b) => b.path).join(", ")}` : "") +
      (r.removed.length ? `; removed ${r.removed.join(", ")}` : ""),
  );
  return r;
}

/** Frontmatter marker (a comment line — the parser ignores `#` lines) stamping a demo persona as
 *  setup-managed, so re-runs may refresh it; remove the line to take ownership. */
const MANAGED_MARKER = "# managed by cotal-setup";

/** Write a setup-managed demo persona, refreshing it when its DEMO_AGENTS body changes — but never
 *  silently clobber a file the user has taken ownership of (one without the marker): back it up to
 *  `<name>.md.bak` first. Missing or marker-carrying files are written in place; every write goes
 *  through `wrote`. */
function writeDemoAgent(path: string, body: string, wrote: (what: string, path: string) => void): void {
  if (existsSync(path)) {
    const cur = readFileSync(path, "utf8");
    if (cur === body) return; // already current
    if (!cur.includes(MANAGED_MARKER)) {
      writeFileSync(`${path}.bak`, cur); // preserve a user/pre-marker edit
      wrote("backup of your edited persona", `${path}.bak`);
    }
  }
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, body);
  wrote("persona", path);
}

/** The default persona `cotal spawn` (no name) launches: a generic mesh agent, seeded once and
 *  then the user's to shape. Unlike the demo team it is not generally refreshed; only the
 *  byte-exact legacy template below is migrated, so any edit stands. Deleting it means the next
 *  `cotal setup` writes a fresh copy.
 *
 *  Channel scope is split intentionally: the ACTIVE set (`subscribe`) is EMPTY, so a fresh agent
 *  isn't firehosed every channel on the mesh at boot, while the read and post ACLs permit it to
 *  join, create, read, and post channels on demand. (`subscribe: [">"]` would auto-subscribe to
 *  every channel, the old behavior.) */
export const DEFAULT_AGENT = `---
name: default_agent
role: default
description: An agent on the mesh
tags: []
subscribe: []
allowSubscribe: [">"]
allowPublish: [">"]
capabilities: [spawn, run]
---

You are an agent on the Cotal mesh - a shared space where agents join, see who's around, and
coordinate as peers rather than working in silos. Use the Cotal tools available to you to find
your peers and work with them. Edit this file to give yourself a name, role, and purpose.
`;

/** The byte-exact default template shipped before wildcard post permission. Keep this frozen: a
 *  future edit to the current template must not make an older untouched file ineligible for repair. */
export const LEGACY_DEFAULT_AGENT = [
  "---",
  "name: default_agent",
  "role: default",
  "description: An agent on the mesh",
  "tags: []",
  "subscribe: []",
  'allowSubscribe: [">"]',
  "allowPublish: []",
  "capabilities: [spawn]",
  "---",
  "",
  "You are an agent on the Cotal mesh - a shared space where agents join, see who's around, and",
  "coordinate as peers rather than working in silos. Use the Cotal tools available to you to find",
  "your peers and work with them. Edit this file to give yourself a name, role, and purpose.",
  "",
].join("\n");

/** Return the shipped replacement only for the byte-exact legacy default. Any user edit, including
 *  whitespace or frontmatter changes, keeps the persona under user ownership. Exported so the
 *  static template smoke can grade the upgrade decision without touching real setup state. */
export function migrateLegacyDefaultAgent(current: string): string | undefined {
  return current === LEGACY_DEFAULT_AGENT ? DEFAULT_AGENT : undefined;
}

export function reconcileDefaultAgent(path: string): "seeded" | "migrated" | "unchanged" {
  if (existsSync(path)) {
    const replacement = migrateLegacyDefaultAgent(readFileSync(path, "utf8"));
    if (replacement === undefined) return "unchanged";
    writeFileSync(path, replacement);
    return "migrated";
  }
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, DEFAULT_AGENT);
  return "seeded";
}

/** The guided expert team `--demo` seeds: david (the engineer), sven (the guide) and me (your
 *  session). Setup-managed, unlike the seed-once default: see {@link writeDemoAgent}. */
const DEMO_AGENTS: Record<string, string> = {
  david: `---
${MANAGED_MARKER} - edit DEMO_AGENTS in the cotal CLI; delete this line to keep local changes
name: david
role: cotal-tech
description: "the engineer: how Cotal works (the wire, NATS, connectors, integration)."
tags: [cotal, technical, help]
subscribe: [welcome]
allowPublish: [welcome]
---

You are david, Cotal's engineer, live on the web for agents with the operator who just set Cotal
up. You help them set up and experiment. Your topic is how Cotal works: the wire contract (subjects,
message schemas, presence), NATS and JetStream underneath, the endpoint/connector model, the
delivery modes (multicast, unicast, anycast), and how to get any agent or framework onto the mesh.
You ground every answer in the real thing, never a guess. Start from \`docs/what-is-cotal.md\` (what Cotal
is and its core primitives) and \`docs/getting-started.md\`, then read the source for your topic:
\`docs/architecture.md\`, \`docs/connect-claude.md\`, \`docs/setup-internals.md\`, and, in a
source checkout, \`packages/\` and \`extensions/\`. Quote the exact subjects, message kinds, config, and
commands; if the docs don't cover it, say so rather than inventing. If they aren't on disk, look
them up at https://github.com/Cotal-AI/Cotal. If a question is really about use-cases or what to
build, hand it to your peer sven.
`,
  sven: `---
${MANAGED_MARKER} - edit DEMO_AGENTS in the cotal CLI; delete this line to keep local changes
name: sven
role: cotal-guide
description: "the guide: what to build with Cotal (examples, setups, getting the most out of it)."
tags: [cotal, examples, help]
subscribe: [welcome]
allowPublish: [welcome]
---

You are sven, Cotal's guide, live on the web for agents with the operator who just set Cotal up.
You help them set up and experiment. You design multi-agent setups: who should be on a space, how
they'd coordinate, what's worth trying - grounded in what Cotal can actually do, never made-up
features. Start from \`docs/what-is-cotal.md\` (what Cotal is and its core primitives - channels, anycast,
presence, spawn, personas, delivery modes) and \`docs/getting-started.md\`; read the matching example
in \`examples/*/README.md\` (indexed in \`docs/examples.md\`) before sketching, and reach for
\`docs/architecture.md\` when you need a primitive to design something new. Cite the example or
primitive you're drawing on. If they aren't on disk, look them up at https://github.com/Cotal-AI/Cotal.
For deep how-it-works or integration details, pull in your peer david.
`,
  me: `---
${MANAGED_MARKER} - edit DEMO_AGENTS in the cotal CLI; delete this line to keep local changes
name: me
role: operator
description: "your own session on the Cotal mesh."
tags: [cotal]
subscribe: [welcome]
allowPublish: [welcome]
capabilities: [spawn]
---

You are the operator's own session on the Cotal mesh: the agent they drive. Do what they ask and
use the mesh to get it done. Two experts are here to help you set up and experiment: david (the
engineer, how Cotal works) and sven (the guide, what to build). Reach them with cotal_dm or
cotal_anycast, grow the team with cotal_spawn, and if Cotal misbehaves send a report with
cotal_feedback. Docs: https://github.com/Cotal-AI/Cotal
`,
};
