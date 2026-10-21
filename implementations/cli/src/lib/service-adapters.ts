import { registry } from "@cotal-ai/core";
import { CommandFailure, claimExtensionMutationLockAsync, extensionLocalProcesses, loadExtensionsManifest, serviceAdapterDeclaration, serviceMetadataDigest, validateServiceAdapterOptions, validateServiceAdapterPaths, verifiedExtensionServiceProcesses, type LocalProcess, type ServiceAdapterContext, type ServiceAdapterDeclaration, type ServiceAdapterLaunch, type ServiceAdapterReadiness, type ServiceAdapterHooks } from "@cotal-ai/workspace";
import { installedExtensionsEnabled, materializeExtension } from "../ext-loader.js";
import { cliVersion } from "./version.js";

export interface ServiceAdapterPin {
  name: string;
  package: string | null;
  version: string;
  declarationSha256: string;
}
export interface ResolvedServiceAdapter { pin: ServiceAdapterPin; declaration: ServiceAdapterDeclaration }
export interface LoadedServiceAdapter extends ResolvedServiceAdapter {
  prepareStop?: ServiceAdapterHooks["prepareServiceStop"];
  stop?: ServiceAdapterHooks["stopService"];
  prepareKernelStop?: ServiceAdapterHooks["prepareKernelStop"];
  observeKernelStop?: ServiceAdapterHooks["observeKernelStop"];
  build: (context: ServiceAdapterContext) => ServiceAdapterLaunch | Promise<ServiceAdapterLaunch>;
  readiness: (context: ServiceAdapterContext & { process: { pid: number; token: string }; signal: AbortSignal }) => Promise<ServiceAdapterReadiness>;
}

/** Resolve only cached data during add, previews and semantic validation. Executable hooks are
 *  materialized separately, under the ordinary version-locked extension import path. */
export function resolveServiceAdapter(name: string, options: Readonly<Record<string, unknown>>, checkOptions = true): ResolvedServiceAdapter {
  const registered = registry.all<LocalProcess>("local-process").find((component) => component.name === name);
  const owners = installedExtensionsEnabled() ? loadExtensionsManifest().extensions.filter((extension) => extensionLocalProcesses(extension).some((component) => component.name === name)) : [];
  if (owners.length > 1) throw new CommandFailure("refused", "CONFLICT", "several installed packages claim this service adapter; no provider was chosen");
  const owner = owners[0];
  const cached = owner ? verifiedExtensionServiceProcesses(owner).find((component) => component.name === name) : registered;
  if (!cached?.service) throw new CommandFailure("refused", "DEPENDENCY_UNAVAILABLE", "no installed local-process provider declares this service adapter; install or update its extension explicitly before adding or starting the definition");
  if (owner?.pkg.startsWith("@cotal-ai/") && owner.version !== cliVersion()) throw new CommandFailure("refused", "CONFLICT", "the first-party service adapter and this CLI have different versions; run cotal update before use");
  const declaration = serviceAdapterDeclaration(JSON.parse(JSON.stringify(cached.service)));
  if (checkOptions) { validateServiceAdapterOptions(declaration, options); validateServiceAdapterPaths(declaration, options); }
  const pin = { name, package: owner?.pkg ?? null, version: owner?.version ?? cliVersion(), declarationSha256: serviceMetadataDigest(declaration) };
  if (registered && (!registered.service || serviceMetadataDigest(serviceAdapterDeclaration(registered.service)) !== pin.declarationSha256)) throw new CommandFailure("refused", "CONFLICT", "the loaded service provider disagrees with its cached declaration; no changed schema was silently adopted");
  return { pin, declaration };
}

export function sameServiceAdapterPin(a: ServiceAdapterPin | undefined, b: ServiceAdapterPin | undefined): boolean {
  return a === undefined ? b === undefined : b !== undefined && a.name === b.name && a.package === b.package && a.version === b.version && a.declarationSha256 === b.declarationSha256;
}

/** Call only after an explicitly authorized operation has reserved its definition and launch. */
export async function loadServiceAdapter(expected: ResolvedServiceAdapter, options: Readonly<Record<string, unknown>>): Promise<LoadedServiceAdapter> {
  const current = resolveServiceAdapter(expected.pin.name, options);
  if (!sameServiceAdapterPin(current.pin, expected.pin)) throw new CommandFailure("refused", "CONFLICT", "the service adapter declaration changed before its explicit action; no different provider was substituted");
  const provider = await materializeExtension<LocalProcess>({ kind: "local-process", name: expected.pin.name });
  // The controller has already published a starting intent. Uninstall scans those intents while
  // holding this same writer lock. Even a registered-provider short circuit cannot cross a remove
  // that scanned before our intent was written: recheck after that remover releases the lock.
  const release = expected.pin.package === null ? undefined : await claimExtensionMutationLockAsync({ waitMs: 0, label: "service adapter launch validation" });
  try {
    const after = resolveServiceAdapter(expected.pin.name, options);
    if (!sameServiceAdapterPin(after.pin, expected.pin) || typeof provider.buildServiceLaunch !== "function" || typeof provider.checkServiceReadiness !== "function") throw new CommandFailure("refused", "CONFLICT", "the service adapter's live declaration or hooks do not match its reviewed metadata");
    if (current.declaration.stop === "native" && (typeof provider.prepareServiceStop !== "function" || typeof provider.stopService !== "function")) throw new CommandFailure("refused", "UNSUPPORTED", "the native stop declaration has no matching impact and terminal hooks; generic signals were not substituted");
    if (current.declaration.stop === "kernel-exit" && (typeof provider.prepareKernelStop !== "function" || typeof provider.observeKernelStop !== "function")) throw new CommandFailure("refused", "UNSUPPORTED", "the kernel-exit stop declaration has no matching scope and exit-observation hooks; generic signals were not substituted");
    return { ...current, build: provider.buildServiceLaunch.bind(provider), readiness: provider.checkServiceReadiness.bind(provider), ...(current.declaration.stop === "native" ? { prepareStop: provider.prepareServiceStop!.bind(provider), stop: provider.stopService!.bind(provider) } : {}), ...(current.declaration.stop === "kernel-exit" ? { prepareKernelStop: provider.prepareKernelStop!.bind(provider), observeKernelStop: provider.observeKernelStop!.bind(provider) } : {}) };
  } finally { release?.(); }
}
