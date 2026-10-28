// build-places.js - Build data/pois-toulouse.json, every place of the location page in one list:
//   - named OpenStreetMap places: bars and restaurants (meeting point candidates), offices
//     (companies, administrations…), shops, crafts and well-known amenities (schools,
//     pharmacies, cafés…), found by the address search only;
//   - metro stations and bus stops from the Tisséo GTFS feed (candidates): stop areas, metro if
//     any metro line stops there, else bus; tram-only and cable car-only stops are left out.
// Each place has one category code (see CATEGORY RULES below and docs/location-pipeline.md),
// the engine picks its candidates by code.
//
// OSM input: an osmium export of the Tisséo area (data/tisseo-area.json), made from the
// Geofabrik Midi-Pyrénées extract:
//   curl -LO https://download.geofabrik.de/europe/france/midi-pyrenees-latest.osm.pbf
//   osmium extract -b 1.20,43.42,1.62,43.75 midi-pyrenees-latest.osm.pbf -o area.osm.pbf
//   osmium tags-filter area.osm.pbf nwr/office nwr/shop nwr/craft nwr/amenity -o tagged.osm.pbf
//   osmium export tagged.osm.pbf -f geojsonseq -u type_id --geometry-types=point,polygon -o tagged.geojsonseq
//
// Addresses: the OSM address when it has a street, completed (postcode, city) by the nearest
// address from the IGN Géoplateforme bulk reverse geocoder; otherwise that nearest address,
// "près de" beyond 30 m.
//
// Usage (needs the unzip command): node scripts/build-places.js <tagged.geojsonseq> <osm extract date>

const fs       = require('fs');
const os       = require('os');
const path     = require('path');
const readline = require('readline');
const { execFileSync, spawn } = require('child_process');
const TISSEO_AREA = require('../data/tisseo-area.json');

const OUTPUT = path.join(__dirname, '..', 'data', 'pois-toulouse.json');
const GTFS_DATASET = 'https://data.toulouse-metropole.fr/api/explore/v2.1/catalog/datasets/tisseo-gtfs/records?limit=20';
const GTFS_FILENAME = 'tisseo_gtfs_v2.zip';
const ROUTE_TYPE_METRO = '1';
const ROUTE_TYPE_BUS = '3';
const REVERSE_CSV_URL = 'https://data.geopf.fr/geocodage/reverse/csv';
const REVERSE_BATCH = 5000;
const NEAR_THRESHOLD_M = 30;
const MERGE_DISTANCE_M = 300; // same name closer than this: one place (a node and its buildings)
const ALIAS_KEYS = ['short_name', 'alt_name', 'official_name', 'old_name'];
// Meeting point candidates: the only places that keep their OSM or GTFS id (used by the engine);
// the ids of the ~15,000 other places would weigh a quarter of the file
const CANDIDATE_CATEGORIES = new Set(['amenity=bar', 'amenity=restaurant', 'metro', 'bus']);

// ---- CATEGORY RULES ----
// OSM: the category code is the first kept tag, in this key order, as "key=value"
// (amenity=bar, shop=bakery, office=company…). Amenities are kept only when listed below,
// office, shop and craft values always (but shop=vacant); an unlisted value gets its key's label.
// GTFS: "metro" or "bus".
const OSM_KEYS = ['amenity', 'office', 'shop', 'craft'];
const KEY_LABELS = { office: 'bureau', shop: 'commerce', craft: 'artisan' };
const SKIPPED = new Set(['shop=vacant']);
const LABELS = {
    'metro': 'métro', 'bus': 'arrêt de bus',
    // Amenities: only these, the others (benches, lockers, chargers…) are not looked for by name
    'amenity=bar': 'bar', 'amenity=restaurant': 'restaurant',
    'amenity=school': 'école', 'amenity=fast_food': 'restauration rapide', 'amenity=parking': 'parking',
    'amenity=bank': 'banque', 'amenity=pharmacy': 'pharmacie', 'amenity=place_of_worship': 'lieu de culte',
    'amenity=doctors': 'médecin', 'amenity=cafe': 'café', 'amenity=community_centre': 'salle municipale',
    'amenity=kindergarten': 'crèche', 'amenity=university': 'université', 'amenity=post_office': 'bureau de poste',
    'amenity=dentist': 'dentiste', 'amenity=townhall': 'mairie', 'amenity=college': 'collège, lycée',
    'amenity=marketplace': 'marché', 'amenity=library': 'bibliothèque', 'amenity=driving_school': 'auto-école',
    'amenity=theatre': 'théâtre', 'amenity=veterinary': 'vétérinaire', 'amenity=pub': 'pub',
    'amenity=police': 'police', 'amenity=nightclub': 'boîte de nuit', 'amenity=arts_centre': 'centre culturel',
    'amenity=clinic': 'clinique', 'amenity=hospital': 'hôpital', 'amenity=cinema': 'cinéma',
    'amenity=music_school': 'école de musique', 'amenity=social_centre': 'centre social',
    'amenity=ice_cream': 'glacier', 'amenity=research_institute': 'institut de recherche',
    'amenity=childcare': 'garde d\'enfants', 'amenity=dojo': 'dojo', 'amenity=toy_library': 'ludothèque',
    'amenity=fire_station': 'pompiers', 'amenity=biergarten': 'biergarten',
    'amenity=events_venue': 'salle d\'événements', 'amenity=bus_station': 'gare routière',
    'amenity=courthouse': 'tribunal', 'amenity=dancing_school': 'école de danse',
    'amenity=language_school': 'école de langues', 'amenity=coworking_space': 'coworking',
    'amenity=social_facility': 'établissement social', 'amenity=food_court': 'aire de restauration',
    'office=company': 'entreprise', 'office=estate_agent': 'agence immobilière', 'office=insurance': 'assurance',
    'office=association': 'association', 'office=government': 'administration',
    'office=employment_agency': 'agence pour l\'emploi', 'office=it': 'informatique',
    'office=architect': 'architecte', 'office=accountant': 'comptable', 'office=notary': 'notaire',
    'office=educational_institution': 'enseignement', 'office=lawyer': 'avocat', 'office=research': 'recherche',
    'office=financial': 'finance', 'office=coworking': 'coworking', 'office=advertising_agency': 'agence de publicité',
    'office=engineer': 'ingénierie', 'office=property_management': 'gestion immobilière',
    'office=consulting': 'conseil', 'office=ngo': 'ONG', 'office=geodesist': 'géomètre', 'office=union': 'syndicat',
    'office=diplomatic': 'consulat', 'office=construction_company': 'BTP', 'office=travel_agent': 'agence de voyage',
    'office=political_party': 'parti politique',
    'shop=clothes': 'vêtements', 'shop=hairdresser': 'coiffeur', 'shop=bakery': 'boulangerie',
    'shop=convenience': 'supérette', 'shop=beauty': 'institut de beauté', 'shop=car_repair': 'garage',
    'shop=optician': 'opticien', 'shop=supermarket': 'supermarché', 'shop=butcher': 'boucherie',
    'shop=jewelry': 'bijouterie', 'shop=car': 'concession auto', 'shop=laundry': 'laverie', 'shop=shoes': 'chaussures',
    'shop=florist': 'fleuriste', 'shop=newsagent': 'presse', 'shop=books': 'librairie', 'shop=doityourself': 'bricolage',
    'shop=furniture': 'meubles', 'shop=bicycle': 'vélos', 'shop=deli': 'épicerie fine', 'shop=greengrocer': 'primeur',
    'shop=pastry': 'pâtisserie', 'shop=cosmetics': 'cosmétiques', 'shop=interior_decoration': 'décoration',
    'shop=alcohol': 'cave', 'shop=wine': 'cave', 'shop=hearing_aids': 'audioprothésiste',
    'shop=mobile_phone': 'téléphonie', 'shop=tobacco': 'tabac', 'shop=variety_store': 'bazar',
    'shop=e-cigarette': 'cigarette électronique', 'shop=travel_agency': 'agence de voyage', 'shop=tattoo': 'tatouage',
    'shop=sports': 'sport', 'shop=kitchen': 'cuisines', 'shop=dry_cleaning': 'pressing', 'shop=gift': 'cadeaux',
    'shop=cheese': 'fromagerie', 'shop=chocolate': 'chocolatier', 'shop=frozen_food': 'surgelés',
    'shop=motorcycle': 'motos', 'shop=massage': 'massage', 'shop=electronics': 'électronique',
    'shop=garden_centre': 'jardinerie', 'shop=seafood': 'poissonnerie', 'shop=art': 'galerie d\'art',
    'shop=funeral_directors': 'pompes funèbres', 'shop=pet': 'animalerie', 'shop=mall': 'centre commercial',
    'shop=computer': 'informatique', 'shop=toys': 'jouets', 'shop=second_hand': 'occasion',
    'shop=copyshop': 'reprographie', 'shop=confectionery': 'confiserie', 'shop=stationery': 'papeterie',
    'shop=perfumery': 'parfumerie', 'shop=chemist': 'droguerie', 'shop=antiques': 'antiquités',
    'shop=hardware': 'quincaillerie', 'shop=tea': 'thé', 'shop=coffee': 'café',
    'shop=musical_instrument': 'instruments de musique', 'shop=games': 'jeux', 'shop=video_games': 'jeux vidéo',
    'shop=farm': 'produits de la ferme', 'shop=locksmith': 'serrurier', 'shop=photo': 'photo',
    'shop=tailor': 'retouches', 'shop=music': 'disquaire', 'shop=grocery': 'épicerie', 'shop=general': 'épicerie',
    'shop=kiosk': 'kiosque', 'shop=convenience;gas': 'station-service', 'shop=gas': 'gaz', 'shop=ticket': 'billetterie',
    'craft=electronics_repair': 'réparation', 'craft=shoemaker': 'cordonnier', 'craft=dressmaker': 'couturier',
    'craft=caterer': 'traiteur', 'craft=electrician': 'électricien', 'craft=cleaning': 'nettoyage',
    'craft=photographer': 'photographe', 'craft=carpenter': 'menuisier', 'craft=joiner': 'menuisier',
    'craft=hvac': 'chauffagiste', 'craft=builder': 'maçon', 'craft=upholsterer': 'tapissier',
    'craft=brewery': 'brasserie artisanale', 'craft=roofer': 'couvreur', 'craft=plumber': 'plombier',
    'craft=tailor': 'tailleur', 'craft=painter': 'peintre',
};

// Category code and label of an OSM feature, null if none is kept
function osmCategory(tags) {
    for (const key of OSM_KEYS) {
        if (!(key in tags)) continue;
        const code = `${key}=${tags[key]}`;
        if (SKIPPED.has(code)) continue;
        const label = LABELS[code] || KEY_LABELS[key];
        if (label) return { code, label };
    }
    return null;
}

const inArea = (lat, lon) => lat >= TISSEO_AREA.minLat && lat <= TISSEO_AREA.maxLat
    && lon >= TISSEO_AREA.minLon && lon <= TISSEO_AREA.maxLon;
const round = x => Math.round(x * 1e5) / 1e5; // ~1 m
const normalize = str => str.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().trim();
// osmium type_id ids: n123 for a node, a<2 × way id> or a<2 × relation id + 1> for an area
function osmId(id) {
    if (id[0] === 'n') return `node/${id.slice(1)}`;
    const area = Number(id.slice(1));
    return area % 2 ? `relation/${(area - 1) / 2}` : `way/${area / 2}`;
}

function distanceM(a, b) {
    const rad = Math.PI / 180;
    const dLat = (b.lat - a.lat) * rad;
    const dLon = (b.lon - a.lon) * rad;
    const h = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.sin(dLon / 2) ** 2;
    return 2 * 6371000 * Math.asin(Math.sqrt(h));
}

// Whole CSV text, double-quoted fields, as rows of fields
function parseCsvRows(text) {
    const rows = [];
    let row = [];
    let field = '';
    let quoted = false;
    for (let i = 0; i < text.length; i++) {
        const c = text[i];
        if (quoted) {
            if (c === '"' && text[i + 1] === '"') { field += '"'; i++; }
            else if (c === '"') quoted = false;
            else field += c;
        } else if (c === '"') quoted = true;
        else if (c === ',') { row.push(field); field = ''; }
        else if (c === '\n') { row.push(field.replace(/\r$/, '')); rows.push(row); row = []; field = ''; }
        else field += c;
    }
    if (field || row.length) { row.push(field); rows.push(row); }
    return rows;
}

// ---- Tisséo GTFS stops ----

// Rows of a CSV file inside the zip, as objects, streamed to onRow
async function readZippedCsv(zip, name, onRow) {
    const unzip = spawn('unzip', ['-p', zip, name]);
    const lines = readline.createInterface({ input: unzip.stdout, crlfDelay: Infinity });
    let header = null;
    for await (const raw of lines) {
        const line = raw.replace(/^﻿/, '');
        if (!line) continue;
        const [fields] = parseCsvRows(line);
        if (!header) { header = fields; continue; }
        onRow(Object.fromEntries(header.map((h, i) => [h, fields[i]])));
    }
}

async function fetchGtfsStops() {
    const records = await (await fetch(GTFS_DATASET)).json();
    const file = records.results.map(r => r.file).find(f => f?.filename === GTFS_FILENAME);
    if (!file) throw new Error(`${GTFS_FILENAME} not found in the tisseo-gtfs dataset`);

    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tisseo-gtfs-'));
    const zip = path.join(dir, GTFS_FILENAME);
    try {
        console.log(`Downloading ${file.url}`);
        fs.writeFileSync(zip, Buffer.from(await (await fetch(file.url)).arrayBuffer()));
        execFileSync('unzip', ['-t', '-q', zip]);

        const routeType = new Map();
        await readZippedCsv(zip, 'routes.txt', r => routeType.set(r.route_id, r.route_type));
        const tripType = new Map();
        await readZippedCsv(zip, 'trips.txt', t => tripType.set(t.trip_id, routeType.get(t.route_id)));

        const areas = new Map();       // stop_area id -> { name, lat, lon }
        const parentOf = new Map();    // stop_point id -> stop_area id
        await readZippedCsv(zip, 'stops.txt', s => {
            if (s.location_type === '1') areas.set(s.stop_id, { name: s.stop_name, lat: Number(s.stop_lat), lon: Number(s.stop_lon) });
            else if (s.parent_station) parentOf.set(s.stop_id, s.parent_station);
        });

        console.log('Reading stop_times.txt');
        const servedBy = new Map();    // stop_area id -> Set of route types
        await readZippedCsv(zip, 'stop_times.txt', st => {
            const area = parentOf.get(st.stop_id);
            const type = tripType.get(st.trip_id);
            if (!area || !type) return;
            if (!servedBy.has(area)) servedBy.set(area, new Set());
            servedBy.get(area).add(type);
        });

        const stops = [];
        for (const [id, area] of areas) {
            const types = servedBy.get(id);
            const code = types?.has(ROUTE_TYPE_METRO) ? 'metro' : types?.has(ROUTE_TYPE_BUS) ? 'bus' : null;
            if (code && inArea(area.lat, area.lon)) {
                stops.push({ id, category: code, name: area.name, lat: round(area.lat), lon: round(area.lon), aliases: [] });
            }
        }
        return stops;
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
}

// ---- OpenStreetMap places ----

// A point, or the mean of the outer ring of a (multi)polygon: close enough for a building
function position(geometry) {
    if (geometry.type === 'Point') return { lon: geometry.coordinates[0], lat: geometry.coordinates[1] };
    const ring = geometry.type === 'Polygon' ? geometry.coordinates[0] : geometry.coordinates[0][0];
    const points = ring.slice(0, -1); // the ring repeats its first point
    return {
        lon: points.reduce((s, p) => s + p[0], 0) / points.length,
        lat: points.reduce((s, p) => s + p[1], 0) / points.length,
    };
}

function readOsmPlaces(file) {
    const places = [];
    for (const raw of fs.readFileSync(file, 'utf8').split('\n')) {
        const line = raw.replace(/^\x1e/, '').trim();
        if (!line) continue;
        const { id, geometry, properties: tags } = JSON.parse(line);
        const name = tags.name?.trim();
        const category = name && osmCategory(tags);
        if (!category) continue;
        const { lat, lon } = position(geometry);
        if (!inArea(lat, lon)) continue;
        places.push({
            id:       osmId(id),
            category: category.code,
            label:    category.label,
            name,
            lat:      round(lat),
            lon:      round(lon),
            aliases:  ALIAS_KEYS.map(k => tags[k]?.trim()).filter(a => a && normalize(a) !== normalize(name)),
            street:   tags['addr:street'],
            number:   tags['addr:housenumber'],
            postcode: tags['addr:postcode'],
            city:     tags['addr:city'],
            isNode:   geometry.type === 'Point',
        });
    }
    return places;
}

// Same category and name within MERGE_DISTANCE_M: keep the best described one (address, then
// node), with every alias; chains keep one place per shop since their shops are further apart
function mergeDuplicates(places) {
    const byName = new Map();
    places.forEach(p => {
        const key = `${p.category}:${normalize(p.name)}`;
        if (!byName.has(key)) byName.set(key, []);
        byName.get(key).push(p);
    });
    const score = p => (p.street ? 2 : 0) + (p.isNode ? 1 : 0);
    const merged = [];
    for (const group of byName.values()) {
        const clusters = [];
        group.sort((a, b) => score(b) - score(a)).forEach(p => {
            const cluster = clusters.find(c => distanceM(c[0], p) < MERGE_DISTANCE_M);
            if (cluster) cluster.push(p);
            else clusters.push([p]);
        });
        clusters.forEach(([best, ...others]) => {
            const aliases = new Set([best, ...others].flatMap(p => p.aliases));
            merged.push({ ...best, aliases: [...aliases] });
        });
    }
    return merged;
}

// ---- Addresses ----

// Nearest address of every place, by batches of the bulk reverse geocoder
async function reverseGeocode(places) {
    const found = [];
    for (let start = 0; start < places.length; start += REVERSE_BATCH) {
        const batch = places.slice(start, start + REVERSE_BATCH);
        const csv = ['lat,lon', ...batch.map(p => `${p.lat},${p.lon}`)].join('\n');
        const form = new FormData();
        form.append('data', new Blob([csv], { type: 'text/csv' }), 'places.csv');
        form.append('columns', 'lat');
        form.append('columns', 'lon');
        const res = await fetch(REVERSE_CSV_URL, { method: 'POST', body: form });
        if (!res.ok) throw new Error(`Bulk reverse geocoding failed: ${res.status}`);
        const [header, ...rows] = parseCsvRows(await res.text());
        if (rows.length !== batch.length) throw new Error(`Bulk reverse geocoding: ${rows.length} rows for ${batch.length}`);
        found.push(...rows.map(r => Object.fromEntries(header.map((h, i) => [h, r[i]]))));
        console.log(`Reverse geocoded ${found.length} / ${places.length}`);
    }
    return found;
}

// { address, addressSource, near } of a place, null when neither OSM nor the BAN has one
function address(place, nearest) {
    const postcode = place.postcode || nearest.result_postcode;
    const city = place.city || nearest.result_city;
    const locality = [postcode, city].filter(Boolean).join(' ');
    if (place.street) {
        const street = place.number ? `${place.number} ${place.street}` : place.street;
        return { address: locality ? `${street}, ${locality}` : street, addressSource: 'osm' };
    }
    if (!nearest.result_name) return null;
    return {
        address:       `${nearest.result_name}, ${nearest.result_postcode} ${nearest.result_city}`,
        addressSource: 'ban',
        near:          Number(nearest.result_distance) > NEAR_THRESHOLD_M,
    };
}

(async () => {
    const [input, osmDate] = process.argv.slice(2);
    if (!input || !/^\d{4}-\d{2}-\d{2}$/.test(osmDate || '')) {
        throw new Error('Usage: node scripts/build-places.js <tagged.geojsonseq> <osm extract date YYYY-MM-DD>');
    }
    const today = new Date().toISOString().slice(0, 10);

    const read = readOsmPlaces(input);
    const osmPlaces = mergeDuplicates(read);
    console.log(`${read.length} named OSM features, ${osmPlaces.length} places after merging duplicates`);
    const stops = await fetchGtfsStops();
    stops.forEach(s => { s.label = LABELS[s.category]; });
    const all = [...osmPlaces, ...stops];
    const nearest = await reverseGeocode(all);

    const categories = {};
    const places = all
        .map((p, i) => {
            categories[p.category] = p.label;
            const found = address(p, nearest[i]);
            return {
                ...CANDIDATE_CATEGORIES.has(p.category) && { id: p.id },
                category: p.category,
                name:     p.name,
                lat:      p.lat,
                lon:      p.lon,
                ...found && {
                    address:       found.address,
                    addressSource: found.addressSource,
                    ...found.near && { near: true },
                },
                ...p.aliases.length && { aliases: p.aliases },
            };
        })
        .sort((a, b) => a.category.localeCompare(b.category) || a.name.localeCompare(b.name, 'fr'));
    const sortedCategories = Object.fromEntries(Object.entries(categories).sort(([a], [b]) => a.localeCompare(b)));
    const data = { sources: { osm: osmDate, gtfs: today, addresses: today }, categories: sortedCategories, places };
    fs.writeFileSync(OUTPUT, `${JSON.stringify(data)}\n`);

    const counts = {};
    places.forEach(p => { counts[p.category] = (counts[p.category] || 0) + 1; });
    const candidates = [...CANDIDATE_CATEGORIES].map(c => `${c} ${counts[c]}`).join(', ');
    console.log(`Wrote ${places.length} places (${candidates}), ${Object.keys(categories).length} categories, `
        + `${places.filter(p => !p.address).length} without address, ${(fs.statSync(OUTPUT).size / 1024).toFixed(0)} KB`);
})().catch(err => {
    console.error(err);
    process.exit(1);
});
