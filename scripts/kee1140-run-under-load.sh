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
  #
  # Recorded limitation (KEE-1140): on this host that suite embeds a fresh
  # postgres per process, so each load process can die on the 20s `beforeAll`
  # boot timeout before running a test. Measured 0 of 9 load processes reaching
  # a test. A load that cannot boot is not load -- see
  # ~/Work/keece-1140-evidence/ac7-load-analysis.md. The harness reports each
  # process's liveness and whether it ran a test so this is visible rather than
  # assumed, but the recipe still needs a load that boots to be meaningful.
  loadpids=()
  for n in $(seq 1 "$LOAD_PROCS"); do
    # setsid puts each load process in its own process group, so the teardown
    # below can signal the whole group (npx wrapper AND the vitest child it
    # re-execs into) rather than just the pid that $! captured.
    setsid npx vitest run "$LOAD_SUITE" > "$SCRATCH/load-${i}-${n}.log" 2>&1 &
    loadpids+=($!)
  done

  # Let the load get established before the timed run starts.
  sleep 6
  la=$(cut -d' ' -f1 /proc/loadavg)
  alive_start=0
  for pid in "${loadpids[@]}"; do kill -0 "$pid" 2>/dev/null && alive_start=$((alive_start+1)); done

  # Timed run, with the load still running.
  log="$SCRATCH/lowtrust-${LABEL}-${i}.log"
  npx vitest run "$TARGET" > "$log" 2>&1
  rc=$?
  read -r p f <<<"$(extract "$log")"

  # How many load processes are still alive, and how many actually ran a test
  # rather than dying on the beforeAll boot. A run that reports alive=0/3 or
  # ran=0/3 was not loaded, and its result is not evidence about the target.
  alive_end=0
  for pid in "${loadpids[@]}"; do kill -0 "$pid" 2>/dev/null && alive_end=$((alive_end+1)); done
  ran=0
  for n in $(seq 1 "$LOAD_PROCS"); do
    grep -qE 'Tests +[0-9]+ passed' "$SCRATCH/load-${i}-${n}.log" 2>/dev/null && ran=$((ran+1))
  done

  # Record 409-at-status-write evidence if it fired.
  conflict=$(grep -c '409 "Conflict"' "$log" 2>/dev/null || echo 0)
  hookto=$(grep -c 'Hook timed out' "$log" 2>/dev/null || echo 0)

  echo -e "$LABEL\t$i\t$p\t$f\tloadavg=$la\tloadalive=$alive_start/$LOAD_PROCS->$alive_end/$LOAD_PROCS\tloadran=$ran/$LOAD_PROCS\tconflicts=$conflict\thooktimeouts=$hookto\trc=$rc\t$log"

  # Stop the load before the next iteration.
  #
  # `kill $pid` alone is not enough: $! is the npx wrapper, and npx re-execs, so
  # the vitest child outlives it, is reparented to init, and keeps loading the
  # box during later iterations. Kill the whole process group instead, and fall
  # back to SIGKILL for anything still standing.
  for pid in "${loadpids[@]}"; do
    kill -TERM -- "-$pid" 2>/dev/null || kill -TERM "$pid" 2>/dev/null
  done
  sleep 2
  for pid in "${loadpids[@]}"; do
    kill -KILL -- "-$pid" 2>/dev/null || kill -KILL "$pid" 2>/dev/null
  done
  wait 2>/dev/null
  sleep 4
done
