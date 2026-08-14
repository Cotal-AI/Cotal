/* Make kill(2) return EIO to the child, by KERNEL POLICY, then exec it.
 *
 * The card's `unknown` arm is reachable only when the kernel answers `kill(pid, 0)` with something
 * that is neither success nor ESRCH nor EPERM. No pidfile content can produce that: `parsePid`
 * rejects anything outside 1..0x7fffffff, so an out-of-range pid renders `unattributable`, not
 * `unknown`. A seccomp filter can, and it is what production would actually hit under an LSM or a
 * sandbox policy.
 *
 * Deliberately NOT an LD_PRELOAD shim. Interposition replaces the function the program calls; this
 * leaves the call site alone and changes what the KERNEL returns, which is the thing being claimed.
 * SECCOMP_RET_ERRNO makes the syscall return the errno without executing it at all.
 *
 * Scoped as tightly as it can be: SYS_kill only. Everything else is SECCOMP_RET_ALLOW, so the
 * child is a normal process in every other respect — a broad filter would make a failure ambiguous
 * between "the card refused" and "the child could not run".
 *
 * NO_NEW_PRIVS is required before PR_SET_SECCOMP without CAP_SYS_ADMIN, and is set here.
 *
 * Build: cc -O2 -o kill-eio kill-eio.c
 * Use:   ./kill-eio <cmd> [args...]
 */
#include <errno.h>
#include <linux/audit.h>
#include <linux/filter.h>
#include <linux/seccomp.h>
#include <stddef.h>
#include <stdio.h>
#include <string.h>
#include <sys/prctl.h>
#include <sys/syscall.h>
#include <unistd.h>

int main(int argc, char **argv) {
  if (argc < 2) {
    fprintf(stderr, "usage: kill-eio <cmd> [args...]\n");
    return 64;
  }

  struct sock_filter filter[] = {
      /* Refuse to run on a foreign architecture rather than filter the wrong syscall numbers:
         a filter that silently matches nothing is a control that cannot fail. */
      BPF_STMT(BPF_LD | BPF_W | BPF_ABS, offsetof(struct seccomp_data, arch)),
      BPF_JUMP(BPF_JMP | BPF_JEQ | BPF_K, AUDIT_ARCH_X86_64, 1, 0),
      BPF_STMT(BPF_RET | BPF_K, SECCOMP_RET_KILL_PROCESS),

      BPF_STMT(BPF_LD | BPF_W | BPF_ABS, offsetof(struct seccomp_data, nr)),
      BPF_JUMP(BPF_JMP | BPF_JEQ | BPF_K, __NR_kill, 0, 1),
      BPF_STMT(BPF_RET | BPF_K, SECCOMP_RET_ERRNO | (EIO & SECCOMP_RET_DATA)),

      BPF_STMT(BPF_RET | BPF_K, SECCOMP_RET_ALLOW),
  };
  struct sock_fprog prog = {
      .len = (unsigned short)(sizeof(filter) / sizeof(filter[0])),
      .filter = filter,
  };

  if (prctl(PR_SET_NO_NEW_PRIVS, 1, 0, 0, 0)) {
    perror("PR_SET_NO_NEW_PRIVS");
    return 70;
  }
  if (prctl(PR_SET_SECCOMP, SECCOMP_MODE_FILTER, &prog)) {
    perror("PR_SET_SECCOMP");
    return 70;
  }
  execvp(argv[1], &argv[1]);
  perror("execvp");
  return 71;
}
