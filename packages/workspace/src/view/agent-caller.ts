import { CotalEndpoint, mintCreds, mintLifecycleUid, newIdentity, type SpaceAuth } from "@cotal-ai/core";

/** A connection for calling the person's agents' `agent` endpoints on a static space (SPEC 13.21),
 *  returned unstarted. It authenticates as the `agent-caller` profile under a fresh nkey and
 *  lifecycle UID, minted in memory from the space's signing key and re-minted for the same nkey
 *  before it expires. It holds the `owner` rows and their reply read and nothing else, so it shows
 *  no presence and reads no channel: use it for `callPrincipal` only. A signed-in person calls on
 *  their own sign-in, and an open mesh needs no credential. */
export function openAgentCaller({ space, server, auth, name }: { space: string; server: string; auth: SpaceAuth; name: string }): CotalEndpoint {
  const identity = newIdentity();
  const lifecycleUid = mintLifecycleUid();
  const ep = new CotalEndpoint({
    space,
    servers: server,
    lifecycleUid,
    creds: () => mintCreds(auth, identity, "agent-caller", { lifecycleUid }),
    card: { id: identity.id, name, kind: "endpoint" },
    channels: [],
    consume: false,
    registerPresence: false,
    watchPresence: false,
    watchChannels: false,
  });
  ep.on("error", () => {});
  return ep;
}
