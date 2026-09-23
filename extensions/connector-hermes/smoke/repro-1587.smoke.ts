/**
 * Repro for issue #1587:
 * bare except OSError around retired-socket close hides a failure no cell observes.
 *
 * Checks:
 * 1. Diagnostic on failed close in reopen(): when sock.close() raises OSError, a named
 *    diagnostic is emitted rather than silenced with a bare `pass`.
 * 2. Diagnostic on failed close in _connect(): when dial-fence s.close() raises OSError,
 *    a named diagnostic is emitted rather than silenced with a bare `pass`.
 * 3. Diagnostic on failed close in close(): when sock.close() raises OSError, a named
 *    diagnostic is emitted rather than silenced with a bare `pass`.
 * 4. Retired reader exit after reopen(): after reopen(), the retired reader thread has exited.
 *
 * Prints one clear final line saying whether the defect is present.
 *
 * Run: tsx smoke/repro-1587.smoke.ts (inside @cotal-ai/connector-hermes)
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

if (process.platform === "win32") {
  console.log("✓ repro-1587 smoke skipped on Windows (the Hermes connector is Unix-only)");
  console.log("defect is present: false");
  process.exit(0);
}

const pkgDir = fileURLToPath(new URL("..", import.meta.url));
const python = ["python3", "python"].find((bin) => spawnSync(bin, ["-c", ""], { stdio: "ignore" }).status === 0);
assert.ok(python, "no python3/python on PATH");

const pythonScript = String.raw`
import sys, os, socket, tempfile, threading, time, io

sys.path.insert(0, os.path.join(sys.argv[1], "plugin"))
from cotal.bridge_client import BridgeClient

tmp = tempfile.mkdtemp()
sock_path = os.path.join(tmp, "repro.sock")
srv = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
srv.bind(sock_path)
srv.listen(16)

def accept_loop():
    while True:
        try:
            srv.accept()
        except OSError:
            break

threading.Thread(target=accept_loop, daemon=True).start()

def wait_connected(c, timeout=2.0):
    deadline = time.time() + timeout
    while time.time() < deadline:
        with c._lock:
            if c._sock is not None:
                return True
        time.sleep(0.01)
    return False

# Check 1: reopen() retired reader thread exits
client = BridgeClient(sock_path)
client.start(lambda m: None)
wait_connected(client)
reader = client._reader
reader_alive_before = reader is not None and reader.is_alive()
client.reopen()
reader.join(timeout=2.0)
reader_exited = reader is not None and not reader.is_alive()

# Check 2: reopen() close failure diagnostic
client2 = BridgeClient(sock_path)
client2.start(lambda m: None)
wait_connected(client2)

class FailingReopenSocket:
    def __init__(self, s):
        self._s = s
    def __getattr__(self, name):
        return getattr(self._s, name)
    def shutdown(self, how):
        if self._s is not None:
            return self._s.shutdown(how)
        return None
    def close(self):
        raise OSError("reopen close failed: test error")

with client2._lock:
    client2._sock = FailingReopenSocket(client2._sock)

captured_reopen = io.StringIO()
old_stderr = sys.stderr
sys.stderr = captured_reopen
try:
    client2.reopen()
finally:
    sys.stderr = old_stderr

reopen_stderr = captured_reopen.getvalue()
reopen_diag_present = "[cotal-hermes]" in reopen_stderr and "failed to close" in reopen_stderr

# Check 3: _connect() dial-fence close failure diagnostic
client3 = BridgeClient(sock_path)
real_socket = socket.socket
class FailingDialSocket:
    def __init__(self, *args, **kwargs):
        self._s = real_socket(*args, **kwargs)
    def __getattr__(self, name):
        return getattr(self._s, name)
    def connect(self, addr):
        res = self._s.connect(addr)
        client3._gen += 1  # retire between dial and assignment
        return res
    def close(self):
        raise OSError("dial fence close failed: test error")

def dial_socket_ctor(*args, **kwargs):
    return FailingDialSocket(*args, **kwargs)

socket.socket = dial_socket_ctor
captured_dial = io.StringIO()
sys.stderr = captured_dial
try:
    client3._connect(client3._gen)
finally:
    socket.socket = real_socket
    sys.stderr = old_stderr

dial_stderr = captured_dial.getvalue()
dial_diag_present = "[cotal-hermes]" in dial_stderr and "failed to close" in dial_stderr

# Check 4: close() failure diagnostic
client4 = BridgeClient(sock_path)
client4.start(lambda m: None)
wait_connected(client4)
with client4._lock:
    client4._sock = FailingReopenSocket(client4._sock)
captured_close = io.StringIO()
sys.stderr = captured_close
try:
    client4.close()
finally:
    sys.stderr = old_stderr

close_stderr = captured_close.getvalue()
close_diag_present = "[cotal-hermes]" in close_stderr and "failed to close" in close_stderr

srv.close()

print(f"READER_ALIVE_BEFORE {reader_alive_before}")
print(f"READER_EXITED {reader_exited}")
print(f"REOPEN_DIAG_PRESENT {reopen_diag_present}")
print(f"DIAL_DIAG_PRESENT {dial_diag_present}")
print(f"CLOSE_DIAG_PRESENT {close_diag_present}")
`;

const res = spawnSync(python!, ["-c", pythonScript, pkgDir], { encoding: "utf8" });
assert.equal(res.status, 0, `python probe failed:\n${res.stdout}\n${res.stderr}`);

const rows = Object.fromEntries(
  res.stdout
    .split("\n")
    .filter((l) => /^[A-Z_]+ /.test(l))
    .map((line) => {
      const i = line.indexOf(" ");
      return [line.slice(0, i), line.slice(i + 1).trim()];
    }),
);

console.log("repro-1587 probe output:", rows);

// The defect is present if any of the close failure diagnostics is missing (silenced with pass)
// or if the retired reader thread fails to exit.
const defectPresent =
  rows.READER_EXITED !== "True" ||
  rows.REOPEN_DIAG_PRESENT !== "True" ||
  rows.DIAL_DIAG_PRESENT !== "True" ||
  rows.CLOSE_DIAG_PRESENT !== "True";

console.log(`defect is present: ${defectPresent}`);
assert.equal(defectPresent, false, "defect is present: retired socket close failure was silenced without diagnostic or retired reader did not exit");

