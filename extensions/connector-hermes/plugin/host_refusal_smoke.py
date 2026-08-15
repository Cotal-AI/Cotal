"""A REFUSAL MUST REACH THE HOST AS A FAILURE — Hermes adapter.

SCOPE, AND IT IS IN EVERY CELL NAME RATHER THAN ONLY HERE: this drives the real
``BridgeClient.call_tool`` and the real registered tool handler over a stub UNIX socket speaking the
sidecar's own frame protocol. **The Hermes HOST is not run**, and neither is the TypeScript sidecar.
So these cells are evidence about the adapter's contract and nothing about how Hermes presents a
raised exception. A cell named as though it measured the host, that measured the function, is a
false claim someone will cite without opening the file.

WHY: the sidecar sends ``isError`` across the socket intact, and this client used to flatten it into
``f"⚠ {text}"`` — an ordinary successful return — while the tool handler additionally caught every
exception and returned ``f"cotal error: {e}"``. Two layers, each turning a failure into a value.

REFUTATION CONDITIONS, before any result is cited:
  - REFUTED if the refusal arm returns a string instead of raising, or if the control arm raises
    (then the probe cannot tell a refusal from any other failure and its raises mean nothing).
  - REFUTED if the stub never receives a ``tool`` frame — the client would not be talking to it and
    the arms would be measuring the stub, not the adapter.

Run: python3 extensions/connector-hermes/plugin/host_refusal_smoke.py
Local-only: a UNIX socket in a temp dir. No broker, no network.
"""
import json
import os
import socket
import sys
import tempfile
import threading

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from cotal.bridge_client import BridgeClient, CotalToolError  # noqa: E402

PASS = 0
FAIL = 0
RAN = []
DECLARED = ["HB-frame", "HB-ctl", "HB1", "HB2"]


def check(name, cond, extra=None):
    global PASS, FAIL
    RAN.append(name)
    if cond:
        PASS += 1
        print(f"  ✓ {name}")
    else:
        FAIL += 1
        print(f"  ✗ FAIL: {name} {extra if extra is not None else ''}")


def roll_call():
    evaluated = [i for i in DECLARED if any(n == i or n.startswith(i + " ") for n in RAN)]
    missing = [i for i in DECLARED if i not in evaluated]
    undeclared = [n for n in RAN if not any(n == i or n.startswith(i + " ") for i in DECLARED)]
    print(f"\n  ROLL CALL: {len(DECLARED)} declared — {len(evaluated)} EVALUATED, {len(missing)} NEVER RAN.")
    if missing:
        print(f"  ⚠ NEVER RAN: {', '.join(missing)}")
    if undeclared:
        print(f"  ⚠ UNDECLARED: {' | '.join(undeclared)}")
    if not missing and not undeclared:
        print(f"  ✓ all {len(DECLARED)} declared cells were EVALUATED.")
    return not missing and not undeclared


def main():
    tmp = tempfile.mkdtemp(prefix="cotal-hermes-refusal-")
    path = os.path.join(tmp, "bridge.sock")
    srv = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    srv.bind(path)
    srv.listen(1)
    seen = []
    connected = threading.Event()

    def serve():
        conn, _ = srv.accept()
        connected.set()
        buf = b""
        while True:
            data = conn.recv(65536)
            if not data:
                return
            buf += data
            while b"\n" in buf:
                line, buf = buf.split(b"\n", 1)
                if not line.strip():
                    continue
                frame = json.loads(line)
                if frame.get("t") != "tool":
                    continue
                seen.append(frame)
                # The sidecar's real reply shape: transport ok, logical failure flagged separately.
                is_error = frame.get("name") == "cotal_disconnect" and len(seen) > 1
                reply = {
                    "t": "tool_result", "id": frame["id"], "ok": True,
                    "text": "Refused [not-connected]: this session is already off the mesh" if is_error
                            else 'Disconnected from "probe" ✓ (cause: requested).',
                    "isError": is_error,
                }
                conn.sendall((json.dumps(reply) + "\n").encode())

    threading.Thread(target=serve, daemon=True).start()

    client = BridgeClient(path)
    client.start(lambda _msg: None)
    # The client's reader thread dials asynchronously and a write before that lands is dropped, so
    # the first call would time out against a socket nobody had accepted yet — an artefact of this
    # probe, not of the adapter. Wait for the accept, with a bound, so a hang is a measured result.
    if not connected.wait(10):
        raise RuntimeError("the bridge client never connected to the stub socket")

    ctl = client.call_tool("cotal_disconnect", {})
    check("HB-ctl CONTROL: a SUCCEEDING tool returns its text through the real call_tool (Hermes host not driven) — so HB1's arms can differ",
          isinstance(ctl, str) and "Disconnected" in ctl, ctl)

    raised = None
    try:
        client.call_tool("cotal_disconnect", {})
    except CotalToolError as e:
        raised = e
    check("HB1 a REFUSAL raises through the real call_tool (Hermes host not driven) — it was returning a prefixed ordinary value, which is a success",
          raised is not None, raised)
    check("HB2 the raised error carries the named condition (Hermes host not driven)",
          raised is not None and "[not-connected]" in str(raised), str(raised))

    check("HB-frame the stub actually received the adapter's tool frames, so the arms above measured the client and not this file",
          len(seen) == 2 and all(f.get("name") == "cotal_disconnect" for f in seen), seen)

    client.close()
    srv.close()
    ok = roll_call()
    verdict = "OK ✅" if FAIL == 0 and ok else "FAILED ❌"
    print(f"\nHERMES HOST-REFUSAL {verdict}  ({PASS} passed, {FAIL} failed)")
    return 0 if FAIL == 0 and ok else 1


if __name__ == "__main__":
    sys.exit(main())
