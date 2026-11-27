"""A byte stream over a private Unix socket or a local Windows named pipe."""
import os
import socket
import threading

if os.name == "nt":
    import _winapi

_SECURITY_SQOS_PRESENT = 0x00100000
_SECURITY_IDENTIFICATION = 0x00010000


class PipeStream:
    def __init__(self, path: str) -> None:
        if not path.lower().startswith("\\\\.\\pipe\\"):
            raise OSError("Cotal requires a local Windows named pipe")
        # Overlapped I/O lets a blocked reader and a writer share one duplex handle. Identification
        # impersonation level allows the other end to identify us, not to act as our Windows user.
        self._handle = _winapi.CreateFile(
            path, _winapi.GENERIC_READ | _winapi.GENERIC_WRITE, 0, 0, _winapi.OPEN_EXISTING,
            _winapi.FILE_FLAG_OVERLAPPED | _SECURITY_SQOS_PRESENT | _SECURITY_IDENTIFICATION, 0,
        )
        self._lock = threading.Lock()
        self._pending = set()
        self._closed = False
        self._timeout = None
        self._prefix = b""

    def settimeout(self, seconds: float | None) -> None:
        self._timeout = None if seconds is None else max(1, int(seconds * 1000))

    def prepend(self, data: bytes) -> None:
        self._prefix = data + self._prefix

    def _transfer(self, call, data):
        with self._lock:
            if self._closed:
                raise OSError("the pipe is closed")
            op, error = call(self._handle, data, overlapped=True)
            self._pending.add(op)
        try:
            if error == _winapi.ERROR_IO_PENDING:
                wait = _winapi.WaitForSingleObject(op.event, _winapi.INFINITE if self._timeout is None else self._timeout)
                if wait != _winapi.WAIT_OBJECT_0:
                    op.cancel()
                    op.GetOverlappedResult(True)
                    raise TimeoutError("the pipe operation timed out")
            count, error = op.GetOverlappedResult(True)
            if error:
                raise OSError(f"the pipe operation failed (Windows error {error})")
            return op, count
        finally:
            with self._lock:
                self._pending.remove(op)
                if self._closed and not self._pending:
                    _winapi.CloseHandle(self._handle)

    def recv(self, size: int) -> bytes:
        if self._prefix:
            data, self._prefix = self._prefix[:size], self._prefix[size:]
            return data
        op, _ = self._transfer(_winapi.ReadFile, size)
        return op.getbuffer()

    def sendall(self, data: bytes) -> None:
        while data:
            _, written = self._transfer(_winapi.WriteFile, data)
            if not written:
                raise OSError("nothing was written to the pipe")
            data = data[written:]

    def shutdown(self, _how: int) -> None:
        self.close()

    def close(self) -> None:
        with self._lock:
            if self._closed:
                return
            self._closed = True
            for op in self._pending:
                op.cancel()
            if not self._pending:
                _winapi.CloseHandle(self._handle)


def dial(path: str, timeout: float | None = None) -> socket.socket | PipeStream:
    if os.name == "nt":
        pipe = PipeStream(path)
        pipe.settimeout(timeout)
        return pipe
    sock = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    try:
        sock.settimeout(timeout)
        sock.connect(path)
        return sock
    except OSError:
        sock.close()
        raise
