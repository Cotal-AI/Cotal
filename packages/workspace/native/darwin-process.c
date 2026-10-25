#define _DARWIN_C_SOURCE
#define NAPI_VERSION 8
#include <node_api.h>
#include <errno.h>
#include <math.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/types.h>
#include <sys/proc.h>
#include <sys/sysctl.h>
#include <time.h>
#include <unistd.h>
#include <uuid/uuid.h>

static napi_value undefined_value(napi_env env) {
  napi_value value;
  if (napi_get_undefined(env, &value) != napi_ok) return NULL;
  return value;
}

static napi_value fail(napi_env env, const char *what, int error) {
  char message[160];
  snprintf(message, sizeof(message), "%s failed: %s", what, strerror(error));
  napi_throw_error(env, NULL, message);
  return NULL;
}

/* A positive integer within pid_t, or 0 for any other argument. */
static pid_t pid_argument(napi_env env, napi_callback_info info) {
  size_t argc = 1;
  napi_value arg;
  double value;
  if (napi_get_cb_info(env, info, &argc, &arg, NULL, NULL) != napi_ok || argc != 1 ||
      napi_get_value_double(env, arg, &value) != napi_ok || !isfinite(value) ||
      value < 1 || value > INT32_MAX || value != (double)(int32_t)value) return 0;
  return (pid_t)value;
}

static int set_number(napi_env env, napi_value object, const char *name, double number) {
  napi_value value;
  return napi_create_double(env, number, &value) == napi_ok && napi_set_named_property(env, object, name, value) == napi_ok;
}

static int set_boolean(napi_env env, napi_value object, const char *name, int flag) {
  napi_value value;
  return napi_get_boolean(env, flag != 0, &value) == napi_ok && napi_set_named_property(env, object, name, value) == napi_ok;
}

/* One process's kernel entry: its start time, its process group and whether it is stopped.
 * Undefined when no process has that ID; a failed read throws. */
static napi_value process_info(napi_env env, napi_callback_info info) {
  pid_t pid = pid_argument(env, info);
  if (pid == 0) return undefined_value(env);
  int mib[4] = {CTL_KERN, KERN_PROC, KERN_PROC_PID, pid};
  struct kinfo_proc entry;
  size_t length = sizeof(entry);
  memset(&entry, 0, sizeof(entry));
  if (sysctl(mib, 4, &entry, &length, NULL, 0) != 0) return fail(env, "sysctl KERN_PROC_PID", errno);
  if (length == 0) return undefined_value(env);
  if (length != sizeof(entry) || entry.kp_proc.p_pid != pid) {
    napi_throw_error(env, NULL, "sysctl KERN_PROC_PID returned another process entry");
    return NULL;
  }

  // The start time is a timeval. Keep every microsecond through the JS boundary as a decimal string.
  struct timeval start = entry.kp_proc.p_starttime;
  if (start.tv_sec < 0 || start.tv_usec < 0 || start.tv_usec >= 1000000) {
    napi_throw_error(env, NULL, "the process start time is out of range");
    return NULL;
  }
  char token[32];
  int written = snprintf(token, sizeof(token), "%llu", (unsigned long long)start.tv_sec * 1000000ULL + (unsigned long long)start.tv_usec);
  if (written < 1 || written >= (int)sizeof(token)) {
    napi_throw_error(env, NULL, "the process start time could not be formatted");
    return NULL;
  }

  napi_value result, text;
  if (napi_create_object(env, &result) != napi_ok ||
      napi_create_string_utf8(env, token, (size_t)written, &text) != napi_ok ||
      napi_set_named_property(env, result, "token", text) != napi_ok ||
      !set_number(env, result, "pgid", (double)entry.kp_eproc.e_pgid) ||
      !set_boolean(env, result, "stopped", entry.kp_proc.p_stat == SSTOP)) return NULL;
  return result;
}

/* The processes in one process group that have not exited. A failed read throws, so an unread group
 * is never reported empty. */
static napi_value group_members(napi_env env, napi_callback_info info) {
  pid_t pgid = pid_argument(env, info);
  if (pgid == 0) return undefined_value(env);
  int mib[4] = {CTL_KERN, KERN_PROC, KERN_PROC_PGRP, pgid};
  struct kinfo_proc *entries = NULL;
  size_t length = 0;
  for (int attempt = 0;; attempt++) {
    size_t needed = 0;
    if (sysctl(mib, 4, NULL, &needed, NULL, 0) != 0) return fail(env, "sysctl KERN_PROC_PGRP", errno);
    length = needed + 8 * sizeof(struct kinfo_proc);
    entries = malloc(length);
    if (entries == NULL) return fail(env, "process group allocation", ENOMEM);
    if (sysctl(mib, 4, entries, &length, NULL, 0) == 0) break;
    int error = errno;
    free(entries);
    entries = NULL;
    // The group grew between the size query and the read; ask again, a bounded number of times.
    if (error != ENOMEM || attempt == 7) return fail(env, "sysctl KERN_PROC_PGRP", error);
  }
  if (length % sizeof(struct kinfo_proc) != 0) {
    free(entries);
    napi_throw_error(env, NULL, "sysctl KERN_PROC_PGRP returned a partial process entry");
    return NULL;
  }
  size_t count = length / sizeof(struct kinfo_proc);
  napi_value result;
  if (napi_create_array(env, &result) != napi_ok) {
    free(entries);
    return NULL;
  }
  uint32_t index = 0;
  for (size_t i = 0; i < count; i++) {
    if (entries[i].kp_eproc.e_pgid != pgid || entries[i].kp_proc.p_stat == SZOMB) continue;
    napi_value member;
    if (napi_create_double(env, (double)entries[i].kp_proc.p_pid, &member) != napi_ok ||
        napi_set_element(env, result, index++, member) != napi_ok) {
      free(entries);
      return NULL;
    }
  }
  free(entries);
  return result;
}

/* The machine's hardware UUID and this boot's session UUID, as the kernel reports them. */
static napi_value host_identity(napi_env env, napi_callback_info info) {
  (void)info;
  uuid_t id;
  struct timespec wait = {5, 0};
  if (gethostuuid(id, &wait) != 0) return fail(env, "gethostuuid", errno);
  if (uuid_is_null(id)) {
    napi_throw_error(env, NULL, "gethostuuid returned the null UUID");
    return NULL;
  }
  uuid_string_t machine;
  uuid_unparse_lower(id, machine);

  char boot[64];
  size_t length = sizeof(boot);
  if (sysctlbyname("kern.bootsessionuuid", boot, &length, NULL, 0) != 0) return fail(env, "sysctl kern.bootsessionuuid", errno);
  if (length == 0 || length > sizeof(boot) || boot[length - 1] != '\0') {
    napi_throw_error(env, NULL, "kern.bootsessionuuid is not a string");
    return NULL;
  }

  napi_value result, machine_value, boot_value;
  if (napi_create_object(env, &result) != napi_ok ||
      napi_create_string_utf8(env, machine, NAPI_AUTO_LENGTH, &machine_value) != napi_ok ||
      napi_set_named_property(env, result, "machine", machine_value) != napi_ok ||
      napi_create_string_utf8(env, boot, NAPI_AUTO_LENGTH, &boot_value) != napi_ok ||
      napi_set_named_property(env, result, "boot", boot_value) != napi_ok) return NULL;
  return result;
}

NAPI_MODULE_INIT() {
  napi_property_descriptor functions[] = {
    {"processInfo", NULL, process_info, NULL, NULL, NULL, napi_enumerable, NULL},
    {"groupMembers", NULL, group_members, NULL, NULL, NULL, napi_enumerable, NULL},
    {"hostIdentity", NULL, host_identity, NULL, NULL, NULL, napi_enumerable, NULL},
  };
  if (napi_define_properties(env, exports, sizeof(functions) / sizeof(functions[0]), functions) != napi_ok) return NULL;
  return exports;
}
