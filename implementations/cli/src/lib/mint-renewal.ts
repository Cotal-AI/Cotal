import { decode } from "@nats-io/jwt";
import { jetstreamManager } from "@nats-io/jetstream";
import {
  DEV_OWNER, acceptedBucket, aclAliasFilter, aclBucket, aclKey, credsClaims, dmDurable, dmStream, jwtFromCreds, mintCreds, newIdentity,
  openAclRegistry, parseLifecycleSubjectKey, principalKey, readAcl, type SpaceAuth,
} from "@cotal-ai/core";
import { codeSpan, CommandFailure, grantMintFlags, type AgentGrants, type MeshTarget } from "@cotal-ai/workspace";
import { withControlConnection } from "@cotal-ai/workspace/control";
import { shellWord } from "./endpoint-errors.js";

/** Remove only the ACL named by an expired, signed predecessor before provisioning its successor. */
export async function retireMintReadAcl(target: MeshTarget, auth: SpaceAuth, actor: string, source: string, name: string, grants: AgentGrants, onMutation: () => void): Promise<void> {
  const { space, server, tlsRequired } = target;
  const principal = principalKey(DEV_OWNER, actor).key;
  const fresh = codeSpan(`cotal auth mint ${name} --space ${shellWord(space)} --provision${grantMintFlags(grants)} --out <new file>`);
  const refuse = (why: string) => new CommandFailure("refused", "CONFLICT", `${why}. No read ACL was retired and no credential was written`, {
    target: { space, name, identity: actor }, remedy: `mint a fresh key with ${fresh}, choosing a new private output, then join with the reported lifecycle UID`,
  });
  const creds = await mintCreds(auth, newIdentity(), "provisioner");
  await withControlConnection(server, { creds, tls: tlsRequired }, async (nc) => {
    const bucket = aclBucket(space), prefix = `$KV.${bucket}.`;
    const kv = await openAclRegistry(nc, space);
    const info = await (await jetstreamManager(nc)).streams.info(`KV_${bucket}`, { subjects_filter: `${prefix}${aclAliasFilter(principal)}` });
    let predecessor: { uid: string; revision: number } | undefined;
    for (const subject of Object.keys(info.state.subjects ?? {})) {
      const key = parseLifecycleSubjectKey(subject.slice(prefix.length));
      if (!subject.startsWith(prefix) || key?.owner !== DEV_OWNER || key.actor !== actor) continue;
      const row = await readAcl(kv, principal, key.lifecycleUid);
      if (!row) continue;
      if (predecessor) throw refuse("This key has multiple provisioned read ACLs");
      predecessor = { uid: key.lifecycleUid, revision: row.revision };
    }
    if (!predecessor) return;
    if (!signedExpiredPredecessor(auth, source, actor, predecessor.uid))
      throw refuse("The supplied credential does not prove that this key's provisioned read ACL belongs to an expired out-of-band lifecycle");
    onMutation();
    await kv.purge(aclKey(principal, predecessor.uid), { previousSeq: predecessor.revision });
  });
}

function signedExpiredPredecessor(auth: SpaceAuth, source: string, actor: string, uid: string): boolean {
  const jwt = jwtFromCreds(source);
  if (!jwt) return false;
  try {
    decode(jwt);
    const claims = credsClaims(source);
    const inbox = `$JS.API.CONSUMER.INFO.${dmStream(auth.space)}.${dmDurable(DEV_OWNER, actor, uid)}`;
    const accepted = acceptedBucket(auth.space);
    const grants = claims.nats?.pub?.allow;
    return claims.name === "agent" && claims.sub === actor && claims.iss === auth.account.signingPub
      && (claims.nats?.issuer_account ?? claims.iss) === auth.account.pub
      && typeof claims.exp === "number" && Number.isSafeInteger(claims.exp) && claims.exp * 1000 <= Date.now()
      && grants?.includes(inbox) === true
      && !grants.some((subject) => subject.startsWith(`$JS.API.DIRECT.GET.KV_${accepted}.$KV.${accepted}.`));
  } catch {
    return false;
  }
}
