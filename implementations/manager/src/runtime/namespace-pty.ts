import { randomUUID, randomBytes } from "node:crypto";
import { accessSync, closeSync, constants, fsyncSync, fstatSync, lstatSync, mkdirSync, openSync, readFileSync, realpathSync, renameSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { dirname, isAbsolute, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { capturePeerProcess, processStartToken, processStatFields, recoverProcess, type LinuxProcessHandle, type LinuxProcessIdentity } from "@cotal-ai/seat";
import type { AgentHandle, LaunchSpec, RuntimeReference } from "@cotal-ai/core";
import { LegacyPtyRuntime } from "./pty.js";
import { SystemdNamespaceCustody, type StoredNamespace } from "./systemd-custody.js";

interface ClosureRecord { version: 1 | 2; identity: LinuxProcessIdentity; closed: boolean; storage?: StoredNamespace }

/** Unregistered Linux containment adapter for explicit integration testing. System tools and
 * host mount policy are caller prerequisites; this does not enable automatic restart support. */
export class NamespacePtyRuntime extends LegacyPtyRuntime {
  readonly #root: string;
  readonly #bwrap: string;
  readonly #unshare: string;
  readonly #storage?: SystemdNamespaceCustody;

  constructor(root: string, tools: { bwrap: string; unshare: string }, storage?: SystemdNamespaceCustody) {
    super();
    this.#storage = storage;
    if (process.platform !== "linux" || typeof process.execve !== "function")
      throw new Error("namespace PTY requires Linux with process.execve");
    mkdirSync(root, { recursive: true, mode: 0o700 });
    this.#root = realpathSync(root);
    this.#bwrap = this.#tool(tools.bwrap);
    this.#unshare = this.#tool(tools.unshare);
    this.#privateDirectory(this.#root);
  }

  #tool(path: string): string {
    if (!isAbsolute(path)) throw new Error("namespace tool path must be absolute");
    const result = realpathSync(path);
    accessSync(result, constants.X_OK);
    if (!lstatSync(result).isFile()) throw new Error("namespace tool must be an executable file");
    return result;
  }

  #privateDirectory(path: string): void {
    const stat = lstatSync(path);
    if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== process.getuid!() || (stat.mode & 0o077) !== 0)
      throw new Error("namespace custody requires an owner-only directory");
  }

  #directory(reference: RuntimeReference): string {
    if (reference.kind !== this.kind || !/^[a-f0-9]{32}$/.test(reference.id)) throw new Error("invalid namespace custody reference");
    const path = join(this.#root, reference.id);
    this.#privateDirectory(this.#root);
    this.#privateDirectory(path);
    return path;
  }

  #save(path: string, record: ClosureRecord): void {
    const temporary = `${path}.${randomUUID()}`;
    const fd = openSync(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    try { writeFileSync(fd, JSON.stringify(record)); fsyncSync(fd); } finally { closeSync(fd); }
    renameSync(temporary, path);
    const directory = openSync(dirname(path), constants.O_RDONLY | constants.O_DIRECTORY);
    try { fsyncSync(directory); } finally { closeSync(directory); }
  }

  reserve(): RuntimeReference {
    const reference = { kind: this.kind, id: randomBytes(16).toString("hex") };
    mkdirSync(join(this.#root, reference.id), { mode: 0o700 });
    return reference;
  }

  override spawn(name: string, spec: LaunchSpec, cwd: string, reference?: RuntimeReference): AgentHandle {
    if (!reference) throw new Error("namespace PTY requires a reserved reference");
    const directory = this.#directory(reference);
    const workspace = realpathSync(cwd);
    const within = (parent: string, child: string) => { const path = relative(parent, child); return path === "" || (!path.startsWith("..") && !isAbsolute(path)); };
    if (within(workspace, this.#root)) throw new Error("custody directory must be outside the application workspace");
    const socketPath = join(directory, "b.sock");
    if (Buffer.byteLength(socketPath) > 103) throw new Error("namespace bootstrap socket path is too long");
    const nonce = randomBytes(32).toString("hex");
    const configPath = join(directory, "launch.json");
    const recordPath = join(directory, "record.json");
    const args = ["--ro-bind", "/usr", "/usr", "--symlink", "usr/bin", "/bin", "--symlink", "usr/lib", "/lib", "--symlink", "usr/lib64", "/lib64",
      "--proc", "/proc", "--dev", "/dev", "--bind", workspace, workspace, "--chdir", workspace, "--", spec.command, ...spec.args];
    // The bootstrap only receives a safe host environment. Connector env is supplied to execve
    // after custody admission, so NODE_OPTIONS cannot run connector code before admission.
    writeFileSync(configPath, JSON.stringify({ socket: socketPath, nonce, command: this.#bwrap, args, env: spec.env ?? {} }), { flag: "wx", mode: 0o600 });
    let processHandle: LinuxProcessHandle | undefined;
    let inner: AgentHandle | undefined;
    let rootBirth: string | undefined;
    let accepting = false;
    let closed = false;
    let failure: Error | undefined;
    let journal: ClosureRecord | undefined;
    let retention: Promise<void> = Promise.resolve();
    const admissionDeadline = Date.now() + 10_000;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let resolveCustody!: (handle: LinuxProcessHandle) => void;
    let rejectCustody!: (error: Error) => void;
    const custody = new Promise<LinuxProcessHandle>((resolve, reject) => { resolveCustody = resolve; rejectCustody = reject; });
    // Launch may fail before a caller requests closure; retain the failure without an unhandled rejection.
    void custody.catch(() => undefined);
    const fail = (error: Error) => {
      failure ??= error; rejectCustody(error); clearTimeout(timer); server.close();
      try { if (processHandle && !closed && !processHandle.hasExited()) processHandle.signal("SIGKILL"); }
      catch (cleanupError) { failure = new Error(`${failure.message}; namespace stop unconfirmed: ${String(cleanupError)}`); }
      inner?.stop({ graceful: false });
    };
    const server = createServer((socket) => {
      if (accepting) { socket.destroy(); return; }
      socket.setTimeout(5_000, () => { socket.destroy(); fail(new Error("namespace bootstrap admission timed out")); });
      socket.on("error", (error) => fail(error));
      let text = "";
      socket.on("data", (chunk) => {
        text += chunk.toString("utf8");
        if (text.length > 65) { socket.destroy(); fail(new Error("invalid bootstrap admission")); return; }
        if (!text.endsWith("\n")) return;
        accepting = true;
        socket.removeAllListeners("data");
        try {
          if (text !== `${nonce}\n` || !inner?.pid || !rootBirth) throw new Error("bootstrap admission identity unavailable");
          const handle = capturePeerProcess(socket);
          let bound = false;
          try {
          const fields = processStatFields(handle.identity.pid);
          const status = readFileSync(`/proc/${handle.identity.pid}/status`, "utf8");
          const nsPids = /^NSpid:\s+(.+)$/m.exec(status)?.[1]?.trim().split(/\s+/);
          if (fields?.[1] !== String(inner.pid) || processStartToken(inner.pid) !== rootBirth || nsPids?.at(-1) !== "1" || handle.hasExited())
            throw new Error("namespace PID1 custody could not be bound before execution");
          const storage = this.#storage?.prepare(reference.id, handle);
          journal = { version: storage ? 2 : 1, identity: handle.identity, closed: false, ...(storage ? { storage } : {}) };
          this.#save(recordPath, journal);
          processHandle = handle; bound = true;
          if (storage) retention = this.#storage!.retain(storage, handle);
          resolveCustody(handle);
          void retention.then(() => {
            if (failure || Date.now() >= admissionDeadline || socket.destroyed || handle.hasExited())
              throw new Error("namespace admission expired or closed before storage confirmation");
            clearTimeout(timer); socket.end("+\n"); server.close();
          }).catch(error => { socket.destroy(); fail(error as Error); });
          } finally { if (!bound) { try { if (!handle.hasExited()) handle.signal("SIGKILL"); } finally { handle.close(); } } }
        } catch (error) { socket.destroy(); fail(error as Error); }
      });
    });
    server.on("error", fail);
    server.listen(socketPath);
    const bootstrap = fileURLToPath(new URL("./namespace-bootstrap.js", import.meta.url));
    try {
      inner = super.spawn(name, { ...spec, command: this.#unshare,
        args: ["--user", "--map-root-user", "--pid", "--fork", "--kill-child=SIGKILL", "--mount-proc", process.execPath, bootstrap, configPath],
        env: { PATH: "/usr/bin:/bin", LANG: "C.UTF-8" },
      }, workspace);
      rootBirth = inner.pid === undefined ? undefined : processStartToken(inner.pid);
      if (!rootBirth) throw new Error("namespace launcher birth unavailable");
    } catch (error) { fail(error as Error); throw error; }
    const actual = inner;
    timer = setTimeout(() => fail(new Error("namespace custody admission timed out")), Math.max(0, admissionDeadline - Date.now()));
    void actual.waitForExit!().then(() => { if (!accepting) fail(new Error("launcher exited before namespace custody")); });
    const workExit = async () => {
      const handle = await custody;
      try {
        if (failure && !this.#storage) throw failure;
        await handle.waitForExit();
        // A late native request may still have an effect. Settle it, then explicitly remove
        // and verify storage before declaring the journal fully closed.
        await retention.catch(() => undefined);
        if (journal?.storage) await this.#storage!.release(journal.storage, handle.identity);
        if (!closed) { this.#save(recordPath, { ...journal!, closed: true }); closed = true; }
      } finally { handle.close(); }
    };
    // Observe from admission, even when no caller asks to wait. Ordinary manager shutdown
    // must persist the same kernel closure evidence and release the retained pidfd.
    const closure = workExit();
    void closure.catch(() => undefined);
    return { ...actual, reference,
      stop: (options) => {
        if (options?.graceful === false && processHandle && !closed && !processHandle.hasExited()) processHandle.signal("SIGKILL");
        actual.stop(options);
      },
      waitForWorkExit: () => closure,
    };
  }

  async reapWork(reference: RuntimeReference): Promise<void> {
    const directory = this.#directory(reference);
    const path = join(directory, "record.json");
    const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    let record: ClosureRecord;
    try {
      const metadata = fstatSync(fd);
      if (!metadata.isFile() || metadata.uid !== process.getuid!() || (metadata.mode & 0o077) !== 0)
        throw new Error("namespace closure record must be an owner-only regular file");
      record = JSON.parse(readFileSync(fd, "utf8")) as ClosureRecord;
    } finally { closeSync(fd); }
    const identity = record?.identity;
    if (![1, 2].includes(record?.version) || typeof record.closed !== "boolean" || !identity ||
        !Number.isSafeInteger(identity.pid) || identity.pid <= 0 || identity.pid > 0x7fffffff ||
        identity.uid !== process.getuid!() || typeof identity.birth !== "string" || !/^\d+$/.test(identity.birth) ||
        typeof identity.boot !== "string" || !/^[a-f0-9-]{36}$/.test(identity.boot) ||
        typeof identity.namespace !== "string" || !/^pid:\[\d+\]$/.test(identity.namespace))
      throw new Error("invalid namespace closure record");
    if (record.storage && record.storage.name !== `cotal-ns-${reference.id}`) throw new Error("namespace storage receipt references another launch");
    if (record.version === 2 && (!record.storage || !this.#storage)) throw new Error("namespace native service custody unavailable");
    if (record.version === 1 && record.storage) throw new Error("invalid legacy namespace storage receipt");
    if (record.closed) {
      if (record.storage) await this.#storage!.release(record.storage, record.identity);
      return;
    }
    const handle = record.storage ? await this.#storage!.recover(record.storage, record.identity) : recoverProcess(record.identity);
    try {
      if (!handle.hasExited()) {
        const status = readFileSync(`/proc/${handle.identity.pid}/status`, "utf8");
        if (/^NSpid:\s+(.+)$/m.exec(status)?.[1]?.trim().split(/\s+/).at(-1) !== "1") throw new Error("record does not bind namespace PID1");
        handle.signal("SIGKILL");
      }
      await handle.waitForExit();
      if (record.storage) await this.#storage!.release(record.storage, record.identity);
      this.#save(path, { ...record, closed: true });
    } finally { handle.close(); }
  }

  async reap(reference: RuntimeReference): Promise<{ outcome: "reaped"; detail: string }> {
    await this.reapWork(reference);
    return { outcome: "reaped", detail: "recorded namespace PID1 closure observed" };
  }
}
