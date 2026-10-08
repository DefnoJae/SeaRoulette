# SeaRoulette

SeaRoulette is a Seanime plugin that turns your AniList library into a configurable anime roulette.

## Features

- Select multiple AniList statuses at once (Watching, Planning, Paused, Completed, Dropped, Repeating).
- Optional English-dub-only filtering.
- Minimum and maximum AniList rating filters.
- Multi-select genres with **ANY** or **ALL** matching.
- **Taste Filter:** choose 1–5 anime you like. SeaRoulette weights candidates using genre similarity, shared tags and AniList recommendations.
- Every spin immediately opens the selected anime's Seanime page.
- Five-second cooldown between spins.
- No repeats until the eligible pool is exhausted.
- Filter settings persist between sessions.
- Cached collection, eligible pool (including empty results), and taste metadata avoid repeated AniList requests during rerolls.

## Install

Add the raw manifest URL to Seanime:

`https://raw.githubusercontent.com/DefnoJae/SeaRoulette/main/Manifest.json`

## Taste Filter

Taste mode is not a hard genre clone. Your selected lists, dub preference, rating range and genre filters first determine the eligible pool. The 1–5 taste anime then influence which eligible title is more likely to be selected. Shared genres and rank-weighted tags increase similarity, and direct AniList recommendations receive a stronger weight. Every eligible title retains a nonzero chance. Enabling taste mode requires at least one seed. Changing seeds preserves the current no-repeat cycle.

## Filters and caching

Selected lists combine with OR; list, rating, dub and genre categories combine with AND. Ratings use AniList's **meanScore**, from 0 to 100, with inclusive bounds. Unrated titles count as 0. Genre matching can require any or all selected genres; no selected genres means no genre restriction. Open the Genres button to edit its compact popover.

English Dub Only checks actual **English voice-actor credits on that anime's AniList character edges**, paging through characters until evidence is found or all pages are exhausted. It never infers a dub from English titles or country metadata. AniList's cast records can be incomplete: a dubbed title without recorded English credits is excluded. This verifies recorded dub production, not availability on a particular streaming service. Positive and negative checks persist for seven days; failed requests are never cached as negatives.

The pool, collection and taste metadata remain cached for the current plugin session. Taste tags are fetched in batches of up to 50 titles; recommendation connections are fetched only for the selected seeds (the top 25 recommendations each). Rerolls reuse these records. **Refresh roulette pool** fetches the collection again and restarts the selection cycle while preserving valid dub and taste records. Refresh is limited to once per minute. Changing normal filters also restarts the cycle. Settings persist across plugin restarts; the no-repeat cycle is session-only.

## 0.1.3 — Request pacing and on-demand dub verification

Generate no longer scans every title's cast before making the first pick. It draws candidates from the list/rating/genre pool, verifies a candidate's English cast only when needed, rejects confirmed non-dubs, and stops as soon as a valid pick is found. Cached positives and negatives are reused, including records saved by earlier versions. Weighted rejection produces the same taste-weighted distribution among eligible dubbed titles; an unverified title never becomes a final pick.

Dub pages, taste metadata and search share one serialized queue with at least **2.5 seconds between requests** (at most about 24 metadata requests per minute). Generate remains busy while verification runs, repeated clicks cannot launch another scan, and changing filters cancels pending work before it can open an outdated pick. First-time searches or verification can take longer when multiple requests are needed. Seanime's shared AniList backoff still applies if other activity consumes the remaining quota.

Regression coverage includes a 500-title pool that needs only one dub request when its first candidate qualifies, paced concurrent search/taste/dub requests, filter-change cancellation, and cache-preserving refreshes. The asynchronous Generate/pagination path was also checked in Seanime 3.10.3's pinned Goja runtime with native Go fixtures and timer callbacks.

## 0.1.2 — Public AniList queries

Fixed Generate's `AniList data could not be loaded` error when dub or taste mode was enabled. The previous metadata helper called `$database.anilist.getToken()`, which requires the separate `anilist-token` permission and throws `permission denied` without it. Cast, taste and search queries now use public AniList access with an empty token. The unused `database` permission was removed; filter persistence still uses `storage`. No additional permissions are required.

Errors now identify the failing operation and underlying message in both the toast and plugin logs. Regression tests deny token access and also run with no database global. The original failure and patched success were reproduced in the exact Goja version pinned by Seanime 3.10.3, using native Go collection/query fixtures. The [AniList Autopause example](https://github.com/nnotwen/n-seanime-extensions/blob/master/plugins/Anilist%20Autopause/anilist-autopause.json) explicitly requests token permission; the [Random Entry example](https://github.com/nnotwen/n-seanime-extensions/blob/master/plugins/Random%20Entry/provider.ts) confirms the collection and navigation calls.

## 0.1.1 — Seanime 3.10.3 compatibility

Fixed `Component type "" not found`: the tray render callback must **return** its root component. The tray now uses explicit object builder arguments, a returned `stack`, and conditional array spreads so no null/undefined component enters `stack` or `flex`. Wrapped rows and native controls keep Generate prominent.

Validated against [Seanime v3.10.3 source](https://github.com/5rahim/seanime/tree/v3.10.3/internal/plugin/ui), its [plugin types](https://github.com/5rahim/seanime/blob/v3.10.3/internal/extension_repo/goja_plugin_types/plugin.d.ts), frontend registry, and the [official working plugin example](https://seanime.gitbook.io/seanime-extensions/plugins/example). The source supports both shorthand and object arguments; the missing render return was the root error. Cooldown now uses `ctx.setTimeout` and navigation uses `ctx.screen.navigateTo("/entry", {id})`. AniList custom queries return unwrapped GraphQL data. Search uses a custom query to avoid the v3.10.3 `listAnime` runtime/type mismatch (the runtime includes an extra tags argument).

## Development validation

Run the contract and behavior tests with Node.js 24+:

```sh
node --test tests/runtime.test.cjs
```

These tests use a strict mock of Seanime's v3.10.3 builders/events and AniList responses. They cover valid render trees, navigation, the five-second cooldown, no repeats, filter logic, dub pagination/cache/error handling, seed limits, taste weights, and persistence. Type-check `code.ts` alongside Seanime v3.10.3's `plugin.d.ts` and `app.d.ts` using `tsc --noEmit --skipLibCheck --target es2020`. A live Seanime UI smoke test is still needed after updating the installed plugin.
