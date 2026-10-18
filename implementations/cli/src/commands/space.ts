import type { CompletionResult, FlagSpec, FlagValues, ParsedArgs } from "@cotal-ai/core";
import {
  CommandFailure,
  brokerAnswers,
  findMesh,
  getCurrent,
  jsonFlag,
  loadMeshes,
  plainFlag,
  presentationOf,
  pruneStaleMeshes,
  writeResult,
  type Cell,
  type MeshEntry,
  type OutputWarning,
  type Report,
} from "@cotal-ai/workspace";
import { ADD_FLAGS, spaceAdd, spaceForget } from "./space-registration.js";

export const spaceFlags = [
  jsonFlag,
  plainFlag,
  { name: "server", type: "string", value: "<url>", description: "add: the space's broker URL" },
  { name: "root", type: "string", value: "<dir>", description: "add: the folder whose .cotal/auth holds the space's trust (default: this project)" },
  { name: "mode", type: "string", value: "<auth|open|user>", description: "add: how the broker authenticates (default: auth when --root holds the space's trust, else open)" },
  { name: "file", short: "f", type: "string", value: "<bundle.json>", description: "add: a user-auth connection bundle exported where the space runs" },
  { name: "from", type: "string", value: "<https url>", description: "add: fetch the space's discovery document; its pins are shown and confirmed" },
  { name: "tls", type: "boolean", description: "add: require TLS on every connection to the space (a tls:// or wss:// --server implies it)" },
  { name: "allow-unencrypted-overlay", type: "boolean", description: "add: accept that an overlay address is protected only while its tunnel is up" },
  { name: "force", type: "boolean", description: "add: replace a registration added by hand, and add a --server space without checking its broker" },
  { name: "yes", short: "y", type: "boolean", description: "add: skip the confirmation on a terminal; fetched pins are still confirmed" },
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
  readonly items: readonly SpaceRow[];
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
 * not answer leaves its registration in place, reported `unreachable`. `space add` and
 * `space forget` change the registry (see `space-registration.ts`).
 */
export async function space(args: ParsedArgs): Promise<void> {
  const values = args.values as FlagValues<typeof spaceFlags>;
  const presentation = presentationOf(values);
  const [sub, ...rest] = args.positionals;
  if (sub === "add") return spaceAdd(rest, values, presentation);
  const addOnly = ADD_FLAGS.find((flag) => values[flag] !== undefined);
  if (addOnly) throw usage(`--${addOnly} is taken by \`cotal space add\` only`);
  if (sub === "forget") return spaceForget(rest, presentation);
  if (sub === undefined) {
    const sweep = await pruneStaleMeshes();
    const current = getCurrent() ?? null;
    const offline = new Set(sweep.offline);
    const items = loadMeshes().map((m) => row(m, current, m.origin === "catalog" ? "not-checked" : offline.has(m.space) ? "unreachable" : "reachable"));
    const result: SpacesResult = { kind: "spaces", current, currentRecorded: current === null || items.some((s) => s.current), items };
    writeResult(presentation, { command: "space", target: null, result, warnings: selectionWarnings(result) }, spacesView);
    return;
  }
  if (sub === "show") {
    if (rest.length > 1) throw usage("usage: cotal space show [<name>]");
    const current = getCurrent() ?? null;
    const name = rest[0] ?? current;
    if (name === null)
      throw new CommandFailure("refused", "TARGET_NOT_FOUND", "no space is selected", { remedy: "name one with `cotal space show <name>`, or select one with `cotal use <name>`" });
    const m = findMesh(name);
    if (!m) throw new CommandFailure("refused", "TARGET_NOT_FOUND", `no space named "${name}" is registered here`, { remedy: "see the registered spaces with `cotal space`" });
    const check: Check = m.origin === "catalog" ? "not-checked" : (await brokerAnswers(m.server)) ? "reachable" : "unreachable";
    writeResult(presentation, { command: "space", target: { space: m.space }, result: detail(m, current, check) }, spaceView);
    return;
  }
  throw usage(`cotal space has no subcommand "${sub}" - run \`cotal help space\``);
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
 *  rather than reaching another space. */
function selectionWarnings(result: SpacesResult): OutputWarning[] {
  if (result.current === null || result.currentRecorded) return [];
  return [{ code: "SELECTION_NOT_REGISTERED", target: { space: result.current }, message: `the selected space "${result.current}" is not registered here - select another with \`cotal use <name>\`` }];
}

/** A record with no origin was written by `up` before origins were recorded. */
const originText = (origin: SpaceRow["origin"]): string => (origin === "manual" ? "registered" : origin === "catalog" ? "discovered" : "started here");

function checkCell(s: Pick<SpaceRow, "check">): Cell {
  if (s.check === "reachable") return { text: "reachable", tone: "ok" };
  if (s.check === "unreachable") return { text: "unreachable", tone: "waiting" };
  return { text: "not checked", tone: "hint" };
}

const nameCell = (s: Pick<SpaceRow, "space" | "current">): Cell => (s.current ? { text: `${s.space} (selected)`, tone: "selected" } : s.space);

function spacesView(result: SpacesResult): Report {
  if (result.items.length === 0)
    return { sections: [{ blocks: [{ kind: "lines", lines: [{ text: "no spaces registered - `cotal up` starts one here, `cotal meshes add <space> --server <url>` registers one running elsewhere", tone: "hint" }] }] }] };
  return {
    sections: [{
      blocks: [{
        kind: "table",
        columns: [
          { key: "space", label: "SPACE" },
          { key: "broker", label: "BROKER" },
          { key: "server", label: "SERVER" },
          { key: "mode", label: "MODE" },
          { key: "origin", label: "ORIGIN" },
          { key: "root", label: "ROOT" },
        ],
        rows: result.items.map((s) => ({
          space: nameCell(s),
          broker: checkCell(s),
          server: s.server,
          mode: s.mode,
          origin: s.catalog?.name ? `${originText(s.origin)} as ${s.catalog.name}` : originText(s.origin),
          root: { text: s.root, tone: "hint" },
        })),
      }],
    }],
  };
}

function spaceView(s: SpaceDetail): Report {
  const fields: [string, Cell][] = [
    ["space", nameCell(s)],
    ["broker", checkCell(s)],
    ["server", s.server],
    ["mode", s.mode],
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
  return { sections: [{ blocks: [{ kind: "fields", rows: fields }, ...(hints.length ? [{ kind: "lines" as const, lines: hints }] : [])] }] };
}

/** Argument completion: the subcommand, then registered names. */
export function spaceComplete(argv: string[]): CompletionResult {
  if (argv.length <= 1) return { items: [{ value: "show" }, { value: "add" }, { value: "forget" }], directive: "nofiles" };
  if ((argv[0] === "show" || argv[0] === "forget") && argv.length === 2) return { items: loadMeshes().map((m) => ({ value: m.space })), directive: "nofiles" };
  return { items: [], directive: "nofiles" };
}
