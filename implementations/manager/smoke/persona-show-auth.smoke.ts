/**
 * Manager-entry regression for persona show authorization (#402).
 *
 * Drives the real `managerServiceDefs()` show-persona handler in process, with no broker. The
 * authenticated subject context is constructed, while the command definition, admission gate,
 * persona path resolution, parser, authorization projection, and envelope mapping are shipped code.
 *
 * An unparseable file has no trustworthy owner. The mesh read path must therefore treat it like an
 * unknown or unauthorized name instead of returning parser diagnostics that reveal its existence.
 *
 * Run: pnpm smoke:manager-persona-show-auth
 */
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DEV_OWNER,
  EpEnvelopeError,
  saveAgentFile,
  type EpCommandDef,
  type EpServeContext,
} from "@cotal-ai/core";
import { Manager } from "../src/manager.js";
import { MANAGER_CONTRACTS, managerClusterDocument } from "../src/manager-service-contract.js";

let failures = 0;
const check = (label: string, ok: boolean, extra?: unknown): void => {
  console.log(`${ok ? "ok" : "not ok"} - ${label}${ok ? "" : `: ${JSON.stringify(extra)}`}`);
  if (!ok) failures++;
};

const root = mkdtempSync(join(tmpdir(), "cotal-manager-persona-show-"));
const agentsDir = join(root, ".cotal", "agents");
mkdirSync(agentsDir, { recursive: true });
saveAgentFile(join(agentsDir, "mine.md"), {
  name: "mine",
  owner: `${DEV_OWNER}.alice`,
  subscribe: [],
  persona: "Owned prompt.",
});
writeFileSync(join(agentsDir, "broken-foreign.md"), "not a persona file\nforeign raw marker\n");

const manager = new Manager({ space: "persona-show-auth", runtime: "pty", workspaceRoot: root });
const defs = (manager as unknown as { managerServiceDefs(): EpCommandDef[] }).managerServiceDefs();
const show = defs.find((d) => d.command === "show-persona");
if (!show) throw new Error("fixture: show-persona handler missing from manager service definitions");

const context = (name: string): EpServeContext => ({
  identity: { endpoint: "manager", instanceId: "persona-show-auth-manager", epoch: 1 },
  subject: {
    plane: "request",
    route: "one",
    endpoint: "manager",
    command: "show-persona",
    target: null,
    caller: {
      owner: DEV_OWNER,
      actor: "alice",
      uid: "00112233445566778899aabbccddeeff",
    },
    nonce: "ffeeddccbbaa99887766554433221100",
  },
  request: {
    v: 1,
    id: "ffeeddccbbaa99887766554433221100",
    args: { name },
  } as unknown as EpServeContext["request"],
});

const owned = await show.handler(context("mine")) as { name?: string; persona?: string };
check(
  "CONTROL: the real manager show handler returns an owned parseable persona",
  owned.name === "mine" && owned.persona === "Owned prompt.",
  owned,
);

let refusal: unknown;
try {
  await show.handler(context("broken-foreign"));
} catch (error) {
  refusal = error;
}
check(
  "a foreign caller showing an ownerless broken persona gets not-found, never parser diagnostics",
  refusal instanceof EpEnvelopeError
    && refusal.code === "not-found"
    && refusal.message === 'no persona "broken-foreign"'
    && !refusal.message.includes("frontmatter")
    && !refusal.message.includes(agentsDir),
  refusal instanceof Error ? { name: refusal.name, message: refusal.message } : refusal,
);

const shipped = managerClusterDocument();
const compiledCount = Object.keys(MANAGER_CONTRACTS).length;
check(
  "shipped command count matches the compiled contract table",
  shipped.commands.length === compiledCount,
  { compiled: compiledCount, document: shipped.commands.length },
);
check(
  "persona catalog list/show are in the shipped document",
  shipped.commands.some((c) => c.name === "list-personas") && shipped.commands.some((c) => c.name === "show-persona"),
  shipped.commands.map((c) => c.name),
);

console.log(`\nMANAGER PERSONA SHOW AUTH ${failures === 0 ? "OK" : "FAILED"}`);
process.exit(failures === 0 ? 0 : 1);
