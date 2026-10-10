import { TenkiSandbox, TemplateRuntimeFailedError, WaitReadyFailedError, type CreateOptions } from "@tenkicloud/sandbox";
import {
  registry,
  type EnvironmentObservation,
  type EnvironmentProvisionDriver,
  type EnvironmentProvisionExtension,
  type EnvironmentProvisionProfile,
  type HostedEnvironmentReference,
} from "@cotal-ai/core";

export interface TenkiProfileOptions {
  allowDomains: string[];
  pauseRetentionMs: number;
  secretPolicies?: string[];
  /** Non-secret values and unresolved request-substitution placeholders. */
  env?: Record<string, string>;
  /** Only agent/workload-scoped credentials may be materialized in the guest. */
  secretFiles?: { path: string; secret: string }[];
}

function object(value: unknown, keys: readonly string[], label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).some((key) => !keys.includes(key)))
    throw new Error(`invalid ${label}`);
  return value as Record<string, unknown>;
}

function integer(value: unknown, min: number, max: number, label: string): void {
  if (!Number.isSafeInteger(value) || (value as number) < min || (value as number) > max)
    throw new Error(`invalid ${label}`);
}

function strings(value: unknown, max: number, pattern: RegExp, label: string): asserts value is string[] {
  if (!Array.isArray(value) || value.length > max || value.some((s) => typeof s !== "string" || !pattern.test(s)))
    throw new Error(`invalid ${label}`);
}

/** Narrow, closed configuration: no sticky sessions, inbound ports, raw setup secrets or implicit
 * unrestricted egress. An empty domain list disables outbound traffic. */
export function tenkiCreateOptions(profile: EnvironmentProvisionProfile, operationId: string): CreateOptions {
  if (profile.provider !== "tenki" || !/^[a-zA-Z0-9][a-zA-Z0-9._/-]*@sha256:[a-f0-9]{64}$/.test(profile.image))
    throw new Error("Tenki requires an immutable image digest reference");
  if (!/^[a-f0-9]{64}$/.test(operationId)) throw new Error("invalid environment operation id");
  integer(profile.resources.cpus, 1, 128, "cpu count");
  integer(profile.resources.memoryMiB, 128, 524288, "memory limit");
  if (profile.resources.memoryMiB % 2) throw new Error("memory must be even MiB");
  integer(profile.resources.diskGiB, 5, 100, "disk limit");
  integer(profile.maxDurationMs, 60_000, 86_400_000, "maximum duration");
  const opts = object(profile.providerOptions, ["allowDomains", "pauseRetentionMs", "secretPolicies", "env", "secretFiles"], "Tenki profile options");
  strings(opts.allowDomains, 256, /^(?:\*\.)?(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/, "egress domains");
  integer(opts.pauseRetentionMs, 60_000, 86_400_000, "pause retention");
  const policies = opts.secretPolicies ?? [];
  strings(policies, 64, /^[A-Za-z0-9_-]{1,128}$/, "secret policies");
  const env = opts.env ?? {};
  if (!env || typeof env !== "object" || Array.isArray(env) || Object.keys(env).length > 64 ||
    Object.entries(env).some(([k, v]) => !/^[A-Z_][A-Z0-9_]{0,127}$/.test(k) || typeof v !== "string" || v.length > 4096 || v.includes("\0")))
    throw new Error("invalid environment values");
  if (Object.keys(env).some((k) => /^(?:TENKI_|AWS_|GOOGLE_APPLICATION_CREDENTIALS$|SSH_AUTH_SOCK$)/.test(k)))
    throw new Error("provider credentials must stay outside the guest");
  const files = opts.secretFiles ?? [];
  if (!Array.isArray(files) || files.length > 32) throw new Error("invalid secret files");
  const paths = new Set<string>();
  const secretFiles = files.map((file) => {
    const f = object(file, ["path", "secret"], "secret file");
    if (typeof f.path !== "string" || f.path.length > 1024 || !/^\/(?:home\/tenki|workspace|app)\/(?:[A-Za-z0-9_.-]+\/)*[A-Za-z0-9_.-]+$/.test(f.path) ||
      f.path.split("/").some((part) => part === "." || part === "..") || paths.has(f.path) ||
      typeof f.secret !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(f.secret)) throw new Error("invalid secret file reference");
    paths.add(f.path);
    return { path: f.path, raw: { name: f.secret } };
  });
  return {
    name: `cotal-${operationId.slice(0, 58)}`,
    image: profile.image,
    cpuCores: profile.resources.cpus,
    memoryMb: profile.resources.memoryMiB,
    diskSizeGb: profile.resources.diskGiB,
    maxDurationMs: profile.maxDurationMs,
    pauseRetentionMs: opts.pauseRetentionMs as number,
    sticky: false,
    allowInbound: false,
    allowOutbound: opts.allowDomains.length > 0,
    allowDomains: [...opts.allowDomains],
    secretPolicies: [...policies],
    env: { ...(env as Record<string, string>) },
    secretFiles,
    tags: ["cotal-environment"],
    metadata: { cotalOperation: operationId },
    waitReady: false,
    waitForRuntime: false,
  };
}

export function tenkiObservation(id: string, state: string): EnvironmentObservation {
  const states: Record<string, EnvironmentObservation["state"]> = {
    CREATING: "creating", RUNNING: "running", PAUSED: "paused", TERMINATING: "terminating", TERMINATED: "terminated",
  };
  return { environment: { kind: "tenki", id }, state: states[state] ?? "unknown", observedAt: Date.now() };
}

/** Opening a driver never reads ambient credentials; the host supplies its own confined key. */
export function openTenki(options: { apiKey: string; timeoutMs: number }): EnvironmentProvisionDriver {
  object(options, ["apiKey", "timeoutMs"], "Tenki client options");
  if (typeof options.apiKey !== "string" || !options.apiKey.trim() || /\s/.test(options.apiKey)) throw new Error("a Tenki API key is required");
  integer(options.timeoutMs, 1000, 120_000, "provider request timeout");
  const client = new TenkiSandbox({ apiKey: options.apiKey, timeoutMs: options.timeoutMs, warningHandler: null });
  const idOf = (ref: HostedEnvironmentReference): string => {
    if (ref.kind !== "tenki" || !/^[a-f0-9-]{36}$/.test(ref.id)) throw new Error("invalid Tenki reference");
    return ref.id;
  };
  return {
    name: "tenki",
    validate: (profile) => { tenkiCreateOptions(profile, "0".repeat(64)); },
    async create(profile, operationId) {
      let id: string;
      try {
        id = (await client.create(tenkiCreateOptions(profile, operationId))).id;
      } catch (error) {
        if (error instanceof TemplateRuntimeFailedError || error instanceof WaitReadyFailedError) id = error.session.id;
        else throw new Error("Tenki create outcome is unknown; do not repeat it");
      }
      const ref = { kind: "tenki", id };
      idOf(ref);
      return ref;
    },
    async inspect(ref) {
      const id = idOf(ref);
      try {
        const session = await client.get(id);
        if (session.id !== id) throw new Error("provider reference mismatch");
        return tenkiObservation(id, session.state);
      } catch { throw new Error("Tenki observation unavailable; termination is unproven"); }
    },
    async destroy(ref) {
      const id = idOf(ref);
      try {
        const session = await client.get(id);
        if (session.id !== id) throw new Error("provider reference mismatch");
        if (session.state !== "TERMINATED" && session.state !== "TERMINATING") await session.close();
      } catch { throw new Error("Tenki destruction unconfirmed; inspect the recorded reference"); }
    },
    close: () => client.close(),
  };
}

const extension: EnvironmentProvisionExtension = {
  kind: "environment-provider",
  name: "tenki",
  open: (options) => openTenki(options as { apiKey: string; timeoutMs: number }),
};
registry.register(extension);
