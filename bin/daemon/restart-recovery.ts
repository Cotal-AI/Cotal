/** Re-enable autostart only after the caller proves one safe recovery case. Never Run here. */
export async function recoverPausedTask(observe: {
  pendingEnd: boolean;
  unchanged(): void;
  oldAnswers(): Promise<boolean>;
  absent(): Promise<void>;
  enable(): void;
}): Promise<string> {
  if (observe.pendingEnd) throw new Error("native End completion is unresolved");
  observe.unchanged();
  if (await observe.oldAnswers()) {
    observe.enable();
    return "the pinned old daemon still answers on the same connection; its owned task was re-enabled without Run";
  }
  await observe.absent();
  observe.unchanged();
  observe.enable();
  return "no daemon runs and the installation receipt is unchanged; its owned task was re-enabled without Run";
}
