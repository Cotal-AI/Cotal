import { CotalEndpoint } from "@cotal-ai/core";
import { endpointAuth, type Connection } from "@cotal-ai/workspace";
import { c } from "../ui.js";
import { connectOrExit, connectOrThrow } from "./connect.js";

/**
 * A one-shot, write-capable connection for the headless commands that touch the live mesh
 * (`dm`/`msg`/`ask`, and `personas list --running`). Resolution + creds + reachability all go through
 * the shared `connectOrExit` (so these work from any directory, and an explicit `--creds` is a raw
 * off-registry connection). Opens a transient endpoint that never joins the roster, does the one
 * thing, stops. USER-mode meshes ride the same call: `connectOrExit` hands back bearer + sentinel
 * and {@link endpointAuth} spreads whichever material arrived.
 */

export interface ConnectValues {
  space?: string;
  server?: string;
  creds?: string;
}

/** Resolve where to connect + with what credentials (`--creds` → raw off-registry; user-auth mesh →
 *  login/bearer material; else the running mesh's minted least-privilege OPERATOR creds — self-scoped
 *  publish + presence/channel read, no broad manager). Fail-loud — an unresolved registry or an
 *  unreachable/auth-mismatched broker exits with one sentence, never degrades. */
export async function resolveConnect(values: ConnectValues): Promise<Connection> {
  return connectOrExit(values, "operator");
}

/** Open a transient endpoint: it holds the roster and channel registry on return but never registers
 *  itself, binds no inbox, and consumes no channels. The caller stops it. Static and open credentials
 *  read both buckets once, leaving no watch consumer behind. A user bearer has no batched Direct Get
 *  row, so it watches them and waits for the presence replay; its consumer lasts until the broker's
 *  inactive threshold. `throwOnRefusal` hands connection refusals to the command kernel, and `report`
 *  takes endpoint errors and warnings instead of printing them. */
export async function openTransient(
  values: ConnectValues,
  name: string,
  opts: { throwOnRefusal?: boolean; report?: (level: "error" | "warning", e: Error) => void } = {},
): Promise<{ ep: CotalEndpoint; space: string; connection: Connection }> {
  const conn = opts.throwOnRefusal ? await connectOrThrow(values, "operator") : await resolveConnect(values);
  const readOnce = conn.bearer === undefined;
  const ep = new CotalEndpoint({
    space: conn.space,
    servers: conn.server,
    ...endpointAuth(conn),
    channels: [],
    consume: false,
    registerPresence: false,
    watchPresence: true,
    readOnce,
    // Display name only. The wire principal comes from the resolved static credential or user
    // bearer; on an open mesh the endpoint self-mints it. Process environment never supplies
    // authority for an operator command.
    card: { name, kind: "endpoint" },
  });
  const report = opts.report ?? ((level, e) => console.error(level === "error" ? c.red("! " + e.message) : c.yellow("! " + e.message)));
  ep.on("error", (e: Error) => report("error", e));
  ep.on("warning", (e: Error) => report("warning", e));
  try {
    await ep.start();
    if (!readOnce) await ep.waitForPresenceSnapshot();
  } catch (e) {
    await ep.stop().catch(() => {});
    throw e;
  }
  return { ep, space: conn.space, connection: conn };
}
