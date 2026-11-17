// The dashboard's HTTP I/O: every read, the two writes and the agent watches, through the status
// gate. This is the one place the client makes a request, so it is the one place a refusal can be
// mistaken for data.
//
// The server answers a failed route with a 500 whose body is `{"error": "..."}`, which is valid
// JSON, and `fetch()` does not reject on a 500. Every route therefore reads through `readJson`
// (lib/snapshot.ts), which turns a non-200 into a throw naming the read and the server's own error.
import { sendRefusal } from "../lib/compose.js";
import { readJson } from "../lib/snapshot.js";
import type { Api } from "../state/controller.js";
import type { ActivityPage, AgentEventsPage, ChannelInfo, CotalMessage, MembershipSnapshot, Meta, RosterEntry, SendAnswer } from "./types.js";

/** `fetchImpl` defaults to the global `fetch`, looked up when a request is made. */
export function httpApi(fetchImpl: typeof fetch = (input, init) => globalThis.fetch(input, init)): Api {
  const get = async <T>(url: string, what: string): Promise<T> => readJson<T>(await fetchImpl(url), what);
  // A watch answers 204 with no body. Anything else is a refusal: a 400 names its cause in `error`,
  // which `readJson` quotes, and a 200 is not what the route answers, so it is refused by its status.
  const noContent = async (url: string, what: string): Promise<void> => {
    const res = await fetchImpl(url, { method: "POST" });
    if (res.status === 204) return;
    if (!res.ok) await readJson<never>(res, what);
    throw new Error(`${what} refused with HTTP ${res.status}`);
  };
  const agent = (id: string) => `/api/agents/${encodeURIComponent(id)}`;
  return {
    meta: () => get<Meta>("/api/meta", "space"),
    roster: () => get<RosterEntry[]>("/api/roster", "peers"),
    channels: () => get<ChannelInfo[]>("/api/channels", "channels"),
    activity: (limit) => get<ActivityPage>(`/api/activity?limit=${limit}`, "activity"),
    dms: (limit) => get<CotalMessage[]>(`/api/dms?limit=${limit}`, "direct messages"),
    history: (channel, limit) =>
      get<CotalMessage[]>(`/api/channels/${encodeURIComponent(channel)}/history?limit=${limit}`, `#${channel} history`),
    membership: () => get<MembershipSnapshot>("/api/membership", "membership"),
    // A refused read of the event channel is a 200 carrying `{ refused }`, passed through as data.
    agentEvents: (id, limit) => get<AgentEventsPage>(`${agent(id)}/events?limit=${limit}`, `${id} events`),
    watch: (id, feed) => noContent(`${agent(id)}/watch?feed=${encodeURIComponent(feed)}`, `watch ${id}`),
    unwatch: (id, feed) => noContent(`${agent(id)}/unwatch?feed=${encodeURIComponent(feed)}`, `unwatch ${id}`),
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
