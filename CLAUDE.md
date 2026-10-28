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

- Vanilla HTML/CSS/JS, no build step. Pages at the root (`index.html`, `rendez-vous.html`, `sport.html`, …),
  shared navigation in `js/nav.js`, styles in `css/style.css`.
- `api/*.js`: Vercel serverless functions for the sport and cinema pages only (keys in Vercel env, see `.env.example`).
- Local dev: `node --env-file=.env scripts/dev-server.js`.
- `docs/` and `scripts/` are not deployed.

## Rendez-vous tool (`rendez-vous.html`, `js/location/`)

Renamed from "Location" on 2026-10-28; code, CSS classes and docs keep the `location` name, and
`location.html` only redirects to the new page (old links).

Finds the meeting place minimizing the group's total travel time for an arrival within a 15 min slot,
Toulouse area. Fully client-side; the user's own openrouteservice key is stored in localStorage only.
Full pipeline: `docs/location-pipeline.md`.

- `main.js` UI, `engine.js` candidates and scoring, `ors.js` openrouteservice (matrix 50/day,
  directions 200/day), `transitous.js` public transport (Transitous `/plan`, max 3 parallel calls,
  > 720 calls / 24 h needs coordination), `keys.js` localStorage.
- Address search: local instant lookup in `data/pois-toulouse.json` (≥ 2 chars), then IGN Géoplateforme
  completion (≥ 3 chars, Haute-Garonne, addresses and IGN points of interest, no companies).
- `data/pois-toulouse.json`: one list `places` (~17,400) with one `category` code each (OSM `key=value`
  such as `amenity=bar`, `office=company`, or GTFS `metro` / `bus`) and a `categories` label table.
  Candidates: `amenity=bar`, `amenity=restaurant`, `metro`, `bus` (only they keep an `id`); the rest is
  for the address search. Address split into street / postcode / city (normalized at generation),
  `addrSrc`, `near`; `aliases` and `oldNames` apart. Same name within 300 m = one place (bar > restaurant
  > …). Rules and fields: `docs/location-pipeline.md` § 6. Rebuilt from scratch by
  `scripts/regenerate-places.sh` (download + osmium + `scripts/build-places.js`; output reproducible). ~3.1 MB raw, ~325 KB brotli, loaded once the page is shown (window load).
- Local search: scored over name, aliases, oldNames, category label + synonyms, city; weights and bonuses
  are constants in `main.js` (`SEARCH_WEIGHTS`…), doc § 2. Sorted word index built in the browser after
  loading (~16 ms), ~0.4 ms per keystroke on a PC (scan fallback for very common prefixes).
- Declined by the user: Photon, a service worker, Tisséo API (key refused), Strasbourg/CTS.

## Open topics (update when they move)

- Local search: scoring implemented 2026-10-28 with starting weights; the user tunes them after testing.
  Sorted index: built in the browser on purpose (shipping it: +103 KB brotli, slower below ~16 Mbit/s).
  Not yet measured on the user's phone (Galaxy A33). At equal rounded score, distance wins over
  category ("jean jau" shows a hairdresser before the metro station).
- Later, once the page's purpose is settled (personal service, demonstrator…): cache of
  openrouteservice times and paths (they do not depend on the time of day; changing the slot
  re-calls the matrix today), favourite addresses with custom names in the autocompletion.
- Local street routing measured 2026-10-28 (not decided): the OSM extract's highways in the Tisséo box
  give 199,000 graph nodes (intersections) and 268,000 edges; naive binary 4.5 MB, 1.9 MB brotli
  (without the shapes needed to draw paths); one full walking Dijkstra 77 ms on a PC. Would replace the
  openrouteservice matrix (50/day) by one Dijkstra per participant and mode.
- Possibly more candidate categories (pub, biergarten, café): one line in `CATEGORIES`, user's call.
- Transitous is the slow step: (A) cache and pruning, or (C) local Connection Scan Algorithm on Tisséo
  GTFS (~2.6 MB/day of connections, estimated 600–900 lines). Waiting for the user's decision.
