/*
 * The Windows primitives the local daemon endpoint needs and Node does not expose.
 *
 * Node's own pipe server (libuv) creates every instance with a NULL security descriptor, whose
 * default DACL lets Everyone and Anonymous open it for reading, and without
 * PIPE_REJECT_REMOTE_CLIENTS; its client opens with no security quality of service. So the pipe is
 * created, connected and authenticated here, and only a connection whose peer process token is this
 * user is handed to Node, as a libuv descriptor that `net.Socket({ fd })` adopts:
 *
 *  - every instance carries the protected DACL D:P(A;;GRGW;;;<this user's SID>), so no other
 *    account, Anonymous, a network logon or an AppContainer can open it, and the unlabeled object's
 *    default no-write-up policy keeps low-integrity processes out;
 *  - the first instance is created with FILE_FLAG_FIRST_PIPE_INSTANCE, so a name that anything
 *    already serves (a squatter or a second daemon) is refused instead of shared;
 *  - every instance sets PIPE_REJECT_REMOTE_CLIENTS;
 *  - the next instance exists before a connected one is handed off, so the name never lapses;
 *  - the server reads the client's pid with GetNamedPipeClientProcessId, and the client the server's
 *    with GetNamedPipeServerProcessId, then each reads that process's token user and creation time
 *    through a handle to the process object before a byte of the protocol moves;
 *  - the client opens with SECURITY_SQOS_PRESENT | SECURITY_IDENTIFICATION, so the server it reaches
 *    can identify it but never act as it.
 *
 * Handles are overlapped and not inheritable, and are never bound to an I/O completion port here,
 * so libuv can bind them to its own.
 *
 * Also: the exclusive lifetime lock (LockFileEx on one byte at 1 GiB, outside the record a client
 * reads, released by the system when the holder dies), a process's creation time, this process's
 * user SID, and a directory's owner and DACL read through a handle that does not follow reparse
 * points.
 */
#include <uv.h>
#include <sddl.h>
#include <aclapi.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <node_api.h>

#define PIPE_BUFFER 65536
#define LOCK_OFFSET 0x40000000u

/* ---- errors ---- */

static napi_value win32_error(napi_env env, const char* step, DWORD err) {
  const char* code = NULL;
  switch (err) {
    case ERROR_FILE_NOT_FOUND:
    case ERROR_PATH_NOT_FOUND: code = "ENOENT"; break;
    case ERROR_ACCESS_DENIED: code = "EACCES"; break;
    case ERROR_PIPE_BUSY:
    case ERROR_SEM_TIMEOUT: code = "ETIMEDOUT"; break;
    case ERROR_OPERATION_ABORTED: code = "ECANCELED"; break;
    default: break;
  }
  char text[256] = "";
  FormatMessageA(FORMAT_MESSAGE_FROM_SYSTEM | FORMAT_MESSAGE_IGNORE_INSERTS, NULL, err, 0, text, sizeof(text), NULL);
  size_t n = strlen(text);
  while (n > 0 && (text[n - 1] == '\r' || text[n - 1] == '\n' || text[n - 1] == '.')) text[--n] = '\0';
  char msg[384];
  snprintf(msg, sizeof(msg), "%s failed: %s (Windows error %lu)", step, text, (unsigned long)err);
  char fallback[16];
  snprintf(fallback, sizeof(fallback), "WIN32_%lu", (unsigned long)err);
  napi_value c, m, e, v;
  napi_create_string_utf8(env, code ? code : fallback, NAPI_AUTO_LENGTH, &c);
  napi_create_string_utf8(env, msg, NAPI_AUTO_LENGTH, &m);
  napi_create_error(env, c, m, &e);
  napi_create_uint32(env, err, &v);
  napi_set_named_property(env, e, "errno", v);
  napi_create_string_utf8(env, step, NAPI_AUTO_LENGTH, &v);
  napi_set_named_property(env, e, "syscall", v);
  return e;
}

static napi_value throw_win32(napi_env env, const char* step, DWORD err) {
  napi_throw(env, win32_error(env, step, err));
  return NULL;
}

/* ---- identity ---- */

typedef union {
  TOKEN_USER user;
  BYTE raw[sizeof(TOKEN_USER) + SECURITY_MAX_SID_SIZE];
} token_user_buf;

/* The token user of `token` as an S-1-... string, LocalAlloc-ed into *sid. */
static DWORD token_sid(HANDLE token, LPWSTR* sid, const char** step) {
  token_user_buf buf;
  DWORD len = 0;
  if (!GetTokenInformation(token, TokenUser, &buf, sizeof(buf), &len)) { *step = "GetTokenInformation"; return GetLastError(); }
  if (!ConvertSidToStringSidW(buf.user.User.Sid, sid)) { *step = "ConvertSidToStringSidW"; return GetLastError(); }
  return 0;
}

static ULONGLONG filetime64(FILETIME t) {
  return ((ULONGLONG)t.dwHighDateTime << 32) | t.dwLowDateTime;
}

/* The token user and creation time of process `pid`, both read through one handle to the process
 * object, so they describe the same process even if the pid is reused later. */
static DWORD process_identity(DWORD pid, LPWSTR* sid, ULONGLONG* birth, const char** step) {
  HANDLE proc = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, FALSE, pid);
  if (proc == NULL) { *step = "OpenProcess"; return GetLastError(); }
  DWORD err = 0;
  HANDLE token = NULL;
  FILETIME created, exited, kernel, user;
  if (!GetProcessTimes(proc, &created, &exited, &kernel, &user)) { *step = "GetProcessTimes"; err = GetLastError(); goto done; }
  if (!OpenProcessToken(proc, TOKEN_QUERY, &token)) { *step = "OpenProcessToken"; err = GetLastError(); goto done; }
  err = token_sid(token, sid, step);
  if (err == 0) *birth = filetime64(created);
done:
  if (token != NULL) CloseHandle(token);
  CloseHandle(proc);
  return err;
}

static napi_value utf16(napi_env env, const wchar_t* s) {
  napi_value out;
  napi_create_string_utf16(env, (const char16_t*)s, NAPI_AUTO_LENGTH, &out);
  return out;
}

static napi_value birth_string(napi_env env, ULONGLONG birth) {
  char buf[32];
  snprintf(buf, sizeof(buf), "%llu", birth);
  napi_value out;
  napi_create_string_utf8(env, buf, NAPI_AUTO_LENGTH, &out);
  return out;
}

/* { fd, pid, user, birth } for a verified connection. */
static napi_value peer_object(napi_env env, int fd, DWORD pid, const wchar_t* sid, ULONGLONG birth) {
  napi_value out, v;
  napi_create_object(env, &out);
  napi_create_int32(env, fd, &v);
  napi_set_named_property(env, out, "fd", v);
  napi_create_uint32(env, pid, &v);
  napi_set_named_property(env, out, "pid", v);
  napi_set_named_property(env, out, "user", utf16(env, sid));
  napi_set_named_property(env, out, "birth", birth_string(env, birth));
  return out;
}

static DWORD current_sid(LPWSTR* sid, const char** step) {
  HANDLE token = NULL;
  if (!OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &token)) { *step = "OpenProcessToken"; return GetLastError(); }
  DWORD err = token_sid(token, sid, step);
  CloseHandle(token);
  return err;
}

/* Read a JS string argument as a NUL-terminated UTF-16 string, malloc-ed. */
static wchar_t* arg_utf16(napi_env env, napi_value value) {
  size_t len = 0;
  if (napi_get_value_string_utf16(env, value, NULL, 0, &len) != napi_ok || len == 0 || len > 32767) {
    napi_throw_type_error(env, NULL, "a non-empty string is required");
    return NULL;
  }
  wchar_t* out = (wchar_t*)malloc((len + 1) * sizeof(wchar_t));
  if (out == NULL) { napi_throw_error(env, NULL, "out of memory"); return NULL; }
  napi_get_value_string_utf16(env, value, (char16_t*)out, len + 1, &len);
  return out;
}

static napi_value CurrentUserSid(napi_env env, napi_callback_info info) {
  (void)info;
  LPWSTR sid = NULL;
  const char* step = "";
  DWORD err = current_sid(&sid, &step);
  if (err) return throw_win32(env, step, err);
  napi_value out = utf16(env, sid);
  LocalFree(sid);
  return out;
}

/* The creation time of process `pid` in 100 ns units since 1601, or undefined when no such
 * process exists. */
static napi_value ProcessStartTime(napi_env env, napi_callback_info info) {
  size_t argc = 1;
  napi_value argv[1];
  napi_get_cb_info(env, info, &argc, argv, NULL, NULL);
  int32_t pid = 0;
  if (argc < 1 || napi_get_value_int32(env, argv[0], &pid) != napi_ok || pid <= 0) {
    napi_throw_type_error(env, NULL, "pid must be a positive integer");
    return NULL;
  }
  napi_value out;
  HANDLE proc = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, FALSE, (DWORD)pid);
  if (proc == NULL) {
    DWORD err = GetLastError();
    if (err == ERROR_INVALID_PARAMETER) { napi_get_undefined(env, &out); return out; }
    return throw_win32(env, "OpenProcess", err);
  }
  FILETIME created, exited, kernel, user;
  BOOL ok = GetProcessTimes(proc, &created, &exited, &kernel, &user);
  DWORD err = ok ? 0 : GetLastError();
  CloseHandle(proc);
  if (!ok) return throw_win32(env, "GetProcessTimes", err);
  return birth_string(env, filetime64(created));
}

/* ---- lifetime lock ---- */

/* LockFileEx(LOCKFILE_EXCLUSIVE_LOCK | LOCKFILE_FAIL_IMMEDIATELY) on one byte at 1 GiB of the file
 * open at libuv descriptor `fd`. True when this process now holds it, false when another handle
 * does. The byte lies past any record, so the lock never blocks a reader of the record. */
static napi_value LockExclusiveNb(napi_env env, napi_callback_info info) {
  size_t argc = 1;
  napi_value argv[1];
  napi_get_cb_info(env, info, &argc, argv, NULL, NULL);
  int32_t fd = 0;
  if (argc < 1 || napi_get_value_int32(env, argv[0], &fd) != napi_ok) {
    napi_throw_type_error(env, NULL, "fd must be an integer");
    return NULL;
  }
  HANDLE h = uv_get_osfhandle(fd);
  if (h == INVALID_HANDLE_VALUE) return throw_win32(env, "uv_get_osfhandle", ERROR_INVALID_HANDLE);
  OVERLAPPED ov;
  memset(&ov, 0, sizeof(ov));
  ov.Offset = LOCK_OFFSET;
  napi_value out;
  if (LockFileEx(h, LOCKFILE_EXCLUSIVE_LOCK | LOCKFILE_FAIL_IMMEDIATELY, 0, 1, 0, &ov)) {
    napi_get_boolean(env, true, &out);
    return out;
  }
  DWORD err = GetLastError();
  if (err == ERROR_LOCK_VIOLATION) {
    napi_get_boolean(env, false, &out);
    return out;
  }
  return throw_win32(env, "LockFileEx", err);
}

/* ---- directory security ---- */

/* { directory, reparse, owner, aces } of `path`, read through a handle opened with
 * FILE_FLAG_OPEN_REPARSE_POINT, so a junction or symlink is reported as itself and never followed.
 * `aces` is null for a NULL DACL (which grants everyone everything); each entry is
 * { type, flags, mask, sid } with `sid` null for ACE types other than allow and deny. */
static napi_value InspectDir(napi_env env, napi_callback_info info) {
  size_t argc = 1;
  napi_value argv[1];
  napi_get_cb_info(env, info, &argc, argv, NULL, NULL);
  if (argc < 1) { napi_throw_type_error(env, NULL, "path required"); return NULL; }
  wchar_t* path = arg_utf16(env, argv[0]);
  if (path == NULL) return NULL;
  HANDLE h = CreateFileW(path, READ_CONTROL | FILE_READ_ATTRIBUTES, FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE, NULL,
                         OPEN_EXISTING, FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT, NULL);
  free(path);
  if (h == INVALID_HANDLE_VALUE) return throw_win32(env, "CreateFileW", GetLastError());
  BY_HANDLE_FILE_INFORMATION fi;
  if (!GetFileInformationByHandle(h, &fi)) {
    DWORD err = GetLastError();
    CloseHandle(h);
    return throw_win32(env, "GetFileInformationByHandle", err);
  }
  PSID owner = NULL;
  PACL dacl = NULL;
  PSECURITY_DESCRIPTOR sd = NULL;
  DWORD err = GetSecurityInfo(h, SE_FILE_OBJECT, OWNER_SECURITY_INFORMATION | DACL_SECURITY_INFORMATION, &owner, NULL, &dacl, NULL, &sd);
  CloseHandle(h);
  if (err != ERROR_SUCCESS) return throw_win32(env, "GetSecurityInfo", err);

  napi_value out, v, aces;
  napi_create_object(env, &out);
  napi_get_boolean(env, (fi.dwFileAttributes & FILE_ATTRIBUTE_DIRECTORY) != 0, &v);
  napi_set_named_property(env, out, "directory", v);
  napi_get_boolean(env, (fi.dwFileAttributes & FILE_ATTRIBUTE_REPARSE_POINT) != 0, &v);
  napi_set_named_property(env, out, "reparse", v);
  LPWSTR s = NULL;
  if (owner != NULL && ConvertSidToStringSidW(owner, &s)) {
    napi_set_named_property(env, out, "owner", utf16(env, s));
    LocalFree(s);
  } else {
    napi_get_null(env, &v);
    napi_set_named_property(env, out, "owner", v);
  }
  if (dacl == NULL) {
    napi_get_null(env, &aces);
  } else {
    napi_create_array_with_length(env, dacl->AceCount, &aces);
    for (DWORD i = 0; i < dacl->AceCount; i++) {
      ACE_HEADER* ace = NULL;
      if (!GetAce(dacl, i, (LPVOID*)&ace)) { err = GetLastError(); LocalFree(sd); return throw_win32(env, "GetAce", err); }
      napi_value entry;
      napi_create_object(env, &entry);
      napi_create_uint32(env, ace->AceType, &v);
      napi_set_named_property(env, entry, "type", v);
      napi_create_uint32(env, ace->AceFlags, &v);
      napi_set_named_property(env, entry, "flags", v);
      if (ace->AceType == ACCESS_ALLOWED_ACE_TYPE || ace->AceType == ACCESS_DENIED_ACE_TYPE) {
        /* ACCESS_ALLOWED_ACE and ACCESS_DENIED_ACE share one layout. */
        ACCESS_ALLOWED_ACE* a = (ACCESS_ALLOWED_ACE*)ace;
        napi_create_uint32(env, a->Mask, &v);
        napi_set_named_property(env, entry, "mask", v);
        if (ConvertSidToStringSidW((PSID)&a->SidStart, &s)) {
          napi_set_named_property(env, entry, "sid", utf16(env, s));
          LocalFree(s);
        } else {
          err = GetLastError();
          LocalFree(sd);
          return throw_win32(env, "ConvertSidToStringSidW", err);
        }
      } else {
        napi_get_null(env, &v);
        napi_set_named_property(env, entry, "sid", v);
        napi_create_uint32(env, 0, &v);
        napi_set_named_property(env, entry, "mask", v);
      }
      napi_set_element(env, aces, i, entry);
    }
  }
  napi_set_named_property(env, out, "aces", aces);
  LocalFree(sd);
  return out;
}

/* ---- pipe server ---- */

typedef struct {
  wchar_t* name;
  PSECURITY_DESCRIPTOR sd;
  /* The instance waiting for the next client, or INVALID_HANDLE_VALUE. */
  HANDLE pending;
  /* Manual-reset event set by close(), which a waiting accept also waits on. */
  HANDLE cancel;
  int accepting;
  int closed;
} listener_t;

static HANDLE create_instance(listener_t* l, BOOL first) {
  SECURITY_ATTRIBUTES sa;
  sa.nLength = sizeof(sa);
  sa.lpSecurityDescriptor = l->sd;
  sa.bInheritHandle = FALSE;
  return CreateNamedPipeW(l->name,
                          PIPE_ACCESS_DUPLEX | FILE_FLAG_OVERLAPPED | (first ? FILE_FLAG_FIRST_PIPE_INSTANCE : 0),
                          PIPE_TYPE_BYTE | PIPE_READMODE_BYTE | PIPE_WAIT | PIPE_REJECT_REMOTE_CLIENTS,
                          PIPE_UNLIMITED_INSTANCES, PIPE_BUFFER, PIPE_BUFFER, 0, &sa);
}

static void listener_free(listener_t* l) {
  if (l->pending != INVALID_HANDLE_VALUE) CloseHandle(l->pending);
  if (l->cancel != NULL) CloseHandle(l->cancel);
  if (l->sd != NULL) LocalFree(l->sd);
  free(l->name);
  free(l);
}

static void listener_finalize(napi_env env, void* data, void* hint) {
  (void)env;
  (void)hint;
  listener_t* l = (listener_t*)data;
  /* A pending accept holds a reference, so this runs with one in flight only at environment
   * teardown. Its worker thread may still be waiting on these handles: wake it and leave them. */
  if (l->accepting) { SetEvent(l->cancel); return; }
  listener_free(l);
}

static listener_t* arg_listener(napi_env env, napi_value value) {
  listener_t* l = NULL;
  if (napi_get_value_external(env, value, (void**)&l) != napi_ok || l == NULL) {
    napi_throw_type_error(env, NULL, "a pipe listener is required");
    return NULL;
  }
  return l;
}

/* Create the first instance of pipe `name` for this user only. Refuses with code EADDRINUSE when
 * anything already serves that name. */
static napi_value PipeListen(napi_env env, napi_callback_info info) {
  size_t argc = 1;
  napi_value argv[1];
  napi_get_cb_info(env, info, &argc, argv, NULL, NULL);
  if (argc < 1) { napi_throw_type_error(env, NULL, "pipe name required"); return NULL; }
  listener_t* l = (listener_t*)calloc(1, sizeof(listener_t));
  if (l == NULL) { napi_throw_error(env, NULL, "out of memory"); return NULL; }
  l->pending = INVALID_HANDLE_VALUE;
  l->name = arg_utf16(env, argv[0]);
  if (l->name == NULL) { listener_free(l); return NULL; }
  LPWSTR sid = NULL;
  const char* step = "";
  DWORD err = current_sid(&sid, &step);
  if (err) { listener_free(l); return throw_win32(env, step, err); }
  wchar_t sddl[256];
  int n = _snwprintf(sddl, sizeof(sddl) / sizeof(sddl[0]), L"D:P(A;;GRGW;;;%ls)", sid);
  LocalFree(sid);
  if (n < 0 || n >= (int)(sizeof(sddl) / sizeof(sddl[0]))) { listener_free(l); napi_throw_error(env, NULL, "security descriptor too long"); return NULL; }
  if (!ConvertStringSecurityDescriptorToSecurityDescriptorW(sddl, SDDL_REVISION_1, &l->sd, NULL)) {
    err = GetLastError();
    listener_free(l);
    return throw_win32(env, "ConvertStringSecurityDescriptorToSecurityDescriptorW", err);
  }
  l->cancel = CreateEventW(NULL, TRUE, FALSE, NULL);
  if (l->cancel == NULL) { err = GetLastError(); listener_free(l); return throw_win32(env, "CreateEventW", err); }
  l->pending = create_instance(l, TRUE);
  if (l->pending == INVALID_HANDLE_VALUE) {
    err = GetLastError();
    listener_free(l);
    if (err == ERROR_ACCESS_DENIED || err == ERROR_PIPE_BUSY) {
      napi_value c, m, e;
      napi_create_string_utf8(env, "EADDRINUSE", NAPI_AUTO_LENGTH, &c);
      napi_create_string_utf8(env, "the pipe name is already served by another process (FILE_FLAG_FIRST_PIPE_INSTANCE refused it)", NAPI_AUTO_LENGTH, &m);
      napi_create_error(env, c, m, &e);
      napi_throw(env, e);
      return NULL;
    }
    return throw_win32(env, "CreateNamedPipeW", err);
  }
  napi_value out;
  if (napi_create_external(env, l, listener_finalize, NULL, &out) != napi_ok) {
    listener_free(l);
    napi_throw_error(env, NULL, "could not wrap the pipe listener");
    return NULL;
  }
  return out;
}

typedef struct {
  napi_async_work work;
  napi_deferred deferred;
  napi_ref ref;
  listener_t* l;
  HANDLE event;
  DWORD connect_error;
  DWORD pid;
  LPWSTR sid;
  ULONGLONG birth;
  DWORD identity_error;
  const char* identity_step;
} accept_req;

static void accept_execute(napi_env env, void* data) {
  (void)env;
  accept_req* r = (accept_req*)data;
  listener_t* l = r->l;
  OVERLAPPED ov;
  memset(&ov, 0, sizeof(ov));
  ov.hEvent = r->event;
  DWORD n = 0;
  r->connect_error = 0;
  if (!ConnectNamedPipe(l->pending, &ov)) {
    DWORD e = GetLastError();
    if (e == ERROR_IO_PENDING) {
      HANDLE waits[2] = { r->event, l->cancel };
      if (WaitForMultipleObjects(2, waits, FALSE, INFINITE) != WAIT_OBJECT_0) CancelIoEx(l->pending, &ov);
      /* Wait for the operation itself to finish, cancelled or not, before `ov` goes away. */
      e = GetOverlappedResult(l->pending, &ov, &n, TRUE) ? 0 : GetLastError();
    } else if (e == ERROR_PIPE_CONNECTED) {
      e = 0;
    }
    r->connect_error = e;
  }
  if (r->connect_error) return;
  if (!GetNamedPipeClientProcessId(l->pending, &r->pid)) {
    r->identity_step = "GetNamedPipeClientProcessId";
    r->identity_error = GetLastError();
    return;
  }
  r->identity_error = process_identity(r->pid, &r->sid, &r->birth, &r->identity_step);
}

static void resolve_refused(napi_env env, napi_deferred d, const char* reason, DWORD pid) {
  napi_value out, v;
  napi_create_object(env, &out);
  napi_create_string_utf8(env, reason, NAPI_AUTO_LENGTH, &v);
  napi_set_named_property(env, out, "refused", v);
  napi_create_uint32(env, pid, &v);
  napi_set_named_property(env, out, "pid", v);
  napi_resolve_deferred(env, d, out);
}

static void accept_complete(napi_env env, napi_status status, void* data) {
  accept_req* r = (accept_req*)data;
  listener_t* l = r->l;
  l->accepting = 0;
  HANDLE connected = l->pending;
  l->pending = INVALID_HANDLE_VALUE;
  if (status != napi_ok || l->closed) {
    if (connected != INVALID_HANDLE_VALUE) CloseHandle(connected);
    napi_reject_deferred(env, r->deferred, win32_error(env, "ConnectNamedPipe", ERROR_OPERATION_ABORTED));
    goto done;
  }
  /* The next instance exists before this one is used or closed, so the name stays ours. */
  l->pending = create_instance(l, FALSE);
  if (l->pending == INVALID_HANDLE_VALUE) {
    DWORD err = GetLastError();
    CloseHandle(connected);
    napi_reject_deferred(env, r->deferred, win32_error(env, "CreateNamedPipeW", err));
    goto done;
  }
  if (r->connect_error == ERROR_NO_DATA || r->connect_error == ERROR_BROKEN_PIPE) {
    CloseHandle(connected);
    resolve_refused(env, r->deferred, "the client closed the pipe before it was accepted", 0);
    goto done;
  }
  if (r->connect_error) {
    CloseHandle(connected);
    napi_reject_deferred(env, r->deferred, win32_error(env, "ConnectNamedPipe", r->connect_error));
    goto done;
  }
  if (r->identity_error) {
    char reason[160];
    snprintf(reason, sizeof(reason), "%s failed with Windows error %lu", r->identity_step, (unsigned long)r->identity_error);
    CloseHandle(connected);
    resolve_refused(env, r->deferred, reason, r->pid);
    goto done;
  }
  int fd = uv_open_osfhandle(connected);
  if (fd < 0) {
    CloseHandle(connected);
    resolve_refused(env, r->deferred, "uv_open_osfhandle refused the connected pipe", r->pid);
    goto done;
  }
  napi_resolve_deferred(env, r->deferred, peer_object(env, fd, r->pid, r->sid, r->birth));
done:
  if (r->sid != NULL) LocalFree(r->sid);
  CloseHandle(r->event);
  napi_delete_reference(env, r->ref);
  napi_delete_async_work(env, r->work);
  free(r);
}

/* Wait for the next client. Resolves { fd, pid, user, birth } for a connection whose identity was
 * read, { refused, pid } for one that was dropped unread, and rejects with code ECANCELED once the
 * listener is closed. */
static napi_value PipeAccept(napi_env env, napi_callback_info info) {
  size_t argc = 1;
  napi_value argv[1];
  napi_get_cb_info(env, info, &argc, argv, NULL, NULL);
  if (argc < 1) { napi_throw_type_error(env, NULL, "a pipe listener is required"); return NULL; }
  listener_t* l = arg_listener(env, argv[0]);
  if (l == NULL) return NULL;
  if (l->closed || l->pending == INVALID_HANDLE_VALUE) return throw_win32(env, "PipeAccept", ERROR_OPERATION_ABORTED);
  if (l->accepting) { napi_throw_error(env, NULL, "an accept is already pending on this listener"); return NULL; }
  accept_req* r = (accept_req*)calloc(1, sizeof(accept_req));
  if (r == NULL) { napi_throw_error(env, NULL, "out of memory"); return NULL; }
  r->l = l;
  r->event = CreateEventW(NULL, TRUE, FALSE, NULL);
  if (r->event == NULL) { DWORD err = GetLastError(); free(r); return throw_win32(env, "CreateEventW", err); }
  napi_value promise, name;
  napi_create_promise(env, &r->deferred, &promise);
  /* Keep the listener alive while a worker thread uses it. */
  napi_create_reference(env, argv[0], 1, &r->ref);
  napi_create_string_utf8(env, "cotal.pipeAccept", NAPI_AUTO_LENGTH, &name);
  napi_create_async_work(env, NULL, name, accept_execute, accept_complete, r, &r->work);
  l->accepting = 1;
  napi_queue_async_work(env, r->work);
  return promise;
}

/* Stop accepting: a pending accept rejects with ECANCELED and every handle the listener holds is
 * closed. Connections already handed to Node are theirs. Idempotent. */
static napi_value PipeClose(napi_env env, napi_callback_info info) {
  size_t argc = 1;
  napi_value argv[1];
  napi_get_cb_info(env, info, &argc, argv, NULL, NULL);
  if (argc < 1) { napi_throw_type_error(env, NULL, "a pipe listener is required"); return NULL; }
  listener_t* l = arg_listener(env, argv[0]);
  if (l == NULL) return NULL;
  l->closed = 1;
  SetEvent(l->cancel);
  if (!l->accepting && l->pending != INVALID_HANDLE_VALUE) {
    CloseHandle(l->pending);
    l->pending = INVALID_HANDLE_VALUE;
  }
  napi_value out;
  napi_get_undefined(env, &out);
  return out;
}

/* ---- pipe client ---- */

typedef struct {
  napi_async_work work;
  napi_deferred deferred;
  wchar_t* name;
  DWORD timeout_ms;
  HANDLE handle;
  DWORD pid;
  LPWSTR sid;
  ULONGLONG birth;
  DWORD error;
  const char* step;
} connect_req;

static void connect_execute(napi_env env, void* data) {
  (void)env;
  connect_req* r = (connect_req*)data;
  ULONGLONG deadline = GetTickCount64() + r->timeout_ms;
  for (;;) {
    r->handle = CreateFileW(r->name, GENERIC_READ | GENERIC_WRITE, 0, NULL, OPEN_EXISTING,
                            FILE_FLAG_OVERLAPPED | SECURITY_SQOS_PRESENT | SECURITY_IDENTIFICATION, NULL);
    if (r->handle != INVALID_HANDLE_VALUE) break;
    DWORD e = GetLastError();
    if (e != ERROR_PIPE_BUSY) { r->step = "CreateFileW"; r->error = e; return; }
    ULONGLONG now = GetTickCount64();
    if (now >= deadline) { r->step = "WaitNamedPipeW"; r->error = ERROR_SEM_TIMEOUT; return; }
    /* Every instance is busy: wait for one, then try again. A wait that ends without one is
     * answered by the next CreateFileW or by the deadline. */
    WaitNamedPipeW(r->name, (DWORD)(deadline - now));
  }
  if (!GetNamedPipeServerProcessId(r->handle, &r->pid)) { r->step = "GetNamedPipeServerProcessId"; r->error = GetLastError(); goto fail; }
  r->error = process_identity(r->pid, &r->sid, &r->birth, &r->step);
  if (r->error == 0) return;
fail:
  CloseHandle(r->handle);
  r->handle = INVALID_HANDLE_VALUE;
}

static void connect_complete(napi_env env, napi_status status, void* data) {
  connect_req* r = (connect_req*)data;
  if (status != napi_ok && r->handle != INVALID_HANDLE_VALUE) {
    CloseHandle(r->handle);
    r->handle = INVALID_HANDLE_VALUE;
    r->step = "PipeConnect";
    r->error = ERROR_OPERATION_ABORTED;
  }
  if (r->handle == INVALID_HANDLE_VALUE) {
    napi_reject_deferred(env, r->deferred, win32_error(env, r->step, r->error));
  } else {
    int fd = uv_open_osfhandle(r->handle);
    if (fd < 0) {
      CloseHandle(r->handle);
      napi_reject_deferred(env, r->deferred, win32_error(env, "uv_open_osfhandle", ERROR_INVALID_HANDLE));
    } else {
      napi_resolve_deferred(env, r->deferred, peer_object(env, fd, r->pid, r->sid, r->birth));
    }
  }
  if (r->sid != NULL) LocalFree(r->sid);
  free(r->name);
  napi_delete_async_work(env, r->work);
  free(r);
}

/* Open pipe `name` within `timeoutMs`. Resolves { fd, pid, user, birth } for the server process;
 * rejects with code ENOENT when nothing serves the name and ETIMEDOUT when every instance stayed
 * busy. Nothing is written. */
static napi_value PipeConnect(napi_env env, napi_callback_info info) {
  size_t argc = 2;
  napi_value argv[2];
  napi_get_cb_info(env, info, &argc, argv, NULL, NULL);
  uint32_t timeout = 0;
  if (argc < 2 || napi_get_value_uint32(env, argv[1], &timeout) != napi_ok) {
    napi_throw_type_error(env, NULL, "pipe name and timeout required");
    return NULL;
  }
  connect_req* r = (connect_req*)calloc(1, sizeof(connect_req));
  if (r == NULL) { napi_throw_error(env, NULL, "out of memory"); return NULL; }
  r->handle = INVALID_HANDLE_VALUE;
  r->timeout_ms = timeout;
  r->name = arg_utf16(env, argv[0]);
  if (r->name == NULL) { free(r); return NULL; }
  napi_value promise, name;
  napi_create_promise(env, &r->deferred, &promise);
  napi_create_string_utf8(env, "cotal.pipeConnect", NAPI_AUTO_LENGTH, &name);
  napi_create_async_work(env, NULL, name, connect_execute, connect_complete, r, &r->work);
  napi_queue_async_work(env, r->work);
  return promise;
}

static void Export(napi_env env, napi_value exports, const char* name, napi_callback cb) {
  napi_value fn;
  napi_create_function(env, name, NAPI_AUTO_LENGTH, cb, NULL, &fn);
  napi_set_named_property(env, exports, name, fn);
}

static napi_value Init(napi_env env, napi_value exports) {
  Export(env, exports, "currentUserSid", CurrentUserSid);
  Export(env, exports, "processStartTime", ProcessStartTime);
  Export(env, exports, "lockExclusiveNb", LockExclusiveNb);
  Export(env, exports, "inspectDir", InspectDir);
  Export(env, exports, "pipeListen", PipeListen);
  Export(env, exports, "pipeAccept", PipeAccept);
  Export(env, exports, "pipeClose", PipeClose);
  Export(env, exports, "pipeConnect", PipeConnect);
  return exports;
}

NAPI_MODULE(NODE_GYP_MODULE_NAME, Init)
