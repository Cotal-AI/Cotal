#define WIN32_LEAN_AND_MEAN
#define _WIN32_WINNT 0x0A00
#define NAPI_VERSION 8
#include <windows.h>
#include <sddl.h>
#include <node_api.h>
#include <math.h>
#include <stdint.h>
#include <stdio.h>
#include <string.h>
#include <wchar.h>

static napi_value unreadable(napi_env env) {
  napi_value value;
  if (napi_get_undefined(env, &value) != napi_ok) return NULL;
  return value;
}

static napi_value fail(napi_env env, const char *what) {
  char message[200];
  DWORD code = GetLastError();
  snprintf(message, sizeof(message), "%s failed (Windows error %lu)", what, (unsigned long)code);
  napi_throw_error(env, NULL, message);
  return NULL;
}

static napi_value refuse(napi_env env, const char *message) {
  napi_throw_error(env, NULL, message);
  return NULL;
}

// FILETIME exceeds Number's exact integer range. Keep every bit through the JS boundary.
static napi_value filetime_token(napi_env env, FILETIME time) {
  uint64_t ticks = ((uint64_t)time.dwHighDateTime << 32) | time.dwLowDateTime;
  char token[21];
  int length = snprintf(token, sizeof(token), "%llu", (unsigned long long)ticks);
  if (length < 1 || length >= (int)sizeof(token)) return unreadable(env);
  napi_value value;
  if (napi_create_string_utf8(env, token, (size_t)length, &value) != napi_ok) return NULL;
  return value;
}

static int pid_arg(napi_env env, napi_callback_info info, DWORD *pid) {
  size_t argc = 1;
  napi_value arg;
  double value;
  if (napi_get_cb_info(env, info, &argc, &arg, NULL, NULL) != napi_ok || argc != 1 ||
      napi_get_value_double(env, arg, &value) != napi_ok || !isfinite(value) ||
      value < 1 || value > INT32_MAX || value != (double)(uint32_t)value) return 0;
  *pid = (DWORD)value;
  return 1;
}

static napi_value creation_token(napi_env env, napi_callback_info info) {
  DWORD pid;
  if (!pid_arg(env, info, &pid)) return unreadable(env);
  HANDLE process = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, FALSE, pid);
  if (process == NULL) return unreadable(env);
  FILETIME creation, exit_time, kernel_time, user_time;
  BOOL ok = GetProcessTimes(process, &creation, &exit_time, &kernel_time, &user_time);
  CloseHandle(process);
  if (!ok) return unreadable(env);
  return filetime_token(env, creation);
}

// The account this process runs as, as its string SID.
static napi_value user_sid(napi_env env, napi_callback_info info) {
  (void)info;
  HANDLE token;
  if (!OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &token)) return fail(env, "OpenProcessToken");
  DWORD size = 0;
  GetTokenInformation(token, TokenUser, NULL, 0, &size);
  TOKEN_USER *user = size == 0 ? NULL : HeapAlloc(GetProcessHeap(), 0, size);
  if (user == NULL || !GetTokenInformation(token, TokenUser, user, size, &size)) {
    DWORD code = GetLastError();
    if (user != NULL) HeapFree(GetProcessHeap(), 0, user);
    CloseHandle(token);
    SetLastError(code);
    return fail(env, "GetTokenInformation");
  }
  CloseHandle(token);
  wchar_t *text = NULL;
  BOOL converted = ConvertSidToStringSidW(user->User.Sid, &text);
  DWORD code = GetLastError();
  HeapFree(GetProcessHeap(), 0, user);
  if (!converted) { SetLastError(code); return fail(env, "ConvertSidToStringSidW"); }
  napi_value value;
  napi_status status = napi_create_string_utf16(env, (const char16_t *)text, NAPI_AUTO_LENGTH, &value);
  LocalFree(text);
  return status == napi_ok ? value : NULL;
}

// The firmware table provider for raw SMBIOS data, 'RSMB'.
#define RSMB_PROVIDER 0x52534D42u

// This machine's SMBIOS system UUID (structure type 1), as GetSystemFirmwareTable documents it.
// SMBIOS 2.6 and later store its first three fields little-endian. A UUID the firmware left unset,
// all zeros or all ones, identifies no machine and is refused.
static napi_value machine_uuid(napi_env env, napi_callback_info info) {
  (void)info;
  UINT size = GetSystemFirmwareTable(RSMB_PROVIDER, 0, NULL, 0);
  if (size < 8) return fail(env, "GetSystemFirmwareTable");
  BYTE *data = HeapAlloc(GetProcessHeap(), 0, size);
  if (data == NULL) return refuse(env, "firmware table allocation failed");
  UINT read = GetSystemFirmwareTable(RSMB_PROVIDER, 0, data, size);
  BYTE uuid[16];
  int found = 0;
  DWORD length = 0;
  if (read >= 8 && read <= size) memcpy(&length, data + 4, sizeof(length));
  if (read >= 8 && read <= size && length <= read - 8) {
    const BYTE *p = data + 8, *end = data + 8 + length;
    while (!found && end - p >= 4) {
      BYTE type = p[0], formatted = p[1];
      if (formatted < 4 || end - p < formatted) break;
      if (type == 1 && formatted >= 0x19) { memcpy(uuid, p + 8, sizeof(uuid)); found = 1; break; }
      if (type == 127) break;
      const BYTE *q = p + formatted;
      while (end - q >= 2 && (q[0] != 0 || q[1] != 0)) q++;
      if (end - q < 2) break;
      p = q + 2;
    }
  }
  BYTE major = 0, minor = 0;
  if (read >= 8) { major = data[1]; minor = data[2]; }
  HeapFree(GetProcessHeap(), 0, data);
  if (!found) return refuse(env, "the firmware reports no SMBIOS system UUID");
  int zeros = 1, ones = 1;
  for (int i = 0; i < 16; i++) { zeros &= uuid[i] == 0x00; ones &= uuid[i] == 0xFF; }
  if (zeros || ones) return refuse(env, "the firmware's SMBIOS system UUID is unset");
  if (major > 2 || (major == 2 && minor >= 6)) {
    BYTE swapped[16];
    memcpy(swapped, uuid, sizeof(swapped));
    for (int i = 0; i < 4; i++) uuid[i] = swapped[3 - i];
    uuid[4] = swapped[5]; uuid[5] = swapped[4];
    uuid[6] = swapped[7]; uuid[7] = swapped[6];
  }
  char text[37];
  int written = snprintf(text, sizeof(text), "%02x%02x%02x%02x-%02x%02x-%02x%02x-%02x%02x-%02x%02x%02x%02x%02x%02x",
    uuid[0], uuid[1], uuid[2], uuid[3], uuid[4], uuid[5], uuid[6], uuid[7], uuid[8], uuid[9], uuid[10], uuid[11], uuid[12], uuid[13], uuid[14], uuid[15]);
  if (written != 36) return refuse(env, "the SMBIOS system UUID could not be formatted");
  napi_value value;
  if (napi_create_string_utf8(env, text, 36, &value) != napi_ok) return NULL;
  return value;
}

// One launched job per process. Its handle is never finalized from JS: closing the last handle
// terminates every member, so it lives until this process exits.
static HANDLE job = NULL;
static HANDLE root = NULL;

static wchar_t *string_property(napi_env env, napi_value object, const char *name, int block) {
  napi_value value;
  napi_valuetype type;
  size_t length, copied;
  if (napi_get_named_property(env, object, name, &value) != napi_ok || napi_typeof(env, value, &type) != napi_ok ||
      type != napi_string || napi_get_value_string_utf16(env, value, NULL, 0, &length) != napi_ok || length == 0 || length > (block ? 1048576u : 32767u)) return NULL;
  wchar_t *buffer = HeapAlloc(GetProcessHeap(), HEAP_ZERO_MEMORY, (length + 1) * sizeof(wchar_t));
  if (buffer == NULL) return NULL;
  if (napi_get_value_string_utf16(env, value, (char16_t *)buffer, length + 1, &copied) != napi_ok || copied != length) {
    HeapFree(GetProcessHeap(), 0, buffer);
    return NULL;
  }
  // A path or command line holds no NUL. An environment block is NUL-separated entries, each
  // ending in NUL, and the terminator here makes its closing empty entry.
  size_t first = wcslen(buffer);
  int valid = block ? buffer[length - 1] == L'\0' && buffer[0] != L'\0' : first == length;
  for (size_t i = 1; block && valid && i < length; i++) if (buffer[i] == L'\0' && buffer[i - 1] == L'\0') valid = 0;
  if (!valid) {
    HeapFree(GetProcessHeap(), 0, buffer);
    return NULL;
  }
  return buffer;
}

static void free_strings(wchar_t **strings, int count) {
  for (int i = 0; i < count; i++) if (strings[i] != NULL) HeapFree(GetProcessHeap(), 0, strings[i]);
}

static napi_value launch_result(napi_env env, DWORD pid, FILETIME creation) {
  napi_value result, pid_value, token;
  if (napi_create_object(env, &result) != napi_ok || napi_create_uint32(env, pid, &pid_value) != napi_ok ||
      (token = filetime_token(env, creation)) == NULL ||
      napi_set_named_property(env, result, "pid", pid_value) != napi_ok ||
      napi_set_named_property(env, result, "token", token) != napi_ok) return NULL;
  return result;
}

// Start `application` inside a new job before it runs. The job kills every member when its last
// handle closes and allows no breakaway. The child inherits only its input and the log; the job
// handle stays private to this process.
static napi_value launch(napi_env env, napi_callback_info info) {
  size_t argc = 1;
  napi_value options;
  napi_valuetype type;
  if (napi_get_cb_info(env, info, &argc, &options, NULL, NULL) != napi_ok || argc != 1 ||
      napi_typeof(env, options, &type) != napi_ok || type != napi_object) return refuse(env, "launch takes one options object");
  if (job != NULL) return refuse(env, "this process already holds a launched job");
  const char *names[5] = { "application", "commandLine", "cwd", "environment", "log" };
  wchar_t *strings[5];
  for (int i = 0; i < 5; i++) strings[i] = string_property(env, options, names[i], i == 3);
  for (int i = 0; i < 5; i++) if (strings[i] == NULL) { free_strings(strings, 5); return refuse(env, "launch needs an application, command line, directory, environment block and log path"); }

  const char *step = NULL;
  DWORD code = ERROR_SUCCESS;
  HANDLE created = NULL, input = INVALID_HANDLE_VALUE, output = INVALID_HANDLE_VALUE;
  LPPROC_THREAD_ATTRIBUTE_LIST attributes = NULL;
  PROCESS_INFORMATION child;
  ZeroMemory(&child, sizeof(child));
  FILETIME creation, exit_time, kernel_time, user_time;
  JOBOBJECT_EXTENDED_LIMIT_INFORMATION limits, applied;
  ZeroMemory(&limits, sizeof(limits));
  ZeroMemory(&applied, sizeof(applied));
  limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
  SECURITY_ATTRIBUTES inheritable = { sizeof(SECURITY_ATTRIBUTES), NULL, TRUE };
  HANDLE inherited[2];
  SIZE_T size = 0;
  STARTUPINFOEXW startup;
  ZeroMemory(&startup, sizeof(startup));
  BOOL member = FALSE;

  if ((created = CreateJobObjectW(NULL, NULL)) == NULL) { step = "CreateJobObjectW"; goto failed; }
  if (!SetInformationJobObject(created, JobObjectExtendedLimitInformation, &limits, sizeof(limits))) { step = "SetInformationJobObject"; goto failed; }
  if (!QueryInformationJobObject(created, JobObjectExtendedLimitInformation, &applied, sizeof(applied), NULL)) { step = "QueryInformationJobObject"; goto failed; }
  if ((applied.BasicLimitInformation.LimitFlags & (JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE | JOB_OBJECT_LIMIT_BREAKAWAY_OK | JOB_OBJECT_LIMIT_SILENT_BREAKAWAY_OK)) != JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE) {
    SetLastError(ERROR_INVALID_DATA); step = "job limit verification"; goto failed;
  }
  input = CreateFileW(L"NUL", GENERIC_READ, FILE_SHARE_READ | FILE_SHARE_WRITE, &inheritable, OPEN_EXISTING, FILE_ATTRIBUTE_NORMAL, NULL);
  if (input == INVALID_HANDLE_VALUE) { step = "CreateFileW(NUL)"; goto failed; }
  output = CreateFileW(strings[4], FILE_APPEND_DATA, FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE, &inheritable, OPEN_EXISTING, FILE_ATTRIBUTE_NORMAL, NULL);
  if (output == INVALID_HANDLE_VALUE) { step = "CreateFileW(log)"; goto failed; }
  inherited[0] = input;
  inherited[1] = output;
  InitializeProcThreadAttributeList(NULL, 2, 0, &size);
  if (size == 0 || (attributes = HeapAlloc(GetProcessHeap(), 0, size)) == NULL) { step = "attribute list allocation"; goto failed; }
  if (!InitializeProcThreadAttributeList(attributes, 2, 0, &size)) { HeapFree(GetProcessHeap(), 0, attributes); attributes = NULL; step = "InitializeProcThreadAttributeList"; goto failed; }
  if (!UpdateProcThreadAttribute(attributes, 0, PROC_THREAD_ATTRIBUTE_JOB_LIST, &created, sizeof(HANDLE), NULL, NULL)) { step = "UpdateProcThreadAttribute(job)"; goto failed; }
  if (!UpdateProcThreadAttribute(attributes, 0, PROC_THREAD_ATTRIBUTE_HANDLE_LIST, inherited, sizeof(inherited), NULL, NULL)) { step = "UpdateProcThreadAttribute(handles)"; goto failed; }
  startup.StartupInfo.cb = sizeof(startup);
  // Detached and hidden, as a Node spawn with `detached` and `windowsHide` starts a program.
  startup.StartupInfo.dwFlags = STARTF_USESTDHANDLES | STARTF_USESHOWWINDOW;
  startup.StartupInfo.wShowWindow = SW_HIDE;
  startup.StartupInfo.hStdInput = input;
  startup.StartupInfo.hStdOutput = output;
  startup.StartupInfo.hStdError = output;
  startup.lpAttributeList = attributes;
  // Suspended, so membership and the creation pin are read before the child runs any code.
  if (!CreateProcessW(strings[0], strings[1], NULL, NULL, TRUE,
      EXTENDED_STARTUPINFO_PRESENT | CREATE_UNICODE_ENVIRONMENT | DETACHED_PROCESS | CREATE_SUSPENDED,
      strings[3], strings[2], &startup.StartupInfo, &child)) { step = "CreateProcessW"; goto failed; }
  if (!IsProcessInJob(child.hProcess, created, &member)) { step = "IsProcessInJob"; goto failed; }
  if (!member) { SetLastError(ERROR_INVALID_DATA); step = "job membership verification"; goto failed; }
  if (!GetProcessTimes(child.hProcess, &creation, &exit_time, &kernel_time, &user_time)) { step = "GetProcessTimes"; goto failed; }
  if (ResumeThread(child.hThread) == (DWORD)-1) { step = "ResumeThread"; goto failed; }
  CloseHandle(child.hThread);
  CloseHandle(input);
  CloseHandle(output);
  DeleteProcThreadAttributeList(attributes);
  HeapFree(GetProcessHeap(), 0, attributes);
  free_strings(strings, 5);
  job = created;
  root = child.hProcess;
  return launch_result(env, child.dwProcessId, creation);

failed:
  code = GetLastError();
  if (child.hProcess != NULL) { TerminateProcess(child.hProcess, 1); CloseHandle(child.hProcess); }
  if (child.hThread != NULL) CloseHandle(child.hThread);
  if (input != INVALID_HANDLE_VALUE) CloseHandle(input);
  if (output != INVALID_HANDLE_VALUE) CloseHandle(output);
  if (attributes != NULL) { DeleteProcThreadAttributeList(attributes); HeapFree(GetProcessHeap(), 0, attributes); }
  if (created != NULL) CloseHandle(created);
  free_strings(strings, 5);
  SetLastError(code);
  return fail(env, step);
}

static int launched(napi_env env) {
  if (job != NULL) return 1;
  napi_throw_error(env, NULL, "this process holds no launched job");
  return 0;
}

// The launched process's exit code once it has exited, otherwise undefined.
static napi_value root_exit(napi_env env, napi_callback_info info) {
  (void)info;
  if (!launched(env)) return NULL;
  DWORD wait = WaitForSingleObject(root, 0), code;
  if (wait == WAIT_TIMEOUT) return unreadable(env);
  if (wait != WAIT_OBJECT_0) return fail(env, "WaitForSingleObject");
  if (!GetExitCodeProcess(root, &code)) return fail(env, "GetExitCodeProcess");
  napi_value value;
  if (napi_create_uint32(env, code, &value) != napi_ok) return NULL;
  return value;
}

// The process IDs the job holds now.
static napi_value job_processes(napi_env env, napi_callback_info info) {
  (void)info;
  if (!launched(env)) return NULL;
  DWORD capacity = 64;
  for (int attempt = 0; attempt < 8; attempt++) {
    DWORD bytes = (DWORD)(sizeof(JOBOBJECT_BASIC_PROCESS_ID_LIST) + (capacity - 1) * sizeof(ULONG_PTR));
    JOBOBJECT_BASIC_PROCESS_ID_LIST *list = HeapAlloc(GetProcessHeap(), HEAP_ZERO_MEMORY, bytes);
    if (list == NULL) return refuse(env, "job process list allocation failed");
    BOOL ok = QueryInformationJobObject(job, JobObjectBasicProcessIdList, list, bytes, NULL);
    DWORD code = GetLastError();
    if ((ok || code == ERROR_MORE_DATA) && list->NumberOfProcessIdsInList < list->NumberOfAssignedProcesses) {
      capacity = list->NumberOfAssignedProcesses + 16;
      HeapFree(GetProcessHeap(), 0, list);
      continue;
    }
    if (!ok) { HeapFree(GetProcessHeap(), 0, list); SetLastError(code); return fail(env, "QueryInformationJobObject"); }
    napi_value result, pid;
    if (napi_create_array_with_length(env, list->NumberOfProcessIdsInList, &result) != napi_ok) { HeapFree(GetProcessHeap(), 0, list); return NULL; }
    for (DWORD i = 0; i < list->NumberOfProcessIdsInList; i++) {
      if (napi_create_uint32(env, (uint32_t)list->ProcessIdList[i], &pid) != napi_ok || napi_set_element(env, result, i, pid) != napi_ok) {
        HeapFree(GetProcessHeap(), 0, list);
        return NULL;
      }
    }
    HeapFree(GetProcessHeap(), 0, list);
    return result;
  }
  return refuse(env, "the job's process list kept growing");
}

// Whether a process is a member of the launched job; undefined when it cannot be opened.
static napi_value in_job(napi_env env, napi_callback_info info) {
  DWORD pid;
  if (!pid_arg(env, info, &pid)) return unreadable(env);
  if (!launched(env)) return NULL;
  HANDLE process = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, FALSE, pid);
  if (process == NULL) return unreadable(env);
  BOOL member = FALSE;
  BOOL ok = IsProcessInJob(process, job, &member);
  CloseHandle(process);
  if (!ok) return fail(env, "IsProcessInJob");
  napi_value value;
  if (napi_get_boolean(env, member != FALSE, &value) != napi_ok) return NULL;
  return value;
}

// Terminate every process in the launched job with `code`.
static napi_value terminate(napi_env env, napi_callback_info info) {
  size_t argc = 1;
  napi_value arg;
  uint32_t code;
  if (napi_get_cb_info(env, info, &argc, &arg, NULL, NULL) != napi_ok || argc != 1 ||
      napi_get_value_uint32(env, arg, &code) != napi_ok) return refuse(env, "terminate takes one exit code");
  if (!launched(env)) return NULL;
  if (!TerminateJobObject(job, code)) return fail(env, "TerminateJobObject");
  return unreadable(env);
}

NAPI_MODULE_INIT() {
  napi_property_descriptor properties[] = {
    { "creationToken", NULL, creation_token, NULL, NULL, NULL, napi_enumerable, NULL },
    { "userSid", NULL, user_sid, NULL, NULL, NULL, napi_enumerable, NULL },
    { "machineUuid", NULL, machine_uuid, NULL, NULL, NULL, napi_enumerable, NULL },
    { "launch", NULL, launch, NULL, NULL, NULL, napi_enumerable, NULL },
    { "rootExit", NULL, root_exit, NULL, NULL, NULL, napi_enumerable, NULL },
    { "jobProcesses", NULL, job_processes, NULL, NULL, NULL, napi_enumerable, NULL },
    { "inJob", NULL, in_job, NULL, NULL, NULL, napi_enumerable, NULL },
    { "terminate", NULL, terminate, NULL, NULL, NULL, napi_enumerable, NULL },
  };
  if (napi_define_properties(env, exports, sizeof(properties) / sizeof(properties[0]), properties) != napi_ok) return NULL;
  return exports;
}
