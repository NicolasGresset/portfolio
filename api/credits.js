// api/credits.js - Vercel serverless function giving a film's director(s) and main cast from TMDB,
// each as { id, name } with the TMDB person id for profile links
// (GET /api/credits?id=<TMDB movie id>, ids come from the Letterboxd feed in api/cinema.js).
// Credits never change, so each film is cached for a year on Vercel's CDN.

const MAIN_CAST = 2;

const person = ({ id, name }) => ({ id, name });

module.exports = async (req, res) => {
    const id = req.query.id;
    if (!/^\d+$/.test(id || '')) {
        res.setHeader('Cache-Control', 'no-store');
        return res.status(400).json({ error: 'Missing or invalid id' });
    }
    try {
        const r = await fetch(`https://api.themoviedb.org/3/movie/${id}/credits`, {
            headers: { Authorization: `Bearer ${process.env.TMDB_READ_TOKEN}` },
        });
        if (!r.ok) throw new Error(`TMDB ${id}: ${r.status}`);
        const { cast = [], crew = [] } = await r.json();

        res.setHeader('Cache-Control', 's-maxage=31536000');
        res.status(200).json({
            // A director can be listed twice (e.g. also credited for another directing job)
            directors: [...new Map(crew.filter(c => c.job === 'Director').map(c => [c.id, person(c)])).values()],
            cast:      cast.sort((a, b) => a.order - b.order).slice(0, MAIN_CAST).map(person),
        });
    } catch (err) {
        console.error(err);
        res.setHeader('Cache-Control', 'no-store');
        res.status(502).json({ error: 'Credits unavailable' });
    }
};
