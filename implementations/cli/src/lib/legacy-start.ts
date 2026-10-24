/** How a stopped legacy root last ran, read from its own files. A legacy `down` drops the
 *  registration that kept the root's broker address, and `clean all` also removes the broker
 *  configuration a start rendered there, so a bare `up` would otherwise start on the default
 *  address, in static auth, under the folder's default space. */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { DEFAULT_SERVER } from "@cotal-ai/core";
import { retainedLegacyBroker, rootHoldsAccount, spaceFromKey, spaceKey } from "@cotal-ai/workspace";
import { listFreshTeamSummaries } from "./team-fresh.js";

/** The line an open broker configuration names its space on, by its {@link spaceKey}. */
const OPEN_SPACE_LINE = /^# space key: ([0-9a-f]+)$/m;

/** An open broker configuration that names `space`. An open root holds no account to name it, and
 *  `down` drops its registration, so this line in `server-open.conf` names it for the next `up`. */
export function namedOpenConfig(config: string, space: string): string {
  return `${config}# space key: ${spaceKey(space)}\n`;
}

/** After `clean all` removed a root's identity and broker configuration, the newest fresh team
 *  summary still names the manifest it was deployed from. Returns the command that deploys it again
 *  when a bare `up` (`open` asks for the open mode, `space` is the folder's space) would start
 *  another address, mode or space instead, else undefined. */
export function cleanedManifestStart(root: string, space: string, open: boolean): { command: string; space: string; server: string; mode: "open" | "auth" } | undefined {
  if (rootHoldsAccount(root) || existsSync(join(root, ".cotal", "server-open.conf"))) return undefined;
  let summaries: ReturnType<typeof listFreshTeamSummaries>["valid"];
  try { summaries = listFreshTeamSummaries(root).valid; } catch { return undefined; }
  const last = summaries.filter((summary) => summary.authMode !== "user").sort((a, b) => a.recordedAt.localeCompare(b.recordedAt)).at(-1);
  if (!last) return undefined;
  const mode = last.authMode === "open" ? "open" : "auth";
  if (last.server === DEFAULT_SERVER && last.space === space && (mode === "open") === open) return undefined;
  return { command: existsSync(last.manifestPath) ? `cotal up -f ${last.manifestPath}` : `cotal up --space ${last.space}${mode === "open" ? " --open" : ""} --server ${last.server}`, space: last.space, server: last.server, mode };
}

/** The space a stopped open legacy root last ran. An open root holds no account, so once `down`
 *  dropped its registration the broker configuration its last start rendered names the space. A
 *  configuration from a release that wrote no such line leaves the newest open fresh team summary,
 *  while that configuration still serves the summary's address. */
export function retainedOpenSpace(root: string): string | undefined {
  const retained = retainedLegacyBroker(root);
  if (!retained?.open) return undefined;
  let key: string | undefined;
  try { key = OPEN_SPACE_LINE.exec(readFileSync(join(root, ".cotal", "server-open.conf"), "utf8"))?.[1]; } catch { return undefined; }
  if (key !== undefined) return spaceFromKey(key);
  let summaries: ReturnType<typeof listFreshTeamSummaries>["valid"];
  try { summaries = listFreshTeamSummaries(root).valid; } catch { return undefined; }
  const last = summaries.filter((summary) => summary.authMode === "open").sort((a, b) => a.recordedAt.localeCompare(b.recordedAt)).at(-1);
  return last?.server === retained.server ? last.space : undefined;
}
