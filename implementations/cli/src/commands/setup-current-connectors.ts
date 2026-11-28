import { existsSync } from "node:fs";
import { join } from "node:path";
import type { ConnectorSetupProvider } from "@cotal-ai/core";
import { homeCotalDir, resolveOnPath } from "@cotal-ai/workspace";
import { extensionNames, materializeExtension } from "../ext-loader.js";
import { selfArgv } from "../lib/self-exec.js";
import { reportUncheckedPreparedRecords } from "./update-continuity.js";
import type { UpdateRuntime } from "./update.js";

/** A current CLI can leave first-use connector setup to the command that needs it. */
export async function reportWithoutConnectorReconciliation(version: string, rt: UpdateRuntime, target: Record<string, unknown>, recovering: boolean): Promise<boolean> {
  if (rt.isCurrent?.()) {
    reportUncheckedPreparedRecords(rt, target);
    await reportCurrentConnectorState(version, rt);
    return true;
  }
  if (!recovering && rt.env.COTAL_AUTO_UPDATE !== "1" && !["space", "server", "creds", "on"].some(key => typeof target[key] === "string") && rt.canDeferConnectorBootstrap?.()) {
    reportUncheckedPreparedRecords(rt, target);
    rt.out("No newer CLI version. Built-in connectors are set up by the first command that needs them.");
    return true;
  }
  return false;
}

/** A manual same-version update can repair a moved marketplace without running package reconciliation. */
async function reportCurrentConnectorState(version: string, rt: {
  env: NodeJS.ProcessEnv; out: (line: string) => void; err: (line: string) => void;
}): Promise<void> {
  const current = "No newer CLI version; installed package closure is current.";
  const home = homeCotalDir();
  if (rt.env.COTAL_AUTO_UPDATE !== "1" && existsSync(join(home, "codex-plugin")) && resolveOnPath("codex")) {
    try {
      if (extensionNames("connector-setup").includes("codex")) {
        const provider = await materializeExtension<ConnectorSetupProvider>({ kind: "connector-setup", name: "codex" });
        const missing = provider.status?.({ version, skillsRemedy: "run `cotal update`" }).some((row) =>
          row.state === "error" && /^- `cotal-mesh` at .+: marketplace root does not contain a supported manifest$/m.test(row.text));
        if (missing && provider.refresh) {
          const detail = await provider.refresh.run({ cotal: selfArgv() });
          rt.out(current);
          rt.out(`${provider.refresh.title}: ${detail}`);
          return;
        }
      }
    } catch (error) {
      rt.out(current);
      rt.err(`Codex integration repair could not finish: ${error instanceof Error ? error.message : String(error)}`);
      return;
    }
  }
  rt.out(`${current} No connector reconciliation was run.`);
}
