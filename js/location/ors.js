// ors.js - openrouteservice access from the browser: matrix (durations) and directions (paths)
// with the user's own API key. The services ignore the time of day.

const TIMEOUT_MS = 15000;
const PROFILES = { walk: 'foot-walking', bike: 'cycling-regular', car: 'driving-car' };

const round = x => Math.round(x * 1e5) / 1e5;

async function orsPost(key, path, body) {
    const res = await fetch(`https://api.openrouteservice.org/v2/${path}`, {
        method:  'POST',
        headers: { Authorization: key, 'Content-Type': 'application/json' },
        body:    JSON.stringify(body),
        signal:  AbortSignal.timeout(TIMEOUT_MS),
    });
    if (res.status === 401 || res.status === 403) throw new Error('Clé openrouteservice refusée.');
    if (res.status === 429) throw new Error('Quota openrouteservice dépassé.');
    if (!res.ok) throw new Error(`openrouteservice ${path} failed: ${res.status}`);
    // Quota left on this service for the API key, as reported by the response headers
    const header = name => (res.headers.get(name) != null ? Number(res.headers.get(name)) : null);
    const quota = {
        limit:     header('x-ratelimit-limit'),
        remaining: header('x-ratelimit-remaining'),
        reset:     header('x-ratelimit-reset'), // Unix time (s)
    };
    return { data: await res.json(), quota };
}

// Durations in seconds, rows = sources, columns = destinations, null when unroutable
export async function durationMatrix(key, mode, sources, destinations) {
    const { data, quota } = await orsPost(key, `matrix/${PROFILES[mode]}`, {
        locations:    [...sources, ...destinations].map(p => [p.lon, p.lat]),
        sources:      sources.map((_, i) => i),
        destinations: destinations.map((_, j) => sources.length + j),
        metrics:      ['duration'],
    });
    return { durations: data.durations, quota };
}

// Path from one point to another, as [lat, lon] pairs
export async function routePath(key, mode, from, to) {
    const { data, quota } = await orsPost(key, `directions/${PROFILES[mode]}/geojson`, {
        coordinates: [[from.lon, from.lat], [to.lon, to.lat]],
    });
    const path = data.features[0].geometry.coordinates.map(([lon, lat]) => [round(lat), round(lon)]);
    return { path, quota };
}
