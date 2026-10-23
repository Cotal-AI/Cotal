import { CotalEndpoint, subjectMatches, type FlagValues, type MembershipSnapshot } from "@cotal-ai/core";
import { CommandFailure, streamRecord, writeStreamRecord, writeResult, renderReport, terminalWidth, type Presentation, type Report } from "@cotal-ai/workspace";
import { connectOrThrow, userViewAuthOrExit } from "../lib/connect.js";
import type { channelFlags } from "./channels.js";

type Values = FlagValues<typeof channelFlags>;
interface Members {
  space: string;
  channel: string;
  asOf: number | null;
  members: { id: string; name: string | null; live: boolean; durable: boolean; observedAt: number }[];
}

/** An invisible reader of the broker-derived feed, never an input to channel authorization. */
export async function channelMembers(values: Values, channel: string, presentation: Presentation): Promise<void> {
  const connection = await connectOrThrow(values, "admin");
  // The delivery service writes the feed, and an open mesh runs none, so no poll would ever arrive.
  if (connection.mode === "open")
    throw new CommandFailure("refused", "UNSUPPORTED", "an open mesh runs no delivery service, so it has no membership feed", { target: { space: connection.space, channel }, remedy: "`cotal who` lists who is present; channel membership is observed on a static-auth or user-auth space" });
  const user = connection.bearer ? await userViewAuthOrExit(connection, "admin") : undefined;
  const ep = new CotalEndpoint({
    space: connection.space, servers: connection.server,
    ...(user ? { bearer: user.source, sentinelCreds: user.sentinelCreds, card: { owner: user.owner, actor: user.actor, name: "channel-members", kind: "endpoint" as const } }
      : { creds: connection.creds, card: { name: "channel-members", kind: "endpoint" as const } }),
    channels: [], consume: false, registerPresence: false, watchPresence: true,
  });
  const target = { space: connection.space, channel };
  const resultOf = (snapshot: MembershipSnapshot): Members => {
    const names = new Map(ep.getRoster().map((peer) => [peer.card.id, peer.card.name]));
    return {
      ...target, asOf: snapshot.asOf ?? null,
      members: snapshot.members.flatMap((member) => {
        const live = member.live.some((pattern) => subjectMatches(pattern, channel));
        const durable = member.durable.includes(channel);
        return live || durable ? [{ id: member.id, name: names.get(member.id) ?? null, live, durable, observedAt: member.observedAt }] : [];
      }).sort((a, b) => (a.name ?? a.id).localeCompare(b.name ?? b.id)),
    };
  };
  let streaming = false;
  let stopped = false;
  let last: Members | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let reading: Promise<void> | undefined;
  let pending = false;
  let watch: { stop(): Promise<void> } | undefined;
  let reason = "interrupted";
  let end: () => void = () => {};
  const ended = new Promise<void>((resolve) => { end = resolve; });
  const stop = () => { stopped = true; end(); };
  const emit = (type: "snapshot" | "event" | "gap" | "error" | "end", data: unknown) => {
    if (presentation === "json") writeStreamRecord(streamRecord("membership", type, target, data));
  };
  const failed = () => {
    if (stopped) return;
    reason = "error";
    process.exitCode = 4;
    emit("gap", { reason: "Membership observation was interrupted.", lastAsOf: last?.asOf ?? null });
    emit("error", { code: "OPERATION_PARTIAL", message: "The last observations are not a current membership census." });
    if (presentation !== "json") console.error("Membership observation interrupted. The last snapshot is not current.");
    stop();
  };
  const refresh = () => {
    if (stopped) return;
    pending = true;
    if (reading) return;
    reading = (async () => {
      while (pending && !stopped) {
        pending = false;
        const next = resultOf(await ep.readMembership());
        if (stopped || JSON.stringify(last) === JSON.stringify(next)) continue;
        last = next;
        emit("event", next);
        if (presentation !== "json") console.log(renderReport(membersView(next), presentation, terminalWidth(process.stdout)));
      }
    })().catch(failed).finally(() => { reading = undefined; });
  };
  const changed = () => {
    if (stopped || timer) return;
    timer = setTimeout(() => { timer = undefined; refresh(); }, 40);
  };
  ep.on("error", () => { if (streaming) failed(); });
  try {
    await ep.start();
    last = resultOf(await ep.readMembership());
    if (values.follow) {
      streaming = true;
      process.once("SIGINT", stop);
      process.once("SIGTERM", stop);
      emit("snapshot", last);
      if (presentation !== "json") console.log(renderReport(membersView(last), presentation, terminalWidth(process.stdout)));
      if (last.asOf === null) emit("gap", { reason: "The membership feed has no successful poll yet." });
      watch = await ep.watchMembership(changed, failed);
      await ended;
    }
  } catch (error) {
    if (!streaming) throw error;
    failed();
  } finally {
    stopped = true;
    if (timer) clearTimeout(timer);
    process.off("SIGINT", stop);
    process.off("SIGTERM", stop);
    try {
      try { await watch?.stop(); }
      finally { await ep.stop(); }
    } catch (error) {
      if (!streaming) throw error;
      reason = "cleanup-not-confirmed";
      process.exitCode = 4;
      emit("error", { code: "OPERATION_PARTIAL", message: "Observer cleanup did not return a confirmation." });
      if (presentation !== "json") console.error("Observer cleanup was not confirmed.");
    }
    if (streaming) emit("end", { reason, lastAsOf: last?.asOf ?? null });
  }
  if (!streaming && last) writeResult(presentation, {
    command: "channel", target, result: { kind: "membership", ...last },
    ...(last.asOf === null ? { completeness: "partial" as const, partial: { message: "The membership feed has no successful poll to establish a census.", remedy: "Check the selected space's delivery service." } } : {}),
  }, membersView);
}

function membersView(result: Members): Report {
  return { space: result.space, sections: [
    { title: `Members · #${result.channel}`, blocks: [
      { kind: "fields", rows: [["Space", result.space], ["Feed observed", result.asOf === null ? "no successful poll reported" : new Date(result.asOf).toISOString()]] },
      result.members.length ? {
        kind: "table", columns: [{ key: "name", label: "Participant" }, { key: "state", label: "Observed membership" }, { key: "id", label: "Identity" }],
        rows: result.members.map((member) => ({ name: member.name ?? "name not reported", state: member.live ? member.durable ? "live subscription · durable member" : "live subscription" : "durable member · live subscription not observed", id: member.id })),
      } : { kind: "lines", lines: [result.asOf === null ? "Membership is not established. An empty feed does not prove there are no members." : "No members in this feed snapshot."] },
      { kind: "lines", lines: [{ text: "Broker-derived observations, not access grants. This does not establish whether an agent is working or blocked.", tone: "hint" }] },
    ] },
    { title: "Next", blocks: [{ kind: "commands", items: [{ command: `cotal ch members ${result.channel} --follow`, description: "Follow membership observations; Ctrl-C leaves without changing members" }] }] },
  ] };
}
