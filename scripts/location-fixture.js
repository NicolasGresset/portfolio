// location-fixture.js - A stored Rendez-vous computation, replayed in the browser to test the
// results' display and behavior without any API call. Not deployed.
//
//   node scripts/location-fixture.js record   one real computation (Transitous calls, ~24), saved
//                                             in scripts/fixtures/rendez-vous.json (slimmed)
//   node scripts/location-fixture.js slim     slims the saved answers again (after a slimAnswer change)
//   node scripts/location-fixture.js shot     replays it, screenshots the results under SHOT_DIR
//
// From a test script:
//   const { withFirefox } = require('./scripts/firefox-bidi.js');
//   const { openWithFixture, runComputation } = require('./scripts/location-fixture.js');
//   await withFirefox(async page => {
//       const scenario = await openWithFixture(page);   // clock, keys and network replaced, page loaded
//       await runComputation(page, scenario);           // form filled, computation done
//       …                                      // page.evaluate(…), page.screenshot(…)
//   });
//
// In the page (preload script, before any of its own): the clock is set back to the recording's
// instant (same day, same slots, same Transitous times), the openrouteservice key is a fake one,
// and fetch is replaced for every other origin: recorded answers (Transitous, Géoplateforme),
// made-up openrouteservice answers (straight lines at a fixed speed), an error for anything else.
// The map tiles (images, not fetch) still load from OpenStreetMap.
// Needs the dev server (node scripts/dev-server.js) on BASE_URL.

const fs   = require('fs');
const path = require('path');

const BASE_URL = process.env.BASE_URL || 'http://localhost:3000';
const FIXTURE_FILE = path.join(__dirname, 'fixtures/rendez-vous.json');
const TIMEOUT_MS = 120000;

// The scenario recorded: places typed in the address search (first local suggestion), modes,
// people, and the arrival slot
const SCENARIO = {
    slot: '12:30',
    participants: [
        { query: 'capitole', modes: ['walk', 'transit'], people: 1 },
        { query: 'ramonville', modes: ['transit', 'bike'], people: 2 },
        { query: 'blagnac aeroport', modes: ['transit', 'car'], people: 1 },
    ],
};

// Runs in the page before its scripts. fixture: { now, responses } (replay) or { now: null }
// (record: real clock, real calls, answers kept in window.__fixtureRecorded)
function preload(fixture) {
    if (location.origin !== new URL(fixture.baseUrl).origin) return;
    localStorage.setItem('location.apiKeys', JSON.stringify({ ors: 'fixture' }));

    if (fixture.now != null) {
        const RealDate = Date;
        const shift = fixture.now - RealDate.now();
        class FixtureDate extends RealDate {
            constructor(...args) { if (args.length) super(...args); else super(RealDate.now() + shift); }
            static now() { return RealDate.now() + shift; }
        }
        window.Date = FixtureDate;
    }

    // openrouteservice, made up: straight line x 1.3 at a fixed speed (m/s), no call
    const SPEEDS = { 'foot-walking': 1.25, 'cycling-regular': 4.2, 'driving-car': 8.3 };
    const metres = ([lon1, lat1], [lon2, lat2]) => {
        const rad = Math.PI / 180;
        const x = (lon2 - lon1) * rad * Math.cos((lat1 + lat2) / 2 * rad);
        return 6371000 * Math.hypot(x, (lat2 - lat1) * rad) * 1.3;
    };
    const orsAnswer = (url, body) => {
        const profile = url.pathname.split('/')[3];
        const speed = SPEEDS[profile];
        if (url.pathname.includes('/matrix/')) {
            const at = i => body.locations[i];
            return { durations: body.sources.map(s => body.destinations.map(d => metres(at(s), at(d)) / speed)) };
        }
        const [a, b] = body.coordinates;
        const middle = [(a[0] + b[0]) / 2 + (b[1] - a[1]) * 0.15, (a[1] + b[1]) / 2 - (b[0] - a[0]) * 0.15];
        return { features: [{ geometry: { coordinates: [a, middle, b] } }] };
    };
    const json = (data, status = 200) => new Response(JSON.stringify(data), { status,
        headers: { 'Content-Type': 'application/json', 'x-ratelimit-limit': '50', 'x-ratelimit-remaining': '42' } });

    const realFetch = window.fetch.bind(window);
    const recorded = window.__fixtureRecorded = [];
    const answers = new Map((fixture.responses || []).map(r => [r.url, r]));
    window.fetch = async (input, init = {}) => {
        const url = new URL(typeof input === 'string' ? input : input.url, location.href);
        if (url.origin === location.origin) return realFetch(input, init);
        if (url.hostname === 'api.openrouteservice.org') return json(orsAnswer(url, JSON.parse(init.body)));
        if (fixture.now == null) {
            const res = await realFetch(input, init);
            recorded.push({ url: url.href, status: res.status, text: await res.clone().text() });
            return res;
        }
        const answer = answers.get(url.href);
        if (!answer) {
            console.error(`fixture: no recorded answer for ${url.href}`);
            return json({ error: 'not in the fixture' }, 404);
        }
        return new Response(answer.text, { status: answer.status, headers: { 'Content-Type': 'application/json' } });
    };
}

// Installs the preload script and loads the page; record: real calls, kept for saving
async function openWithFixture({ send, context }, { record = false, url = `${BASE_URL}/rendez-vous` } = {}) {
    const fixture = record ? { now: null } : JSON.parse(fs.readFileSync(FIXTURE_FILE, 'utf8'));
    const args = JSON.stringify({ baseUrl: BASE_URL, now: fixture.now, responses: fixture.responses });
    await send('script.addPreloadScript', { functionDeclaration: `() => (${preload})(${args})`, contexts: [context] });
    await send('browsingContext.navigate', { context, url, wait: 'complete' });
    return fixture.scenario || SCENARIO;
}

const until = async (evaluate, expression, what) => {
    const end = Date.now() + TIMEOUT_MS;
    while (!(await evaluate(expression))) {
        if (Date.now() > end) throw new Error(`timeout: ${what}`);
        await new Promise(resolve => setTimeout(resolve, 200));
    }
};

// Fills the form as SCENARIO says, starts the computation and waits for its end
async function runComputation({ evaluate }, scenario = SCENARIO) {
    await until(evaluate, `document.querySelectorAll('#participants .participant').length >= 2`, 'participants');
    for (const [i, p] of scenario.participants.entries()) {
        await evaluate(`(() => {
            const rows = document.querySelectorAll('#participants .participant');
            if (rows.length <= ${i}) document.getElementById('add-participant').click();
            const row = document.querySelectorAll('#participants .participant')[${i}];
            row.querySelectorAll('[name="modes"]').forEach(c => { c.checked = ${JSON.stringify(p.modes)}.includes(c.value); });
            row.querySelector('[name="modes"]').dispatchEvent(new Event('change', { bubbles: true }));
            row.querySelector('[name="people"]').value = ${p.people};
            row.querySelector('[name="people"]').dispatchEvent(new Event('change', { bubbles: true }));
            const input = row.querySelector('[name="address"]');
            input.value = ${JSON.stringify(p.query)};
            input.dispatchEvent(new Event('input', { bubbles: true }));
        })()`);
        // The first local suggestion, before the Géoplateforme call is due
        await until(evaluate, `!document.querySelectorAll('#participants .participant')[${i}].querySelector('.address-options').hidden`, `suggestions for ${p.query}`);
        await evaluate(`document.querySelectorAll('#participants .participant')[${i}].querySelector('[name="address"]')
            .dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))`);
    }
    await evaluate(`(() => {
        const li = [...document.querySelectorAll('#slot-options li')].find(li => li.textContent.startsWith(${JSON.stringify(scenario.slot)}));
        if (!li) throw new Error('slot ${scenario.slot} not offered');
        li.click();
        document.querySelector('#location-form [type="submit"]').click();
    })()`);
    await until(evaluate, `/Terminé|Aucun lieu/.test(document.getElementById('progress-text').textContent)`, 'computation');
}

// Transitous answers without what transitous.js does not read (alerts, walking instructions,
// stops' details…): 5.5 MB down to a few hundred KB; other answers only compacted
function slimAnswer(url, text) {
    let data;
    try { data = JSON.parse(text); } catch { return text; }
    if (url.startsWith('https://api.transitous.org/')) {
        const KEPT = ['mode', 'startTime', 'endTime', 'legGeometry', 'routeShortName', 'headsign', 'routeColor'];
        data = { itineraries: (data.itineraries || []).map(it => ({ startTime: it.startTime, endTime: it.endTime,
            legs: it.legs.map(leg => ({ ...Object.fromEntries(KEPT.filter(k => k in leg).map(k => [k, leg[k]])),
                from: { name: leg.from?.name }, to: { name: leg.to?.name },
                ...(leg.intermediateStops ? { intermediateStops: leg.intermediateStops.map(() => ({})) } : {}) })) })) };
    }
    return JSON.stringify(data);
}

async function main(command) {
    const { withFirefox, SHOT_DIR } = require('./firefox-bidi.js');
    if (command === 'record') {
        const now = Date.now();
        await withFirefox(async page => {
            await openWithFixture(page, { record: true });
            await runComputation(page);
            const responses = JSON.parse(await page.evaluate('JSON.stringify(window.__fixtureRecorded)'));
            responses.forEach(r => { r.text = slimAnswer(r.url, r.text); });
            fs.mkdirSync(path.dirname(FIXTURE_FILE), { recursive: true });
            fs.writeFileSync(FIXTURE_FILE, `${JSON.stringify({ recorded: new Date(now).toISOString(), now, scenario: SCENARIO, responses }, null, 1)}\n`);
            console.log(`${responses.length} answers saved in ${FIXTURE_FILE}`);
            if (page.errors.length) console.log('page errors:', page.errors);
        });
    } else if (command === 'slim') {
        const fixture = JSON.parse(fs.readFileSync(FIXTURE_FILE, 'utf8'));
        fixture.responses.forEach(r => { r.text = slimAnswer(r.url, r.text); });
        fs.writeFileSync(FIXTURE_FILE, `${JSON.stringify(fixture, null, 1)}\n`);
    } else if (command === 'shot') {
        await withFirefox(async page => {
            await runComputation(page, await openWithFixture(page));
            console.log(await page.evaluate(`document.getElementById('progress-text').textContent`));
            console.log(await page.screenshot('rendez-vous-results.png', '#location-results'));
            if (page.errors.length) console.log('page errors:', page.errors);
        });
        console.log(`screenshots in ${SHOT_DIR}`);
    } else {
        console.log('usage: node scripts/location-fixture.js record|slim|shot');
    }
}

if (require.main === module) main(process.argv[2]).catch(err => { console.error(err); process.exitCode = 1; });

module.exports = { openWithFixture, runComputation, SCENARIO, FIXTURE_FILE, BASE_URL };
