import { accessSync, constants } from "node:fs";
import { join, delimiter, resolve, extname } from "node:path";

const isWindows = process.platform === "win32";

/**
 * Fallback executable extensions when `PATHEXT` is unset — a deliberately NARROWED subset of
 * cmd.exe's documented default (which also carries `.VBS/.VBE/.JS/.JSE/.WSF/.WSH/.MSC`), ordered so
 * a real executable (`.COM`/`.EXE`) wins over a script shim (`.BAT`/`.CMD`) when both share a
 * directory. NOT "the cmd default" — only the extensions Cotal knows how to launch.
 */
const DEFAULT_PATHEXT = ".COM;.EXE;.BAT;.CMD";

/** Read an env var by canonical name, case-insensitively. `env` may be a plain object (a launch
 *  `spec.env`), not Node's case-folding Windows `process.env` proxy, and on Windows `PATH`/`PATHEXT`
 *  can arrive under any casing (`Path`, `Pathext`). Exact hit wins; else first case-insensitive match. */
function envGet(env: NodeJS.ProcessEnv, name: string): string | undefined {
  if (env[name] !== undefined) return env[name];
  const lower = name.toLowerCase();
  for (const key of Object.keys(env)) if (key.toLowerCase() === lower) return env[key];
  return undefined;
}

/**
 * Resolve `bin` to a concrete executable path, or `undefined` if not found. The single shared
 * resolver behind every "is this binary available / what exactly will we launch" decision:
 *   - a connector's `requires` preflight (manager + CLI manifest) — boolean-ised as `!!resolveOnPath(bin)`;
 *   - the PtyRuntime, which launches the EXACT path returned (resolve once; never validate one file
 *     and then launch a different one).
 *
 * `env` is explicit so a caller resolves against the SAME environment it will act on. Preflights pass
 * the operator env (default `process.env`); the PtyRuntime passes `spec.env` — its post-P3-isolation
 * launch env — so executable selection can't escape isolation: a poisoned manager PATH can't make the
 * child launch a different shim than the preflight saw.
 *
 * POSIX: the name IS the file — a bare name is looked up across PATH, an explicit path checked as
 * given, each via `accessSync(X_OK)`. Windows: there is no execute bit, so `accessSync(X_OK)` is
 * existence-only; a bare name (or a path lacking a known executable extension) is tried against each
 * `PATHEXT` extension IN ORDER — executables before scripts — so a real `claude.exe` beats a
 * `claude.cmd` shim in the same directory; a name that already carries a `PATHEXT` extension is taken
 * as-is.
 */
export function resolveOnPath(bin: string, env: NodeJS.ProcessEnv = process.env): string | undefined {
  // Probe real executables (.com/.exe) before script shims (.bat/.cmd/…) REGARDLESS of the order
  // PATHEXT lists them, so a co-located `foo.exe` always wins over a `foo.cmd` shim and a hostile or
  // reordered PATHEXT can't force shim selection. (A deliberate divergence from cmd's strict
  // PATHEXT-order lookup: a real `.exe` launches directly; a shim needs a cmd.exe wrapper. An
  // explicit `foo.cmd` is still honored — a name that already carries an extension skips this.)
  const isExecutableExt = (e: string): boolean => e.toLowerCase() === ".com" || e.toLowerCase() === ".exe";
  const exts = isWindows
    ? (() => {
        const all = (envGet(env, "PATHEXT") ?? DEFAULT_PATHEXT)
          .split(";")
          .map((e) => e.trim())
          .filter(Boolean);
        return [...all.filter(isExecutableExt), ...all.filter((e) => !isExecutableExt(e))];
      })()
    : [];

  // The candidate filenames to probe for one base path. POSIX: just the base. Windows: the base
  // as-is when it already carries a known executable extension, else the base + each PATHEXT ext.
  const candidates = (base: string): string[] => {
    if (!isWindows) return [base];
    const ext = extname(base).toLowerCase();
    if (ext && exts.some((e) => e.toLowerCase() === ext)) return [base];
    return exts.map((e) => base + e);
  };

  const probe = (base: string): string | undefined => {
    for (const cand of candidates(base)) {
      try {
        accessSync(cand, constants.X_OK);
        return cand;
      } catch {
        // not this candidate — keep trying
      }
    }
    return undefined;
  };

  // An explicit path (absolute or with a separator) is checked as given, never PATH-scanned.
  if (bin.includes("/") || bin.includes("\\")) return probe(resolve(bin));

  for (const dir of (envGet(env, "PATH") ?? "").split(delimiter)) {
    if (!dir) continue;
    const hit = probe(join(dir, bin));
    if (hit) return hit;
  }
  return undefined;
}
