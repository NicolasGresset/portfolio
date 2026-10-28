// query.js - Query string check shared by the api/ functions
//
// Vercel's CDN caches one response per full URL: a made-up parameter (/api/sport?x=1) would miss
// the cache and reach the upstream API every time. Requests with any parameter outside the
// expected ones are refused before any upstream call.

// Sends a 400 and returns true when the query has a parameter outside `allowed`
function rejectUnknownParams(req, res, allowed = []) {
    const unknown = Object.keys(req.query || {}).filter(name => !allowed.includes(name));
    if (!unknown.length) return false;
    res.setHeader('Cache-Control', 'no-store');
    res.status(400).json({ error: 'Unexpected query parameter' });
    return true;
}

module.exports = { rejectUnknownParams };
