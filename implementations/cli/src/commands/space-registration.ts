import { mkdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import {
  CommandFailure,
  authDir,
  canonicalRoot,
  checkDiscoveryDocument,
  clearCurrent,
  discoveryDocumentUrl,
  findMesh,
  findPreparedSpace,
  getCurrent,
  homeCotalDir,
  loadMeshes,
  pinnedFetch,
  preparedSpaceAt,
  recordMesh,
  recordPreparedSpace,
  removeMesh,
  removePreparedSpace,
  writeResult,
  type Cell,
  type Check,
  type MeshEntry,
  type OutputWarning,
  type Presentation,
  type RefusalCode,
  type Report,
  type UserBundle,
} from "@cotal-ai/workspace";
import { liveMeshOwner } from "./clean.js";
import {
  candidateTarget,
  checkDialPolicy,
  checkEnforcement,
  checkMode,
  checkRoot,
  checkServer,
  checkTrust,
  checkUserBundle,
  probeEnforcement,
  remoteUserEntry,
  spacesAtRoot,
  tlsIntent,
  userExchangeIssuer,
  verifyTarget,
  verifyUserExchange,
} from "./meshes-add.js";
import { canPrompt, clackIO } from "./meshes-wizard.js";
import { detail, type SpaceDetail } from "./space.js";

/** The flags only `space add` takes. */
export const ADD_FLAGS = ["file", "from", "server", "root", "mode", "tls", "allow-unencrypted-overlay", "force", "yes"] as const;

export interface AddValues {
  readonly file?: string;
  readonly from?: string;
  readonly server?: string;
  readonly root?: string;
  readonly mode?: string;
  readonly tls?: boolean;
  readonly "allow-unencrypted-overlay"?: boolean;
  readonly force?: boolean;
  readonly yes?: boolean;
}

interface SpaceAdded {
  readonly kind: "space-added";
  /** The registration as `cotal space show` reports it. */
  readonly space: SpaceDetail;
  /** Whether the broker was checked before the record was written; false under `--force`. */
  readonly verified: boolean;
  /** Whether it replaced an earlier registration of the same name. */
  readonly replaced: boolean;
}

interface AddCancelled {
  readonly kind: "space-add-cancelled";
  /** The space named on the command line, or null when it was to come from a bundle. */
  readonly space: string | null;
}

interface SpaceCreated {
  readonly kind: "space-created";
  readonly space: string;
  /** The folder `cotal up` starts the space in. */
  readonly root: string;
  readonly preparedAt: string;
  readonly current: boolean;
}

interface SpaceForgotten {
  readonly kind: "space-forgotten";
  readonly space: string;
  /** The broker it was registered at, or null for a prepared space, which has none. */
  readonly server: string | null;
  readonly root: string;
  /** How it came to be here: a registration's origin, or `prepared` for a space `space create` made. */
  readonly origin: MeshEntry["origin"] | "prepared" | null;
  /** Whether it was the selected space, so no space is selected now. */
  readonly selectionCleared: boolean;
}

const usage = (message: string, remedy?: string): CommandFailure => new CommandFailure("refused", "USAGE_INVALID", message, remedy ? { remedy } : {});

/** A rule's value, or its refusal as a {@link CommandFailure} with the code the rule gives. */
function take<T>(check: Check<T>, target: unknown): T {
  if (check.ok) return check.value;
  if (!check.code) throw new Error(`internal error: a registration rule refused without a code: ${check.message}`);
  throw new CommandFailure("refused", check.code, check.message.replace(/^✗ /, ""), { target });
}

const refuse = (code: RefusalCode, message: string, target: unknown, remedy?: string): CommandFailure =>
  new CommandFailure("refused", code, message, { target, ...(remedy ? { remedy } : {}) });

/** Only a registration added by hand can be replaced; one this machine started or a catalog lists
 *  is forgotten or stopped first. */
function replaceable(name: string, force: boolean, target: unknown): boolean {
  if (findPreparedSpace(name))
    throw refuse("CONFLICT", `"${name}" is a space prepared on this machine`, target, `start it with \`cotal up\` in its root, or forget it with \`cotal space forget ${name}\``);
  const existing = findMesh(name);
  if (!existing) return false;
  if (!force) throw refuse("CONFLICT", `"${name}" is already registered at ${existing.server}`, target, `forget it first with \`cotal space forget ${name}\`, or pass --force to replace it`);
  if (existing.origin !== "manual")
    throw refuse("CONFLICT", `"${name}" is ${existing.origin === "catalog" ? "listed by a signed-in space catalog" : "a space this machine started"}, so --force does not replace it`, target, `see it with \`cotal space show ${name}\``);
  return true;
}

/** Shows what the registration will trust and asks before it is written. Without a terminal, or
 *  when `skip` is set (`--yes` where the question is not a guard), the command line is the consent. */
async function review(prompt: boolean, skip: boolean, rows: readonly (readonly [string, string])[], title: string, initialValue: boolean): Promise<boolean> {
  if (!prompt || skip) return true;
  const io = clackIO();
  const pad = Math.max(...rows.map(([label]) => label.length));
  io.note(rows.map(([label, value]) => `${label.padEnd(pad)}  ${value}`).join("\n"), title);
  return (await io.confirm({ message: "Add it?", initialValue })) === true;
}

/**
 * `cotal space add [<name>]` registers a space that runs elsewhere: from `--server` with the trust
 * under `--root`, or from a user-auth connection bundle (`--file`, or `--from` to fetch the
 * space's discovery document). Every check runs before anything is written: the address may carry
 * credentials, the trust composes, the broker enforces the mode, and the credentials open the
 * space. On a terminal the trust is shown and confirmed first. The selection is left as it is.
 */
export async function spaceAdd(rest: readonly string[], v: AddValues, presentation: Presentation): Promise<void> {
  if (rest.length > 1) throw usage("usage: cotal space add [<name>] --server <url> | --file <bundle.json> | --from <https url>");
  const name = rest[0];
  if (v.file !== undefined && v.from !== undefined) throw usage("pass --file or --from, not both: they are two sources for the same pinned trust");
  const bundled = v.file !== undefined || v.from !== undefined;
  if (bundled && v.mode !== undefined && v.mode !== "user") throw usage(`--file and --from add a user-auth space, so they do not take --mode ${v.mode}`);
  if (v.mode === "user" && !bundled)
    throw usage("--mode user needs the space's pinned trust", "pass --file <bundle.json> exported where the space runs, or --from <https url> to fetch its discovery document");
  const prompt = presentation !== "json" && canPrompt();
  const added = bundled ? await addFromBundle(name, v, prompt) : await addFromServer(name, v, prompt);
  if (added === undefined) {
    const target = name ? { space: name } : null;
    const result: AddCancelled = { kind: "space-add-cancelled", space: name ?? null };
    writeResult(presentation, { command: "space", target, result, noOp: true, warnings: [{ code: "USER_CANCELLED", target, message: "nothing was added" }] }, addedView);
    return;
  }
  writeResult(presentation, { command: "space", target: { space: added.result.space.space }, result: added.result, warnings: added.warnings }, addedView);
}

type Added = { readonly result: SpaceAdded; readonly warnings: OutputWarning[] } | undefined;

async function addFromServer(name: string | undefined, v: AddValues, prompt: boolean): Promise<Added> {
  if (name === undefined) throw usage("name the space to add", "cotal space add <name> --server <url>");
  const target = { space: name };
  if (v.server === undefined) throw usage("--server <url> is required: a space that runs elsewhere has no address to infer", "pass its broker URL, for example --server nats://100.90.12.34:4222");
  const server = take(checkServer(v.server, "--server"), target);
  const tlsRequired = tlsIntent(server, v.tls === true);
  const dial = take(checkDialPolicy(server, { tlsRequired, allowUnencryptedOverlay: v["allow-unencrypted-overlay"] === true }), target);
  const root = take(checkRoot(v.root, process.cwd()), target);
  const accounts = take(spacesAtRoot(root), target);
  const mode = take(checkMode(name, root, accounts, v.mode, false), target);
  const auth = take(checkTrust(mode, root, name), target);
  const replaced = replaceable(name, v.force === true, target);
  const verified = v.force !== true;
  if (verified) {
    take(checkEnforcement(mode, await probeEnforcement(server), server, name, root), target);
    take(await verifyTarget(candidateTarget(name, server, root, mode, auth, tlsRequired)), target);
  }
  const warnings: OutputWarning[] = [];
  if (dial.residual) warnings.push({ code: "UNENCRYPTED_OVERLAY", target, message: dial.residual });
  if (mode === "open" && accounts.includes(name))
    warnings.push({ code: "TRUST_NOT_USED", target, message: `${authDir(root)} holds trust for "${name}", but --mode open adds a connection with no credentials` });
  const rows: [string, string][] = [
    ["space", name],
    ["broker", `${server}${tlsRequired ? " (TLS required)" : ""}`],
    ["mode", mode === "auth" ? `auth, with the trust under ${authDir(root)}` : "open, with no credentials"],
    ["root", root],
    ["checked", verified ? "the broker answers and enforces this mode" : "nothing: --force adds it unchecked"],
  ];
  if (!(await review(prompt, v.yes === true, rows, `Add ${name}`, true))) return undefined;
  const entry: MeshEntry = { space: name, server, root, mode, origin: "manual", ...(tlsRequired ? { tlsRequired: true } : {}), ...(dial.residual ? { unencryptedOverlay: true } : {}), ts: new Date().toISOString() };
  recordMesh(entry);
  return { result: { kind: "space-added", space: detail(entry, getCurrent() ?? null, verified ? "reachable" : "not-checked"), verified, replaced }, warnings };
}

/** A user-auth space: its pins come from a bundle exported where it runs, or from its HTTPS
 *  discovery document, which is fetched only after the operator agrees and is adopted only after
 *  they confirm the pins. Its checks run even under `--force`, which only replaces a record. */
async function addFromBundle(name: string | undefined, v: AddValues, prompt: boolean): Promise<Added> {
  const target = name ? { space: name } : null;
  let bundle: UserBundle;
  if (v.file !== undefined) {
    let raw: string;
    try {
      raw = readFileSync(v.file, "utf8");
    } catch (e) {
      throw usage(`cannot read --file ${v.file} (${(e as NodeJS.ErrnoException).code ?? (e as Error).message})`);
    }
    bundle = take(checkUserBundle(raw), target);
  } else {
    let disco: URL;
    try {
      const from = new URL(v.from!);
      disco = from.pathname.endsWith("/.well-known/cotal-mesh") ? from : discoveryDocumentUrl(from);
    } catch {
      throw usage("--from is not a URL");
    }
    if (disco.protocol !== "https:") throw usage("--from must be an https:// URL: the discovery document carries the trust pins, and a plaintext fetch lets the network choose them");
    if (!prompt) throw usage("--from needs a terminal to show and confirm the fetched pins", "in a script, export the bundle where the space runs and pass it with --file");
    const io = clackIO();
    if ((await io.confirm({ message: `Fetch trust pins from ${disco}?`, initialValue: false })) !== true) return undefined;
    let res: Response;
    try {
      res = await pinnedFetch(disco.toString(), `--from ${disco}`);
    } catch (e) {
      const m = (e as Error).message;
      throw refuse(m.startsWith("✗") ? "UNSUPPORTED" : "TARGET_UNAVAILABLE", m.startsWith("✗") ? m.slice(2) : `could not fetch ${disco} (${m})`, target);
    }
    if (!res.ok) throw refuse("TARGET_UNAVAILABLE", `${disco} answered ${res.status}: no discovery document there`, target);
    bundle = take(await checkDiscoveryDocument(res), target);
  }
  const space = name ?? bundle.space;
  const spaceTarget = { space };
  if (name !== undefined && bundle.space !== name) throw refuse("CONFLICT", `the bundle is for "${bundle.space}", not "${name}": a bundle adds the space it was exported for`, spaceTarget);
  const server = take(v.server === undefined ? checkServer(bundle.server, "the bundle's server") : checkServer(v.server, "--server"), spaceTarget);
  const tlsRequired = bundle.tlsRequired || tlsIntent(server, v.tls === true);
  const dial = take(checkDialPolicy(server, { tlsRequired, allowUnencryptedOverlay: v["allow-unencrypted-overlay"] === true }), spaceTarget);
  const root = take(checkRoot(v.root, process.cwd()), spaceTarget);
  take(checkMode(space, root, [], "user", true), spaceTarget);
  const replaced = replaceable(space, v.force === true, spaceTarget);
  take(await verifyUserExchange(bundle.userAuth.endpoints!.url!, userExchangeIssuer(bundle.space)), spaceTarget);
  take(checkEnforcement("user", await probeEnforcement(server), server, space, root), spaceTarget);
  const rows: [string, string][] = [
    ["space", space],
    ["broker", `${server}${tlsRequired ? " (TLS required)" : ""}`],
    ["IdP", bundle.userAuth.idp.url],
    ["issuer", bundle.userAuth.idp.issuer],
    ["audience", bundle.userAuth.idp.audience],
    ["exchange", bundle.userAuth.endpoints!.url!],
    ["root", root],
  ];
  // A fetched document is always confirmed: the operator, not the network, adopts its pins.
  const title = "Trust these pins only if they match what the space's operator published";
  if (!(await review(prompt, v.yes === true && v.from === undefined, rows, title, false))) return undefined;
  const entry = remoteUserEntry(space, server, root, bundle, tlsRequired, Boolean(dial.residual));
  recordMesh(entry);
  const warnings: OutputWarning[] = dial.residual ? [{ code: "UNENCRYPTED_OVERLAY", target: spaceTarget, message: dial.residual }] : [];
  return { result: { kind: "space-added", space: detail(entry, getCurrent() ?? null, "reachable"), verified: true, replaced }, warnings };
}

function addedView(r: SpaceAdded | AddCancelled): Report {
  if (r.kind === "space-add-cancelled") return { sections: [{ blocks: [{ kind: "lines", lines: [{ text: "nothing was added", tone: "hint" }] }] }] };
  const s = r.space;
  const head: Cell = { text: `${r.replaced ? "replaced" : "added"} ${s.space}`, tone: "ok", mark: "✓" };
  const fields: [string, Cell][] = [
    ["server", s.server],
    ["mode", s.mode],
    ["root", s.root],
    ["checked", r.verified ? { text: "broker answered", tone: "ok" } : { text: "not checked (--force)", tone: "waiting" }],
  ];
  if (s.userAuth) fields.push(["login", s.userAuth.idp.url]);
  const hints: Cell[] = s.current ? [] : [{ text: `select it with \`cotal use ${s.space}\``, tone: "hint" }];
  return { sections: [{ blocks: [{ kind: "lines", lines: [head] }, { kind: "fields", rows: fields }, ...(hints.length ? [{ kind: "lines" as const, lines: hints }] : [])] }] };
}

/**
 * `cotal space create <name>` prepares a space to start on this machine: it records the name and
 * the root, and makes `<root>/.cotal/` so `cotal up` there starts it under that name. It starts
 * nothing, and the selection is left as it is. The root is `--root`, else this folder.
 */
export async function spaceCreate(rest: readonly string[], rootFlag: string | undefined, presentation: Presentation): Promise<void> {
  if (rest.length !== 1 || rest[0]!.trim() === "") throw usage("usage: cotal space create <name> [--root <dir>]");
  const name = rest[0]!;
  const target = { space: name };
  const root = resolve(rootFlag ?? process.cwd());
  if (!isDir(root)) throw usage(`--root ${root} is not a directory`, "create the folder first, or pass an existing one");
  if (resolve(root, ".cotal") === resolve(homeCotalDir()) || canonicalRoot(root) === canonicalRoot(homedir()))
    throw refuse("CONFLICT", `${root} is your home folder, whose .cotal holds this machine's own records`, target, "create the space in a project folder, or pass --root <dir>");
  const registered = findMesh(name);
  if (registered) throw refuse("CONFLICT", `"${name}" is already registered at ${registered.server}`, target, `see it with \`cotal space show ${name}\``);
  const prepared = findPreparedSpace(name);
  if (prepared) throw refuse("CONFLICT", `"${name}" is already prepared in ${prepared.root}`, target, `start it with \`cotal up\` there, or forget it with \`cotal space forget ${name}\``);
  const held = [...take(spacesAtRoot(root), target), ...loadMeshes().filter((m) => canonicalRoot(m.root) === canonicalRoot(root)).map((m) => m.space), ...[preparedSpaceAt(root)?.space].filter((s): s is string => s !== undefined)];
  if (held.length > 0)
    throw refuse("CONFLICT", `${root} is already the root of "${[...new Set(held)].join('", "')}"`, target, "create the space in another folder, or pass --root <dir>");
  mkdirSync(join(root, ".cotal"), { recursive: true });
  const ts = new Date().toISOString();
  recordPreparedSpace({ space: name, root, ts });
  const result: SpaceCreated = { kind: "space-created", space: name, root, preparedAt: ts, current: getCurrent() === name };
  writeResult(presentation, { command: "space", target, result }, createdView);
}

function isDir(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

function createdView(r: SpaceCreated): Report {
  const lines: Cell[] = [
    { text: `prepared ${r.space}`, tone: "ok", mark: "✓" },
    { text: `  start it with \`cotal up\` in ${r.root}`, tone: "hint" },
  ];
  if (!r.current) lines.push({ text: `  select it with \`cotal use ${r.space}\``, tone: "hint" });
  return { sections: [{ blocks: [{ kind: "lines", lines }] }] };
}

/**
 * `cotal space forget <name>` removes a registration this machine keeps. It stops nothing and
 * deletes nothing on a broker, and the root's files stay. A space this machine is running is
 * stopped with `cotal down`, which also drops its record, and a discovered space follows its
 * catalog. Forgetting the selected space clears the selection. A prepared space is forgotten the
 * same way, and the `.cotal/` folder `space create` made stays.
 */
export async function spaceForget(rest: readonly string[], presentation: Presentation): Promise<void> {
  if (rest.length !== 1) throw usage("usage: cotal space forget <name>");
  const name = rest[0]!;
  const target = { space: name };
  const m = findMesh(name);
  if (!m) {
    const p = findPreparedSpace(name);
    if (!p) throw refuse("TARGET_NOT_FOUND", `no space named "${name}" is registered here`, target, "see the registered spaces with `cotal space`");
    removePreparedSpace(name);
    return forgotten(presentation, { space: name, server: null, root: p.root, origin: "prepared" });
  }
  if (m.origin === "catalog")
    throw refuse("CONFLICT", `"${name}" is listed by a signed-in space catalog, so this machine does not own its registration`, target, "it is removed when the catalog no longer lists it and `cotal sync` runs");
  if (m.origin !== "manual") {
    let running: string | undefined;
    try {
      running = liveMeshOwner(m.root, m.space);
    } catch (e) {
      throw refuse("LIFECYCLE_BLOCKED", `could not tell whether "${name}" is running from ${m.root}: ${(e as Error).message}`, target, "check it with `cotal status`");
    }
    if (running) throw refuse("LIFECYCLE_BLOCKED", `"${name}" is running from ${m.root} (${running})`, target, `stop it with \`cotal down\` in ${m.root}, which also drops its record`);
  }
  removeMesh(name);
  forgotten(presentation, { space: name, server: m.server, root: m.root, origin: m.origin ?? null });
}

function forgotten(presentation: Presentation, r: Omit<SpaceForgotten, "kind" | "selectionCleared">): void {
  const selectionCleared = getCurrent() === r.space;
  if (selectionCleared) clearCurrent();
  const result: SpaceForgotten = { kind: "space-forgotten", ...r, selectionCleared };
  writeResult(presentation, { command: "space", target: { space: r.space }, result }, forgottenView);
}

function forgottenView(r: SpaceForgotten): Report {
  const lines: Cell[] = [
    { text: `forgot ${r.space}`, tone: "ok", mark: "✓" },
    { text: `  ${r.server === null ? "prepared, never started" : r.server}; the files under ${r.root} are kept`, tone: "hint" },
  ];
  if (r.selectionCleared) lines.push({ text: "no space is selected now - select one with `cotal use <name>`", tone: "hint" });
  return { sections: [{ blocks: [{ kind: "lines", lines }] }] };
}
