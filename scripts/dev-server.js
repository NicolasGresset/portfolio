// dev-server.js - Local preview: serves static files and runs api/*.js like Vercel does
//
// Usage: node --env-file=.env scripts/dev-server.js   ->  http://localhost:3000
//
// The headers of vercel.json are sent as on Vercel. To check a Content-Security-Policy change, set
// CSP_REPORT=1 (violations logged here, policy enforced) or CSP_REPORT=only (logged, not enforced).

const http = require('http');
const fs   = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const PORT = process.env.PORT || 3000;
const CSP_REPORT_PATH = '/__csp-report';

// vercel.json header rules, with their "(.*)" wildcards turned into regular expressions
const HEADER_RULES = (JSON.parse(fs.readFileSync(path.join(ROOT, 'vercel.json'), 'utf8')).headers || [])
    .map(rule => ({
        pattern: new RegExp(`^${rule.source.split('(.*)').map(part => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('(.*)')}$`),
        headers: rule.headers,
    }));

function setVercelHeaders(pathname, res) {
    for (const rule of HEADER_RULES.filter(r => r.pattern.test(pathname))) {
        for (let { key, value } of rule.headers) {
            if (key.toLowerCase() === 'content-security-policy' && process.env.CSP_REPORT) {
                value += `; report-uri ${CSP_REPORT_PATH}`;
                if (process.env.CSP_REPORT === 'only') key = 'Content-Security-Policy-Report-Only';
            }
            res.setHeader(key, value);
        }
    }
}

const MIME = {
    '.html': 'text/html; charset=utf-8', '.css': 'text/css', '.js': 'text/javascript',
    '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png',
    '.jpg': 'image/jpeg', '.pdf': 'application/pdf', '.woff2': 'font/woff2', '.txt': 'text/plain; charset=utf-8',
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

    if (url.pathname === CSP_REPORT_PATH) {
        let body = '';
        req.on('data', chunk => { body += chunk; });
        req.on('end', () => {
            const r = JSON.parse(body || '{}')['csp-report'] || {};
            console.log(`CSP VIOLATION ${r['violated-directive']} blocked=${r['blocked-uri']} page=${r['document-uri']}`
                + (r['source-file'] ? ` at ${r['source-file']}:${r['line-number']}` : ''));
            res.statusCode = 204;
            res.end();
        });
        return;
    }
    setVercelHeaders(url.pathname, res);

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
