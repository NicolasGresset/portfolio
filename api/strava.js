// api/strava.js - Vercel serverless function returning recent Strava runs and rides
//
// Required environment variables (Vercel > Settings > Environment Variables):
//   STRAVA_CLIENT_ID, STRAVA_CLIENT_SECRET, STRAVA_REFRESH_TOKEN (scope: activity:read)

const RUN_TYPES  = ['Run', 'TrailRun', 'VirtualRun'];
const RIDE_TYPES = ['Ride', 'GravelRide', 'MountainBikeRide', 'VirtualRide', 'EBikeRide'];
const MAX_ACTIVITIES = 12;

async function getAccessToken() {
    const res = await fetch('https://www.strava.com/oauth/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            client_id:     process.env.STRAVA_CLIENT_ID,
            client_secret: process.env.STRAVA_CLIENT_SECRET,
            refresh_token: process.env.STRAVA_REFRESH_TOKEN,
            grant_type:    'refresh_token',
        }),
    });
    if (!res.ok) throw new Error(`Strava token refresh failed: ${res.status}`);
    return (await res.json()).access_token;
}

module.exports = async (req, res) => {
    try {
        const token = await getAccessToken();
        const apiRes = await fetch('https://www.strava.com/api/v3/athlete/activities?per_page=50', {
            headers: { Authorization: `Bearer ${token}` },
        });
        if (!apiRes.ok) throw new Error(`Strava activities fetch failed: ${apiRes.status}`);

        const activities = (await apiRes.json())
            // Only show public activities, never "followers" or "only me"
            .filter(a => a.visibility === 'everyone')
            .filter(a => RUN_TYPES.includes(a.sport_type) || RIDE_TYPES.includes(a.sport_type))
            .slice(0, MAX_ACTIVITIES)
            .map(a => ({
                id:           a.id,
                name:         a.name,
                kind:         RUN_TYPES.includes(a.sport_type) ? 'run' : 'ride',
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
        res.status(502).json({ error: 'Strava unavailable' });
    }
};
