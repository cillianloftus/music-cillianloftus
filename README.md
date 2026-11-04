# music.cillianloftus.com

A personal music rating and playlist tool. Tracks and albums are rated
across several axes, composite scores are derived from those ratings, and
playlists are generated from saved queries over the results.

## How it works

- **Catalogue.** Five layers (work, recording, track, release, release
  group), so a reissue or deluxe edition counts as one album and a song on an
  album and a compilation counts as one song.
- **Ratings** are append-only. Re-rating adds a row, so how an opinion drifts
  over time is kept rather than overwritten.
- **Scores** are SQL views, never stored. Changing a weight re-ranks the whole
  library at once. Gut scores are calibrated against considered ones from
  the ratings themselves.
- **Playlists are saved queries.** One JSON definition format, validated
  against a field registry and compiled to a single read-only `SELECT`;
  the same compiler serves the page, the API and the Spotify push. A
  filter-chip builder edits definitions with the state in the URL, so back
  is undo.
- **Imports** run as jobs on a cron. They match on external IDs, fill only
  empty fields, and attach a new edition to an existing album rather than
  duplicating it. Albums not on any database can be pasted in by hand.
- **Backups** dump every table to JSON daily, to R2 and optionally GitHub.
  Every test run restores one.

## Stack

Astro on Cloudflare Workers, with D1 (SQLite), KV, R2 and Workers AI.
Writes sit behind Cloudflare Access; the Worker verifies the Access JWT
itself. Plain CSS, server-rendered pages, and no client framework: every
page works without JavaScript.

## Development

```sh
npm install
npx wrangler d1 migrations apply music-db --local
npm run dev      # http://127.0.0.1:4323
npm test         # Vitest against real SQLite (node:sqlite) with every migration applied
npm run check    # type-check the Worker code and the tests separately
```

Create `.dev.vars` with `DEV_ACCESS_EMAIL` (your identity in local
development) and `OWNER_EMAIL`; Spotify and GitHub backup credentials are
optional.

No audio is hosted, served, or fetched from any streaming service.
