import { lookup } from "node:dns/promises";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { isIP, SocketAddress } from "node:net";
import { join } from "node:path";
import { oneLine, processStartToken, recordUpdateDeferral, type OutputWarning } from "@cotal-ai/workspace";
import { displayRemedy } from "../lib/self-exec.js";
import { c } from "../ui.js";
import { type CommandResult, RegistryUnavailable, StagingTimeout, parseNpmVersion, failure, message } from "./update-process.js";
import type { UpdateRuntime } from "./update.js";

export const MISSING_NPM_REMEDY = "Install npm or add it to this command's PATH, then retry.";
export const OFFLINE_CHECK_REMEDY = "Disable npm offline mode for this invocation and repeat update --check if you want a live registry check.";
export const REGISTRY_CHECK_REMEDY = "Check registry access and repeat update --check.";

type LatestVersionFailure = { ok: false; error: string; missingNpm?: true; offline?: true; npmResult?: CommandResult };

export function latestVersionCheckWarning(latest: LatestVersionFailure): OutputWarning {
  if (latest.missingNpm) return { code: "NPM_UNAVAILABLE", target: null, message: "npm is not on PATH. Update availability is unknown." };
  if (latest.offline) return { code: "LATEST_VERSION_UNAVAILABLE", target: null, message: "npm is in offline mode. Update availability is unknown." };
  return { code: "LATEST_VERSION_UNAVAILABLE", target: null, message: "The registry did not return a valid latest version. Update availability is unknown." };
}

export function latestVersionCheckRemedy(latest: { ok: true; version: string } | LatestVersionFailure, inventoryReadable: boolean): string {
  if (!latest.ok && latest.missingNpm) return MISSING_NPM_REMEDY;
  if (!latest.ok && latest.offline) {
    return inventoryReadable
      ? OFFLINE_CHECK_REMEDY
      : "Disable npm offline mode for this invocation, check the unreadable inventory, and repeat update --check.";
  }
  if (inventoryReadable) return REGISTRY_CHECK_REMEDY;
  return latest.ok ? "Check the unreadable inventory and repeat update --check." : "Check registry access or the unreadable inventory and repeat update --check.";
}

/** The registry's latest tag, read through a throwaway npm cache with npm's log files and update
 *  notifier off, so the read leaves nothing in npm's own cache, log directory or notifier stamp. */
export function latestVersion(rt: UpdateRuntime): { ok: true; version: string } | LatestVersionFailure {
  const cache = mkdtempSync(join(tmpdir(), "cotal-npm-view-"));
  try {
    const result = rt.npm(["view", "cotal-ai@latest", "version", "--json", "--cache", cache, "--logs-max=0", "--update-notifier=false", "--fetch-retries=0", "--fetch-timeout=15000"]);
    if (result.errorCode === "ENOENT") return { ok: false, error: "npm is not on PATH", missingNpm: true };
    if (result.status !== 0) {
      if (npmOfflineCacheMiss(result)) return { ok: false, error: "npm is in offline mode", offline: true };
      return { ok: false, error: failure(result), npmResult: result };
    }
    try {
      return { ok: true, version: parseNpmVersion(result.stdout) };
    } catch (e) {
      return { ok: false, error: message(e) };
    }
  } finally {
    rmSync(cache, { recursive: true, force: true, maxRetries: 3 });
  }
}

function npmOfflineCacheMiss(result: CommandResult): boolean {
  if (result.status === null || result.error) return false;
  try { return JSON.parse(result.stdout)?.error?.code === "ENOTCACHED"; }
  catch { return false; }
}

export function reportConnectorAccessRestored(rt: UpdateRuntime, permissionsRestored: boolean, offline = false): void {
  if (permissionsRestored) rt.out(`Restored owner access to the Cotal connector configuration${offline ? "; no installed packages were replaced." : "."}`);
}

export async function handleLatestVersionFailure(latest: LatestVersionFailure, current: string, rt: UpdateRuntime, unavailable: string, promotionRecovered: boolean, permissionsRestored = false): Promise<number> {
  if (latest.missingNpm) {
    if (rt.env.COTAL_AUTO_UPDATE === "1") recordUpdateDeferral(current, "waiting for npm availability", true);
    reportConnectorAccessRestored(rt, permissionsRestored);
    rt.err(c.red(`✗ cotal-ai version check failed: ${latest.error}. ${MISSING_NPM_REMEDY}`));
    return 1;
  }
  if (latest.offline) {
    if (rt.env.COTAL_AUTO_UPDATE === "1") recordUpdateDeferral(current, "waiting for npm offline mode to be disabled", true);
    rt.onOfflineVersionCheckSkipped?.();
    if (promotionRecovered) rt.out("Completed an interrupted extension promotion.");
    reportConnectorAccessRestored(rt, permissionsRestored, true);
    rt.out(`${latest.error}. The latest-version check was skipped.`);
    return 0;
  }
  reportConnectorAccessRestored(rt, permissionsRestored);
  if (!latest.npmResult || !(releaseReadError(latest.npmResult, "cotal-ai version check failed") instanceof RegistryUnavailable)) {
    rt.err(c.red(`✗ cotal-ai version check failed: ${oneLine(latest.error.split(/\r?\n/, 1)[0]!)}`));
    return 1;
  }
  if (rt.env.COTAL_AUTO_UPDATE === "1") recordUpdateDeferral(current, "waiting for registry availability", true);
  else {
    const setting = await npmProxyRefusal(latest.npmResult, rt);
    if (setting === "environment") {
      rt.err("The npm proxy refused the connection (ECONNREFUSED). The update did not start. Check HTTP_PROXY and HTTPS_PROXY, then retry.");
      return 1;
    }
    if (setting) {
      rt.out(`The npm proxy refused the connection (ECONNREFUSED). No installed packages were replaced. Check \`${setting}\` in your npm configuration, then retry.`);
      return 0;
    }
  }
  rt.out(unavailable);
  return 0;
}

/** npm gives a generic proxy hint even for direct failures. Match the refused socket instead. */
async function npmProxyRefusal(result: CommandResult, rt: UpdateRuntime): Promise<"environment" | "https-proxy" | "proxy" | undefined> {
  if (result.status === null || result.error) return;
  let error: { code?: unknown; summary?: unknown } | undefined;
  try { error = JSON.parse(result.stdout)?.error; }
  catch { return; }
  if (error?.code !== "ECONNREFUSED" || typeof error.summary !== "string") return;
  const refused = /^(?:FetchError: )?request to (\S+) failed, reason: connect ECONNREFUSED (\S+):(\d+)$/.exec(error.summary);
  if (!refused) return;
  const [, request, address, port] = refused;
  const registry = URL.parse(request);
  if (!registry || (registry.protocol !== "https:" && registry.protocol !== "http:") || !isIP(address)) return;

  const portOf = (url: URL) => url.port || (url.protocol === "https:" ? "443" : "80");
  const normalize = (ip: string) => isIP(ip) === 6 ? new SocketAddress({ address: ip, family: "ipv6" }).address : ip;
  const matches = async (url: URL) => {
    const host = url.hostname.replace(/^\[|\]$/g, "");
    const addresses = isIP(host) ? [host] : (await lookup(host, { all: true })).map(item => item.address);
    return addresses.some(ip => normalize(ip) === normalize(address));
  };
  const confirmsProxy = async (setting: string | undefined) => {
    const proxy = setting ? URL.parse(setting) : null;
    if (!proxy || (proxy.protocol !== "http:" && proxy.protocol !== "https:") || portOf(proxy) !== port) return false;
    try {
      // If the registry could have refused the same socket directly, do not blame the proxy.
      return await matches(proxy) && (portOf(registry) !== port || !await matches(registry));
    } catch { return false; }
  };
  const { https_proxy, HTTPS_PROXY, http_proxy, HTTP_PROXY } = rt.env;
  if (await confirmsProxy(https_proxy || HTTPS_PROXY || (registry.protocol === "http:" ? http_proxy || HTTP_PROXY : undefined))) return "environment";

  // npm resolves config precedence and redacts the password in its text listing. Its JSON listing
  // omits authenticated proxy URLs, and commented-out settings are not effective.
  const config = rt.npm(["config", "list", "--json=false", "--long", "--logs-max=0", "--update-notifier=false"]);
  if (config.status !== 0 || config.error) return;
  for (const key of ["https-proxy", "proxy"] as const) {
    const value = new RegExp(`^${key} = ("[^\\r\\n]*")$`, "m").exec(config.stdout)?.[1];
    if (!value) continue;
    try { if (await confirmsProxy(JSON.parse(value))) return key; }
    catch { return; }
    return;
  }
}

/** Resolve installed first-party surfaces in a disposable prefix, including their npm dependencies. */
function checkInstalledClosure(version: string, releasePackages: ReadonlySet<string>, rt: UpdateRuntime): void {
  const names = [...new Set(rt.extensions().filter(entry => entry.pkg.startsWith("@cotal-ai/")).map(entry => entry.pkg))];
  if (!names.length) return;
  const staging = mkdtempSync(join(tmpdir(), "cotal-closure-check-"));
  try {
    // Reconciliation supplies first-party peers from the target CLI, not the registry's latest tag.
    // Constrain npm to that verified release graph without skipping third-party peers.
    writeFileSync(join(staging, "package.json"), JSON.stringify({
      overrides: Object.fromEntries([...releasePackages, ...names].map(name => [name, version])),
    }));
    const specs = names.map(name => `${name}@${version}`);
    const result = rt.npm(["install", "--prefix", staging, "--cache", join(staging, ".npm-cache"), "--json", "--logs-max=0", "--update-notifier=false", "--ignore-scripts", "--package-lock=false", "--no-audit", "--no-fund", "--fetch-retries=2", "--fetch-retry-mintimeout=1000", "--fetch-retry-maxtimeout=2000", "--fetch-timeout=15000", "--prefer-online", ...specs]);
    if (result.signal) throw new DependencyCheckInterrupted(`npm dependency check was terminated by ${result.signal}`);
    if (result.status !== 0) {
      const detail = `installed extension dependency closure is unavailable: ${failure(result.stderr.trim() ? { ...result, stdout: "" } : result)}`;
      if (/^npm (?:error|ERR!) code ENOSPC\s*$/m.test(result.stderr)) throw new DependencyCheckNoSpace(detail);
      throw releaseReadError(result, detail, { installedSpecs: specs });
    }
  } finally {
    rmSync(staging, { recursive: true, force: true, maxRetries: 3 });
  }
}

/** Fetch the target's first-party install closure through npm, including integrity verification.
 *  A private cache forces a registry read without changing the installed packages or running scripts. */
export async function checkReleaseArchives(version: string, rt: UpdateRuntime): Promise<ReadonlySet<string>> {
  const cache = mkdtempSync(join(tmpdir(), "cotal-release-check-"));
  const options = ["--cache", cache, "--logs-max=0", "--update-notifier=false", "--fetch-retries=2", "--fetch-retry-mintimeout=1000", "--fetch-retry-maxtimeout=2000", "--fetch-timeout=15000", "--prefer-online"];
  const pending = new Set(["cotal-ai"]);
  const names = ["cotal-ai"];
  try {
    if (process.platform === "linux" || process.platform === "darwin") {
      const start = processStartToken(process.pid);
      if (!start) throw new Error("cannot identify the archive cache owner");
      writeFileSync(join(cache, ".owner"), `${process.pid}\n${start}\n`, { mode: 0o600, flag: "wx" });
    }
    for (let offset = 0; offset < names.length;) {
      const batch = names.slice(offset, offset + 3);
      // Settle every read before validating or removing its shared private cache. Validation below
      // stays in discovery order, including when independent registry requests finish out of order.
      const manifests = await Promise.allSettled(batch.map(name => rt.npmAsync(["view", `${name}@${version}`, "--json", ...options], cache)));
      offset += batch.length;
      for (const [index, name] of batch.entries()) {
        const spec = `${name}@${version}`;
        const result = manifests[index]!;
        if (result.status === "rejected") throw new Error(`metadata for ${spec} is unavailable`);
        const manifest = result.value;
        if (manifest.status !== 0) throw releaseReadError(manifest, `metadata for ${spec} is unavailable`, { metadataSpec: spec });
        let meta: Record<string, unknown>;
        try {
          const payload: unknown = JSON.parse(manifest.stdout);
          const parsed = Array.isArray(payload) && payload.length === 1 ? payload[0] : payload;
          if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error();
          meta = parsed as Record<string, unknown>;
          if (meta.name !== name || meta.version !== version) throw new Error();
          const dist = meta.dist as { tarball?: unknown; integrity?: unknown } | undefined;
          if (typeof dist?.tarball !== "string" || !dist.tarball || typeof dist.integrity !== "string" || !dist.integrity) throw new Error();
        } catch {
          throw new Error(`metadata for ${spec} is incomplete or invalid`);
        }
        for (const field of ["dependencies", "optionalDependencies", "peerDependencies"] as const) {
          const deps = meta[field];
          if (deps === undefined) continue;
          if (!deps || typeof deps !== "object" || Array.isArray(deps)) throw new Error(`invalid ${field} for ${spec}`);
          for (const [dependency, range] of Object.entries(deps)) {
            if (!dependency.startsWith("@cotal-ai/")) continue;
            if (!/^@cotal-ai\/[a-z0-9][a-z0-9._-]*$/.test(dependency) || typeof range !== "string" ||
                (field !== "peerDependencies" && range !== version)) throw new Error(`invalid first-party dependency in ${spec}`);
            if (!pending.has(dependency)) { pending.add(dependency); names.push(dependency); }
          }
        }
      }
    }
    // npm verifies each archive's integrity and applies registry, scoped auth and proxy/TLS policy.
    // Its cache add accepts multiple specs. Bound each group rather than starting npm per archive.
    for (let offset = 0; offset < names.length; offset += 6) {
      const specs = names.slice(offset, offset + 6).map(name => `${name}@${version}`);
      const archive = await rt.npmAsync(["cache", "add", ...specs, "--json", "--ignore-scripts", ...options], cache);
      if (archive.status !== 0) throw releaseReadError(archive, `archives for ${specs.join(", ")} could not be downloaded and verified`);
    }
    return pending;
  } finally {
    rmSync(cache, { recursive: true, force: true, maxRetries: 3 });
  }
}

export class ReleaseNotAvailable extends Error {
  constructor(message: string, readonly scopedMetadataMissing = false) { super(message); }
}
export class ReleaseDateExcluded extends Error {}
export class DependencyCheckInterrupted extends Error {}
export class DependencyCheckNoSpace extends Error {}

const NETWORK_ERROR_CODE = /^(?:ENETUNREACH|EHOSTUNREACH|ENETDOWN|EHOSTDOWN|ECONNRESET|ECONNREFUSED|ECONNABORTED|ETIMEDOUT|EIDLETIMEOUT|ESOCKETTIMEDOUT|EAI_AGAIN|ENOTFOUND)$/;

export function registryNetworkFailure(error: unknown): boolean {
  if (error instanceof RegistryUnavailable) return true;
  const detail = error instanceof StagingTimeout ? error.npmOutput : message(error);
  const code = /(?:^|\n|^target staging failed: )npm (?:error|ERR!) code ([A-Z_]+)(?:\s|$)/.exec(detail)?.[1];
  return code !== undefined && NETWORK_ERROR_CODE.test(code);
}

export function offlineUpdateMessage(repaired: boolean): string {
  return repaired ? "The registry cannot be reached; no installed packages were replaced." : "The registry cannot be reached; nothing was changed.";
}

export function deferStagingFailure(error: unknown, version: string, rt: UpdateRuntime, repaired: boolean): boolean {
  const detail = message(error);
  const fetchTimedOut = /^target staging failed: npm (?:error|ERR!) code FETCH_ERROR\r?\n/.test(detail) &&
    /^npm (?:error|ERR!) network timeout at: \S/m.test(detail);
  if (fetchTimedOut || (error instanceof RegistryUnavailable || error instanceof StagingTimeout || detail.startsWith("target staging failed: ")) && registryNetworkFailure(error)) {
    recordUpdateDeferral(version, "waiting for registry access", true);
    rt.out(fetchTimedOut
      ? displayRemedy("The registry fetch timed out during package staging. The previous version remains installed. Run `cotal update --self` again when the registry responds.")
      : offlineUpdateMessage(repaired));
  } else if (error instanceof StagingTimeout) {
    recordUpdateDeferral(version, error.message, true);
    rt.out(displayRemedy(`${error.message}. The previous version remains installed. Run \`cotal update --self\` again.`));
  } else return false;
  return true;
}

export function releaseReadError(result: CommandResult, detail: string, { installedSpecs, metadataSpec }: { installedSpecs?: readonly string[]; metadataSpec?: string } = {}): Error {
  if (result.status !== null && !result.error) {
    try {
      const error = (JSON.parse(result.stdout) as { error?: { code?: unknown; summary?: unknown; detail?: unknown } }).error;
      if (error?.code === "ETARGET" && [error.summary, error.detail].some(text => typeof text === "string" && /with a date before\b/i.test(text)))
        return new ReleaseDateExcluded(`${detail}: npm's min-release-age or before setting excludes this release. Adjust that date filter and run \`cotal update --self\` again`);
      // A first-party scoped read can fail while the public registry still answers.
      if (!detail.includes("@cotal-ai/") && typeof error?.code === "string" && NETWORK_ERROR_CODE.test(error.code)) return new RegistryUnavailable(detail);
      if (error?.code === "E404" || error?.code === "ETARGET") {
        if (error.code === "E404" && metadataSpec?.startsWith("@cotal-ai/")) {
          const request = typeof error.summary === "string" ? /\bGET (https?:\/\/\S+) - /.exec(error.summary)?.[1] : undefined;
          // Use only the origin so npm diagnostics cannot expose credentials or URL tokens.
          const origin = request ? URL.parse(request)?.origin : undefined;
          const registryDetail = `${metadataSpec} was not found (npm E404${origin ? ` from ${origin}` : ""}). Check @cotal-ai:registry in .npmrc`;
          return new ReleaseNotAvailable(registryDetail, true);
        }
        if (!installedSpecs) return new ReleaseNotAvailable(detail);
        // A scoped registry 404 or a missing third-party dependency does not prove release lag.
        const missing = error.code === "ETARGET" && installedSpecs.find(spec => error.summary === `No matching version found for ${spec}.`);
        return missing ? new ReleaseNotAvailable(`${missing} is not yet available in the registry`) : new Error(detail);
      }
      if (!installedSpecs && typeof error?.code === "string" && /^[A-Z][A-Z0-9_]{0,39}$/.test(error.code)) {
        const registry = detail.includes("@cotal-ai/") ? "the @cotal-ai:registry setting in .npmrc" : "your npm registry settings";
        return new Error(`${detail} (npm ${error.code}${error.code === "ECONNREFUSED" ? ": registry connection refused" : ""}); check ${registry}, authentication, proxy and TLS configuration`);
      }
    } catch { /* An unstructured failure is not evidence of registry propagation. */ }
  }
  return registryNetworkFailure(new Error(failure(result))) ? new RegistryUnavailable(detail) : new Error(detail);
}

export async function waitForReleasePreflight(version: string, current: string, rt: UpdateRuntime, prepareExtensions: () => boolean): Promise<"ready" | "deferred" | "refused"> {
  const now = rt.now ?? Date.now;
  const deadline = now() + 10 * 60_000;
  rt.out(`Checking cotal-ai@${version} release archives`);
  let releasePackages: ReadonlySet<string> | undefined;
  for (;;) {
    try {
      if (!releasePackages) {
        releasePackages = await checkReleaseArchives(version, rt);
        if (!prepareExtensions()) return "refused";
        rt.out(`Checking installed extension dependencies for ${version}`);
      }
      checkInstalledClosure(version, releasePackages, rt);
      return "ready";
    } catch (error) {
      if (!(error instanceof ReleaseNotAvailable)) throw error;
      const remaining = deadline - now();
      if (remaining <= 0) {
        if (releasePackages) throw error;
        recordUpdateDeferral(version, "waiting for registry or extension closure availability", true);
        const reason = error.scopedMetadataMissing ? `cotal-ai@${version} release archives are still unavailable. ${error.message}.` : `cotal-ai@${version} is still reaching the registry.`;
        rt.out(`${reason} Keeping cotal-ai@${current}; no global install was attempted. A later update check will try again.`);
        return "deferred";
      }
      const pending = releasePackages ? `an installed extension: ${error.message}`
        : `cotal-ai@${version} release archives${error.scopedMetadataMissing ? `: ${error.message}` : " to reach the registry"}`;
      rt.out(`Waiting for ${pending} (${Math.ceil(remaining / 1000)} s remaining); cotal-ai@${current} stays installed.`);
      await (rt.sleep ?? (milliseconds => new Promise(resolveSleep => setTimeout(resolveSleep, milliseconds))))(Math.min(15_000, remaining));
    }
  }
}
