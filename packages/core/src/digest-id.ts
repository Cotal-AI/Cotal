import { createHash } from "node:crypto";

/** An id derived from `input`: its base64url sha256, 43 characters, so it fits {@link ID} and the
 *  same input re-derives the same id in every module that needs it. */
export function digestIdToken(input: string): string {
  return createHash("sha256").update(input, "utf8").digest("base64url");
}
