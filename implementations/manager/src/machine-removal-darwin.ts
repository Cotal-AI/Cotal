import { darwinBootSession, processStartTime } from "@cotal-ai/seat";
type Phase = "prepare" | "stop" | "abort";
interface RemovalModule {
  parseDarwinRemovalFrame(raw: unknown): { phase: Phase } | undefined;
  createDarwinManagerRemoval(): (frame: { phase: Phase }, authorized: () => boolean) => Promise<number>;
}

/** Attach only from the existing machine-parent composition root, never from a runtime provider. */
export function listenForDarwinMachineRemoval(): void {
  if (process.platform !== "darwin" || !process.connected) return;
  const pid = process.ppid;
  let start: string | undefined, boot: string;
  try { start = processStartTime(pid); boot = darwinBootSession(); }
  catch { return; }
  const authorized = () => Boolean(start && pid > 1 && process.connected && process.ppid === pid &&
    processStartTime(pid) === start && darwinBootSession() === boot);
  let pending = Promise.resolve();
  let remove: ReturnType<RemovalModule["createDarwinManagerRemoval"]> | undefined;
  process.on("message", (raw: unknown) => {
    if (!raw || typeof raw !== "object" || !("kind" in raw) || raw.kind !== "machine-hosted-pty-remove" ||
        !("attemptId" in raw) || typeof raw.attemptId !== "string" || !/^[a-f0-9]{24}$/.test(raw.attemptId)) return;
    const { attemptId } = raw;
    const kind = "machine-hosted-pty-remove-result";
    pending = pending.then(async () => {
      try {
        if (!authorized()) throw new Error("unverified machine parent");
        const path = new URL("./shared-removal-darwin.js", import.meta.resolve("@cotal-ai/seat"));
        const { createDarwinManagerRemoval, parseDarwinRemovalFrame } = await import(path.href) as RemovalModule;
        const frame = parseDarwinRemovalFrame(raw);
        if (!frame) throw new Error("invalid removal request");
        remove ??= createDarwinManagerRemoval();
        const count = await remove(frame, authorized);
        process.send?.({ kind, attemptId, phase: frame.phase, ok: true, count });
      } catch {
        if (process.connected) process.send?.({ kind, attemptId, ok: false, error: "machine-hosted-pty-remove could not verify incumbent PTY custody" });
      }
    }).catch(() => {});
  });
}
