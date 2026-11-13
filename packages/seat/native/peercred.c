/*
 * The kernel primitives this workstation layer needs and Node does not expose, on Linux and macOS:
 * the credentials of the peer of a connected unix socket, and an exclusive non-blocking flock(2).
 * macOS also gets the start time of a process, the per-user cache directory and a read-only lookup
 * of a loaded launchd job. Windows has its own
 * file, peercred_win32.c, with the same exports where they apply.
 */
#include <node_api.h>
#include <sys/socket.h>
#include <sys/file.h>
#include <errno.h>
#include <stdio.h>
#include <string.h>
#ifdef __APPLE__
#include <CoreFoundation/CoreFoundation.h>
#include <dlfcn.h>
#include <limits.h>
#include <stdlib.h>
#include <sys/sysctl.h>
#include <sys/ucred.h>
#include <sys/un.h>
#include <unistd.h>
#endif

static napi_value Peercred(napi_env env, napi_callback_info info) {
  size_t argc = 1;
  napi_value argv[1];
  napi_get_cb_info(env, info, &argc, argv, NULL, NULL);
  if (argc < 1) {
    napi_throw_type_error(env, NULL, "fd required");
    return NULL;
  }
  int32_t fd = 0;
  napi_status st = napi_get_value_int32(env, argv[0], &fd);
  if (st != napi_ok) {
    napi_throw_type_error(env, NULL, "fd must be an integer");
    return NULL;
  }
  napi_value out;
#ifdef __APPLE__
  /* LOCAL_PEERCRED is the peer's credentials as the kernel recorded them at connect (the listener's
   * at listen() for a client, the connecting thread's for a server): what getpeereid(3) reads.
   * LOCAL_PEERPID is the pid of the last process that used the peer's socket. */
  struct xucred cred;
  socklen_t len = sizeof(cred);
  if (getsockopt(fd, SOL_LOCAL, LOCAL_PEERCRED, &cred, &len) != 0) {
    napi_throw_error(env, NULL, strerror(errno));
    return NULL;
  }
  if (len != sizeof(cred) || cred.cr_version != XUCRED_VERSION || cred.cr_ngroups < 1) {
    napi_throw_error(env, NULL, "LOCAL_PEERCRED returned an unexpected xucred");
    return NULL;
  }
  pid_t pid = 0;
  len = sizeof(pid);
  if (getsockopt(fd, SOL_LOCAL, LOCAL_PEERPID, &pid, &len) != 0) {
    napi_throw_error(env, NULL, strerror(errno));
    return NULL;
  }
  napi_create_object(env, &out);
  napi_value v;
  napi_create_int32(env, pid, &v);
  napi_set_named_property(env, out, "pid", v);
  napi_create_uint32(env, cred.cr_uid, &v);
  napi_set_named_property(env, out, "uid", v);
  napi_create_uint32(env, cred.cr_groups[0], &v);
  napi_set_named_property(env, out, "gid", v);
#else
  struct ucred cred;
  socklen_t len = sizeof(cred);
  if (getsockopt(fd, SOL_SOCKET, SO_PEERCRED, &cred, &len) != 0) {
    napi_throw_error(env, NULL, strerror(errno));
    return NULL;
  }
  napi_create_object(env, &out);
  napi_value v;
  napi_create_int32(env, cred.pid, &v);
  napi_set_named_property(env, out, "pid", v);
  napi_create_uint32(env, cred.uid, &v);
  napi_set_named_property(env, out, "uid", v);
  napi_create_uint32(env, cred.gid, &v);
  napi_set_named_property(env, out, "gid", v);
#endif
  return out;
}

/*
 * flock(fd, LOCK_EX | LOCK_NB). Returns true when this process now holds the lock, false when
 * another open file description holds it (EWOULDBLOCK). The kernel releases the lock when the
 * last descriptor referring to it closes, which includes every way the process can die, so a
 * SIGKILLed holder leaves no lock behind and the next acquirer needs no liveness guess.
 */
static napi_value FlockExclusiveNb(napi_env env, napi_callback_info info) {
  size_t argc = 1;
  napi_value argv[1];
  napi_get_cb_info(env, info, &argc, argv, NULL, NULL);
  if (argc < 1) {
    napi_throw_type_error(env, NULL, "fd required");
    return NULL;
  }
  int32_t fd = 0;
  if (napi_get_value_int32(env, argv[0], &fd) != napi_ok) {
    napi_throw_type_error(env, NULL, "fd must be an integer");
    return NULL;
  }
  napi_value out;
  if (flock(fd, LOCK_EX | LOCK_NB) == 0) {
    napi_get_boolean(env, true, &out);
    return out;
  }
  if (errno == EWOULDBLOCK) {
    napi_get_boolean(env, false, &out);
    return out;
  }
  napi_throw_error(env, NULL, strerror(errno));
  return NULL;
}

#ifdef __APPLE__
/* The start time of process `pid` as "<seconds>.<microseconds>", from the kernel's process table,
 * or undefined when no such process exists. A pid reused by a later process has a later start. */
static napi_value ProcessStartTime(napi_env env, napi_callback_info info) {
  size_t argc = 1;
  napi_value argv[1];
  napi_get_cb_info(env, info, &argc, argv, NULL, NULL);
  int32_t pid = 0;
  if (argc < 1 || napi_get_value_int32(env, argv[0], &pid) != napi_ok || pid <= 0) {
    napi_throw_type_error(env, NULL, "pid must be a positive integer");
    return NULL;
  }
  int mib[4] = { CTL_KERN, KERN_PROC, KERN_PROC_PID, pid };
  struct kinfo_proc kp;
  size_t len = sizeof(kp);
  memset(&kp, 0, sizeof(kp));
  if (sysctl(mib, 4, &kp, &len, NULL, 0) != 0) {
    napi_throw_error(env, NULL, strerror(errno));
    return NULL;
  }
  napi_value out;
  if (len == 0) {
    napi_get_undefined(env, &out);
    return out;
  }
  char buf[64];
  snprintf(buf, sizeof(buf), "%lld.%06d", (long long)kp.kp_proc.p_starttime.tv_sec, (int)kp.kp_proc.p_starttime.tv_usec);
  napi_create_string_utf8(env, buf, NAPI_AUTO_LENGTH, &out);
  return out;
}

/* confstr(_CS_DARWIN_USER_CACHE_DIR): this user's cache directory, created 0700 if absent and never
 * cleaned automatically. It depends on no environment variable, so every process of the user,
 * a LaunchAgent included, gets the same path. */
static napi_value UserCacheDir(napi_env env, napi_callback_info info) {
  (void)info;
  char buf[PATH_MAX];
  size_t n = confstr(_CS_DARWIN_USER_CACHE_DIR, buf, sizeof(buf));
  if (n == 0 || n > sizeof(buf)) {
    napi_throw_error(env, NULL, n == 0 ? strerror(errno) : "the user cache directory path is too long");
    return NULL;
  }
  napi_value out;
  napi_create_string_utf8(env, buf, NAPI_AUTO_LENGTH, &out);
  return out;
}

/* ---- launchd job lookup ---- */

#define JOB_STRING_MAX 16384
#define JOB_ARGS_MAX 256

/* A CFString as a JS string, or NULL when it is not a string or longer than JOB_STRING_MAX bytes. */
static napi_value cf_string(napi_env env, CFTypeRef value) {
  if (value == NULL || CFGetTypeID(value) != CFStringGetTypeID()) return NULL;
  CFIndex max = CFStringGetMaximumSizeForEncoding(CFStringGetLength((CFStringRef)value), kCFStringEncodingUTF8) + 1;
  if (max > JOB_STRING_MAX * 4) return NULL;
  char* buf = (char*)malloc((size_t)max);
  if (buf == NULL) return NULL;
  napi_value out = NULL;
  if (CFStringGetCString((CFStringRef)value, buf, max, kCFStringEncodingUTF8) && strlen(buf) <= JOB_STRING_MAX) {
    napi_create_string_utf8(env, buf, NAPI_AUTO_LENGTH, &out);
  }
  free(buf);
  return out;
}

static void set_job_string(napi_env env, napi_value out, CFDictionaryRef job, CFStringRef key, const char* name) {
  napi_value v = cf_string(env, CFDictionaryGetValue(job, key));
  if (v != NULL) napi_set_named_property(env, out, name, v);
}

/* ProgramArguments only when it is an array of at most JOB_ARGS_MAX strings that all convert, so a
 * partial list is never reported as the whole one. */
static void set_job_arguments(napi_env env, napi_value out, CFDictionaryRef job) {
  CFTypeRef value = CFDictionaryGetValue(job, CFSTR("ProgramArguments"));
  if (value == NULL || CFGetTypeID(value) != CFArrayGetTypeID()) return;
  CFIndex count = CFArrayGetCount((CFArrayRef)value);
  if (count > JOB_ARGS_MAX) return;
  napi_value args;
  napi_create_array_with_length(env, (size_t)count, &args);
  for (CFIndex i = 0; i < count; i++) {
    napi_value v = cf_string(env, CFArrayGetValueAtIndex((CFArrayRef)value, i));
    if (v == NULL) return;
    napi_set_element(env, args, (uint32_t)i, v);
  }
  napi_set_named_property(env, out, "programArguments", args);
}

/*
 * SMJobCopyDictionary(kSMDomainUserLaunchd, label): the calling process's per-user launchd domain's
 * loaded definition of job `label`. Returns null when no such job is loaded, { unavailable } when
 * the API cannot be reached, and otherwise { label, program, programArguments, workingDirectory },
 * each present only when the dictionary carries it in a readable form.
 *
 * The function is deprecated since macOS 10.10 with no replacement, and Apple's header says its
 * contents are not wholly representative of the on-disk plist and not stable between releases. It
 * is resolved with dlsym, so a macOS that drops it makes only this lookup unavailable, never the
 * load of this helper.
 */
static napi_value LaunchdJob(napi_env env, napi_callback_info info) {
  size_t argc = 1;
  napi_value argv[1];
  napi_get_cb_info(env, info, &argc, argv, NULL, NULL);
  char label[256];
  size_t len = 0;
  if (argc < 1 || napi_get_value_string_utf8(env, argv[0], label, sizeof(label), &len) != napi_ok || len == 0 || len >= sizeof(label) - 1) {
    napi_throw_type_error(env, NULL, "label must be a string of 1-254 bytes");
    return NULL;
  }
  napi_value out, v;
  typedef CFDictionaryRef (*copy_fn)(CFStringRef, CFStringRef);
  void* sm = dlopen("/System/Library/Frameworks/ServiceManagement.framework/ServiceManagement", RTLD_LAZY | RTLD_LOCAL);
  copy_fn copy = sm != NULL ? (copy_fn)dlsym(sm, "SMJobCopyDictionary") : NULL;
  const CFStringRef* domain = sm != NULL ? (const CFStringRef*)dlsym(sm, "kSMDomainUserLaunchd") : NULL;
  if (copy == NULL || domain == NULL || *domain == NULL) {
    const char* why = dlerror();
    napi_create_object(env, &out);
    napi_create_string_utf8(env, why != NULL ? why : "SMJobCopyDictionary or kSMDomainUserLaunchd is not available", NAPI_AUTO_LENGTH, &v);
    napi_set_named_property(env, out, "unavailable", v);
    return out;
  }
  CFStringRef key = CFStringCreateWithCString(kCFAllocatorDefault, label, kCFStringEncodingUTF8);
  if (key == NULL) {
    napi_throw_type_error(env, NULL, "label is not valid UTF-8");
    return NULL;
  }
  CFDictionaryRef job = copy(*domain, key);
  CFRelease(key);
  if (job == NULL) {
    napi_get_null(env, &out);
    return out;
  }
  napi_create_object(env, &out);
  if (CFGetTypeID(job) == CFDictionaryGetTypeID()) {
    set_job_string(env, out, job, CFSTR("Label"), "label");
    set_job_string(env, out, job, CFSTR("Program"), "program");
    set_job_arguments(env, out, job);
    set_job_string(env, out, job, CFSTR("WorkingDirectory"), "workingDirectory");
  }
  CFRelease(job);
  return out;
}
#endif

static void Export(napi_env env, napi_value exports, const char* name, napi_callback cb) {
  napi_value fn;
  napi_create_function(env, name, NAPI_AUTO_LENGTH, cb, NULL, &fn);
  napi_set_named_property(env, exports, name, fn);
}

#include "linux-process.h"

static napi_value Init(napi_env env, napi_value exports) {
  Export(env, exports, "peercred", Peercred);
  Export(env, exports, "flockExclusiveNb", FlockExclusiveNb);
#ifdef __linux__
  ExportProcesses(env, exports);
#endif
#ifdef __APPLE__
  Export(env, exports, "processStartTime", ProcessStartTime);
  Export(env, exports, "userCacheDir", UserCacheDir);
  Export(env, exports, "launchdJob", LaunchdJob);
#endif
  return exports;
}

NAPI_MODULE(NODE_GYP_MODULE_NAME, Init)
