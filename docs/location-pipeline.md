# Location — processing pipeline

How the meeting point finder (`location.html`, `js/location/`) turns participants into a
chosen place. Everything runs in the browser: Vercel only serves static files, and the
only key (openrouteservice) is the user's own, kept in `localStorage`.

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
        OSMIUM["osmium: Tisséo area bbox,<br/>named bars and restaurants"]:::algo
        OSMPLACES["scripts/build-search-places.js:<br/>named offices, shops, crafts, kept amenities;<br/>same name within 300 m merged;<br/>French type label, short / former names"]:::algo
        GTFS[("Tisséo GTFS<br/>data.toulouse-metropole.fr")]:::api
        STOPS["scripts/fetch-pois.js:<br/>stop areas, metro if a metro line stops,<br/>else bus; tram / cable car only dropped"]:::algo
        REVCSV[("IGN Géoplateforme<br/>reverse/csv, bulk")]:::api
        ADDR["address of every place (search places:<br/>OSM address when it has a street),<br/>'près de' beyond 30 m"]:::algo
        GEOFABRIK --> OSMIUM
        GEOFABRIK --> OSMPLACES
        OSMPLACES --> REVCSV
        GTFS --> STOPS
        OSMIUM --> MERGE["merge + dedupe"]
        STOPS --> MERGE
        MERGE --> REVCSV --> ADDR
    end

    ADDR --> DATA[("data/pois-toulouse.json<br/>pois: candidates (bars, restaurants, metro, bus)<br/>places: search only (~13,800 companies, shops…)<br/>name, position, address")]:::local

    subgraph BROWSER["In the browser (js/location/)"]
        direction TB
        KEY[("ORS key<br/>localStorage")]:::user
        INPUT["Participants (1 to 5): position + modes<br/>Arrival slot (15 min, today, Europe/Paris)<br/>Place types: stations / bars / restaurants"]:::user
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
    TYPE -->|">= 2 chars, instant"| LOCAL["Local name search<br/>accents / case ignored,<br/>each word typed starts a word of the name<br/>or of a short / former name,<br/>st / av / bd... abbreviations;<br/>linear scan, ~1 ms for 17,000 entries"]:::algo
    LOCAL --> JSON[("pois-toulouse.json<br/>loaded on first focus")]:::local
    LOCAL --> RANK["Rank: name starts with query,<br/>then metro > bar, restaurant, other place > bus,<br/>then shortest name; max 5"]:::algo
    TYPE -->|">= 3 chars, 250 ms debounce"| COMPLETION[("Géoplateforme completion<br/>addresses + IGN points of interest,<br/>Haute-Garonne only, max 6")]:::api
    RANK --> LIST["Suggestions:<br/>local places first, then addresses"]
    COMPLETION --> LIST
    LIST -->|"choice"| POS["Position recorded,<br/>participant folded"]:::user

    GEO["'ma position actuelle'"]:::user --> BROWSERGEO["Browser geolocation"]
    BROWSERGEO -->|"at once"| POS
    BROWSERGEO -->|"then"| REVERSE[("Géoplateforme reverse<br/>1 call, label only")]:::api
    REVERSE -.->|"address shown when it arrives"| POS
```

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
        R1["Haversine distance to the barycenter,<br/>dedupe same kind + name"]:::algo
        R2["Radius 1 km, + 500 m while fewer than 3 candidates,<br/>up to 5 km"]:::algo
        R3["Quota per type (maximums):<br/>1 type: 8 · 2 types: 4 each ·<br/>3 types: 3 stations, 3 bars, 2 restaurants"]:::algo
        R4["Stations: half the quota (rounded up)<br/>to the metro first, closest stops fill the rest"]:::algo
        R1 --> R2 --> R3 --> R4
    end
    CAND --> CANDIDATES

    CANDIDATES --> TIMES["Travel times<br/>every participant x candidate x mode"]

    subgraph STREET["Walk, bike, car"]
        MATRIX[("openrouteservice matrix<br/>1 call per mode used (max 3)<br/>no time of day, no traffic")]:::api
        PARK["car: + 5 min to park"]:::algo
        MATRIX --> PARK
    end

    subgraph TRANSIT["Transit"]
        PLAN[("Transitous /api/v6/plan<br/>1 call per transit participant x candidate,<br/>3 at a time")]:::api
        WINDOW["arriveBy = end of slot;<br/>keep journeys arriving within the slot,<br/>the latest departure wins;<br/>time = journey only, walking included"]:::algo
        PLAN --> WINDOW
    end

    TIMES --> STREET
    TIMES --> TRANSIT
    PARK --> SCORE
    WINDOW --> SCORE

    SCORE["Each participant: fastest available mode<br/>Score = sum over participants<br/>(candidate unreachable by one participant: excluded)"]:::algo
    SCORE --> BEST["Chosen place = lowest score"]:::algo

    BEST --> ROUTES["Paths to the chosen place"]
    ROUTES --> DIRECTIONS[("openrouteservice directions<br/>1 call per walk / bike / car participant")]:::api
    ROUTES --> LEGS["Transit: legs of the Transitous journey<br/>already fetched (lines, direction, stops)"]:::local

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
    participant TR as Transitous

    U->>B: Trouver le lieu
    B->>J: candidates around the barycenter (local, no call)
    J-->>B: C places
    par street modes
        B->>ORS: matrix x M (P x C durations each)
        ORS-->>B: durations + quota left
    and transit
        loop T x C journeys, 3 at a time
            B->>TR: plan (arrive by end of slot)
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
| Géoplateforme completion | 1 per pause while typing (≥ 3 chars) | none stated |
| Géoplateforme reverse | 1 per "ma position actuelle" | none stated |
| Local data | 0 (one static file, loaded once) | — |

## 5. Data sources and licences

| Data | Source | Licence / policy |
|---|---|---|
| Bars, restaurants | OpenStreetMap via Geofabrik, extract of 2026-10-26 | ODbL |
| Search-only places (companies, shops, schools…) | OpenStreetMap via Geofabrik, extract of 2026-10-28 | ODbL |
| Metro stations, bus stops | Tisséo GTFS, 2026-10-27 | ODbL |
| Place addresses | IGN Géoplateforme (Base Adresse Nationale), 2026-10-27 and 2026-10-28 (search places) | Licence Ouverte |
| Transit journeys | Transitous (networks' open GTFS) | open-source, non-commercial, light use |
| Walk, bike, car | openrouteservice | free plan, user's own key |
| Map tiles | OpenStreetMap | tile usage policy |
