/**
 * Capability census sources: every capability Cotal exposes, read from the machine-readable sources
 * that define it, as one flat list of item ids.
 *
 * The census asks one question of each item: which CLI command performs it. This module only lists
 * the items. `owner-map.json` records each item's owner, and `capability-census.smoke.ts` fails when
 * an item has no owner, an owner names no real command or flag, or a row names an item that no
 * longer exists. Prose sources (SPEC.md §13, the console and dashboard actions, docs/mesh-view.md
 * and the delivery daemon's `ctl.delivery` requests) are covered by the checklist in the owner map,
 * not by this list.
 *
 * Item ids:
 *   ep:<endpoint>:<command>             a registered endpoint command
 *   ep:<endpoint>:<command>#<class>/<capability>   its execution class and capability
 *   ep:<endpoint>:<command>@<mode>      one of its target modes
 *   ep:<endpoint>:<command>.<field>     one input field, nested fields joined with "."
 *   tool:<name> / tool:<name>.<arg>     an agent tool and its arguments
 *   cli:<command> / cli:<command>--<flag>   a registered CLI command and its declared flags
 *   cli:<command> <mode>                one subcommand mode its usage string declares
 *   agent-file:<field>                  a persona (agent file) field
 *   manifest:<Interface>.<field>        a team manifest model field
 *   config:<Interface>.<field>          a configuration file field
 *   presence:<field>                    a roster (presence) field
 *   roster:<key>                        a key of a manager roster file
 *   env:<NAME>                          a COTAL_* environment variable shipped source reads or sets
 *   auth-http:<route>                   an auth service HTTP route
 */
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import ts from "typescript";

export const REPO = join(import.meta.dirname, "..", "..", "..");

/** One census item: its id and the source file it was read from. */
export interface CensusItem {
  readonly id: string;
  readonly source: string;
}

type JsonSchema = { properties?: Record<string, JsonSchema>; type?: unknown };
type ContractDoc = { commands: { name: string; class: string; capability: string; modes?: string[]; inputDigest: string }[] };

const ENDPOINT_CONTRACTS = [
  { endpoint: "manager", file: "implementations/manager/dist/manager-service-contract.js", doc: "managerClusterDocument", values: "managerContractArtifactValues" },
  { endpoint: "auth", file: "implementations/auth/dist/auth-service-contract.js", doc: "authClusterDocument", values: "authContractArtifactValues" },
  { endpoint: "linear", file: "implementations/linear/dist/contract.js", doc: "linearClusterDocument", values: "linearContractArtifactValues" },
] as const;

/** Every input field of a schema, nested object fields included, as dotted paths. */
function schemaFields(schema: JsonSchema | undefined, prefix = ""): string[] {
  const out: string[] = [];
  for (const [key, sub] of Object.entries(schema?.properties ?? {})) {
    out.push(prefix + key);
    if (sub.properties) out.push(...schemaFields(sub, `${prefix}${key}.`));
  }
  return out;
}

/** Endpoint commands, their class and capability, modes and input fields, resolved from each contract's published artifacts. */
export async function endpointItems(): Promise<CensusItem[]> {
  const { contractDigest } = await import("@cotal-ai/core");
  const items: CensusItem[] = [];
  for (const c of ENDPOINT_CONTRACTS) {
    const mod = (await import(pathToFileURL(join(REPO, c.file)).href)) as Record<string, () => unknown>;
    const doc = mod[c.doc]() as ContractDoc;
    const values = mod[c.values]() as unknown[];
    const byDigest = new Map(values.map((v) => [contractDigest(v), v]));
    for (const cmd of doc.commands) {
      const base = `ep:${c.endpoint}:${cmd.name}`;
      items.push({ id: base, source: c.file });
      items.push({ id: `${base}#${cmd.class}/${cmd.capability}`, source: c.file });
      for (const mode of cmd.modes ?? []) items.push({ id: `${base}@${mode}`, source: c.file });
      const manifest = byDigest.get(cmd.inputDigest) as { root?: string } | undefined;
      const schema = manifest?.root ? (byDigest.get(manifest.root) as JsonSchema | undefined) : undefined;
      if (!schema) throw new Error(`${c.file}: ${cmd.name} has an input digest that resolves to no schema`);
      for (const field of schemaFields(schema)) items.push({ id: `${base}.${field}`, source: c.file });
    }
  }
  return items;
}

/** Agent tools and their arguments, from a clean open-mode config so no tool is hidden. */
export async function toolItems(): Promise<CensusItem[]> {
  const { cotalToolSpecs, configFromEnv } = await import("@cotal-ai/connector-core");
  const config = configFromEnv({ COTAL_NAME: "census", COTAL_SPACE: "census", COTAL_SERVERS: "nats://127.0.0.1:4222" });
  const source = "extensions/connector-core/src/tool-specs.ts";
  const items: CensusItem[] = [];
  for (const spec of cotalToolSpecs(config, "census")) {
    items.push({ id: `tool:${spec.name}`, source });
    for (const arg of Object.keys(spec.schema.shape)) items.push({ id: `tool:${spec.name}.${arg}`, source });
  }
  return items;
}

/** The surfaces the published composition root registers, plus first-party command extensions. */
const COMMAND_SURFACES = [
  "@cotal-ai/cli",
  "@cotal-ai/manager",
  "@cotal-ai/delivery",
  "@cotal-ai/runtime",
  "@cotal-ai/auth",
  "@cotal-ai/web",
  "@cotal-ai/linear",
];

/** Split `text` on `|` that sits outside any `<…>`, `[…]` or `(…)` group. */
function topLevelAlternatives(text: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === "<" || ch === "[" || ch === "(") depth++;
    else if (ch === ">" || ch === "]" || ch === ")") depth--;
    else if (ch === "|" && depth === 0) { out.push(text.slice(start, i)); start = i + 1; }
  }
  out.push(text.slice(start));
  return out.map((a) => a.trim());
}

const WORD = /^[a-z][a-z-]*$/;

/**
 * The subcommand modes a usage string declares. A usage holds one or more forms, separated by new
 * lines or by `| <command> `. In each form the first token after the command name is a mode when it
 * is a bare word (`history clear`, `linear account add`), or a group of alternatives: `<a | b>` with
 * two or more alternatives, or `[a | b]`, each alternative's leading word. A single `<word>` is a
 * placeholder, and an alternative that starts with a flag is not a mode.
 */
export function usageModes(name: string, usage: string): string[] {
  const modes = new Set<string>();
  const forms = usage.split("\n").flatMap((line) => line.split(` | ${name} `).map((f, i) => (i === 0 ? f : `${name} ${f}`)));
  for (const raw of forms) {
    const form = raw.trim().replace(/^cotal /, "");
    if (!form.startsWith(`${name} `) && form !== name) continue;
    const rest = form.slice(name.length).trim();
    const open = rest[0];
    if (open === "<" || open === "[") {
      const close = open === "<" ? ">" : "]";
      let depth = 0;
      let end = 0;
      for (; end < rest.length; end++) {
        if (rest[end] === "<" || rest[end] === "[" || rest[end] === "(") depth++;
        else if (rest[end] === ">" || rest[end] === "]" || rest[end] === ")") depth--;
        if (depth === 0) break;
      }
      if (rest[end] !== close) continue;
      const alternatives = topLevelAlternatives(rest.slice(1, end));
      if (open === "<" && alternatives.length < 2) continue;
      for (const alt of alternatives) {
        const word = alt.split(/\s+/)[0] ?? "";
        if (WORD.test(word)) modes.add(word);
      }
    } else {
      const words = rest.split(/\s+/);
      if (!WORD.test(words[0] ?? "")) continue;
      modes.add(WORD.test(words[1] ?? "") ? `${words[0]} ${words[1]}` : words[0]!);
    }
  }
  return [...modes];
}

/** Registered CLI commands, their declared flags and the subcommand modes their usage declares. */
export async function cliItems(): Promise<CensusItem[]> {
  for (const surface of COMMAND_SURFACES) await import(surface);
  const { registry } = await import("@cotal-ai/core");
  const items: CensusItem[] = [];
  for (const cmd of registry.all<import("@cotal-ai/core").Command>("command")) {
    items.push({ id: `cli:${cmd.name}`, source: "command registry" });
    for (const flag of cmd.flags ?? []) items.push({ id: `cli:${cmd.name}--${flag.name}`, source: "command registry" });
    for (const mode of usageModes(cmd.name, cmd.usage ?? "")) items.push({ id: `cli:${cmd.name} ${mode}`, source: "command usage" });
  }
  return items;
}

/** The property names of named interfaces in one TypeScript source file. */
function interfaceFields(file: string, names?: readonly string[]): Map<string, string[]> {
  const sf = ts.createSourceFile(file, readFileSync(join(REPO, file), "utf8"), ts.ScriptTarget.Latest, true);
  const out = new Map<string, string[]>();
  sf.forEachChild((node) => {
    if (!ts.isInterfaceDeclaration(node) || (names && !names.includes(node.name.text))) return;
    out.set(
      node.name.text,
      node.members.filter(ts.isPropertySignature).map((m) => m.name.getText(sf).replace(/^["']|["']$/g, "")),
    );
  });
  for (const name of names ?? []) if (!out.has(name)) throw new Error(`${file}: interface ${name} not found`);
  return out;
}

/** Fields of the persona, manifest, configuration and presence models. */
export function modelItems(): CensusItem[] {
  const items: CensusItem[] = [];
  const add = (prefix: string, file: string, names?: readonly string[], qualify = true): void => {
    for (const [iface, fields] of interfaceFields(file, names))
      for (const f of fields) items.push({ id: qualify ? `${prefix}:${iface}.${f}` : `${prefix}:${f}`, source: file });
  };
  add("agent-file", "packages/core/src/agent-file.ts", ["AgentDef"], false);
  add("manifest", "implementations/cli/src/lib/manifest/model.ts");
  add("config", "packages/core/src/connector-config.ts");
  add("presence", "packages/core/src/types.ts", ["Presence"], false);
  return items;
}

/** The keys a manager roster file accepts: the top-level list and each entry's keys. */
export function rosterItems(): CensusItem[] {
  const file = "implementations/manager/src/roster.ts";
  const sf = ts.createSourceFile(file, readFileSync(join(REPO, file), "utf8"), ts.ScriptTarget.Latest, true);
  let keys: string[] | undefined;
  sf.forEachChild((node) => {
    if (!ts.isVariableStatement(node)) return;
    for (const d of node.declarationList.declarations) {
      if (d.name.getText(sf) !== "ENTRY_KEYS" || !d.initializer || !ts.isNewExpression(d.initializer)) continue;
      const list = d.initializer.arguments?.[0];
      if (list && ts.isArrayLiteralExpression(list)) keys = list.elements.filter(ts.isStringLiteral).map((e) => e.text);
    }
  });
  if (!keys?.length) throw new Error(`${file}: ENTRY_KEYS not found`);
  return ["agents", ...keys].map((k) => ({ id: `roster:${k}`, source: file }));
}

/** `COTAL_*` names in an environment position: `env.X`, `env["X"]`, a quoted or `$`-expanded name,
 *  `X=` assignment text, or an object key. Browser globals (`window.COTAL_*`) and exported constants
 *  that share the prefix are not environment variables and do not match. */
const ENV_SHAPED = String.raw`(env\??\.|env\[["']|["'$]|\$\{)COTAL_[A-Z0-9_]*[A-Z0-9]|COTAL_[A-Z0-9_]*[A-Z0-9]=|(^ *|[{,(] *)COTAL_[A-Z0-9_]*[A-Z0-9]\??:`;

/** COTAL_* environment variables that shipped source reads or sets. */
export function envItems(): CensusItem[] {
  const out = execFileSync(
    "git",
    ["grep", "-hoE", ENV_SHAPED, "--", "packages", "implementations", "extensions", "bin/cotal.ts", "bin/run.ts",
      ":!**/smoke/**", ":!**/smoke.ts", ":!**/*.smoke.*", ":!**/test/**", ":!**/*.test.*", ":!**/*.md", ":!**/dist/**", ":!**/claude-plugin/**"],
    { cwd: REPO, encoding: "utf8" },
  );
  const names = new Set(out.match(/COTAL_[A-Z0-9_]*[A-Z0-9]/g) ?? []);
  return [...names].sort().map((name) => ({ id: `env:${name}`, source: "shipped source" }));
}

/** The auth service's HTTP routes: the keys of its route tables, string literals or the module's
 *  own string constants. A key that resolves to neither fails the census rather than going uncounted. */
export function authHttpItems(): CensusItem[] {
  const file = "implementations/auth/src/service.ts";
  const sf = ts.createSourceFile(file, readFileSync(join(REPO, file), "utf8"), ts.ScriptTarget.Latest, true);
  const constants = new Map<string, string>();
  sf.forEachChild((node) => {
    if (!ts.isVariableStatement(node)) return;
    for (const d of node.declarationList.declarations)
      if (ts.isIdentifier(d.name) && d.initializer && ts.isStringLiteral(d.initializer)) constants.set(d.name.text, d.initializer.text);
  });
  const routes = new Set<string>();
  const visit = (node: ts.Node): void => {
    if (ts.isNewExpression(node) && node.expression.getText(sf) === "Map" && node.arguments?.[0] && ts.isArrayLiteralExpression(node.arguments[0])) {
      for (const el of node.arguments[0].elements) {
        const key = ts.isArrayLiteralExpression(el) ? el.elements[0] : undefined;
        if (!key) continue;
        const text = ts.isStringLiteral(key) ? key.text : ts.isIdentifier(key) ? constants.get(key.text) : undefined;
        if (text === undefined) throw new Error(`${file}: route key ${key.getText(sf)} is not a string or a module string constant`);
        if (text.startsWith("/")) routes.add(text);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  if (routes.size === 0) throw new Error(`${file}: no HTTP route table found`);
  return [...routes].sort().map((r) => ({ id: `auth-http:${r}`, source: file }));
}

/** Every census item from every machine-readable source. Ids are unique. */
export async function censusItems(): Promise<CensusItem[]> {
  const all = [
    ...(await endpointItems()),
    ...(await toolItems()),
    ...(await cliItems()),
    ...modelItems(),
    ...rosterItems(),
    ...envItems(),
    ...authHttpItems(),
  ];
  const seen = new Set<string>();
  for (const item of all) {
    if (seen.has(item.id)) throw new Error(`duplicate census item ${item.id}`);
    seen.add(item.id);
  }
  return all;
}
