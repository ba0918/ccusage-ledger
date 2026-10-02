# Startup collection and progress

This records the approved scope for the startup improvement related to issue #5. The benchmark is a gate: implement the following only if month-window collection is useful on the available local history.

## Collection and replacement

The first successful collection retrieves full history using the pinned ccusage JSON daily/monthly/by-agent contract. Later compatible collections start at the first day of the previous calendar month, including the entire current month. Replace all daily and monthly records in that coverage with the new result, including removing records absent from successful output. Preserve records before coverage. Empty validated output is successful and removes covered records; it is not a fetch failure. Repeating a refresh must not duplicate or accumulate totals. Keep ccusage monthly results; do not derive monthly from daily.

## Reconciliation and compatibility

Provide an explicit `--rebuild-cache` full collection. Also require a full collection on startup when the last successful full reconciliation is at least seven days old. A failed attempt does not advance reconciliation metadata. This bounds old edits, deletions, backfills and historical repricing to the next successful full reconciliation; it is not a background scheduler. Continue configured upstream price behavior, without forcing offline prices. A legacy, corrupt, future-dated or incompatible incremental metadata record triggers a full fetch, never a window merge. Compatibility covers cache schema/aggregation revision, pinned upstream implementation, command/configuration, effective source directories and timezone. Do not persist raw private paths in metadata: fingerprint relevant configuration. A known-incompatible source/config cache must not be merged or presented as compatible fallback. Existing legacy valid aggregate caches may remain explicitly stale fallback until a successful full fetch. Keep all existing bounds and white-list projection.

## Progress and outcomes

During startup show ledger-owned single-line progress on stderr when stderr is a TTY (except CI). Report observed stages: verify ccusage, full-history or date-window collection, validate/save, and ready URL. Use elapsed monotonic time; never claim percentage, ETA, file counts or parse upstream debug logs. NonTTY/CI output is minimal ordinary lines and stdout/JSON stays free of animation escapes. Distinguish successful data, valid empty data, failed fetch using stale cache, failed first fetch without cache, and successful data with a cache-write warning. Open the browser only after usable final/fallback data exists, including a valid empty result. Keep existing bind and security behavior.

## Cancellation and resource safety

Ctrl+C during startup cancels retrieval, terminates the spawned work, clears timers/display and temporary resources, exits without later opening the browser, and does not replace the cache with a partial result. Preserve bounded fetch timeout, output limits, private atomic cache writes, allowed environment variables, integrity verification and existing HTTP protections. Timeout remains 60 seconds unless measurements directly justify a bounded adjustment.

## Evidence and scope

Use synthetic fixtures for replacement/removal/idempotence, month/year boundaries, invalidation/reconciliation, fallback and cancellation tests. Test terminal and nonterminal progress behavior. Run tests, typecheck, lint, build, audit, secretlint, vendor integrity and packaged Node smoke. Keep measured local logs and private usage/model/account details out of commits and PRs; record only timings, byte sizes and aggregate validation results. Create a draft PR and verify CI at its exact pushed head, without merging. Parser forks, databases, daily-to-monthly reimplementation, cache-first browser refresh, HTTP pricing cache changes, normalization of existing aggregate discrepancies and full issue #5 completion are outside scope.
