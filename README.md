# SeaRoulette

SeaRoulette is a Seanime plugin that turns your AniList library into a configurable anime roulette.

## Features

- Select multiple AniList statuses at once (Watching, Planning, Paused, Completed, Dropped, Repeating).
- Optional English-dub-only filtering.
- Minimum and maximum AniList rating filters.
- Multi-select genres with **ANY** or **ALL** matching.
- Every spin immediately opens the selected anime's Seanime page.
- Five-second cooldown between spins.
- No repeats until the eligible pool is exhausted.
- Filter settings persist between sessions.
- Cached collection and eligible pool (including empty results) avoid repeated AniList requests during rerolls.

## Install

Add the raw manifest URL to Seanime:

`https://raw.githubusercontent.com/DefnoJae/SeaRoulette/main/Manifest.json`

## Filters and caching

Selected lists combine with OR; list, rating, dub and genre categories combine with AND. Ratings use AniList's **meanScore**, from 0 to 100, with inclusive bounds. Unrated titles count as 0. Lists and Genres are always visible in three-column checkbox grids. Select multiple choices and use the ANY/ALL buttons beside Genres to set matching; no selected genres means no genre restriction.

English Dub Only matches the library's **MAL IDs** against the maintained [MAL-Dubs catalog](https://github.com/MAL-Dubs/MAL-Dubs/blob/main/data/dubInfo.json). Recorded full and partial English dubs qualify; this is not a guarantee that every episode is dubbed or available on a particular service. Titles absent from the catalog or without a MAL ID are excluded. Titles/language metadata are never used to guess dub availability. The catalog is refreshed at most daily and persists across restarts. If the source is unavailable, a saved catalog up to seven days old can be used; without valid evidence generation stops.

Dub catalog data is provided by MAL-Dubs under its [AGPL-3.0 license](https://github.com/MAL-Dubs/MAL-Dubs/blob/main/LICENSE). SeaRoulette downloads it directly from the upstream URL; no catalog snapshot or upstream script is distributed in this repository.

The pool and collection remain cached for the current plugin session. **Refresh roulette pool** fetches the collection again and restarts the selection cycle while preserving the valid dub catalog. Refresh is limited to once per minute. Changing filters also restarts the cycle. Settings persist across plugin restarts; the no-repeat cycle is session-only. Picks are uniformly random among remaining eligible titles, with no taste or search metadata requests.

## 0.1.10 — Avoid native async continuation panic

Replaced native async/await in Generate, discovery and dub loading with explicit Promise callbacks after Seanime's Goja runtime panicked while resuming a discovery fetch (storeStashLexP / index out of range). Normal error reporting, stale-filter cancellation, the generation guard, cache reuse, cooldown and rate-limit blocking remain. Checked delayed fetch completion in Seanime 3.10.3's pinned Goja version with its ES2018 minification settings. The original panic was not reproduced locally, so confirmation in the installed Seanime instance remains necessary.

## 0.1.9 — Outside-library discovery

Select **Outside library** in Lists to include titles absent from every status in your library. It can be combined with existing statuses using OR. Dub, rating and genre filters still apply. Discovery loads one 50-title batch at a time from AniList, ordered by popularity. Rerolls reuse the batch and avoid repeats until its eligible pool is exhausted; **Refresh roulette pool** advances to the next batch (once per minute). This samples batches rather than the entire AniList catalog. Empty batches need a manual refresh; no automatic scanning or retries occur. HTTP 429 blocks further discovery requests for Retry-After (60 seconds by default), then requires another click. Changing filters reuses discovery data. The normal library-only mode sends no discovery requests.

## 0.1.8 — Remove taste recommendations

Removed taste controls, seed requirements, weighted selection, search, and associated AniList metadata requests and network permission. Old saved taste settings are ignored; list, dub, rating, and genre preferences remain.

## 0.1.7 — Three-column filter rows

Removed the failing dropdown menus. Lists and Genres now use native checkboxes in three-column grids, with ANY/ALL buttons beside the Genres heading. Selection settings, cooldown, navigation, and keeping the tray open are preserved.

## 0.1.6 — Compact multi-select dropdowns (superseded)

Lists and Genres now use native dropdown menus with checked selections and compact summaries. The Genres menu scrolls and includes ANY/ALL matching. Taste search and seeds appear only when Taste Recommendations is enabled. Removed redundant headings and explanatory text from the tray; Generate remains prominent and keeps the tray open.

## 0.1.5 — Keep the tray open

Generate opens the selected anime page while keeping SeaRoulette's tray open. The cooldown updates in place, letting you generate again after five seconds. Click outside the tray to dismiss it using Seanime's native behavior.

## 0.1.4 — Catalog-based dubs and no automatic metadata retries

Removed per-title AniList cast queries completely. Even a large library now needs only one external catalog download for dub filtering, then local MAL-ID lookups. Taste scoring happens after this fully filtered pool is known.

Public search and taste requests use `ctx.fetch` directly, with a 15-second timeout and the existing 2.5-second request queue, instead of Seanime's automatically retrying AniList helper. An HTTP 429 stops the operation immediately; `Retry-After` blocks subsequent requests until the wait expires. **No automatic retry is scheduled**, including for other queued work. You must click again after the wait. Normal collection access still uses Seanime's account-aware collection API; Seanime's own collection synchronization is outside this metadata queue.

The manifest requests network access only to `raw.githubusercontent.com` (catalog) and `graphql.anilist.co` (public metadata). Grant these domains when updating the plugin. The tray displays **SeaRoulette 0.1.4** so the installed payload can be verified. If an earlier version's scan continues after updating, fully stop/restart Seanime once to terminate that old work.

## 0.1.3 — Request pacing and on-demand dub verification (superseded)

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

These tests use a strict mock of Seanime's v3.10.3 builders/events, HTTP responses and collection data. They cover valid render trees, navigation, the five-second cooldown, no repeats, filter logic, catalog matching/cache/offline behavior, persistence, ignoring legacy taste settings, and generation without metadata requests. Type-check `code.ts` alongside Seanime v3.10.3's `plugin.d.ts` and `app.d.ts` using `tsc --noEmit --skipLibCheck --target es2020`. A live Seanime UI smoke test is still needed after updating the installed plugin.
