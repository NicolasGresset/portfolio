// tisseo.js - Tisséo OpenData API v2 journeys access from the browser, with the user's own key.
// Plain GET with the key in the query string (as documented), so no CORS preflight is needed.
//
// journeys only takes a departure window, so departures are searched from DEPARTURE_LEAD_MIN
// before the arrival slot to its end, and the latest departure arriving within the slot is kept.

const DEPARTURE_LEAD_MIN = 40;
const MAX_JOURNEYS = 8; // API maximum
const MAX_PARALLEL = 4; // concurrent journeys requests
const TIMEOUT_MS = 10000;

// area: approximate bounding box of the Tisséo network (data/tisseo-area.json)
export const inArea = (area, p) => p.lat >= area.minLat && p.lat <= area.maxLat
    && p.lon >= area.minLon && p.lon <= area.maxLon;

// Local times are handled as "YYYY-MM-DD HH:MM[:SS]" strings, read as UTC to avoid
// any time zone shift (they are only compared and subtracted with each other)
const parseLocal = str => new Date(`${str.replace(' ', 'T')}Z`);
const formatLocal = date => date.toISOString().slice(0, 16).replace('T', ' ');
export const addMinutes = (str, minutes) => formatLocal(new Date(parseLocal(str).getTime() + minutes * 60000));

// WKT LINESTRING or MULTILINESTRING ("x y" = "lon lat") -> lists of [lat, lon] pairs
const parseWkt = wkt => [...wkt.matchAll(/\(([^()]+)\)/g)]
    .map(([, coords]) => coords.split(',').map(xy => {
        const [lon, lat] = xy.trim().split(/\s+/).map(Number);
        return [Math.round(lat * 1e5) / 1e5, Math.round(lon * 1e5) / 1e5];
    }));

// Journey chunks -> drawable legs: walking portions and transit lines
function journeyLegs(journey) {
    return (journey.chunks || []).flatMap(chunk => {
        if (chunk.street?.wkt) return parseWkt(chunk.street.wkt).map(path => ({ kind: 'walk', path }));
        if (chunk.service?.wkt) {
            const line = chunk.service.destinationStop?.line;
            return parseWkt(chunk.service.wkt).map(path => ({
                kind: 'line', path, line: line?.shortName ?? null, mode: line?.transportMode?.name ?? null,
            }));
        }
        return [];
    });
}

// Transit trip (walking included) arriving within [arriveFrom, arriveTo], for the latest
// departure: { seconds, legs }, or null when no journey arrives within the slot
export async function transitTrip(key, from, to, arriveFrom, arriveTo) {
    const params = new URLSearchParams({
        departurePlaceXY:       `${from.lon},${from.lat}`,
        arrivalPlaceXY:         `${to.lon},${to.lat}`,
        firstDepartureDatetime: addMinutes(arriveFrom, -DEPARTURE_LEAD_MIN),
        lastDepartureDatetime:  arriveTo,
        number:                 MAX_JOURNEYS,
        key,
    });
    let res;
    try {
        res = await fetch(`https://api.tisseo.fr/v2/journeys.json?${params}`, { signal: AbortSignal.timeout(TIMEOUT_MS) });
    } catch (err) {
        // Error answers (e.g. invalid key) come without CORS headers: the browser only sees a network failure
        throw new Error(`Tisseo journeys unreachable (${err.name}), invalid key?`);
    }
    if (!res.ok) throw new Error(`Tisseo journeys failed: ${res.status}`);
    const data = await res.json();
    const journeys = (data.routePlannerResult?.journeys ?? data.journeys ?? []).map(j => j.journey);

    const valid = journeys.filter(j => {
        const arrival = parseLocal(j.arrivalDateTime);
        return arrival >= parseLocal(arriveFrom) && arrival <= parseLocal(arriveTo);
    });
    if (!valid.length) return null;
    const latest = valid.reduce((a, b) => (parseLocal(b.departureDateTime) > parseLocal(a.departureDateTime) ? b : a));
    return {
        seconds: (parseLocal(latest.arrivalDateTime) - parseLocal(latest.departureDateTime)) / 1000,
        legs:    journeyLegs(latest),
    };
}

// Run fn on every item with limited concurrency
export async function forEachLimited(items, fn) {
    const queue = [...items];
    const worker = async () => {
        for (let item = queue.shift(); item; item = queue.shift()) await fn(item);
    };
    await Promise.all(Array.from({ length: MAX_PARALLEL }, worker));
}
