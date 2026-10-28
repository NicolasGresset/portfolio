# Notes for Claude Code sessions

Personal site gresset-bourgeois.fr. GitHub `NicolasGresset/portfolio` (public), deployed by Vercel from `main`.
This file is excluded from the deployment (`.vercelignore`) but versioned on GitHub.

## Working rules

- UI text in French; code, names, comments, logs and docs in English. PEP8 for any Python.
- Never hard-code or commit keys; never print secret values (redact `.env`).
- List methodological choices (scoring, candidates, time handling, data sources, new external
  services) with trade-offs and ask before coding them. The user likes to measure and test before deciding.
- Commit often on `main`; **push only when the user asks** (each push triggers a Vercel deploy).
- Keep `docs/location-pipeline.md` (Mermaid diagrams, API calls, data sources) up to date with every
  change to the location tool.
- Keep API usage conservative.

## Site layout

- Vanilla HTML/CSS/JS, no build step. Pages at the root (`index.html`, `location.html`, `sport.html`, …),
  shared navigation in `js/nav.js`, styles in `css/style.css`.
- `api/*.js`: Vercel serverless functions for the sport and cinema pages only (keys in Vercel env, see `.env.example`).
- Local dev: `node --env-file=.env scripts/dev-server.js`.
- `docs/` and `scripts/` are not deployed.

## Location tool (`location.html`, `js/location/`)

Finds the meeting place minimizing the group's total travel time for an arrival within a 15 min slot,
Toulouse area. Fully client-side; the user's own openrouteservice key is stored in localStorage only.
Full pipeline: `docs/location-pipeline.md`.

- `main.js` UI, `engine.js` candidates and scoring, `ors.js` openrouteservice (matrix 50/day,
  directions 200/day), `transitous.js` public transport (Transitous `/plan`, max 3 parallel calls,
  > 720 calls / 24 h needs coordination), `keys.js` localStorage.
- Address search: local instant lookup in `data/pois-toulouse.json` (≥ 2 chars), then IGN Géoplateforme
  completion (≥ 3 chars, Haute-Garonne, addresses and IGN points of interest, no companies).
- `data/pois-toulouse.json`: bars and restaurants (OSM, Geofabrik Midi-Pyrénées extract + osmium),
  metro and bus stops (Tisséo GTFS), addresses precomputed with the Géoplateforme bulk reverse geocoder.
  Bounding box in `data/tisseo-area.json`. `scripts/fetch-pois.js` regenerates places, not addresses yet.
- `data.places` (search only, never candidates): ~13,800 named OSM offices, shops, crafts and kept amenities
  with a French type label and aliases (`short_name`…), built by `scripts/build-search-places.js` from an
  osmium export (commands in its header). File: 2.3 MB raw, ~318 KB brotli, loaded on first address focus.
- Declined by the user: Photon, a service worker, Tisséo API (key refused), Strasbourg/CTS.

## Open topics (update when they move)

- Local search ranking and matching (proposed 2026-10-28, waiting for the user's choice): index type label and city words, exact-word bonus, prefix index,
  proximity ranking, typo tolerance. A sorted word index would cut a search from ~0.6 ms to
  ~0.01 ms (0.3 ms for 1-letter queries), 22 ms to build: measured, not needed yet.
- Data quality found 2026-10-28 (not fixed yet): 31 search places have an OSM street but an empty
  postcode and city (`"3A Cours Rose Dieng-Kuntz,  "`); OSM cities are not normalized (`TOULOUSE`,
  `Toulouse CEDEX 4`); the address source (OSM or BAN) is not stored; `old_name` aliases may name a
  previous business at the same place.
- Transitous is the slow step: (A) cache and pruning, or (C) local Connection Scan Algorithm on Tisséo
  GTFS (~2.6 MB/day of connections, estimated 600–900 lines). Waiting for the user's decision.
