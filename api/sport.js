// api/sport.js - Vercel serverless function feeding the sport page from intervals.icu
// (activities are synced there from Garmin Connect):
//   - activities: recent runs and rides, runs labelled with their detected intervals
//   - weeks: weekly running distance, split into easy and quality km
// Each run is analyzed once for both, to stay under intervals.icu rate limit.

const { RUN_TYPES, RIDE_TYPES, listActivities, analyzeRuns } = require('./_lib/intervals');
const { rejectUnknownParams } = require('./_lib/query');

const MAX_ACTIVITIES = 12;
const WEEKS = 8;
const DAY_MS = 86400 * 1000;

// Monday (YYYY-MM-DD) of the week containing a YYYY-MM-DD local date
function weekStart(day) {
    const d = new Date(`${day}T00:00:00Z`);
    d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7));
    return d.toISOString().slice(0, 10);
}

module.exports = async (req, res) => {
    if (rejectUnknownParams(req, res)) return;
    try {
        // One bucket per week, oldest first, ending with the current week
        const currentWeek = weekStart(new Date().toISOString().slice(0, 10));
        const weeks = Array.from({ length: WEEKS }, (_, i) => ({
            week:    new Date(Date.parse(currentWeek) - (WEEKS - 1 - i) * 7 * DAY_MS).toISOString().slice(0, 10),
            easy:    0,
            quality: 0,
        }));
        const byWeek = new Map(weeks.map(w => [w.week, w]));

        const all = (await listActivities(weeks[0].week))
            .filter(a => a.start_date_local && (RUN_TYPES.includes(a.type) || RIDE_TYPES.includes(a.type)))
            .sort((a, b) => b.start_date_local.localeCompare(a.start_date_local));
        const recent = all.slice(0, MAX_ACTIVITIES);
        const runs = all.filter(a => RUN_TYPES.includes(a.type) && a.distance);
        const analyses = await analyzeRuns(runs);

        for (const a of runs) {
            const bucket = byWeek.get(weekStart(a.start_date_local.slice(0, 10)));
            if (!bucket) continue;
            // Quality share from detected segments, rescaled to the activity's official distance
            const segments = analyses.get(a.id)?.segments || [];
            const total = segments.reduce((s, x) => s + x.distance, 0);
            const quality = segments.filter(x => x.quality).reduce((s, x) => s + x.distance, 0);
            const km = a.distance / 1000;
            const qualityKm = total > 0 ? km * quality / total : 0;
            bucket.quality += qualityKm;
            bucket.easy += km - qualityKm;
        }
        weeks.forEach(w => {
            w.easy = Math.round(w.easy * 10) / 10;
            w.quality = Math.round(w.quality * 10) / 10;
        });

        const activities = recent.map(a => ({
            id:           a.id,
            name:         a.name,
            kind:         RUN_TYPES.includes(a.type) ? 'run' : 'ride',
            label:        analyses.get(a.id)?.label ?? null,
            date:         a.start_date_local,
            distance:     a.distance,                    // meters
            movingTime:   a.moving_time,                 // seconds
            averageSpeed: a.average_speed,               // m/s
            averageHr:    a.average_heartrate ?? null,   // bpm, absent without HR monitor
        }));

        // Cache on Vercel's CDN for 1h, serve stale up to 1 day while revalidating
        res.setHeader('Cache-Control', 's-maxage=3600, stale-while-revalidate=86400');
        res.status(200).json({ activities, weeks });
    } catch (err) {
        console.error(err);
        res.setHeader('Cache-Control', 'no-store');
        res.status(502).json({ error: 'Sport data unavailable' });
    }
};
