/*
 * The Linux kernel primitives this workstation layer needs and Node does not expose:
 * SO_PEERCRED on a connected unix socket, and an exclusive non-blocking flock(2).
 */
#include <node_api.h>
#include <sys/socket.h>
#include <sys/file.h>
#include <errno.h>
#include <string.h>

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
  struct ucred cred;
  socklen_t len = sizeof(cred);
  napi_value out;
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

static napi_value Init(napi_env env, napi_value exports) {
  napi_value fn;
  napi_create_function(env, "peercred", NAPI_AUTO_LENGTH, Peercred, NULL, &fn);
  napi_set_named_property(env, exports, "peercred", fn);
  napi_create_function(env, "flockExclusiveNb", NAPI_AUTO_LENGTH, FlockExclusiveNb, NULL, &fn);
  napi_set_named_property(env, exports, "flockExclusiveNb", fn);
  return exports;
}

NAPI_MODULE(NODE_GYP_MODULE_NAME, Init)
