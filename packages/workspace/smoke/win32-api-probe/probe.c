// Windows API probe for a SID-tagged local authority and live Job Object custody. Diagnostic only:
// nothing ships from this directory and no production code calls it. Run it through run.mjs.
//
// Each cell prints one line, `<id> PASS|FAIL|INFO <facts>`, and the exit code is 1 when any cell
// reads FAIL. Machine identifiers are printed as SHA-256 digests. Every job this probe creates kills
// its members when its last handle closes, and every helper process sleeps at most 60 s, so nothing
// outlives a crashed run for long. No credential, user account or logon is created or used: the
// non-admin cells run under a restricted copy of the caller's own token.
//
// Build from a VsDevCmd prompt (x64 or arm64):
//   cl /nologo /O2 /MT /W4 /std:c11 /Fe:probe.exe probe.c /link advapi32.lib bcrypt.lib
#define WIN32_LEAN_AND_MEAN
#ifndef _WIN32_WINNT
#define _WIN32_WINNT 0x0A00
#endif
#define _CRT_SECURE_NO_WARNINGS
#include <windows.h>
#include <sddl.h>
#include <aclapi.h>
#include <ntsecapi.h>
#include <bcrypt.h>
#include <stdarg.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <wchar.h>

#define CHILD_LIFETIME_MS 60000
#define WAIT_MS 10000
#define TERMINATED 0xC0DEu
#define KILLED 0xDEADu
#define RSMB_SIGNATURE 0x52534D42u

static wchar_t g_self[MAX_PATH * 2];
static wchar_t g_user_sid[192];
static int g_failed;

static void line_out(const char *id, const char *verdict, const char *fmt, va_list ap) {
  printf("%s %s ", id, verdict);
  vprintf(fmt, ap);
  printf("\n");
  fflush(stdout);
}

static void cell(const char *id, int ok, const char *fmt, ...) {
  va_list ap;
  va_start(ap, fmt);
  line_out(id, ok ? "PASS" : "FAIL", fmt, ap);
  va_end(ap);
  if (!ok) g_failed++;
}

static void info(const char *id, const char *fmt, ...) {
  va_list ap;
  va_start(ap, fmt);
  line_out(id, "INFO", fmt, ap);
  va_end(ap);
}

static void sha256_hex(const void *data, ULONG size, char out[65]) {
  BCRYPT_ALG_HANDLE alg = NULL;
  UCHAR digest[32];
  strcpy(out, "unavailable");
  if (!BCRYPT_SUCCESS(BCryptOpenAlgorithmProvider(&alg, BCRYPT_SHA256_ALGORITHM, NULL, 0))) return;
  if (BCRYPT_SUCCESS(BCryptHash(alg, NULL, 0, (PUCHAR)data, size, digest, sizeof digest)))
    for (int i = 0; i < 32; i++) sprintf(out + 2 * i, "%02x", digest[i]);
  BCryptCloseAlgorithmProvider(alg, 0);
}

/** `"part" "part" ...`, every part quoted, as CreateProcess's security remarks ask. */
static wchar_t *command_line(const wchar_t *const *parts, int count) {
  size_t size = 1;
  for (int i = 0; i < count; i++) size += wcslen(parts[i]) + 3;
  wchar_t *line = malloc(size * sizeof *line);
  if (!line) return NULL;
  line[0] = L'\0';
  for (int i = 0; i < count; i++) {
    if (i) wcscat(line, L" ");
    wcscat(line, L"\"");
    wcscat(line, parts[i]);
    wcscat(line, L"\"");
  }
  return line;
}

static wchar_t *self_command(const wchar_t *mode) {
  const wchar_t *parts[] = { g_self, mode };
  return command_line(parts, 2);
}

/** The creation FILETIME the shipped pin reads, as one integer. */
static int creation(HANDLE process, unsigned long long *value) {
  FILETIME created, exited, kernel, user;
  if (!GetProcessTimes(process, &created, &exited, &kernel, &user)) return 0;
  *value = ((unsigned long long)created.dwHighDateTime << 32) | created.dwLowDateTime;
  return 1;
}

static int in_job(HANDLE process, HANDLE job) {
  BOOL result = FALSE;
  return IsProcessInJob(process, job, &result) ? (result ? 1 : 0) : -1;
}

static long active_processes(HANDLE job) {
  JOBOBJECT_BASIC_ACCOUNTING_INFORMATION accounting;
  if (!QueryInformationJobObject(job, JobObjectBasicAccountingInformation, &accounting, sizeof accounting, NULL)) return -1;
  return (long)accounting.ActiveProcesses;
}

static int exited(HANDLE process, DWORD ms, DWORD *code) {
  *code = 0;
  if (WaitForSingleObject(process, ms) != WAIT_OBJECT_0) return 0;
  GetExitCodeProcess(process, code);
  return 1;
}

/** A job with KILL_ON_JOB_CLOSE and no breakaway flag: closing its last handle ends every member. */
static HANDLE custody_job(DWORD *err) {
  JOBOBJECT_EXTENDED_LIMIT_INFORMATION limits;
  HANDLE job = CreateJobObjectW(NULL, NULL);
  *err = 0;
  if (!job) { *err = GetLastError(); return NULL; }
  memset(&limits, 0, sizeof limits);
  limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
  if (!SetInformationJobObject(job, JobObjectExtendedLimitInformation, &limits, sizeof limits)) {
    *err = GetLastError();
    CloseHandle(job);
    return NULL;
  }
  return job;
}

typedef struct { HANDLE process, thread, out; DWORD pid; } child_t;

static void child_close(child_t *child) {
  if (child->process) CloseHandle(child->process);
  if (child->thread) CloseHandle(child->thread);
  if (child->out) CloseHandle(child->out);
  memset(child, 0, sizeof *child);
}

/**
 * Start `command` with its stdout and stderr on a new pipe, inheriting that pipe end and nothing
 * else (PROC_THREAD_ATTRIBUTE_HANDLE_LIST). With `job`, the process is in that job from its first
 * instruction (PROC_THREAD_ATTRIBUTE_JOB_LIST). With `token`, it runs under that token.
 */
static DWORD spawn(child_t *child, const wchar_t *command, HANDLE job, HANDLE token, DWORD flags) {
  SECURITY_ATTRIBUTES inherit = { sizeof inherit, NULL, TRUE };
  HANDLE read_end = NULL, write_end = NULL;
  LPPROC_THREAD_ATTRIBUTE_LIST list = NULL;
  int list_ready = 0;
  SIZE_T size = 0;
  STARTUPINFOEXW startup;
  PROCESS_INFORMATION created;
  DWORD err = 0, count = job ? 2 : 1;
  wchar_t *line = _wcsdup(command);
  memset(child, 0, sizeof *child);
  memset(&startup, 0, sizeof startup);
  memset(&created, 0, sizeof created);
  do {
    if (!line || !CreatePipe(&read_end, &write_end, &inherit, 0) || !SetHandleInformation(read_end, HANDLE_FLAG_INHERIT, 0)) { err = GetLastError(); break; }
    InitializeProcThreadAttributeList(NULL, count, 0, &size);
    list = HeapAlloc(GetProcessHeap(), 0, size);
    if (!list || !InitializeProcThreadAttributeList(list, count, 0, &size)) { err = GetLastError(); break; }
    list_ready = 1;
    if (!UpdateProcThreadAttribute(list, 0, PROC_THREAD_ATTRIBUTE_HANDLE_LIST, &write_end, sizeof write_end, NULL, NULL)
        || (job && !UpdateProcThreadAttribute(list, 0, PROC_THREAD_ATTRIBUTE_JOB_LIST, &job, sizeof job, NULL, NULL))) { err = GetLastError(); break; }
    startup.StartupInfo.cb = sizeof startup;
    startup.StartupInfo.dwFlags = STARTF_USESTDHANDLES;
    startup.StartupInfo.hStdOutput = write_end;
    startup.StartupInfo.hStdError = write_end;
    startup.lpAttributeList = list;
    flags |= EXTENDED_STARTUPINFO_PRESENT | CREATE_NO_WINDOW;
    if (!(token ? CreateProcessAsUserW(token, NULL, line, NULL, NULL, TRUE, flags, NULL, NULL, &startup.StartupInfo, &created)
                : CreateProcessW(NULL, line, NULL, NULL, TRUE, flags, NULL, NULL, &startup.StartupInfo, &created))) { err = GetLastError(); break; }
    child->process = created.hProcess;
    child->thread = created.hThread;
    child->pid = created.dwProcessId;
    child->out = read_end;
    read_end = NULL;
  } while (0);
  if (list_ready) DeleteProcThreadAttributeList(list);
  if (list) HeapFree(GetProcessHeap(), 0, list);
  if (write_end) CloseHandle(write_end);
  if (read_end) CloseHandle(read_end);
  free(line);
  return err;
}

/** A plain child with no inherited handles, as an agent's own subprocess would be. */
static DWORD spawn_plain(const wchar_t *mode, DWORD flags, PROCESS_INFORMATION *created) {
  STARTUPINFOW startup;
  wchar_t *line = self_command(mode);
  DWORD err = 0;
  memset(&startup, 0, sizeof startup);
  startup.cb = sizeof startup;
  memset(created, 0, sizeof *created);
  if (!line) return ERROR_OUTOFMEMORY;
  if (!CreateProcessW(NULL, line, NULL, NULL, FALSE, flags | CREATE_NO_WINDOW, NULL, NULL, &startup, created)) err = GetLastError();
  else CloseHandle(created->hThread);
  free(line);
  return err;
}

/** One line from a child's pipe, or -1 when the writer is gone or `ms` passes first. */
static int read_line(HANDLE pipe, char *buffer, int size, DWORD ms) {
  ULONGLONG deadline = GetTickCount64() + ms;
  int length = 0;
  buffer[0] = '\0';
  while (length < size - 1) {
    DWORD available = 0, got = 0;
    char ch;
    if (!PeekNamedPipe(pipe, NULL, 0, NULL, &available, NULL)) break;
    if (!available) {
      if (GetTickCount64() >= deadline) break;
      Sleep(10);
      continue;
    }
    if (!ReadFile(pipe, &ch, 1, &got, NULL) || !got) break;
    if (ch == '\n') { buffer[length] = '\0'; return length; }
    if (ch != '\r') buffer[length++] = ch;
  }
  buffer[length] = '\0';
  return -1;
}

static DWORD field(const char *line, const char *key) {
  const char *at = strstr(line, key);
  return at ? strtoul(at + strlen(key), NULL, 10) : 0;
}

static void sddl_of(HANDLE object, char *out, size_t size) {
  SECURITY_INFORMATION what = OWNER_SECURITY_INFORMATION | GROUP_SECURITY_INFORMATION | DACL_SECURITY_INFORMATION | LABEL_SECURITY_INFORMATION;
  PSECURITY_DESCRIPTOR descriptor = NULL;
  LPWSTR text = NULL;
  DWORD err = GetSecurityInfo(object, SE_KERNEL_OBJECT, what, NULL, NULL, NULL, NULL, &descriptor);
  if (err) { snprintf(out, size, "err%lu", err); return; }
  if (ConvertSecurityDescriptorToStringSecurityDescriptorW(descriptor, SDDL_REVISION_1, what, &text, NULL)) {
    snprintf(out, size, "%ls", text);
    LocalFree(text);
  } else snprintf(out, size, "convert_err%lu", GetLastError());
  LocalFree(descriptor);
}

typedef struct { wchar_t sid[192]; int user_deny_only, admin_enabled, restricted, elevation_type; DWORD elevated, integrity; } token_facts_t;

static int read_token_facts(token_facts_t *facts) {
  union { TOKEN_USER user; BYTE raw[256]; } user;
  union { TOKEN_MANDATORY_LABEL label; BYTE raw[128]; } label;
  TOKEN_ELEVATION elevation;
  TOKEN_ELEVATION_TYPE elevation_type;
  BYTE admins[SECURITY_MAX_SID_SIZE];
  DWORD size = sizeof admins, got;
  BOOL member = FALSE;
  HANDLE token;
  int ok = 0;
  memset(facts, 0, sizeof *facts);
  wcscpy(facts->sid, L"?");
  if (!OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &token)) return 0;
  if (GetTokenInformation(token, TokenUser, &user, sizeof user, &got)) {
    LPWSTR text;
    facts->user_deny_only = (user.user.User.Attributes & SE_GROUP_USE_FOR_DENY_ONLY) != 0;
    if (ConvertSidToStringSidW(user.user.User.Sid, &text)) {
      wcsncpy(facts->sid, text, ARRAYSIZE(facts->sid) - 1);
      LocalFree(text);
      ok = 1;
    }
  }
  if (GetTokenInformation(token, TokenElevation, &elevation, sizeof elevation, &got)) facts->elevated = elevation.TokenIsElevated;
  if (GetTokenInformation(token, TokenElevationType, &elevation_type, sizeof elevation_type, &got)) facts->elevation_type = (int)elevation_type;
  if (GetTokenInformation(token, TokenIntegrityLevel, &label, sizeof label, &got)) {
    PSID sid = label.label.Label.Sid;
    facts->integrity = *GetSidSubAuthority(sid, *GetSidSubAuthorityCount(sid) - 1u);
  }
  if (CreateWellKnownSid(WinBuiltinAdministratorsSid, NULL, admins, &size) && CheckTokenMembership(NULL, admins, &member)) facts->admin_enabled = member ? 1 : 0;
  facts->restricted = IsTokenRestricted(token) ? 1 : 0;
  CloseHandle(token);
  return ok;
}

/**
 * A restricted copy of this process's own token: BUILTIN\Administrators deny-only, every privilege
 * but SeChangeNotifyPrivilege removed, integrity lowered to medium. With `deny_user` the user SID is
 * deny-only too, which stands in for another principal in DACL checks only.
 */
static DWORD restricted_token(int deny_user, HANDLE *out) {
  union { TOKEN_USER user; BYTE raw[256]; } user;
  union { TOKEN_MANDATORY_LABEL label; BYTE raw[128]; } current;
  BYTE admins[SECURITY_MAX_SID_SIZE], medium[SECURITY_MAX_SID_SIZE];
  DWORD admins_size = sizeof admins, medium_size = sizeof medium, got, err = 0, count = 1;
  SID_AND_ATTRIBUTES disable[2];
  HANDLE base;
  *out = NULL;
  if (!OpenProcessToken(GetCurrentProcess(), TOKEN_DUPLICATE | TOKEN_QUERY | TOKEN_ASSIGN_PRIMARY | TOKEN_ADJUST_DEFAULT, &base)) return GetLastError();
  do {
    if (!CreateWellKnownSid(WinBuiltinAdministratorsSid, NULL, admins, &admins_size)
        || !CreateWellKnownSid(WinMediumLabelSid, NULL, medium, &medium_size)) { err = GetLastError(); break; }
    disable[0].Sid = admins;
    disable[0].Attributes = 0;
    if (deny_user) {
      if (!GetTokenInformation(base, TokenUser, &user, sizeof user, &got)) { err = GetLastError(); break; }
      disable[1].Sid = user.user.User.Sid;
      disable[1].Attributes = 0;
      count = 2;
    }
    if (!CreateRestrictedToken(base, DISABLE_MAX_PRIVILEGE, count, disable, 0, NULL, 0, NULL, out)) { err = GetLastError(); break; }
    if (!GetTokenInformation(*out, TokenIntegrityLevel, &current, sizeof current, &got)) { err = GetLastError(); break; }
    PSID level = current.label.Label.Sid;
    if (*GetSidSubAuthority(level, *GetSidSubAuthorityCount(level) - 1u) > SECURITY_MANDATORY_MEDIUM_RID) {
      TOKEN_MANDATORY_LABEL lowered;
      lowered.Label.Sid = medium;
      lowered.Label.Attributes = SE_GROUP_INTEGRITY;
      if (!SetTokenInformation(*out, TokenIntegrityLevel, &lowered, (DWORD)(sizeof lowered + GetLengthSid(medium)))) { err = GetLastError(); break; }
    }
  } while (0);
  if (err && *out) { CloseHandle(*out); *out = NULL; }
  CloseHandle(base);
  return err;
}

// ---- helper modes -------------------------------------------------------------------------------

static int mode_leaf(void) {
  printf("leaf pid=%lu\n", GetCurrentProcessId());
  fflush(stdout);
  Sleep(CHILD_LIFETIME_MS);
  return 0;
}

/** An agent root: one ordinary child, then one child that asks to leave the job. */
static int mode_root(void) {
  PROCESS_INFORMATION leaf, escaped;
  DWORD err = spawn_plain(L"leaf", 0, &leaf);
  if (err) {
    printf("root pid=%lu leaf=0 leaf_err=%lu\n", GetCurrentProcessId(), err);
  } else {
    DWORD breakaway = spawn_plain(L"leaf", CREATE_BREAKAWAY_FROM_JOB, &escaped);
    if (!breakaway) {
      TerminateProcess(escaped.hProcess, KILLED);
      WaitForSingleObject(escaped.hProcess, WAIT_MS);
      printf("root pid=%lu leaf=%lu breakaway=escaped%lu\n", GetCurrentProcessId(), leaf.dwProcessId, escaped.dwProcessId);
      CloseHandle(escaped.hProcess);
    } else printf("root pid=%lu leaf=%lu breakaway=err%lu\n", GetCurrentProcessId(), leaf.dwProcessId, breakaway);
    CloseHandle(leaf.hProcess);
  }
  fflush(stdout);
  Sleep(CHILD_LIFETIME_MS);
  return 0;
}

/** Inside a job, put itself into a second job: the documented nested hierarchy (Windows 8+). */
static int mode_nest(void) {
  HANDLE inner = CreateJobObjectW(NULL, NULL);
  DWORD err = 0;
  if (!inner) err = GetLastError();
  else if (!AssignProcessToJobObject(inner, GetCurrentProcess())) err = GetLastError();
  printf("nest pid=%lu assign_err=%lu in_inner=%d\n", GetCurrentProcessId(), err, inner ? in_job(GetCurrentProcess(), inner) : -1);
  fflush(stdout);
  Sleep(CHILD_LIFETIME_MS);
  return 0;
}

/** The candidate custodian: holds the only handle to a custody job and starts the root inside it. */
static int mode_custodian(void) {
  DWORD err;
  HANDLE job = custody_job(&err);
  child_t root;
  char line[256];
  if (!job) { printf("custodian pid=%lu job_err=%lu\n", GetCurrentProcessId(), err); fflush(stdout); return 1; }
  wchar_t *command = self_command(L"root");
  err = command ? spawn(&root, command, job, NULL, 0) : ERROR_OUTOFMEMORY;
  free(command);
  if (err) { printf("custodian pid=%lu spawn_err=%lu\n", GetCurrentProcessId(), err); fflush(stdout); return 1; }
  if (read_line(root.out, line, sizeof line, WAIT_MS) < 0) snprintf(line, sizeof line, "root_line=timeout");
  printf("custodian pid=%lu in_job=%d %s\n", GetCurrentProcessId(), in_job(GetCurrentProcess(), NULL), line);
  fflush(stdout);
  Sleep(CHILD_LIFETIME_MS);
  return 0;
}

static DWORD open_err(const wchar_t *name, DWORD access) {
  HANDLE job = OpenJobObjectW(access, FALSE, name);
  if (!job) return GetLastError();
  CloseHandle(job);
  return 0;
}

/** Open a named job and a control event that grants Everyone, from whatever token this runs under. */
static int mode_open_job(const wchar_t *job_name, const wchar_t *control_name) {
  token_facts_t facts;
  HANDLE control = OpenEventW(SYNCHRONIZE, FALSE, control_name);
  DWORD control_err = control ? 0 : GetLastError();
  if (control) CloseHandle(control);
  read_token_facts(&facts);
  printf("open control_err=%lu query_err=%lu terminate_err=%lu user_deny_only=%d admin_enabled=%d integrity=0x%lx\n",
         control_err, open_err(job_name, JOB_OBJECT_QUERY), open_err(job_name, JOB_OBJECT_TERMINATE),
         facts.user_deny_only, facts.admin_enabled, facts.integrity);
  fflush(stdout);
  return 0;
}

/** Run a command under the restricted token and relay its lines, prefixed. */
static int mode_run_restricted(int count, wchar_t **parts) {
  HANDLE token;
  child_t child;
  char line[2048];
  DWORD code = 0, err = restricted_token(0, &token);
  if (err) { cell("R0", 0, "restricted_token_err=%lu", err); return 1; }
  wchar_t *command = command_line((const wchar_t *const *)parts, count);
  err = command ? spawn(&child, command, NULL, token, 0) : ERROR_OUTOFMEMORY;
  free(command);
  CloseHandle(token);
  if (err) { cell("R0", 0, "create_process_as_user_err=%lu", err); return 1; }
  info("R0", "restricted child pid=%lu started", child.pid);
  ULONGLONG deadline = GetTickCount64() + 150000;
  for (;;) {
    ULONGLONG now = GetTickCount64();
    int got = read_line(child.out, line, sizeof line, now < deadline ? (DWORD)(deadline - now) : 0);
    if (got >= 0) { printf("[restricted] %s\n", line); fflush(stdout); continue; }
    if (line[0]) printf("[restricted] %s\n", line);
    break;
  }
  if (!exited(child.process, 5000, &code)) { TerminateProcess(child.process, KILLED); exited(child.process, 5000, &code); }
  info("R9", "restricted child exit=0x%lx", code);
  child_close(&child);
  return (int)code;
}

/**
 * The custodian under a Node parent: probe -> node run.mjs --hold -> probe custodian -> job{root -> leaf}.
 * Node puts a non-detached child in its own kill-on-close job and leaves a detached one out of it.
 */
static int mode_node_chain(const wchar_t *node, const wchar_t *script, const wchar_t *detached) {
  const wchar_t *parts[] = { node, script, L"--hold", g_self, detached };
  const char *id = detached[0] == L'1' ? "N2" : "N1";
  int is_detached = detached[0] == L'1';
  child_t helper;
  char line[512];
  DWORD code, access = SYNCHRONIZE | PROCESS_QUERY_LIMITED_INFORMATION | PROCESS_TERMINATE;
  wchar_t *command = command_line(parts, 5);
  DWORD err = command ? spawn(&helper, command, NULL, NULL, 0) : ERROR_OUTOFMEMORY;
  free(command);
  if (err) { cell(id, 0, "node_spawn_err=%lu", err); return 1; }
  int got = read_line(helper.out, line, sizeof line, 20000);
  DWORD custodian_pid = field(line, "custodian pid="), root_pid = field(line, "root pid="), leaf_pid = field(line, "leaf=");
  if (got < 0 || !custodian_pid || !root_pid || !leaf_pid) {
    cell(id, 0, "no custodian line from the Node helper: %s", line);
    TerminateProcess(helper.process, KILLED);
    child_close(&helper);
    return 1;
  }
  HANDLE custodian = OpenProcess(access, FALSE, custodian_pid), root = OpenProcess(access, FALSE, root_pid), leaf = OpenProcess(access, FALSE, leaf_pid);
  unsigned long long helper_at = 0, custodian_at = 0, root_at = 0, leaf_at = 0;
  creation(helper.process, &helper_at);
  int pinned = custodian && root && leaf && creation(custodian, &custodian_at) && creation(root, &root_at) && creation(leaf, &leaf_at)
               && custodian_at >= helper_at && root_at >= custodian_at && leaf_at >= root_at;
  TerminateProcess(helper.process, KILLED);
  WaitForSingleObject(helper.process, WAIT_MS);
  if (!is_detached) {
    int c = pinned && exited(custodian, WAIT_MS, &code), r = pinned && exited(root, WAIT_MS, &code), l = pinned && exited(leaf, WAIT_MS, &code);
    cell(id, c && r && l, "node parent killed (non-detached): pinned=%d custodian_in_node_job=%lu custodian_exited=%d root_exited=%d leaf_exited=%d",
         pinned, field(line, "in_job="), c, r, l);
  } else {
    int alive = pinned && WaitForSingleObject(custodian, 2000) == WAIT_TIMEOUT && WaitForSingleObject(root, 0) == WAIT_TIMEOUT && WaitForSingleObject(leaf, 0) == WAIT_TIMEOUT;
    if (custodian) TerminateProcess(custodian, KILLED);
    int r = pinned && exited(root, WAIT_MS, &code), l = pinned && exited(leaf, WAIT_MS, &code);
    cell(id, alive && r && l, "node parent killed (detached): pinned=%d custodian_in_job=%lu survived_node=%d then custodian killed: root_exited=%d leaf_exited=%d",
         pinned, field(line, "in_job="), alive, r, l);
  }
  if (custodian) { TerminateProcess(custodian, KILLED); CloseHandle(custodian); }
  if (root) { TerminateProcess(root, KILLED); CloseHandle(root); }
  if (leaf) { TerminateProcess(leaf, KILLED); CloseHandle(leaf); }
  child_close(&helper);
  return g_failed ? 1 : 0;
}

// ---- the cells ----------------------------------------------------------------------------------

static void identity_cells(void) {
  token_facts_t facts;
  int ok = read_token_facts(&facts);
  wcscpy(g_user_sid, facts.sid);
  cell("I1", ok && wcsncmp(facts.sid, L"S-1-", 4) == 0, "token_user=%ls user_deny_only=%d elevated=%lu elevation_type=%d integrity=0x%lx admin_enabled=%d restricting_sids=%d",
       facts.sid, facts.user_deny_only, facts.elevated, facts.elevation_type, facts.integrity, facts.admin_enabled, facts.restricted);

  // Raw SMBIOS: the type-1 System UUID sits at offset 8 of its structure (SMBIOS 2.1+).
  UINT size = GetSystemFirmwareTable(RSMB_SIGNATURE, 0, NULL, 0);
  if (!size) cell("I2", 0, "rsmb size_err=%lu", GetLastError());
  else {
    BYTE *raw = malloc(size), *uuid = NULL;
    UINT got = raw ? GetSystemFirmwareTable(RSMB_SIGNATURE, 0, raw, size) : 0;
    if (got == size && size > 8) {
      DWORD length = *(DWORD *)(raw + 4);
      BYTE *at = raw + 8, *end = raw + 8 + (length < size - 8 ? length : size - 8);
      while (at + 4 <= end && at[1] >= 4) {
        if (at[0] == 1 && at[1] >= 0x19 && at + 0x18 <= end) { uuid = at + 8; break; }
        if (at[0] == 127) break;
        BYTE *strings = at + at[1];
        while (strings + 1 < end && (strings[0] || strings[1])) strings++;
        at = strings + 2;
      }
    }
    char digest[65] = "none";
    const char *state = "absent";
    if (uuid) {
      int zero = 1, ones = 1;
      for (int i = 0; i < 16; i++) { zero &= uuid[i] == 0; ones &= uuid[i] == 0xFF; }
      state = zero ? "all-zero" : ones ? "all-ff" : "set";
      sha256_hex(uuid, 16, digest);
    }
    cell("I2", got == size && uuid != NULL, "rsmb bytes=%u smbios=%u.%u system_uuid=%s uuid_sha256=%s",
         size, got > 2 ? (unsigned)raw[1] : 0u, got > 2 ? (unsigned)raw[2] : 0u, state, digest);
    free(raw);
  }

  // The account-domain (machine) SID through the documented LSA policy call.
  LSA_OBJECT_ATTRIBUTES attributes;
  LSA_HANDLE policy;
  memset(&attributes, 0, sizeof attributes);
  NTSTATUS status = LsaOpenPolicy(NULL, &attributes, POLICY_VIEW_LOCAL_INFORMATION, &policy);
  if (status < 0) cell("I3", 0, "lsa_open_err=%lu", LsaNtStatusToWinError(status));
  else {
    POLICY_ACCOUNT_DOMAIN_INFO *domain = NULL;
    status = LsaQueryInformationPolicy(policy, PolicyAccountDomainInformation, (PVOID *)&domain);
    LPWSTR text = NULL;
    if (status < 0) cell("I3", 0, "lsa_query_err=%lu", LsaNtStatusToWinError(status));
    else if (!domain->DomainSid || !ConvertSidToStringSidW(domain->DomainSid, &text)) cell("I3", 0, "account_domain_sid=unreadable");
    else {
      char digest[65];
      size_t prefix = wcslen(text);
      sha256_hex(text, (ULONG)(prefix * sizeof *text), digest);
      cell("I3", 1, "account_domain_sid_sha256=%s user_is_local_account=%d", digest,
           wcsncmp(g_user_sid, text, prefix) == 0 && g_user_sid[prefix] == L'-');
      LocalFree(text);
    }
    if (domain) LsaFreeMemory(domain);
    LsaClose(policy);
  }
}

static void job_cells(void) {
  JOBOBJECT_EXTENDED_LIMIT_INFORMATION limits;
  DWORD err, code_root = 0, code_leaf = 0;
  char line[256], sddl[1024];
  child_t root;

  HANDLE job = custody_job(&err);
  if (!job) { cell("J1", 0, "custody_job_err=%lu", err); return; }
  DWORD flags = QueryInformationJobObject(job, JobObjectExtendedLimitInformation, &limits, sizeof limits, NULL) ? limits.BasicLimitInformation.LimitFlags : 0;
  cell("J1", (flags & JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE) && !(flags & (JOB_OBJECT_LIMIT_BREAKAWAY_OK | JOB_OBJECT_LIMIT_SILENT_BREAKAWAY_OK)),
       "limit_flags=0x%lx", flags);
  sddl_of(job, sddl, sizeof sddl);
  info("J8", "default job security descriptor (creator token): %s", sddl);

  wchar_t *command = self_command(L"root");
  err = command ? spawn(&root, command, job, NULL, 0) : ERROR_OUTOFMEMORY;
  free(command);
  if (err) { cell("J2", 0, "job_list_spawn_err=%lu", err); CloseHandle(job); return; }
  int got = read_line(root.out, line, sizeof line, WAIT_MS);
  DWORD leaf_pid = field(line, "leaf=");
  HANDLE leaf = leaf_pid ? OpenProcess(SYNCHRONIZE | PROCESS_QUERY_LIMITED_INFORMATION | PROCESS_TERMINATE, FALSE, leaf_pid) : NULL;
  int root_in = in_job(root.process, job), leaf_in = leaf ? in_job(leaf, job) : -1;
  const char *breakaway = strstr(line, "breakaway=");
  cell("J2", got >= 0 && root_in == 1 && leaf_in == 1 && breakaway && !strncmp(breakaway, "breakaway=err5", 14) && active_processes(job) == 2,
       "root=%lu root_in_job=%d leaf=%lu leaf_in_job=%d active=%ld %s", root.pid, root_in, leaf_pid, leaf_in, active_processes(job), breakaway ? breakaway : line);

  unsigned long long root_at = 0, leaf_at = 0;
  int pinned = creation(root.process, &root_at) && leaf && creation(leaf, &leaf_at);
  cell("J3", pinned && leaf_at >= root_at && in_job(GetCurrentProcess(), job) == 0,
       "root_creation=%llu leaf_creation=%llu launcher_in_custody_job=%d", root_at, leaf_at, in_job(GetCurrentProcess(), job));

  BOOL terminated = TerminateJobObject(job, TERMINATED);
  int r = exited(root.process, WAIT_MS, &code_root), l = leaf && exited(leaf, WAIT_MS, &code_leaf);
  cell("J4", terminated && r && l && code_root == TERMINATED && code_leaf == TERMINATED && active_processes(job) == 0,
       "terminate_job=%d root_exit=0x%lx leaf_exit=0x%lx active_after=%ld launcher_alive=1", terminated, code_root, code_leaf, active_processes(job));
  if (leaf) CloseHandle(leaf);
  child_close(&root);
  CloseHandle(job);

  // The other documented placement: start suspended, assign, then resume.
  child_t late;
  job = custody_job(&err);
  command = self_command(L"leaf");
  err = job && command ? spawn(&late, command, NULL, NULL, CREATE_SUSPENDED) : (err ? err : ERROR_OUTOFMEMORY);
  free(command);
  if (err) cell("J5", 0, "suspended_spawn_err=%lu", err);
  else {
    int before = in_job(late.process, NULL);
    DWORD assign = AssignProcessToJobObject(job, late.process) ? 0 : GetLastError();
    ResumeThread(late.thread);
    got = read_line(late.out, line, sizeof line, WAIT_MS);
    int inside = in_job(late.process, job);
    TerminateJobObject(job, TERMINATED);
    int done = exited(late.process, WAIT_MS, &code_leaf);
    cell("J5", !assign && got >= 0 && inside == 1 && done && code_leaf == TERMINATED,
         "in_any_job_before=%d assign_err=%lu ran=%d in_job=%d exit=0x%lx", before, assign, got >= 0, inside, code_leaf);
    child_close(&late);
  }
  if (job) CloseHandle(job);

  // Nesting: a member of the custody job joins a job of its own; terminating the outer job still ends it.
  child_t nest;
  job = custody_job(&err);
  command = self_command(L"nest");
  err = job && command ? spawn(&nest, command, job, NULL, 0) : (err ? err : ERROR_OUTOFMEMORY);
  free(command);
  if (err) cell("J6", 0, "nest_spawn_err=%lu", err);
  else {
    got = read_line(nest.out, line, sizeof line, WAIT_MS);
    int outer = in_job(nest.process, job);
    TerminateJobObject(job, TERMINATED);
    int done = exited(nest.process, WAIT_MS, &code_leaf);
    cell("J6", got >= 0 && field(line, "assign_err=") == 0 && strstr(line, "in_inner=1") && outer == 1 && done && code_leaf == TERMINATED,
         "%s in_outer=%d exit=0x%lx", line, outer, code_leaf);
    child_close(&nest);
  }
  if (job) CloseHandle(job);

  // The custodian dies: its job handle closes and KILL_ON_JOB_CLOSE ends the tree.
  child_t custodian;
  command = self_command(L"custodian");
  err = command ? spawn(&custodian, command, NULL, NULL, 0) : ERROR_OUTOFMEMORY;
  free(command);
  if (err) { cell("J7", 0, "custodian_spawn_err=%lu", err); return; }
  got = read_line(custodian.out, line, sizeof line, WAIT_MS);
  DWORD access = SYNCHRONIZE | PROCESS_QUERY_LIMITED_INFORMATION | PROCESS_TERMINATE;
  DWORD root_pid = field(line, "root pid=");
  leaf_pid = field(line, "leaf=");
  HANDLE tree_root = root_pid ? OpenProcess(access, FALSE, root_pid) : NULL;
  leaf = leaf_pid ? OpenProcess(access, FALSE, leaf_pid) : NULL;
  int alive = tree_root && leaf && WaitForSingleObject(tree_root, 0) == WAIT_TIMEOUT && WaitForSingleObject(leaf, 0) == WAIT_TIMEOUT;
  TerminateProcess(custodian.process, KILLED);
  WaitForSingleObject(custodian.process, WAIT_MS);
  r = tree_root && exited(tree_root, WAIT_MS, &code_root);
  l = leaf && exited(leaf, WAIT_MS, &code_leaf);
  cell("J7", got >= 0 && alive && r && l, "%s alive_before=%d custodian killed: root_exited=%d (0x%lx) leaf_exited=%d (0x%lx)",
       line, alive, r, code_root, l, code_leaf);
  if (tree_root) { TerminateProcess(tree_root, KILLED); CloseHandle(tree_root); }
  if (leaf) { TerminateProcess(leaf, KILLED); CloseHandle(leaf); }
  child_close(&custodian);
}

static DWORD restricted_open(int deny_user, const wchar_t *job_name, const wchar_t *control_name, char *line, int size) {
  HANDLE token;
  child_t child;
  DWORD code = 0, err = restricted_token(deny_user, &token);
  const wchar_t *parts[] = { g_self, L"open-job", job_name, control_name };
  if (err) { snprintf(line, size, "restricted_token_err=%lu", err); return err; }
  wchar_t *command = command_line(parts, 4);
  err = command ? spawn(&child, command, NULL, token, 0) : ERROR_OUTOFMEMORY;
  free(command);
  CloseHandle(token);
  if (err) { snprintf(line, size, "create_process_as_user_err=%lu", err); return err; }
  if (read_line(child.out, line, size, WAIT_MS) < 0 && !line[0]) snprintf(line, size, "no_line");
  if (!exited(child.process, WAIT_MS, &code)) TerminateProcess(child.process, KILLED);
  size_t used = strlen(line);
  snprintf(line + used, size - used, " child_exit=0x%lx", code);
  child_close(&child);
  return 0;
}

static void cross_cells(int as_restricted) {
  wchar_t job_name[96], control_name[96], other_name[96], tagged[512], other[512];
  SECURITY_ATTRIBUTES job_sa, control_sa, other_sa;
  char line[512], sddl[1024];
  DWORD stamp = (DWORD)GetTickCount64();
  swprintf(job_name, ARRAYSIZE(job_name), L"Local\\cotal-probe-job-%lu-%lu", GetCurrentProcessId(), stamp);
  swprintf(control_name, ARRAYSIZE(control_name), L"Local\\cotal-probe-ctl-%lu-%lu", GetCurrentProcessId(), stamp);
  swprintf(other_name, ARRAYSIZE(other_name), L"Local\\cotal-probe-other-%lu-%lu", GetCurrentProcessId(), stamp);
  // SID-tagged: owner and the only grant are this user; the medium label keeps integrity out of the check.
  swprintf(tagged, ARRAYSIZE(tagged), L"O:%lsD:P(A;;GA;;;%ls)S:(ML;;NW;;;ME)", g_user_sid, g_user_sid);
  swprintf(other, ARRAYSIZE(other), L"O:%lsD:P(A;;GA;;;LS)S:(ML;;NW;;;ME)", g_user_sid);
  memset(&job_sa, 0, sizeof job_sa);
  memset(&control_sa, 0, sizeof control_sa);
  memset(&other_sa, 0, sizeof other_sa);
  job_sa.nLength = control_sa.nLength = other_sa.nLength = sizeof job_sa;
  if (!ConvertStringSecurityDescriptorToSecurityDescriptorW(tagged, SDDL_REVISION_1, &job_sa.lpSecurityDescriptor, NULL)
      || !ConvertStringSecurityDescriptorToSecurityDescriptorW(L"D:P(A;;GA;;;WD)S:(ML;;NW;;;ME)", SDDL_REVISION_1, &control_sa.lpSecurityDescriptor, NULL)
      || !ConvertStringSecurityDescriptorToSecurityDescriptorW(other, SDDL_REVISION_1, &other_sa.lpSecurityDescriptor, NULL)) {
    cell("X1", 0, "sddl_err=%lu", GetLastError());
    return;
  }
  HANDLE job = CreateJobObjectW(&job_sa, job_name);
  DWORD created = GetLastError();
  HANDLE control = CreateEventW(&control_sa, TRUE, FALSE, control_name);
  HANDLE foreign = CreateJobObjectW(&other_sa, other_name);
  if (!job || !control || !foreign) cell("X1", 0, "create_err=%lu", GetLastError());
  else {
    sddl_of(job, sddl, sizeof sddl);
    DWORD query = open_err(job_name, JOB_OBJECT_QUERY), terminate = open_err(job_name, JOB_OBJECT_TERMINATE);
    cell("X1", created != ERROR_ALREADY_EXISTS && !query && !terminate, "sid_tagged_job self open: query_err=%lu terminate_err=%lu sd=%s", query, terminate, sddl);

    HANDLE again = CreateJobObjectW(&job_sa, job_name);
    DWORD again_err = GetLastError();
    cell("X5", again != NULL && again_err == ERROR_ALREADY_EXISTS, "second create of the same name: handle=%d err=%lu (a creator detects an existing name)", again != NULL, again_err);
    if (again) CloseHandle(again);

    query = open_err(other_name, JOB_OBJECT_QUERY);
    terminate = open_err(other_name, JOB_OBJECT_TERMINATE);
    cell("X2", query == ERROR_ACCESS_DENIED && terminate == ERROR_ACCESS_DENIED, "job granted only to LocalService, self open: query_err=%lu terminate_err=%lu", query, terminate);

    if (as_restricted) {
      info("X3", "skipped: already under the restricted token");
      info("X4", "skipped: already under the restricted token");
    } else {
      // Same user, administrators deny-only, no privileges, medium integrity.
      if (restricted_open(0, job_name, control_name, line, sizeof line)) cell("X3", 0, "%s", line);
      else cell("X3", field(line, "control_err=") == 0 && field(line, "query_err=") == 0 && field(line, "terminate_err=") == 0 && strstr(line, "admin_enabled=0"), "%s", line);
      // The user SID deny-only too: another principal for this DACL check only, not a second logon.
      if (restricted_open(1, job_name, control_name, line, sizeof line)) cell("X4", 0, "%s", line);
      else cell("X4", strstr(line, "control_err=0 ") && field(line, "query_err=") == ERROR_ACCESS_DENIED && field(line, "terminate_err=") == ERROR_ACCESS_DENIED, "%s", line);
    }
  }
  if (job) CloseHandle(job);
  if (control) CloseHandle(control);
  if (foreign) CloseHandle(foreign);
  LocalFree(job_sa.lpSecurityDescriptor);
  LocalFree(control_sa.lpSecurityDescriptor);
  LocalFree(other_sa.lpSecurityDescriptor);
}

static int mode_all(int as_restricted) {
  DWORD session = 0;
  ProcessIdToSessionId(GetCurrentProcessId(), &session);
  info("P0", "pid=%lu session=%lu in_any_job_at_start=%d as_restricted=%d", GetCurrentProcessId(), session, in_job(GetCurrentProcess(), NULL), as_restricted);
  identity_cells();
  job_cells();
  cross_cells(as_restricted);
  printf("P9 %s failed=%d\n", g_failed ? "FAIL" : "PASS", g_failed);
  fflush(stdout);
  return g_failed ? 1 : 0;
}

int wmain(int argc, wchar_t **argv) {
  const wchar_t *mode = argc > 1 ? argv[1] : L"all";
  if (!GetModuleFileNameW(NULL, g_self, ARRAYSIZE(g_self))) return 3;
  if (!wcscmp(mode, L"leaf")) return mode_leaf();
  if (!wcscmp(mode, L"root")) return mode_root();
  if (!wcscmp(mode, L"nest")) return mode_nest();
  if (!wcscmp(mode, L"custodian")) return mode_custodian();
  if (!wcscmp(mode, L"open-job") && argc == 4) return mode_open_job(argv[2], argv[3]);
  if (!wcscmp(mode, L"run-restricted") && argc >= 3) return mode_run_restricted(argc - 2, argv + 2);
  if (!wcscmp(mode, L"node-chain") && argc == 5) return mode_node_chain(argv[2], argv[3], argv[4]);
  if (!wcscmp(mode, L"all")) return mode_all(argc > 2 && !wcscmp(argv[2], L"--as-restricted"));
  fprintf(stderr, "usage: probe [all [--as-restricted] | run-restricted <exe> [args...] | node-chain <node> <run.mjs> <0|1>]\n");
  return 2;
}
