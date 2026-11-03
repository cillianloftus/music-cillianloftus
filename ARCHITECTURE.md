# music.cillianloftus.com — architecture

## How to read this document

This is the vision for the site as it stands today. It is a snapshot of
intent, not a contract.

Cillian will change his mind about things as the build progresses, and that is
expected and fine. When a decision here turns out to be wrong, change it and
update this document rather than working around it. A stale architecture
document is worse than none.

Two categories of decision live in here, and they deserve different treatment:

**Structural.** Expensive or painful to reverse once there is data. Push back
before changing these, and if they do change, plan a migration. They are
listed in full at the end under *Structural commitments*.

**Current preference.** Everything else. Weights, thresholds, orderings,
colours, which source is tried first, how the queue is sorted. These are
starting positions, chosen so there is something concrete to react to. Change
them freely as Cillian forms opinions. Do not treat a number in this document
as sacred just because it is written down.

If something here conflicts with what Cillian says in a session, he wins.

---

## 1. What this is

A personal music rating and playlist tool. Rate tracks and albums across
several axes, derive composite scores, and generate Spotify playlists from
saved queries over the results.

Single primary user, with up to four friends able to log in and rate. Not a
product, not a service, no growth ambition. Spotify's Development Mode cap of
five authorised users matches the intended audience exactly and there is no
room above it.

It is also a portfolio piece. Cillian's main site presents his architecture
work and establishes that he writes code; this is the piece that demonstrates
the second claim properly. It should be genuinely beautiful and genuinely
useful, in that order of difficulty and the reverse order of importance.

Lives at `music.cillianloftus.com` as a subdomain of the main site, with its
own repo and its own Worker. Nothing is shared with the portfolio codebase.

---

## 2. Platform

One Cloudflare Worker, `music-cillianloftus`, deployed from its own repo via
Workers Builds on push to `main`.

| Concern | Choice |
|---|---|
| Framework | Astro 5, Cloudflare adapter, `output: 'server'` |
| Language | TypeScript, strict |
| Database | D1 (binding `DB`) |
| Cache | KV (binding `CACHE`) |
| Blobs | R2 (binding `ASSETS`) — artwork, playlist art, DB dumps |
| Interpretation | Workers AI (binding `AI`) |
| Auth | Cloudflare Access, path-scoped |
| Secrets | Worker secrets — Spotify client secret, GitHub backup token, Discogs token |

No separate services. No container. No Node server.

### Auth

Access policies apply to paths, not the whole site:

- `/edit/*` and `/api/write/*` — Access required, email allowlist (max 5)
- `/api/query` — Access required (see below)
- everything else — public, cacheable at the edge

The site is publicly readable. Anyone can browse the catalogue, ratings,
genre tree and playlists. Only authenticated users can change anything.

The Worker reads identity from the `Cf-Access-Jwt-Assertion` header to
attribute writes. No login code is written.

Public pages show Cillian's ratings by default. Other users' ratings are
visible when authenticated as that user.

**The natural language endpoint requires authentication** even though browsing
does not, because every call costs an AI inference and a public endpoint is an
open invitation to run up a bill. Saved definitions run without the model and
stay public, so the public site remains fully functional.

### Local development

`wrangler dev` with D1 in local mode. Migrations live in `migrations/` and run
with `wrangler d1 migrations apply`, local first then remote. A seed script
populates a handful of albums so a fresh checkout has something to look at.

---

## 3. Data model

Primary keys are locally generated UUIDs on every table. External IDs are
nullable columns. No entity depends on existing in any external database,
because plenty of the music Cillian listens to does not.

### Catalogue

```
artist              id, name, sort_name, disambiguation,
                    mbid?, spotify_id?, discogs_id?, source, created_at

work                id, title, preferred_recording_id?

recording           id, work_id?, title, length_ms?,
                    first_release_date?, date_precision,
                    mbid?, spotify_id?, isrc?, source

release_group       id, title, type, status, availability,
                    first_release_date?, date_precision,
                    preferred_release_id?, mbid?, spotify_id?, source

release             id, release_group_id, title, date?, date_precision,
                    country?, label?, format?, mbid?, spotify_id?

track               id, release_id, recording_id, disc, position,
                    title_on_release?
```

The five layers exist to solve a specific problem. Thriller has an original
pressing, a reissue, a Japanese edition and a deluxe, and it must count as one
album in a ranking. A song can appear on an album and a mixtape and must count
as one song. A remix is a different recording that should be rateable
separately but must not put three versions of the same song in a top 100.

So: **album ratings attach to `release_group`**, editions are `release` rows.
**Track ratings attach to `recording`**, appearances are `track` rows.
Recordings link up to a shared `work`, and that link is what allows collapsing
versions.

`release_group.type` — album | ep | single | compilation | mixtape |
soundtrack | live

`release_group.status` — announced | released | cancelled

`release_group.availability` — for_sale | unpurchasable | unreleased

`date_precision` — day | month | year | unknown. Every date column is paired
with one. Old records often have only a year, and announced albums sometimes
have only a vague quarter.

A release group may have zero releases and zero tracks, which is what an
announced album looks like for months. Nothing in the import or render path
may assume a tracklist exists.

### Credits

```
artist_credit       id, entity_type, entity_id, artist_id, role, position
```

`entity_type` — release_group | release | recording

`role` — primary | featured | remixer | producer | writer | engineer |
performer | mixer

This table is the entire credits feature. "Everything produced by X", "tracks
where Y appears as a guest rather than lead", "writers whose songs I rate
highly across artists I would never connect" are all one join. It is the
richest seam in the whole system and worth populating properly.

### Genre

```
genre               id, name, parent_id?
genre_tag           entity_type, entity_id, genre_id, source, weight
```

Genres are atomic concepts. Atomic means naming one thing, not being one word:
"art pop" is a single genre, "experimental hip hop" is two.

`parent_id` forms a tree. Pop is a parent of indie pop is a parent of bedroom
pop. Queries use recursive CTEs for "pop and everything beneath it", which
lets a playlist filter at whatever altitude suits it.

The tree is seeded from Wikidata subclass relations and then curated by hand.
There is no canonical genre hierarchy anywhere; where bedroom pop sits is a
judgement, and this one is Cillian's.

`genre_tag.source` — manual | derived | musicbrainz | discogs

Manual tags always win. Album genres are derived from track genres on a
schedule: a genre is derived onto a release group when tagged on at least 40%
of its tracks, ordered by frequency. An album with eight art pop tracks, six
experimental, four chamber pop and two rap reads as experimental art pop,
which is what a person would say. Recomputation never touches manual rows.

The 40% threshold is a current preference. Expect to move it.

Albums and tracks genuinely differ, so a track may override its album's genre
entirely.

### Ratings

Append-only. Never updated in place. The current rating is the latest row.
This gives rating drift for free, and means a bad edit can never destroy
history.

```
rating              id, user_id, entity_type, entity_id, rated_at,
                    depth,
                    gut_score,
                    production, songwriting, lyrics, performance,
                    sequencing, cohesion, ambition,
                    impact, impact_note
```

`entity_type` — recording | release_group

`depth` — gut | detailed

All axes 0–10 and nullable.

**Craft axes** apply to recordings: production, songwriting, lyrics,
performance. Lyrics are split from songwriting deliberately, because they fail
independently.

**Album axes** apply to release groups: sequencing, cohesion, ambition. These
have no track equivalent and are what makes an album more than its tracklist.

**`gut_score`** is a single 0–10 entered in about two seconds. It is not a
rough version of the breakdown; it is a different measurement, capturing
immediate response rather than considered judgement. Both are stored and
neither overwrites the other.

Most tracks only ever get a gut score, and that is the intended behaviour. A
system that demands five numbers per track will go unused within a fortnight.
Detailed ratings are for records that earn the attention.

**`impact`** is 0–10 and deliberately sparse, null on almost everything. It
records "there was life before this record and life after". It is not a
quality measurement; a scrappy, badly produced album can be the one that
rearranged you. Roughly one album in twelve should carry it. If every album
has an impact score the field has stopped meaning anything.

**`impact_note`** is free text, a line about when and what. It is the only
data in this system that no API could ever supply, and in ten years it will be
the part that matters most. Public, by Cillian's choice.

```
weights             id, user_id, version, payload_json, active, created_at
```

Versioned, so historical formulas can be replayed and a top 50 under last
year's weights can be compared against this year's.

### Derived scores

SQL views. Never stored columns. Storing a composite freezes a formula that
will certainly change, and re-rating a library by hand to fix a weighting
decision is how this project dies.

```
v_gut_calibration   user_id, offset
```

The mean difference between `gut_score` and the axis composite, across rows
that have both. Gut scores almost certainly run consistently high or low
against considered ones. Applying the offset puts the two populations on a
comparable scale empirically rather than by assumption, and the offset should
shrink over time as the gut gets trained.

```
v_recording_score   recording_id, user_id, quality_score, personal_score, depth
v_release_score     release_group_id, user_id, quality_score, personal_score
```

- **`quality_score`** — weighted craft axes normalised to 0–100, falling back
  to the calibrated gut score where axes are absent. Hard capped at 100. A
  bounded scale is what makes it a measurement, and it answers "which albums
  are best made" independently of anyone's relationship to them.
- **`personal_score`** — `quality_score + impact`, range 0–110. Flat points
  rather than a percentage, because impact is independent of quality.

Both exist because they answer different questions. Playlist definitions
choose which to sort by. This is also why the old 11-out-of-10 habit works
here: a hundred plus ten is the same gesture with more room in it.

Album quality aggregates its tracks with a trimmed mean, discarding the lowest
track, at 70%, plus album-only axes at 30%. A plain mean punishes an ambitious
record with one weak track more than a consistently mediocre one, which
inverts how albums are actually experienced. Both the trim rule and the 70/30
split are current preferences and live in the weights table.

Every rating row carries `depth`, so definitions can demand full breakdowns
for a serious ranking and ignore it for a shuffle.

### Ownership and files

```
holding             id, user_id, release_id, format, acquired_at?, notes?
file                id, recording_id, path, format, bitrate?, checksum?
```

`holding.format` — cd | vinyl | cassette | digital

Ownership and availability are separate things. `holding` rows say what
Cillian physically has. `release_group.availability` says whether a copy can
be bought at all. That split gives "albums I rate above 85, that are for sale,
that I do not own", which is a shopping list, and "albums I rate highly that
are unpurchasable", which is the list of candidates for burning his own.

`file` catalogues audio Cillian already owns, by path on his own machine, with
checksums so a missing or corrupted rip is detectable. It supports assembling
a folder of audio plus artwork ready for burning.

**No audio is uploaded, hosted, served, or fetched from any streaming
service.** The site catalogues files; it never moves them.

### Listening history

```
play                id, user_id, recording_id, played_at, ms_played, source
```

`source` — spotify_export | lastfm | manual

Populated from Spotify's extended streaming history export, requested from
privacy settings. That is the same data third-party stats services are built
on, straight from the source, and it can be re-requested periodically. Last.fm
is the option for ongoing scrobbles rather than periodic dumps.

The interesting query is not "most played". It is the divergence between what
is rated highly and what is actually played. Both directions surprise.

### Playlist definitions

```
definition          id, user_id, name, description?, query_json,
                    spotify_playlist_id?, art_key?, art_mode,
                    created_at, updated_at
definition_run      id, definition_id, ran_at, result_ids_json
definition_pin      definition_id, recording_id
definition_exclude  definition_id, recording_id
```

A playlist is a saved query, not a list of tracks. Regenerating updates the
existing Spotify playlist in place rather than creating "Top 100 (2)".

Pins and excludes exist because eventually a query will be right about
ninety-eight tracks and wrong about two, and the whole approach should not
have to be abandoned over it.

`definition_run` snapshots each generation, so it is possible to see that a
song dropped out of the top 100 in March.

Title, description and art are all editable on the site and pushed to Spotify
with the tracks.

### Playlist art

`art_mode` — generated | uploaded

**Generated is the default and the more interesting option.** Art is composed
deterministically from the playlist's own data: genre mix, rating
distribution, date range, track count. Same inputs always produce the same
image. Rendered as SVG, rasterised for Spotify's upload requirement, stored in
R2.

The result is that every playlist looks like part of one family and the image
actually encodes something about its contents, rather than being a model's
guess at a mood. Uploaded art overrides it whenever Cillian wants something
specific.

### Provenance and corrections

```
field_override      entity_type, entity_id, field, value_json,
                    user_id, edited_at
```

Imports write freely to base rows. Reads merge overrides on top. A re-sync can
never clobber a correction, and it is always visible what was changed by hand
and revertible.

Every entity also carries `source` — musicbrainz | spotify | discogs | files |
manual — so it is knowable which records to re-check if a database's coverage
improves, and which were typed by hand and should be left alone.

### Review queue

```
anomaly             id, kind, entity_type, entity_a, entity_b?,
                    detected_at, status, resolution?
entity_redirect     entity_type, old_id, new_id
confirmed_distinct  entity_type, id_a, id_b
```

Rules run on a schedule and raise anomalies. **They never fix anything
themselves.** Starting rules:

- two artists with the same name
- two recordings with near-identical titles by the same artist, not linked to
  the same work
- releases in a group with wildly different track counts, usually a deluxe
  edition filed as a separate album
- rated recordings with no work link, which can therefore never collapse
- releases with no cover art
- orphaned tracks

Resolutions are recorded in `confirmed_distinct` so the same pair is never
raised twice. Without that the queue nags forever and gets ignored.

**Merge** reparents every reference to the survivor, writes an
`entity_redirect` so old IDs still resolve, and deletes nothing. Merging is
the operation most likely to silently destroy data, so it is written properly
before there is anything to destroy.

**Rating collision on merge:** if both entities carry ratings, keep both sets,
ordered by `rated_at`, and treat the result as a re-rating history. Nothing is
discarded and the latest row still wins. The merge UI shows what the combined
history will look like before confirming.

### Jobs

```
job                 id, kind, payload_json, status, progress, total,
                    created_at, started_at?, finished_at?, error?
```

`kind` — import_release | import_discography | derive_genres | backup |
recompute_calibration | spotify_push | generate_art

### Users

```
app_user            id, email, display_name, is_owner
spotify_token       user_id, refresh_token, access_token, expires_at,
                    authorized_at
```

`authorized_at` drives the six-month re-authorisation warning.

---

## 4. Query layer

### The definition format

One JSON shape, used for ad-hoc questions and saved playlists alike. This is
the keystone: a question and a playlist are the same object, so any answer can
be saved with one click and becomes a live playlist that regenerates as
ratings move.

```json
{
  "entity": "recording",
  "where": {
    "and": [
      { "field": "personal_score", "op": "gte", "value": 85 },
      { "field": "genre", "op": "in_tree", "value": "pop" },
      { "field": "first_release_date", "op": "gte", "value": "2015" }
    ]
  },
  "group": {
    "by": "artist",
    "limit_per_group": 5,
    "sort": [{ "field": "personal_score", "dir": "desc" }]
  },
  "sort": [{ "field": "personal_score", "dir": "desc" }],
  "collapse_by_work": true,
  "limit": 50
}
```

`entity` — recording | release_group | artist | genre

`op` — eq | neq | gt | gte | lt | lte | in | not_in | contains | in_tree |
is_null | is_not_null | between

`field` must appear in a field registry generated from the schema. Aggregates
(`avg_rating`, `track_count`, `play_count`, `rating_variance`,
`days_since_release`) are registered fields and are sortable, which is what
makes "my most consistent artists" and "rated high, barely played"
answerable.

**`group`** supports top-N-per-group. This is what makes "top five tracks from
each of my top five artists" expressible, and it does not fall out of a flat
filter-and-sort model. It must be in the format from the start.

**`collapse_by_work`** defaults true. When on, results group by work and keep
one recording per group, chosen by `work.preferred_recording_id` or by score.
This is what stops four versions of one song filling a top 100. Turn it off
for a definition like "best remixes of the year".

### The pipeline

1. **Input.** Typed text, or a transcript from the Web Speech API. Both POST
   to `/api/query` with the utterance and, when refining, the current
   definition.

2. **Interpretation.** Workers AI, constrained to the definition schema. The
   prompt carries a schema description generated from the field registry, plus
   a vocabulary list of artist, genre and label names present in the library,
   cached in KV and refreshed after each import. That vocabulary is what lets
   a mangled voice transcription of an obscure artist name snap back to the
   real one.

3. **Validation.** Zod. Rejects unknown fields, unknown operators, limits over
   a ceiling. Model output is untrusted and this is the security boundary.

4. **Compilation.** `compile(definition) -> { sql, params }`. Emits `SELECT`
   only. There is no code path in it that produces a write. All values are
   bound parameters.

5. **Execution** against D1.

6. **Return** results plus the definition. The UI renders filter chips from
   the returned definition, so what is displayed always matches what ran, and
   a misreading is fixed by adjusting a chip rather than rephrasing a
   sentence.

### Why the model cannot write

The model emits JSON naming a field and an operator from fixed lists. It has
no vocabulary for SQL. A broken or hostile response fails validation and never
reaches the database.

**There is no raw-SQL fallback path.** If a question cannot be expressed, the
fix is extending the definition format. This was considered and deliberately
rejected.

### Three callers, one compiler

`compile()` is called by the query endpoint, by a saved definition when its
page opens, and by the Spotify generator before pushing tracks. Identical
semantics, so a Spotify playlist always contains exactly what the preview
showed. Letting these diverge produces discrepancies with no single cause.

### Voice

Web Speech API. Built in, free, no key, roughly twenty lines. Good support in
Chrome and Edge, works in Safari on iOS with the webkit prefix. Chrome's
implementation sends audio to Google, and accuracy on obscure artist names is
ropey.

That second caveat matters less than it appears, because the interpretation
layer repairs it using the library vocabulary.

Voice and typing share one code path. The mic is an input method on the
existing box, not a separate feature. Interim transcript shows live.

**Conversational refinement is the point.** The current definition stays in
context, so "make it thirty and drop anything before 2015" amends the previous
object rather than starting over. Keep a short stack of recent definitions in
the session so a bad sentence can be undone, which makes experimenting
cheap.

This matters most on mobile, where building a six-clause filter by tapping
chips is miserable and saying it takes four seconds.

### Caching

Cache the interpretation, not the results. Key on the normalised utterance,
value is the definition. Ratings change constantly; what a sentence means does
not. Saved definitions never call the model again, so reopening a playlist is
instant and costs nothing.

### Plain search

Separate from all of the above and not model-backed. A fast text search across
artist, album and track names, reachable from everywhere, that finds something
from three characters. At a few thousand tracks this is used far more often
than natural language, and it should feel instant.

### Model choice

Workers AI, behind a one-method `Interpreter` interface. Revisit if malformed
output exceeds roughly 5% of calls; the swap is to Claude Haiku or equivalent
via the Anthropic API and touches one file.

---

## 5. Import

### Source ladder

1. **MusicBrainz** — no key, User-Agent required, roughly one request per
   second. Richest structure: works, recordings, credits, relationships.
   Coverage of mainstream and physically released music is excellent;
   bedroom artists with a few hundred listeners are often absent entirely.
2. **Spotify by URL** — paste an album link, fetch by ID. Bypasses the
   ten-result Development Mode search cap completely, which makes it the
   practical route for small artists.
3. **Discogs** — personal access token, no app review. Strong on physical
   pressings, electronic and dance.
4. **Local audio tags** — drag a folder, read Vorbis comments or ID3. For
   uncleared mixtapes and anything not on a service, the files are the richest
   metadata source available, often including embedded art. This turns the
   hardest category of entry into the easiest.
5. **Manual entry** — a properly designed form, paste-a-tracklist rather than
   forty "add row" clicks. Used regularly, so designed accordingly.

Cover art from the Cover Art Archive by MBID, which serves front, back and
booklet scans where they exist, with manual upload as override. Everything
lands in R2.

Contributing missing artists back to MusicBrainz is worth doing for the ones
that matter: it yields a real MBID, makes the entry permanent, and lets the
Cover Art Archive hold their art.

**Not used:** Album of the Year, RateYourMusic, Bandcamp scraping. No public
API, bot protection, terms prohibit automated collection, and their genre data
is user-tagged in the same way MusicBrainz's is. For a hundred albums, typing
the genres takes an evening and produces Cillian's taxonomy rather than
someone else's.

### Matching

One `match(candidate) -> { entity_id, confidence }` service, called by both
import and the review queue.

Tiers:
- exact match on a held external ID or ISRC — certain
- normalised title and artist, lowercased, punctuation and articles stripped,
  edition suffixes like *deluxe*, *remastered*, *expanded*, *anniversary*
  removed, with release year as tiebreaker

Actions by confidence:
- **High** — merge automatically. Fill nulls only. Never touch a field with a
  `field_override`. Never delete.
- **Medium** — raise an anomaly offering: merge and fill gaps / merge and
  prefer imported / keep separate / cancel.
- **Low** — create new, flag for review.

**Importing an album already present usually means a different edition.** It
attaches a new `release` to the existing `release_group` rather than creating
a second group. Getting this branch right is most of what prevents ending up
with eight copies of the same album.

A manually created stub (title and artist only) must be matched and filled
rather than duplicated. This path is built deliberately, not left to chance.

### Execution

All imports are jobs. A cron runs every minute, claims a batch, and processes
within the Worker's execution budget, which is why a discography import cannot
be a single invocation. Resumable, idempotent, progress visible.

"Import this entire discography" is a supported and expected operation. At one
request per second with relationships, a full discography takes ten to twenty
minutes, which is fine. Queue it and come back.

Bulk imports show a **dry run** before committing: what would be created,
updated and skipped.

### Errors

A failed job surfaces its error on `/edit/jobs` with the item that failed and
a retry button, rather than disappearing. Partial imports stay partial and
resumable rather than rolling back. An import that fails on track nine of
twenty keeps the first eight.

---

## 6. Spotify

Development Mode permanently. Extended Quota requires roughly 250,000 monthly
active users and is for organisations. Premium required on the owner account.
Five authorised users maximum.

**Removed November 2024 for new apps, returning 403:** `/recommendations`,
`/audio-features`, `/audio-analysis`, `/artists/{id}/related-artists`,
`/browse/featured-playlists`, browse categories, and `preview_url`.

No tempo, energy, danceability or valence data exists. Mood-based and
BPM-based playlist generation are impossible. Do not design features assuming
audio analysis.

**February 2026 Development Mode changes:** Premium requirement, limited
Client IDs, five authorised users, a reduced endpoint allowlist, search capped
at ten results, and refresh tokens expiring six months after authorisation.
Artist popularity and follower counts are among the restricted fields, so
Spotify is not a usable popularity source. Last.fm is, and has no comparable
restriction.

**Verify playlist creation and modification are still in the Development Mode
allowlist before building export.** It is the one Spotify capability this
project genuinely depends on.

Used for: fetching albums by ID, creating and updating playlists, uploading
playlist art. Nothing else. Not a catalogue identifier, not a popularity
source.

Push updates the existing `spotify_playlist_id` in place.

**Market availability:** a track unavailable in Ireland will silently drop out
of a pushed playlist. Check the response against what was sent and surface any
missing tracks rather than letting the playlist quietly differ from the
preview.

**Token expiry:** the UI surfaces time remaining and offers re-authorisation
before expiry rather than failing silently mid-push.

---

## 7. The rating queue

The feature that keeps the database alive. Without it, unrated music
accumulates and the system decays into a catalogue nobody adds to.

Built as an inbox, one item at a time, not a list. An undifferentiated pile of
four hundred unrated albums is as useless as no page at all, so **ordering is
the feature**.

Priority, highest first (current preference, expect to tune):

1. albums by artists already rated highly
2. high play count with no rating
3. gut-rated 8 or above with no detailed breakdown — the second tier, records
   believed excellent but not yet examined
4. recently added
5. albums with some tracks rated but no album rating

Each item offers a skip, which deprioritises rather than hides.

**Spotify handoff.** Each item links to `open.spotify.com/album/...`, which
opens in the app on mobile. Autoplay from a link is not possible without the
Web Playback SDK, an active device and Premium, so the user presses play.

The important part: **record the handoff**. When something is opened in
Spotify, note the time. On return to the site, that album is waiting at the
top for rating rather than having to be found again. That small piece of state
is what turns a page into a loop.

The queue is designed around gut scores. Entering one should take about two
seconds and be possible with a thumb.

**Web Playback SDK** is available given Premium and would let the queue play a
track in-page without leaving the site. Desktop only, needs an active device,
real work. Filed under later.

---

## 8. Design direction

Deliberately underspecified. Cillian will develop this during the build and
this section should be rewritten as he does. What follows is the brief, not
the design.

**The bar.** This is a portfolio piece as much as a tool. It should look
considered and feel fast, and a technical visitor will open devtools. That
means clean semantics, no layout shift, good Lighthouse scores, and real
keyboard navigation. Those are not polish; they are the demonstration.

**Dark by default, both modes supported.** Define everything as CSS custom
properties from the start and the second mode costs almost nothing. The light
mode should be designed on its own terms rather than being an inversion, which
never works for an interface whose identity is built on darkness.

**Reference point is Spotify, with its mistakes corrected.** Worth borrowing:
surface hierarchy in dark mode, large album art as the primary visual anchor,
bottom navigation on mobile. Worth fixing: grey-on-grey secondary text that
fails contrast outright, inconsistent navigation depth where it becomes
unclear how you arrived somewhere, and affordances that only appear on hover
and therefore do not exist on a phone.

**Mobile first.** The phone is the primary device. Rating happens on a phone,
voice queries happen on a phone. Minimum 44px touch targets, which is easy to
get wrong on filter chips that look fine on a laptop. Design mobile and let it
expand; the reverse rarely convinces.

**Album art is the material.** It is the only imagery in the system and it
should carry the visual weight. Always build `srcset` from stored derivatives
rather than serving full-resolution images to phones.

**The genre tree page** is worth building early, even though it is not load
bearing. A D3 hierarchy reading from the genre table, with each node sized by
how many tracks sit in that genre. That turns a taxonomy into a portrait of
actual listening, with mass where taste concentrates. Dragging to reparent is
a far better way to reorganise a tree than a form. Genre evolution over time
is a separate visualisation, not the same one.

**Weights page.** Editing weights and watching the ranking reorder live is
half the point of versioned weights, and it is the most persuasive
demonstration in the whole site of why composites are computed rather than
stored.

---

## 9. Routes

**Public**

```
/                         overview
/artist/[id]
/album/[id]
/track/[id]
/genres                   the tree, nodes sized by library count
/playlists
/playlist/[id]
/search                   plain text search
/colophon                 how it is built
```

**Access-protected**

```
/query                    natural language and filter builder
/edit/rate/[type]/[id]
/edit/queue               rating inbox
/edit/import
/edit/review              anomaly queue
/edit/jobs
/edit/weights
/edit/holdings
```

**API**

```
POST /api/query                   protected, read-only
GET  /api/definition/[id]/run     public, read-only
POST /api/write/rating            protected
POST /api/write/definition        protected
POST /api/write/import            protected
POST /api/write/merge             protected
POST /api/write/spotify/push      protected
POST /api/cron/jobs               cron trigger
POST /api/cron/backup             cron trigger
```

---

## 10. Backups

Daily cron. Dumps every table to JSON, not SQL, so it stays readable if the
stack ever changes. Writes to R2 with rolling retention, and commits a copy to
a private GitHub repo, which gives version history free and puts a copy
outside Cloudflare entirely. The local copy is a `git pull`.

Three locations, two existing credentials.

Every other piece of data in this system can be refetched. The ratings cannot.
**Test a restore once, early.** A backup never restored from is a hypothesis.

---

## 11. Build order

Vertical slice before any breadth. Every assumption in this document gets
tested by the first five steps, and the ones that are wrong are cheap to fix
at that point.

1. Schema and migrations
2. Import one album from MusicBrainz end to end
3. Rate one track on it
4. Write a definition by hand that selects it
5. Compile, run, push to Spotify

Only then:

6. Import ladder — Spotify URL, local tags, manual form
7. Rating queue
8. Definition builder UI with filter chips
9. Natural language and voice
10. Genre tree and derivation
11. Review queue and merge
12. Backups
13. Spotify history import
14. Physical collection and file catalogue
15. Playlist art generation

Building a beautiful rating interface before the Spotify export is proven is
how this ends up as a lovely front end onto a dead end.

---

## 12. Structural commitments

The decisions that are expensive to reverse. Everything else in this document
is a starting position.

- **Local UUIDs as primary keys**, external IDs nullable. Nothing depends on
  existing in an external database.
- **Five-layer catalogue model** — work, recording, track, release, release
  group. Album ratings on release groups, track ratings on recordings.
- **Ratings are append-only** and timestamped.
- **Composite scores are computed, never stored.**
- **Every date carries a precision flag.**
- **`user_id` on every rating row** from day one, even while there is one
  user. Retrofitting it later is miserable.
- **Overrides live in their own table**; imports fill nulls and never
  overwrite them.
- **The compiler emits `SELECT` only** and has no write path. Model output is
  validated before it reaches the database. No raw-SQL fallback.
- **One compiler, three callers.** Query, saved definition, Spotify push.
- **Merges reparent and redirect.** Nothing is deleted.
- **Grouping and top-N-per-group** are in the definition format from the
  start.
- **No audio is hosted, served, or fetched from a streaming service.**
