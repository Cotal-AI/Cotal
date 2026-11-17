import { isIP } from "node:net";
import type { UserAuthInfo } from "./mesh-registry.js";

export const DISCOVERY_LOGIN_TIMEOUT_MS = 5_000;
export const DISCOVERY_LOGIN_MAX_BYTES = 65_536;
const WELL_KNOWN = "/.well-known/cotal-mesh";

/** A canonical DNS name supplied by the operator, never a URL or an IP literal. */
export function isDiscoveryName(value: string): boolean {
  if (value.length > 253 || isIP(value)) return false;
  if (!value.split(".").every((label) => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label))) return false;
  try { return new URL(`https://${value}`).hostname === value && !isIP(new URL(`https://${value}`).hostname); }
  catch { return false; }
}

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("discovery document must contain objects");
  return value as Record<string, unknown>;
}

function pins(document: unknown): UserAuthInfo["idp"] {
  const idp = object(object(object(document).userAuth).idp);
  for (const key of ["url", "issuer", "audience"] as const) {
    if (typeof idp[key] !== "string" || !idp[key].trim()) throw new Error(`discovery document requires userAuth.idp.${key}`);
  }
  for (const key of ["url", "issuer"] as const) {
    const value = idp[key] as string;
    const url = new URL(value);
    if (value !== value.trim() || url.protocol !== "https:" || url.username || url.password || value.includes("?") || value.includes("#"))
      throw new Error(`discovery userAuth.idp.${key} must be HTTPS without credentials, query or fragment`);
  }
  return { url: idp.url as string, issuer: idp.issuer as string, audience: idp.audience as string };
}

/** Resolve login pins without persisting the name or starting authentication.
 * Each credential-free document has a five-second deadline and a 64 KiB decoded body limit.
 * The optional fetch seam is for transport fixtures. Production callers use the default fetch.
 */
export async function resolveDiscoveryLogin(name: string, options: { fetch?: typeof fetch } = {}): Promise<UserAuthInfo["idp"]> {
  if (!isDiscoveryName(name)) throw new Error("discovery name must be a canonical lowercase DNS hostname without a scheme, port, path, IP or trailing dot");
  const fetcher = options.fetch ?? globalThis.fetch;
  async function document(url: string): Promise<unknown> {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        controller.abort();
        reject(new Error(`discovery at ${url} exceeded ${DISCOVERY_LOGIN_TIMEOUT_MS}ms`));
      }, DISCOVERY_LOGIN_TIMEOUT_MS);
    });
    const work = async (): Promise<unknown> => {
      const response = await fetcher(url, { redirect: "manual", signal: controller.signal });
      try {
        if (response.redirected || !response.ok) throw new Error(`discovery at ${url} refused HTTP ${response.status} or redirect`);
        if (!response.body) throw new Error(`discovery at ${url} has no body`);
        const reader = response.body.getReader();
        const chunks: Uint8Array[] = [];
        let bytes = 0;
        try {
          for (;;) {
            const part = await reader.read();
            if (part.done) break;
            bytes += part.value.byteLength;
            if (bytes > DISCOVERY_LOGIN_MAX_BYTES) throw new Error(`discovery at ${url} exceeds ${DISCOVERY_LOGIN_MAX_BYTES} decoded bytes`);
            chunks.push(part.value);
          }
        } finally {
          void reader.cancel().catch(() => {});
          reader.releaseLock();
        }
        return JSON.parse(Buffer.concat(chunks, bytes).toString("utf8")) as unknown;
      } finally { controller.abort(); }
    };
    try { return await Promise.race([work(), timeout]); }
    finally { clearTimeout(timer); controller.abort(); }
  }
  const alias = pins(await document(`https://${name}${WELL_KNOWN}`));
  const issuer = new URL(alias.issuer);
  const root = await document(`${issuer.origin}${WELL_KNOWN}`);
  const approved = pins(root);
  if (alias.issuer !== approved.issuer || alias.audience !== approved.audience)
    throw new Error(`discovery name ${name} and issuer ${issuer.origin} have different IdP pins`);
  if (name !== issuer.hostname) {
    const names = object(root).discoveryNames;
    if (!Array.isArray(names) || !names.every((value) => typeof value === "string" && isDiscoveryName(value)) || !names.includes(name))
      throw new Error(`issuer ${issuer.origin} does not authorize discovery name ${name}`);
  }
  if (new URL(alias.url).origin !== `https://${name}` && alias.url !== approved.url)
    throw new Error(`discovery name ${name} IdP URL must be on its own origin or match issuer ${issuer.origin} IdP URL`);
  return alias;
}
