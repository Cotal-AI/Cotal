import { isLoopbackLiteral } from "@cotal-ai/core/loopback";

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
  if (url.protocol !== "https:" && !(url.protocol === "http:" && isLoopbackLiteral(url.hostname)))
    return { ok: false, reason: "scheme" };
  if (url.search || url.hash) return { ok: false, reason: "query-or-fragment" };
  if (url.username || url.password) return { ok: false, reason: "credentials", host: url.host };
  return { ok: true, url };
}
