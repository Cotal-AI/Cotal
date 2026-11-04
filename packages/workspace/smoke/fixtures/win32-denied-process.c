#define WIN32_LEAN_AND_MEAN
#include <windows.h>
#include <sddl.h>
#include <stdio.h>

int main(void) {
  PSECURITY_DESCRIPTOR descriptor = NULL;
  // Restrict only this disposable process. Its owner can wait for or terminate it, not query it.
  if (!ConvertStringSecurityDescriptorToSecurityDescriptorA(
        "D:P(A;;0x00100001;;;OW)", SDDL_REVISION_1, &descriptor, NULL)) return 3;
  BOOL ok = SetKernelObjectSecurity(GetCurrentProcess(), DACL_SECURITY_INFORMATION, descriptor);
  LocalFree(descriptor);
  if (!ok) return 4;
  fputs("ready\n", stdout);
  fflush(stdout);
  getchar();
  return 0;
}
