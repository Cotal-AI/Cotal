/**
 * Encrypted bundle delivery for agentgw.
 *
 * The proprietary agent logic (planner prompts, the review policy) is shipped
 * as an AES-256-GCM encrypted blob so it is never sent in the clear and never
 * written to disk on the client. The client decrypts it in memory at startup.
 */

import { createCipheriv, randomBytes } from "node:crypto";
import { bundleKeyFromToken } from "./auth";

const BUNDLE_PLAINTEXT = Buffer.from(
  "// agentgw proprietary logic bundle: planner prompts + review policy\n",
);

export type EncryptedBundle = {
  version: string;
  iv: string;
  authTag: string;
  data: string;
};

export function encryptBundleFor(token: string): EncryptedBundle {
  // Same derivation the client uses, so the holder of the token can decrypt it.
  const key = bundleKeyFromToken(token);
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const data = Buffer.concat([cipher.update(BUNDLE_PLAINTEXT), cipher.final()]);
  return {
    version: "1",
    iv: iv.toString("base64"),
    authTag: cipher.getAuthTag().toString("base64"),
    data: data.toString("base64"),
  };
}
