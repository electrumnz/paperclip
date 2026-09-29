#!/usr/bin/env bash
# KEE-1140 AC7 load harness — CPU-only.
#
# Acceptance (per the KEE-1020 merge-decision owner) is stability UNDER LOAD, not
# on an idle host: an idle-host 10/10 is inconclusive because this race does not
# fire when the machine is quiet.
#
# WHY CPU-ONLY. The original recipe started N background
# `heartbeat-dependency-scheduling` vitest processes to load the box. On this
# host that produces NO load at all: measured 0 of 9 load processes reached a
# test, each dying on the 20s `beforeAll` embedded-Postgres boot timeout before
# running anything. A load that cannot boot is not load, and a green target run
# under it is as inconclusive as an idle-host run.
#
# CPU is the right axis for this defect. What must be reproduced is a
# load-dependent *timing* race — fire-and-forget wakeups racing the per-write
# quiesce and the teardown drain — and CPU contention is what delays that async
# work. It is not a memory- or disk-pressure defect. This harness therefore uses
# `yes` burners, so no database is in the load path and no fresh Postgres
# fixture is booted per process.
#
# THE LOAD IS MEASURED, NOT ASSUMED. Every iteration sums fields 14+15
# (utime,stime) of /proc/<pid>/stat across every pid in the load process group,
# before and after the timed run, so "the load did work" is a number in
# core-seconds rather than an inference from loadavg. loadavg is also reported,
# but its 1- and 5-minute windows lag the measured window by tens of seconds, so
# it cannot be the load-bearing evidence. An iteration consuming less than
# MIN_LOAD_SECONDS of CPU is reported UNLOADED and is not evidence whatever the
# target's result.
#
# BOUNDED AND ISOLATED.
#   - Each burner runs under `setsid` in its own process group, wrapped in
#     `timeout` as a hard self-limit, so it cannot outlive its window even if
#     teardown is interrupted.
#   - Teardown signals ONLY the process groups this script creates (kill -$pgid).
#     Never a bare pid, never a pkill pattern, no host-wide signal, no cgroup
#     change, no global concurrency cap.
#   - No production or test timeout is touched. The target suite is run with no
#     extra flags, exactly as the AC1 runs ran it.
#
# Usage: kee1140-run-under-load.sh <runs> [outdir]
#   runs    number of timed target runs (default 3)
#   outdir  where logs and the TSV go (default $PAPERCLIP_RUN_SCRATCH_DIR/kee1140)
#
# Env: BURNERS=<n>          concurrent burner processes (default 4; AC7 wants 4+)
#      BURN_SECONDS=<n>    hard self-limit per burner (default 300)
#      WORKTREE=<path>      worktree to run in (default: this script's repo)
set -uo pipefail

HERE=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
REPO=${WORKTREE:-$(cd "$HERE/.." && pwd)}
SERVER_DIR="$REPO/server"
OUT=${2:-${PAPERCLIP_RUN_SCRATCH_DIR:-/tmp}/kee1140}
mkdir -p "$OUT"

RUNS=${1:-3}
BURNERS=${BURNERS:-4}
BURN_SECONDS=${BURN_SECONDS:-300}
CLK_TCK=$(getconf CLK_TCK)
MIN_LOAD_SECONDS=5          # below this an iteration is UNLOADED, not evidence
TARGET=src/__tests__/low-trust-red-team-routes.test.ts

cd "$SERVER_DIR" || { echo "no server dir at $SERVER_DIR" >&2; exit 1; }

# CPU ticks (utime+stime) summed across every pid in process group $1.
group_cpu_ticks() {
  local pgid="$1" total=0 pid ticks
  for pid in $(ps -eo pid=,pgid= 2>/dev/null | awk -v g="$pgid" '$2==g {print $1}'); do
    if [ -r "/proc/$pid/stat" ]; then
      # comm may contain spaces and parens, so split on the final ')' and count
      # from there; fields 14,15 land at $12,$13 of that remainder.
      ticks=$(sed 's/.*) //' "/proc/$pid/stat" 2>/dev/null | awk '{print $12+$13}')
      [ -n "$ticks" ] && total=$((total + ticks))
    fi
  done
  echo "$total"
}

group_pgid() { ps -o pgid= -p "$1" 2>/dev/null | tr -d ' '; }

group_alive() {
  local pgid="$1" n=0 pid
  for pid in $(ps -eo pid=,pgid= 2>/dev/null | awk -v g="$pgid" '$2==g {print $1}'); do
    kill -0 "$pid" 2>/dev/null && n=$((n + 1))
  done
  echo "$n"
}

sum_group_metric() {   # $1 = metric fn, over all burner leader pids in "$@"
  local fn="$1"; shift
  local total=0 p pg
  for p in "$@"; do
    pg=$(group_pgid "$p")
    [ -n "$pg" ] && total=$((total + $($fn "$pg")))
  done
  echo "$total"
}

TSV="$OUT/ac7-load.tsv"
: > "$TSV"
printf 'run\tburners\tcpu_ticks_delta\tload_pids_alive_start\tload_pids_alive_end\tla_start\tla_end\tpassed\tfailed\trc\tconflicts\thook_timeout_20s\thook_timeout_30s\tstartlock_waits\trogue_dispatches\ttarget_s\tverdict\n' >> "$TSV"

echo "AC7: repo=$REPO burners=$BURNERS CLK_TCK=$CLK_TCK cores=$(nproc) runs=$RUNS"

for i in $(seq 1 "$RUNS"); do
  PIDS=()
  for n in $(seq 1 "$BURNERS"); do
    setsid timeout --signal=TERM "$BURN_SECONDS" yes > /dev/null 2>&1 &
    PIDS+=($!)
  done
  sleep 3   # let burners reach steady CPU before the measurement window

  cpu_start=$(sum_group_metric group_cpu_ticks "${PIDS[@]}")
  alive_start=$(sum_group_metric group_alive "${PIDS[@]}")
  la_start=$(cut -d' ' -f1 /proc/loadavg)
  t0=$(date +%s)

  log="$OUT/loadrun-$i.log"
  npx vitest run "$TARGET" > "$log" 2>&1
  rc=$?

  # Measure the load after the target run but BEFORE teardown, so the figure
  # covers exactly the window the target ran in.
  cpu_end=$(sum_group_metric group_cpu_ticks "${PIDS[@]}")
  alive_end=$(sum_group_metric group_alive "${PIDS[@]}")
  la_end=$(cut -d' ' -f1 /proc/loadavg)
  cpu_delta=$((cpu_end - cpu_start))
  # Wall time in seconds, integer-only: this shell has no bc, and %d is safe.
  wall_s=$(( $(date +%s) - t0 ))

  passed=$(grep -oE 'Tests +[0-9]+ passed' "$log" | tail -1 | grep -oE '[0-9]+' | head -1)
  failed=$(grep -oE '[0-9]+ failed' "$log" | tail -1 | grep -oE '[0-9]+' | head -1)
  # grep -c prints a count per FILE, and `|| echo 0` fires alongside a real 0
  # count, so both can emit. Collapse to a single integer: 1 if the pattern
  # occurs at all, 0 if not.
  count_of() { grep -qE "$1" "$log" 2>/dev/null && echo 1 || echo 0; }
  conf=$(count_of '409 "Conflict"')
  h20=$(count_of 'Hook timed out in 20000ms')
  h30=$(count_of 'Hook timed out in 30000ms')
  sl=$(count_of 'start lock timed out')
  rg=$(count_of 'Process adapter missing command')

  if [ "$cpu_delta" -ge $((CLK_TCK * MIN_LOAD_SECONDS)) ]; then verdict=LOADED; else verdict=UNLOADED; fi

  printf '%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\n' \
    "$i" "$BURNERS" "$cpu_delta" "$alive_start" "$alive_end" "$la_start" "$la_end" \
    "${passed:-0}" "${failed:-0}" "$rc" "$conf" "$h20" "$h30" "$sl" "$rg" "$wall_s" "$verdict" >> "$TSV"

  # How busy the box was, in core-seconds (ticks / CLK_TCK), alongside the
  # target's own wall time in seconds. Deliberately NOT a synthetic decimal:
  # every shell-only way of formatting N/denominator here truncates or rounds
  # inconsistently at integer boundaries, and a wrong-looking "3.0" or "4.7"
  # in the log is worse than two exact integers a reader can divide. Compare
  # cpu_s against wall_s to get cores; `verdict` below is the load-bearing
  # signal and it is a boolean, not a formatted number.
  cpu_s=$((cpu_delta / CLK_TCK))
  echo "run $i verdict=$verdict cpu_ticks=+$cpu_delta (${cpu_s} core-seconds over ${wall_s}s wall) loadpids=$alive_start->$alive_end la=$la_start->$la_end passed=${passed:-0} failed=${failed:-0} rc=$rc conflicts=$conf hook20=$h20 hook30=$h30 startlock=$sl rogue=$rg"

  # Teardown: ONLY the process groups this iteration created.
  for p in "${PIDS[@]}"; do
    pg=$(group_pgid "$p"); [ -n "$pg" ] && kill -TERM -- "-$pg" 2>/dev/null
  done
  sleep 2
  for p in "${PIDS[@]}"; do
    pg=$(group_pgid "$p"); [ -n "$pg" ] && kill -KILL -- "-$pg" 2>/dev/null
  done
  for p in "${PIDS[@]}"; do
    pg=$(group_pgid "$p")
    if [ -n "$pg" ] && [ "$(group_alive "$pg")" -gt 0 ]; then
      echo "  WARNING: group $pg still has $(group_alive "$pg") pid(s) after teardown" >&2
    fi
  done
  wait 2>/dev/null
  sleep 3
done

echo "AC7_DONE tsv=$TSV"
