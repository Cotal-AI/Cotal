import { spawnSync } from "node:child_process";
import { accessSync, constants, readFileSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, join } from "node:path";
import { cmdSpawnSpec, resolveOnPath } from "@cotal-ai/workspace";
import { cliPackageRoot } from "../seed/paths.js";

/** This CLI's own invocation as argv: `[node, ...loaderFlags, entryScript]`. The loader flags carry
 *  tsx in dev (so a re-exec can run the `.ts` entry) and are empty in prod (entry = compiled JS).
 *  Re-execed children (web, manager) and cmux pane commands use this so they never depend on
 *  `cotal` being on PATH — works the same via `npx`, `npm i -g`, and a dev clone. */
export function selfArgv(): string[] {
  return [process.execPath, ...process.execArgv, assertSelfEntry()];
}

/**
 * {@link selfArgv}'s entry script, PROVEN to be this CLI's own.
 *
 * `process.argv[1]` is whatever started this process, and a re-exec appends a subcommand to it. When
 * the starter is NOT the CLI — a smoke suite, a test runner, an embedder's script — the detached
 * child is that same script again with `supervise` (or `deliver`) appended to an argv it never
 * reads, so it runs its own body instead of the daemon. A suite that reaches `ensureManager` in a
 * fixture therefore RE-EXECS ITSELF, and every generation reaches the same call: #1629 measured 970
 * generations in 4.7 hours on a persistent host, each with its own broker and holder.
 *
 * Proven the way `seedWriterKind` proves the same thing: the nearest `package.json` above the
 * resolved entry must be `cotal-ai`. That holds for a published install, an `npx` unpack and
 * `tsx bin/cotal.ts` in a dev clone, and fails for every path that is not this CLI.
 *
 * REFUSING IS THE ONLY SAFE ANSWER, and it belongs HERE, at the one place every re-exec's argv is
 * built: the children are detached and `unref`ed, so no caller owns one, and a suite's own signal
 * teardown cannot reap what it never parented. A guard at any single spawn site would leave the
 * siblings (`deliver`, the bearer preflight, the seed child) re-execing the same wrong entry.
 */
function assertSelfEntry(): string {
  const entry = process.argv[1];
  let owner: unknown;
  try {
    owner = (JSON.parse(readFileSync(join(cliPackageRoot(), "package.json"), "utf8")) as { name?: unknown }).name;
  } catch {
    owner = undefined; // no entry, an unresolvable one, or no readable package.json above it
  }
  if (owner === "cotal-ai") return entry as string;
  throw new Error(
    `refusing to re-exec ${entry ?? "(no entry script)"}: it is not this CLI's entry (no \`cotal-ai\` package.json above it).\n` +
      `A re-exec appends a subcommand (\`supervise\`, \`deliver\`) to that path, so the detached child would be that script again, running its own body instead of the daemon - and if the script is what reached this line, each generation spawns the next.\n` +
      `NEXT: run this through the \`cotal\` binary (or \`tsx bin/cotal.ts\` in a checkout). A test or embedder that must reach this path sets \`process.argv[1]\` to the real CLI entry first.`,
  );
}

/** True when launched via `npx` — the package is unpacked under `~/.npm/_npx/<hash>/…`. */
export function isNpx(): boolean {
  return /[/\\]_npx[/\\]/.test(process.argv[1] ?? "");
}

/** Is a *durable* `cotal` executable resolvable on PATH? A pure PATH scan (no exec): `cotal
 *  --version` isn't a real command, so probing it via `onPath` would always report cotal missing.
 *  Skips npx's transient shim: `npm exec` (npx) prepends the package's own
 *  `<cache>/_npx/<hash>/node_modules/.bin` to PATH, and since `cotal-ai` declares a `cotal` bin,
 *  that dir holds a throwaway `cotal`. Counting it would make a bare `npx cotal-ai setup` conclude
 *  `cotal` is already installed — skipping the global-install offer and printing `cotal …` hints
 *  the user can't run once npx exits. That shim is exactly what we're offering to make permanent. */
export function cotalOnPath(): boolean {
  const exts = process.platform === "win32" ? ["", ".cmd", ".exe", ".bat"] : [""];
  for (const dir of (process.env.PATH ?? "").split(delimiter)) {
    if (!dir || isEphemeralNpxBin(dir)) continue;
    for (const ext of exts) {
      try {
        accessSync(join(dir, `cotal${ext}`), constants.X_OK);
        return true;
      } catch {
        /* not here */
      }
    }
  }
  return false;
}

export interface CotalExecutable {
  readonly path: string;
  readonly version: string;
}

/**
 * Concrete durable `cotal` executables this host can prove exist and identify. This is deliberately
 * NOT part of ordinary startup: it executes each candidate's side-effect-free `--version` surface,
 * with a short timeout, only when a recovery path needs an executable rather than another bare
 * `cotal` command that may resolve straight back to the failing binary.
 *
 * PATH entries are checked in order after transient npx bins are skipped, then the POSIX installer's
 * default `~/.local/bin/cotal` is checked even when a service supplied a reduced PATH. Candidates
 * are deduped by real path. A file counts only when it exits cleanly and its first line is exactly
 * `cotal-ai <numeric semver>`.
 */
export function verifiedCotalExecutables(env: NodeJS.ProcessEnv = process.env): CotalExecutable[] {
  const candidates: string[] = [];
  const pathDirs = (env.PATH ?? "").split(delimiter).filter(Boolean);
  for (const dir of pathDirs) {
    if (isEphemeralNpxBin(dir)) continue;
    const hit = resolveOnPath(join(dir, "cotal"), env);
    if (hit) candidates.push(hit);
  }
  if (process.platform !== "win32") candidates.push(join(env.HOME || homedir(), ".local", "bin", "cotal"));

  const seen = new Set<string>();
  const verified: CotalExecutable[] = [];
  for (const path of candidates) {
    let identity: string;
    try {
      accessSync(path, constants.X_OK);
      identity = realpathSync(path);
    } catch {
      continue;
    }
    if (seen.has(identity)) continue;
    seen.add(identity);

    try {
      const spec = cmdSpawnSpec(path, ["--version"], env);
      const result = spawnSync(spec.file, spec.args, {
        encoding: "utf8",
        env,
        timeout: 2000,
        windowsVerbatimArguments: spec.windowsVerbatimArguments,
      });
      if (result.status !== 0 || result.error) continue;
      const firstLine = `${result.stdout ?? ""}`.split(/\r?\n/, 1)[0];
      const match = /^cotal-ai ([0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?)$/.exec(firstLine);
      if (match) verified.push({ path, version: match[1] });
    } catch {
      // A recovery hint is optional. An unlaunchable candidate is not evidence and is omitted.
    }
  }
  return verified;
}

/** A PATH entry npx (`npm exec`) injected for the current run only — its `_npx` cache
 *  `node_modules/.bin`. A `cotal` shim there disappears when npx exits, so it must not count as
 *  `cotal` being installed. Matches the `_npx` cache segment on POSIX and Windows. */
function isEphemeralNpxBin(dir: string): boolean {
  return /[/\\]_npx[/\\]/.test(dir);
}

/** The copy-paste command prefix for user-facing hints: `cotal` when it's on PATH, `npx cotal-ai`
 *  for an npx run, `pnpm cotal` in a dev clone. (Display only — re-execs use {@link selfArgv}.) */
export function displayCmd(): string {
  if (cotalOnPath()) return "cotal";
  if (isNpx()) return "npx cotal-ai";
  return "pnpm cotal";
}

/** The self-invocation as a shell-ready, double-quoted command prefix (for cmux pane commands).
 *  Tokens are absolute paths with no single quotes, so the surrounding `bash -lc '…'` single-quote
 *  wrapping stays intact through a login shell (e.g. nushell) before bash. */
export function selfCotal(): string {
  return selfArgv()
    .map((a) => `"${a}"`)
    .join(" ");
}
