#!/bin/sh
# LOCAL-ONLY observation of the delivery daemon across the fleet-adoption restart.
# Zero broker dials: reads /proc and ps only. Records the pid recorded AT CREATION.
PID=836803
OUT=/home/david/Cotal-wt-fm-health/.observations/delivery-restart.log
echo "# fm-health opportunistic observation; pid pinned at creation = $PID" >> "$OUT"
echo "# columns: utc | pid_exists | etime | comm" >> "$OUT"
i=0
while [ $i -lt 1200 ]; do
  TS=$(date -u +%Y-%m-%dT%H:%M:%SZ)
  if [ -d /proc/$PID ]; then
    ET=$(ps -o etime= -p $PID 2>/dev/null | tr -d ' ')
    CM=$(tr '\0' ' ' < /proc/$PID/cmdline 2>/dev/null | cut -c1-60)
    echo "$TS | yes | $ET | $CM" >> "$OUT"
  else
    NEW=$(pgrep -f "bin/cotal.ts deliver --space main" 2>/dev/null | tr '\n' ',')
    echo "$TS | NO | - | successor_pids=$NEW" >> "$OUT"
  fi
  i=$((i+1))
  sleep 1
done
