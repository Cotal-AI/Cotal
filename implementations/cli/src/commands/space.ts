import { existsSync } from "node:fs";
import type { CompletionResult, FlagSpec, FlagValues, ParsedArgs } from "@cotal-ai/core";
import {
  CommandFailure,
  brokerAnswers,
  findMesh,
  findPreparedSpace,
  folderSpace,
  folderSpaceHeld,
  folderSpaceOverSelection,
  getCurrent,
  isMeshRegistryError,
  jsonFlag,
  loadMeshes,
  loadPreparedSpaces,
  noteFolderSpace,
  noteFolderSpaceShown,
  plainFlag,
  preparedLifecycle,
  presentationOf,
  pruneStaleMeshes,
  writeResult,
  type Cell,
  type MeshEntry,
  type OutputWarning,
  type Presentation,
  type PreparedSpace,
  type Report,
  type Section,
} from "@cotal-ai/workspace";
import { completingFlagValue } from "../lib/completion.js";
import { registryFailure } from "../lib/registry-errors.js";
import { SPACE_MODES } from "./meshes-add.js";
import { ADD_FLAGS, spaceAdd, spaceCreate, spaceForget } from "./space-registration.js";
import { spaceDelete } from "./space-delete.js";

export const spaceFlags = [
  jsonFlag,
  plainFlag,
  { name: "server", type: "string", value: "<url>", description: "add: the space's broker URL" },
  { name: "root", type: "string", value: "<dir>", description: "add: the folder for the space's personas and, for an auth space, its .cotal/auth trust (default: this project; required outside one); create: the folder it starts in (default: this one)" },
  { name: "mode", type: "string", value: "<auth|open|user>", description: "add: how the broker authenticates (default: auth when --root holds the space's trust, else open)" },
  { name: "file", short: "f", type: "string", value: "<bundle.json>", description: "add: a user-auth connection bundle exported where the space runs" },
  { name: "from", type: "string", value: "<https url>", description: "add: fetch the space's discovery document; its pins are shown and confirmed" },
  { name: "tls", type: "boolean", description: "add: require TLS on every connection to the space (a tls:// or wss:// --server implies it)" },
  { name: "allow-unencrypted-overlay", type: "boolean", description: "add: accept that an overlay address is protected only while its tunnel is up" },
  { name: "force", type: "boolean", description: "add: replace a registration added by hand, and add a --server space without checking its broker" },
  { name: "yes", short: "y", type: "boolean", description: "confirm without the terminal question; a delete must name the exact space, and an add still confirms fetched pins" },
  { name: "dry-run", type: "boolean", description: "delete: read native first-party impact without deleting anything" },
  { name: "adopt", type: "boolean", description: "create: take over the stack journal a copied or moved project folder holds, so the space starts from this folder" },
] as const satisfies readonly FlagSpec[];

const usage = (message: string): CommandFailure => new CommandFailure("refused", "USAGE_INVALID", message);

/** Whether a registration's broker answered. A discovered catalog entry is never dialed by a read, so
 *  its broker is `not-checked` rather than a guessed answer. */
export type Check = "reachable" | "unreachable" | "not-checked";

/** One registered space, as `cotal space` lists it: the same row `cotal status --json` gives under
 *  `meshes.items`. */
export interface SpaceRow {
  readonly space: string;
  readonly server: string;
  readonly mode: MeshEntry["mode"];
  readonly root: string;
  /** `up` when this machine started it, `manual` when it was registered by hand, `catalog` when a
   *  signed-in catalog lists it, null for a record written before origins were recorded. */
  readonly origin: MeshEntry["origin"] | null;
  readonly tlsRequired: boolean;
  readonly eventsRequired: boolean;
  /** False when `space add --force` registered it unchecked, so its `mode` was never seen enforced. */
  readonly modeChecked: boolean;
  /** Whether it is the space `cotal use` selected. */
  readonly current: boolean;
  readonly check: Check;
  /** A discovered space's catalog name when it differs from the space, and the last fetch. */
  readonly catalog: { readonly name: string | null; readonly fetchedAt: string | null; readonly error: string | null } | null;
}

interface SpacesResult {
  readonly kind: "spaces";
  /** The space `cotal use` selected, or null. It can name a space that is no longer registered. */
  readonly current: string | null;
  readonly currentRecorded: boolean;
  /** This folder's space when a command without `--space` targets it here instead of `current`, or null. */
  readonly folder: string | null;
  readonly items: readonly SpaceRow[];
  /** Spaces `cotal space create` prepared and no `cotal up` has started. They have no broker yet. */
  readonly prepared: readonly PreparedRow[];
}

/** A prepared space, as `cotal space` lists it and `cotal space show` shows it. */
export interface PreparedRow {
  readonly space: string;
  readonly root: string;
  readonly preparedAt: string;
  readonly current: boolean;
  /** Its project folder no longer exists, so `up` cannot start it there. */
  readonly rootMissing: boolean;
  /** What its root's stack records, as `status` reports it: never started, stopped, or a last
   *  `up` or `down` with no recorded outcome. */
  readonly state: "prepared" | "stopped" | "unsettled";
  /** That last operation and how it ended, such as `` `cotal down`, completed ``; null when it never started. */
  readonly lastOperation: string | null;
}

interface PreparedDetail extends PreparedRow {
  readonly kind: "prepared-space";
}

/** One registration in full. Pins and endpoints are public; credential paths are left out. */
export interface SpaceDetail extends Omit<SpaceRow, "catalog"> {
  readonly kind: "space";
  readonly recordedAt: string;
  readonly attachHost: string | null;
  readonly maxSessions: number | null;
  readonly storeDir: string | null;
  readonly unencryptedOverlay: boolean;
  readonly userAuth: { readonly provider: string; readonly idp: { readonly url: string; readonly issuer: string; readonly audience: string }; readonly remote: boolean } | null;
  readonly catalog: (NonNullable<SpaceRow["catalog"]> & { readonly id: string | null; readonly slug: string | null; readonly kind: string | null; readonly role: string | null }) | null;
}

/**
 * `cotal space` lists the spaces this machine can reach, and `cotal space show [<name>]` shows one in
 * full. Both read the local registry and probe brokers; neither writes anything. A broker that does
 * not answer leaves its registration in place, reported `unreachable`. Spaces `space create`
 * prepared are listed apart, with no broker to probe. `space add`, `space create` and
 * `space forget` change what is recorded (see `space-registration.ts`).
 */
export async function space(args: ParsedArgs): Promise<void> {
  const values = args.values as FlagValues<typeof spaceFlags>;
  const presentation = presentationOf(values);
  const [sub, ...rest] = args.positionals;
  if (values.adopt !== undefined && sub !== "create") throw usage("--adopt belongs to space create");
  if (sub === "delete") {
    const invalid = ADD_FLAGS.find((flag) => flag !== "yes" && values[flag] !== undefined);
    if (invalid) throw usage(`--${invalid} belongs to space add, not delete`);
    return spaceDelete(args);
  }
  if (values["dry-run"] !== undefined) throw usage("--dry-run belongs to space delete");
  if (sub === "add") return spaceAdd(rest, values, presentation);
  const addOnly = ADD_FLAGS.find((flag) => values[flag] !== undefined && !(sub === "create" && flag === "root"));
  if (addOnly) throw usage(addOnly === "yes" ? "--yes is taken by `cotal space add` and `cotal space delete` only" : `--${addOnly} is taken by \`cotal space add\` only`);
  if (sub === "forget") return spaceForget(rest, presentation);
  if (sub === "create") return spaceCreate(rest, values.root, values.adopt === true, presentation);
  if (sub !== undefined && sub !== "show") throw usage(`cotal space has no subcommand "${sub}" - run \`cotal help space\``);
  // Listing and show read the registry before anything else and write nothing, so a record that
  // cannot be read refuses them.
  try { await read(sub, rest, presentation); }
  catch (e) { throw isMeshRegistryError(e) ? registryFailure(e) : e; }
}

async function read(sub: "show" | undefined, rest: string[], presentation: Presentation): Promise<void> {
  if (sub === undefined) {
    const sweep = await pruneStaleMeshes();
    const current = getCurrent() ?? null;
    const offline = new Set(sweep.offline);
    const items = loadMeshes().map((m) => row(m, current, m.origin === "catalog" ? "not-checked" : offline.has(m.space) ? "unreachable" : "reachable"));
    const prepared = loadPreparedSpaces().map((p) => preparedRow(p, current));
    const folder = folderSpaceOverSelection(process.cwd(), current, sweep.offline) ?? null;
    const result: SpacesResult = { kind: "spaces", current, currentRecorded: current === null || items.some((s) => s.current), folder, items, prepared };
    writeResult(presentation, { command: "space", target: null, result, warnings: selectionWarnings(result) }, spacesView);
    return;
  }
  if (sub === "show") {
    if (rest.length > 1) throw usage("usage: cotal space show [<name>]");
    const current = getCurrent() ?? null;
    // With no name it is about this folder: the space it has registered, or the one it holds
    // prepared or stopped, which `show` names even though every other command here targets the
    // selection. Then the selection.
    const registered = rest[0] === undefined ? folderSpace(process.cwd()) : undefined;
    // A folder whose only trace of its space is its own stack journal records no space to show, so
    // `show` falls through to the selection there; the journal's own refusals name that space.
    const held = rest[0] === undefined && registered === undefined ? folderSpaceHeld(process.cwd()) : undefined;
    const recorded = held !== undefined && (findMesh(held.space) ?? findPreparedSpace(held.space)) !== undefined ? held : undefined;
    const folder = registered ?? recorded?.space;
    if (current !== null && recorded !== undefined && recorded.space !== current) noteFolderSpaceShown(recorded.space, recorded.state, current);
    const name = rest[0] ?? folder ?? current;
    if (name === null)
      throw new CommandFailure("refused", "TARGET_NOT_FOUND", "no space is selected", { remedy: "name one with `cotal space show <name>`, or select one with `cotal use <name>`" });
    const m = findMesh(name);
    if (!m) {
      const p = findPreparedSpace(name);
      // No space has the name, so the refusal is not headed with it.
      if (!p) throw new CommandFailure("refused", "TARGET_NOT_FOUND", `no space named "${name}" is registered here`, { target: { requested: name }, remedy: "see the registered spaces with `cotal space`" });
      const result: PreparedDetail = { kind: "prepared-space", ...preparedRow(p, current) };
      writeResult(presentation, { command: "space", target: { space: p.space }, result }, preparedView);
      return;
    }
    const check: Check = m.origin === "catalog" ? "not-checked" : (await brokerAnswers(m.server)) ? "reachable" : "unreachable";
    // The space this folder registered is the target of the commands run here only while it runs,
    // which its broker answering shows.
    if (current !== null && registered !== undefined && registered !== current) {
      if (check === "unreachable") noteFolderSpaceShown(registered, "stopped", current);
      else noteFolderSpace(registered, current);
    }
    writeResult(presentation, { command: "space", target: { space: m.space }, result: detail(m, current, check) }, spaceView);
    return;
  }
}

function preparedRow(p: PreparedSpace, current: string | null): PreparedRow {
  const rootMissing = !existsSync(p.root);
  const lifecycle = rootMissing ? undefined : preparedLifecycle(p.root, p.space);
  return { space: p.space, root: p.root, preparedAt: p.ts, current: p.space === current, rootMissing, state: lifecycle?.state ?? "prepared", lastOperation: lifecycle?.lastOperation ?? null };
}

/** How a prepared space's own root left it, as a cell. */
function lifecycleCell(p: Pick<PreparedRow, "state" | "lastOperation">): Cell {
  if (p.state === "stopped") return { text: `stopped · ${p.lastOperation}`, tone: "waiting" };
  if (p.state === "unsettled") return { text: `last ${p.lastOperation}`, tone: "waiting" };
  return { text: "not started", tone: "waiting" };
}

function row(m: MeshEntry, current: string | null, check: Check): SpaceRow {
  return {
    space: m.space,
    server: m.server,
    mode: m.mode,
    root: m.root,
    origin: m.origin ?? null,
    tlsRequired: m.tlsRequired === true,
    eventsRequired: m.policy?.events === "required",
    modeChecked: m.unchecked !== true,
    current: m.space === current,
    check,
    catalog: m.origin === "catalog" ? { name: m.catalogName && m.catalogName !== m.space ? m.catalogName : null, fetchedAt: m.catalogFetchedAt ?? null, error: m.catalogError ?? null } : null,
  };
}

/** One registration in full, as `space show` reports it. */
export function detail(m: MeshEntry, current: string | null, check: Check): SpaceDetail {
  const base = row(m, current, check);
  return {
    kind: "space",
    ...base,
    recordedAt: m.ts,
    attachHost: m.attachHost ?? null,
    maxSessions: m.maxSessions ?? null,
    storeDir: m.storeDir ?? null,
    unencryptedOverlay: m.unencryptedOverlay === true,
    userAuth: m.userAuth ? { provider: m.userAuth.provider, idp: { ...m.userAuth.idp }, remote: m.userAuth.remote === true } : null,
    catalog: base.catalog ? { ...base.catalog, id: m.catalogId ?? null, slug: m.catalogSlug ?? null, kind: m.catalogKind ?? null, role: m.catalogRole ?? null } : null,
  };
}

/** A selection that names no registration still selects it: the command that targets it refuses
 *  rather than reaching another space. A prepared space is selected, not missing. */
function selectionWarnings(result: SpacesResult): OutputWarning[] {
  if (result.current === null || result.currentRecorded || result.prepared.some((p) => p.current)) return [];
  return [{ code: "SELECTION_NOT_REGISTERED", target: { space: result.current }, message: `the selected space "${result.current}" is not registered here - select another with \`cotal use <name>\`` }];
}

/** A record with no origin was written by `up` before origins were recorded. */
const originText = (origin: SpaceRow["origin"]): string => (origin === "manual" ? "registered" : origin === "catalog" ? "discovered" : "started here");

function checkCell(s: Pick<SpaceRow, "check">): Cell {
  if (s.check === "reachable") return { text: "reachable", tone: "ok", mark: "●" };
  if (s.check === "unreachable") return { text: "unreachable", tone: "waiting", mark: "●" };
  return { text: "not checked", tone: "hint", mark: "○" };
}

const nameCell = (s: Pick<SpaceRow, "space" | "current">, folder: string | null = null): Cell =>
  s.current ? { text: `${s.space} (selected)`, tone: "selected" } : s.space === folder ? { text: `${s.space} (this folder's)`, tone: "selected" } : s.space;

function spacesView(result: SpacesResult): Report {
  // A space that ran and was stopped says so, as `status` does, rather than reading as never started.
  const ran = result.prepared.some((p) => p.state !== "prepared");
  const prepared: Section[] = result.prepared.length === 0 ? [] : [{
    title: ran ? "Prepared spaces" : "Prepared, not started",
    blocks: [
      {
        kind: "table",
        columns: [{ key: "space", label: "Space" }, ...(ran ? [{ key: "state", label: "State" }] : []), { key: "root", label: "Project" }],
        rows: result.prepared.map((p) => ({ space: nameCell(p, result.folder), state: lifecycleCell(p), root: p.rootMissing ? { text: `${p.root} (no longer exists)`, tone: "waiting" } : { text: p.root, tone: "hint" } })),
      },
      // A folder that is gone cannot be started, so its space names the steps `space show` gives.
      { kind: "commands", items: [
        ...(result.prepared.some((p) => !p.rootMissing) ? [{ command: "cotal up", description: "Start a prepared space from its project folder" }] : []),
        ...(result.prepared.some((p) => p.state === "unsettled") ? [{ command: "cotal status", description: "Run in its project folder, it names the step that finishes or settles its last operation" }] : []),
        ...result.prepared.filter((p) => p.rootMissing).map((p) => ({ command: `cotal space forget ${p.space}`, description: `Its folder is gone: forget it, then prepare it again with \`cotal space create ${p.space} --root <dir>\`` })),
      ] },
    ],
  }];
  // A prepared space is listed below, so the empty line names what is missing without denying it.
  if (result.items.length === 0)
    return { sections: [{ title: "Spaces", blocks: [{ kind: "lines", lines: result.prepared.length ? [ran ? "No space is running or registered." : "No space has been started or registered yet."] : ["No spaces registered.", { text: "Prepare a local space or connect to one you already run.", tone: "hint" }] }] }, ...prepared, { title: "Next", blocks: [{ kind: "commands", items: [{ command: "cotal setup", description: "Choose a local or self-hosted space" }, { command: "cotal space add <name> --server <url>", description: "Register an existing broker" }] }] }] };
  return {
    sections: [{
      title: "Spaces",
      blocks: [{
        kind: "table",
        columns: [
          { key: "space", label: "Space" },
          { key: "broker", label: "Connection" },
          { key: "server", label: "Broker" },
          { key: "mode", label: "Access" },
          { key: "origin", label: "Source" },
          { key: "root", label: "Project" },
        ],
        rows: result.items.map((s) => ({
          space: nameCell(s, result.folder),
          broker: checkCell(s),
          server: s.server,
          mode: s.modeChecked ? s.mode : { text: `${s.mode}, not checked`, tone: "waiting" },
          origin: s.catalog?.name ? `${originText(s.origin)} as ${s.catalog.name}` : originText(s.origin),
          root: { text: s.root, tone: "hint" },
        })),
      }],
    }, ...prepared, { title: "Next", blocks: [{ kind: "commands", items: [
      { command: "cotal use <name>", description: "Select the space commands use" },
      { command: "cotal space show <name>", description: "Inspect its connection and project" },
      { command: "cotal space create <name>", description: "Prepare another local space in this folder" },
      { command: "cotal space add <name> --server <url>", description: "Register an existing broker" },
    ] }] }],
  };
}

function preparedView(p: PreparedDetail): Report {
  // A folder that is gone cannot be started; the space is forgotten and prepared again elsewhere.
  const hints: Cell[] = p.rootMissing
    ? [{ text: `prepared in ${p.root}, which no longer exists`, tone: "waiting" }, { text: `forget it with \`cotal space forget ${p.space}\`, then prepare it again with \`cotal space create ${p.space} --root <dir>\``, tone: "hint" }]
    : p.state === "unsettled" ? [{ text: `run \`cotal status\` in ${p.root}, which names the step that finishes or settles it`, tone: "hint" }]
    : [{ text: `start it${p.state === "stopped" ? " again" : ""} with \`cotal up\` in ${p.root}`, tone: "hint" }];
  if (!p.current && !p.rootMissing) hints.push({ text: `select it with \`cotal use ${p.space}\``, tone: "hint" });
  return {
    sections: [{
      blocks: [
        { kind: "fields", rows: [["space", nameCell(p)], ["broker", lifecycleCell(p)], ["root", p.root], ["prepared", p.preparedAt]] },
        { kind: "lines", lines: hints },
      ],
    }],
  };
}

function spaceView(s: SpaceDetail): Report {
  const fields: [string, Cell][] = [
    ["space", nameCell(s)],
    ["broker", checkCell(s)],
    ["server", s.server],
    ["mode", s.modeChecked ? s.mode : { text: `${s.mode}, not checked: added with --force`, tone: "waiting" }],
    ["origin", originText(s.origin)],
    ["root", s.root],
    ["recorded", s.recordedAt],
  ];
  if (s.tlsRequired) fields.push(["tls", "required"]);
  if (s.eventsRequired) fields.push(["events", "required"]);
  if (s.unencryptedOverlay) fields.push(["overlay", { text: "unencrypted, accepted at registration", tone: "waiting" }]);
  if (s.attachHost) fields.push(["attach host", s.attachHost]);
  if (s.maxSessions !== null) fields.push(["max sessions", String(s.maxSessions)]);
  if (s.storeDir) fields.push(["store", s.storeDir]);
  if (s.userAuth) fields.push(["login", `${s.userAuth.idp.url}${s.userAuth.remote ? " (registered from elsewhere)" : ""}`]);
  if (s.catalog) {
    if (s.catalog.name) fields.push(["catalog name", s.catalog.name]);
    if (s.catalog.fetchedAt) fields.push(["catalog fetched", s.catalog.fetchedAt]);
    if (s.catalog.error) fields.push(["catalog error", { text: s.catalog.error, tone: "failed" }]);
  }
  const hints: Cell[] = s.current ? [] : [{ text: `select it with \`cotal use ${s.space}\``, tone: "hint" }];
  if (!s.modeChecked) hints.push({ text: `check its mode by adding it again without --force: \`cotal space forget ${s.space}\`, then \`cotal space add ${s.space} --server ${s.server} --root ${s.root}\``, tone: "hint" });
  return { sections: [{ title: `Space · ${s.space}`, blocks: [{ kind: "fields", rows: fields }, ...(hints.length ? [{ kind: "lines" as const, lines: hints }] : [])] }] };
}

/** Argument completion: the subcommand, then registered names, the modes `--mode` takes, and a path
 *  for `--root` and `--file`. */
export function spaceComplete(argv: string[]): CompletionResult {
  const flag = completingFlagValue(argv, spaceFlags);
  if (flag?.name === "mode") return { items: SPACE_MODES.map((value) => ({ value })), directive: "nofiles" };
  if (flag?.name === "root" || flag?.name === "file") return { items: [], directive: "default" };
  if (argv.length <= 1) return { items: [{ value: "show" }, { value: "add" }, { value: "create" }, { value: "forget" }, { value: "delete" }], directive: "nofiles" };
  if ((argv[0] === "show" || argv[0] === "forget" || argv[0] === "delete") && argv.length === 2)
    return { items: [...loadMeshes().map((m) => ({ value: m.space })), ...loadPreparedSpaces().map((p) => ({ value: p.space }))], directive: "nofiles" };
  return { items: [], directive: "nofiles" };
}
