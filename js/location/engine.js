// engine.js - Meeting point computation, in the browser: candidates around the participants'
// barycenter, each participant's travel time per mode to arrive today within [slot, slot + 15 min],
// and the candidate minimizing the sum of each participant's fastest time.
//
// Progress is reported through emit(event), with event.type:
//   start -> candidates -> matrix (one per mode) -> transit (progress) -> result
//   -> route (one per participant, path to the chosen place with the retained mode) -> done
// Errors are thrown.

import { durationMatrix, routePath } from './ors.js';
import { transitTrip, forEachLimited } from './transitous.js';
import { tisseoTrip, TisseoKeyError } from './tisseo.js';

const ORS_MODES = ['walk', 'bike', 'car'];
const RETRY_DELAY_MS = 2000; // a transit journey failing for a technical reason is tried once more
// Transit engines: journey function (same contract, counting its calls in calls[name]) and
// journeys computed in parallel. Transitous slows down beyond 3; Tisséo answered 6 in parallel
// without slowing down (2026-10-28)
const TRANSIT_ENGINES = {
    transitous: { trip: (keys, onCall, ...args) => (onCall(), transitTrip(...args)), parallel: 3 },
    tisseo:     { trip: (keys, onCall, ...args) => tisseoTrip(keys.tisseo, onCall, ...args), parallel: 6 },
};
const SLOT_MIN = 15;
const CAR_PARKING_S = 5 * 60;      // fixed time to park, added to every car trip
const RADIUS_START_M = 1000;
const RADIUS_STEP_M = 500;
const RADIUS_MAX_M = 5000;
const MIN_CANDIDATES = 3;

// Categories the user picks from, and the place categories of data/pois-toulouse.json they cover:
// only these places can be candidates, the others are for the address search
export const CATEGORIES = { station: ['metro', 'bus'], bar: ['amenity=bar'], restaurant: ['amenity=restaurant'] };
const CANDIDATE_CATEGORIES = new Set(Object.values(CATEGORIES).flat());
// Maximum candidates per category, by number of categories picked (fewer if fewer nearby)
const QUOTAS = {
    1: { station: 8, bar: 8, restaurant: 8 },
    2: { station: 4, bar: 4, restaurant: 4 },
    3: { station: 3, bar: 3, restaurant: 2 },
};

// Every place (OSM places, Tisséo GTFS stops) and the French label of each category, a static
// file served with the site
export async function loadData() {
    const res = await fetch('data/pois-toulouse.json');
    if (!res.ok) throw new Error(`data/pois-toulouse.json failed: ${res.status}`);
    return res.json();
}

// "YYYY-MM-DD HH:MM" + minutes, computed on the digits (read as UTC: no time zone shift)
const addMinutes = (local, minutes) => new Date(Date.parse(`${local.replace(' ', 'T')}:00Z`) + minutes * 60000)
    .toISOString().slice(0, 16).replace('T', ' ');

// Today's date (YYYY-MM-DD) in Toulouse, whatever the device time zone
const todayInToulouse = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Paris' }).format(new Date());

// Plain mean of latitudes and longitudes
function barycenter(points) {
    return {
        lat: points.reduce((s, p) => s + p.lat, 0) / points.length,
        lon: points.reduce((s, p) => s + p.lon, 0) / points.length,
    };
}

// Great-circle distance in meters
function haversine(a, b) {
    const rad = deg => deg * Math.PI / 180;
    const h = Math.sin(rad(b.lat - a.lat) / 2) ** 2
        + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(rad(b.lon - a.lon) / 2) ** 2;
    return 2 * 6371000 * Math.asin(Math.sqrt(h));
}

// Closest places of the picked categories within radius meters, within each category's quota
function candidatesWithin(places, center, categories, radius) {
    const seen = new Set();
    const nearby = places
        .map(p => ({ ...p, distance: Math.round(haversine(center, p)) }))
        .filter(p => p.distance <= radius)
        .sort((a, b) => a.distance - b.distance)
        // A place mapped twice under the same name counts once
        .filter(c => !seen.has(`${c.category}:${c.name}`) && seen.add(`${c.category}:${c.name}`));
    const quotas = QUOTAS[categories.length];
    return categories.flatMap(category => {
        const pool = nearby.filter(p => CATEGORIES[category].includes(p.category));
        const quota = quotas[category];
        if (category !== 'station') return pool.slice(0, quota);
        // Half of the stations (rounded up) go to the metro first, so that the numerous
        // bus stops do not crowd it out; the closest remaining stops fill the rest
        const metro = pool.filter(p => p.category === 'metro').slice(0, Math.ceil(quota / 2));
        return [...metro, ...pool.filter(p => !metro.includes(p)).slice(0, quota - metro.length)];
    }).sort((a, b) => a.distance - b.distance);
}

// The search radius grows by RADIUS_STEP_M until MIN_CANDIDATES are found, up to
// RADIUS_MAX_M (local data only: no API call, whatever the radius)
function findCandidates(places, center, categories) {
    const pool = places.filter(p => CANDIDATE_CATEGORIES.has(p.category));
    let radius = RADIUS_START_M;
    let candidates = candidatesWithin(pool, center, categories, radius);
    while (candidates.length < MIN_CANDIDATES && radius < RADIUS_MAX_M) {
        radius += RADIUS_STEP_M;
        candidates = candidatesWithin(pool, center, categories, radius);
    }
    return { candidates, radius };
}

// Fastest available mode of one participant to one candidate, null if none
function fastest(modeTimes) {
    return Object.entries(modeTimes)
        .filter(([, t]) => t.seconds != null)
        .reduce((best, [mode, t]) => (!best || t.seconds < best.seconds ? { mode, seconds: t.seconds } : best), null);
}

// participants: [{ name, lat, lon, modes }], slot: "HH:MM",
// categories: keys of CATEGORIES (1 to 3), transitEngine: key of TRANSIT_ENGINES,
// keys: { ors, tisseo }, data: from loadData(),
// calls: external API call counters, updated as calls are made
export async function evaluate({ participants, slot, categories, transitEngine = 'transitous' }, keys, data, calls, emit) {
    const date = todayInToulouse();
    const arriveFrom = `${date} ${slot}`;
    const arriveTo = addMinutes(arriveFrom, SLOT_MIN);
    const center = barycenter(participants);
    const base = { date, slot: { from: arriveFrom, to: arriveTo }, center, participants };
    emit({ type: 'start', ...base });

    const { candidates, radius } = findCandidates(data.places, center, categories);
    emit({ type: 'candidates', candidates, radius, sources: data.sources });
    if (!candidates.length) {
        emit({ type: 'result', ...base, candidates, best: null });
        return emit({ type: 'done' });
    }

    // times[i][j][mode] = { seconds } or { error } for participant i and candidate j
    const times = participants.map(() => candidates.map(() => ({})));

    // One openrouteservice matrix per mode
    const durations = {};
    await Promise.all(ORS_MODES.map(async mode => {
        const indices = participants.map((_, i) => i).filter(i => participants[i].modes.includes(mode));
        if (!indices.length) return;
        calls.orsMatrix++;
        const matrix = await durationMatrix(keys.ors, mode, indices.map(i => participants[i]), candidates);
        durations[mode] = new Map(indices.map((i, k) => [i, matrix.durations[k]]));
        emit({ type: 'matrix', mode, sources: indices.length, destinations: candidates.length,
            orsQuota: { service: 'matrix', ...matrix.quota } });
    }));

    const transitPairs = [];
    participants.forEach((p, i) => candidates.forEach((c, j) => {
        for (const mode of ORS_MODES.filter(m => p.modes.includes(m))) {
            const seconds = durations[mode].get(i)[j];
            times[i][j][mode] = seconds == null
                ? { error: 'itinéraire introuvable' }
                : { seconds: Math.round(seconds + (mode === 'car' ? CAR_PARKING_S : 0)) };
        }
        if (!p.modes.includes('transit')) return;
        transitPairs.push([i, j]);
    }));

    // Every candidate keeps its journeys (legs, lines, times): choosing another place needs no new call
    const engine = TRANSIT_ENGINES[transitEngine];
    // A technical failure (timeout, rate limit, server error) is tried once more after a pause;
    // if it fails again, the journey is marked failed: its candidate is incomplete (see below)
    const engineName = transitEngine === 'tisseo' ? 'Tisséo' : 'Transitous';
    const onCall = () => { calls[transitEngine]++; };
    const trip = (i, j) => engine.trip(keys, onCall, participants[i], candidates[j], arriveFrom, arriveTo);
    const tripWithRetry = async (i, j) => {
        try {
            return await trip(i, j);
        } catch (err) {
            if (err instanceof TisseoKeyError) throw err;
            console.warn(`${engineName} failed, trying again: ${err.message}`);
        }
        await new Promise(resolve => setTimeout(resolve, RETRY_DELAY_MS));
        try {
            return await trip(i, j);
        } catch (err) {
            // Tisséo unreachable twice in a row: most likely a refused key
            if (err.unreachable) throw new TisseoKeyError(err.message);
            throw err;
        }
    };
    let done = 0;
    let errors = 0;
    const progress = () => emit({ type: 'transit', engine: transitEngine, done, errors, total: transitPairs.length });
    progress();
    await forEachLimited(transitPairs, engine.parallel, async ([i, j]) => {
        try {
            const trip = await tripWithRetry(i, j);
            times[i][j].transit = trip == null
                ? { error: 'aucun trajet n\'arrive avant la fin de la plage' }
                : { seconds: trip.seconds, trip };
        } catch (err) {
            if (err instanceof TisseoKeyError) throw err;
            console.error(err);
            errors++;
            times[i][j].transit = { error: `${engineName} indisponible (2 essais)`, failed: true };
        }
        done++;
        progress();
    });

    // Score = sum of each participant's fastest time; null when someone cannot reach the candidate.
    // A candidate is incomplete when a transit journey to it failed: its score may be too high
    // (transit unknown, not impossible), so it is chosen only if no complete candidate is reachable
    const evaluated = candidates.map((c, j) => {
        const choices = participants.map((_, i) => fastest(times[i][j]));
        const score = choices.every(Boolean) ? choices.reduce((s, x) => s + x.seconds, 0) : null;
        const incomplete = participants.some((_, i) => times[i][j].transit?.failed);
        return { ...c, score, incomplete, choices, times: participants.map((_, i) => times[i][j]) };
    });
    const feasible = evaluated.filter(c => c.score != null);
    const pool = feasible.some(c => !c.incomplete) ? feasible.filter(c => !c.incomplete) : feasible;
    const best = pool.length
        ? evaluated.indexOf(pool.reduce((a, b) => (b.score < a.score ? b : a)))
        : null;

    emit({ type: 'result', ...base, candidates: evaluated, best });
    if (best != null) await placeRoutes(participants, evaluated[best], keys, calls, emit);
    emit({ type: 'done' });
}

// Paths to a place with each participant's retained mode, emitted as route events: the legs of
// the Transitous journey already fetched, or one openrouteservice directions call per participant
// (made only for the places actually displayed)
export async function placeRoutes(participants, place, keys, calls, emit) {
    await Promise.all(participants.map(async (p, i) => {
        const choice = place.choices[i];
        if (!choice) return emit({ type: 'route', place: place.id, participant: i, legs: null, error: 'injoignable' });
        const { mode } = choice;
        if (mode === 'transit') {
            const legs = place.times[i].transit.trip?.legs;
            return emit({ type: 'route', place: place.id, participant: i, mode, legs: legs || null, error: legs ? null : 'tracé indisponible' });
        }
        try {
            calls.orsDirections++;
            const route = await routePath(keys.ors, mode, p, place);
            emit({ type: 'route', place: place.id, participant: i, mode, legs: [{ kind: mode, path: route.path }],
                orsQuota: { service: 'directions', ...route.quota } });
        } catch (err) {
            console.error(err);
            emit({ type: 'route', place: place.id, participant: i, mode, legs: null, error: 'tracé indisponible' });
        }
    }));
}
