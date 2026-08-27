import { mkdirSync, realpathSync, statSync } from "node:fs";
import { isAbsolute, join } from "node:path";

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

function sameDirectory(expected: RecordedDirectory, observedPath: string): boolean {
  try {
    const observed = directoryIdentity("observed directory", observedPath);
    return observed.physicalPath === expected.physicalPath && observed.dev === expected.dev && observed.ino === expected.ino;
  } catch {
    return false;
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

/** Refuse a destructive CLI call unless its actual spawn options retain the recorded sandbox. */
export function assertSmokeSandboxDown(
  anchor: SmokeSandboxAnchor | undefined,
  args: readonly string[],
  options: SmokeCommandOptions,
): void {
  if (args[0] !== "down") return;
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
  const rootMatches = typeof observedRoot === "string" && sameDirectory(expected.root, observedRoot);
  const markerHeld = sameDirectory(expected.marker, expected.marker.path);
  const homeMatches = cotalHome === expected.cotalHome.path && sameDirectory(expected.cotalHome, cotalHome);
  const configMatches = xdgConfigHome === expected.xdgConfigHome.path && sameDirectory(expected.xdgConfigHome, xdgConfigHome);
  if (rootMatches && markerHeld && homeMatches && configMatches) return;

  throw new Error(
    `smoke sandbox refused cotal down: observed root ${JSON.stringify(observedRoot ?? "<missing>")}, ` +
      `expected root ${JSON.stringify(expected.root.path)}; ` +
      `COTAL_HOME ${JSON.stringify(cotalHome ?? "<missing>")}, expected ${JSON.stringify(expected.cotalHome.path)}; ` +
      `XDG_CONFIG_HOME ${JSON.stringify(xdgConfigHome ?? "<missing>")}, expected ${JSON.stringify(expected.xdgConfigHome.path)}; ` +
      `root ownership marker ${markerHeld ? "held" : "missing or replaced"}`,
  );
}
