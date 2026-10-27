// fetch-pois.js - Build data/pois-toulouse.json, the meeting point candidates of the location page:
//   - bars and squares from OpenStreetMap (one Overpass query over the Tisséo area)
//   - metro stations and bus stops from the Tisséo GTFS feed (stop areas, classified by the
//     route types serving them: metro if any metro line stops there, else bus; tram-only and
//     cable car-only stops are left out)
// If Overpass is unavailable, the bars and squares of the previous file are kept.
//
// Usage (needs the unzip command): node scripts/fetch-pois.js

const fs       = require('fs');
const os       = require('os');
const path     = require('path');
const readline = require('readline');
const { execFileSync, spawn } = require('child_process');
const TISSEO_AREA = require('../data/tisseo-area.json');

const OUTPUT = path.join(__dirname, '..', 'data', 'pois-toulouse.json');
const GTFS_DATASET = 'https://data.toulouse-metropole.fr/api/explore/v2.1/catalog/datasets/tisseo-gtfs/records?limit=20';
const GTFS_FILENAME = 'tisseo_gtfs_v2.zip';
const OVERPASS_URLS = [
    'https://overpass-api.de/api/interpreter',
    'https://overpass.private.coffee/api/interpreter',
];
const OVERPASS_TIMEOUT_MS = 120000;
const ROUTE_TYPE_METRO = '1';
const ROUTE_TYPE_BUS = '3';

const inArea = (lat, lon) => lat >= TISSEO_AREA.minLat && lat <= TISSEO_AREA.maxLat
    && lon >= TISSEO_AREA.minLon && lon <= TISSEO_AREA.maxLon;
const round = x => Math.round(x * 1e5) / 1e5; // ~1 m

// One CSV line, with double-quoted fields
function parseCsvLine(line) {
    const fields = [];
    let field = '';
    let quoted = false;
    for (let i = 0; i < line.length; i++) {
        const c = line[i];
        if (quoted) {
            if (c === '"' && line[i + 1] === '"') { field += '"'; i++; }
            else if (c === '"') quoted = false;
            else field += c;
        } else if (c === '"') quoted = true;
        else if (c === ',') { fields.push(field); field = ''; }
        else field += c;
    }
    fields.push(field);
    return fields;
}

// Rows of a CSV file inside the zip, as objects, streamed to onRow
async function readZippedCsv(zip, name, onRow) {
    const unzip = spawn('unzip', ['-p', zip, name]);
    const lines = readline.createInterface({ input: unzip.stdout, crlfDelay: Infinity });
    let header = null;
    for await (const raw of lines) {
        const line = raw.replace(/^﻿/, '');
        if (!line) continue;
        const fields = parseCsvLine(line);
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
            const kind = types?.has(ROUTE_TYPE_METRO) ? 'metro' : types?.has(ROUTE_TYPE_BUS) ? 'bus' : null;
            if (kind && inArea(area.lat, area.lon)) stops.push({ id, kind, name: area.name, lat: round(area.lat), lon: round(area.lon) });
        }
        return stops;
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
}

async function fetchOsmPlaces() {
    const bbox = `${TISSEO_AREA.minLat},${TISSEO_AREA.minLon},${TISSEO_AREA.maxLat},${TISSEO_AREA.maxLon}`;
    const query = `[out:json][timeout:90][bbox:${bbox}];(nwr["amenity"="bar"]["name"];nwr["place"="square"]["name"];);out center tags;`;
    for (const url of OVERPASS_URLS) {
        try {
            console.log(`Querying ${url}`);
            const res = await fetch(url, {
                method:  'POST',
                headers: { 'User-Agent': 'gresset-bourgeois.fr location prototype' },
                body:    new URLSearchParams({ data: query }),
                signal:  AbortSignal.timeout(OVERPASS_TIMEOUT_MS),
            });
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
            return (await res.json()).elements
                .map(el => ({
                    id:   `${el.type}/${el.id}`,
                    kind: el.tags.amenity === 'bar' ? 'bar' : 'square',
                    name: el.tags.name,
                    lat:  round(el.lat ?? el.center?.lat),
                    lon:  round(el.lon ?? el.center?.lon),
                }))
                .filter(p => Number.isFinite(p.lat) && inArea(p.lat, p.lon));
        } catch (err) {
            console.warn(`Overpass ${url} failed: ${err.message}`);
        }
    }
    return null;
}

(async () => {
    const previous = fs.existsSync(OUTPUT) ? JSON.parse(fs.readFileSync(OUTPUT, 'utf8')) : null;
    const today = new Date().toISOString().slice(0, 10);

    const stops = await fetchGtfsStops();
    let places = await fetchOsmPlaces();
    let osmDate = today;
    if (!places) {
        places = (previous?.pois || []).filter(p => p.kind === 'bar' || p.kind === 'square');
        osmDate = previous?.sources?.osm || null;
        console.warn(`Overpass unavailable: keeping ${places.length} bars and squares from the previous file`);
    }

    const pois = [...places, ...stops]
        .sort((a, b) => a.kind.localeCompare(b.kind) || a.name.localeCompare(b.name, 'fr'));
    const data = { sources: { osm: osmDate, gtfs: today }, pois };
    fs.writeFileSync(OUTPUT, `${JSON.stringify(data)}\n`);

    const counts = {};
    pois.forEach(p => { counts[p.kind] = (counts[p.kind] || 0) + 1; });
    console.log(`Wrote ${OUTPUT}: ${JSON.stringify(counts)}, ${(fs.statSync(OUTPUT).size / 1024).toFixed(0)} KB`);
})().catch(err => {
    console.error(err);
    process.exit(1);
});
