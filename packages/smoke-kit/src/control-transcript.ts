/**
 * The control exchange's MAC, written from the transcript bytes documented in
 * `packages/core/src/control-exchange.ts` and NOT from its implementation. A suite that drives a
 * real end with these MACs pins the documented bytes, so the two cannot drift apart.
 *
 * `label` defaults to the version this tree speaks; a suite passes another to stand in for a peer of
 * a different version.
 */
import { createHmac } from "node:crypto";

export function controlTranscriptMac(
  key: string,
  role: "server" | "client" | "reply",
  nc: string,
  ns: string,
  body?: string,
  label = "cotal-control/1",
): string {
  const parts = [Buffer.from(`${label}\0${role}\0${nc}\0${ns}`, "utf8")];
  if (body !== undefined) parts.push(Buffer.from([0]), Buffer.from(body, "utf8"));
  return createHmac("sha256", Buffer.from(key, "utf8")).update(Buffer.concat(parts)).digest("base64url");
}
