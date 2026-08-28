import { mkdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { parseArgs, type ParseArgsOptionsConfig } from "node:util";

const smokeSandboxAnchor: unique symbol = Symbol("smokeSandboxAnchor");

interface RecordedDirectory {
  readonly path: string;
  readonly physicalPath: string;
  readonly dev: bigint;
  readonly ino: bigint;
}

/** Exact sandbox identity captured before a smoke can invoke the CLI. */
export interface SmokeSandboxAnchor {
  readonly [smokeSandboxAnchor]: {
    readonly root: RecordedDirectory;
    readonly marker: RecordedDirectory;
    readonly cotalHome: RecordedDirectory;
    readonly xdgConfigHome: RecordedDirectory;
  };
}

export interface SmokeCommandOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
}

const downOptions: ParseArgsOptionsConfig = {
  file: { type: "string", short: "f" },
  run: { type: "string" },
  space: { type: "string" },
  "dry-run": { type: "boolean" },
  "preserve-state": { type: "boolean" },
  "store-dir": { type: "string" },
};

interface ParsedSmokeDown {
  readonly positionals: string[];
  readonly values: Record<string, string | boolean | undefined>;
}

function parseSmokeDown(args: readonly string[]): ParsedSmokeDown | undefined {
  if (args[0] !== "down") return undefined;
  try {
    // Calling the same Node parser as the CLI's parseCommandArgs is necessary. Applying the same
    // acceptance test makes the guard agree on which parsed value the CLI will honor. This is a
    // safety lower bound: the guard may refuse more values, but must never accept one the consumer
    // treats as absent. Do not replace this with argv scanning: flag order, `--space=value`, and
    // repeated non-multiple flags are valid, and parseArgs deterministically applies last-wins.
    const { positionals, values } = parseArgs({
      args: args.slice(1),
      options: downOptions,
      allowPositionals: true,
      strict: true,
    });
    return { positionals, values: values as ParsedSmokeDown["values"] };
  } catch (error) {
    throw new Error(
      `smoke sandbox refused cotal down: cannot classify arguments ${JSON.stringify(args)} with the strict down parser`,
      { cause: error },
    );
  }
}

function exactAbsolute(name: string, value: string | undefined): string {
  if (!value || !isAbsolute(value))
    throw new Error(`smoke sandbox ${name} must be an exact absolute path, received ${JSON.stringify(value)}`);
  return value;
}

function directoryIdentity(name: string, path: string): RecordedDirectory {
  let stat: ReturnType<typeof statSync>;
  let physicalPath: string;
  try {
    stat = statSync(path, { bigint: true });
    physicalPath = realpathSync.native(path);
  } catch (error) {
    throw new Error(`cannot establish smoke sandbox ${name} identity at ${JSON.stringify(path)}`, { cause: error });
  }
  if (!stat.isDirectory()) throw new Error(`smoke sandbox ${name} is not a directory: ${JSON.stringify(path)}`);
  return Object.freeze({ path, physicalPath, dev: stat.dev, ino: stat.ino });
}

function sameDirectory(expected: RecordedDirectory, observedPath: string): "same" | "foreign" | "missing" {
  try {
    const observed = directoryIdentity("observed directory", observedPath);
    return observed.physicalPath === expected.physicalPath && observed.dev === expected.dev && observed.ino === expected.ino
      ? "same"
      : "foreign";
  } catch {
    return "missing";
  }
}

/**
 * Record the sandbox's concrete identity once, before any CLI invocation can resolve ambient state.
 * The owned `.cotal` directory is load-bearing: it terminates `findCotalRoot` inside the scratch root
 * instead of letting a bare `down` walk upward into an operator checkout. Later guards inspect only
 * these exact recorded paths and identities. They never resolve a mesh target or search ancestors.
 */
export function recordSmokeSandbox(input: {
  root: string;
  cotalHome: string;
  xdgConfigHome: string;
}): SmokeSandboxAnchor {
  const root = exactAbsolute("root", input.root);
  const cotalHome = exactAbsolute("COTAL_HOME", input.cotalHome);
  const xdgConfigHome = exactAbsolute("XDG_CONFIG_HOME", input.xdgConfigHome);
  const marker = join(root, ".cotal");
  mkdirSync(marker, { recursive: true });
  mkdirSync(cotalHome, { recursive: true });
  mkdirSync(xdgConfigHome, { recursive: true });
  return Object.freeze({
    [smokeSandboxAnchor]: Object.freeze({
      root: directoryIdentity("root", root),
      marker: directoryIdentity("root ownership marker", marker),
      cotalHome: directoryIdentity("COTAL_HOME", cotalHome),
      xdgConfigHome: directoryIdentity("XDG_CONFIG_HOME", xdgConfigHome),
    }),
  });
}

function assertRecordedSandboxDown(
  anchor: SmokeSandboxAnchor | undefined,
  args: readonly string[],
  options: SmokeCommandOptions,
  parsed = parseSmokeDown(args),
): void {
  if (!parsed) return;
  if (!anchor) {
    throw new Error(
      `smoke sandbox refused cotal down: observed root ${JSON.stringify(options.cwd ?? "<missing>")}, ` +
        `expected root "<missing anchor>"`,
    );
  }

  const expected = anchor[smokeSandboxAnchor];
  const observedRoot = options.cwd;
  const cotalHome = options.env?.COTAL_HOME;
  const xdgConfigHome = options.env?.XDG_CONFIG_HOME;
  const rootIdentity = typeof observedRoot === "string" ? sameDirectory(expected.root, observedRoot) : "missing";
  const markerIdentity = sameDirectory(expected.marker, expected.marker.path);
  const homeIdentity = cotalHome === expected.cotalHome.path ? sameDirectory(expected.cotalHome, cotalHome) : "foreign";
  const configIdentity = xdgConfigHome === expected.xdgConfigHome.path ? sameDirectory(expected.xdgConfigHome, xdgConfigHome) : "foreign";
  const rootMatches = rootIdentity === "same";
  const markerHeld = markerIdentity === "same";
  const homeMatches = homeIdentity === "same";
  const configMatches = configIdentity === "same";
  if (rootMatches && markerHeld && homeMatches && configMatches) return;

  throw new Error(
    `smoke sandbox refused cotal down: observed root ${JSON.stringify(observedRoot ?? "<missing>")}, ` +
      `expected root ${JSON.stringify(expected.root.path)}; ` +
      `COTAL_HOME ${JSON.stringify(cotalHome ?? "<missing>")}, expected ${JSON.stringify(expected.cotalHome.path)}; ` +
      `XDG_CONFIG_HOME ${JSON.stringify(xdgConfigHome ?? "<missing>")}, expected ${JSON.stringify(expected.xdgConfigHome.path)}; ` +
      `identity verdicts root=${rootIdentity}, COTAL_HOME=${homeIdentity}, XDG_CONFIG_HOME=${configIdentity}, ` +
      `marker=${markerHeld ? "held" : markerIdentity}`,
  );
}

/** Refuse a folder-rooted destructive call unless its actual spawn options retain the sandbox. */
export function assertSmokeSandboxDown(
  anchor: SmokeSandboxAnchor | undefined,
  args: readonly string[],
  options: SmokeCommandOptions,
): void {
  const parsed = parseSmokeDown(args);
  if (!parsed) return;
  const requested = [...new Set(parsed.positionals)];
  if (requested.includes("web"))
    throw new Error("target-addressed `down web` requires assertSmokeSandboxTargetDown");
  assertRecordedSandboxDown(anchor, args, options, parsed);
}

/**
 * Guard a target-addressed component such as `down web`. The call must name its space explicitly so
 * the CLI cannot select a different `current` entry. The guard reads that ONE canonical record from
 * the already-anchored COTAL_HOME, requires that document's space field to be the requested space
 * (the same key loadMeshes/findMesh honor), and compares its concrete root with the root recorded at
 * sandbox construction. It never runs the mesh resolver, searches the registry, or consults ambient
 * state.
 */
export function assertSmokeSandboxTargetDown(
  anchor: SmokeSandboxAnchor | undefined,
  args: readonly string[],
  options: SmokeCommandOptions,
): void {
  const parsed = parseSmokeDown(args);
  if (!parsed) return;
  assertRecordedSandboxDown(anchor, args, options, parsed);
  const requested = [...new Set(parsed.positionals)];
  if (requested.length !== 1 || requested[0] !== "web")
    throw new Error("smoke sandbox target guard requires exactly the target-addressed component `down web`");
  if (!anchor) throw new Error("smoke sandbox target guard requires a recorded anchor");
  const space = parsed.values.space;
  if (typeof space !== "string" || space === "")
    throw new Error("smoke sandbox target down must name a non-empty --space explicitly");

  const expected = anchor[smokeSandboxAnchor];
  const key = Buffer.from(space, "utf8").toString("hex");
  const recordPath = join(expected.cotalHome.path, "meshes", `space.${key}.json`);
  let observed: { root?: unknown; space?: unknown };
  try {
    observed = JSON.parse(readFileSync(recordPath, "utf8")) as { root?: unknown; space?: unknown };
  } catch (error) {
    throw new Error(`cannot establish smoke sandbox target identity from ${JSON.stringify(recordPath)}`, { cause: error });
  }
  // Filename location is not the consumer's key. loadMeshes/findMesh select by the document's
  // space field, so a canonical file whose document names another space must not satisfy the
  // requested space: the CLI would then honor a different record (including a legacy file).
  if (observed.space !== space) {
    throw new Error(
      `smoke sandbox refused target-addressed cotal down: observed space ${JSON.stringify(observed.space ?? "<missing>")}, ` +
        `expected space ${JSON.stringify(space)}`,
    );
  }
  const observedRoot = observed.root;
  if (typeof observedRoot === "string" && sameDirectory(expected.root, observedRoot) === "same") return;
  throw new Error(
    `smoke sandbox refused target-addressed cotal down: observed root ${JSON.stringify(observedRoot ?? "<missing>")}, ` +
      `expected root ${JSON.stringify(expected.root.path)}`,
  );
}
