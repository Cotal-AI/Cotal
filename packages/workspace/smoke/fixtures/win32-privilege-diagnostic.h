// Diagnostic only. Read the current process's debug privilege; change no token or ACL.
#include <stdlib.h>

static int diagnostic_debug_enabled(void) {
  HANDLE token;
  if (!OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &token)) return -1;
  DWORD size = 0;
  GetTokenInformation(token, TokenPrivileges, NULL, 0, &size);
  LUID debug;
  if (size < sizeof(TOKEN_PRIVILEGES) || size > 65536 ||
      !LookupPrivilegeValueA(NULL, "SeDebugPrivilege", &debug)) {
    CloseHandle(token);
    return -1;
  }
  TOKEN_PRIVILEGES *info = (TOKEN_PRIVILEGES *)malloc(size);
  int enabled = -1;
  if (info != NULL) {
    if (GetTokenInformation(token, TokenPrivileges, info, size, &size)) {
      enabled = 0;
      for (DWORD i = 0; i < info->PrivilegeCount; i++) {
        if (info->Privileges[i].Luid.LowPart == debug.LowPart && info->Privileges[i].Luid.HighPart == debug.HighPart)
          enabled = (info->Privileges[i].Attributes & SE_PRIVILEGE_ENABLED) != 0;
      }
    }
    free(info);
  }
  CloseHandle(token);
  return enabled;
}
