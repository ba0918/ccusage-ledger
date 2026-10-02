# Startup month cache

Goal: shorten repeat startup while preserving complete daily/monthly coverage and showing truthful progress.

Specification: `docs/spec/startup-month-cache.md`.

Approach: measure before changing product code; replace complete month coverage in the existing private aggregate cache, then add observed progress and cancellation around the existing retrieval lifecycle. This retains upstream aggregation and current HTTP/browser flow.

Scope: fetch/cache code and focused helper modules/tests, CLI startup and related tests, README/AGENTS.md/dashboard specification updates needed for accuracy. No dependency upgrade, unrelated refactor or issue #5 scope expansion. Internal helper names and code organization are implementation choices. The governing user approval authorizes implementation and draft PR creation; no renewed approval gate is needed for routine reversible work.

## Step 1: benchmark gate

Purpose: verify the approach under specification Evidence and scope. Prerequisite: pinned dependencies and local usage data. May change: private scratch and a sanitized measurement note. Done when full and month-boundary output timings and sizes are compared and covered daily/monthly aggregates are checked. Shown by external measurement with allowlisted existing ccusage behavior. Never upload raw logs or model details. Stop and report if ineffective or if sensitive new transmission would be required.

## Step 2: cache replacement

Purpose: implement Collection and replacement and Reconciliation and compatibility. Prerequisite: favorable benchmark. May change: src/fetch-usage.ts, a focused cache helper, related synthetic tests and CLI rebuild flag. Done when repeated refresh replaces covered records/removes absent records, leaves earlier records intact, and incompatible/stale metadata forces full reconciliation. Shown by test-first focused `bun test` runs for these behaviors. Internal representations may be chosen for clarity while preserving private atomic cache storage and API projection. Stop if upstream window semantics contradict the approved daily/monthly contract.

## Step 3: progress and cancellation

Purpose: implement Progress and outcomes and Cancellation and resource safety. Prerequisite: collection stages available. May change: CLI/fetch lifecycle, focused progress helper and tests, server lifecycle only if cancellation needs shutdown support. Done when real stages and monotonic elapsed time display on stderr TTY, CI/nonTTY is clean, outcomes are distinct, Ctrl+C cleans up and cannot launch browser. Shown by test-first focused tests of observable behavior. No fake progress or upstream logging dependency. Preserve existing timeout unless benchmark evidence justifies a bounded first-load value. Stop for a required scope expansion.

## Step 4: verification and review

Purpose: prove Evidence and scope and document resulting behavior. Prerequisites: steps 2 and 3. May change: README.md, AGENTS.md, docs/spec/dashboard.md and sanitized benchmark note; focused fixes from review. Done when documentation matches and checks pass. Shown by checks in order: `bun test`, `bunx tsc --noEmit`, `bun run lint`, `bun run build`, `bun audit`, repository `.lefthook/secretlint.sh` on changed files, vendor integrity tests, packaged Node smoke equivalent to CI with synthetic/empty data. Run independent quality and conformance review, fix scoped findings, and repeat review. Never disable hooks. Commit only explicit paths. Parent creates the authorized draft PR, verifies exact pushed head and CI, and does not merge.
