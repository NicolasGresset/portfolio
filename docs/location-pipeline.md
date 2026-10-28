# Location — processing pipeline

How the meeting point finder (`rendez-vous.html`, page called "Rendez-vous"; code in `js/location/`) turns participants into a
chosen place. Everything runs in the browser: Vercel only serves static files, and the
keys (openrouteservice, required; Tisséo, optional) are the user's own, kept in `localStorage`.

The diagrams are [Mermaid](https://mermaid.js.org/) code: GitHub renders them, and any
Mermaid editor (e.g. https://mermaid.live) can display or export them.

Legend used in the diagrams:

- **blue**: external API call (network, counted in the page's "Appels API" panel)
- **green**: local data (`data/pois-toulouse.json`, served with the site, no API call)
- **orange**: algorithm choice
- **grey**: browser storage or user input

## 1. Overview

```mermaid
flowchart TB
    classDef api fill:#DBEAFE,stroke:#2563EB,color:#0C1A2E
    classDef local fill:#DCFCE7,stroke:#15803D,color:#0C1A2E
    classDef algo fill:#FFEDD5,stroke:#EA580C,color:#0C1A2E
    classDef user fill:#F1F5F9,stroke:#7A90AA,color:#0C1A2E

    subgraph OFFLINE["Offline, run by hand (not deployed)"]
        direction TB
        GEOFABRIK[("Geofabrik<br/>OSM extract Midi-Pyrénées")]:::api
        OSMIUM["osmium: Tisséo area bbox,<br/>amenity / office / shop / craft features"]:::algo
        OSMPLACES["scripts/build-places.js:<br/>named features with a kept category (§ 6);<br/>same category + name within 300 m merged;<br/>short / former names as aliases"]:::algo
        GTFS[("Tisséo GTFS<br/>data.toulouse-metropole.fr")]:::api
        STOPS["scripts/build-places.js:<br/>stop areas, metro if a metro line stops,<br/>else bus; tram / cable car only dropped"]:::algo
        REVCSV[("IGN Géoplateforme<br/>reverse/csv, bulk")]:::api
        ADDR["address of every place: OSM address<br/>when it has a street, else nearest BAN address,<br/>'près de' beyond 30 m"]:::algo
        GEOFABRIK --> OSMIUM --> OSMPLACES
        GTFS --> STOPS
        OSMPLACES --> MERGE["one list"]
        STOPS --> MERGE
        MERGE --> REVCSV --> ADDR
    end

    ADDR --> DATA[("data/pois-toulouse.json<br/>~17,500 places, one category each,<br/>candidates: bars, restaurants, metro, bus<br/>name, position, address")]:::local

    subgraph BROWSER["In the browser (js/location/)"]
        direction TB
        KEY[("ORS key<br/>localStorage")]:::user
        INPUT["Participants (1 to 5): position + modes<br/>(walk and transit checked by default)<br/>Arrival slot (15 min, today, Europe/Paris)<br/>Place types: stations / bars / restaurants"]:::user
        SEARCH["2. Address search"]
        ENGINE["3. Computation (engine.js)"]
        RESULT["4. Result: chosen place,<br/>trip details, map paths"]
        INPUT --> SEARCH --> ENGINE --> RESULT
        KEY --> ENGINE
    end

    DATA --> SEARCH
    DATA --> ENGINE
```

## 2. Address search (main.js)

```mermaid
flowchart LR
    classDef api fill:#DBEAFE,stroke:#2563EB,color:#0C1A2E
    classDef local fill:#DCFCE7,stroke:#15803D,color:#0C1A2E
    classDef algo fill:#FFEDD5,stroke:#EA580C,color:#0C1A2E
    classDef user fill:#F1F5F9,stroke:#7A90AA,color:#0C1A2E

    TYPE["User types<br/>in an address field"]:::user
    TYPE -->|">= 2 chars, instant"| LOCAL["Local search: typed words<br/>(accents / case ignored, split on apostrophes)<br/>against name, aliases, former names,<br/>category label + synonyms, city;<br/>stop words optional, every other word required;<br/>sorted word index: only the places of the<br/>most selective word are scored (all if it<br/>matches > 25 %), ~0.4 ms on a PC"]:::algo
    LOCAL --> JSON[("pois-toulouse.json<br/>loaded once the page is shown; words per field<br/>and sorted word index built then, ~16 ms")]:::local
    LOCAL --> RANK["Rank: score rounded down,<br/>then distance to the located participants<br/>(Capitole if none), then metro > others > bus,<br/>then shortest name; max 5"]:::algo
    TYPE -->|">= 3 chars, 250 ms debounce"| COMPLETION[("Géoplateforme completion<br/>addresses + IGN points of interest,<br/>Haute-Garonne only, max 6")]:::api
    RANK --> LIST["Suggestions:<br/>local places first, then addresses"]
    COMPLETION --> LIST
    LIST -->|"choice"| POS["Position recorded,<br/>participant folded"]:::user

    GEO["'ma position actuelle'"]:::user --> BROWSERGEO["Browser geolocation"]
    BROWSERGEO -->|"at once"| POS
    BROWSERGEO -->|"then"| REVERSE[("Géoplateforme reverse<br/>1 call, label only")]:::api
    REVERSE -.->|"address shown when it arrives"| POS
```

Score of a place (constants at the top of the search section of `main.js`, starting values to tune):

- each typed word keeps its best match over all fields: quality × field weight;
- quality: whole word 3 (also for an abbreviation: `st` = `saint`), start of a word 2;
- weight: name 1, alias 0.8, category label or synonym 0.6, city 0.6, former name 0.3;
- + 2 when the name starts with the whole query, + 1 when every required word matches in the name;
- stop words (le, la, les, l, de, du, des, d, au, aux) add their match but may match nothing,
  unless the query has only stop words.

Sorted word index: every distinct word of every field (~11,300) with the places that have it,
built in the browser right after the data file. Shipping it precomputed would add ~100 KB
(brotli) to download, slower than building it below ~16 Mbit/s. A typed word finds its places by
binary search; only the places of the most selective required word are scored. Same results as
a scan of every place (checked on 830 queries); ~0.4 ms per keystroke on average on a PC instead
of ~3 ms, and never slower: a very common prefix (one letter, "to" for Toulouse) falls back to the scan.

## 3. Computation (engine.js)

```mermaid
flowchart TB
    classDef api fill:#DBEAFE,stroke:#2563EB,color:#0C1A2E
    classDef local fill:#DCFCE7,stroke:#15803D,color:#0C1A2E
    classDef algo fill:#FFEDD5,stroke:#EA580C,color:#0C1A2E

    START(["Participants, slot, place types"]) --> CENTER["Barycenter<br/>plain mean of latitudes and longitudes"]:::algo
    CENTER --> CAND["Candidates"]:::algo
    DATA[("pois-toulouse.json")]:::local --> CAND

    subgraph CANDIDATES["Candidate selection (no API call)"]
        direction TB
        R0["Only the candidate categories:<br/>amenity=bar, amenity=restaurant, metro, bus"]:::algo
        R1["Haversine distance to the barycenter,<br/>dedupe same category + name"]:::algo
        R2["Radius 1 km, + 500 m while fewer than 3 candidates,<br/>up to 5 km"]:::algo
        R3["Quota per type (maximums):<br/>1 type: 8 · 2 types: 4 each ·<br/>3 types: 3 stations, 3 bars, 2 restaurants"]:::algo
        R4["Stations: half the quota (rounded up)<br/>to the metro first, closest stops fill the rest"]:::algo
        R0 --> R1 --> R2 --> R3 --> R4
    end
    CAND --> CANDIDATES

    CANDIDATES --> TIMES["Travel times<br/>every participant x candidate x mode"]

    subgraph STREET["Walk, bike, car"]
        MATRIX[("openrouteservice matrix<br/>1 call per mode used (max 3)<br/>no time of day, no traffic")]:::api
        PARK["car: + 5 min to park"]:::algo
        MATRIX --> PARK
    end

    subgraph TRANSIT["Transit (engine picked in the page)"]
        PLAN[("Transitous /api/v6/plan (default)<br/>1 call per transit participant x candidate,<br/>3 at a time; arriveBy = end of slot")]:::api
        TISSEO[("Tisséo /v2/journeys.xml (user's key)<br/>2 calls per participant x candidate, 6 at a time:<br/>4 journeys leaving 1 h before the end of the slot,<br/>then 4 leaving (shortest travel time + 10 min) before it")]:::api
        WINDOW["keep journeys arriving by the end of the slot;<br/>time = journey + wait until the slot starts<br/>when arriving early (walking included);<br/>shortest time wins, then latest departure"]:::algo
        RETRY["technical failure: 1 retry after 2 s;<br/>failing twice = journey failed,<br/>its candidate is 'incomplete'"]:::algo
        WINDOW --- RETRY
        PLAN --> WINDOW
        TISSEO --> WINDOW
    end

    TIMES --> STREET
    TIMES --> TRANSIT
    PARK --> SCORE
    WINDOW --> SCORE

    SCORE["Each participant: fastest available mode<br/>Score = sum over participants<br/>(candidate unreachable by one participant: excluded)"]:::algo
    SCORE --> BEST["Chosen place = lowest score among complete candidates<br/>(incomplete ones only if no complete one is reachable);<br/>failures shown in the progress, the list and the trip cards"]:::algo

    BEST --> ROUTES["Paths to the chosen place"]
    ROUTES --> DIRECTIONS[("openrouteservice directions<br/>1 call per walk / bike / car participant")]:::api
    ROUTES --> LEGS["Transit: legs of the journey already fetched<br/>(lines, direction; stops count with Transitous only)"]:::local

    BEST -.->|"user picks another place<br/>(list or map)"| OTHER["Same details for that place:<br/>transit legs kept, ORS directions<br/>fetched once per place shown"]:::algo
```

## 4. API calls of one computation

With `P` participants (at most 5), `C` candidates (at most 8), `M` street modes used by
someone (at most 3) and `T` participants who may take transit:

```mermaid
sequenceDiagram
    autonumber
    participant U as User
    participant B as Browser (engine.js)
    participant J as pois-toulouse.json
    participant ORS as openrouteservice
    participant TR as Transitous or Tisséo

    U->>B: Trouver le lieu
    B->>J: candidates around the barycenter (local, no call)
    J-->>B: C places
    par street modes
        B->>ORS: matrix x M (P x C durations each)
        ORS-->>B: durations + quota left
    and transit
        loop T x C journeys, 3 at a time (Tisséo: 6, 2 calls each)
            B->>TR: journeys arriving by the end of the slot
            TR-->>B: itineraries
        end
    end
    Note over B: score = sum of each participant's fastest time<br/>chosen place = lowest score
    B-->>U: chosen place + trip details
    loop each walk / bike / car participant
        B->>ORS: directions (path to the chosen place)
        ORS-->>B: path
    end
    B-->>U: paths on the map
    opt user picks another place
        B->>ORS: directions, once per place shown
    end
```

| Service | Calls per computation | Limit |
|---|---|---|
| openrouteservice matrix | `M` ≤ 3 | 50 / day (free plan) |
| openrouteservice directions | ≤ `P` for the chosen place, + ≤ `P` per other place shown | 200 / day (free plan) |
| Transitous plan | `T` × `C` ≤ 40 | > 720 / 24 h: coordinate with Transitous |
| Tisséo journeys (instead of Transitous) | 2 × `T` × `C` ≤ 80 | per key, monitored by Tisséo; paid beyond thresholds if they ever set some |
| Géoplateforme completion | 1 per pause while typing (≥ 3 chars) | none stated |
| Géoplateforme reverse | 1 per "ma position actuelle" | none stated |
| Local data | 0 (one static file, loaded once) | — |

Tisséo API notes (checked 2026-10-28): CORS headers only on XML answers (none on JSON), hence
`journeys.xml` read with `DOMParser`; a refused key answers 403 without CORS headers, so the
browser only sees a network error; no arrival-time search, hence the two calls; Tisséo network
only (no TER, no liO coaches); it gives no count of stops travelled.

## 5. Data sources and licences

| Data | Source | Licence / policy |
|---|---|---|
| Bars, restaurants, companies, shops, schools… | OpenStreetMap via Geofabrik, data of 2026-10-27 | ODbL |
| Metro stations, bus stops | Tisséo GTFS, 2026-10-28 | ODbL |
| Place addresses | OpenStreetMap, else IGN Géoplateforme (Base Adresse Nationale), 2026-10-28 | ODbL / Licence Ouverte |
| Transit journeys | Transitous (networks' open GTFS) | open-source, non-commercial, light use |
| Transit journeys (optional) | Tisséo API v2, with the visitor's own key | ODbL; a key in a web page is accepted by Tisséo (developer documentation § 2.7) |
| Walk, bike, car | openrouteservice | free plan, user's own key |
| Map tiles | OpenStreetMap | tile usage policy |

## 6. Place categories

To rebuild the file from scratch (OSM download, osmium, Tisséo GTFS, addresses, every
post-processing step below): `scripts/regenerate-places.sh` (needs curl, osmium-tool, node,
unzip; `--pbf` reuses an extract already downloaded). About 30 s plus the ~360 MB download.

Every place of `data/pois-toulouse.json` has exactly one `category` code; the French label of
each code is in the file's `categories` table. The code depends on where the place comes from
(`scripts/build-places.js`, "CATEGORY RULES"):

| Source | How the code is set | Examples |
|---|---|---|
| Tisséo GTFS stop area | `metro` if at least one metro trip stops at one of its stop points, else `bus` if a bus trip does; stop areas served only by tram or cable car are left out | `metro`, `bus` |
| OpenStreetMap feature with a `name` | the first tag present among `amenity`, `office`, `shop`, `craft` (in this order) that is kept, written `key=value` | `amenity=bar`, `office=company`, `shop=bakery` |

OSM tags kept:

- `amenity`: only a listed set of values people look for by name (bar, restaurant, school,
  pharmacy, bank, café, town hall, cinema…); benches, lockers, chargers… are dropped, and the
  next key is tried.
- `office`, `shop`, `craft`: every value except `shop=vacant`.

Labels: a listed code gets its own label (`office=company` → "entreprise"); an unlisted
`office`, `shop` or `craft` value gets the key's label ("bureau", "commerce", "artisan").
The code always keeps the precise OSM tag, so a label can be refined later without
regenerating the file's codes.

Candidates: the engine only picks `amenity=bar`, `amenity=restaurant`, `metro` and `bus`
places (`CATEGORIES` in `engine.js`); every other place is for the address search only. Only
candidates keep their OSM or GTFS `id` (the engine keys its route cache with it); the ids of
the other places would weigh a quarter of the file.

Duplicates: within one source, the same name (accents and case ignored) closer than 300 m is
one place, whatever its categories: it takes the category first in the order bar, restaurant,
metro, bus, other amenities, office, shop, craft, and the position and address of its best
described feature (an address, then a node rather than a building). An OSM `amenity=bus_station`
named like a Tisséo stop area within 300 m is that stop area and is dropped. Other OSM places
named like a nearby stop (a school, a church, a clinic) stay apart: the stop is named after them.

Fields (generation normalizes them, the browser only reads them):

| Field | Presence | Content |
|---|---|---|
| `id` | candidates only | OSM `node/…`, `way/…`, `relation/…` or Tisséo `stop_area:…` |
| `category` | always | code, see above |
| `name` | always | as written in OSM or the GTFS, trimmed only (capitals are often real acronyms) |
| `lat`, `lon` | always | node, mean of a building's outer ring, or stop area position; 5 decimals |
| `street` | ~17,200 | house number and street, street type capitalized |
| `postcode`, `city` | all but 2 | commune in its BAN spelling, without CEDEX; CEDEX or missing OSM postcodes replaced by the BAN one |
| `addrSrc` | with an address | `osm`: the place's own OSM street; `ban`: the nearest BAN address (bulk reverse geocoder), or, when none is found, only the postcode and city of the nearest one within 500 m (no street) |
| `near` | some `ban` | the BAN address is more than 30 m away ("près de") |
| `aliases` | ~700 | OSM `short_name`, `alt_name`, `official_name` (split on `;`) |
| `oldNames` | ~140 | OSM `old_name`, kept apart: it sometimes names the previous business at the address |
