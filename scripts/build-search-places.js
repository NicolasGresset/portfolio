// build-search-places.js - Add the search-only places to data/pois-toulouse.json: named offices
// (companies, administrations…), shops, crafts and well-known amenities (schools, pharmacies,
// cafés…) from OpenStreetMap, so that the address search finds them by name. They are never
// meeting point candidates (the engine only reads `pois`).
//
// Input: an osmium export of the Tisséo area (see data/tisseo-area.json), made from the
// Geofabrik Midi-Pyrénées extract:
//   curl -LO https://download.geofabrik.de/europe/france/midi-pyrenees-latest.osm.pbf
//   osmium extract -b 1.20,43.42,1.62,43.75 midi-pyrenees-latest.osm.pbf -o area.osm.pbf
//   osmium tags-filter area.osm.pbf nwr/office nwr/shop nwr/craft nwr/amenity -o tagged.osm.pbf
//   osmium export tagged.osm.pbf -f geojsonseq --geometry-types=point,polygon -o tagged.geojsonseq
//
// Addresses: the OSM address when it has a street, completed (postcode, city) or replaced by the
// nearest address from the IGN Géoplateforme bulk reverse geocoder ("près de" beyond 30 m).
//
// Usage: node scripts/build-search-places.js <tagged.geojsonseq>

const fs   = require('fs');
const path = require('path');

const OUTPUT = path.join(__dirname, '..', 'data', 'pois-toulouse.json');
const REVERSE_CSV_URL = 'https://data.geopf.fr/geocodage/reverse/csv';
const REVERSE_BATCH = 5000;
const NEAR_THRESHOLD_M = 30;
const MERGE_DISTANCE_M = 300; // same name closer than this: one place (a node and its buildings)
const ALIAS_KEYS = ['short_name', 'alt_name', 'official_name', 'old_name'];

// French label of each kept OSM type; a type missing here gets its group label
const GROUP_LABELS = { office: 'bureau', shop: 'commerce', craft: 'artisan' };
const LABELS = {
    office: {
        company: 'entreprise', estate_agent: 'agence immobilière', insurance: 'assurance',
        association: 'association', government: 'administration', employment_agency: 'agence pour l\'emploi',
        it: 'informatique', architect: 'architecte', accountant: 'comptable', notary: 'notaire',
        educational_institution: 'enseignement', lawyer: 'avocat', research: 'recherche',
        financial: 'finance', coworking: 'coworking', advertising_agency: 'agence de publicité',
        engineer: 'ingénierie', property_management: 'gestion immobilière', consulting: 'conseil',
        ngo: 'ONG', geodesist: 'géomètre', union: 'syndicat', diplomatic: 'consulat',
        construction_company: 'BTP', travel_agent: 'agence de voyage', political_party: 'parti politique',
    },
    shop: {
        clothes: 'vêtements', hairdresser: 'coiffeur', bakery: 'boulangerie', convenience: 'supérette',
        beauty: 'institut de beauté', car_repair: 'garage', optician: 'opticien', supermarket: 'supermarché',
        butcher: 'boucherie', jewelry: 'bijouterie', car: 'concession auto', laundry: 'laverie',
        shoes: 'chaussures', florist: 'fleuriste', newsagent: 'presse', books: 'librairie',
        doityourself: 'bricolage', furniture: 'meubles', bicycle: 'vélos', deli: 'épicerie fine',
        greengrocer: 'primeur', pastry: 'pâtisserie', cosmetics: 'cosmétiques', interior_decoration: 'décoration',
        alcohol: 'cave', wine: 'cave', hearing_aids: 'audioprothésiste', mobile_phone: 'téléphonie',
        tobacco: 'tabac', variety_store: 'bazar', 'e-cigarette': 'cigarette électronique',
        travel_agency: 'agence de voyage', tattoo: 'tatouage', sports: 'sport', kitchen: 'cuisines',
        dry_cleaning: 'pressing', gift: 'cadeaux', cheese: 'fromagerie', chocolate: 'chocolatier',
        frozen_food: 'surgelés', motorcycle: 'motos', massage: 'massage', electronics: 'électronique',
        garden_centre: 'jardinerie', seafood: 'poissonnerie', art: 'galerie d\'art',
        funeral_directors: 'pompes funèbres', pet: 'animalerie', mall: 'centre commercial',
        computer: 'informatique', toys: 'jouets', second_hand: 'occasion', copyshop: 'reprographie',
        confectionery: 'confiserie', stationery: 'papeterie', perfumery: 'parfumerie', chemist: 'droguerie',
        antiques: 'antiquités', hardware: 'quincaillerie', tea: 'thé', coffee: 'café',
        musical_instrument: 'instruments de musique', games: 'jeux', video_games: 'jeux vidéo',
        farm: 'produits de la ferme', locksmith: 'serrurier', photo: 'photo', tailor: 'retouches',
        music: 'disquaire', grocery: 'épicerie', general: 'épicerie', kiosk: 'kiosque',
        'convenience;gas': 'station-service', gas: 'gaz', ticket: 'billetterie',
    },
    craft: {
        electronics_repair: 'réparation', shoemaker: 'cordonnier', dressmaker: 'couturier',
        caterer: 'traiteur', electrician: 'électricien', cleaning: 'nettoyage', photographer: 'photographe',
        carpenter: 'menuisier', joiner: 'menuisier', hvac: 'chauffagiste', builder: 'maçon',
        upholsterer: 'tapissier', brewery: 'brasserie artisanale', roofer: 'couvreur', plumber: 'plombier',
        tailor: 'tailleur', painter: 'peintre',
    },
    // Amenities: only these, the others (benches, lockers, chargers…) are not looked for by name;
    // bars and restaurants are already in `pois`
    amenity: {
        school: 'école', fast_food: 'restauration rapide', parking: 'parking', bank: 'banque',
        pharmacy: 'pharmacie', place_of_worship: 'lieu de culte', doctors: 'médecin', cafe: 'café',
        community_centre: 'salle municipale', kindergarten: 'crèche', university: 'université',
        post_office: 'bureau de poste', dentist: 'dentiste', townhall: 'mairie', college: 'collège, lycée',
        marketplace: 'marché', library: 'bibliothèque', driving_school: 'auto-école', theatre: 'théâtre',
        veterinary: 'vétérinaire', pub: 'pub', police: 'police', nightclub: 'boîte de nuit',
        arts_centre: 'centre culturel', clinic: 'clinique', hospital: 'hôpital', cinema: 'cinéma',
        music_school: 'école de musique', social_centre: 'centre social', ice_cream: 'glacier',
        research_institute: 'institut de recherche', childcare: 'garde d\'enfants', dojo: 'dojo',
        toy_library: 'ludothèque', fire_station: 'pompiers', biergarten: 'biergarten',
        events_venue: 'salle d\'événements', bus_station: 'gare routière', courthouse: 'tribunal',
        dancing_school: 'école de danse', language_school: 'école de langues',
        coworking_space: 'coworking', social_facility: 'établissement social', food_court: 'aire de restauration',
    },
};
const SKIPPED = { shop: new Set(['vacant']) };

const round = x => Math.round(x * 1e5) / 1e5; // ~1 m
const normalize = str => str.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().trim();

function distanceM(a, b) {
    const rad = Math.PI / 180;
    const dLat = (b.lat - a.lat) * rad;
    const dLon = (b.lon - a.lon) * rad;
    const h = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.sin(dLon / 2) ** 2;
    return 2 * 6371000 * Math.asin(Math.sqrt(h));
}

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

function readFeatures(file) {
    const places = [];
    for (const raw of fs.readFileSync(file, 'utf8').split('\n')) {
        const line = raw.replace(/^\x1e/, '').trim();
        if (!line) continue;
        const { geometry, properties: tags } = JSON.parse(line);
        const name = tags.name?.trim();
        if (!name) continue;
        const group = ['office', 'shop', 'craft', 'amenity'].find(g => g in tags);
        if (!group) continue;
        const value = tags[group];
        if (SKIPPED[group]?.has(value)) continue;
        const type = LABELS[group][value] || GROUP_LABELS[group];
        if (!type) continue; // amenity not kept
        const { lat, lon } = position(geometry);
        places.push({
            name,
            type,
            lat:     round(lat),
            lon:     round(lon),
            aliases: ALIAS_KEYS.map(k => tags[k]?.trim()).filter(a => a && normalize(a) !== normalize(name)),
            street:  tags['addr:street'],
            number:  tags['addr:housenumber'],
            postcode: tags['addr:postcode'],
            city:    tags['addr:city'],
            isNode:  geometry.type === 'Point',
        });
    }
    return places;
}

// Same name within MERGE_DISTANCE_M: keep the best described one (address, then node), with
// every alias; chains keep one place per shop since their shops are further apart
function mergeDuplicates(places) {
    const byName = new Map();
    places.forEach(p => {
        const key = normalize(p.name);
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
        const rows = parseCsv(await res.text());
        if (rows.length !== batch.length) throw new Error(`Bulk reverse geocoding: ${rows.length} rows for ${batch.length}`);
        found.push(...rows);
        console.log(`Reverse geocoded ${found.length} / ${places.length}`);
    }
    return found;
}

// Whole CSV text, double-quoted fields, as objects
function parseCsv(text) {
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
    const [header, ...data] = rows;
    return data.map(r => Object.fromEntries(header.map((h, i) => [h, r[i]])));
}

function address(place, nearest) {
    const postcode = place.postcode || nearest.result_postcode;
    const city = place.city || nearest.result_city;
    if (place.street) {
        const street = place.number ? `${place.number} ${place.street}` : place.street;
        return { address: `${street}, ${postcode} ${city}` };
    }
    if (!nearest.result_name) return null;
    return {
        address: `${nearest.result_name}, ${nearest.result_postcode} ${nearest.result_city}`,
        near:    Number(nearest.result_distance) > NEAR_THRESHOLD_M,
    };
}

(async () => {
    const input = process.argv[2];
    if (!input) throw new Error('Usage: node scripts/build-search-places.js <tagged.geojsonseq>');
    const data = JSON.parse(fs.readFileSync(OUTPUT, 'utf8'));

    const read = readFeatures(input);
    const places = mergeDuplicates(read);
    console.log(`${read.length} named features, ${places.length} places after merging duplicates`);
    const nearest = await reverseGeocode(places);

    data.places = places
        .map((p, i) => {
            const found = address(p, nearest[i]);
            if (!found) return null;
            return {
                name: p.name,
                type: p.type,
                lat:  p.lat,
                lon:  p.lon,
                ...found.near ? { near: true } : {},
                address: found.address,
                ...p.aliases.length ? { aliases: p.aliases } : {},
            };
        })
        .filter(Boolean)
        .sort((a, b) => a.name.localeCompare(b.name, 'fr'));
    data.sources.places = new Date().toISOString().slice(0, 10);
    fs.writeFileSync(OUTPUT, `${JSON.stringify(data)}\n`);
    console.log(`Wrote ${data.places.length} search places to ${OUTPUT}, ${(fs.statSync(OUTPUT).size / 1024).toFixed(0)} KB`);
})().catch(err => {
    console.error(err);
    process.exit(1);
});
