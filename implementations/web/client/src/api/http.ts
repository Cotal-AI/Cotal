// The dashboard's HTTP I/O: every read and the two writes, through the status gate. This is the one
// place the client makes a request, so it is the one place a refusal can be mistaken for data.
//
// The server answers a failed route with a 500 whose body is `{"error": "..."}`, which is valid
// JSON, and `fetch()` does not reject on a 500. Every route therefore reads through `readJson`
// (lib/snapshot.ts), which turns a non-200 into a throw naming the read and the server's own error.
import { sendRefusal } from "../lib/compose.js";
import { readJson } from "../lib/snapshot.js";
import type { Api } from "../state/controller.js";
import type { ActivityPage, ChannelInfo, CotalMessage, MembershipSnapshot, Meta, RosterEntry, SendAnswer } from "./types.js";

/** `fetchImpl` defaults to the global `fetch`, looked up when a request is made. */
export function httpApi(fetchImpl: typeof fetch = (input, init) => globalThis.fetch(input, init)): Api {
  const get = async <T>(url: string, what: string): Promise<T> => readJson<T>(await fetchImpl(url), what);
  return {
    meta: () => get<Meta>("/api/meta", "space"),
    roster: () => get<RosterEntry[]>("/api/roster", "peers"),
    channels: () => get<ChannelInfo[]>("/api/channels", "channels"),
    activity: (limit) => get<ActivityPage>(`/api/activity?limit=${limit}`, "activity"),
    dms: (limit) => get<CotalMessage[]>(`/api/dms?limit=${limit}`, "direct messages"),
    history: (channel, limit) =>
      get<CotalMessage[]>(`/api/channels/${encodeURIComponent(channel)}/history?limit=${limit}`, `#${channel} history`),
    membership: () => get<MembershipSnapshot>("/api/membership", "membership"),
    deleteChannel: async (channel) => {
      const res = await fetchImpl("/api/channel/delete", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ channel }),
      });
      return readJson<{ ok: true; channel: string; purged: number }>(res, `delete #${channel}`);
    },
    // A refusal keeps its status apart from the server's text, so the composer can tell the broker's
    // refusal (502) from the others and quote the text as it came.
    send: async (target, text) => {
      const res = await fetchImpl("/api/send", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ ...target, text }) });
      if (!res.ok) throw await sendRefusal(res);
      return readJson<SendAnswer>(res, "post");
    },
  };
}
