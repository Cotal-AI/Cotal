"""The control exchange, client half, in Python: the counterpart of ``@cotal-ai/core``'s
``control-exchange.ts`` for the Hermes hooks, plus the bridge token the bridge client presents.

The client and the sidecar each prove they hold the launch's control key without sending it::

    C -> S  {"v":1,"nonce":"<Nc>"}\\n
    S -> C  {"v":1,"nonce":"<Ns>","mac":"<Ms>"}\\n
    C -> S  <Mc> <request JSON>\\n
    S -> C  <Mr> <reply JSON>\\n

Nonces are 32 random bytes, base64url without padding. Every MAC is HMAC-SHA256 keyed with the
UTF-8 bytes of the key, base64url without padding, over these exact bytes (``\\0`` is one zero
byte; the request and reply are the bytes between the single space and the newline)::

    Ms = HMAC(K, "cotal-control/1\\0server\\0" Nc "\\0" Ns)
    Mc = HMAC(K, "cotal-control/1\\0client\\0" Nc "\\0" Ns "\\0" request)
    Mr = HMAC(K, "cotal-control/1\\0reply\\0"  Nc "\\0" Ns "\\0" reply)

The bridge socket does not run the exchange. Its client presents :func:`bridge_token`, derived
from the key, in its first frame, so the key crosses neither socket.

The version travels with the key (the launch material's ``controlVersion``, or
``COTAL_CONTROL_VERSION`` beside ``COTAL_CONTROL_TOKEN``), this module speaks exactly one, and a
mismatch anywhere is a refusal. Nothing is negotiated and there is no fallback.
"""
from __future__ import annotations

import base64
import hashlib
import hmac
import json
import os
import re
import secrets
import socket
import stat
import time
from typing import Any

CONTROL_PROTOCOL_VERSION = 1
# How long a client waits, from connect, for the server to prove it holds the key.
CLIENT_PROOF_DEADLINE_S = 1.0
_MAX_HANDSHAKE_LINE = 1024
_NONCE = re.compile(r"^[A-Za-z0-9_-]{43}$")
_MAC_CHARS = 43


class ControlConfigError(Exception):
    """The launch carries a control key this module cannot use (no version, or another one)."""


class ExchangeRefused(Exception):
    """The peer did not prove it holds the key, or spoke another version. Nothing it sent is used."""


def _b64(raw: bytes) -> str:
    return base64.urlsafe_b64encode(raw).rstrip(b"=").decode("ascii")


def _mac(key: str, role: str, nc: str, ns: str, body: bytes | None = None) -> str:
    msg = f"cotal-control/{CONTROL_PROTOCOL_VERSION}\0{role}\0{nc}\0{ns}".encode("ascii")
    if body is not None:
        msg += b"\0" + body
    return _b64(hmac.new(key.encode("utf-8"), msg, hashlib.sha256).digest())


def _mac_matches(presented: Any, expected: str) -> bool:
    if not isinstance(presented, str) or len(presented) != _MAC_CHARS or not presented.isascii():
        return False
    return hmac.compare_digest(presented.encode("ascii"), expected.encode("ascii"))


def bridge_token(key: str) -> str:
    """The token the bridge client presents: HMAC-SHA256 keyed with the UTF-8 bytes of the control
    key over ``cotal-hermes-bridge/<version>``, base64url without padding. Mirrors ``bridgeToken``
    in ``src/bridge.ts``; a sidecar of another version derives another token and drops the frame."""
    return _b64(hmac.new(key.encode("utf-8"), f"cotal-hermes-bridge/{CONTROL_PROTOCOL_VERSION}".encode("ascii"), hashlib.sha256).digest())


def control_key() -> str | None:
    """This launch's control key, or ``None`` when it carries none.

    A managed launch carries the key and its version in the launch material (``COTAL_LAUNCH_MATERIAL``);
    standalone mode exports ``COTAL_CONTROL_TOKEN`` and ``COTAL_CONTROL_VERSION``. Raises
    :class:`ControlConfigError` when a key comes without the version this module speaks. A material
    file readable beyond its owner is refused, as the TypeScript reader refuses it.
    """
    direct = os.environ.get("COTAL_CONTROL_TOKEN")
    if direct:
        version = os.environ.get("COTAL_CONTROL_VERSION", "")
        if version.strip() != str(CONTROL_PROTOCOL_VERSION):
            raise ControlConfigError("COTAL_CONTROL_VERSION does not name the control protocol version this plugin speaks")
        return direct
    path = os.environ.get("COTAL_LAUNCH_MATERIAL")
    if not path:
        return None
    try:
        if os.name != "nt" and (os.stat(path).st_mode & 0o077):
            return None
        with open(path, encoding="utf-8") as fh:
            material = json.load(fh)
    except (OSError, ValueError):
        return None
    if not isinstance(material, dict):
        return None
    key = material.get("controlToken")
    if not isinstance(key, str) or not key:
        return None
    if material.get("controlVersion") != CONTROL_PROTOCOL_VERSION:
        raise ControlConfigError("the launch material's controlVersion is not the control protocol version this plugin speaks")
    return key


def socket_dir_problem(path: str) -> tuple[bool, str] | None:
    """``None`` when the socket's directory is a real directory owned by this user with no group or
    other access. Otherwise ``(absent, reason)``: an absent directory reads like a server that is not
    up yet, any other failure counts as no endpoint. Checked right before every dial."""
    if os.name == "nt":
        return None
    directory = os.path.dirname(path) or "."
    try:
        st = os.lstat(directory)
    except FileNotFoundError:
        return (True, "the control socket's directory does not exist")
    except OSError as exc:
        return (False, f"the control socket's directory cannot be checked: {exc.strerror}")
    if not stat.S_ISDIR(st.st_mode) or st.st_uid != os.getuid() or (st.st_mode & 0o077):
        return (False, "the control socket's directory is not private to this user")
    return None


def _read_line(sock: socket.socket, buf: bytearray, deadline: float, cap: int | None) -> bytes:
    while b"\n" not in buf:
        remaining = deadline - time.monotonic()
        if remaining <= 0:
            raise ExchangeRefused("deadline passed before a full line arrived")
        if cap is not None and len(buf) > cap:
            raise ExchangeRefused("oversized line")
        sock.settimeout(remaining)
        try:
            chunk = sock.recv(65536)
        except socket.timeout as exc:
            raise ExchangeRefused("deadline passed before a full line arrived") from exc
        if not chunk:
            raise ExchangeRefused("the connection closed before a full line arrived")
        buf.extend(chunk)
    line, _, rest = bytes(buf).partition(b"\n")
    buf[:] = rest
    return line


class ClientExchange:
    """One client exchange on a connected socket. :meth:`open` proves both ends and sends the
    request; :meth:`reply` reads and verifies the one MAC'd reply (control socket only)."""

    def __init__(self, sock: socket.socket, key: str) -> None:
        self._sock = sock
        self._key = key
        self._nc = _b64(secrets.token_bytes(32))
        self._ns = ""
        self._buf = bytearray()

    def open(self, request: dict) -> None:
        deadline = time.monotonic() + CLIENT_PROOF_DEADLINE_S
        self._sock.sendall((json.dumps({"v": CONTROL_PROTOCOL_VERSION, "nonce": self._nc}) + "\n").encode("ascii"))
        line = _read_line(self._sock, self._buf, deadline, _MAX_HANDSHAKE_LINE)
        try:
            hello = json.loads(line)
        except ValueError as exc:
            raise ExchangeRefused("the server's challenge is not JSON") from exc
        if not isinstance(hello, dict) or hello.get("v") != CONTROL_PROTOCOL_VERSION:
            raise ExchangeRefused("the server speaks another control protocol version")
        ns = hello.get("nonce")
        if not isinstance(ns, str) or not _NONCE.match(ns):
            raise ExchangeRefused("the server's nonce is malformed")
        if not _mac_matches(hello.get("mac"), _mac(self._key, "server", self._nc, ns)):
            raise ExchangeRefused("the server did not prove it holds the key")
        self._ns = ns
        body = json.dumps(request).encode("utf-8")
        self._sock.sendall(_mac(self._key, "client", self._nc, ns, body).encode("ascii") + b" " + body + b"\n")

    def reply(self, timeout_s: float) -> bytes:
        line = _read_line(self._sock, self._buf, time.monotonic() + timeout_s, None)
        mac, sep, body = line.partition(b" ")
        if not sep or len(mac) != _MAC_CHARS or not _mac_matches(mac.decode("ascii", "replace"), _mac(self._key, "reply", self._nc, self._ns, body)):
            raise ExchangeRefused("the reply's MAC does not verify")
        return body
