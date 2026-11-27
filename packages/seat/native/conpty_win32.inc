/* Included by peercred_win32.c for the shared Node-API and Windows identity helpers. */

typedef HRESULT (WINAPI *seat_pty_create)(COORD, HANDLE, HANDLE, DWORD, HPCON*);
typedef HRESULT (WINAPI *seat_pty_resize)(HPCON, COORD);
typedef void (WINAPI *seat_pty_close)(HPCON);

typedef struct {
  HANDLE child, job, thread;
  HMODULE dll;
  HPCON console;
  seat_pty_resize resize;
  seat_pty_close close, release;
  napi_ref pin;
} seat_pty;

static const napi_type_tag seat_pty_tag = { 0x398f8d9d2c8343b7ULL, 0x849a814ef0ca4572ULL };

static void seat_pty_final(napi_env env, void* data, void* hint) {
  (void)env;
  (void)hint;
  seat_pty* s = data;
  if (s->job) CloseHandle(s->job);
  if (s->child) CloseHandle(s->child);
  if (s->thread) CloseHandle(s->thread);
  if (s->console) s->close(s->console);
  if (s->dll) FreeLibrary(s->dll);
  free(s);
}

/* Only this function opens the client end. The console side uses synchronous I/O, the Node side
 * uses overlapped handles. The first-instance flag refuses a name already in use. */
static DWORD seat_pty_pipe(const wchar_t* name, BOOL input, HANDLE* server, HANDLE* client) {
  LPWSTR sid = NULL;
  const char* step = "";
  DWORD err = current_sid(&sid, &step);
  if (err) return err;
  wchar_t acl[256];
  int formatted = swprintf_s(acl, _countof(acl), L"D:P(A;;GRGW;;;%ls)", sid);
  LocalFree(sid);
  if (formatted < 0) return ERROR_INVALID_DATA;
  PSECURITY_DESCRIPTOR sd;
  if (!ConvertStringSecurityDescriptorToSecurityDescriptorW(acl, SDDL_REVISION_1, &sd, NULL)) return GetLastError();
  SECURITY_ATTRIBUTES security = { sizeof(security), sd, FALSE };
  *server = CreateNamedPipeW(name, (input ? PIPE_ACCESS_INBOUND : PIPE_ACCESS_OUTBOUND) | FILE_FLAG_FIRST_PIPE_INSTANCE,
    PIPE_TYPE_BYTE | PIPE_WAIT | PIPE_REJECT_REMOTE_CLIENTS, 1, PIPE_BUFFER, PIPE_BUFFER, 0, &security);
  err = *server == INVALID_HANDLE_VALUE ? GetLastError() : ERROR_SUCCESS;
  LocalFree(sd);
  if (err) return err;
  *client = CreateFileW(name, (input ? GENERIC_WRITE : GENERIC_READ) | FILE_READ_ATTRIBUTES, 0, NULL, OPEN_EXISTING,
    FILE_FLAG_OVERLAPPED | SECURITY_SQOS_PRESENT | SECURITY_IDENTIFICATION, NULL);
  if (*client == INVALID_HANDLE_VALUE) return GetLastError();
  if (!ConnectNamedPipe(*server, NULL) && GetLastError() != ERROR_PIPE_CONNECTED) return GetLastError();
  ULONG peer;
  if (!GetNamedPipeClientProcessId(*server, &peer)) return GetLastError();
  return peer == GetCurrentProcessId() ? ERROR_SUCCESS : ERROR_ACCESS_DENIED;
}

static const char* seat_pty_spawn(seat_pty* s, wchar_t** values, PROCESS_INFORMATION* child, FILETIME* birth) {
  JOBOBJECT_EXTENDED_LIMIT_INFORMATION limit = {0};
  limit.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
  s->job = CreateJobObjectW(NULL, NULL);
  if (!s->job) return "CreateJobObjectW";
  if (!SetInformationJobObject(s->job, JobObjectExtendedLimitInformation, &limit, sizeof(limit))) return "SetInformationJobObject";

  SIZE_T size = 0;
  InitializeProcThreadAttributeList(NULL, 2, 0, &size);
  if (!size) return "InitializeProcThreadAttributeList";
  LPPROC_THREAD_ATTRIBUTE_LIST attrs = malloc(size);
  if (!attrs) { SetLastError(ERROR_OUTOFMEMORY); return "attribute list allocation"; }
  if (!InitializeProcThreadAttributeList(attrs, 2, 0, &size)) {
    DWORD err = GetLastError(); free(attrs); SetLastError(err); return "InitializeProcThreadAttributeList";
  }
  const char* step = NULL;
  STARTUPINFOEXW startup = {0};
  startup.StartupInfo.cb = sizeof(startup);
  startup.lpAttributeList = attrs;
  BOOL member = FALSE;
  FILETIME exit, kernel, user;
  if (!UpdateProcThreadAttribute(attrs, 0, PROC_THREAD_ATTRIBUTE_PSEUDOCONSOLE, s->console, sizeof(HPCON), NULL, NULL)) step = "ConPTY attribute";
  else if (!UpdateProcThreadAttribute(attrs, 0, PROC_THREAD_ATTRIBUTE_JOB_LIST, &s->job, sizeof(HANDLE), NULL, NULL)) step = "job list attribute";
  else if (!CreateProcessW(values[1], values[2], NULL, NULL, FALSE, EXTENDED_STARTUPINFO_PRESENT | CREATE_UNICODE_ENVIRONMENT | CREATE_SUSPENDED,
    values[4], values[3], &startup.StartupInfo, child)) step = "CreateProcessW";
  else if (!IsProcessInJob(child->hProcess, s->job, &member)) step = "IsProcessInJob";
  else if (!member) { SetLastError(ERROR_INVALID_DATA); step = "seat job membership"; }
  else if (!GetProcessTimes(child->hProcess, birth, &exit, &kernel, &user)) step = "GetProcessTimes";
  DWORD err = GetLastError();
  DeleteProcThreadAttributeList(attrs);
  free(attrs);
  SetLastError(err);
  return step;
}

static void seat_pty_set(napi_env env, napi_value object, const char* name, uint32_t number) {
  napi_value v;
  napi_create_uint32(env, number, &v);
  napi_set_named_property(env, object, name, v);
}

static napi_value SeatPtyLaunch(napi_env env, napi_callback_info info) {
  size_t argc = 9;
  napi_value argv[9], out, handle;
  uint32_t width, height;
  napi_get_cb_info(env, info, &argc, argv, NULL, NULL);
  if (argc != 9 || napi_get_value_uint32(env, argv[7], &width) != napi_ok || napi_get_value_uint32(env, argv[8], &height) != napi_ok ||
      !width || !height || width > 32767 || height > 32767) {
    napi_throw_type_error(env, NULL, "invalid Windows seat launch arguments"); return NULL;
  }
  wchar_t* text[7] = {0};
  seat_pty* s = NULL;
  DWORD err = ERROR_OUTOFMEMORY;
  const char* step = "allocate Windows seat";
  HANDLE in = INVALID_HANDLE_VALUE, outpipe = INVALID_HANDLE_VALUE, write = INVALID_HANDLE_VALUE, read = INVALID_HANDLE_VALUE;
  int write_fd = -1, read_fd = -1;
  BOOL wrapped = FALSE;
  PROCESS_INFORMATION child = {0};
  FILETIME birth;
  for (int i = 0; i < 7; i++) if ((text[i] = arg_utf16(env, argv[i])) == NULL) { step = NULL; goto done; }
  s = calloc(1, sizeof(*s));
  if (!s) goto done;
  s->dll = LoadLibraryExW(text[0], NULL, LOAD_LIBRARY_SEARCH_DLL_LOAD_DIR | LOAD_LIBRARY_SEARCH_SYSTEM32);
  if (!s->dll) { step = "LoadLibraryExW(ConPTY)"; err = GetLastError(); goto done; }
  seat_pty_create create = (seat_pty_create)(void*)GetProcAddress(s->dll, "ConptyCreatePseudoConsole");
  s->resize = (seat_pty_resize)(void*)GetProcAddress(s->dll, "ConptyResizePseudoConsole");
  s->close = (seat_pty_close)(void*)GetProcAddress(s->dll, "ConptyClosePseudoConsole");
  s->release = (seat_pty_close)(void*)GetProcAddress(s->dll, "ConptyReleasePseudoConsole");
  if (!create || !s->resize || !s->close || !s->release) { step = "ConPTY exports"; err = ERROR_PROC_NOT_FOUND; goto done; }
  step = "ConPTY input pipe";
  if ((err = seat_pty_pipe(text[5], TRUE, &in, &write)) != 0) goto done;
  step = "ConPTY output pipe";
  if ((err = seat_pty_pipe(text[6], FALSE, &outpipe, &read)) != 0) goto done;
  COORD size = { (SHORT)width, (SHORT)height };
  HRESULT hr = create(size, in, outpipe, 0, &s->console);
  if (FAILED(hr)) { step = "ConptyCreatePseudoConsole"; err = (DWORD)hr; goto done; }
  step = seat_pty_spawn(s, text, &child, &birth);
  s->child = child.hProcess;
  if (step) { err = GetLastError(); goto done; }
  step = "ConPTY descriptor handoff";
  err = ERROR_INVALID_HANDLE;
  write_fd = uv_open_osfhandle(write);
  if (write_fd < 0) goto done;
  write = INVALID_HANDLE_VALUE;
  read_fd = uv_open_osfhandle(read);
  if (read_fd < 0) goto done;
  read = INVALID_HANDLE_VALUE;
  step = "ConPTY handle pin";
  err = ERROR_OUTOFMEMORY;
  if (napi_create_object(env, &out) != napi_ok || napi_create_object(env, &handle) != napi_ok ||
      napi_wrap(env, handle, s, seat_pty_final, NULL, NULL) != napi_ok) goto done;
  wrapped = TRUE;
  if (napi_type_tag_object(env, handle, &seat_pty_tag) != napi_ok || napi_create_reference(env, handle, 1, &s->pin) != napi_ok) goto done;
  napi_set_named_property(env, out, "handle", handle);
  napi_set_named_property(env, out, "start", birth_string(env, filetime64(birth)));
  seat_pty_set(env, out, "pid", child.dwProcessId);
  seat_pty_set(env, out, "input", (uint32_t)write_fd);
  seat_pty_set(env, out, "output", (uint32_t)read_fd);
  s->release(s->console);
  s->thread = child.hThread;
  child.hThread = NULL;
  step = NULL;
  err = ERROR_SUCCESS;

done:
  for (int i = 0; i < 7; i++) free(text[i]);
  if (child.hThread) CloseHandle(child.hThread);
  if (in != INVALID_HANDLE_VALUE) CloseHandle(in);
  if (outpipe != INVALID_HANDLE_VALUE) CloseHandle(outpipe);
  if (err != ERROR_SUCCESS) {
    if (write != INVALID_HANDLE_VALUE) CloseHandle(write);
    if (read != INVALID_HANDLE_VALUE) CloseHandle(read);
    uv_fs_t req;
    if (write_fd >= 0) { uv_fs_close(NULL, &req, write_fd, NULL); uv_fs_req_cleanup(&req); }
    if (read_fd >= 0) { uv_fs_close(NULL, &req, read_fd, NULL); uv_fs_req_cleanup(&req); }
    /* No child has resumed on this path. If membership confirmation failed, the
     * private job alone is not proof that closing it will end the suspended child. */
    if (s) {
      if (s->child) TerminateProcess(s->child, 1);
      if (s->job) { CloseHandle(s->job); s->job = NULL; }
      if (s->child && WaitForSingleObject(s->child, 2000) != WAIT_OBJECT_0) {
        napi_throw_error(env, "COTAL_WINDOWS_SEAT_LAUNCH_UNKNOWN", "suspended Windows seat rollback was not confirmed");
        return NULL;
      }
      if (s->pin) { napi_delete_reference(env, s->pin); s->pin = NULL; }
      if (!wrapped) seat_pty_final(env, s, NULL);
    }
    return step ? throw_win32(env, step, err) : NULL;
  }
  return out;
}

static seat_pty* seat_pty_arg(napi_env env, napi_value arg) {
  seat_pty* s = NULL;
  bool match = false;
  if (napi_check_object_type_tag(env, arg, &seat_pty_tag, &match) != napi_ok || !match ||
      napi_unwrap(env, arg, (void**)&s) != napi_ok || !s || !s->child) {
    napi_throw_type_error(env, NULL, "invalid Windows seat session"); return NULL;
  }
  return s;
}

static napi_value SeatPtyResume(napi_env env, napi_callback_info info) {
  size_t argc = 1;
  napi_value arg, out;
  napi_get_cb_info(env, info, &argc, &arg, NULL, NULL);
  seat_pty* s = argc == 1 ? seat_pty_arg(env, arg) : NULL;
  if (!s) return NULL;
  if (!s->thread) return throw_win32(env, "Windows seat is not suspended", ERROR_INVALID_PARAMETER);
  if (ResumeThread(s->thread) == (DWORD)-1) return throw_win32(env, "ResumeThread", GetLastError());
  CloseHandle(s->thread); s->thread = NULL;
  napi_get_undefined(env, &out);
  return out;
}

static napi_value SeatPtyPoll(napi_env env, napi_callback_info info) {
  size_t argc = 1;
  napi_value arg, out;
  napi_get_cb_info(env, info, &argc, &arg, NULL, NULL);
  seat_pty* s = argc == 1 ? seat_pty_arg(env, arg) : NULL;
  if (!s) return NULL;
  DWORD wait = WaitForSingleObject(s->child, 0), code;
  if (wait == WAIT_TIMEOUT) { napi_get_undefined(env, &out); return out; }
  if (wait != WAIT_OBJECT_0) return throw_win32(env, "WaitForSingleObject", GetLastError());
  if (!GetExitCodeProcess(s->child, &code)) return throw_win32(env, "GetExitCodeProcess", GetLastError());
  JOBOBJECT_BASIC_ACCOUNTING_INFORMATION accounting;
  if (!QueryInformationJobObject(s->job, JobObjectBasicAccountingInformation, &accounting, sizeof(accounting), NULL))
    return throw_win32(env, "QueryInformationJobObject", GetLastError());
  napi_create_object(env, &out);
  seat_pty_set(env, out, "exitCode", code);
  seat_pty_set(env, out, "active", accounting.ActiveProcesses);
  return out;
}

static napi_value SeatPtyDispose(napi_env env, napi_callback_info info) {
  size_t argc = 1;
  napi_value arg, out;
  napi_get_cb_info(env, info, &argc, &arg, NULL, NULL);
  seat_pty* s = argc == 1 ? seat_pty_arg(env, arg) : NULL;
  if (!s) return NULL;
  JOBOBJECT_BASIC_ACCOUNTING_INFORMATION accounting;
  if (!QueryInformationJobObject(s->job, JobObjectBasicAccountingInformation, &accounting, sizeof(accounting), NULL))
    return throw_win32(env, "QueryInformationJobObject", GetLastError());
  DWORD wait = WaitForSingleObject(s->child, 0);
  if (wait != WAIT_OBJECT_0 && wait != WAIT_TIMEOUT) return throw_win32(env, "WaitForSingleObject", GetLastError());
  BOOL dead = wait == WAIT_OBJECT_0 && accounting.ActiveProcesses == 0;
  if (dead) {
    CloseHandle(s->job); s->job = NULL;
    CloseHandle(s->child); s->child = NULL;
    if (s->thread) { CloseHandle(s->thread); s->thread = NULL; }
    s->close(s->console); s->console = NULL;
    FreeLibrary(s->dll); s->dll = NULL;
    napi_delete_reference(env, s->pin); s->pin = NULL;
  }
  napi_get_boolean(env, dead != FALSE, &out);
  return out;
}

static napi_value SeatPtyAbort(napi_env env, napi_callback_info info) {
  size_t argc = 1;
  napi_value arg, out;
  napi_get_cb_info(env, info, &argc, &arg, NULL, NULL);
  seat_pty* s = argc == 1 ? seat_pty_arg(env, arg) : NULL;
  if (!s) return NULL;
  if (!s->thread) return throw_win32(env, "Windows seat is not suspended", ERROR_INVALID_PARAMETER);
  TerminateProcess(s->child, 1);
  if (WaitForSingleObject(s->child, 2000) != WAIT_OBJECT_0) {
    napi_throw_error(env, "COTAL_WINDOWS_SEAT_LAUNCH_UNKNOWN", "suspended Windows seat rollback was not confirmed");
    return NULL;
  }
  CloseHandle(s->job); s->job = NULL;
  CloseHandle(s->child); s->child = NULL;
  CloseHandle(s->thread); s->thread = NULL;
  napi_delete_reference(env, s->pin); s->pin = NULL;
  napi_get_undefined(env, &out);
  return out;
}

static napi_value SeatPtyResize(napi_env env, napi_callback_info info) {
  size_t argc = 3;
  napi_value argv[3], out;
  uint32_t width, height;
  napi_get_cb_info(env, info, &argc, argv, NULL, NULL);
  if (argc != 3 || napi_get_value_uint32(env, argv[1], &width) != napi_ok || napi_get_value_uint32(env, argv[2], &height) != napi_ok ||
      !width || !height || width > 32767 || height > 32767) {
    napi_throw_type_error(env, NULL, "invalid Windows seat console size"); return NULL;
  }
  seat_pty* s = seat_pty_arg(env, argv[0]);
  if (!s) return NULL;
  COORD size = { (SHORT)width, (SHORT)height };
  HRESULT hr = s->resize(s->console, size);
  if (FAILED(hr)) return throw_win32(env, "ConptyResizePseudoConsole", (DWORD)hr);
  napi_get_undefined(env, &out);
  return out;
}

static napi_value SeatPtyStop(napi_env env, napi_callback_info info) {
  size_t argc = 1;
  napi_value arg, out;
  napi_get_cb_info(env, info, &argc, &arg, NULL, NULL);
  seat_pty* s = argc == 1 ? seat_pty_arg(env, arg) : NULL;
  if (!s) return NULL;
  if (!TerminateJobObject(s->job, 1)) return throw_win32(env, "TerminateJobObject", GetLastError());
  napi_get_undefined(env, &out);
  return out;
}
