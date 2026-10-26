// dev-server.js - Local preview: serves static files and runs api/*.js like Vercel does
//
// Usage: node --env-file=.env scripts/dev-server.js   ->  http://localhost:3000

const http = require('http');
const fs   = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const PORT = process.env.PORT || 3000;
const MIME = {
    '.html': 'text/html; charset=utf-8', '.css': 'text/css', '.js': 'text/javascript',
    '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png',
    '.jpg': 'image/jpeg', '.pdf': 'application/pdf',
};

// Minimal subset of Vercel's response helpers used by api/*.js
function vercelResponse(res) {
    res.status = code => { res.statusCode = code; return res; };
    res.json = body => {
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify(body));
    };
    return res;
}

http.createServer(async (req, res) => {
    const url = new URL(req.url, `http://localhost:${PORT}`);
    console.log(req.method, url.pathname);

    if (url.pathname.startsWith('/api/')) {
        const file = path.join(ROOT, 'api', path.basename(url.pathname) + '.js');
        if (!fs.existsSync(file)) { res.statusCode = 404; return res.end('Not found'); }
        // Pick up edits to api/ (routes and their _lib helpers) without restarting
        for (const cached of Object.keys(require.cache)) {
            if (cached.startsWith(path.join(ROOT, 'api'))) delete require.cache[cached];
        }
        req.query = Object.fromEntries(url.searchParams);
        return require(file)(req, vercelResponse(res));
    }

    let file = path.join(ROOT, path.normalize(url.pathname));
    // Never serve outside the repo or dotfiles such as .env
    if (!file.startsWith(ROOT) || url.pathname.split('/').some(p => p.startsWith('.'))) {
        res.statusCode = 403;
        return res.end();
    }
    if (fs.existsSync(file) && fs.statSync(file).isDirectory()) file = path.join(file, 'index.html');
    fs.readFile(file, (err, data) => {
        if (err) { res.statusCode = 404; return res.end('Not found'); }
        res.setHeader('Content-Type', MIME[path.extname(file)] || 'application/octet-stream');
        res.end(data);
    });
}).listen(PORT, '127.0.0.1', () => console.log(`Dev server on http://localhost:${PORT}`));
