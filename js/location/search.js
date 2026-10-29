// search.js - Local place search: every place with an address (candidates and search-only places
// such as companies, shops, schools…), instant and without any call. Each typed word (accents and
// case ignored) is matched against the name, aliases, former names, category and city of every
// place, and scored; see docs/location-pipeline.md § 2. No DOM: it runs in Node too.

const MAX_SUGGESTIONS = 5;

const normalize = str => str.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
const words = str => normalize(str).split(/[^a-z0-9]+/).filter(Boolean);
// Score of a place: for each typed word, its best match, quality x weight of the field
const SEARCH_WEIGHTS = { name: 1, alias: 0.8, category: 0.6, city: 0.6, oldName: 0.3 };
const MATCH_EXACT = 3;       // the typed word is a whole word of the field
const MATCH_PREFIX = 2;      // the typed word starts a word of the field
const BONUS_NAME_START = 2;  // the name starts with the whole query
const BONUS_ALL_IN_NAME = 1; // every required typed word matches in the name
// Optional words: they add to the score when they match, but are not required
const STOP_WORDS = new Set(['le', 'la', 'les', 'l', 'de', 'du', 'des', 'd', 'au', 'aux']);
// Usual abbreviations typed for words of place names, matched as the whole word
const ABBREVIATIONS = { st: 'saint', ste: 'sainte', av: 'avenue', bd: 'boulevard', pl: 'place', r: 'rue' };
// Other words people type for a category, on top of its label
const CATEGORY_SYNONYMS = {
    'metro': 'station', 'amenity=restaurant': 'resto', 'amenity=fast_food': 'fast food snack',
    'amenity=townhall': 'hotel de ville', 'amenity=post_office': 'poste', 'amenity=university': 'fac faculte campus',
    'amenity=hospital': 'chu', 'amenity=doctors': 'docteur cabinet medical', 'amenity=cinema': 'cine',
    'office=company': 'societe', 'shop=hairdresser': 'coiffure',
};
// At equal score: metro stations, then every other place, then the numerous bus stops (before the
// distance, so that "jean jau" gives the metro station before a nearer hairdresser of the same name)
const categoryRank = category => (category === 'metro' ? 0 : category === 'bus' ? 2 : 1);
const placeAddress = p => [p.street, [p.postcode, p.city].filter(Boolean).join(' ')].filter(Boolean).join(', ');

// Index of the places of the data file (see loadData in engine.js), built once (~16 ms on a PC);
// returns search(text, origin)
export function createPlaceSearch(data) {
    // [{ place, rank, name (normalized words joined), nameLength, fields: [{ field, weight, words }] }]
    const placeIndex = data.places.filter(p => p.street || p.city).map(p => {
        const nameWords = words(p.name);
        const fields = [
            { field: 'name', words: nameWords },
            { field: 'alias', words: (p.aliases || []).flatMap(words) },
            { field: 'oldName', words: (p.oldNames || []).flatMap(words) },
            { field: 'category', words: words(`${data.categories[p.category]} ${CATEGORY_SYNONYMS[p.category] || ''}`) },
            { field: 'city', words: words(p.city || '') },
        ].filter(f => f.words.length).map(f => ({ ...f, weight: SEARCH_WEIGHTS[f.field] }));
        return { place: p, rank: categoryRank(p.category), name: nameWords.join(' '), nameLength: p.name.length, fields };
    });
    // Sorted word index, built in the browser right after the data file (~16 ms on a PC; shipping it
    // would add ~100 KB to download): every distinct word of every field, sorted, and for each the
    // placeIndex positions of the places that have it. A typed word then finds its places with a
    // binary search instead of a scan of every place
    let indexWords = null;    // sorted distinct words
    let indexPostings = null; // indexPostings[i]: placeIndex positions of the places with indexWords[i]

    function buildWordIndex() {
        const postings = new Map();
        placeIndex.forEach((entry, i) => {
            new Set(entry.fields.flatMap(f => f.words)).forEach(w => {
                const list = postings.get(w);
                if (list) list.push(i);
                else postings.set(w, [i]);
            });
        });
        indexWords = [...postings.keys()].sort();
        indexPostings = indexWords.map(w => postings.get(w));
    }
    buildWordIndex();

    // Position of the first indexed word >= word
    function lowerBound(word) {
        let low = 0;
        let high = indexWords.length;
        while (low < high) {
            const mid = (low + high) >> 1;
            if (indexWords[mid] < word) low = mid + 1;
            else high = mid;
        }
        return low;
    }

    // Indexed words matching token (starting with it, or equal to its abbreviation's word):
    // { positions in indexWords, size: number of places listed, duplicates included }, or null as
    // soon as more than limit places are listed
    function indexRange(token, limit) {
        const positions = [];
        let size = 0;
        const add = i => {
            positions.push(i);
            size += indexPostings[i].length;
            return size <= limit;
        };
        for (let i = lowerBound(token); i < indexWords.length && indexWords[i].startsWith(token); i++) {
            if (!add(i)) return null;
        }
        const expanded = ABBREVIATIONS[token];
        if (expanded && !expanded.startsWith(token)) {
            const i = lowerBound(expanded);
            if (indexWords[i] === expanded && !add(i)) return null;
        }
        return { positions, size };
    }

    // Places to score: those matching the most selective required word (scorePlace checks the
    // others), in placeIndex order; every place when even that word is very common ("to" matches
    // the city Toulouse): building that set would cost more than a scan
    const SCAN_RATIO = 0.25;
    function candidatePlaces(tokens, required) {
        let best = null;
        tokens.forEach((token, i) => {
            const range = required[i] && indexRange(token, best ? best.size : placeIndex.length * SCAN_RATIO);
            if (range) best = range;
        });
        if (!best) return placeIndex;
        const found = new Set();
        best.positions.forEach(i => indexPostings[i].forEach(j => found.add(j)));
        return [...found].sort((a, b) => a - b).map(j => placeIndex[j]);
    }

    // Best match of one typed word in a place: { score, inName }
    function bestMatch(entry, token) {
        const expanded = ABBREVIATIONS[token];
        let score = 0;
        let inName = false;
        for (const { field, weight, words: fieldWords } of entry.fields) {
            for (const w of fieldWords) {
                const quality = w === token || w === expanded ? MATCH_EXACT : w.startsWith(token) ? MATCH_PREFIX : 0;
                if (quality * weight > score) score = quality * weight;
                if (quality && field === 'name') inName = true;
            }
        }
        return { score, inName };
    }

    // Score of a place for the typed words, null when a required word matches nothing
    function scorePlace(entry, tokens, required) {
        let score = 0;
        let allInName = true;
        for (let i = 0; i < tokens.length; i++) {
            const match = bestMatch(entry, tokens[i]);
            if (!match.score && required[i]) return null;
            score += match.score;
            if (required[i] && !match.inName) allInName = false;
        }
        if (entry.name.startsWith(tokens.join(' '))
            || entry.name.startsWith(tokens.map(t => ABBREVIATIONS[t] || t).join(' '))) score += BONUS_NAME_START;
        if (allInName) score += BONUS_ALL_IN_NAME;
        return score;
    }

    // origin: center of the participants already located (Capitole if none), to rank near places first
    return function search(text, origin) {
        const tokens = words(text);
        if (!tokens.length) return [];
        // Stop words are optional, unless the query has nothing else
        const onlyStopWords = tokens.every(t => STOP_WORDS.has(t));
        const required = tokens.map(t => onlyStopWords || !STOP_WORDS.has(t));
        // Squared equirectangular distance: enough to compare places a few km apart
        const cosLat = Math.cos(origin.lat * Math.PI / 180);
        const distance = p => (p.lat - origin.lat) ** 2 + ((p.lon - origin.lon) * cosLat) ** 2;
        const found = [];
        for (const entry of candidatePlaces(tokens, required)) {
            const score = scorePlace(entry, tokens, required);
            if (score != null) found.push({ entry, score: Math.floor(score), distance: distance(entry.place) });
        }
        return found
            .sort((a, b) => b.score - a.score
                || a.entry.rank - b.entry.rank
                || a.distance - b.distance
                || a.entry.nameLength - b.entry.nameLength)
            .slice(0, MAX_SUGGESTIONS)
            .map(({ entry: { place: p } }) => {
                const address = `${p.near ? 'près de ' : ''}${placeAddress(p)}`;
                return { label: `${p.name} — ${address}`, name: p.name, address, kind: data.categories[p.category], lat: p.lat, lon: p.lon };
            });
    };
}
