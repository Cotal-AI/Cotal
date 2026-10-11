import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  closeSync, constants, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync,
  readdirSync, realpathSync, rmSync, rmdirSync, statfsSync, writeFileSync, fchownSync,
} from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import {
  delegatedSeatCommand, managedRuntimeKey, parseManagedLifecycleHandoff, SpawnRefused,
  type AgentHandle, type DelegatedSeatLaunch, type LaunchSpec, type ManagedLifecycleHandoff,
} from "@cotal-ai/core";
import { LegacyPtyRuntime } from "./pty.js";

/** Trusted guest configuration, never spawn arguments. One child is admitted for this root forever.
 * The host pins the stock cotal entry and supplies only workload-scoped gateway environment values.
 * Neither the manager's environment nor its private files are inherited. */
export interface DelegatedPtyOptions {
  uid: number;
  gid: number;
  childRoot: string;
  cgroupRoot: string;
  cotalCommand: string;
  env: Readonly<Record<string, string>>;
}

const CGROUP2_SUPER_MAGIC = 0x63677270;
const EXIT_PROOF_MS = 8_000;
const POLL_MS = 50;
// The shell has no child before it joins the confinement. A failed join cannot exec the seat.
const JOIN_SCRIPT = 'printf "%s" "$$" > "$1/cgroup.procs"; shift; exec "$@"';
const forbiddenEnv = /^(?:COTAL_|TENKI_|LD_|DYLD_|NODE_OPTIONS$|NODE_PATH$|BASH_ENV$|ENV$|GCONV_PATH$|GLIBC_TUNABLES$|LOCPATH$|HOME$|USER$|LOGNAME$|TMPDIR$|XDG_)/;

function refusal(message: string): never { throw new SpawnRefused(message); }

/** Resolve a protected root without accepting a symlink or a child-writable ancestor. */
function protectedRoot(path: string, childTraverses = true): string {
  if (typeof path !== "string" || !isAbsolute(path) || resolve(path) !== path || realpathSync(path) !== path)
    refusal("delegated pty roots must be canonical absolute directories");
  for (let current = path; ; current = dirname(current)) {
    const st = lstatSync(current);
    if (!st.isDirectory() || st.isSymbolicLink() || st.uid !== 0 || (st.mode & 0o022) !== 0 || (childTraverses && (st.mode & 0o001) === 0))
      refusal("delegated pty roots need root-owned, traversable, non-writable ancestors");
    if (dirname(current) === current) break;
  }
  return path;
}

function executable(path: string, uid: number, gid: number, script = false): string {
  if (!isAbsolute(path)) refusal("delegated pty commands must be absolute paths");
  const canonical = realpathSync(path);
  for (let current = canonical; ; current = dirname(current)) {
    const st = lstatSync(current);
    const bits = st.uid === uid ? (st.mode >> 6) & 7 : st.gid === gid ? (st.mode >> 3) & 7 : st.mode & 7;
    if ((bits & 2) !== 0 || (current === canonical ? !st.isFile() || (bits & (script ? 4 : 1)) === 0 : !st.isDirectory() || (bits & 1) === 0))
      refusal("delegated pty commands must be accessible and not writable by the child");
    if (dirname(current) === current) break;
  }
  return canonical;
}

function emptyUid(uid: number): void {
  for (const pid of readdirSync("/proc").filter(name => /^[0-9]+$/.test(name))) {
    let status: string;
    try { status = readFileSync(`/proc/${pid}/status`, "utf8"); }
    catch (error) {
      if (["ENOENT", "ESRCH"].includes((error as NodeJS.ErrnoException).code ?? "")) continue;
      throw error;
    }
    const ids = /^Uid:\s+([0-9]+)\s+([0-9]+)\s+([0-9]+)\s+([0-9]+)$/m.exec(status);
    if (!ids) refusal("delegated pty cannot observe a process UID");
    if (ids.slice(1).some(value => Number(value) === uid))
      refusal("delegated pty needs a dedicated child UID with no existing processes");
  }
}

function privateFile(path: string, value: string, uid: number, gid: number): void {
  const fd = openSync(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  try { writeFileSync(fd, value); fchownSync(fd, uid, gid); fsyncSync(fd); }
  finally { closeSync(fd); }
}

function populated(group: string): boolean {
  const value = /^populated ([01])$/m.exec(readFileSync(join(group, "cgroup.events"), "utf8"));
  if (!value) throw new Error("delegated pty confinement has no populated observation");
  return value[1] === "1";
}

/** Guest-root local PTY with by-value managed handoff and kernel-owned descendant custody.
 * There is no adoption or weaker UID/pgid sweep. External environment retirement covers worker death. */
export class DelegatedPtyRuntime extends LegacyPtyRuntime {
  private readonly options: DelegatedPtyOptions;
  private readonly username: string;
  private readonly node: string;
  private readonly setpriv: string;

  constructor(input: DelegatedPtyOptions) {
    super();
    if (process.platform !== "linux" || process.getuid?.() !== 0)
      refusal("delegated pty requires a Linux guest-root manager");
    const options = structuredClone(input);
    if (!options || Object.keys(options).sort().join(",") !== "cgroupRoot,childRoot,cotalCommand,env,gid,uid" ||
      !Number.isSafeInteger(options.uid) || options.uid <= 0 || options.uid >= 0xffffffff ||
      !Number.isSafeInteger(options.gid) || options.gid <= 0 || options.gid >= 0xffffffff ||
      !options.env || Array.isArray(options.env) || typeof options.env !== "object" ||
      Object.entries(options.env).some(([key, value]) => !/^[A-Za-z_][A-Za-z0-9_]*$/.test(key) || forbiddenEnv.test(key) || typeof value !== "string" || value.includes("\0")) ||
      typeof options.env.PATH !== "string" || options.env.PATH.split(":").some(part => !isAbsolute(part)))
      refusal("delegated pty configuration or explicit child environment is invalid");
    options.childRoot = protectedRoot(options.childRoot);
    options.cgroupRoot = protectedRoot(options.cgroupRoot, false);
    if (options.childRoot === options.cgroupRoot || options.childRoot.startsWith(options.cgroupRoot + "/") || options.cgroupRoot.startsWith(options.childRoot + "/"))
      refusal("delegated pty file and confinement roots must be separate");
    if (statfsSync(options.cgroupRoot).type !== CGROUP2_SUPER_MAGIC ||
      readFileSync(join(options.cgroupRoot, "cgroup.type"), "utf8").trim() !== "domain")
      refusal("delegated pty requires a writable cgroup-v2 domain subtree");
    const migration = lstatSync(join(options.cgroupRoot, "cgroup.procs"));
    if (migration.uid !== 0 || (migration.mode & 0o022) !== 0)
      refusal("delegated pty confinement migration must remain root-private");
    const user = execFileSync("/usr/bin/getent", ["passwd", String(options.uid)], { encoding: "utf8" }).trim().split(":");
    if (user.length !== 7 || Number(user[2]) !== options.uid || Number(user[3]) !== options.gid || !/^[a-z_][a-z0-9_-]*$/i.test(user[0]!))
      refusal("delegated pty requires the configured passwd UID and GID");
    this.username = user[0]!;
    this.node = executable(process.execPath, options.uid, options.gid);
    this.setpriv = executable("/usr/bin/setpriv", options.uid, options.gid);
    options.cotalCommand = executable(options.cotalCommand, options.uid, options.gid, true);
    emptyUid(options.uid);
    // Check kernel creation and kill authority at boot, before the host can enroll a child.
    const probe = join(options.cgroupRoot, `cotal-check-${randomUUID()}`);
    try {
      mkdirSync(probe);
      writeFileSync(join(probe, "cgroup.kill"), "1");
      if (populated(probe)) refusal("delegated pty confinement preflight did not prove emptiness");
    } catch { refusal("delegated pty cannot create and kill a cgroup-v2 confinement"); }
    finally { if (lstatSync(probe, { throwIfNoEntry: false }) && !populated(probe)) rmdirSync(probe); }
    this.options = options;
  }

  override spawn(_name: string, _spec: LaunchSpec, _cwd: string): AgentHandle {
    return refusal("delegated pty accepts only the by-value managed handoff");
  }

  spawnDelegated(launch: DelegatedSeatLaunch, input: ManagedLifecycleHandoff): AgentHandle {
    const handoff = parseManagedLifecycleHandoff(JSON.stringify(input), input);
    const options = this.options;
    emptyUid(options.uid);
    const key = managedRuntimeKey(handoff);
    const root = join(options.childRoot, key);
    const group = join(options.cgroupRoot, key);
    // Create-only and fsynced before fork. Kept after close, so a restart cannot allocate a second child.
    try { privateFile(join(options.childRoot, ".delegated-child"), JSON.stringify({ v: 1, key }), 0, 0); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") refusal("delegated pty child allocation is already reserved");
      throw error;
    }
    const parent = openSync(options.childRoot, constants.O_RDONLY | constants.O_DIRECTORY);
    try { fsyncSync(parent); } finally { closeSync(parent); }
    let started = false;
    try {
      mkdirSync(group);
      if (!lstatSync(join(group, "cgroup.kill")).isFile() || populated(group))
        refusal("delegated pty cannot create an empty killable confinement");
      mkdirSync(root, { mode: 0o700 });
      // All paths belong to the child's new resource. No manager file is copied or named here.
      privateFile(join(root, "handoff.json"), JSON.stringify(handoff), options.uid, options.gid);
      privateFile(join(root, "persona.md"), launch.persona, options.uid, options.gid);
      const rootFd = openSync(root, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
      try { fchownSync(rootFd, options.uid, options.gid); fsyncSync(rootFd); }
      finally { closeSync(rootFd); }
      const child = delegatedSeatCommand(launch, handoff, { handoff: join(root, "handoff.json"), persona: join(root, "persona.md") });
      // Nothing is handed to the backend until confinement, material and all argv conversions exist.
      const spec: LaunchSpec = {
        command: "/bin/sh",
        args: ["-ec", JOIN_SCRIPT, "cotal-delegated-pty", group, this.setpriv,
          `--reuid=${options.uid}`, `--regid=${options.gid}`, "--clear-groups", "--inh-caps=-all",
          "--ambient-caps=-all", "--bounding-set=-all", "--no-new-privs", "--", this.node, options.cotalCommand, ...child.args],
        env: { ...options.env, ...child.env, HOME: root, USER: this.username, LOGNAME: this.username,
          COTAL_HOME: join(root, ".cotal-home"), TMPDIR: root },
      };
      started = true;
      const handle = super.spawn(handoff.actor, spec, root);
      return this.confinedHandle(handle, group, root);
    } catch (error) {
      // Unknown native spawn outcomes retain both roots. External termination must close the environment.
      if (!started || error instanceof SpawnRefused) {
        if (lstatSync(group, { throwIfNoEntry: false }) && !populated(group)) rmdirSync(group);
        rmSync(root, { recursive: true, force: true });
        throw error instanceof SpawnRefused ? error : new SpawnRefused("delegated pty refused before starting its child");
      }
      throw error;
    }
  }

  private confinedHandle(handle: AgentHandle, group: string, root: string): AgentHandle {
    let exited = false;
    let closing: Promise<void> | undefined;
    const finish = (): Promise<void> => {
      if (exited) return Promise.resolve();
      if (closing) return closing;
      closing = (async () => {
        await handle.waitForExit!();
        // The launcher is gone, so no pre-join shell can attach late. Kill every remaining descendant.
        writeFileSync(join(group, "cgroup.kill"), "1");
        const deadline = Date.now() + EXIT_PROOF_MS;
        while (populated(group)) {
          if (Date.now() >= deadline) throw new Error("delegated pty descendant exit is not proved; private root retained");
          await new Promise(resolve => setTimeout(resolve, POLL_MS));
        }
        rmdirSync(group);
        // This is the exit fact. File removal may fail independently and is retried without inventing liveness.
        exited = true;
        let retry: ReturnType<typeof setInterval> | undefined;
        const remove = () => {
          try { rmSync(root, { recursive: true, force: true }); clearInterval(retry); }
          catch (error) {
            if (!retry) console.error(`delegated pty private-file cleanup pending: ${(error as Error).message}`);
            retry ??= setInterval(remove, 5_000); retry.unref();
          }
        };
        remove();
      })().catch(error => { closing = undefined; throw error; });
      return closing;
    };
    handle.attach().onExit(() => { void finish().catch(error => console.error(`delegated pty close pending: ${(error as Error).message}`)); });
    return {
      name: handle.name, kind: handle.kind, pid: handle.pid,
      status: () => exited ? "exited" : "running",
      exitInfo: () => exited ? handle.exitInfo?.() : undefined,
      stop: options => { handle.stop(options); void finish().catch(error => console.error(`delegated pty close pending: ${(error as Error).message}`)); },
      waitForExit: finish,
      interrupt: () => handle.interrupt(),
      write: handle.write?.bind(handle),
      attach: () => {
        const session = handle.attach();
        return { ...session, get cols() { return session.cols; }, get rows() { return session.rows; }, onExit: listener => session.onExit(() => { void finish().then(listener).catch(error => console.error(`delegated pty close pending: ${(error as Error).message}`)); }) };
      },
    };
  }
}
