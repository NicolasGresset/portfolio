// search-queries.js - Reference queries for the local place search (js/location/search.js): prints
// the first suggestions of each query, to compare the ranking before and after a change of its
// constants. Usage: node scripts/search-queries.js [query…] (default: the list below)

import fs from 'fs';
import { createPlaceSearch } from '../js/location/search.js';

const QUERIES = [
    'jean jau', 'jean', 'capi', 'mirail', 'borderouge', 'arenes', 'compans', 'st cyp', 'bagatelle',
    'basso', 'esquirol', 'carmes', 'mcdo', 'cinema', 'pharmacie', 'la cale', 'universite', 'gare',
];
const SHOWN = 3;
const CAPITOLE = { lat: 43.6045, lon: 1.4440 };

const data = JSON.parse(fs.readFileSync(new URL('../data/pois-toulouse.json', import.meta.url)));
const search = createPlaceSearch(data);
const queries = process.argv.length > 2 ? process.argv.slice(2) : QUERIES;
for (const query of queries) {
    const found = search(query, CAPITOLE).slice(0, SHOWN).map(r => `${r.name} (${r.kind})`);
    console.log(`${query.padEnd(12)} ${found.join(' | ') || '-'}`);
}
