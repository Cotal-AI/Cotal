import { catalogChoiceRefusal, readModelCatalog, type Connector, type LaunchModes } from "@cotal-ai/core";
import { CommandFailure, parseLaunchModes } from "@cotal-ai/workspace";

/** The modes a spawn in this terminal launches with, once the connector and its model catalog take
 *  them and the variant. With no manager keeping the catalog, it is read from the harness, and only
 *  when the launch chose a variant or modes. A managed handoff's manager checked both before handing
 *  the launch off, so `managerChecked` skips the read. */
export async function launchModes(
  connector: Connector,
  flags: string[] | undefined,
  choice: { model?: string; variant?: string },
  managerChecked: boolean,
  target: { space: string; path: string },
): Promise<LaunchModes | undefined> {
  const modes = parseLaunchModes(flags);
  if (modes && !connector.supportsModes)
    throw new CommandFailure("refused", "USAGE_INVALID", `${connector.name} connector does not support modes (modes)`, { target, remedy: "omit `--mode`" });
  if (managerChecked) return modes;
  const refusal = await catalogChoiceRefusal(connector, { ...choice, modes }, () => readModelCatalog(connector, {}));
  if (refusal) throw new CommandFailure("refused", "USAGE_INVALID", refusal, { target, remedy: `\`cotal models -H ${connector.name}\` lists what each model takes` });
  return modes;
}
