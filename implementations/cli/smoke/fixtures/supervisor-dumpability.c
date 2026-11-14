#define _GNU_SOURCE
#include <sys/prctl.h>
#include <time.h>
#include <signal.h>
static volatile sig_atomic_t running = 1;
static void stop(int signal) { (void)signal; running = 0; }
int main(void) {
  signal(SIGTERM, stop);
  struct timespec delay = {0, 100000};
  while (running) {
    prctl(PR_SET_DUMPABLE, 1);
    nanosleep(&delay, 0);
    prctl(PR_SET_DUMPABLE, 0);
    nanosleep(&delay, 0);
  }
  return 0;
}
