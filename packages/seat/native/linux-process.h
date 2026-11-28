/* Linux process capabilities. A descriptor stays bound to one kernel process across PID reuse.
 * A type-tagged object owns its descriptor until explicit close or GC. Imported descriptors
 * are borrowed and duplicated; the owned descriptor number never escapes to JS. */
#ifdef __linux__
#include <fcntl.h>
#include <dlfcn.h>
#include <uv.h>
#include <limits.h>
#include <inttypes.h>
#include <sys/stat.h>
#include <sys/sysmacros.h>
#include <sys/vfs.h>
#include <linux/magic.h>

#ifndef PID_FS_MAGIC
#define PID_FS_MAGIC 0x50494446
#endif
#include <math.h>
#include <poll.h>
#include <signal.h>
#include <stdlib.h>
#include <sys/syscall.h>
#include <unistd.h>

/* Stable Linux socket ABI, absent from older build headers. An older running kernel refuses
 * getsockopt; there is no fallback to looking a peer up by its numeric PID. */
#ifndef SO_PEERPIDFD
#define SO_PEERPIDFD 77
#endif

typedef struct ProcessWatch ProcessWatch;
typedef struct {
  int fd;
  pid_t pid;
  napi_env env;
  unsigned references;
  bool closing_env;
  napi_async_cleanup_hook_handle cleanup;
  ProcessWatch *watches;
} ProcessHandle;

static void StopProcessWatches(ProcessHandle *handle, bool notify);
static void CleanupProcess(napi_async_cleanup_hook_handle cleanup, void *data);
static void ReleaseProcess(ProcessHandle *handle) {
  if (--handle->references == 0) free(handle);
}

static const napi_type_tag process_handle_tag = {
  0x42d9207a9469a311ULL, 0xb629fef318a4d20eULL
};

static napi_value ProcessError(napi_env env, const char *code, const char *message) {
  napi_throw_error(env, code, message);
  return NULL;
}

static int ProcessInteger(napi_env env, napi_value value, int minimum, int *out) {
  double n;
  if (napi_get_value_double(env, value, &n) != napi_ok || !isfinite(n) ||
      n < minimum || n > INT_MAX || n != (int)n) {
    napi_throw_type_error(env, NULL, "process argument must be an integer in range");
    return 0;
  }
  *out = (int)n;
  return 1;
}

static void FinalizeProcess(napi_env env, void *data, void *hint) {
  (void)env;
  (void)hint;
  ProcessHandle *handle = data;
  if (handle->cleanup) {
    napi_remove_async_cleanup_hook(handle->cleanup);
    handle->cleanup = NULL;
  }
  if (handle->fd >= 0) { close(handle->fd); handle->fd = -1; }
  StopProcessWatches(handle, false);
  ReleaseProcess(handle);
}

static napi_value WrapProcess(napi_env env, int fd, pid_t pid) {
  ProcessHandle *handle = calloc(1, sizeof(*handle));
  if (!handle) {
    close(fd);
    return ProcessError(env, "ENOMEM", "cannot allocate process handle");
  }
  handle->fd = fd;
  handle->pid = pid;
  handle->env = env;
  handle->references = 1;
  if (napi_add_async_cleanup_hook(env, CleanupProcess, handle, &handle->cleanup) != napi_ok) {
    FinalizeProcess(env, handle, NULL);
    return ProcessError(env, NULL, "cannot register process cleanup");
  }
  napi_value out;
  if (napi_create_object(env, &out) != napi_ok ||
      napi_type_tag_object(env, out, &process_handle_tag) != napi_ok ||
      napi_wrap(env, out, handle, FinalizeProcess, NULL, NULL) != napi_ok) {
    FinalizeProcess(env, handle, NULL);
    return ProcessError(env, NULL, "cannot create process handle");
  }
  return out;
}

static ProcessHandle *ReadProcess(napi_env env, napi_value value, int allow_closed) {
  bool tagged = false;
  ProcessHandle *handle = NULL;
  if (napi_check_object_type_tag(env, value, &process_handle_tag, &tagged) != napi_ok ||
      !tagged || napi_unwrap(env, value, (void **)&handle) != napi_ok || !handle) {
    napi_throw_type_error(env, NULL, "kernel process handle required");
    return NULL;
  }
  if (!allow_closed && handle->fd < 0) {
    ProcessError(env, "ERR_PROCESS_HANDLE_CLOSED", "process handle is closed");
    return NULL;
  }
  return handle;
}

static int ProcessArgs(napi_env env, napi_callback_info info, size_t expected, napi_value *argv) {
  size_t argc = expected;
  if (napi_get_cb_info(env, info, &argc, argv, NULL, NULL) != napi_ok || argc != expected) {
    napi_throw_type_error(env, NULL, "missing process handle argument");
    return 0;
  }
  return 1;
}

static napi_value CapturePeerProcess(napi_env env, napi_callback_info info) {
  napi_value argv[1];
  int socket_fd;
  if (!ProcessArgs(env, info, 1, argv) || !ProcessInteger(env, argv[0], 0, &socket_fd)) return NULL;
  struct ucred cred;
  socklen_t length = sizeof(cred);
  if (getsockopt(socket_fd, SOL_SOCKET, SO_PEERCRED, &cred, &length) != 0)
    return ProcessError(env, NULL, strerror(errno));
  if (length != sizeof(cred) || cred.pid <= 0)
    return ProcessError(env, NULL, "socket peer has no process identity");
  int fd = -1;
  length = sizeof(fd);
  if (getsockopt(socket_fd, SOL_SOCKET, SO_PEERPIDFD, &fd, &length) != 0)
    return ProcessError(env, NULL, strerror(errno));
  if (length != sizeof(fd) || fd < 0) {
    if (fd >= 0) close(fd);
    return ProcessError(env, NULL, "socket peer returned an invalid process handle");
  }
  return WrapProcess(env, fd, cred.pid);
}

/* This candidate must be validated against a recorded identity before it grants signalling
 * authority. The public wrapper performs that validation while the descriptor remains live. */
static napi_value OpenProcessCandidate(napi_env env, napi_callback_info info) {
  napi_value argv[1];
  int pid;
  if (!ProcessArgs(env, info, 1, argv) || !ProcessInteger(env, argv[0], 1, &pid)) return NULL;
  int fd = syscall(SYS_pidfd_open, pid, 0);
  if (fd < 0) return ProcessError(env, NULL, strerror(errno));
  return WrapProcess(env, fd, pid);
}

/* Import duplicates first, so validation never races reuse of the caller's descriptor. */
static napi_value ImportProcess(napi_env env, napi_callback_info info) {
  napi_value argv[1];
  int source;
  if (!ProcessArgs(env, info, 1, argv) || !ProcessInteger(env, argv[0], 0, &source)) return NULL;
  int fd = fcntl(source, F_DUPFD_CLOEXEC, 0);
  if (fd < 0) return ProcessError(env, NULL, strerror(errno));
  /* Signal zero checks the kernel descriptor type/permission without delivering a signal.
   * ESRCH is expected for retained exited pidfds, not permission to reopen a numeric PID. */
  if (syscall(SYS_pidfd_send_signal, fd, 0, NULL, 0) != 0 && errno != ESRCH) {
    int saved = errno;
    close(fd);
    return ProcessError(env, NULL, strerror(saved));
  }
  int flags = fcntl(fd, F_GETFL);
  if (flags < 0 || (flags & O_EXCL)) {
    close(fd);
    return ProcessError(env, NULL, "thread-only pidfds are not process handles");
  }
  char path[64], line[256];
  snprintf(path, sizeof(path), "/proc/self/fdinfo/%d", fd);
  FILE *file = fopen(path, "re");
  if (!file) { int saved = errno; close(fd); return ProcessError(env, NULL, strerror(saved)); }
  long pid = 0;
  while (fgets(line, sizeof(line), file)) {
    if (strncmp(line, "Pid:", 4) != 0) continue;
    char *end;
    errno = 0;
    pid = strtol(line + 4, &end, 10);
    if (errno || end == line + 4 || (*end != '\n' && *end != '\0')) pid = 0;
    break;
  }
  fclose(file);
  if ((pid <= 0 && pid != -1) || pid > INT_MAX) {
    close(fd);
    return ProcessError(env, NULL, "imported pidfd has no visible process identity");
  }
  return WrapProcess(env, fd, (pid_t)pid);
}

static napi_value DuplicateProcess(napi_env env, napi_callback_info info) {
  napi_value argv[1];
  if (!ProcessArgs(env, info, 1, argv)) return NULL;
  ProcessHandle *handle = ReadProcess(env, argv[0], 0);
  if (!handle) return NULL;
  int fd = fcntl(handle->fd, F_DUPFD_CLOEXEC, 0);
  if (fd < 0) return ProcessError(env, NULL, strerror(errno));
  return WrapProcess(env, fd, handle->pid);
}

static napi_value ProcessKernelIdentity(napi_env env, napi_callback_info info) {
  napi_value argv[1], out, value;
  if (!ProcessArgs(env, info, 1, argv)) return NULL;
  ProcessHandle *handle = ReadProcess(env, argv[0], 0);
  if (!handle) return NULL;
  struct statfs fs;
  if (fstatfs(handle->fd, &fs) != 0) return ProcessError(env, NULL, strerror(errno));
  if ((unsigned long)fs.f_type != PID_FS_MAGIC)
    return ProcessError(env, NULL, "kernel process identity requires pidfs (Linux 6.9 or newer)");
  struct stat st;
  if (fstat(handle->fd, &st) != 0) return ProcessError(env, NULL, strerror(errno));
  char inode[32];
  snprintf(inode, sizeof(inode), "%" PRIuMAX, (uintmax_t)st.st_ino);
  napi_create_object(env, &out);
  napi_create_uint32(env, major(st.st_dev), &value); napi_set_named_property(env, out, "deviceMajor", value);
  napi_create_uint32(env, minor(st.st_dev), &value); napi_set_named_property(env, out, "deviceMinor", value);
  napi_create_uint32(env, st.st_mode, &value); napi_set_named_property(env, out, "mode", value);
  napi_create_string_utf8(env, inode, NAPI_AUTO_LENGTH, &value); napi_set_named_property(env, out, "inode", value);
  return out;
}

static napi_value ProcessPid(napi_env env, napi_callback_info info) {
  napi_value argv[1], out;
  if (!ProcessArgs(env, info, 1, argv)) return NULL;
  ProcessHandle *handle = ReadProcess(env, argv[0], 0);
  if (!handle) return NULL;
  napi_create_int32(env, handle->pid, &out);
  return out;
}

static int ProcessExited(ProcessHandle *handle) {
  struct pollfd state = {.fd = handle->fd, .events = POLLIN};
  int result;
  do { result = poll(&state, 1, 0); } while (result < 0 && errno == EINTR);
  if (result < 0) return -1;
  if (state.revents & (POLLNVAL | POLLERR)) { errno = EBADF; return -1; }
  return (state.revents & (POLLIN | POLLHUP)) != 0;
}

static napi_value HasProcessExited(napi_env env, napi_callback_info info) {
  napi_value argv[1], out;
  if (!ProcessArgs(env, info, 1, argv)) return NULL;
  ProcessHandle *handle = ReadProcess(env, argv[0], 0);
  if (!handle) return NULL;
  int result = ProcessExited(handle);
  if (result < 0) return ProcessError(env, NULL, strerror(errno));
  napi_get_boolean(env, result != 0, &out);
  return out;
}

static napi_value SignalProcess(napi_env env, napi_callback_info info) {
  napi_value argv[2], out;
  int number;
  if (!ProcessArgs(env, info, 2, argv) || !ProcessInteger(env, argv[1], 1, &number)) return NULL;
  ProcessHandle *handle = ReadProcess(env, argv[0], 0);
  if (!handle) return NULL;
  if (number >= NSIG) return ProcessError(env, NULL, "signal is outside the platform range");
  if (syscall(SYS_pidfd_send_signal, handle->fd, number, NULL, 0) != 0)
    return ProcessError(env, NULL, strerror(errno));
  napi_get_undefined(env, &out);
  return out;
}

static napi_value CloseProcess(napi_env env, napi_callback_info info) {
  napi_value argv[1], out;
  if (!ProcessArgs(env, info, 1, argv)) return NULL;
  ProcessHandle *handle = ReadProcess(env, argv[0], 1);
  if (!handle) return NULL;
  if (handle->fd >= 0) {
    int fd = handle->fd;
    handle->fd = -1;
    /* Linux has already released the descriptor on EINTR; retrying could close a reused fd. */
    int result = close(fd);
    int saved = errno;
    StopProcessWatches(handle, true);
    if (result != 0) return ProcessError(env, NULL, strerror(saved));
  }
  napi_get_undefined(env, &out);
  return out;
}

/* Each pending wait duplicates the pidfd. Cancellation can release its watcher without
 * closing the process capability or racing another wait on the same libuv descriptor. */
struct ProcessWatch {
  uv_poll_t poll;
  int fd;
  unsigned references;
  bool finished;
  bool notify;
  char error[160];
  ProcessHandle *owner;
  ProcessWatch *next;
  napi_ref callback;
  napi_ref owner_ref;
  napi_async_context context;
};

static const napi_type_tag process_watch_tag = {
  0x38357ee791e22362ULL, 0x9f314a025cfcd8e1ULL
};

static void ReleaseProcessWatch(ProcessWatch *watch) {
  if (--watch->references == 0) free(watch);
}

static void ProcessWatchClosed(uv_handle_t *uv) {
  ProcessWatch *watch = uv->data;
  ProcessHandle *owner = watch->owner;
  napi_env env = owner->env;
  ProcessWatch **entry = &owner->watches;
  while (*entry && *entry != watch) entry = &(*entry)->next;
  if (*entry) *entry = watch->next;
  if (!owner->closing_env) {
    napi_handle_scope scope;
    if (napi_open_handle_scope(env, &scope) == napi_ok) {
      if (watch->notify && watch->callback) {
        napi_value callback, receiver, argument, result;
        napi_get_reference_value(env, watch->callback, &callback);
        napi_get_global(env, &receiver);
        if (watch->error[0]) {
          napi_value message;
          napi_create_string_utf8(env, watch->error, NAPI_AUTO_LENGTH, &message);
          napi_create_error(env, NULL, message, &argument);
        } else napi_get_null(env, &argument);
        napi_status status = napi_make_callback(env, watch->context, receiver, callback, 1, &argument, &result);
        if (status == napi_pending_exception) {
          napi_value error;
          napi_get_and_clear_last_exception(env, &error);
          napi_fatal_exception(env, error);
        }
      }
      napi_close_handle_scope(env, scope);
    }
    if (watch->callback) napi_delete_reference(env, watch->callback);
    if (watch->owner_ref) napi_delete_reference(env, watch->owner_ref);
    if (watch->context) napi_async_destroy(env, watch->context);
  }
  if (owner->closing_env && !owner->watches && owner->cleanup) {
    napi_remove_async_cleanup_hook(owner->cleanup);
    owner->cleanup = NULL;
  }
  ReleaseProcess(owner);
  ReleaseProcessWatch(watch);
}

static void FinishProcessWatch(ProcessWatch *watch, const char *error, bool notify) {
  if (watch->finished) return;
  watch->finished = true;
  watch->notify = notify;
  if (error) snprintf(watch->error, sizeof(watch->error), "%s", error);
  uv_poll_stop(&watch->poll);
  close(watch->fd);
  watch->fd = -1;
  uv_close((uv_handle_t *)&watch->poll, ProcessWatchClosed);
}

static void StopProcessWatches(ProcessHandle *handle, bool notify) {
  for (ProcessWatch *watch = handle->watches; watch; watch = watch->next) {
    if (!notify) watch->notify = false;
    FinishProcessWatch(watch, "process handle is closed", notify);
  }
}

static void CleanupProcess(napi_async_cleanup_hook_handle cleanup, void *data) {
  ProcessHandle *handle = data;
  handle->closing_env = true;
  if (handle->fd >= 0) { close(handle->fd); handle->fd = -1; }
  StopProcessWatches(handle, false);
  if (!handle->watches) {
    napi_remove_async_cleanup_hook(cleanup);
    handle->cleanup = NULL;
  }
}

static void FinalizeProcessWatch(napi_env env, void *data, void *hint) {
  (void)env;
  (void)hint;
  ProcessWatch *watch = data;
  watch->notify = false;
  FinishProcessWatch(watch, NULL, false);
  ReleaseProcessWatch(watch);
}

static void ProcessReady(uv_poll_t *poll_handle, int status, int events) {
  (void)events;
  ProcessWatch *watch = poll_handle->data;
  if (status < 0) { FinishProcessWatch(watch, uv_strerror(status), true); return; }
  ProcessHandle observed = {.fd = watch->fd};
  int result = ProcessExited(&observed);
  if (result < 0) FinishProcessWatch(watch, strerror(errno), true);
  else if (result) FinishProcessWatch(watch, NULL, true);
}

static napi_value WaitForProcess(napi_env env, napi_callback_info info) {
  napi_value argv[2], out, name;
  napi_valuetype type;
  if (!ProcessArgs(env, info, 2, argv)) return NULL;
  ProcessHandle *owner = ReadProcess(env, argv[0], 0);
  if (!owner) return NULL;
  if (napi_typeof(env, argv[1], &type) != napi_ok || type != napi_function) {
    napi_throw_type_error(env, NULL, "process exit callback required");
    return NULL;
  }
  uv_loop_t *loop;
  if (napi_get_uv_event_loop(env, &loop) != napi_ok)
    return ProcessError(env, NULL, "process exit loop unavailable");
  ProcessWatch *watch = calloc(1, sizeof(*watch));
  if (!watch) return ProcessError(env, "ENOMEM", "cannot allocate process wait");
  watch->fd = fcntl(owner->fd, F_DUPFD_CLOEXEC, 0);
  if (watch->fd < 0) { free(watch); return ProcessError(env, NULL, strerror(errno)); }
  int result = uv_poll_init(loop, &watch->poll, watch->fd);
  if (result < 0) {
    close(watch->fd);
    free(watch);
    return ProcessError(env, NULL, uv_strerror(result));
  }
  watch->poll.data = watch;
  watch->references = 1; /* The libuv close callback owns this reference. */
  watch->owner = owner;
  owner->references++;
  watch->next = owner->watches;
  owner->watches = watch;
  if (napi_create_object(env, &out) != napi_ok ||
      napi_type_tag_object(env, out, &process_watch_tag) != napi_ok ||
      napi_wrap(env, out, watch, FinalizeProcessWatch, NULL, NULL) != napi_ok) {
    FinishProcessWatch(watch, NULL, false);
    return ProcessError(env, NULL, "cannot create process wait");
  }
  watch->references++; /* The JS token owns this reference. */
  if (napi_create_reference(env, argv[0], 1, &watch->owner_ref) != napi_ok ||
      napi_create_reference(env, argv[1], 1, &watch->callback) != napi_ok ||
      napi_create_string_utf8(env, "CotalProcessExit", NAPI_AUTO_LENGTH, &name) != napi_ok ||
      napi_async_init(env, out, name, &watch->context) != napi_ok) {
    FinishProcessWatch(watch, NULL, false);
    return ProcessError(env, NULL, "cannot retain process wait");
  }
  result = uv_poll_start(&watch->poll, UV_READABLE, ProcessReady);
  if (result < 0) {
    FinishProcessWatch(watch, NULL, false);
    return ProcessError(env, NULL, uv_strerror(result));
  }
  return out;
}

static napi_value CancelProcessWait(napi_env env, napi_callback_info info) {
  napi_value argv[1], out;
  bool tagged = false;
  ProcessWatch *watch = NULL;
  if (!ProcessArgs(env, info, 1, argv)) return NULL;
  if (napi_check_object_type_tag(env, argv[0], &process_watch_tag, &tagged) != napi_ok ||
      !tagged || napi_unwrap(env, argv[0], (void **)&watch) != napi_ok || !watch) {
    napi_throw_type_error(env, NULL, "kernel process wait required");
    return NULL;
  }
  watch->notify = false;
  FinishProcessWatch(watch, NULL, false);
  napi_get_undefined(env, &out);
  return out;
}

/* libsystemd owns notification/barrier semantics. The bounded blocking acknowledgment
 * runs off the JS thread. A processed request is not proof that the fdstore accepted it. */
typedef struct {
  int fd;
  char name[129];
  char error[256];
  napi_deferred deferred;
  napi_async_work work;
} ProcessStorage;

static void ExecuteProcessStorage(napi_env env, void *data) {
  (void)env;
  ProcessStorage *request = data;
  void *library = dlopen("libsystemd.so.0", RTLD_NOW | RTLD_LOCAL);
  if (!library) { snprintf(request->error, sizeof(request->error), "libsystemd.so.0 is required for process storage"); return; }
  typedef int (*NotifyFds)(pid_t, int, const char *, const int *, unsigned);
  typedef int (*Notify)(int, const char *);
  typedef int (*Barrier)(int, uint64_t);
  NotifyFds notify_fds = (NotifyFds)dlsym(library, "sd_pid_notify_with_fds");
  Notify notify = (Notify)dlsym(library, "sd_notify");
  Barrier barrier = (Barrier)dlsym(library, "sd_notify_barrier");
  if (!notify_fds || !notify || !barrier) {
    snprintf(request->error, sizeof(request->error), "required systemd notification APIs are unavailable");
    dlclose(library);
    return;
  }
  char message[192];
  snprintf(message, sizeof(message), "%s\nFDNAME=%s", request->fd >= 0 ? "FDSTORE=1\nFDPOLL=0" : "FDSTOREREMOVE=1", request->name);
  int result = request->fd >= 0 ? notify_fds(0, 0, message, &request->fd, 1) : notify(0, message);
  if (result <= 0) snprintf(request->error, sizeof(request->error), "process storage notification unavailable or failed (%d)", result);
  else {
    result = barrier(0, 5000000);
    if (result <= 0) snprintf(request->error, sizeof(request->error), "process storage acknowledgment unconfirmed (%d); inspect before retry", result);
  }
  dlclose(library);
}

static void CompleteProcessStorage(napi_env env, napi_status status, void *data) {
  ProcessStorage *request = data;
  if (request->fd >= 0) close(request->fd);
  napi_value value;
  if (status != napi_ok || request->error[0]) {
    napi_value code, message;
    napi_create_string_utf8(env, "ERR_PROCESS_STORAGE_UNCONFIRMED", NAPI_AUTO_LENGTH, &code);
    napi_create_string_utf8(env, request->error[0] ? request->error : "process storage operation cancelled; outcome unconfirmed", NAPI_AUTO_LENGTH, &message);
    napi_create_error(env, code, message, &value);
    napi_reject_deferred(env, request->deferred, value);
  } else {
    napi_get_undefined(env, &value);
    napi_resolve_deferred(env, request->deferred, value);
  }
  napi_delete_async_work(env, request->work);
  free(request);
}

/* Owns fd immediately; removal uses -1 and never obtains a process descriptor. */
static napi_value QueueProcessStorage(napi_env env, int fd, napi_value name) {
  char text[129];
  size_t length = 0;
  if (napi_get_value_string_utf8(env, name, NULL, 0, &length) != napi_ok || length == 0 || length > 128 ||
      napi_get_value_string_utf8(env, name, text, sizeof(text), &length) != napi_ok) {
    if (fd >= 0) close(fd);
    return ProcessError(env, NULL, "process storage name must be 1-128 ASCII letters, digits, underscores or hyphens");
  }
  for (size_t i = 0; i < length; i++) {
    char c = text[i];
    if (!((c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || (c >= '0' && c <= '9') || c == '_' || c == '-')) {
      if (fd >= 0) close(fd);
      return ProcessError(env, NULL, "invalid process storage name");
    }
  }
  ProcessStorage *request = calloc(1, sizeof(*request));
  if (!request) { if (fd >= 0) close(fd); return ProcessError(env, "ENOMEM", "cannot allocate process storage request"); }
  request->fd = fd;
  memcpy(request->name, text, length + 1);
  napi_value promise, resource;
  if (napi_create_promise(env, &request->deferred, &promise) != napi_ok ||
      napi_create_string_utf8(env, "CotalProcessStorage", NAPI_AUTO_LENGTH, &resource) != napi_ok ||
      napi_create_async_work(env, NULL, resource, ExecuteProcessStorage, CompleteProcessStorage, request, &request->work) != napi_ok ||
      napi_queue_async_work(env, request->work) != napi_ok) {
    if (request->work) napi_delete_async_work(env, request->work);
    if (fd >= 0) close(fd);
    free(request);
    return ProcessError(env, NULL, "cannot queue process storage request");
  }
  return promise;
}

static napi_value RequestProcessStorage(napi_env env, napi_callback_info info) {
  napi_value argv[2];
  if (!ProcessArgs(env, info, 2, argv)) return NULL;
  ProcessHandle *handle = ReadProcess(env, argv[0], 0);
  if (!handle) return NULL;
  int fd = fcntl(handle->fd, F_DUPFD_CLOEXEC, 0);
  if (fd < 0) return ProcessError(env, NULL, strerror(errno));
  return QueueProcessStorage(env, fd, argv[1]);
}

static napi_value RequestProcessStorageRemoval(napi_env env, napi_callback_info info) {
  napi_value argv[1];
  if (!ProcessArgs(env, info, 1, argv)) return NULL;
  return QueueProcessStorage(env, -1, argv[0]);
}

static void ExportProcesses(napi_env env, napi_value exports) {
  Export(env, exports, "requestProcessStorage", RequestProcessStorage);
  Export(env, exports, "requestProcessStorageRemoval", RequestProcessStorageRemoval);
  Export(env, exports, "capturePeerProcess", CapturePeerProcess);
  Export(env, exports, "openProcessCandidate", OpenProcessCandidate);
  Export(env, exports, "importProcess", ImportProcess);
  Export(env, exports, "duplicateProcess", DuplicateProcess);
  Export(env, exports, "processKernelIdentity", ProcessKernelIdentity);
  Export(env, exports, "processPid", ProcessPid);
  Export(env, exports, "hasProcessExited", HasProcessExited);
  Export(env, exports, "signalProcess", SignalProcess);
  Export(env, exports, "closeProcess", CloseProcess);
  Export(env, exports, "waitForProcess", WaitForProcess);
  Export(env, exports, "cancelProcessWait", CancelProcessWait);
}
#endif
