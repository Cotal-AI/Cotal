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
  mintCreds,
  newIdentity,
  provisionAgent,
  type Delivery,
  type EndpointKind,
  type PresenceStatus,
  type CotalMessage,
} from "@cotal-ai/core";
import { resolveSpace } from "../lib/status.js";
import { reachableOrExit, resolveTargetOrExit, preflightOrExit } from "../lib/connect.js";
import { c, statusBadge } from "../ui.js";

// The plan's stale-cred fail-fast gate: render an unprovisioned / auth-rejected join as ONE human
// sentence instead of a raw NATS stack. Shared by the self-mint provisioning step (which runs
// BEFORE ep.start) and ep.start itself. Returns false for anything that isn't a known auth/
// provisioning class, so the caller re-throws the raw error for genuinely unexpected failures.
function renderJoinAuthError(e: unknown, space: string): boolean {
  const msg = (e as Error)?.message ?? String(e);
  if (/consumer not found|no responders|not provisioned/i.test(msg)) {
    console.error(
      c.red(`${space} isn't provisioned for a console session yet — run `) +
        c.bold("cotal up") +
        c.red(` first, or join with --creds/--token.`),
    );
    return true;
  }
  if (/authoriz|permission|not authorized/i.test(msg)) {
    console.error(
      c.red(`not authorized to join ${space}'s channels — pass --creds/--token, or ask the mesh operator for a join link.`),
    );
    return true;
  }
  return false;
}

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
    // Self-mint: a bare `cotal join` becomes a console on the running mesh. In auth mode it self-provisions
    // exactly like the manager does at spawn — open a short-lived `provisioner`, pre-create THIS console's
    // own bind-only dm_<id>/dlv_<id> durables + record its read ACL, then connect as a plain `agent`. The
    // console never HOLDS provisioner authority as a session cred (mint → provision own inbox → drop →
    // connect as agent), so the DM CONSUMER.CREATE surface exists only for the provisioning window — the
    // same containment as the manager's `withProvisioner`. This fixes the unprovisioned-console
    // ConsumerNotFound (a self-minted console had no manager to pre-create its dm_<id> durable) AND drops
    // the last broad `manager` mint off the console. Open mode (no auth) is unchanged — connect bare.
    const target = await resolveTargetOrExit({ server: values.server, space: values.space });
    space = target.space;
    server = target.server;
    await preflightOrExit(target); // one sentence if the mesh is down / won't auth, + stale-prune
    if (target.auth) {
      const identity = newIdentity();
      const prov = new CotalEndpoint({
        space,
        servers: server,
        creds: await mintCreds(target.auth, newIdentity(), "provisioner"),
        channels: [],
        consume: false,
        registerPresence: false,
        watchPresence: false,
        watchChannels: false,
        card: { name: "join-provisioner", role: "provisioner", kind: "endpoint" },
      });
      // Swallow provisioner errors: this ephemeral endpoint's failures surface through the try/catch
      // below as one legible sentence, not a raw `! provisioner: …` side channel.
      prov.on("error", () => {});
      try {
        await prov.start();
        // Live-only: a bare join isn't under a manager, so no durable Plane-3 backstop
        // (durableMembership:false) — the console reads live via its core-sub + receives DMs on its dm_<id>.
        auth.creds = await provisionAgent(prov, target.auth, identity, {
          subscribe: [channel],
          allowSubscribe: [channel],
          allowPublish: [channel],
          role: values.role,
          durableMembership: false,
        });
        await prov.stop();
      } catch (e) {
        // The self-mint step runs BEFORE ep.start(), so its auth/provisioning failure must render
        // legibly too — same fail-fast gate, not a raw NATS error leaked through the on-error channel.
        if (!renderJoinAuthError(e, space)) throw e;
        process.exit(1);
      }
    }
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

  try {
    await ep.start();
  } catch (e) {
    // A bare `cotal join` binds a durable DM inbox nobody pre-created on an unprovisioned space;
    // surface that (and an auth reject) as ONE human sentence, not a raw NATS stack.
    if (!renderJoinAuthError(e, space)) throw e;
    process.exit(1);
  }

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
