import { encodeUser, fmtCreds } from "@nats-io/jwt";
import { fromPublic, fromSeed } from "@nats-io/nkeys";
import { connect, credsAuthenticator } from "@nats-io/transport-node";
import { newIdentity, type SpaceAuth } from "../src/index.js";

export async function kvCreateCounter(servers: string, auth: SpaceAuth, caller: string, buckets: string[]) {
  const identity = newIdentity();
  const enc = new TextEncoder();
  const subjects = buckets.map((bucket) => `$JS.API.CONSUMER.CREATE.KV_${bucket}.>`);
  const jwt = await encodeUser("kv-create-counter", fromPublic(identity.id), fromPublic(auth.account.pub),
    { pub: { deny: [">"] }, sub: { allow: subjects } }, { signer: fromSeed(enc.encode(auth.account.signingSeed)) });
  const conn = await connect({ servers, authenticator: credsAuthenticator(fmtCreds(jwt, fromSeed(enc.encode(identity.seed)))) });
  let count = 0;
  try {
    for (const subject of subjects) {
      conn.subscribe(subject, { callback: (_err, msg) => {
        if (msg?.reply?.startsWith(`_INBOX_${caller}.`)) count++;
      } });
    }
    await conn.flush();
  } catch (error) {
    await conn.close();
    throw error;
  }
  return { conn, count: async () => { await conn.flush(); return count; } };
}
