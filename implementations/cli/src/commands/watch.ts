import { writeSync } from "node:fs";
import { CotalEndpoint, chatWildcard, type FlagSpec, type FlagValues, type ParsedArgs } from "@cotal-ai/core";
import { colorEnabled, CommandFailure, exitCode, inputDisabledByFlag, isCommandFailure, jsonFlag, plainFlag, presentationOf, streamRecord, writeStreamRecord, userViewAuth, targetFlags } from "@cotal-ai/workspace";
import { connectOrExit, connectOrThrow, userViewAuthOrExit } from "../lib/connect.js";
import { watchViews, type WatchFilter } from "../watch-data.js";
export type { WatchFilter } from "../watch-data.js";

export const watchFlags = [
  ...targetFlags,
  { name: "view", type: "string", value: "<view>", description: "feed, events, messages, roster, channels, waiting, dms or topology" },
  jsonFlag, plainFlag,
] as const satisfies readonly FlagSpec[];


export function validateWatchArguments(args: ParsedArgs): void {
  presentationOf(args.values);
  const filter = args.values.view === "feed" ? "activity" : args.values.view ?? "activity";
  if (!watchViews.includes(filter as WatchFilter)) throw new CommandFailure("refused", "USAGE_INVALID", "watch --view takes feed, events, messages, roster, channels, waiting, dms or topology");
}

/** An invisible observer. Leaving this view never sends a control or stop request. */
export async function watch(args: ParsedArgs): Promise<void> {
  validateWatchArguments(args);
  try { await watchSession(args); }
  catch (error) {
    if (!args.values.json) throw error;
    const target = { requestedSpace: args.values.space ?? null };
    writeStreamRecord(streamRecord("watch", "error", target, { code: isCommandFailure(error) ? error.code : "OPERATION_FAILED", message: "The observer could not establish its authorized view; this is not an empty successful snapshot." }));
    writeStreamRecord(streamRecord("watch", "end", target, { reason: "setup-failed" }));
    process.exitCode = isCommandFailure(error) ? exitCode(error.outcome, error.code) : 5;
  }
}

async function watchSession(args: ParsedArgs): Promise<void> {
  const values = args.values as FlagValues<typeof watchFlags>;
  const filter = (values.view === "feed" ? "activity" : values.view ?? "activity") as WatchFilter;
  const interactive = !values.json && !values.plain && !inputDisabledByFlag() && process.stdout.isTTY && process.stdin.isTTY;
  const connection = values.json ? await connectOrThrow(values, "admin") : await connectOrExit(values, "admin");
  if (filter === "dms" && (connection.bearer || connection.creds)) throw new CommandFailure("refused", "UNSUPPORTED", "this observer is narrowed to channel traffic in authenticated spaces; no broader credential or private conversation was substituted");
  const user = connection.bearer ? values.json ? await userViewAuth(connection, "admin") : await userViewAuthOrExit(connection, "admin") : undefined;
  const ep = new CotalEndpoint({
    space: connection.space,
    servers: connection.server,
    ...(user ? {
      bearer: user.source,
      sentinelCreds: user.sentinelCreds,
      card: { owner: user.owner, actor: user.actor, name: "watch", kind: "endpoint" as const },
    } : { creds: connection.creds, card: { name: "watch", kind: "endpoint" as const } }),
    channels: [],
    consume: false,
    registerPresence: false,
    watchPresence: true,
  });
  ep.on("error", () => {});
  const tapSubject = connection.creds || user ? chatWildcard(connection.space) : undefined;
  if (values.json || !interactive) {
    const { runWatchStream } = await import("../watch-json.js");
    return runWatchStream(ep, connection.space, tapSubject, filter, values.json ? "json" : "plain");
  }
  const forced = process.env.FORCE_COLOR;
  if (!colorEnabled()) process.env.FORCE_COLOR = "0";
  const ui = await Promise.all([import("ink"), import("react"), import("../watch-view.js"), import("../view/mesh-view.js")]).finally(() => {
    if (forced === undefined) delete process.env.FORCE_COLOR;
    else process.env.FORCE_COLOR = forced;
  });
  const [{ render }, { createElement }, { WatchView }, { MeshView }] = ui;
  const view = new MeshView(ep, { tapSubject, window: 300 });
  let entered = false;
  const restore = () => {
    if (!entered) return;
    entered = false;
    try { writeSync(process.stdout.fd, "\x1b[?1049l\x1b[?25h"); } catch { /* terminal closed */ }
  };
  let leave: (() => void) | undefined;
  const interrupt = () => leave?.();
  const terminate = () => { process.exitCode = 143; leave?.(); };
  try {
    await view.start();
    writeSync(process.stdout.fd, "\x1b[?1049h");
    entered = true;
    process.once("exit", restore);
    process.once("SIGINT", interrupt);
    process.once("SIGTERM", terminate);
    const instance = render(createElement(WatchView, { view, initialFilter: filter, onLeave: () => leave?.() }), { exitOnCtrlC: false, maxFps: 30 });
    leave = () => instance.unmount();
    await instance.waitUntilExit();
  } finally {
    try { await view.stop(); }
    finally {
      process.off("exit", restore);
      process.off("SIGINT", interrupt);
      process.off("SIGTERM", terminate);
      restore();
    }
  }
}
