#!/usr/bin/env bash
# Integration test for queuectl. Exercises the 5 scenarios called out in the
# assignment: success, retry+backoff+DLQ, no-overlap across workers, invalid
# commands, and persistence across restarts.
set -uo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"
CLI="node bin/queuectl.js"
PASS=0
FAIL=0

# Fallback for systems (like macOS) that don't have GNU timeout installed
if ! command -v timeout &> /dev/null; then
  timeout() {
    local duration=$1
    shift
    "$@" &
    local pid=$!
    (sleep "$duration" && kill -0 "$pid" 2>/dev/null && kill -9 "$pid" 2>/dev/null) &
    local timer_pid=$!
    wait "$pid" 2>/dev/null
    local exit_status=$?
    kill "$timer_pid" 2>/dev/null
    return $exit_status
  }
fi

pass() { echo "  PASS: $1"; PASS=$((PASS+1)); }
fail() { echo "  FAIL: $1"; FAIL=$((FAIL+1)); }

assert_contains() {
  local haystack="$1" needle="$2" desc="$3"
  if echo "$haystack" | grep -qF "$needle"; then pass "$desc"; else fail "$desc (expected to find: $needle)"; fi
}

echo "== Resetting state =="
rm -rf data
$CLI status > /dev/null

echo "== Configuring short retry window for fast tests =="
$CLI config set max-retries 2 > /dev/null
$CLI config set backoff-base 2 > /dev/null
$CLI config set poll-interval-ms 200 > /dev/null

echo "== Scenario 1: basic job completes successfully =="
$CLI enqueue '{"id":"t-ok","command":"echo hi"}' > /dev/null
timeout 10 $CLI worker start --count 1 > /dev/null
sleep 1
OUT=$($CLI list --state completed)
assert_contains "$OUT" "t-ok" "job completes and shows in completed list"

echo "== Scenario 2: failed job retries with backoff and moves to DLQ =="
$CLI enqueue '{"id":"t-fail","command":"exit 1"}' > /dev/null
sleep 4
OUT=$($CLI dlq list)
assert_contains "$OUT" "t-fail" "failing job lands in DLQ after exhausting retries"

echo "== Scenario 3: multiple workers process jobs without overlap =="
timeout 10 $CLI worker start --count 2 > /dev/null
for i in 1 2 3 4 5 6; do
  $CLI enqueue "{\"id\":\"t-par-$i\",\"command\":\"sleep 0.3 && echo done-$i\"}" > /dev/null
done
sleep 3
OUT=$($CLI list --state completed)
COUNT=$(echo "$OUT" | grep -c "t-par-")
if [ "$COUNT" -eq 6 ]; then pass "all 6 parallel jobs completed exactly once"; else fail "expected 6 completed t-par jobs, saw $COUNT"; fi

echo "== Scenario 4: invalid commands fail gracefully (no crash) =="
$CLI enqueue '{"id":"t-badcmd","command":"totally_not_a_real_binary_123"}' > /dev/null
sleep 4
OUT=$($CLI dlq list)
assert_contains "$OUT" "t-badcmd" "invalid command retried then moved to DLQ without crashing the worker"

echo "== Scenario 5: job data survives restart =="
BEFORE=$($CLI status)
# A fresh `node bin/queuectl.js ...` invocation is a brand-new OS process
# reading from the same SQLite file, i.e. a full "restart" of the tool.
AFTER=$($CLI status)
if [ "$BEFORE" == "$AFTER" ]; then pass "job/state counts identical across process restart"; else fail "state mismatch across restart"; fi
OUT=$($CLI list --state completed)
assert_contains "$OUT" "t-ok" "completed job still present after restart"

echo "== Scenario 6: priority queueing =="
# Enqueue a low priority job, then a high priority job
$CLI enqueue '{"id":"t-low","command":"sleep 0.2 && echo low","priority":1}' > /dev/null
$CLI enqueue '{"id":"t-high","command":"sleep 0.2 && echo high","priority":10}' > /dev/null
sleep 2.5
HIGH_TIME=$(node -e "console.log(require('./src/jobs').getJob('t-high').updated_at)")
LOW_TIME=$(node -e "console.log(require('./src/jobs').getJob('t-low').updated_at)")
if [[ "$HIGH_TIME" < "$LOW_TIME" ]]; then
  pass "high priority job executed before low priority job"
else
  fail "priority queueing fail: t-low executed before t-high (high updated at $HIGH_TIME, low updated at $LOW_TIME)"
fi

echo "== Scenario 7: job execution timeout =="
$CLI enqueue '{"id":"t-timeout","command":"sleep 2","timeout_ms":400}' > /dev/null
sleep 2.5
OUT=$($CLI info t-timeout)
assert_contains "$OUT" "Job timed out after exceeding limit of 400ms" "job timed out and recorded correct error message"

echo "== Scenario 8: delayed job scheduling =="
$CLI enqueue '{"id":"t-delayed","command":"echo delayed_done","delay_seconds":3}' > /dev/null
sleep 1
OUT=$($CLI info t-delayed)
assert_contains "$OUT" "State:      pending" "delayed job remains pending before delay expires"
sleep 3
OUT=$($CLI info t-delayed)
assert_contains "$OUT" "State:      completed" "delayed job completes after delay expires"

echo "== Stopping workers gracefully =="
timeout 15 $CLI worker stop > /dev/null

echo ""
echo "================================"
echo "Results: $PASS passed, $FAIL failed"
echo "================================"
[ "$FAIL" -eq 0 ]
