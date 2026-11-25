import { catalogChoiceRefusal, readModelCatalog, rejectionText, type Connector, type LaunchModes, type LaunchOpts } from "@cotal-ai/core";
import { CommandFailure, parseLaunchModes } from "@cotal-ai/workspace";

/** The modes a spawn in this terminal launches with, refused when the connector takes none. */
export function launchModes(connector: Connector, flags: string[] | undefined, target: { space: string; path: string }): LaunchModes | undefined {
  const modes = parseLaunchModes(flags);
  if (modes && !connector.supportsModes)
    throw new CommandFailure("refused", "USAGE_INVALID", `${connector.name} connector does not support modes (modes)`, { target, remedy: "omit `--mode`" });
  return modes;
}

/** Check a spawn in this terminal before anything is provisioned: the connector's own launch check,
 *  then the model catalog for a variant or modes. The catalog is read from the harness, so the harness
 *  runs only for a choice the connector takes. A managed handoff's manager checked the catalog before
 *  handing the launch off, so `managerChecked` skips that read. */
export async function checkLaunch(connector: Connector, launch: LaunchOpts, managerChecked: boolean, target: { space: string; path: string }): Promise<void> {
  try {
    if (connector.supportsLaunchValidation) connector.buildLaunch({ ...launch, validateOnly: true });
  } catch (error) {
    throw new CommandFailure("refused", "USAGE_INVALID", rejectionText(error), { target });
  }
  if (managerChecked) return;
  const choice = { model: launch.model, variant: launch.variant, modes: launch.modes };
  const refusal = await catalogChoiceRefusal(connector, choice, () => readModelCatalog(connector, { resolvedBinaries: launch.resolvedBinaries, ...(launch.envAllow ? { envAllow: launch.envAllow } : {}) }));
  if (refusal) throw new CommandFailure("refused", "USAGE_INVALID", refusal, { target, remedy: `\`cotal models -H ${connector.name}\` lists what each model takes` });
}
