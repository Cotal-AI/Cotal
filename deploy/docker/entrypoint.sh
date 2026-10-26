#!/usr/bin/env bash
# Cotal container entrypoint.
#
# Runs the cotal binary (there is no packaged executable - the entry is `tsx bin/cotal.ts`)
# with whatever subcommand the container was given (`supervise …` / `spawn …`), pointed at
# the EXTERNAL broker named by COTAL_SERVERS. The broker lives outside the container; only
# NATS traffic crosses the wall.
#
# Why map COTAL_SERVERS -> --server here: `supervise`/`spawn` read only the --server flag
# (they don't consult COTAL_SERVERS), so this is the single source of broker config. The
# connector forwards COTAL_SERVERS to the agent processes it launches separately.
set -euo pipefail

: "${COTAL_SERVERS:?set COTAL_SERVERS to the external broker, e.g. tls://broker.host:4222}"

# Wait for the broker before handing off: the manager hard-exits if NATS is unreachable,
# so a broker blip / cold start would otherwise crash-loop the container. A plain TCP
# connect to the listener is enough to know it's up (no TLS handshake needed).
hostport="${COTAL_SERVERS#*://}"   # strip scheme (nats:// | tls://) if present
hostport="${hostport%%,*}"         # first server only
host="${hostport%%:*}"
port="${hostport##*:}"
[ "$port" = "$host" ] && port=4222 # no :port given -> NATS default

echo "cotal: waiting for broker ${host}:${port} …"
for i in $(seq 1 60); do
  if (exec 3<>"/dev/tcp/${host}/${port}") 2>/dev/null; then
    exec 3>&-
    echo "cotal: broker reachable"
    break
  fi
  [ "$i" = 60 ] && { echo "cotal: broker ${host}:${port} unreachable after 120s" >&2; exit 1; }
  sleep 2
done

# --max-semi-space-size=1 is the daemon node flag `cotal up` and the service controller put on every
# daemon they start (DAEMON_NODE_FLAGS in implementations/cli/src/lib/self-exec.ts): it caps V8's
# young generation at 2 MB. tsx passes a node flag given before the script to the node it starts.
# It is not set through NODE_OPTIONS, which every node child would inherit, including the agent
# processes a manager launches.
exec pnpm exec tsx --max-semi-space-size=1 bin/cotal.ts "$@" --server "$COTAL_SERVERS"
