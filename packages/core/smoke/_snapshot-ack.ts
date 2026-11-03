/**
 * Instruments for the snapshot-credential smokes. No shipped profile can publish into another
 * connection's inbox or watch snapshot ACK subjects, so the injector and the ACK tap are
 * hand-signed users with exactly the permissions they name, standing for any party that can.
 */
import { connect, credsAuthenticator, type NatsConnection } from "@nats-io/transport-node";
import { encodeUser, fmtCreds, type User } from "@nats-io/jwt";
import { createUser, fromPublic, fromSeed } from "@nats-io/nkeys";
import type { SpaceAuth } from "../src/index.js";

/** A connection under a user the space account signs with exactly `permissions`. */
export async function openSigned(servers: string, auth: SpaceAuth, name: string, permissions: Partial<User>): Promise<NatsConnection> {
  const key = createUser();
  const jwt = await encodeUser(name, fromPublic(key.getPublicKey()), fromPublic(auth.account.pub), permissions,
    { signer: fromSeed(new TextEncoder().encode(auth.account.signingSeed)), exp: Math.floor(Date.now() / 1000) + 600 });
  return connect({ servers, authenticator: credsAuthenticator(fmtCreds(jwt, key)), maxReconnectAttempts: 0, inboxPrefix: `_INBOX_${name}` });
}

/** Run `work` while counting the snapshot chunk ACKs that reach `stream`'s ACK subjects. A
 *  publish the broker refuses never reaches a subscriber, so the count is what the grant let out. */
export async function countSnapshotAcks<T>(tap: NatsConnection, stream: string, work: () => Promise<T>): Promise<{ result: T; acks: number }> {
  let acks = 0;
  const sub = tap.subscribe(`$JS.SNAPSHOT.ACK.${stream}.>`, { callback: () => { acks++; } });
  await tap.flush();
  try {
    const result = await work();
    await tap.flush();
    return { result, acks };
  } finally {
    sub.unsubscribe();
  }
}

/** Deliver one message to `subject` in the holder's inbox carrying reply
 *  `$JS.API.STREAM.DELETE.<victim>`, and answer it from the holder as a snapshot chunk is answered.
 *  Returns whether the holder sent the answer and the permission error its connection reported. */
export async function answerInjectedDelete(holder: NatsConnection, injector: NatsConnection, subject: string, victim: string): Promise<{ answered: boolean; refusal: string | undefined }> {
  let refusal: string | undefined;
  const watch = (async () => {
    for await (const status of holder.status())
      if (status.type === "error" && /permission/i.test(String((status as { error?: unknown }).error))) { refusal = String((status as { error?: unknown }).error); return; }
  })();
  const answered = new Promise<boolean>((resolve) => {
    holder.subscribe(subject, { max: 1, callback: (_error, msg) => resolve(Boolean(msg.reply) && msg.respond()) });
  });
  await holder.flush();
  injector.publish(subject, new TextEncoder().encode("chunk"), { reply: `$JS.API.STREAM.DELETE.${victim}` });
  await injector.flush();
  const sent = await answered;
  await holder.flush();
  for (let i = 0; i < 40 && refusal === undefined; i++) await new Promise((resolve) => setTimeout(resolve, 25));
  void watch;
  return { answered: sent, refusal };
}
