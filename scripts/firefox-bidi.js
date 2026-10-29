// firefox-bidi.js - Headless Firefox driven through WebDriver BiDi, for browser tests against the
// dev server (node scripts/dev-server.js). Not deployed.
//
// Usage, from a test script (CommonJS or ESM):
//   const { withFirefox } = require('./scripts/firefox-bidi.js');
//   await withFirefox(async ({ send, context, evaluate, screenshot, errors }) => {
//       await send('browsingContext.navigate', { context, url: 'http://localhost:3000/', wait: 'complete' });
//       console.log(await evaluate('document.title'));
//       await screenshot('home.png');            // written under SHOT_DIR
//   }, { width: 1280, height: 900, finePointer: true });
//
// Firefox is launched here, not by the caller: a free port each time, a fresh profile that is
// removed afterwards, and a clean shutdown with browser.close (killing it is only a fallback).
// Snap pitfalls handled: the profile and the screenshots must be under ~/snap/firefox/common (the
// snap cannot write to /tmp), and the snap launcher hides Firefox's arguments from ps / pgrep, so
// Firefox can only be found through the child process started here.

const { spawn } = require('child_process');
const fs   = require('fs');
const os   = require('os');
const path = require('path');

const FIREFOX = '/snap/bin/firefox';
const SNAP_DIR = path.join(os.homedir(), 'snap/firefox/common');
const SHOT_DIR = path.join(SNAP_DIR, 'shots');
const START_TIMEOUT_MS = 30000; // measured 2026-10-29: ~8.5 s to the first BiDi answer
const CLOSE_TIMEOUT_MS = 10000;

function launch(profile) {
    const child = spawn(FIREFOX, ['--headless', '--profile', profile, '--remote-debugging-port', '0'],
        { stdio: ['ignore', 'ignore', 'pipe'] });
    // Port 0: Firefox picks a free port and prints it on stderr
    const url = new Promise((resolve, reject) => {
        let log = '';
        const timer = setTimeout(() => reject(new Error(`no BiDi port after ${START_TIMEOUT_MS} ms:\n${log}`)), START_TIMEOUT_MS);
        child.stderr.on('data', chunk => {
            log += chunk;
            const match = log.match(/WebDriver BiDi listening on (ws:\/\/[\d.:]+)/);
            if (match) { clearTimeout(timer); resolve(`${match[1]}/session`); }
        });
        child.on('exit', code => { clearTimeout(timer); reject(new Error(`Firefox exited (${code}) before BiDi:\n${log}`)); });
    });
    return { child, url };
}

async function connect(url) {
    const ws = new WebSocket(url);
    await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = () => reject(new Error(`cannot reach ${url}`)); });
    let id = 0;
    const pending = new Map();
    const listeners = [];
    ws.onmessage = e => {
        const message = JSON.parse(e.data);
        if (message.id != null && pending.has(message.id)) {
            pending.get(message.id)(message);
            pending.delete(message.id);
        } else if (message.method) listeners.forEach(fn => fn(message));
    };
    // Resolves with the result, throws on a BiDi error
    const send = (method, params = {}) => new Promise((resolve, reject) => {
        const n = ++id;
        pending.set(n, m => (m.type === 'error' ? reject(new Error(`${method}: ${m.error} ${m.message}`)) : resolve(m.result)));
        ws.send(JSON.stringify({ id: n, method, params }));
    });
    return { ws, send, onEvent: fn => listeners.push(fn) };
}

async function withFirefox(scenario, { width = 1280, height = 900, finePointer = false } = {}) {
    fs.mkdirSync(SHOT_DIR, { recursive: true });
    const profile = fs.mkdtempSync(path.join(SNAP_DIR, 'bidi-profile-'));
    // Headless Firefox matches no (pointer: fine): set it for mouse-only behavior
    if (finePointer) {
        fs.writeFileSync(path.join(profile, 'user.js'),
            'user_pref("ui.primaryPointerCapabilities", 6);\nuser_pref("ui.allPointerCapabilities", 6);\n');
    }
    const { child, url } = launch(profile);
    const exited = new Promise(resolve => child.on('exit', resolve));
    let bidi = null;
    try {
        bidi = await connect(await url);
        const { send, onEvent } = bidi;
        await send('session.new', { capabilities: {} });
        const errors = [];
        await send('session.subscribe', { events: ['log.entryAdded'] });
        onEvent(m => { if (m.method === 'log.entryAdded' && m.params.level === 'error') errors.push(m.params.text); });
        // A new tab: the first context of getTree needs system access
        const { context } = await send('browsingContext.create', { type: 'tab' });
        await send('browsingContext.setViewport', { context, viewport: { width, height } });
        const evaluate = async expression => {
            const r = await send('script.evaluate', { expression, target: { context }, awaitPromise: true });
            if (r.type === 'exception') throw new Error(`page exception: ${r.exceptionDetails.text}`);
            return r.result.value;
        };
        // Whole viewport, or the box of a CSS selector (with a margin)
        const screenshot = async (name, selector = null, margin = 8) => {
            const params = { context };
            if (selector) {
                const box = JSON.parse(await evaluate(`JSON.stringify(document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect())`));
                params.clip = { type: 'box', x: box.x - margin, y: box.y - margin, width: box.width + 2 * margin, height: box.height + 2 * margin };
            }
            const { data } = await send('browsingContext.captureScreenshot', params);
            const file = path.join(SHOT_DIR, name);
            fs.writeFileSync(file, Buffer.from(data, 'base64'));
            return file;
        };
        return await scenario({ send, context, evaluate, screenshot, errors });
    } finally {
        // Clean shutdown, so that the profile is not left locked; kill only if it hangs
        if (bidi) await Promise.race([bidi.send('browser.close').catch(() => {}), exited]);
        const timer = setTimeout(() => child.kill('SIGKILL'), CLOSE_TIMEOUT_MS);
        if (child.exitCode == null && child.signalCode == null) {
            if (!bidi) child.kill('SIGTERM');
            await exited;
        }
        clearTimeout(timer);
        fs.rmSync(profile, { recursive: true, force: true });
    }
}

module.exports = { withFirefox, SHOT_DIR };
