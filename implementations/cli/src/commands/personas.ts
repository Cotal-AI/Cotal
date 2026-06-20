import { existsSync, readFileSync, renameSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { parseArgs } from "node:util";
import {
  agentFilePath,
  assertValidName,
  saveAgentFile,
  type AgentDef,
  type CompletionResult,
} from "@cotal-ai/core";
import { cotalRoot } from "../lib/paths.js";
import { listPersonas, listPersonaNames, personasDir } from "../lib/personas.js";
import { c } from "../ui.js";

/**
 * `cotal personas` — list and manage the local persona catalog (`.cotal/agents/*.md`),
 * modelled on `cotal channels`. Workspace-local file editing, NOT a mesh operation: it reads
 * and writes the files directly (instant, works offline). The privileged, ownership-checked
 * path stays in the manager's `definePersona` for *agents* defining personas over the wire.
 *
 *   cotal personas [list] [--verbose]
 *   cotal personas show <name>
 *   cotal personas new <name> (--prompt <text> | --from <file|->) [--role <r>] [--model <m>] [--force]
 *   cotal personas rm <name> --force
 */

/** Persona names are also filenames and spawn names — mirror the `cotal_persona` tool's pattern. */
const NAME_RE = /^[A-Za-z0-9_-]+$/;

export async function personas(argv: string[]): Promise<void> {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      role: { type: "string" },
      model: { type: "string" },
      prompt: { type: "string" },
      from: { type: "string" },
      verbose: { type: "boolean", short: "v" },
      force: { type: "boolean" },
    },
  });

  switch (positionals[0] ?? "list") {
    case "list":
      return list(values.verbose === true);
    case "show":
      return show(positionals[1]);
    case "new":
      return create(positionals[1], values);
    case "rm":
      return remove(positionals[1], values.force === true);
    default:
      return usage();
  }
}

/** Argument completion: subcommands, then persona names for `show`/`rm`. */
export function personasComplete(argv: string[]): CompletionResult {
  const subs: CompletionResult = {
    items: [
      { value: "list", description: "list the persona catalog" },
      { value: "show", description: "print a persona's card" },
      { value: "new", description: "create a persona" },
      { value: "rm", description: "delete a persona" },
    ],
    directive: "nofiles",
  };
  if (argv.length <= 1) return subs; // completing the subcommand
  if (argv[0] === "show" || argv[0] === "rm")
    return { items: listPersonaNames().map((value) => ({ value })), directive: "nofiles" };
  return { items: [], directive: "nofiles" };
}

function list(verbose: boolean): void {
  const entries = listPersonas();
  if (!entries.length) {
    console.log(
      c.dim(`no personas in ${personasDir()}\n`) +
        c.dim('create one:  cotal personas new <name> --prompt "<who they are>"'),
    );
    return;
  }
  const pad = Math.max(...entries.map((e) => e.name.length));
  for (const e of entries) {
    if (e.error) {
      console.log(`${c.red(e.name.padEnd(pad))}  ${c.red("⨯ unparseable")} ${c.dim(e.error)}`);
      continue;
    }
    const d = e.def!;
    const meta = [d.role && c.cyan(d.role), d.model && c.dim(`model=${d.model}`), d.owner && c.dim(`owner=${d.owner}`)]
      .filter(Boolean)
      .join("  ");
    console.log(`${c.bold(e.name.padEnd(pad))}  ${meta}`.trimEnd());
    const desc = d.description ?? firstLine(d.persona);
    if (desc) console.log(c.dim(`  ${truncate(desc, 100)}`));
    if (verbose && d.persona) console.log(d.persona.replace(/^/gm, "    ") + "\n");
  }
}

function show(name?: string): void {
  if (!name) return usage();
  const path = agentFilePath(cotalRoot(), name);
  if (!existsSync(path)) return notFound(name, path);
  // Print the file verbatim — the canonical card (frontmatter + persona body).
  console.log(c.dim(path));
  process.stdout.write(readFileSync(path, "utf8"));
}

function create(name: string | undefined, v: { role?: string; model?: string; prompt?: string; from?: string; force?: boolean }): void {
  if (!name) return usage();
  if (!NAME_RE.test(name)) {
    console.error(c.red(`invalid persona name "${name}": use letters, digits, "_" or "-"`));
    process.exit(1);
  }
  assertValidName(name); // shared reserved-character guard (also rejects "/")

  const path = agentFilePath(cotalRoot(), name);
  if (existsSync(path) && !v.force) {
    console.error(c.red(`persona "${name}" already exists — pass --force to overwrite`));
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

  const def: AgentDef = { name, role: v.role, model: v.model, persona };
  saveAtomic(path, def);
  console.log(c.green(`✓ wrote persona "${name}"`));
  console.log(c.dim(`${path}\nspawn it:  cotal spawn ${name}${v.role ? ` --role ${v.role}` : ""}`));
}

function remove(name: string | undefined, force: boolean): void {
  if (!name) return usage();
  const path = agentFilePath(cotalRoot(), name);
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
      "usage: cotal personas <list [--verbose] | show <name> | " +
        'new <name> (--prompt <text> | --from <file|->) [--role <r>] [--model <m>] [--force] | rm <name> --force>',
    ),
  );
  process.exit(1);
}
