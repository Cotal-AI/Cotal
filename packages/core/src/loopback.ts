import { BlockList, isIPv4, isIPv6 } from "node:net";

const LOOPBACK = new BlockList();
LOOPBACK.addSubnet("127.0.0.0", 8, "ipv4");
LOOPBACK.addAddress("::1", "ipv6");

/** Is this host a loopback IP literal, the one place plain http may carry a credential because
 *  nothing leaves the machine? The address is parsed, so every IPv6 spelling of `::1` and the
 *  v4-mapped `::ffff:127.x.y.z` count while `127.evil.com` does not. A name such as `localhost`
 *  never counts: resolution would choose where the credential goes. Brackets are tolerated so a
 *  caller may pass `URL.hostname`, which has already canonicalized legacy IPv4 such as
 *  `0177.0.0.1` for http(s) URLs. */
export function isLoopbackLiteral(hostname: string): boolean {
  const host = hostname.replace(/^\[|\]$/g, "");
  if (isIPv4(host)) return LOOPBACK.check(host, "ipv4");
  return isIPv6(host) && LOOPBACK.check(host, "ipv6");
}

/** May this URL carry a credential? `https:`, or `http:` on a loopback IP literal. Every other
 *  scheme is refused, including `ftp:` and `ws:` on loopback: a site that kept only the loopback
 *  half would send the credential off this machine. A name such as `localhost` is not a literal. */
export function isCredentialTransportUrl(url: URL): boolean {
  return url.protocol === "https:" || (url.protocol === "http:" && isLoopbackLiteral(url.hostname));
}
