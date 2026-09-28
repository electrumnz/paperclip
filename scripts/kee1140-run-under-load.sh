#!/usr/bin/env bash
# KEE-1140 load harness.
#
# Acceptance (per KEE-1020 merge-decision owner) is stability UNDER LOAD, not on
# an idle host: an idle-host 10/10 is inconclusive because this race does not
# fire when the machine is quiet.
#
# Recipe: start N background `heartbeat-dependency-scheduling` vitest processes
# to load the box, then run the low-trust suite while they are still running,
# and record the per-run pass/fail counts.
#
# Usage: run-low-trust-under-load.sh <runs> [label]
#   runs   number of timed low-trust runs (default 3)
#   label  tag for the log file (default "run")
#
# Prints one TSV line per run: <label> <run> <passed> <failed> <loadavg>
set -uo pipefail

SERVER_DIR=/home/love4vengeance/Work/keece-issue-worktrees/paperclip-kee-1140-497069c4/server
SCRATCH="${PAPERCLIP_RUN_SCRATCH_DIR:-/tmp}/kee1140"
mkdir -p "$SCRATCH"

RUNS="${1:-3}"
LABEL="${2:-run}"
LOAD_PROCS=4
# Path note: the issue text names `src/services/heartbeat-dependency-scheduling`,
# but the file actually lives at `src/__tests__/`. Passing the wrong path makes
# vitest fall back to the whole suite, which OOMs this 15GB host.
LOAD_SUITE=src/__tests__/heartbeat-dependency-scheduling.test.ts
TARGET=src/__tests__/low-trust-red-team-routes.test.ts

cd "$SERVER_DIR" || exit 1

# One test file, whole file, no retries. vitest exits non-zero if anything
# fails, so capture counts out of the summary lines rather than trusting $?.
extract() {
  local f="$1"
  local tests passed failed
  tests=$(grep -oE 'Tests +[0-9]+ (failed|passed) \| [0-9]+ passed' "$f" | tail -1)
  if [ -z "$tests" ]; then
    tests=$(grep -oE 'Tests +[0-9]+ passed \| [0-9]+ skipped \([0-9]+\)' "$f" | tail -1)
  fi
  [ -z "$tests" ] && tests=$(grep -oE 'Tests +[0-9]+ failed \| [0-9]+ passed \([0-9]+\)' "$f" | tail -1)
  if [ -z "$tests" ]; then
    echo "1 0"
    return
  fi
  passed=$(echo "$tests" | grep -oE '[0-9]+ passed' | head -1 | grep -oE '[0-9]+')
  failed=$(echo "$tests" | grep -oE '[0-9]+ failed' | head -1 | grep -oE '[0-9]+')
  [ -z "$failed" ] && failed=0
  echo "$passed $failed"
}

for i in $(seq 1 "$RUNS"); do
  # Start the load. heartbeat-dependency-scheduling is the suite KEE-1020 used.
  loadpids=()
  for n in $(seq 1 "$LOAD_PROCS"); do
    npx vitest run "$LOAD_SUITE" > "$SCRATCH/load-${i}-${n}.log" 2>&1 &
    loadpids+=($!)
  done

  # Let the load get established before the timed run starts.
  sleep 6
  la=$(cut -d' ' -f1 /proc/loadavg)

  # Timed run, with the load still running.
  log="$SCRATCH/lowtrust-${LABEL}-${i}.log"
  npx vitest run "$TARGET" > "$log" 2>&1
  rc=$?
  read -r p f <<<"$(extract "$log")"

  # Record 409-at-status-write evidence if it fired.
  conflict=$(grep -c '409 "Conflict"' "$log" 2>/dev/null || echo 0)
  hookto=$(grep -c 'Hook timed out' "$log" 2>/dev/null || echo 0)

  echo -e "$LABEL\t$i\t$p\t$f\tloadavg=$la\tconflicts=$conflict\thooktimeouts=$hookto\trc=$rc\t$log"

  # Stop the load before the next iteration.
  for pid in "${loadpids[@]}"; do kill "$pid" 2>/dev/null; done
  wait 2>/dev/null
  sleep 4
done
