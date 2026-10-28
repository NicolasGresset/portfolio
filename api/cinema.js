// api/cinema.js - Vercel serverless function feeding the cinema page from the Letterboxd RSS feed
// (last 50 diary entries):
//   - films: one per film, most recently watched first, with poster, rating and review paragraphs
//     (director and main cast come from api/credits.js, cached much longer)
//   - months: viewings per month, from the first complete month to the current one
// Set LETTERBOXD_RSS_FILE to read a saved feed instead (local dev, e.g. data/cinema.xml).

const fs = require('fs');

const FEED_URL = 'https://letterboxd.com/nicogresset/rss/';

// Feed values are flat and HTML-escaped, a regex per tag is enough
function tag(xml, name) {
    const m = xml.match(new RegExp(`<${name}[^>]*>([\\s\\S]*?)</${name}>`));
    return m ? m[1].replace(/^\s*<!\[CDATA\[([\s\S]*)\]\]>\s*$/, '$1').trim() : null;
}

const decodeEntities = str => str
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/&(quot|lt|gt|nbsp|amp);/g, (_, e) => ({ quot: '"', lt: '<', gt: '>', nbsp: ' ', amp: '&' }[e]));

// The feed links 600x900 posters, shown at most 90 px wide: ask Letterboxd for 300x450, sharp up
// to 3x screens and about a third of the weight (smaller sizes such as 230x345 weigh more)
const POSTER_SIZE = '-0-300-0-450-crop';

// Description: poster paragraph, optional spoiler warning, then the review paragraphs
function parseDescription(html) {
    const poster = html.match(/<img src="([^"]+)"/)?.[1]?.replace(/-0-\d+-0-\d+-crop/, POSTER_SIZE) ?? null;
    const paragraphs = [...html.matchAll(/<p>([\s\S]*?)<\/p>/g)]
        .map(m => m[1])
        .filter(p => !p.includes('<img') && !p.includes('This review may contain spoilers.'))
        .map(p => decodeEntities(p.replace(/<br\s*\/?>/g, '\n').replace(/<[^>]+>/g, '')).trim())
        .filter(Boolean);
    return { poster, paragraphs };
}

function parseItem(xml) {
    const { poster, paragraphs } = parseDescription(tag(xml, 'description') || '');
    const rating = tag(xml, 'letterboxd:memberRating');
    return {
        tmdbId:   tag(xml, 'tmdb:movieId'),
        title:    decodeEntities(tag(xml, 'letterboxd:filmTitle')),
        year:     Number(tag(xml, 'letterboxd:filmYear')) || null,
        url:      tag(xml, 'link'),
        watched:  tag(xml, 'letterboxd:watchedDate'),          // YYYY-MM-DD
        rating:   rating ? Number(rating) : null,               // 0.5 to 5
        liked:    tag(xml, 'letterboxd:memberLike') === 'Yes',
        rewatch:  tag(xml, 'letterboxd:rewatch') === 'Yes',
        spoilers: (tag(xml, 'title') || '').endsWith('(contains spoilers)'),
        poster,
        // Entries logged without a review only carry "Watched on <date>."
        review:   tag(xml, 'guid')?.startsWith('letterboxd-review-') ? paragraphs : [],
    };
}

// Viewings come newest first: keep the latest date, rating and review, fill gaps from older viewings
function mergeViewings(viewings) {
    const byFilm = new Map();
    for (const v of viewings) {
        const key = v.tmdbId || `${v.title} (${v.year})`;
        const film = byFilm.get(key);
        if (!film) { byFilm.set(key, { ...v, viewings: 1 }); continue; }
        film.viewings++;
        film.rating ??= v.rating;
        if (!film.review.length) { film.review = v.review; film.spoilers = v.spoilers; }
    }
    return [...byFilm.values()];
}

async function readFeed() {
    if (process.env.LETTERBOXD_RSS_FILE) return fs.promises.readFile(process.env.LETTERBOXD_RSS_FILE, 'utf8');
    const r = await fetch(FEED_URL);
    if (!r.ok) throw new Error(`Letterboxd RSS: ${r.status}`);
    return r.text();
}

module.exports = async (req, res) => {
    try {
        const xml = await readFeed();
        // Lists also show up in the feed, keep diary entries only
        const viewings = [...xml.matchAll(/<item>([\s\S]*?)<\/item>/g)]
            .map(m => parseItem(m[1]))
            .filter(f => f.watched)
            .sort((a, b) => b.watched.localeCompare(a.watched));
        const films = mergeViewings(viewings);

        // One bucket per month (YYYY-MM), oldest first, ending with the current month.
        // The feed is cut at 50 entries mid-month, so the oldest entry's month is left out as incomplete.
        const months = [];
        if (viewings.length) {
            const last = new Date().toISOString().slice(0, 7);
            const d = new Date(`${viewings[viewings.length - 1].watched.slice(0, 7)}-01T00:00:00Z`);
            d.setUTCMonth(d.getUTCMonth() + 1);
            for (let m = d.toISOString().slice(0, 7); m <= last; m = d.toISOString().slice(0, 7)) {
                months.push({ month: m, count: 0 });
                d.setUTCMonth(d.getUTCMonth() + 1);
            }
            const byMonth = new Map(months.map(m => [m.month, m]));
            viewings.forEach(f => { const b = byMonth.get(f.watched.slice(0, 7)); if (b) b.count++; });
        }

        // Cache on Vercel's CDN for 1h, serve stale up to 1 day while revalidating
        res.setHeader('Cache-Control', 's-maxage=3600, stale-while-revalidate=86400');
        res.status(200).json({ films, months });
    } catch (err) {
        console.error(err);
        res.setHeader('Cache-Control', 'no-store');
        res.status(502).json({ error: 'Cinema data unavailable' });
    }
};
