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

const ORS_MODES = ['walk', 'bike', 'car'];
const SLOT_MIN = 15;
const CAR_PARKING_S = 5 * 60;      // fixed time to park, added to every car trip
const SEARCH_RADIUS_M = 1000;
const PER_KIND = 2;                // so that the numerous bus stops do not crowd out the rest
const KINDS = ['bar', 'square', 'metro', 'bus'];

// Candidate places (OSM bars and squares, Tisséo GTFS stops), a static file served with the site
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

function findCandidates(pois, center) {
    const seen = new Set();
    const perKind = {};
    return pois
        .filter(p => KINDS.includes(p.kind))
        .map(p => ({ ...p, distance: Math.round(haversine(center, p)) }))
        .filter(p => p.distance <= SEARCH_RADIUS_M)
        .sort((a, b) => a.distance - b.distance)
        // A place mapped twice under the same name counts once
        .filter(c => !seen.has(`${c.kind}:${c.name}`) && seen.add(`${c.kind}:${c.name}`))
        .filter(c => (perKind[c.kind] = (perKind[c.kind] || 0) + 1) <= PER_KIND);
}

// Fastest available mode of one participant to one candidate, null if none
function fastest(modeTimes) {
    return Object.entries(modeTimes)
        .filter(([, t]) => t.seconds != null)
        .reduce((best, [mode, t]) => (!best || t.seconds < best.seconds ? { mode, seconds: t.seconds } : best), null);
}

// participants: [{ name, lat, lon, modes }], slot: "HH:MM", keys: { ors },
// data: from loadData(), calls: external API call counters, updated as calls are made
export async function evaluate({ participants, slot }, keys, data, calls, emit) {
    const date = todayInToulouse();
    const arriveFrom = `${date} ${slot}`;
    const arriveTo = addMinutes(arriveFrom, SLOT_MIN);
    const center = barycenter(participants);
    const base = { date, slot: { from: arriveFrom, to: arriveTo }, center, participants };
    emit({ type: 'start', ...base });

    const candidates = findCandidates(data.pois, center);
    emit({ type: 'candidates', candidates, sources: data.sources });
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
    let done = 0;
    emit({ type: 'transit', done, total: transitPairs.length });
    await forEachLimited(transitPairs, async ([i, j]) => {
        try {
            calls.transitous++;
            const trip = await transitTrip(participants[i], candidates[j], arriveFrom, arriveTo);
            times[i][j].transit = trip == null ? { error: 'aucun trajet n\'arrive dans la plage' } : { seconds: trip.seconds, trip };
        } catch (err) {
            console.error(err);
            times[i][j].transit = { error: 'erreur Transitous' };
        }
        emit({ type: 'transit', done: ++done, total: transitPairs.length });
    });

    // Score = sum of each participant's fastest time; null when someone cannot reach the candidate
    const evaluated = candidates.map((c, j) => {
        const choices = participants.map((_, i) => fastest(times[i][j]));
        const score = choices.every(Boolean) ? choices.reduce((s, x) => s + x.seconds, 0) : null;
        return { ...c, score, choices, times: participants.map((_, i) => times[i][j]) };
    });
    const feasible = evaluated.filter(c => c.score != null);
    const best = feasible.length
        ? evaluated.indexOf(feasible.reduce((a, b) => (b.score < a.score ? b : a)))
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
