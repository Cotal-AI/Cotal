#define WIN32_LEAN_AND_MEAN
#define NAPI_VERSION 8
#include <windows.h>
#include <node_api.h>
#include <math.h>
#include <stdint.h>

// Test-only. The callback runs synchronously under a private thread token, never a changed
// process token. The independent probe must see a real query denial before invoking the reader.
static napi_value read_denied(napi_env env, napi_callback_info info) {
  size_t argc = 2;
  napi_value args[2];
  napi_valuetype type;
  double pid;
  if (napi_get_cb_info(env, info, &argc, args, NULL, NULL) != napi_ok || argc != 2 ||
      napi_get_value_double(env, args[0], &pid) != napi_ok || !isfinite(pid) ||
      pid < 1 || pid > INT32_MAX || pid != (double)(uint32_t)pid ||
      napi_typeof(env, args[1], &type) != napi_ok || type != napi_function) {
    napi_throw_type_error(env, NULL, "expected a process pid and synchronous reader callback");
    return NULL;
  }
  HANDLE ambient;
  if (OpenThreadToken(GetCurrentThread(), TOKEN_QUERY, TRUE, &ambient)) {
    CloseHandle(ambient);
    napi_throw_error(env, NULL, "refusing to replace an existing thread security context");
    return NULL;
  }
  if (GetLastError() != ERROR_NO_TOKEN || !ImpersonateSelf(SecurityImpersonation)) {
    napi_throw_error(env, NULL, "could not create a private test thread token");
    return NULL;
  }
  HANDLE token = NULL;
  napi_value result = NULL;
  napi_status status = napi_ok;
  const char *failure = NULL;
  do {
    if (!OpenThreadToken(GetCurrentThread(), TOKEN_QUERY | TOKEN_ADJUST_PRIVILEGES, TRUE, &token)) {
      failure = "could not open the private test thread token"; break;
    }
    TOKEN_PRIVILEGES desired;
    ZeroMemory(&desired, sizeof(desired));
    desired.PrivilegeCount = 1;
    if (!LookupPrivilegeValueA(NULL, "SeDebugPrivilege", &desired.Privileges[0].Luid)) {
      failure = "could not identify the debug privilege"; break;
    }
    SetLastError(ERROR_SUCCESS);
    BOOL adjusted = AdjustTokenPrivileges(token, FALSE, &desired, 0, NULL, NULL);
    DWORD error = GetLastError();
    if (!adjusted || (error != ERROR_SUCCESS && error != ERROR_NOT_ALL_ASSIGNED)) {
      failure = "could not disable debug on the private test thread token"; break;
    }
    HANDLE target = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, FALSE, (DWORD)pid);
    error = target == NULL ? GetLastError() : ERROR_SUCCESS;
    if (target != NULL) CloseHandle(target);
    if (error != ERROR_ACCESS_DENIED) {
      failure = "the independent native probe did not establish query denial"; break;
    }
    napi_value receiver;
    status = napi_get_undefined(env, &receiver);
    if (status == napi_ok) status = napi_call_function(env, receiver, args[1], 0, NULL, &result);
  } while (0);
  BOOL reverted = RevertToSelf();
  if (token != NULL) CloseHandle(token);
  if (!reverted) failure = "could not restore the original test thread security context";
  if (failure != NULL) { napi_throw_error(env, NULL, failure); return NULL; }
  return status == napi_ok ? result : NULL;
}

NAPI_MODULE_INIT() {
  napi_value control;
  if (napi_create_function(env, "readDenied", NAPI_AUTO_LENGTH, read_denied, NULL, &control) != napi_ok ||
      napi_set_named_property(env, exports, "readDenied", control) != napi_ok) return NULL;
  return exports;
}
