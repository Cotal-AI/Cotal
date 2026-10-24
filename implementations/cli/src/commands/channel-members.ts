import { CotalEndpoint, subjectMatches, type FlagValues, type MembershipSnapshot } from "@cotal-ai/core";
import { brokerAddressForDisplay, CommandFailure, exitCode, streamRecord, writeStreamRecord, writeResult, renderReport, terminalWidth, type ConnectRefusal, type Presentation, type Report } from "@cotal-ai/workspace";
import { connectOrThrow, credentialEnded, userViewAuthOrExit } from "../lib/connect.js";
import { refuseUnknownChannel, type channelFlags } from "./channels.js";

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
  let retry: ReturnType<typeof setTimeout> | undefined;
  let reading: Promise<void> | undefined;
  let pending = false;
  let watch: { stop(): Promise<void> } | undefined;
  let reason = "interrupted";
  let refusal: ConnectRefusal | undefined;
  let checking = false;
  // While observation is interrupted, one record says so and the failed reads that follow are not shown.
  let interruption = false;
  let end: () => void = () => {};
  const ended = new Promise<void>((resolve) => { end = resolve; });
  const stop = () => { stopped = true; end(); };
  const interrupt = () => { process.exitCode = 130; stop(); };
  const terminate = () => { reason = "terminated"; process.exitCode = 143; stop(); };
  const emit = (type: "snapshot" | "event" | "gap" | "error" | "end", data: unknown) => {
    if (presentation === "json") writeStreamRecord(streamRecord("membership", type, target, data));
  };
  const show = (next: Members) => {
    emit("event", next);
    if (presentation !== "json") console.log(renderReport(membersView(next, true), presentation, terminalWidth(process.stdout)));
  };
  // A dropped connection or a failed read ends the follow only once its credential can no longer
  // connect, with the refusal a one-shot command with it gets. Otherwise it is reported once, and the
  // feed is read again until it answers, so a follow outlives a broker restart.
  const interrupted = (lostConnection: boolean) => {
    if (stopped || checking) return;
    checking = true;
    void credentialEnded(connection).catch(() => undefined).then((ending) => {
      checking = false;
      if (stopped) return;
      if (ending) { refusal = ending; reason = "refused"; stop(); return; }
      if (!interruption) {
        interruption = true;
        const message = lostConnection ? `the connection to ${brokerAddressForDisplay(connection.server) ?? "the broker"} was lost; re-establishing it` : "The last observations are not a current membership census; reading the feed again.";
        emit("error", { code: lostConnection ? "TARGET_UNAVAILABLE" : "OPERATION_PARTIAL", message });
        if (presentation !== "json") console.error(message);
      }
      retry ??= setTimeout(() => { retry = undefined; refresh(); }, 2_000);
    });
  };
  // A watch whose consumer closed delivers no more changes, so reading again cannot recover it.
  const watchClosed = () => {
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
        if (stopped) continue;
        // The first read that answers after an interruption reports the gap and the census as it is now.
        if (interruption) {
          interruption = false;
          emit("gap", { reason: "Membership observation was interrupted; changes during the interruption are not shown.", lastAsOf: last?.asOf ?? null });
          if (presentation !== "json") console.error("Membership observation resumed; changes during the interruption are not shown.");
          last = next;
          show(next);
          continue;
        }
        // Each poll moves the feed's timestamps, so a read that observed the same census is not a change.
        const same = census(last) === census(next);
        last = next;
        if (!same) show(next);
      }
    })().catch(() => interrupted(false)).finally(() => { reading = undefined; });
  };
  const changed = () => {
    if (stopped || timer) return;
    timer = setTimeout(() => { timer = undefined; refresh(); }, 40);
  };
  ep.on("error", () => { if (streaming) interrupted(false); });
  ep.on("transport", ({ connected }: { connected: boolean }) => {
    if (!streaming) return;
    if (connected) changed();
    else interrupted(true);
  });
  try {
    await ep.start();
    last = resultOf(await ep.readMembership());
    if (values.follow) {
      streaming = true;
      process.once("SIGINT", interrupt);
      process.once("SIGTERM", terminate);
      emit("snapshot", last);
      if (presentation !== "json") console.log(renderReport(membersView(last, true), presentation, terminalWidth(process.stdout)));
      if (last.asOf === null) emit("gap", { reason: "The membership feed has no successful poll yet." });
      watch = await ep.watchMembership(changed, watchClosed);
      await ended;
    }
  } catch (error) {
    if (!streaming) throw error;
    reason = "error";
    process.exitCode = 4;
    emit("error", { code: "OPERATION_PARTIAL", message: "The last observations are not a current membership census." });
    if (presentation !== "json") console.error("Membership observation interrupted. The last snapshot is not current.");
  } finally {
    stopped = true;
    if (timer) clearTimeout(timer);
    if (retry) clearTimeout(retry);
    process.off("SIGINT", interrupt);
    process.off("SIGTERM", terminate);
    if (refusal && presentation === "json") {
      const failure = refusal.failure();
      emit("error", { code: failure.code, message: failure.message, ...(failure.remedy === undefined ? {} : { remedy: failure.remedy }) });
      process.exitCode = exitCode(failure.outcome, failure.code);
    }
    try {
      // The endpoint's stop is what settles the watch's own stop once the connection is closed for
      // good, so it must not wait behind it.
      const watchStopped = watch?.stop().then(() => undefined, (error: unknown) => error ?? new Error("membership watch stop failed"));
      await ep.stop();
      const watchError = await watchStopped;
      if (watchError) throw watchError;
    } catch (error) {
      if (!streaming) throw error;
      // After a refusal the credential cannot connect to delete the watch's consumer. That consumer
      // is ephemeral, so the broker drops it once nothing reads it, and the refusal stays the outcome.
      if (!refusal) {
        reason = "cleanup-not-confirmed";
        process.exitCode = 4;
        emit("error", { code: "OPERATION_PARTIAL", message: "Observer cleanup did not return a confirmation." });
        if (presentation !== "json") console.error("Observer cleanup was not confirmed.");
      }
    }
    if (streaming) emit("end", { reason, lastAsOf: last?.asOf ?? null });
  }
  if (refusal && presentation !== "json") throw refusal.failure();
  // An established census with no member does not show whether the name is a channel the space has.
  if (!streaming && last?.asOf != null && !last.members.length) await refuseUnknownChannel(channel, values, target, "members");
  if (!streaming && last) writeResult(presentation, {
    command: "channel", target, result: { kind: "membership", ...last },
    ...(last.asOf === null ? { completeness: "partial" as const, partial: { message: "The membership feed has no successful poll to establish a census.", remedy: "Check the selected space's delivery service." } } : {}),
  }, membersView);
}

/** Whether the feed has a census, and which members it observed with which membership. */
function census(result: Members | undefined): string {
  return JSON.stringify(result && [result.asOf !== null, result.members.map(({ id, name, live, durable }) => [id, name, live, durable])]);
}

/** A follow already shows each change, so its view offers no command to follow. */
function membersView(result: Members, following = false): Report {
  return { space: result.space, sections: [
    { title: `Members · #${result.channel}`, blocks: [
      { kind: "fields", rows: [["Space", result.space], ["Feed observed", result.asOf === null ? "no successful poll reported" : new Date(result.asOf).toISOString()]] },
      result.members.length ? {
        kind: "table", columns: [{ key: "name", label: "Participant" }, { key: "state", label: "Observed membership" }, { key: "id", label: "Identity" }],
        rows: result.members.map((member) => ({ name: member.name ?? "name not reported", state: member.live ? member.durable ? "live subscription · durable member" : "live subscription" : "durable member · live subscription not observed", id: member.id })),
      } : { kind: "lines", lines: [result.asOf === null ? "Membership is not established. An empty feed does not prove there are no members." : "No members in this feed snapshot."] },
      { kind: "lines", lines: [{ text: "Broker-derived observations, not access grants. This does not establish whether an agent is working or blocked.", tone: "hint" }] },
    ] },
    ...following ? [] : [{ title: "Next", blocks: [{ kind: "commands" as const, items: [{ command: `cotal ch members ${result.channel} --follow`, description: "Follow membership observations; Ctrl-C leaves without changing members" }] }] }],
  ] };
}
