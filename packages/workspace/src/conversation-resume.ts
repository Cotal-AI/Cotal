import { createHmac, randomBytes } from "node:crypto";
import { lstatSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { mkSecretDir, writeSecretFileCreateOnly } from "@cotal-ai/core/secret-fs";
import { userCotalDir } from "./cotal-home.js";
import { osMachineId } from "./machine-identity.js";

export interface ConversationResumeProof {
  v: 1;
  salt: string;
  /** Digest of the pinned space, native session, name and requested selection. */
  binding: string;
}

export const CONVERSATION_RESUME_PREFIX = "cotal-conversation-resume-v1:";

/** A copied conversation record contains neither this key nor an actor token. The key is outside
 * the redirected Cotal home, under this OS user's Cotal directory. The OS identity also separates
 * copies of the directory between ordinary installations with different machine identities. */
export function conversationResumeToken(proof: ConversationResumeProof, create = false): string {
  if (proof.v !== 1 || !/^[A-Za-z0-9_-]{43}$/.test(proof.salt) || !/^[a-f0-9]{64}$/.test(proof.binding))
    throw new Error("invalid conversation resume proof");
  const machine = osMachineId();
  const dir = join(userCotalDir(), "conversation-device");
  const file = join(dir, "key");
  if (create) {
    mkSecretDir(dir);
    try { writeSecretFileCreateOnly(file, randomBytes(32).toString("hex")); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
  }
  const stat = lstatSync(file);
  if (!stat.isFile() || (process.getuid && (stat.uid !== process.getuid() || (stat.mode & 0o077) !== 0)))
    throw new Error("conversation device key is not an owner-private regular file");
  const key = readFileSync(file, "utf8");
  if (!/^[a-f0-9]{64}$/.test(key)) throw new Error("invalid conversation device key");
  return createHmac("sha256", Buffer.from(key, "hex"))
    .update(`cotal conversation credential v1\0${machine.platform}\0${machine.bytes.toString("hex")}\0${proof.binding}\0${proof.salt}`)
    .digest("base64url");
}
