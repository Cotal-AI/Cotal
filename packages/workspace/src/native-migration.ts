import { checkBundleDocument, type UserBundle } from "./registration-policy.js";

export interface NativeMigrationPins { url: string; issuer: string; audience: string }
export interface NativeMigrationEndorsement { version: 1; origin: string }
export interface NativeMigrationResolution {
  bundle: UserBundle;
  /** Complete canonical document, including metadata the bundle validator does not retain. */
  raw: Record<string, unknown>;
  oldRootPins: NativeMigrationPins;
  endorsement: NativeMigrationEndorsement;
}

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("native migration requires a JSON object");
  return value as Record<string, unknown>;
}

function httpsUrl(value: string): URL {
  const url = new URL(value);
  if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash || value.includes("?") || value.includes("#"))
    throw new Error("native migration requires HTTPS URLs without credentials, query or fragment");
  return url;
}

/** Fetch public discovery only. The deadline covers headers and decoded body consumption. */
async function documentAt(origin: string, fetchDocument: typeof fetch): Promise<Record<string, unknown>> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  const deadline = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(new Error("native migration discovery exceeded its 5s deadline"));
    }, 5_000);
  });
  try {
    return await Promise.race([deadline, (async () => {
      const response = await fetchDocument(`${origin}/.well-known/cotal-mesh`, {
        redirect: "manual", credentials: "omit", signal: controller.signal,
      });
      if (response.status >= 300 && response.status < 400 || response.redirected)
        throw new Error("native migration discovery redirects are refused");
      if (!response.ok) throw new Error(`native migration discovery answered HTTP ${response.status}`);
      if (!response.body) throw new Error("native migration discovery has no body");
      reader = response.body.getReader();
      const chunks: Uint8Array[] = [];
      let size = 0;
      for (;;) {
        const next = await reader.read();
        if (next.done) break;
        size += next.value.byteLength;
        if (size > 65_536) throw new Error("native migration discovery exceeds 64 KiB decoded body limit");
        chunks.push(next.value);
      }
      const bytes = new Uint8Array(size);
      let offset = 0;
      for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
      return object(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)));
    })()]);
  } finally {
    clearTimeout(timer);
    controller.abort();
    if (reader) void reader.cancel().catch(() => {});
  }
}

/** Resolve a migration endorsed by the old issuer's public root, without tokens or state writes.
 * The optional fetch adapter is for synthetic tests. Production uses real HTTPS fetch. */
export async function resolveNativeMigration(
  oldIdpPins: NativeMigrationPins,
  fetchDocument: typeof fetch = fetch,
): Promise<NativeMigrationResolution> {
  for (const pin of [oldIdpPins.url, oldIdpPins.issuer, oldIdpPins.audience])
    if (typeof pin !== "string" || !pin) throw new Error("native migration requires complete old IdP pins");
  httpsUrl(oldIdpPins.url);
  const oldOrigin = httpsUrl(oldIdpPins.issuer).origin;
  const oldRoot = await documentAt(oldOrigin, fetchDocument);
  const pins = object(object(oldRoot.userAuth).idp);
  if (pins.url !== oldIdpPins.url || pins.issuer !== oldIdpPins.issuer || pins.audience !== oldIdpPins.audience)
    throw new Error("native migration old root IdP pins do not match trusted pins");
  const migration = object(oldRoot.nativeMigration);
  if (migration.version !== 1 || typeof migration.origin !== "string")
    throw new Error("native migration endorsement requires version 1 and origin");
  const canonicalOrigin = httpsUrl(migration.origin).origin;
  if (migration.origin !== canonicalOrigin || canonicalOrigin === oldOrigin)
    throw new Error("native migration endorsement must name a different canonical HTTPS origin only");
  const raw = await documentAt(canonicalOrigin, fetchDocument);
  const checked = checkBundleDocument(raw);
  if (!checked.ok) throw new Error(`native migration canonical bundle: ${checked.message}`);
  const bundle = checked.value;
  if (httpsUrl(bundle.userAuth.idp.url).origin !== canonicalOrigin ||
      bundle.userAuth.idp.issuer !== oldIdpPins.issuer || bundle.userAuth.idp.audience !== oldIdpPins.audience)
    throw new Error("native migration canonical IdP pins do not match endorsement and trusted issuer/audience");
  // Inspect raw endpoints too: validation omits optional empty strings, which must not hide a bad URL.
  for (const endpoint of Object.values(object(object(raw.userAuth).endpoints))) {
    if (typeof endpoint !== "string" || httpsUrl(endpoint).origin !== canonicalOrigin)
      throw new Error("native migration canonical endpoint must use the endorsed HTTPS origin");
  }
  return { bundle, raw, oldRootPins: { ...oldIdpPins }, endorsement: { version: 1, origin: canonicalOrigin } };
}
