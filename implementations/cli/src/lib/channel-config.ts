import { channelConfigSubject, credsClaims, CotalEndpoint, subjectMatches, type ChannelPatch } from "@cotal-ai/core";
import { CommandFailure, type Connection } from "@cotal-ai/workspace";

export function isAgentChannelWriter(connection: Connection): boolean {
  try { return connection.creds !== undefined && credsClaims(connection.creds).name === "agent"; }
  catch { return false; }
}

export async function configureChannelAsAgent(connection: Connection, channel: string, patch: ChannelPatch | undefined): Promise<{ removed: boolean; wrote: boolean }> {
  const ep = new CotalEndpoint({ space: connection.space, servers: connection.server, creds: connection.creds,
    tls: connection.tls, card: { name: "channel", kind: "endpoint" }, channels: [], consume: false,
    registerPresence: false, watchPresence: false, watchChannels: false });
  ep.on("error", () => {});
  try {
    const claims = credsClaims(connection.creds!);
    const publish = claims.nats?.pub;
    const subject = channelConfigSubject(connection.space, ep.ref().id, channel);
    if (!publish?.allow?.some((pattern) => subjectMatches(pattern, subject)) || publish.deny?.some((pattern) => subjectMatches(pattern, subject)))
      throw new CommandFailure("refused", "PERMISSION_DENIED", "This agent credential needs channel-config and a publish grant for this channel.", { target: { space: connection.space, channel } });
    await ep.start();
    const before = await ep.channelState(channel);
    const expectedRevision = before.revision;
    const after = await ep.configureChannel(channel, patch === undefined ? { remove: true, expectedRevision } : { patch, expectedRevision });
    return { removed: patch === undefined && before.config !== undefined, wrote: after.revision !== expectedRevision };
  } finally { await ep.stop(); }
}
