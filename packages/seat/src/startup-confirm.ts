const CSI = /\x1b\[[0-?]*[ -/]*[@-~]/g;
const OSC = /\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g;
const ESC = /\x1b(?:.|$)/g;

/** Normalize terminal text according to LaunchSpec.confirm: ignore ANSI control sequences and whitespace. */
export function normalizeConfirmText(value: string): string {
  return value.replace(OSC, "").replace(CSI, "").replace(ESC, "").replace(/\s+/g, "");
}

/**
 * Matches a connector-declared startup confirmation prompt across arbitrary PTY chunks.
 * The retained text is bounded because startup TUIs can repaint indefinitely before showing a gate.
 */
export class StartupConfirmMatcher {
  private readonly needle: string;
  private raw = "";
  private matched = false;

  constructor(readonly prompt: string, private readonly maxChars = 64 * 1024) {
    this.needle = normalizeConfirmText(prompt);
    if (!this.needle) throw new Error("startup confirmation prompt is empty after ANSI and whitespace normalization");
  }

  push(chunk: string): boolean {
    if (this.matched) return false;
    this.raw += chunk;
    const text = normalizeConfirmText(this.raw);
    if (text.includes(this.needle)) {
      this.matched = true;
      return true;
    }
    if (this.raw.length > this.maxChars) this.raw = this.raw.slice(-this.maxChars);
    return false;
  }
}

export function unmatchedConfirmMessage(prompt: string, timeoutMs: number): string {
  return `Cotal startup confirmation failed: prompt ${JSON.stringify(prompt)} did not appear within ${timeoutMs}ms.`;
}
