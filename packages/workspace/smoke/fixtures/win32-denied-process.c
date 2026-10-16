#define WIN32_LEAN_AND_MEAN
#include <windows.h>
#include <sddl.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include "win32-privilege-diagnostic.h"

int main(int argc, char **argv) {
  if (argc == 3 && strcmp(argv[1], "--probe") == 0) {
    int debug = diagnostic_debug_enabled();
    DWORD pid = (DWORD)strtoul(argv[2], NULL, 10);
    HANDLE process = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, FALSE, pid);
    DWORD error = process == NULL ? GetLastError() : 0;
    printf("{\"debugEnabled\":%d,\"self\":%s,\"opened\":%s,\"error\":%lu}\n", debug,
      pid == GetCurrentProcessId() ? "true" : "false", process != NULL ? "true" : "false", (unsigned long)error);
    if (process != NULL) { CloseHandle(process); return 1; }
    return error == ERROR_ACCESS_DENIED ? 0 : 2;
  }
  if (argc != 1) return 2;
  PSECURITY_DESCRIPTOR descriptor = NULL;
  // Restrict only this disposable process. The owner retains control, except query access.
  if (!ConvertStringSecurityDescriptorToSecurityDescriptorA(
        "D:(D;;0x1000;;;WD)(A;;0x1fffff;;;OW)", SDDL_REVISION_1, &descriptor, NULL)) return 3;
  BOOL ok = SetKernelObjectSecurity(GetCurrentProcess(), DACL_SECURITY_INFORMATION, descriptor);
  LocalFree(descriptor);
  if (!ok) return 4;
  fputs("ready\n", stdout);
  fflush(stdout);
  getchar();
  return 0;
}
