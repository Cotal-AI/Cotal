import { Registry, stagePlugin, type Command, type Connector, type Extension, type PluginHost } from "@cotal-ai/core";
import { cacheCommand, cacheConnector, cacheExtension, cacheLocalProcess, type InstalledExtension } from "./extensions.js";
import type { LocalProcess } from "./local-process.js";
import { cacheServicePreset, type ServicePreset } from "./service-preset.js";

/** The declarative part of a plugin's package.json. */
export interface PluginDeclaration extends Pick<InstalledExtension, "commands" | "connectors" | "localProcesses" | "servicePresets"> {
  readonly contract: 1;
  readonly core?: string;
  readonly provides: NonNullable<InstalledExtension["provides"]>;
}

const pluginKinds = new Set(["command", "connector", "connector-setup", "client-setup", "runtime", "local-process", "service-preset"]);

function checkServiceHooks(component: LocalProcess): void {
  if (component.service === undefined) return;
  if (typeof component.buildServiceLaunch !== "function" || typeof component.checkServiceReadiness !== "function")
    throw new Error("a service adapter must provide both declared launch and readiness hooks");
  if (component.service.stop === "native" && (typeof component.prepareServiceStop !== "function" || typeof component.stopService !== "function"))
    throw new Error("a native stop adapter must provide both impact and terminal hooks");
  if (component.service.stop === "kernel-exit" && (typeof component.prepareKernelStop !== "function" || typeof component.observeKernelStop !== "function"))
    throw new Error("a kernel exit adapter must provide both prepare and observe hooks");
}

/** Shape staged registrations without executing a factory a second time. */
export function pluginDeclaration(staged: readonly Extension[], coreVersion?: string): PluginDeclaration {
  const commands: NonNullable<PluginDeclaration["commands"]>[number][] = [];
  const connectors: NonNullable<PluginDeclaration["connectors"]>[number][] = [];
  const localProcesses: LocalProcess[] = [], servicePresets: ServicePreset[] = [];
  for (const entry of staged) {
    if (!pluginKinds.has(entry.kind)) throw new Error(`a plugin cannot provide ${entry.kind}`);
    switch (entry.kind) {
      case "command": commands.push(cacheCommand(entry as Command)); break;
      case "connector": connectors.push(cacheConnector(entry as Connector)); break;
      case "local-process": {
        const component = entry as LocalProcess;
        checkServiceHooks(component);
        localProcesses.push(cacheLocalProcess(component));
        break;
      }
      case "service-preset": servicePresets.push(cacheServicePreset(entry as ServicePreset)); break;
    }
  }
  return {
    contract: 1,
    ...(coreVersion === undefined ? {} : { core: coreVersion }),
    provides: staged.map((entry) => ({ ...cacheExtension(entry), aliases: [...(entry.aliases ?? [])] })),
    commands, connectors, localProcesses, servicePresets,
  };
}

/** Run the same private factory stage used at load, for a package build. */
export async function pluginManifest(factory: (host: PluginHost) => unknown, options: { coreVersion?: string } = {}): Promise<PluginDeclaration> {
  return pluginDeclaration(await stagePlugin(new Registry(), factory), options.coreVersion);
}
