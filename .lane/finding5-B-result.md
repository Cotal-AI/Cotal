FINDING 5 / DEFECT B (identity, pid reuse) — RE-DERIVED BY fm-health
measured-at-utc: 2026-08-14T20:04:28Z   (date -u, not estimated)
head: 77c6b04c011ee762851094461f51401fca392a55
predictions registered at: 77c6b04c (parent 9ad70005), BEFORE this run

INSTRUMENT VERIFIED BEFORE USE, AND THE FIRST READING WAS DISCARDED
  cotalPath("manager.pid") = findCotalRoot() + "/.cotal/manager.pid"
  (implementations/cli/src/lib/paths.ts:6-13; manager-proc.ts:11-12)
  It walks up from CWD. It does NOT use COTAL_HOME.
  My first probe wrote the pid to $COTAL_HOME/manager.pid and rendered the card with cwd =
  /home/david/Cotal-wt-fm-health. The card said "not running". THAT READING MEASURED NOTHING:
  the code read my own worktree's .cotal/manager.pid, not the scratch. Recorded because it would
  have been reported as a REFUTATION of the inherited claim, from an instrument pointed at the
  wrong file.
  Corrected: cwd = the scratch project; findCotalRoot measured = <scratch>/proj

B1 unrelated-live-pid-in-manager-pid-renders-running .... REPRODUCED
  planted pid 1862408 = "sleep 600", setsid, recorded at creation. Never a manager.
  written to <scratch>/proj/.cotal/manager.pid
  real entry path: bin/cotal.ts setup, repeat run, COTAL_HOME + XDG_CONFIG_HOME sandboxed
  CARD RENDERED:  "|  ✓ manager  running"

B2 dead-pid-renders-not-running (INVERSE CONTROL) ....... HELD, AND DIFFERS
  same pidfile, same contents (1862408), same renderer, same cwd
  kill -9 by EXACT recorded pid; proven gone by kill -0 polling, not by assumption
  CARD RENDERED:  "|  ○ manager  not running · start: cotal up, or: cotal supervise"

WHAT THE PAIR ESTABLISHES
  The ONLY variable between B1 and B2 is whether an unrelated process is alive.
  The card's manager claim tracks kill(pid,0) on whatever integer is in that file.
  It is not a claim about a manager. It is a claim about an integer.
  B2 differing is what makes B1 non-vacuous: the card is not unconditionally green.

NOT MEASURED IN THIS RUN
  Defect A (wedge) — needs a real manager and a broker; separate arm, not started here.
  Whether any fix is correct. This establishes the defect only.