import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, renameSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import {
  agentFilePath,
  assertValidName,
  loadAgentFile,
  saveAgentFile,
  type AgentDef,
  type CompletionResult,
  type ParsedArgs,
} from "@cotal-ai/core";
import { isWorkspaceTargetError, loadMeshes, renderWorkspaceError, resolveMeshTarget, targetFlags } from "@cotal-ai/workspace";
import { completedFlagValue, completingFlagValue, positionalsForCompletion } from "../lib/completion.js";
import { listPersonas, listPersonaNames, personasDir } from "../lib/personas.js";
import { openTransient, type ConnectValues } from "../lib/transient.js";
import { c } from "../ui.js";

/**
 * `cotal personas` — list and manage the local persona catalog (`.cotal/agents/*.md`),
 * modelled on `cotal channels`. Workspace-local file editing, NOT a mesh operation: it reads
 * and writes the files directly (instant, works offline). The privileged, ownership-checked
 * path stays in the manager's `definePersona` for *agents* defining personas over the wire.
 *
 *   cotal personas [list] [--verbose] [--running]
 *   cotal personas show <name>
 *   cotal personas edit <name>
 *   cotal personas new <name> (--prompt <text> | --from <file|->) [--role <r>] [--model <m>] [--force]
 *   cotal personas rm <name> --force
 *
 * WHICH CATALOG IT ACTS ON. Every subcommand resolves the MESH's root through
 * {@link resolveMeshTarget} — the same resolution `cotal spawn` uses — and never the cwd.
 * "Local" above means "files on this machine, not a wire call"; it does not mean "whatever
 * directory you are standing in". Those two readings came apart badly: until this was fixed the
 * listing took `listPersonas()`'s silent cwd default while `spawn` passed the resolved mesh root,
 * so from one cwd `personas` listed a set `spawn` could not launch a single member of.
 *
 * That also makes `--space`/`--server` real HERE, not just for the `--running` overlay: naming a
 * mesh now moves the catalog the command reads and writes, so two spaces give two answers from
 * one cwd. Mesh resolution is offline and pure (registry + `current` + the cwd project, no
 * broker), so the offline subcommands stay offline.
 */

/** Persona names are also filenames and spawn names — mirror the `cotal_persona` tool's pattern. */
const NAME_RE = /^[A-Za-z0-9_-]+$/;

export async function personas(args: ParsedArgs): Promise<void> {
  const positionals = args.positionals;
  const values = args.values as { role?: string; model?: string; prompt?: string; from?: string; subscribe?: string; verbose?: boolean; force?: boolean; running?: boolean; space?: string; server?: string; creds?: string };

  switch (positionals[0] ?? "list") {
    case "list":
      return list(values.verbose === true, values.running === true, values);
    case "show":
      return show(positionals[1], values);
    case "edit":
      return edit(positionals[1], values);
    case "new":
      return create(positionals[1], values);
    case "rm":
      return remove(positionals[1], values.force === true, values);
    default:
      return usage();
  }
}

/**
 * The root whose `.cotal/agents` this command acts on: the RESOLVED MESH's, honouring
 * `--space`/`--server`, exactly as `cotal spawn` resolves it.
 *
 * Resolution is offline and pure (registry + `current` + the cwd project) so `show`/`edit`/`new`/
 * `rm` and the plain listing still work with no broker. It is deliberately NOT wrapped in a cwd
 * fallback: when the target cannot be resolved the command says so and exits, because the only
 * alternative is to silently act on some other directory's catalog — the exact defect this
 * command is being fixed for. `--creds` is auth material, not a location, so it plays no part
 * here; it stays what it always was, an input to the live `--running` overlay.
 */
function targetRoot(values: { space?: string; server?: string }): string {
  try {
    return resolveMeshTarget(process.cwd(), { space: values.space, server: values.server }).root;
  } catch (e) {
    if (isWorkspaceTargetError(e)) {
      console.error(c.red(renderWorkspaceError({ kind: "target", error: e })));
      process.exit(1);
    }
    throw e;
  }
}

/** Argument completion: subcommands, then persona names for `show`/`rm`. */
export function personasComplete(argv: string[]): CompletionResult {
  const flags = [
    ...targetFlags,
    { name: "role", type: "string" },
    { name: "model", type: "string" },
    { name: "prompt", type: "string" },
    { name: "from", type: "string" },
    { name: "subscribe", type: "string" },
    { name: "verbose", type: "boolean", short: "v" },
    { name: "running", type: "boolean" },
    { name: "force", type: "boolean" },
  ] as const;
  const flag = completingFlagValue(argv, flags);
  if (flag?.name === "space") return { items: loadMeshes().map((m) => ({ value: m.space })), directive: "nofiles" };
  if (flag?.name === "from" || flag?.name === "creds") return { items: [], directive: "default" };

  const positionals = positionalsForCompletion(argv, flags);
  const subs: CompletionResult = {
    items: [
      { value: "list", description: "list the persona catalog" },
      { value: "show", description: "print a persona's card" },
      { value: "edit", description: "open a persona in $EDITOR" },
      { value: "new", description: "create a persona" },
      { value: "rm", description: "delete a persona" },
    ],
    directive: "nofiles",
  };
  if (positionals.length <= 1) return subs; // completing the subcommand
  if (positionals[0] === "show" || positionals[0] === "edit" || positionals[0] === "rm") {
    // Complete from the TARGET mesh's catalog, matching what the subcommand will actually open —
    // a <TAB> that offers a name the command then reports as missing is worse than no completion.
    // Resolved offline (no probe), and FAIL CLOSED: with no single target, offer nothing rather
    // than throw into the operator's shell (the same posture as `spawnComplete`).
    try {
      const root = resolveMeshTarget(process.cwd(), {
        space: completedFlagValue(argv, flags, "space"),
        server: completedFlagValue(argv, flags, "server"),
      }).root;
      return { items: listPersonaNames(root).map((value) => ({ value })), directive: "nofiles" };
    } catch {
      return { items: [], directive: "nofiles" };
    }
  }
  return { items: [], directive: "nofiles" };
}

async function list(verbose: boolean, running: boolean, values: ConnectValues): Promise<void> {
  const root = targetRoot(values);
  const entries = listPersonas(root);
  if (!entries.length) {
    console.log(
      c.dim(`no personas in ${personasDir(root)}\n`) +
        c.dim('create one:  cotal personas new <name> --prompt "<who they are>"'),
    );
    return;
  }
  // `--running` is an explicit live overlay: connect, snapshot who's present, and mark each persona.
  // Fails loud if the mesh is unreachable (presentNames exits) — never a silent best-effort.
  const present = running ? await presentNames(values) : undefined;
  const pad = Math.max(...entries.map((e) => e.name.length));
  for (const e of entries) {
    if (e.error) {
      console.log(`${c.red(e.name.padEnd(pad))}  ${c.red("⨯ unparseable")} ${c.dim(e.error)}`);
      continue;
    }
    const d = e.def!;
    const live = present ? (present.has(e.name) ? c.green("● running") : c.dim("○")) : undefined;
    const meta = [d.role && c.cyan(d.role), d.model && c.dim(`model=${d.model}`), d.owner && c.dim(`owner=${d.owner}`), live]
      .filter(Boolean)
      .join("  ");
    console.log(`${c.bold(e.name.padEnd(pad))}  ${meta}`.trimEnd());
    const desc = d.description ?? firstLine(d.persona);
    if (desc) console.log(c.dim(`  ${truncate(desc, 100)}`));
    if (verbose && d.persona) console.log(d.persona.replace(/^/gm, "    ") + "\n");
  }
}

/** Snapshot the names currently present on the mesh — the live overlay behind `personas list
 *  --running`. Presence is a KV watch that replays asynchronously after connect (no synced signal),
 *  so let the roster settle (snapshot once its size holds steady) under a hard deadline so it never
 *  hangs. A name is "running" when an agent of exactly that name is present and not offline. */
async function presentNames(values: ConnectValues): Promise<Set<string>> {
  const { ep } = await openTransient(values, "personas");
  try {
    let last = -1;
    let stable = 0;
    for (let i = 0; i < 20 && stable < 3; i++) {
      const n = ep.getRoster().length;
      stable = n === last ? stable + 1 : 0;
      last = n;
      await new Promise((r) => setTimeout(r, 75));
    }
    return new Set(ep.getRoster().filter((p) => p.status !== "offline").map((p) => p.card.name));
  } finally {
    await ep.stop();
  }
}

function show(name: string | undefined, values: { space?: string; server?: string }): void {
  if (!name) return usage();
  const path = agentFilePath(targetRoot(values), name);
  if (!existsSync(path)) return notFound(name, path);
  // Print the file verbatim — the canonical card (frontmatter + persona body).
  console.log(c.dim(path));
  process.stdout.write(readFileSync(path, "utf8"));
}

/** `cotal personas edit <name>` — open the card in $EDITOR (or $VISUAL), then re-validate on exit
 *  so a save that breaks the frontmatter fails loud instead of silently shipping a bad card. */
function edit(name: string | undefined, values: { space?: string; server?: string }): void {
  if (!name) return usage();
  const path = agentFilePath(targetRoot(values), name);
  if (!existsSync(path)) return notFound(name, path);
  const editor = process.env.VISUAL || process.env.EDITOR;
  if (!editor) {
    console.error(c.red("no editor set - export EDITOR (or VISUAL), e.g. export EDITOR=vim"));
    process.exit(1);
  }
  // Hand the terminal to the editor (inherit stdio so it draws). $EDITOR may carry flags
  // (e.g. "code --wait"), so go through the shell.
  const res = spawnSync(`${editor} "${path}"`, { stdio: "inherit", shell: true });
  if (res.error) {
    console.error(c.red(`couldn't launch editor "${editor}": ${res.error.message}`));
    process.exit(1);
  }
  if (res.status !== 0) {
    console.error(c.red(`editor exited ${res.signal ? `on ${res.signal}` : `with status ${res.status}`} - not saved`));
    process.exit(1);
  }
  // Re-validate: a save that breaks the frontmatter must fail loud, not ship a broken card.
  try {
    loadAgentFile(path);
  } catch (e) {
    console.error(c.red(`⨯ "${name}" is now unparseable - fix it:`));
    console.error(c.dim(`  ${(e as Error).message}`));
    process.exit(1);
  }
  console.log(c.green(`✓ saved "${name}"`));
}

function create(name: string | undefined, v: { role?: string; model?: string; prompt?: string; from?: string; subscribe?: string; force?: boolean; space?: string; server?: string }): void {
  if (!name) return usage();
  if (!NAME_RE.test(name)) {
    console.error(c.red(`invalid persona name "${name}": use letters, digits, "_" or "-"`));
    process.exit(1);
  }
  assertValidName(name); // shared reserved-character guard (also rejects "/")

  const path = agentFilePath(targetRoot(v), name);
  if (existsSync(path) && !v.force) {
    console.error(c.red(`persona "${name}" already exists - pass --force to overwrite`));
    console.error(c.dim(path));
    process.exit(1);
  }

  // Body from --prompt <text>, or --from <file|-> (- = stdin). No fallback — one must be given.
  let persona: string;
  if (v.prompt !== undefined) persona = v.prompt;
  else if (v.from !== undefined) persona = readFileSync(v.from === "-" ? 0 : v.from, "utf8");
  else {
    console.error(c.red('provide the persona body: --prompt "<text>"  or  --from <file|->'));
    process.exit(1);
  }
  persona = persona.trim();
  if (!persona) {
    console.error(c.red("persona body is empty"));
    process.exit(1);
  }

  // The channels it reads are stated, never guessed: `--subscribe a,b` or `--subscribe ""` for an
  // agent that reads none. There is no default, because the two possible ones are both wrong - a
  // channel the author did not ask for, or an empty set indistinguishable from forgetting to say.
  if (v.subscribe === undefined) {
    console.error(c.red("--subscribe is required: name the channels this persona reads"));
    console.error(c.dim('e.g. --subscribe general   or   --subscribe "" for an agent reachable only by direct message'));
    process.exit(1);
  }
  const subscribe = v.subscribe.split(",").map((s) => s.trim()).filter(Boolean);

  const def: AgentDef = { name, role: v.role, model: v.model, persona, subscribe };
  saveAtomic(path, def);
  console.log(c.green(`✓ wrote persona "${name}"`));
  console.log(c.dim(`${path}\nspawn it:  cotal spawn ${name}${v.role ? ` --role ${v.role}` : ""}`));
}

function remove(name: string | undefined, force: boolean, values: { space?: string; server?: string }): void {
  if (!name) return usage();
  const path = agentFilePath(targetRoot(values), name);
  if (!existsSync(path)) return notFound(name, path);
  if (!force) {
    console.error(c.red(`refusing to delete "${name}" without --force`));
    console.error(c.dim(`cotal personas rm ${name} --force`));
    process.exit(1);
  }
  rmSync(path);
  console.log(c.green(`✓ removed persona "${name}"`));
}

/** Write through a sibling temp file + rename so a concurrent reader never sees a half-written
 *  card (rename is atomic within the same directory). `saveAgentFile` creates the parent dir. */
function saveAtomic(path: string, def: AgentDef): void {
  const tmp = join(dirname(path), `.${def.name}.tmp-${process.pid}`);
  saveAgentFile(tmp, def);
  renameSync(tmp, path);
}

function firstLine(s?: string): string | undefined {
  return s?.split("\n").find((l) => l.trim())?.trim();
}

function truncate(s: string, n: number): string {
  return s.length > n ? `${s.slice(0, n - 1)}…` : s;
}

function notFound(name: string, path: string): never {
  console.error(c.red(`no persona "${name}"`));
  console.error(c.dim(path));
  process.exit(1);
}

function usage(): never {
  console.error(
    c.red(
      "usage: cotal personas <list [--verbose] [--running] | show <name> | edit <name> | " +
        'new <name> (--prompt <text> | --from <file|->) --subscribe <a,b|""> [--role <r>] [--model <m>] [--force] | rm <name> --force>',
    ),
  );
  process.exit(1);
}
