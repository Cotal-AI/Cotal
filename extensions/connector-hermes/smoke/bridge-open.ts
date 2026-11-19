/**
 * Open a Hermes bridge connection as the adapter does, for the bridge smokes: a subscribe carrying
 * the bridge token derived from the launch's control key. The token is computed here from the
 * documented bytes (HMAC-SHA256 keyed with the key over `cotal-hermes-bridge/<version>`, base64url),
 * independently of `bridgeToken`, so a smoke that passes here also pins the derivation.
 */
import { createHmac } from "node:crypto";
import type { Socket } from "node:net";
import { CONTROL_PROTOCOL_VERSION, type ControlEndpoint } from "@cotal-ai/core";

/** The endpoint a smoke hands `startBridgeServer`: the bridge reads only its key and version. */
export const bridgeKey = (socketPath: string, token: string): ControlEndpoint => ({ path: socketPath, token, version: CONTROL_PROTOCOL_VERSION });

/** The subscribe frame an adapter holding control key `token` sends first. */
export function subscribeFrame(token: string, version = CONTROL_PROTOCOL_VERSION): string {
  const derived = createHmac("sha256", Buffer.from(token, "utf8")).update(`cotal-hermes-bridge/${version}`, "utf8").digest("base64url");
  return JSON.stringify({ t: "subscribe", token: derived }) + "\n";
}

/** Send the subscribe for control key `token` on a connected socket; resolves once it is written. */
export function openBridge(sock: Socket, token: string): Promise<void> {
  return new Promise((resolve) => sock.write(subscribeFrame(token), () => resolve()));
}
