// intervals.js - Shared intervals.icu access for the api/ functions
//
// Required environment variables (Vercel > Settings > Environment Variables):
//   INTERVALS_API_KEY, INTERVALS_ATHLETE_ID (both in intervals.icu > Settings > Developer Settings)

const { detectIntervals } = require('./detect-intervals');

const RUN_TYPES  = ['Run', 'TrailRun', 'VirtualRun'];
const RIDE_TYPES = ['Ride', 'GravelRide', 'MountainBikeRide', 'VirtualRide', 'EBikeRide'];
const MAX_PARALLEL = 3; // concurrent stream downloads, to stay under intervals.icu rate limit
const MAX_RETRIES = 3;

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

async function intervalsGet(path) {
    const auth = Buffer.from(`API_KEY:${process.env.INTERVALS_API_KEY}`).toString('base64');
    for (let attempt = 0; ; attempt++) {
        const res = await fetch(`https://intervals.icu/api/v1${path}`, { headers: { Authorization: `Basic ${auth}` } });
        // Rate limited: wait as asked (or back off exponentially) and retry
        if (res.status === 429 && attempt < MAX_RETRIES) {
            const retryAfter = Number(res.headers.get('retry-after'));
            await sleep(retryAfter > 0 ? retryAfter * 1000 : 1000 * 2 ** attempt);
            continue;
        }
        if (!res.ok) throw Object.assign(new Error(`intervals.icu ${path} failed: ${res.status}`), { status: res.status });
        return res.json();
    }
}

// Activities since a YYYY-MM-DD date
const listActivities = oldest => intervalsGet(`/athlete/${process.env.INTERVALS_ATHLETE_ID}/activities?oldest=${oldest}`);

// time/distance/heartrate streams of one activity (never GPS)
async function getStreams(id) {
    const streams = await intervalsGet(`/activity/${id}/streams.json?types=time,distance,heartrate`);
    const stream = type => (streams.find(s => s.type === type) || {}).data;
    return { time: stream('time'), distance: stream('distance'), heartrate: stream('heartrate') };
}

// Detected intervals of a run, from its list entry (which carries the HR zones)
async function analyzeRun(activity) {
    return detectIntervals(await getStreams(activity.id), activity.icu_hr_zones);
}

// Analyze several runs with limited concurrency; a failing run gets null instead of failing all
async function analyzeRuns(activities) {
    const results = new Map();
    const queue = [...activities];
    const worker = async () => {
        for (let a = queue.shift(); a; a = queue.shift()) {
            try {
                results.set(a.id, await analyzeRun(a));
            } catch (err) {
                console.error(err);
                results.set(a.id, null);
            }
        }
    };
    await Promise.all(Array.from({ length: MAX_PARALLEL }, worker));
    return results;
}

module.exports = { RUN_TYPES, RIDE_TYPES, intervalsGet, listActivities, getStreams, analyzeRuns };
