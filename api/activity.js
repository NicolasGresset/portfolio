// api/activity.js - Vercel serverless function returning one run with pace/HR series and detected intervals
//
// Usage: /api/activity?id=i201985934
// Required environment variables: see api/_lib/intervals.js

const { detectIntervals, resample, smoothSpeed } = require('./_lib/detect-intervals');
const { RUN_TYPES, intervalsGet, getStreams } = require('./_lib/intervals');
const { rejectUnknownParams } = require('./_lib/query');

const CHART_SMOOTH_HALF_WINDOW = 15; // s, pace on the chart is averaged over 31 s
const CHART_BUCKET_S = 10;            // one chart point per 10 s
const STOP_SPEED = 1.2;               // m/s, no pace is drawn below this (standing, slow walking)

module.exports = async (req, res) => {
    if (rejectUnknownParams(req, res, ['id'])) return;
    const id = req.query && req.query.id;
    // No leading zero: one cache entry per activity
    if (!/^i?[1-9]\d*$/.test(id || '')) return res.status(400).json({ error: 'Invalid activity id' });

    try {
        const [a, streams] = await Promise.all([intervalsGet(`/activity/${id}`), getStreams(id)]);
        // The key may read other athletes' activities (shared, followed): only the site owner's runs
        if (a.icu_athlete_id !== process.env.INTERVALS_ATHLETE_ID || !RUN_TYPES.includes(a.type)) {
            return res.status(404).json({ error: 'Not a run' });
        }

        const { time, distance, heartrate } = streams;
        const { label, segments } = detectIntervals({ time, distance, heartrate }, a.icu_hr_zones);

        // Chart series: smoother than what detection uses, one averaged point per bucket
        const { dist, hr, T } = resample(time, distance, heartrate);
        const v = smoothSpeed(dist, T, CHART_SMOOTH_HALF_WINDOW);
        const series = { km: [], pace: [], hr: [] };
        for (let a0 = 0; a0 < T; a0 += CHART_BUCKET_S) {
            const b0 = Math.min(a0 + CHART_BUCKET_S, T);
            const mid = Math.round((a0 + b0) / 2);
            let hrSum = 0;
            for (let s = a0; s < b0; s++) hrSum += hr ? hr[s] : 0;
            series.km.push(Math.round(dist[mid]) / 1000);
            series.pace.push(v[mid] > STOP_SPEED ? Math.round(1000 / v[mid]) : null); // s/km
            series.hr.push(hr ? Math.round(hrSum / (b0 - a0)) : null);
        }

        res.setHeader('Cache-Control', 's-maxage=3600, stale-while-revalidate=86400');
        res.status(200).json({
            id:           a.id,
            name:         a.name,
            description:  a.description,
            date:         a.start_date_local,
            distance:     a.distance,
            movingTime:   a.moving_time,
            averageSpeed: a.average_speed,
            averageHr:    a.average_heartrate ?? null,
            label,
            segments: segments.map(s => ({
                type:     s.type,
                startKm:  s.startKm,
                endKm:    s.endKm,
                distance: s.distance,
                duration: s.duration,
                hr:       s.hr && Math.round(s.hr),
                splits:   s.splits.map(k => ({ distance: k.distance, duration: k.duration, hr: k.hr && Math.round(k.hr) })),
            })),
            series,
        });
    } catch (err) {
        console.error(err);
        res.setHeader('Cache-Control', 'no-store');
        res.status(err.status === 404 ? 404 : 502).json({ error: 'Activity unavailable' });
    }
};
