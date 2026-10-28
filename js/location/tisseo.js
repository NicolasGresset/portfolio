// tisseo.js - Transit journeys from the Tisséo API (https://api.tisseo.fr, ODbL data), called
// straight from the browser with the visitor's own key, like openrouteservice. Tisséo allows a
// public key in web pages (its developer documentation, § 2.7) and sends CORS headers, but only
// on XML answers (checked 2026-10-28): the journeys are read as XML.
//
// Tisséo only searches by departure time, so arriving by the end of the slot takes two calls of
// a few successive journeys each: the first leaves an hour before the end of the slot and gives
// the shortest travel time, the second leaves that long (plus a margin) before the end of the
// slot; of both, the best journey is picked as with Transitous (bestJourney: arriving early is
// allowed, the wait until the slot starts counting in its time).
// Same contract as transitTrip in transitous.js.

import { parseParis, bestJourney } from './transitous.js';

const JOURNEYS_URL = 'https://api.tisseo.fr/v2/journeys.xml';
const TIMEOUT_MS = 15000;
const PROBE_LEAD_MIN = 60;  // first call: leave this long before the end of the slot
const MARGIN_MIN = 10;      // second call: leave this much earlier than the travel time requires
const JOURNEYS_PER_CALL = 4;

// Unix ms -> "YYYY-MM-DD HH:MM" in Toulouse
const formatParis = ms => new Intl.DateTimeFormat('sv-SE', {
    timeZone: 'Europe/Paris', dateStyle: 'short', timeStyle: 'short',
}).format(new Date(ms));

// "HH:MM[:SS]" on the day of dayStart (Unix ms of the journey's departure), the next day when
// earlier than dayStart (a journey past midnight)
function timeOnDay(time, dayStart) {
    const day = formatParis(dayStart).slice(0, 10);
    const ms = parseParis(`${day} ${time.slice(0, 5)}`).getTime() + (Number(time.slice(6, 8)) || 0) * 1000;
    return ms < dayStart - 60000 ? ms + 86400000 : ms;
}

// WKT (MULTI)LINESTRING -> [lat, lon] pairs
function wktPath(wkt) {
    return [...String(wkt || '').matchAll(/(-?\d+(?:\.\d+)?) (-?\d+(?:\.\d+)?)/g)]
        .map(([, lon, lat]) => [Math.round(Number(lat) * 1e5) / 1e5, Math.round(Number(lon) * 1e5) / 1e5]);
}

// "Ramonville RAMONVILLE-SAINT-AGNE" -> "Ramonville": the city Tisséo appends in capitals
const headsign = name => String(name || '').replace(/\s+[A-ZÀ-Ý][A-ZÀ-Ý' -]{2,}$/, '') || null;

// One <journey> -> { departure, arrival (Unix ms), legs }, null without any transit line.
// Its departure is the latest one that still catches the first line: Tisséo starts walking at
// the requested time and waits at the stop
function readJourney(journey) {
    const start = parseParis(journey.getAttribute('departureDateTime').slice(0, 16)).getTime();
    const legs = [];
    let walk = null;
    let lastStop = null;
    const chunks = journey.querySelector('chunks')?.children || [];
    for (const chunk of chunks) {
        const attr = name => chunk.getAttribute(name);
        if (chunk.tagName === 'street') {
            const from = timeOnDay(attr('departureTime'), start);
            const to = timeOnDay(attr('arrivalTime'), start);
            if (!walk) walk = { kind: 'walk', path: [], from: lastStop, to: null, departure: from, arrival: to, seconds: 0 };
            walk.path.push(...wktPath(attr('wkt')));
            walk.arrival = to;
            walk.seconds += (to - from) / 1000;
        } else if (chunk.tagName === 'stop') {
            lastStop = attr('name') || null;
            const previous = legs[legs.length - 1];
            if (walk) {
                walk.to = lastStop;
                legs.push(walk);
                walk = null;
            } else if (previous?.kind === 'line' && !previous.to) {
                previous.to = lastStop; // where the line is left
            }
        } else if (chunk.tagName === 'service') {
            // Tisséo may give no stop between a walk and the line it leads to
            if (walk) {
                legs.push(walk);
                walk = null;
            }
            const destination = chunk.querySelector('destinationStop');
            const line = destination?.querySelector('line');
            const color = line?.getAttribute('bgXmlColor') || '';
            legs.push({
                kind:      'line',
                path:      wktPath(attr('wkt')),
                from:      lastStop,
                to:        null, // set by the next stop
                departure: timeOnDay(attr('firstDepartureTime'), start),
                arrival:   timeOnDay(attr('firstArrivalTime'), start),
                mode:      (line?.querySelector('transportMode')?.getAttribute('name') || 'ligne').toLowerCase(),
                line:      line?.getAttribute('shortName') || null,
                headsign:  headsign(destination?.getAttribute('name')),
                color:     /^#[0-9a-f]{6}$/i.test(color) ? color : null,
                stops:     null, // Tisséo does not give the stops travelled
            });
        }
    }
    if (walk) legs.push(walk);
    const firstLine = legs.findIndex(l => l.kind === 'line');
    if (firstLine < 0) return null;

    // Walk to the first line only just in time: shift it to end at the line's departure
    if (firstLine === 1) {
        legs[0].departure = legs[1].departure - legs[0].seconds * 1000;
        legs[0].arrival = legs[1].departure;
    }
    legs.filter(l => l.kind === 'line').forEach(l => { l.seconds = (l.arrival - l.departure) / 1000; });
    return { departure: legs[0].departure, arrival: legs[legs.length - 1].arrival, legs };
}

// Journeys leaving from the given time (Unix ms), [] when Tisséo finds none
async function journeys(key, onCall, from, to, departure, number) {
    const params = new URLSearchParams({
        key,
        departurePlaceXY:       `${from.lon},${from.lat}`,
        arrivalPlaceXY:         `${to.lon},${to.lat}`,
        firstDepartureDatetime: formatParis(departure),
        number,
        lang:                   'fr',
    });
    let res;
    onCall();
    try {
        res = await fetch(`${JOURNEYS_URL}?${params}`, { signal: AbortSignal.timeout(TIMEOUT_MS) });
    } catch (err) {
        // A refused key comes back without CORS headers: the browser only sees a network error
        if (err.name === 'TypeError') throw new Error('Tisséo injoignable ou clé Tisséo refusée.');
        throw err;
    }
    if (res.status === 404) return []; // no journey found
    if (res.status === 401 || res.status === 403) throw new Error('Clé Tisséo refusée.');
    if (!res.ok) throw new Error(`Tisséo journeys failed: ${res.status}`);
    const xml = new DOMParser().parseFromString(await res.text(), 'application/xml');
    return [...xml.querySelectorAll('journeys > journey')].map(readJourney).filter(Boolean);
}

// Transit trip (walking included) to be there for the slot [arriveFrom, arriveTo]
// ("YYYY-MM-DD HH:MM" in Toulouse): { seconds (wait included), wait, departure, arrival, legs }
// (times in ISO), or null when no journey arrives by the end of the slot
// onCall: called before each Tisséo request (two per trip)
export async function tisseoTrip(key, onCall, from, to, arriveFrom, arriveTo) {
    const slotEnd = parseParis(arriveTo).getTime();
    const probe = await journeys(key, onCall, from, to, slotEnd - PROBE_LEAD_MIN * 60000, JOURNEYS_PER_CALL);
    if (!probe.length) return null;
    const travel = Math.min(...probe.map(j => j.arrival - j.departure));
    const later = await journeys(key, onCall, from, to, slotEnd - travel - MARGIN_MIN * 60000, JOURNEYS_PER_CALL);
    const found = bestJourney([...probe, ...later], arriveFrom, arriveTo);
    if (!found) return null;
    const best = found.journey;
    const iso = ms => new Date(ms).toISOString();
    return {
        seconds:   found.seconds,
        wait:      found.wait,
        departure: iso(best.departure),
        arrival:   iso(best.arrival),
        legs:      best.legs.map(l => ({ ...l, departure: iso(l.departure), arrival: iso(l.arrival) })),
    };
}
