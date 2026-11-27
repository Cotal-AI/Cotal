/**
 * `cotal acp`: the ACP agent on stdio. stdout carries the protocol and nothing else, so every other
 * write to it goes to stderr.
 */
import { spawnSync } from "node:child_process";
import { closeSync, readFileSync, writeSync } from "node:fs";
import { join } from "node:path";
import { Readable } from "node:stream";
import { ndJsonStream } from "@agentclientprotocol/sdk";
import { mkSecretDir, openPrivateAppend, type ParsedArgs } from "@cotal-ai/core";
import { homeCotalDir, isConnectRefusal, resolveTargetOrThrow } from "@cotal-ai/workspace";
import { cotalAgent, type HiddenSessions, type ThreadLink, type ThreadLinks } from "./agent.js";
import { openLiveMesh } from "./live-mesh.js";

const version = (JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { version: string }).version;

/** Seat runs that `session/delete` hid, one lifecycle UID per line. Every read goes to the file,
 *  because a client may run one agent process per thread and another process may have hidden one
 *  since. Each hide is one append, so two processes hiding at once both keep theirs. */
export function hiddenStore(dir = join(homeCotalDir(), "acp")): HiddenSessions {
  const path = join(dir, "hidden-runs");
  const read = (): Set<string> => {
    try {
      return new Set(readFileSync(path, "utf8").split("\n").filter((line) => line !== ""));
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") return new Set();
      throw e;
    }
  };
  return {
    read,
    add(lifecycleUid) {
      if (!lifecycleUid || /[\r\n]/.test(lifecycleUid)) throw new Error(`"${lifecycleUid}" is not a lifecycle UID`);
      if (read().has(lifecycleUid)) return;
      mkSecretDir(dir);
      const fd = openPrivateAppend(path);
      try {
        writeSync(fd, `${lifecycleUid}\n`);
      } finally {
        closeSync(fd);
      }
    },
  };
}

/** The thread links, one JSON line per link, `{ space, thread, lifecycleUid, title? }`, in the order
 *  they were stored. Every read goes to the file, as for {@link hiddenStore}, and each link is one
 *  append. A line that does not parse is refused, naming the file, rather than skipped. */
export function threadStore(dir = join(homeCotalDir(), "acp")): ThreadLinks {
  const path = join(dir, "threads");
  return {
    read(space) {
      let text: string;
      try {
        text = readFileSync(path, "utf8");
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code === "ENOENT") return [];
        throw e;
      }
      return text.split("\n").filter((line) => line !== "").flatMap((line, at): ThreadLink[] => {
        let row: unknown;
        try {
          row = JSON.parse(line);
        } catch {
          throw new Error(`${path}: line ${at + 1} is not a thread link`);
        }
        const { space: s, thread, lifecycleUid, title } = (row ?? {}) as Record<string, unknown>;
        if (typeof s !== "string" || typeof thread !== "string" || typeof lifecycleUid !== "string" || (title !== undefined && typeof title !== "string"))
          throw new Error(`${path}: line ${at + 1} is not a thread link`);
        return s === space ? [{ thread, lifecycleUid, ...(title !== undefined ? { title } : {}) }] : [];
      });
    },
    add(space, link) {
      mkSecretDir(dir);
      const fd = openPrivateAppend(path);
      try {
        writeSync(fd, `${JSON.stringify({ space, thread: link.thread, lifecycleUid: link.lifecycleUid, title: link.title })}\n`);
      } finally {
        closeSync(fd);
      }
    },
  };
}

/** Give the protocol its own handle on stdout and send every other stdout write to stderr. */
function claimStdout(): WritableStream<Uint8Array> {
  const write = process.stdout.write.bind(process.stdout) as (chunk: Uint8Array, done: (e?: Error | null) => void) => boolean;
  process.stdout.write = process.stderr.write.bind(process.stderr) as typeof process.stdout.write;
  return new WritableStream<Uint8Array>({
    write: (chunk) => new Promise<void>((resolve, reject) => void write(chunk, (e) => (e ? reject(e) : resolve()))),
  });
}

const log = (line: string): void => void process.stderr.write(`cotal acp: ${line}\n`);

async function signInTarget(space: string | undefined, server: string | undefined) {
  try {
    const target = await resolveTargetOrThrow({ space, server });
    return { space: target.space, idp: target.mode === "user" ? target.userAuth?.idp.url : undefined };
  } catch (e) {
    if (!isConnectRefusal(e) || (e.cause as { code?: unknown } | undefined)?.code !== "no-meshes") throw e;
    return undefined;
  }
}

/** The sign-in a client runs in a terminal: `cotal login` for a space that authenticates users,
 *  `cotal setup` when no space is recorded on this machine. */
async function signIn(space: string | undefined, server: string | undefined): Promise<number> {
  const target = await signInTarget(space, server);
  let command: string[];
  if (!target) command = ["setup", ...(space ? ["--space", space] : [])];
  else if (target.idp !== undefined) command = ["login", "--idp", target.idp];
  else {
    log(`${target.space} does not authenticate users, so there is nothing to sign in to.`);
    return 0;
  }
  const cotal = [...process.execArgv, process.argv[1]!];
  log(`running \`cotal ${command.join(" ")}\``);
  return spawnSync(process.execPath, [...cotal, ...command], { stdio: "inherit" }).status ?? 1;
}

export async function acp(args: ParsedArgs): Promise<void> {
  const space = typeof args.values.space === "string" ? args.values.space : undefined;
  const server = typeof args.values.server === "string" ? args.values.server : undefined;
  if (args.values.auth === true) {
    process.exitCode = await signIn(space, server);
    return;
  }
  const output = claimStdout();
  const input = Readable.toWeb(process.stdin) as ReadableStream<Uint8Array>;
  const stop = (reason: string): void => {
    log(`${reason}. Stopping; start the agent again in your client.`);
    process.exit(1);
  };
  const canSignIn = () => signInTarget(space, server).then((target) => !target || target.idp !== undefined, () => false);
  const app = cotalAgent({ mesh: () => openLiveMesh({ space, server, log, stop }), hidden: hiddenStore(), links: threadStore(), log, version, canSignIn });
  const connection = app.connect(ndJsonStream(output, input));
  await connection.closed;
}
