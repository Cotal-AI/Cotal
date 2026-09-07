#include <node_api.h>
#include <sys/socket.h>
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

static napi_value Init(napi_env env, napi_value exports) {
  napi_value fn;
  napi_create_function(env, "peercred", NAPI_AUTO_LENGTH, Peercred, NULL, &fn);
  napi_set_named_property(env, exports, "peercred", fn);
  return exports;
}

NAPI_MODULE(NODE_GYP_MODULE_NAME, Init)
