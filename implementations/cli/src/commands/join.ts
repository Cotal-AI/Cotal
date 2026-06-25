import { parseArgs } from "node:util";
import { userInfo } from "node:os";
import { readFileSync } from "node:fs";
import * as readline from "node:readline";
import {
  CotalEndpoint,
  parseJoinLink,
  resolvePeer,
  AmbiguousPeerError,
  DEFAULT_SERVER,
  type Delivery,
  type EndpointKind,
  type PresenceStatus,
  type CotalMessage,
} from "@cotal-ai/core";
import { resolveSpace } from "../lib/status.js";
import { connectOrExit, reachableOrExit } from "../lib/connect.js";
import { c, statusBadge } from "../ui.js";

export async function join(argv: string[]): Promise<void> {
  const { values } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      space: { type: "string" },
      name: { type: "string" },
      role: { type: "string" },
      channel: { type: "string" },
      server: { type: "string" },
      kind: { type: "string" },
      link: { type: "string" },
      token: { type: "string" },
      creds: { type: "string" },
      tls: { type: "boolean" },
    },
  });

  // A join link carries server + auth + space; explicit flags still override it.
  const link = values.link ? parseJoinLink(values.link) : undefined;
  const name = values.name ?? userInfo().username;
  const channel = values.channel ?? link?.channels?.[0] ?? "general";
  const auth = {
    token: values.token ?? link?.token,
    user: link?.user,
    pass: link?.pass,
    creds: values.creds ? readFileSync(values.creds, "utf8") : undefined,
    tls: values.tls ?? link?.tls ?? false,
  };

  let space: string;
  let server: string;
  // An explicit connection (a join link, --token, or --creds) is taken at face value — that's the
  // escape hatch. Otherwise resolve the running mesh from any directory (server + trust material)
  // and self-mint, so a bare `cotal join` works outside the project instead of crashing credless.
  if (link || values.token || values.creds) {
    space = values.space ?? link?.space ?? resolveSpace(process.cwd());
    server = values.server ?? link?.servers ?? DEFAULT_SERVER;
    // Preflight with the ACTUAL auth (probeConnect, not isReachable — which returns true on an auth
    // REJECT, so a bad --creds/token/link would skip the check and crash raw at ep.start()). One
    // sentence on unreachable vs credentials-rejected, then we connect with the same auth.
    await reachableOrExit(server, auth);
  } else {
    const conn = await connectOrExit(values, "manager");
    space = conn.space;
    server = conn.server;
    auth.creds = conn.creds;
  }

  const ep = new CotalEndpoint({
    space,
    servers: server,
    ...auth,
    channels: [channel],
    card: {
      name,
      role: values.role,
      kind: (values.kind as EndpointKind) ?? "agent",
    },
  });
  const me = ep.card.id;

  // Interactive only when attached to a real terminal; headless when spawned
  // detached (manager) — then we just hold presence and log mesh events.
  const interactive = process.stdin.isTTY === true;
  let rlClosed = false;
  const rl = interactive
    ? readline.createInterface({
        input: process.stdin,
        output: process.stdout,
        prompt: c.dim(`${name}> `),
      })
    : undefined;
  rl?.on("close", () => {
    rlClosed = true;
  });

  const print = (line: string) => {
    if (rl && !rlClosed) {
      readline.cursorTo(process.stdout, 0);
      readline.clearLine(process.stdout, 0);
      console.log(line);
      rl.prompt(true);
    } else {
      console.log(line);
    }
  };

  const who = (card: { name: string; role?: string }) =>
    `${c.bold(card.name)}${card.role ? c.dim("/" + card.role) : ""}`;

  ep.on("message", (m: CotalMessage, d: Delivery) => {
    const text = m.parts
      .map((p) => (p.kind === "text" ? p.text : JSON.stringify(p.data)))
      .join(" ");
    if (m.to === me)
      print(`${c.magenta("(DM)")} ${who(m.from)} ${c.dim("→ you:")} ${text}`);
    else if (m.toService)
      print(`${c.yellow("(@" + m.toService + ")")} ${who(m.from)}: ${text}`);
    else print(`${c.cyan("#" + (m.channel ?? "?"))} ${who(m.from)}: ${text}`);
    d.ack(); // printed = surfaced
  });

  ep.on("presence", (ev) => {
    if (ev.presence.card.id === me) return; // ignore self
    if (ev.type === "join")
      print(c.green(`→ ${who(ev.presence.card)} joined `) + statusBadge(ev.presence.status));
    else if (ev.type === "offline")
      print(c.dim(`← ${who(ev.presence.card)} went offline`));
    else
      print(
        `${c.dim("•")} ${who(ev.presence.card)} ${statusBadge(ev.presence.status)}${ev.presence.activity ? c.dim(" — " + ev.presence.activity) : ""}`,
      );
  });

  ep.on("error", (e: Error) => print(c.red(`! ${e.message}`)));

  await ep.start();

  const shutdown = async () => {
    print(c.dim("leaving…"));
    rl?.close();
    await ep.stop();
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown());
  process.on("SIGTERM", () => void shutdown());

  if (!interactive || !rl) {
    console.log(
      c.dim(`${name} (${values.role ?? "no role"}) holding presence in ${space} — headless`),
    );
    await new Promise<void>(() => {}); // park; event handlers do the work
    return;
  }

  console.log(
    c.dim(`Joined ${c.bold(space)} as ${who({ name, role: values.role })} on #${channel}.`),
  );
  console.log(
    c.dim(
      "Type to broadcast. Commands: /who  /dm <name> <msg>  /anycast <role> <msg>  /working [x]  /waiting [x]  /idle  /me <x>  /quit\n",
    ),
  );
  setTimeout(() => {
    const others = ep.getRoster().filter((p) => p.card.id !== me);
    if (others.length)
      print(
        c.dim("Present: ") +
          others.map((p) => who(p.card) + " " + statusBadge(p.status)).join(c.dim(", ")),
      );
  }, 400);
  rl.prompt();

  const setStatus = async (status: PresenceStatus, activity?: string) => {
    if (activity) await ep.setActivity(activity);
    await ep.setStatus(status);
    print(c.dim(`(you are now ${status}${activity ? ": " + activity : ""})`));
  };

  rl.on("line", async (raw) => {
    const line = raw.trim();
    if (!line) {
      rl.prompt();
      return;
    }
    try {
      if (line === "/quit" || line === "/exit") return void (await shutdown());
      else if (line === "/who") {
        print(c.dim("Roster:"));
        for (const p of ep.getRoster())
          print(
            "  " +
              who(p.card) +
              " " +
              statusBadge(p.status) +
              (p.activity ? c.dim(" — " + p.activity) : "") +
              (p.card.id === me ? c.dim(" (you)") : ""),
          );
      } else if (line === "/idle") await setStatus("idle");
      else if (line.startsWith("/working"))
        await setStatus("working", line.slice(8).trim() || undefined);
      else if (line.startsWith("/waiting"))
        await setStatus("waiting", line.slice(8).trim() || undefined);
      else if (line.startsWith("/me "))
        await ep.setActivity(line.slice(4).trim()).then(() => print(c.dim("(activity updated)")));
      else if (line.startsWith("/dm ")) {
        const rest = line.slice(4).trim();
        const sp = rest.indexOf(" ");
        if (sp < 1) print(c.red("usage: /dm <name> <message>"));
        else {
          const target = rest.slice(0, sp);
          const text = rest.slice(sp + 1);
          try {
            const peer = resolvePeer(ep.getRoster(), target, { selfId: me });
            if (!peer) print(c.red(`no peer named "${target}" present`));
            else {
              await ep.unicast(peer.card.id, text);
              print(`${c.magenta("(DM)")} ${c.dim("you →")} ${c.bold(peer.card.name)}: ${text}`);
            }
          } catch (e) {
            if (!(e instanceof AmbiguousPeerError)) throw e;
            print(c.red(`"${target}" is ambiguous — DM by instance id:`));
            for (const cand of e.candidates) print(c.dim(`  ${cand.name} (${cand.status})  ${cand.id}`));
          }
        }
      } else if (line.startsWith("/anycast ")) {
        const rest = line.slice(9).trim();
        const sp = rest.indexOf(" ");
        if (sp < 1) print(c.red("usage: /anycast <role> <message>"));
        else {
          const service = rest.slice(0, sp);
          const text = rest.slice(sp + 1);
          await ep.anycast(service, text);
          print(`${c.yellow("(@" + service + ")")} ${c.dim("you →")} ${text}`);
        }
      } else {
        await ep.multicast(line, { channel });
        print(`${c.cyan("#" + channel)} ${c.dim("you:")} ${line}`);
      }
    } catch (e) {
      print(c.red(`! ${(e as Error).message}`));
    }
    rl.prompt();
  });
}
