/**
 * A thread's title is the name its agent shows (SPEC 13.22): its label, else its name. The bridge
 * sends it with ACP's `session_info_update`, and keeps it in step both ways with the client's own
 * title on a thread server the client lists (thread-title.ts). A title the person gives the thread
 * there labels the agent with `set-label`, and otherwise the agent's name titles the thread there.
 */
import type { SessionUpdate } from "@agentclientprotocol/sdk";
import type { CotalAgentOptions, Session } from "./agent.js";
import type { Mesh } from "./mesh.js";
import { ClientTitle, ThreadServers } from "./thread-title.js";

type Send = (session: Session, update: SessionUpdate) => Promise<void>;

/** The titles of one bridge's sessions. */
export class Titles {
  private readonly servers: ThreadServers;

  constructor(
    private readonly sessions: ReadonlyMap<string, Session>,
    private readonly send: Send,
    private readonly options: Pick<CotalAgentOptions, "log" | "version" | "links">,
  ) {
    this.servers = new ThreadServers(options.version);
  }

  /** Title the session `name` unless it is the title last sent, through ACP and the client's thread
   *  server. An undefined name, as of a seat the roster does not show now, keeps the title. */
  retitle(session: Session, m: Mesh, name: string | undefined): void {
    if (name !== undefined && this.announce(session, name)) void this.push(session, m, name);
  }

  /** Make the title of a session that drives a seat and the name its agent shows one value. A title
   *  the person gave the thread in the client since the bridge last wrote or read it labels the agent;
   *  otherwise the agent's name titles the thread. `stored` is the title the thread's link stored, for
   *  the session's first look at its client's title. Syncs of one session run one at a time, and a
   *  sync never rejects: a failure is said in the thread and logged. */
  sync(session: Session, m: Mesh, stored?: string): Promise<void> {
    // The thread gets a title at once; the client's own may wait for a server to start.
    const shown = this.shownOf(session, m);
    if (shown !== undefined) this.announce(session, shown);
    const run = (session.titled ?? Promise.resolve()).then(() => this.syncNow(session, m, stored))
      .catch((e: Error) => this.options.log(`session ${session.id}: title not synced: ${e.message}`));
    session.titled = run;
    return run;
  }

  /** Retitle each session whose agent shows another name, as a label it takes, `/name` or a rename
   *  made elsewhere changes it. Returns a function that stops following. */
  follow(m: Mesh): () => void {
    return m.followRoster(() => {
      for (const session of this.sessions.values()) this.retitle(session, m, session.seat && m.shownName(session.seat));
    });
  }

  private async syncNow(session: Session, m: Mesh, stored?: string): Promise<void> {
    const seat = session.seat;
    if (!seat) return;
    let title: string | undefined;
    try {
      title = await this.clientTitle(session, m, stored).pull();
    } catch (e) {
      return this.note(session, `Could not read this thread's title from the client: ${(e as Error).message}`);
    }
    const shown = this.shownOf(session, m)!;
    if (title === undefined || title === shown) {
      this.announce(session, shown);
      return this.push(session, m, shown);
    }
    try {
      this.retitle(session, m, await m.relabel(seat, title));
    } catch (e) {
      await this.note(session, `Could not rename ${seat.name} to "${title}": ${(e as Error).message}`);
      await this.push(session, m, shown);
    }
  }

  /** The name the session's agent shows: its presence's, else the title last sent, else the name the
   *  seat was listed with. */
  private shownOf(session: Session, m: Mesh): string | undefined {
    const seat = session.seat;
    return seat && (m.shownName(seat) ?? session.title ?? seat.display ?? seat.name);
  }

  /** Send `name` through ACP unless it is the title last sent. Says whether it sent it. */
  private announce(session: Session, name: string): boolean {
    if (name === session.title) return false;
    session.title = name;
    void this.send(session, { sessionUpdate: "session_info_update", title: name })
      .catch((e: Error) => this.options.log(`session ${session.id}: title not sent: ${e.message}`));
    return true;
  }

  private push(session: Session, m: Mesh, name: string): Promise<void> {
    return this.clientTitle(session, m).push(name).catch((e: Error) => this.note(session, `Could not set this thread's title in the client: ${e.message}`));
  }

  private clientTitle(session: Session, m: Mesh, stored?: string): ClientTitle {
    const log = (line: string): void => this.options.log(`session ${session.id}: ${line}`);
    return (session.clientTitle ??= new ClientTitle(this.servers.find(session.mcpServers, log), stored, (title) => this.remember(session, m, title)));
  }

  /** Store a title the client's thread carries with the link from the thread to its seat's run. */
  private remember(session: Session, m: Mesh, title: string): void {
    if (!session.seat) return;
    try {
      this.options.links.add(m.space, { thread: session.id, lifecycleUid: session.seat.lifecycleUid, title });
    } catch (e) {
      this.options.log(`session ${session.id}: the thread's title not stored: ${(e as Error).message}`);
    }
  }

  /** Say `line` in the session's thread and log it. */
  private note(session: Session, line: string): Promise<void> {
    this.options.log(`session ${session.id}: ${line}`);
    return this.send(session, { sessionUpdate: "agent_message_chunk", content: { type: "text", text: line } })
      .catch((e: Error) => this.options.log(`session ${session.id}: update not sent: ${e.message}`));
  }
}
