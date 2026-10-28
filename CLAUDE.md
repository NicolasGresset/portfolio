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
- Do not touch the Letterboxd (cinema) and Strava/intervals.icu (sport) pages unless asked.

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
- Declined by the user: Photon, a service worker, Tisséo API (key refused), Strasbourg/CTS.

## Open topics (update when they move)

- Search for companies and shops (e.g. "CLS Ramonville" finds nothing today). Options: OSM `office=*` /
  `shop=*` in the local file (user agrees to extend the file beyond candidates; counts being measured),
  or the government "Recherche d'entreprises" API (no key, CORS OK, finds CLS with a full name).
- Transitous is the slow step: (A) cache and pruning, or (C) local Connection Scan Algorithm on Tisséo
  GTFS (~2.6 MB/day of connections, estimated 600–900 lines). Waiting for the user's decision.
