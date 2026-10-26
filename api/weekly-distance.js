// api/weekly-distance.js - Vercel serverless function returning weekly running distance from intervals.icu
//
// Required environment variables: INTERVALS_API_KEY, INTERVALS_ATHLETE_ID (see api/activities.js)

const RUN_TYPES = ['Run', 'TrailRun', 'VirtualRun'];
const WEEKS = 8;
const DAY_MS = 86400 * 1000;

// Monday (YYYY-MM-DD) of the week containing a YYYY-MM-DD local date
function weekStart(day) {
    const d = new Date(`${day}T00:00:00Z`);
    d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7));
    return d.toISOString().slice(0, 10);
}

module.exports = async (req, res) => {
    try {
        // One bucket per week, oldest first, ending with the current week
        const currentWeek = weekStart(new Date().toISOString().slice(0, 10));
        const weeks = Array.from({ length: WEEKS }, (_, i) => ({
            week: new Date(Date.parse(currentWeek) - (WEEKS - 1 - i) * 7 * DAY_MS).toISOString().slice(0, 10),
            km:   0,
        }));
        const byWeek = new Map(weeks.map(w => [w.week, w]));

        const auth = Buffer.from(`API_KEY:${process.env.INTERVALS_API_KEY}`).toString('base64');
        const apiRes = await fetch(
            `https://intervals.icu/api/v1/athlete/${process.env.INTERVALS_ATHLETE_ID}/activities?oldest=${weeks[0].week}`,
            { headers: { Authorization: `Basic ${auth}` } },
        );
        if (!apiRes.ok) throw new Error(`intervals.icu activities fetch failed: ${apiRes.status}`);

        for (const a of await apiRes.json()) {
            const bucket = a.start_date_local && byWeek.get(weekStart(a.start_date_local.slice(0, 10)));
            if (bucket && RUN_TYPES.includes(a.type) && a.distance) bucket.km += a.distance / 1000;
        }
        weeks.forEach(w => { w.km = Math.round(w.km * 10) / 10; });

        res.setHeader('Cache-Control', 's-maxage=3600, stale-while-revalidate=86400');
        res.status(200).json(weeks);
    } catch (err) {
        console.error(err);
        res.setHeader('Cache-Control', 'no-store');
        res.status(502).json({ error: 'Weekly distance unavailable' });
    }
};
