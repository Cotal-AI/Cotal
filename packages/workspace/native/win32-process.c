#define WIN32_LEAN_AND_MEAN
#define NAPI_VERSION 8
#include <windows.h>
#include <node_api.h>
#include <math.h>
#include <stdint.h>
#include <stdio.h>
#include "../smoke/fixtures/win32-privilege-diagnostic.h"

static napi_value unreadable(napi_env env) {
  napi_value value;
  if (napi_get_undefined(env, &value) != napi_ok) return NULL;
  return value;
}

static napi_value creation_token(napi_env env, napi_callback_info info) {
  size_t argc = 1;
  napi_value arg;
  double pid;
  if (napi_get_cb_info(env, info, &argc, &arg, NULL, NULL) != napi_ok || argc != 1 ||
      napi_get_value_double(env, arg, &pid) != napi_ok || !isfinite(pid) ||
      pid < 1 || pid > INT32_MAX || pid != (double)(uint32_t)pid) return unreadable(env);

  static unsigned probes = 0;
  int debug = probes < 8 ? diagnostic_debug_enabled() : -1;
  HANDLE process = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, FALSE, (DWORD)pid);
  DWORD error = process == NULL ? GetLastError() : 0;
  if (probes++ < 8) fprintf(stderr, "NATIVE_QUERY {\"self\":%s,\"debugEnabled\":%d,\"opened\":%s,\"error\":%lu}\n",
    (DWORD)pid == GetCurrentProcessId() ? "true" : "false", debug, process != NULL ? "true" : "false", (unsigned long)error);
  if (process == NULL) return unreadable(env);
  FILETIME creation, exit_time, kernel_time, user_time;
  BOOL ok = GetProcessTimes(process, &creation, &exit_time, &kernel_time, &user_time);
  CloseHandle(process);
  if (!ok) return unreadable(env);

  // FILETIME exceeds Number's exact integer range. Keep every bit through the JS boundary.
  uint64_t ticks = ((uint64_t)creation.dwHighDateTime << 32) | creation.dwLowDateTime;
  char token[21];
  int length = snprintf(token, sizeof(token), "%llu", (unsigned long long)ticks);
  if (length < 1 || length >= (int)sizeof(token)) return unreadable(env);
  napi_value value;
  if (napi_create_string_utf8(env, token, (size_t)length, &value) != napi_ok) return NULL;
  return value;
}

NAPI_MODULE_INIT() {
  napi_value reader;
  if (napi_create_function(env, "creationToken", NAPI_AUTO_LENGTH, creation_token, NULL, &reader) != napi_ok ||
      napi_set_named_property(env, exports, "creationToken", reader) != napi_ok) return NULL;
  return exports;
}
