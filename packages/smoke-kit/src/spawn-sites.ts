/**
 * Enumerate every site in this repo that starts a `nats-server`, and decide for each whether it is
 * ADOPTED: minted through {@link SMOKE_BROKER_TOKEN} and handed to {@link teardownOnSignal}.
 *
 * WHY THIS IS AN ENUMERATION AND NOT A LIST OF FILENAMES. #1008 was filed against five named suites,
 * and those five were migrated. That fixed the five and protected nothing: the reaper's own header
 * says it "is only ever as complete as the migration that mints the token", so the standing defect is
 * that nothing notices the SIXTH suite. A gate naming files re-acquires the same blind spot the
 * moment somebody adds one. This walks `git ls-files` instead, so a new spawn site is in the
 * population the commit it lands in, with no list to remember to update.
 *
 * WHAT ADOPTION MEANS, and why both halves are required rather than either one:
 *
 *   TOKEN. The reaper matches on argv and nothing else, for the measured reasons in its header. So
 *   the token has to be in a path the broker is STARTED with, not merely somewhere in the suite. A
 *   `-sd` store dir and a `-c` config path are both argv paths and both count; a broker started with
 *   neither carries no evidence at all and can never be claimed, which is why `no-store` is a failure
 *   rather than a category to skip.
 *
 *   OWNERSHIP. The token only helps after the owner is dead. `teardownOnSignal` is what kills the
 *   broker when the suite is signalled, which is the common case. Ownership is checked against the
 *   binding the spawn result is assigned to, not against the file, because a file that owns ONE of
 *   its two brokers would otherwise read as clean.
 *
 * WHAT IS DELIBERATELY OUT OF SCOPE, each with a reason rather than a convenience:
 *
 *   SHIPPED CODE. `@cotal-ai/smoke-kit` is test-only and `pnpm smoke:core-boundary` forbids shipped
 *   files from importing it. A shipped file that starts a broker cannot adopt the helper without
 *   breaking that boundary, so it is reported separately instead of being counted as a violation the
 *   repo is not allowed to fix.
 *
 *   NEGATIVE CONTROLS. A reaper test must be able to spawn a deliberately untokened broker, since
 *   that is the condition it exists to detect. Those sites opt out with an explicit
 *   `SMOKE_BROKER_UNADOPTED_OK` marker comment, which makes the exemption greppable and per-site
 *   rather than a silent exclusion.
 *
 * A VERSION MATCHING ARGV RATHER THAN SOURCE WAS TRIED AND REJECTED. Reading `ps` tells you what is
 * running now, which depends on which suites happened to run; this has to be true of the repo, not of
 * the box, so it reads source.
 */
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

/** One place in the source that starts a `nats-server`. */
export interface SpawnSite {
  readonly file: string;
  readonly line: number;
  /** `store` = `-sd <dir>`, `config` = `-c <file>`, `none` = neither, so argv carries no evidence. */
  readonly argvPath: "store" | "config" | "none";
  /** The source text of the argv path, for a diagnosis that names what to change. */
  readonly pathExpr?: string;
  readonly tokened: boolean;
  readonly owned: boolean;
  /** Shipped (non-test) code, which may not import the test-only kit. */
  readonly shipped: boolean;
  /** Carries the explicit opt-out marker. */
  readonly exempt: boolean;
}

/** Sites a migration is responsible for: test code, not exempted. */
export const isAdopted = (s: SpawnSite): boolean => s.tokened && s.owned;
export const inScope = (s: SpawnSite): boolean => !s.shipped && !s.exempt;

/** The marker a negative control uses to opt out, on or above the spawn line. */
export const EXEMPT_MARKER = "SMOKE_BROKER_UNADOPTED_OK";

const TOKEN_RE = /SMOKE_BROKER_TOKEN|SMOKE_BROKER_PREFIX/;
const TEST_RE = /(^|\/)(smoke|test|tests|fixtures)\//;
const TEST_FILE_RE = /\.(smoke|acceptance|test|spec)\.[cm]?[jt]s$/;

/** Split an argument list at top-level commas, respecting nesting and every quote form. */
function splitArgs(s: string): string[] {
  const out: string[] = [];
  let depth = 0, cur = "", quote: string | null = null;
  for (let i = 0; i < s.length; i++) {
    const c = s[i]!;
    if (quote !== null) {
      if (c === "\\") { cur += c + (s[++i] ?? ""); continue; }
      if (c === quote) quote = null;
      cur += c;
      continue;
    }
    if (c === '"' || c === "'" || c === "`") { quote = c; cur += c; continue; }
    if (c === "(" || c === "[" || c === "{") depth++;
    if (c === ")" || c === "]" || c === "}") depth--;
    if (c === "," && depth === 0) { out.push(cur.trim()); cur = ""; continue; }
    cur += c;
  }
  if (cur.trim() !== "") out.push(cur.trim());
  return out;
}

/** The balanced text inside a call whose `(` is at `open`. */
function callBody(src: string, open: number): string | null {
  let depth = 0, quote: string | null = null;
  for (let i = open; i < src.length; i++) {
    const c = src[i]!;
    if (quote !== null) {
      if (c === "\\") { i++; continue; }
      if (c === quote) quote = null;
      continue;
    }
    if (c === '"' || c === "'" || c === "`") { quote = c; continue; }
    if (c === "(") depth++;
    else if (c === ")") { depth--; if (depth === 0) return src.slice(open + 1, i); }
  }
  return null;
}

/** Every `const|let|var NAME = ...` initializer in a file, by name, INCLUDING the second and later
 *  declarators of a comma-separated list. That last part is not a detail: `const port = ..., conf =
 *  join(dir, "x.conf")` is a real shape in this repo, and a resolver that only saw the first
 *  declarator read a correctly tokened suite as untokened. One pass, so the resolver below is a map
 *  lookup rather than a fresh scan of the file per identifier it meets. */
function bindings(src: string): Map<string, string[]> {
  const out = new Map<string, string[]>();
  const add = (name: string, value: string): void => {
    const list = out.get(name) ?? [];
    list.push(value);
    out.set(name, list);
  };
  // Plain REASSIGNMENT counts too (`let scratch: string | undefined;` then `scratch = mkdtemp(...)`
  // later, once a port is known). A declaration-only scan reads the tokened value as absent and
  // reports the suite as untokened, which it is not.
  const re = /(?:(?:const|let|var)\s+|^[ \t]*)([A-Za-z_$][\w$]*)\s*(?::[^=\n]+)?=\s*/gm;
  let m: RegExpExecArray | null;
  while ((m = re.exec(src)) !== null) {
    const rest = src.slice(m.index + m[0].length, m.index + m[0].length + 900);
    const stmt = rest.split(/;|\n/)[0] ?? "";
    // An arrow or block initializer spans lines, so keep a window; a plain one ends at the line.
    const isMultiline = /^\(?\s*[\w\s,{}[\]]*\)?\s*(?:=>|\{)/.test(stmt);
    if (isMultiline) { add(m[1]!, rest); continue; }
    for (const part of splitArgs(stmt)) {
      const decl = /^([A-Za-z_$][\w$]*)\s*(?::[^=]+)?=\s*([\s\S]+)$/.exec(part);
      if (decl) add(decl[1]!, decl[2]!);
      else add(m[1]!, part);
    }
  }
  return out;
}

const IGNORED_IDS = new Set(["join", "resolve", "tmpdir", "mkdtempSync", "mkdirSync", "writeFileSync", "String", "process", "env"]);

/** Callees that actually START a process. Anything else that merely NAMES the binary (`need(...)`,
 *  `locate(...)`, `commandExists(...)`, `resolveOnPath(...)`) is a PATH lookup or an availability
 *  check: it returns a string, never a child, so there is no broker to token and no handle to own.
 *  Counting those as spawn sites is not a harmless over-report. It produced edits that were type
 *  errors on their face (`teardownOnSignal(locate("nats-server"))` hands a string to a helper that
 *  wants a ChildProcess), which is what surfaced this. Matched on the callee's last segment so
 *  `child_process.spawn` and an aliased `spawn as spawnProc` are both covered. */
const SPAWNERS = /(^|\.)(spawn|spawnSync|fork|exec|execSync|execFile|execFileSync)$/i;
const isSpawner = (callee: string): boolean => SPAWNERS.test(callee) || /^spawn/i.test(callee);

/** Does this expression reach the token, directly or through the bindings it names? */
function reachesToken(expr: string, defs: Map<string, string[]>, params: Map<string, string[]>, seen = new Set<string>()): boolean {
  if (TOKEN_RE.test(expr)) return true;
  if (seen.size > 16) return false;
  for (const id of new Set(expr.match(/[A-Za-z_$][\w$]*/g) ?? [])) {
    if (IGNORED_IDS.has(id) || seen.has(id)) continue;
    seen.add(id);
    for (const v of defs.get(id) ?? []) if (reachesToken(v, defs, params, seen)) return true;
    // A function PARAMETER is tokened only when EVERY call site passes something tokened. "Any call
    // site" would be unsound in a way this repo actually exercises: `reaper.smoke.ts` starts one
    // tokened broker and one deliberately untokened one through the SAME helper, and an any-rule
    // would let the tokened caller vouch for the untokened one and hide a real violation.
    const args = params.get(id);
    if (args !== undefined && args.length > 0 && args.every((a) => reachesToken(a, defs, params, new Set(seen)))) return true;
  }
  return false;
}

/** For every function parameter, the argument expressions its call sites pass for that position.
 *  Keyed by parameter NAME, which is enough here: these are single-file smoke suites, and a
 *  same-named binding elsewhere would have to also be untokened to change the verdict. */
function paramArguments(src: string): Map<string, string[]> {
  const out = new Map<string, string[]>();
  const fns = /(?:function\s+([A-Za-z_$][\w$]*)|(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*(?::[^=\n]+)?=\s*(?:async\s*)?)\s*\(([^)]*)\)/g;
  let f: RegExpExecArray | null;
  while ((f = fns.exec(src)) !== null) {
    const name = f[1] ?? f[2];
    if (name === undefined) continue;
    const names = splitArgs(f[3] ?? "").map((p) => /^([A-Za-z_$][\w$]*)/.exec(p.trim())?.[1]).filter((p): p is string => p !== undefined);
    if (names.length === 0) continue;
    for (const call of src.matchAll(new RegExp(`(?:^|[^\\w$.])${name}\\s*\\(`, "g"))) {
      const open = call.index + call[0].length - 1;
      // Skip the DECLARATION, which this scan also matches: its "arguments" are the parameter list
      // itself (`conf: string`), which is never tokened, so counting it made every parameter fail
      // the all-call-sites rule and reported correctly migrated suites as untokened.
      if (new RegExp(`(?:function\\s+|(?:const|let|var)\\s+)${name}\\s*$`).test(src.slice(0, open))) continue;
      const body = callBody(src, open);
      if (body === null) continue;
      const args = splitArgs(body);
      names.forEach((p, i) => {
        const a = args[i];
        if (a === undefined) return;
        out.set(p, [...(out.get(p) ?? []), a]);
      });
    }
  }
  return out;
}

/** Every site, in `git ls-files` order. */
export function enumerateSpawnSites(cwd: string): SpawnSite[] {
  const files = execFileSync("git", ["ls-files", "*.ts", "*.mts", "*.cts", "*.mjs", "*.cjs", "*.js"], { cwd, encoding: "utf8", maxBuffer: 32 * 1024 * 1024 })
    .split("\n")
    .filter((f) => f !== "");
  const sites: SpawnSite[] = [];
  for (const file of files) {
    let src: string;
    try { src = readFileSync(`${cwd}/${file}`, "utf8"); } catch { continue; }
    if (!src.includes("nats-server")) continue;
    const defs = bindings(src);
    const params = paramArguments(src);
    const lineStarts = src.split("\n");
    const re = /([A-Za-z_$][\w$.]*)\s*\(\s*(["'`])nats-server\2/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(src)) !== null) {
      // A PATH lookup or availability check is not a spawn; see SPAWNERS.
      if (!isSpawner(m[1]!)) continue;
      const open = src.indexOf("(", m.index + m[1]!.length);
      const body = open === -1 ? null : callBody(src, open);
      if (body === null) continue;
      const args = splitArgs(body);
      const argvText = args[1] ?? "";
      // `nats-server --version` is a capability probe, not a broker: it exits immediately and can
      // never be orphaned, so counting it would inflate the population with sites nothing can leak.
      if (/--version/.test(argvText)) continue;
      const line = src.slice(0, m.index).split("\n").length;
      const items = splitArgs(argvText.replace(/^\[/, "").replace(/\]$/, ""));
      const sdIdx = items.findIndex((x) => /^["'`]-sd["'`]$/.test(x));
      const cIdx = items.findIndex((x) => /^["'`]-c["'`]$/.test(x));
      const idx = sdIdx >= 0 ? sdIdx : cIdx;
      const argvPath = sdIdx >= 0 ? "store" : cIdx >= 0 ? "config" : "none";
      const pathExpr = idx >= 0 ? items[idx + 1] : undefined;
      // An argv that is a prebuilt variable hides its flags; resolve it before calling it evidence-free.
      const indirect = argvPath === "none" && /^[A-Za-z_$][\w$]*$/.test(argvText.trim());
      const effectiveExpr = pathExpr ?? (indirect ? argvText.trim() : undefined);
      const tokened = effectiveExpr !== undefined && reachesToken(effectiveExpr, defs, params);
      // OWNERSHIP IS PER-SITE, NOT PER-FILE. A file that owns one of its two brokers would read as
      // clean under a file-level test, which is the same "named list" mistake one level down.
      //
      // Three shapes cover every site in this repo and they are graded differently:
      //   `const broker = spawn("nats-server", ...)` binds a name, so require THAT name reach
      //   `teardownOnSignal`. A sibling broker owned under a different name does not count.
      //   `const startBroker = () => spawn("nats-server", ...)` binds a FACTORY, and the handle its
      //   callers hold is what gets owned. Grading the factory's own name would report a suite that
      //   owns every broker it starts as unowned, so follow the call: a site is owned when some
      //   binding initialized from `startBroker(...)` reaches the helper. This is not hypothetical
      //   tidiness, it is a false positive this enumerator actually produced.
      //   `broker = trackChild(spawn("nats-server", ...))` passes the handle THROUGH a wrapper into
      //   a binding. The wrapper returns the child (that is what makes it a tracker), so the
      //   binding on the left is the handle, and grading it as unbound would report a suite that
      //   owns its broker correctly as unowned. Look past any wrapper calls to the assignment.
      //   `kids.push(spawn("nats-server", ...))` binds nothing, so there is no name to trace. The
      //   spawn is UNOWNED unless that expression is itself wrapped in the helper.
      const before = src.slice(0, m.index);
      const tail = before.slice(-200);
      // Strip trailing wrapper openings (`= track("broker", ` / `= trackChild(`) so the assignment
      // underneath becomes visible, without letting the strip cross a statement boundary.
      const unwrapped = tail.replace(/(?:[A-Za-z_$][\w$.]*\s*\(\s*(?:(["'`])[^"'`]*\1\s*,\s*)?)+$/, "");
      const bind = /(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*(?::[^=\n]+)?=\s*(?:await\s+)?$|(?:^|[\s;{(])([A-Za-z_$][\w$]*)\s*=\s*(?:await\s+)?$/.exec(unwrapped);
      const name = bind?.[1] ?? bind?.[2];
      const ownsName = (n: string): boolean => new RegExp(`teardownOnSignal\\s*\\(\\s*${n}\\b`).test(src);
      let owned: boolean;
      if (name !== undefined) {
        owned = ownsName(name);
      } else {
        // A factory: `const NAME = (...) => spawn(...)` or `function NAME(...) { ... spawn(...) }`.
        const factory = /(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*(?::[^=\n]+)?=\s*(?:async\s*)?\([^)]*\)\s*(?::[^=>\n]+)?=>\s*(?:\{[\s\S]*)?$/.exec(tail)
          ?? /function\s+([A-Za-z_$][\w$]*)\s*\([\s\S]*$/.exec(tail);
        const fname = factory?.[1];
        owned = fname !== undefined
          && [...src.matchAll(new RegExp(`(?:const|let|var)\\s+([A-Za-z_$][\\w$]*)\\s*(?::[^=\\n]+)?=\\s*(?:await\\s+)?${fname}\\s*\\(`, "g"))]
            .some((c) => ownsName(c[1]!));
        if (!owned && /teardownOnSignal\s*\(\s*$/.test(tail)) owned = true;
      }
      // The exemption may need a paragraph of justification above the spawn, so the window is
      // generous. It is still bounded: a marker further away than this belongs to another site.
      const window = lineStarts.slice(Math.max(0, line - 12), line + 1).join("\n");
      sites.push({
        file,
        line,
        argvPath,
        ...(effectiveExpr === undefined ? {} : { pathExpr: effectiveExpr }),
        tokened,
        owned,
        shipped: !(TEST_RE.test(file) || TEST_FILE_RE.test(file)),
        exempt: window.includes(EXEMPT_MARKER),
      });
    }
  }
  return sites;
}
