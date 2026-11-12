import { copyFileSync } from 'node:fs';

// Source is the debug app's already-sanitized receipt file, never process arguments or URLs.
export function startReceiptMirror(source, destination, intervalMs = 500) {
  const capture = () => {
    try { copyFileSync(source, destination); }
    catch { /* Missing diagnostics do not change the native journey. */ }
  };
  capture();
  const timer = setInterval(capture, intervalMs);
  timer.unref();
  return () => { clearInterval(timer); capture(); };
}
