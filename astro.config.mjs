import { defineConfig } from 'astro/config';
import cloudflare from '@astrojs/cloudflare';

export default defineConfig({
  output: 'server',
  adapter: cloudflare({
    // Cover art is stored as ready-made derivatives in R2 and served as-is,
    // so no Cloudflare Images binding is needed.
    imageService: 'passthrough',
    // PERSIST_TO points local bindings at another directory, for a throwaway
    // database that tests can write to without touching real local data.
    // Astro runs one dev server per project, so stop the usual one first:
    //   npx wrangler d1 migrations apply music-db --local --persist-to <dir>
    //   PERSIST_TO=<dir> npm run dev
    persistState: process.env.PERSIST_TO ? { path: process.env.PERSIST_TO } : true,
  }),
  // Spotify only accepts loopback redirect URIs as IP literals, so the dev
  // server listens on 127.0.0.1 (browsers still resolve localhost to it).
  // Not 0.0.0.0: in development every visitor is signed in as
  // DEV_ACCESS_EMAIL, so the dev server must not be reachable from the LAN.
  // The port is fixed because other local projects hold 4321/4322 on ::1,
  // where "localhost:4321" would silently reach a different site.
  server: { host: '127.0.0.1', port: 4323 },
  // Identity comes from Cloudflare Access on every request; there is no
  // session state, so no SESSION KV namespace should be provisioned.
  session: false,
});
