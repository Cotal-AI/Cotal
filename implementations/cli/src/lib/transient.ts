import { CotalEndpoint } from "@cotal-ai/core";
import { endpointAuth, type Connection } from "@cotal-ai/workspace";
import { c } from "../ui.js";
import { connectOrExit } from "./connect.js";

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

export interface TransientCaller {
  name: string;
  owner: string;
  actor: string;
}

function callerFromEnv(env: NodeJS.ProcessEnv): TransientCaller | undefined {
  const name = env.COTAL_NAME?.trim();
  const owner = env.COTAL_OWNER?.trim();
  const actor = env.COTAL_ACTOR?.trim();
  const id = env.COTAL_ID?.trim();
  if (!name) return undefined;
  if (owner && actor) return { name, owner, actor };
  if (id) return { name, owner: "local", actor: id };
  return undefined;
}

/** Complete seat identity from THIS process's environment. A name without an id is not enough, and
 * ancestor environments are not walked: inherited `/proc` identity would make a stripped child still
 * send as its parent seat. */
export function transientCaller(env: NodeJS.ProcessEnv = process.env): TransientCaller | undefined {
  return callerFromEnv(env);
}

/** Resolve where to connect + with what credentials (`--creds` → raw off-registry; user-auth mesh →
 *  login/bearer material; else the running mesh's minted least-privilege OPERATOR creds — self-scoped
 *  publish + presence/channel read, no broad manager). Fail-loud — an unresolved registry or an
 *  unreachable/auth-mismatched broker exits with one sentence, never degrades. */
export async function resolveConnect(values: ConnectValues): Promise<Connection> {
  return connectOrExit(values, "operator");
}

/** Open a transient endpoint: it watches presence (so name→id resolution and the live roster work)
 *  but never registers itself, binds no inbox, and consumes no channels. The caller stops it. */
export async function openTransient(
  values: ConnectValues,
  caller: string | TransientCaller,
): Promise<{ ep: CotalEndpoint; space: string }> {
  const name = typeof caller === "string" ? caller : caller.name;
  const conn = await resolveConnect(values);
  const ep = new CotalEndpoint({
    space: conn.space,
    servers: conn.server,
    ...endpointAuth(conn),
    channels: [],
    consume: false,
    registerPresence: false,
    watchPresence: true,
    // Display name only. Owner+actor on this card would disagree with a user-mode bearer
    // and with the operator cred mint, so admission stays in transientCaller and the wire
    // principal stays the connection's.
    card: { name, kind: "endpoint" },
  });
  ep.on("error", (e: Error) => console.error(c.red("! " + e.message)));
  ep.on("warning", (e: Error) => console.error(c.yellow("! " + e.message)));
  await ep.start();
  return { ep, space: conn.space };
}
