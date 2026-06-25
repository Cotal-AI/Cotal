import { CotalEndpoint } from "@cotal-ai/core";
import { c } from "../ui.js";
import { connectOrExit } from "./connect.js";

/**
 * A one-shot, write-capable connection for the headless commands that touch the live mesh
 * (`dm`/`msg`/`ask`, and `personas list --running`). Resolution + creds + reachability all go through
 * the shared `connectOrExit` (so these work from any directory, and an explicit `--creds` is a raw
 * off-registry connection). Opens a transient endpoint that never joins the roster, does the one
 * thing, stops.
 */

export interface ConnectValues {
  space?: string;
  server?: string;
  creds?: string;
}

/** Resolve where to connect + with what credentials (`--creds` → raw off-registry; else the running
 *  mesh's minted manager creds). Fail-loud — an unresolved registry or an unreachable/auth-mismatched
 *  broker exits with one sentence, never degrades. */
export async function resolveConnect(
  values: ConnectValues,
): Promise<{ server: string; space: string; creds?: string }> {
  const { server, space, creds } = await connectOrExit(values, "manager");
  return { server, space, creds };
}

/** Open a transient endpoint: it watches presence (so name→id resolution and the live roster work)
 *  but never registers itself, binds no inbox, and consumes no channels. The caller stops it. */
export async function openTransient(
  values: ConnectValues,
  name: string,
): Promise<{ ep: CotalEndpoint; space: string }> {
  const { server, space, creds } = await resolveConnect(values);
  const ep = new CotalEndpoint({
    space,
    servers: server,
    creds,
    channels: [],
    consume: false,
    registerPresence: false,
    watchPresence: true,
    card: { name, kind: "endpoint" },
  });
  ep.on("error", (e: Error) => console.error(c.red("! " + e.message)));
  await ep.start();
  return { ep, space };
}
