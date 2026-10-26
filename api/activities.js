// api/activities.js - Vercel serverless function returning recent runs and rides from intervals.icu
// (activities are synced there from Garmin Connect)
//
// Required environment variables (Vercel > Settings > Environment Variables):
//   INTERVALS_API_KEY, INTERVALS_ATHLETE_ID (both in intervals.icu > Settings > Developer Settings)

const RUN_TYPES  = ['Run', 'TrailRun', 'VirtualRun'];
const RIDE_TYPES = ['Ride', 'GravelRide', 'MountainBikeRide', 'VirtualRide', 'EBikeRide'];
const MAX_ACTIVITIES = 12;
const LOOKBACK_DAYS  = 90;

module.exports = async (req, res) => {
    try {
        const oldest = new Date(Date.now() - LOOKBACK_DAYS * 86400 * 1000).toISOString().slice(0, 10);
        const auth = Buffer.from(`API_KEY:${process.env.INTERVALS_API_KEY}`).toString('base64');
        const apiRes = await fetch(
            `https://intervals.icu/api/v1/athlete/${process.env.INTERVALS_ATHLETE_ID}/activities?oldest=${oldest}`,
            { headers: { Authorization: `Basic ${auth}` } },
        );
        if (!apiRes.ok) throw new Error(`intervals.icu activities fetch failed: ${apiRes.status}`);

        const activities = (await apiRes.json())
            .filter(a => RUN_TYPES.includes(a.type) || RIDE_TYPES.includes(a.type))
            .sort((a, b) => b.start_date_local.localeCompare(a.start_date_local))
            .slice(0, MAX_ACTIVITIES)
            .map(a => ({
                name:         a.name,
                kind:         RUN_TYPES.includes(a.type) ? 'run' : 'ride',
                date:         a.start_date_local,
                distance:     a.distance,                    // meters
                movingTime:   a.moving_time,                 // seconds
                averageSpeed: a.average_speed,               // m/s
                averageHr:    a.average_heartrate ?? null,   // bpm, absent without HR monitor
            }));

        // Cache on Vercel's CDN for 1h, serve stale up to 1 day while revalidating
        res.setHeader('Cache-Control', 's-maxage=3600, stale-while-revalidate=86400');
        res.status(200).json(activities);
    } catch (err) {
        console.error(err);
        res.setHeader('Cache-Control', 'no-store');
        res.status(502).json({ error: 'Activities unavailable' });
    }
};
