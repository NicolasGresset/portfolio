// transitous.js - Transit journeys from Transitous (https://transitous.org), a community-run
// routing service built on the networks' open GTFS data. No key; usage policy:
// https://transitous.org/api/ (open-source, non-commercial, light use, attribution). From a
// browser the Referer header identifies the site, which shows a contact address.
//
// /plan is asked for journeys arriving by the end of the slot; those arriving within the slot
// are kept, and the one with the latest departure wins.

const PLAN_URL = 'https://api.transitous.org/api/v6/plan';
const MAX_PARALLEL = 3; // concurrent requests, to stay light on Transitous servers
const TIMEOUT_MS = 15000;
const MODE_NAMES = {
    SUBWAY: 'métro', TRAM: 'tram', BUS: 'bus', COACH: 'car', RAIL: 'train', REGIONAL_RAIL: 'TER',
    SUBURBAN: 'train', FERRY: 'bateau', AERIAL_LIFT: 'téléphérique', FUNICULAR: 'funiculaire',
};

// UTC offset of Europe/Paris at a given date, e.g. "+01:00"
function parisOffset(date) {
    const name = new Intl.DateTimeFormat('en-US', { timeZone: 'Europe/Paris', timeZoneName: 'longOffset' })
        .formatToParts(new Date(`${date}T12:00:00Z`)).find(p => p.type === 'timeZoneName').value;
    return name === 'GMT' ? '+00:00' : name.slice(3);
}

// "YYYY-MM-DD HH:MM" in Toulouse -> Date
export const parseParis = local => {
    const [date, time] = local.split(' ');
    return new Date(`${date}T${time}:00${parisOffset(date)}`);
};

// Encoded polyline (Google format) -> [lat, lon] pairs
function decodePolyline(points, precision) {
    const factor = 10 ** precision;
    const path = [];
    let lat = 0;
    let lon = 0;
    for (let i = 0; i < points.length;) {
        for (const axis of [0, 1]) {
            let shift = 0;
            let value = 0;
            let byte;
            do {
                byte = points.charCodeAt(i++) - 63;
                value |= (byte & 0x1f) << shift;
                shift += 5;
            } while (byte >= 0x20);
            const delta = value & 1 ? ~(value >> 1) : value >> 1;
            if (axis === 0) lat += delta; else lon += delta;
        }
        path.push([Math.round(lat / factor * 1e5) / 1e5, Math.round(lon / factor * 1e5) / 1e5]);
    }
    return path;
}

// Itinerary legs -> walking portions and transit lines, with what the page shows and draws
function itineraryLegs(itinerary) {
    return itinerary.legs.map(leg => {
        const common = {
            path:      leg.legGeometry?.points ? decodePolyline(leg.legGeometry.points, leg.legGeometry.precision) : [],
            from:      leg.from?.name ?? null,
            to:        leg.to?.name ?? null,
            departure: leg.startTime,
            arrival:   leg.endTime,
            seconds:   (Date.parse(leg.endTime) - Date.parse(leg.startTime)) / 1000,
        };
        if (leg.mode === 'WALK') return { kind: 'walk', ...common };
        return {
            kind:     'line',
            ...common,
            mode:     MODE_NAMES[leg.mode] || leg.mode.toLowerCase(),
            line:     leg.routeShortName ?? null,
            headsign: leg.headsign ?? null,
            color:    /^#?[0-9a-f]{6}$/i.test(leg.routeColor || '') ? `#${leg.routeColor.replace('#', '')}` : null,
            stops:    (leg.intermediateStops?.length ?? 0) + 1, // stops travelled, the alighting one included
        };
    });
}

// Transit trip (walking included) arriving within [arriveFrom, arriveTo] ("YYYY-MM-DD HH:MM"
// in Toulouse), for the latest departure: { seconds, departure, arrival, legs } (times in ISO),
// or null when none arrives in the slot
export async function transitTrip(from, to, arriveFrom, arriveTo) {
    const params = new URLSearchParams({
        fromPlace: `${from.lat},${from.lon}`,
        toPlace:   `${to.lat},${to.lon}`,
        time:      parseParis(arriveTo).toISOString(),
        arriveBy:  'true',
    });
    const res = await fetch(`${PLAN_URL}?${params}`, { signal: AbortSignal.timeout(TIMEOUT_MS) });
    if (res.status === 429) throw new Error('Transitous rate limit reached');
    if (!res.ok) throw new Error(`Transitous plan failed: ${res.status}`);
    const data = await res.json();

    const slotStart = parseParis(arriveFrom).getTime();
    const slotEnd = parseParis(arriveTo).getTime();
    const valid = (data.itineraries || []).filter(it => {
        const arrival = Date.parse(it.endTime);
        return arrival >= slotStart && arrival <= slotEnd && it.legs.some(leg => leg.mode !== 'WALK');
    });
    if (!valid.length) return null;
    const latest = valid.reduce((a, b) => (Date.parse(b.startTime) > Date.parse(a.startTime) ? b : a));
    return {
        seconds:   (Date.parse(latest.endTime) - Date.parse(latest.startTime)) / 1000,
        departure: latest.startTime,
        arrival:   latest.endTime,
        legs:      itineraryLegs(latest),
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
