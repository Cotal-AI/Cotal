import { isCredentialTransportUrl } from "@cotal-ai/core/loopback";

/** The shared IdP base-URL verdict. Callers own their diagnostics and normalization. */
export type IdpUrlCheck =
  | { ok: true; url: URL }
  | { ok: false; reason: "invalid-url" | "scheme" | "query-or-fragment" }
  | { ok: false; reason: "credentials"; host: string };

/** Parse an IdP base URL without network or state access. HTTP is allowed only on a loopback
 *  literal; userinfo, query and fragment are refused before a caller can normalize them away. */
export function checkIdpUrl(value: string): IdpUrlCheck {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return { ok: false, reason: "invalid-url" };
  }
  if (!isCredentialTransportUrl(url))
    return { ok: false, reason: "scheme" };
  if (url.search || url.hash) return { ok: false, reason: "query-or-fragment" };
  if (url.username || url.password) return { ok: false, reason: "credentials", host: url.host };
  return { ok: true, url };
}

/** OIDC uses the issuer as written, including a trailing slash if the provider declares one. */
export function isExactOidcIssuer(value: string): boolean {
  const checked = checkIdpUrl(value);
  return checked.ok && !/[?#]/.test(value) && (checked.url.href === value || checked.url.origin === value);
}

/** The same identifier is used in the provider grant and the pinned proof audience. */
export function validOidcClientId(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && !/[\s\p{Cc}]/u.test(value);
}
