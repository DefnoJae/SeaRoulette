# SeaRoulette

SeaRoulette is a Seanime plugin that turns your AniList library into a configurable anime roulette.

## Features

- Select multiple AniList statuses at once (Watching, Planning, Paused, Completed, Dropped, Repeating).
- Optional English-dub-only filtering.
- Minimum and maximum AniList rating filters.
- Multi-select genres with **ANY** or **ALL** matching.
- **Taste Filter:** choose 1–5 anime you like. SeaRoulette weights candidates using genre similarity and AniList recommendations.
- Every spin immediately opens the selected anime's Seanime page.
- Five-second cooldown between spins.
- No repeats until the eligible pool is exhausted.
- Filter settings persist between sessions.
- Cached eligible pool avoids unnecessary AniList collection requests.

## Install

Add the raw manifest URL to Seanime:

`https://raw.githubusercontent.com/DefnoJae/SeaRoulette/main/Manifest.json`

## Taste Filter

Taste mode is not a hard genre clone. Your selected lists, dub preference, rating range and genre filters first determine the eligible pool. The 1–5 taste anime then influence which eligible title is more likely to be selected. Shared genres increase similarity, and direct AniList recommendations receive a stronger weight.
