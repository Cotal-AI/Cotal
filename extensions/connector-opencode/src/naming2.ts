/**
 * The OpenCode 2.x connector's naming request (SPEC 13.22, names from the first message): one
 * `generate` on a child session of the seat's session, on the seat's own server, so on its login and
 * default model. A child session starts empty, so the seat's conversation stays out of the request
 * and the request stays out of the conversation; `generate` runs no tool and records no message. The
 * child session is deleted afterwards.
 */
import type { AgentNaming, NameFromMessage } from "@cotal-ai/connector-core";

export interface OpenCode2NamingSeat {
  /** A call on the seat's server API, as the plugin makes its own. */
  api<T>(path: string, init?: RequestInit): Promise<T>;
  /** The seat's session, once created. */
  session(): Promise<string | undefined>;
  log(msg: string): void;
  launchPrompt?: string;
}

/** The naming for the OpenCode 2.x seat `seat`. */
export function opencode2Naming(seat: OpenCode2NamingSeat): AgentNaming {
  return { request: opencode2NameFromMessage(seat), launchPrompt: seat.launchPrompt };
}

function opencode2NameFromMessage(seat: OpenCode2NamingSeat): NameFromMessage {
  return async ({ system, prompt, signal }) => {
    const parentID = await seat.session();
    if (!parentID) throw new Error("this seat has no OpenCode session to name it from");
    const created = await seat.api<{ data?: { id?: unknown } }>("/api/session", {
      method: "POST",
      body: JSON.stringify({ parentID, title: "Cotal agent name" }),
      signal,
    });
    const id = created?.data?.id;
    if (typeof id !== "string") throw new Error("OpenCode created the naming session without an id");
    const path = `/api/session/${encodeURIComponent(id)}`;
    try {
      const r = await seat.api<{ data?: { text?: unknown } }>(`${path}/generate`, {
        method: "POST",
        body: JSON.stringify({ prompt: `${system}\n\n${prompt}` }),
        signal,
      });
      if (typeof r?.data?.text !== "string") throw new Error("OpenCode answered the naming request with no text");
      return r.data.text;
    } finally {
      await seat.api(path, { method: "DELETE" }).catch((e: Error) => seat.log(`the naming session ${id} was not deleted: ${e.message}`));
    }
  };
}
