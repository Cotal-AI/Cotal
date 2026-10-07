import { LoopLagMeter } from "./watchdog.js";

/** Delivery's broker coupling, driven by the resident NATS connection rather than a second
 * authenticated connection. A successful credential adoption counts only after the caller has
 * proved it against the broker; a disconnected socket cannot be made healthy by an adoption. */
export class DeliveryTransportHealth {
  private connected = true;
  private disconnectedAt = 0;
  private lag = new LoopLagMeter(250);
  private timer: ReturnType<typeof setInterval> | undefined;
  private stopped = false;
  private expired = false;

  constructor(
    private readonly onGone: (reason: "broker-gone" | "backstop" | "credential-expired") => void,
    private readonly onCredentialExpired: () => void,
    private readonly windowMs = 15_000,
    private readonly backstopMs = windowMs * 4,
    private readonly now: () => number = Date.now,
  ) {
    if (windowMs <= 0 || backstopMs < windowMs) throw new Error("invalid delivery broker health windows");
  }

  /** The endpoint's own current-epoch `transport` edge, including initial connection, reconnect,
   * expiry close and terminal close. No timer and no dial run while it is connected. */
  transport(connected: boolean): void {
    if (this.stopped) return;
    if (connected) {
      this.connected = true;
      if (this.expired) return; // a stale JWT can reconnect briefly before the broker closes it again
      this.disconnectedAt = 0;
      this.clear();
      return;
    }
    if (!this.connected) return;
    this.connected = false;
    if (!this.disconnectedAt) this.disconnectedAt = this.now();
    this.armTimer();
  }

  /** Called only after the real credential-adoption operation succeeded. A preflight failure,
   * file change, or merely queued adoption must never reset the broker-loss clock. */
  adopted(): void {
    if (this.stopped || !this.connected) return;
    this.expired = false;
    this.disconnectedAt = 0;
    this.lag.reset();
    this.clear();
  }

  /** NATS reports authentication expiry as an explicit status error before its disconnect edge.
   * Surface it immediately, leave room for renewal, and never call it broker unavailability. */
  credentialExpired(): void {
    if (this.stopped || this.expired) return;
    this.expired = true;
    if (!this.disconnectedAt) this.disconnectedAt = this.now();
    this.armTimer();
    this.onCredentialExpired();
  }

  private armTimer(): void {
    if (this.timer !== undefined) return;
    this.lag = new LoopLagMeter(250);
    this.lag.tick(this.now());
    this.timer = setInterval(() => this.evaluate(), 250);
    this.timer.unref?.();
  }

  private evaluate(): void {
    if ((this.connected && !this.expired) || this.stopped) return;
    const now = this.now();
    this.lag.tick(now);
    const elapsed = now - this.disconnectedAt;
    if (elapsed < this.windowMs) return;
    if (this.expired) {
      if (elapsed >= this.backstopMs) {
        this.clear();
        this.stopped = true;
        this.onGone("credential-expired");
      }
      return;
    }
    // A late local callback is not evidence that the broker spent that time unavailable. The
    // absolute backstop still prevents indefinite survival after a real disconnect.
    const reason = elapsed >= this.backstopMs ? "backstop" : elapsed - this.lag.starvedMsWithin(elapsed) >= this.windowMs ? "broker-gone" : undefined;
    if (reason) {
      this.clear();
      this.stopped = true;
      this.onGone(reason);
    }
  }

  stop(): void {
    this.stopped = true;
    this.clear();
  }

  private clear(): void {
    if (this.timer !== undefined) clearInterval(this.timer);
    this.timer = undefined;
  }
}
