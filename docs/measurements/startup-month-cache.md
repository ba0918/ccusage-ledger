# Startup month-window measurement

Measured on 2026-10-02 using the existing local WSL usage sources, ccusage 20.0.26, and the ledger's JSON command with daily/monthly sections and agent breakdowns. The window starts on the first day of the previous calendar month. No usage logs were changed or copied into the repository.

The runner reused the ledger's runtime command construction, environment allowlist, empty temporary HOME, pinned wrapper/native integrity checks, 64 MiB stdout limit, and 60-second timeout. Pricing used the existing default behavior; no offline-price override or persistent price-cache optimization was introduced.

| Trial order | Collection | Elapsed | JSON bytes |
| --- | --- | ---: | ---: |
| 1 | Full history | 27.810 s | 603,254 |
| 2 | Previous-month boundary | 2.503 s | 130,202 |
| 3 | Previous-month boundary | 1.616 s | 130,202 |
| 4 | Full history | 13.436 s | 603,254 |
| 5 | Full history | 4.270 s | 603,255 |
| 6 | Previous-month boundary | 1.566 s | 130,203 |
| Validation | Full history | 3.702 s | 603,260 |
| Validation | Previous-month boundary | 1.618 s | 130,207 |

Full output contained 183 daily records and 9 monthly records; window output contained 32 daily records and 2 monthly records. All outputs passed the ledger schema. The first six trials' median was 13.436 s for full history and 1.616 s for the window. Warm validation still showed about a 2.3-fold improvement. Output size fell by about 78%.

## Correctness validation

Filter the full result at the same month boundary, project both results with the ledger's existing whitelist, sort arrays by stable period/model/agent identity, and compare every projected field. Numeric comparison permits relative/absolute floating-point rounding of 1e-8. Both daily and monthly sections matched.

An initial comparator sorted entire serialized objects; small floating-point reduction differences could reorder nested arrays and produce false mismatches. Stable identity sorting resolved these mismatches. Private identifiers and numerical usage totals were never emitted. Raw output stayed in process memory; temporary homes and benchmark scratch were removed.

## Decision and limits

The month-window strategy is effective on this machine's available history, so month-aligned replacement with previous-month overlap is justified. Retain the 60-second fetch limit: even the first full run completed within it. Results include process startup and default pricing behavior; they do not isolate filesystem caching or network latency. The descending full-run timings show warm-cache/order effects, so the median is evidence for this dataset, not a universal speed guarantee.

The window is a refresh boundary, not a source offset. Earlier edits, deletions, backfills, and historical price changes still require full reconciliation. A weekly full rebuild plus an explicit rebuild option bounds that staleness without forcing offline pricing. Successful window refreshes must replace all covered daily and monthly records, including periods absent from the new result.

