import { CotalEndpoint } from "@cotal-ai/core";
import { endpointAuth, type Connection } from "@cotal-ai/workspace";
import { readFileSync } from "node:fs";
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

function linuxProcess(pid: number): { parentPid: number; env: NodeJS.ProcessEnv } | undefined {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    const after = stat.lastIndexOf(") ");
    if (after < 0) return undefined;
    const fields = stat.slice(after + 2).trim().split(/\s+/u);
    const parentPid = Number(fields[1]);
    if (!Number.isInteger(parentPid) || parentPid < 0) return undefined;
    const env = Object.fromEntries(
      readFileSync(`/proc/${pid}/environ`, "utf8")
        .split("\0")
        .filter(Boolean)
        .map((entry) => {
          const eq = entry.indexOf("=");
          return eq < 0 ? [entry, ""] : [entry.slice(0, eq), entry.slice(eq + 1)];
        }),
    );
    return { parentPid, env };
  } catch {
    return undefined;
  }
}

/** The nearest complete seat identity in this process tree. One process must carry the whole tuple;
 * fields from different ancestors are never combined into a principal nobody launched. */
export function transientCaller(env: NodeJS.ProcessEnv = process.env): TransientCaller | undefined {
  const direct = callerFromEnv(env);
  if (direct) return direct;
  if (process.platform !== "linux") return undefined;
  let pid = process.ppid;
  const seen = new Set<number>();
  while (pid > 1 && !seen.has(pid)) {
    seen.add(pid);
    const processInfo = linuxProcess(pid);
    if (!processInfo) return undefined;
    const caller = callerFromEnv(processInfo.env);
    if (caller) return caller;
    pid = processInfo.parentPid;
  }
  return undefined;
}

/** Resolve where to connect + with what credentials (`--creds` → raw off-registry; user-auth mesh →
 *  login/bearer material; else the running mesh's minted least-privilege OPERATOR creds — self-scoped
 *  publish + presence/channel read, no broad manager). Fail-loud — an unresolved registry or an
 *  unreachable/auth-mismatched broker exits with one sentence, never degrades. */
export async function resolveConnect(values: ConnectValues, caller?: TransientCaller): Promise<Connection> {
  return connectOrExit(values, "operator", caller ? { principal: caller } : undefined);
}

/** Open a transient endpoint: it watches presence (so name→id resolution and the live roster work)
 *  but never registers itself, binds no inbox, and consumes no channels. The caller stops it. */
export async function openTransient(
  values: ConnectValues,
  caller: string | TransientCaller,
): Promise<{ ep: CotalEndpoint; space: string }> {
  const identity = typeof caller === "string" ? undefined : caller;
  const conn = await resolveConnect(values, identity);
  const ep = new CotalEndpoint({
    space: conn.space,
    servers: conn.server,
    ...endpointAuth(conn),
    channels: [],
    consume: false,
    registerPresence: false,
    watchPresence: true,
    card: {
      name: typeof caller === "string" ? caller : caller.name,
      kind: "endpoint",
      ...(identity ? { owner: identity.owner, actor: identity.actor } : {}),
    },
  });
  ep.on("error", (e: Error) => console.error(c.red("! " + e.message)));
  ep.on("warning", (e: Error) => console.error(c.yellow("! " + e.message)));
  await ep.start();
  return { ep, space: conn.space };
}
