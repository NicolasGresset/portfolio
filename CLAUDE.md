# Notes for Claude Code sessions

Personal site gresset-bourgeois.fr. GitHub `NicolasGresset/portfolio` (public), deployed by Vercel from `main`.
This file is excluded from the deployment (`.vercelignore`) but versioned on GitHub. So are
`projects.html` and `blog.html` (and their `data/` files) until they are written.

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
  shared navigation and footer in `js/layout.js`. Styles: `css/fonts.css` and `css/base.css` (variables,
  shared components) on every page, then the page's own file (`home`, `sport` for sport and run detail,
  `cinema`, `publications`, `rendez-vous`, `article` for legal and long-form pages).
- `api/*.js`: Vercel serverless functions for the sport and cinema pages only (keys in Vercel env, see `.env.example`).
- Local dev: `node --env-file=.env scripts/dev-server.js`; it sends `vercel.json`'s headers, and
  `CSP_REPORT=1` (or `only`, not enforced) logs Content-Security-Policy violations.
- `vercel.json`: Content-Security-Policy for every path, long cache for `assets/fonts/`. **Any new
  external service called from a page (fetch, image, script) must be added to the CSP**, and the
  third-party list of `legal.html` (English legal notice and privacy page) kept true.
- Fonts (`assets/fonts`) and Leaflet (`assets/vendor/leaflet`) are served by the site: no
  third-party request on load besides what `legal.html` lists. The site sets no cookies.
- Browser tests: headless Firefox (`/snap/bin/firefox`) against the dev server, driven through
  WebDriver BiDi by `scripts/firefox-bidi.js` (`withFirefox(async ({ send, context, evaluate,
  screenshot, errors }) => …)`: navigation, in-page scenarios, console errors, screenshots under
  `~/snap/firefox/common/shots`). Always go through it, never launch Firefox by hand: it picks a
  free port (`--remote-debugging-port 0`), uses a fresh profile it deletes, and closes with
  `browser.close`. Pitfalls it avoids (2026-10-29): the snap launcher hides Firefox's arguments, so
  `pgrep -f <profile>` never finds it and a kill hits only its shell (Firefox survives, keeps its
  port: "exit 69" on the next start, and recreates its profile after `rm`); a Bash background task
  killed by hand reports "failed, exit 143/144", which is not a Firefox failure. Startup ~9 s.
  The dev server's port 3000 is often already taken by the user's own server: reuse it.
- `docs/`, `scripts/`, `data/README.md` (sources, ODbL licence of the places file) are not deployed.

## Rendez-vous tool (`rendez-vous.html`, `js/location/`)

Renamed from "Location" on 2026-10-28; code, CSS classes and docs keep the `location` name, and
`location.html` only redirects to the new page (old links).

Proposes the 3 meeting places with the best score (group's total travel time, or mean + gap) for an arrival within a 15 min slot,
Toulouse area. Fully client-side; the user's own openrouteservice key is stored in localStorage only.
Full pipeline: `docs/location-pipeline.md`.

- `main.js` UI glue (keys, form, progress), `search.js` local address search (no DOM), `slots.js`
  arrival slot picker, `map.js` Leaflet drawing, `results.js` results HTML, `labels.js` shared labels;
  `engine.js` candidates and scoring, `ors.js` openrouteservice (matrix 50/day,
  directions 200/day), `transitous.js` public transport (Transitous `/plan`, max 3 parallel calls,
  > 720 calls / 24 h needs coordination) or `tisseo.js` (optional, visitor's key), `keys.js` localStorage.
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
  are constants in `search.js` (`SEARCH_WEIGHTS`…), doc § 2. Sorted word index built in the browser after
  loading (~16 ms), ~0.4 ms per keystroke on a PC (scan fallback for very common prefixes).
- Declined by the user: Photon, a service worker, Tisséo API (key refused), Strasbourg/CTS.

## Next big steps (stated by the user, 2026-10-28)

1. **Home server**: a second-hand machine with Debian, hosted at home behind the ISP box with a port
   opened, exposing routing services callable from anywhere. Goal: replace openrouteservice and
   Transitous (street times, transit journeys, paths), with home-made algorithms (pedagogical
   interest), and deal with deployment, caching, latency (ping to the box from outside unknown).
   Points raised: HTTPS needed (the site is HTTPS: mixed content), domain / dynamic DNS, security of an
   exposed home machine, power draw of an old server vs a mini PC, fallback when the box is down.
   It would also hold secret keys (Tisséo) and proxy APIs without CORS.
2. **Better meeting point algorithm** (the original goal; the user finds the current result
   disappointing): the plain barycenter ignores modes and is not the Fermat-Weber point (a weighted
   geometric median, Weiszfeld, weights ~ 1 / speed of each participant's mode, is easy); candidates
   within 1 km are too close to each other, so the transit calls bring little information. Ideas:
   cheap estimate over many places, then exact times for a geographically diverse short list;
   a second round around the best area; with one's own one-to-many engine (Dijkstra, CSA / RAPTOR),
   every place could be scored exactly.

Tisséo API (key obtained 2026-10-28, `TISSEO_API_KEY` in `.env` for tests only): now an optional
transit engine picked in the page (`js/location/tisseo.js`), called from the browser with the visitor's
own key like openrouteservice (Tisséo accepts public keys, doc § 2.7). CORS headers only on XML answers,
so `journeys.xml` + `DOMParser`; departure time only, so 2 calls per trip (4 journeys an hour before the
end of the slot, then 4 leaving shortest travel time + 10 min before it); 6 in parallel. Measured: 20
journeys in 2.0 s vs 27.7 s for Transitous at 3 in parallel; a full computation (2 participants, 8
stations) in 3.9 s with 32 calls. Tisséo network only (no TER / liO); no count of stops travelled.
Quotas: monitored per key, possibly paid beyond thresholds one day (doc § 2.3).

## Open topics (update when they move)

- Local search: scoring implemented 2026-10-28 with starting weights; the user tunes them after testing.
  Sorted index: built in the browser on purpose (shipping it: +103 KB brotli, slower below ~16 Mbit/s).
  Not yet measured on the user's phone (Galaxy A33). Since 2026-10-29, at equal rounded score the
  category (metro > others > bus) wins over distance ("jean jau": the metro station before a nearer
  hairdresser). Reference queries to compare rankings: `node scripts/search-queries.js [query…]`.
- Later, once the page's purpose is settled (personal service, demonstrator…): cache of
  openrouteservice times and paths (they do not depend on the time of day; changing the slot
  re-calls the matrix today), favourite addresses with custom names in the autocompletion.
- Local street routing measured 2026-10-28 (not decided): the OSM extract's highways in the Tisséo box
  give 199,000 graph nodes (intersections) and 268,000 edges; naive binary 4.5 MB, 1.9 MB brotli
  (without the shapes needed to draw paths); one full walking Dijkstra 77 ms on a PC. Would replace the
  openrouteservice matrix (50/day) by one Dijkstra per participant and mode.
- Transit robustness (2026-10-28, after a walk-instead-of-metro report from Viveris, Ramonville, not
  reproduced; most likely a failed Transitous call silently replaced by walking): 1 retry after 2 s,
  failures counted in the progress, failed candidates marked incomplete and chosen only if nothing
  complete is reachable. Arriving before the slot is accepted, the wait counted in the time.
- Placing on the map (2026-10-29): a click places the *active* participant (last card focused or
  touched, then the next one to fill; none during and after a computation), a double click only
  zooms, points draggable on computers only (the user feared it would misbehave on phones). Doc § 2.
  Not yet tried on the user's phone.
- Possibly more candidate categories (pub, biergarten, café): one line in `CATEGORIES`, user's call.
- Transitous is the slow step: (A) cache and pruning, or (C) local Connection Scan Algorithm on Tisséo
  GTFS (~2.6 MB/day of connections, estimated 600–900 lines). Waiting for the user's decision.
- Site audit 2026-10-28: done (fonts and Leaflet self-hosted, query parameters refused on api/,
  /api/activity limited to the owner's runs, any of them by id being accepted by the user, TMDB
  cached 180 days, posters 300x450, legal page, CSP, Transitous `maxItineraries=5&detailedTransfers=false`,
  measured: half the size, same best trip on 11/12 trips). Still open:
  - /api/credits accepts any TMDB id (each new one is a TMDB call): check it against /api/cinema?
  - Vercel Firewall rate limit on /api/* (dashboard, the user's call).
  - Transitous 720/24 h shared counter: deferred to the home server.
- Ideas for later (stated by the user, 2026-10-28):
  - Make sure the repository holds no dead code.
- CSS refactored 2026-10-28 (dead rules removed, 7-step font size scale `--text-2xs`…`--text-2xl`,
  color / radius variables, shared components in `base.css`, one file per page, mobile rules nested
  in their rule with native CSS nesting, so browsers from 2023 on). Checked by comparing screenshots
  and computed styles of every page, desktop and mobile, before and after each step.
- Before publishing a blog article: the drafts in `_drafts/` load KaTeX, Plotly and Google Fonts from
  CDNs and use inline scripts, all blocked by the CSP (and Google Fonts sends visitors' IPs to
  Google); `projects.html` and `blog.html` also have inline scripts. Self-host or move them to files,
  or extend the CSP, when they are written.
- Comparison with togather (meettogather.com), studied 2026-10-29: Astro + React page, Google Maps JS
  (map, Places autocomplete, key in the page), one backend call `POST api.togather.fr/compute-location`
  {venueType (free text), locations [{address, transport: walking|bicycling|transit|driving, position}]}
  -> 3 Google venues (placeId, rating) with each person's time; measured 1.0 s for 2 people. Speed most
  likely from a server-side Google matrix (all people x all venues in one request) and Places search
  (inferred from mode names, fields and error messages; the backend is not visible). Score: average
  time + gap longest-shortest, weighted equally (their page). No arrival time, share link where
  others add their start, GA4 + PostHog analytics.
- Transitous `/api/experimental/one-to-many-intermodal` (MOTIS) works: `arriveBy=true` gives many ->
  one transit durations (and transfers) for an arrival time, so one call per candidate for all
  participants (C calls instead of P x C); 4.6 s per call (2 calls measured), durations only (no legs:
  /plan still needed for the chosen place). Not used: estimated ~15 s instead of ~22 s, the real
  speed-up is the home server.
- Decided 2026-10-29 after the togather study (the user values open source and open data, no Google
  API): score picked in the settings (temps total, or moyenne + écart as togather), 3 proposals,
  links to OpenStreetMap / Google Maps and a share button (no share link to the tool itself),
  practical (default) and demonstrator views, no name field (the user may change their mind).
  Settings kept in localStorage (`location.settings`, in `legal.html`).
- Next for the Rendez-vous tool (stated by the user 2026-10-29, for a new session):
  - **Diversity of the candidates** (high on the list): the 8 candidates must be spread out (two
    bars 50 m apart were proposed); choose the method with the user first.
  - People per participant: done 2026-10-29 (doc § 1): stepper − [n] + after the modes, no upper
    bound, every person counts (weighted barycenter, total and mean over people, gap unchanged), at
    least 2 participants placed. Two variants to compare in use on the user's phone: always visible
    (default) or folded into a "1 pers." chip (`?personnes=replie`, TEMPORARY: remove the losing one,
    marked TEMPORARY in `main.js` and `rendez-vous.css`).
