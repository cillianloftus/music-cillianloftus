# music-cillianloftus

Personal music rating and playlist tool for Cillian Loftus. Rate tracks and
albums across several axes, derive composite scores, generate Spotify
playlists from saved queries. Single primary user plus up to four friends.
Deployed at music.cillianloftus.com.

Also a portfolio piece, so code quality, semantics, accessibility and
performance matter as much as the result.

## Read this first

**`ARCHITECTURE.md` is the full spec.** Read it before writing anything
non-trivial: data model, query layer, import ladder, Spotify constraints,
rating model, build order.

That document is a snapshot of intent, not a contract. Cillian will change
his mind. When a decision turns out wrong, change it and update the document
rather than working around it. Its *Structural commitments* section lists the
decisions that are expensive to reverse; push back before changing those.
Everything else is a starting position.

If the document and Cillian disagree in a session, Cillian wins.

## Stack

- Astro 5/6, Cloudflare adapter, `output: 'server'`, TypeScript strict
- Cloudflare Workers, deployed on push to `main`
- D1 (`env.DB`), KV (`env.CACHE`), R2 (`env.ASSET_STORE`), Workers AI (`env.AI`)
- Bindings are reached with `import { env } from 'cloudflare:workers'`
- Plain modern CSS, scoped per component. No Tailwind.

## Commands

```
npm run dev                                          local worker + bindings
npx wrangler d1 migrations apply music-db --local    apply schema locally
npx wrangler d1 migrations apply music-db --remote    apply to production
npx wrangler types                                   regenerate binding types
```

Always migrate `--local` first. Re-run `wrangler types` after any binding
change.

## Current state

Fresh scaffold. Working through the build order in `ARCHITECTURE.md` §11.

Next: the initial D1 migration (catalogue, credits, genre, rating tables).

## Conventions

- Composite scores are computed in SQL views, never stored as columns.
- Ratings are append-only and timestamped. Never update a rating in place.
- The query compiler emits `SELECT` only and has no write path.
- Imports fill nulls and never overwrite rows in `field_override`.
- Every date column is paired with a `date_precision` column.
- Dark mode by default, both modes supported, mobile first.
- No audio is hosted, served, or fetched from a streaming service.
