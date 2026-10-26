// detect-intervals.js - Split a run into warmup / reps / recoveries / cooldown and build a readable label
//
// Input streams come from intervals.icu (irregular "smart recording" sampling), so everything is
// first resampled to 1 Hz. Files under api/_lib are not exposed as Vercel functions.

const SMOOTH_HALF_WINDOW = 7;     // s, speed is averaged over 2 * 7 + 1 = 15 s
const MAX_SPEED = 7;              // m/s, faster than this is a GPS jump
const STOP_SPEED = 1.2;           // m/s, slower than this is standing/walking slowly, ignored when clustering
const JOG_SPEED = 2;              // m/s, easy running reference ignores walking below this
const MIN_SPEED_RATIO = 1.15;     // fast cluster must be 15% faster than slow cluster to be "intervals"
const MIN_REP_RATIO = 1.2;        // each rep must be 20% faster than the easy running pace
const HR_LAG_S = 60;              // HR takes about a minute to catch up with the effort
const MIN_EASY_JOG_S = 120;       // without this much easy running, slow parts are just stops
const LONE_REP_S = 120;           // a rep shorter than this...
const LONE_GAP_S = 300;           // ...this far from any other rep is a stride, not a workout
const PAUSE_S = 60;               // a stop this short inside a long rep (traffic light) does not split it
const MIN_SPLIT_M = 100;          // a shorter leftover after the last full km is not listed
const HYSTERESIS = 0.03;          // ±3% around the threshold before switching state
const MIN_WORK_S = 30;
const MIN_EASY_S = 20;
const MIN_EDGE_M = 300;           // shorter warmup/cooldown are not worth mentioning
const LONG_REP_S = 5 * 60;        // reps at least this long are named by HR zone (seuil, tempo...)

// Zone names indexed by intervals.icu HR zone (Z1..Z7), with the phrase used after a distance
const ZONE_NAMES = ['EF', 'EF', 'tempo', 'seuil', 'VMA', 'VMA', 'VMA'];
const ZONE_PHRASES = { EF: 'en EF', tempo: 'au tempo', seuil: 'au seuil', VMA: 'à VMA' };

function resample(time, distance, heartrate) {
    const T = Math.round(time[time.length - 1]);
    const dist = new Float64Array(T + 1);
    const hr = new Float64Array(T + 1);
    let j = 0;
    let prevRaw = distance[0];
    let lastHr = heartrate ? heartrate.find(h => h > 0) || 0 : 0;
    for (let s = 0; s <= T; s++) {
        while (j < time.length - 2 && time[j + 1] < s) j++;
        const t0 = time[j], t1 = time[j + 1] ?? t0;
        const f = t1 > t0 ? Math.min(Math.max((s - t0) / (t1 - t0), 0), 1) : 0;
        const d = distance[j] + f * ((distance[j + 1] ?? distance[j]) - distance[j]);
        // Accumulate capped increments so a GPS jump does not create a fake sprint
        dist[s] = s === 0 ? 0 : dist[s - 1] + Math.min(Math.max(d - prevRaw, 0), MAX_SPEED);
        prevRaw = d;
        if (heartrate) {
            const h0 = heartrate[j], h1 = heartrate[j + 1] ?? h0;
            if (h0 > 0 && h1 > 0) lastHr = h0 + f * (h1 - h0);
            hr[s] = lastHr;
        }
    }
    return { dist, hr: heartrate ? hr : null, T };
}

function smoothSpeed(dist, T, halfWindow = SMOOTH_HALF_WINDOW) {
    const v = new Float64Array(T + 1);
    for (let s = 0; s <= T; s++) {
        const a = Math.max(s - halfWindow, 0);
        const b = Math.min(s + halfWindow, T);
        v[s] = b > a ? (dist[b] - dist[a]) / (b - a) : 0;
    }
    return v;
}

// 1D 2-means: returns [slow centroid, fast centroid]
function twoMeans(values) {
    const sorted = [...values].sort((a, b) => a - b);
    let c = [sorted[Math.floor(sorted.length * 0.2)], sorted[Math.floor(sorted.length * 0.8)]];
    for (let iter = 0; iter < 30; iter++) {
        const mid = (c[0] + c[1]) / 2;
        const lo = sorted.filter(x => x <= mid), hi = sorted.filter(x => x > mid);
        if (!lo.length || !hi.length) break;
        c = [lo.reduce((s, x) => s + x, 0) / lo.length, hi.reduce((s, x) => s + x, 0) / hi.length];
    }
    return c;
}

// Collapse neighbouring runs that share the same state
const collapse = runs => runs.reduce((acc, r) => {
    const prev = acc[acc.length - 1];
    if (prev && prev.work === r.work) prev.end = r.end;
    else acc.push({ ...r });
    return acc;
}, []);

// Merge runs shorter than their minimum duration into their neighbours, shortest first
function mergeShortRuns(runs) {
    for (;;) {
        let worst = -1;
        runs.forEach((r, i) => {
            const min = r.work ? MIN_WORK_S : MIN_EASY_S;
            if (r.end - r.start < min && (worst < 0 || r.end - r.start < runs[worst].end - runs[worst].start)) worst = i;
        });
        if (worst < 0 || runs.length === 1) return runs;
        runs[worst].work = !runs[worst].work;
        runs = collapse(runs);
    }
}

function hrZone(hr, zones) {
    if (!hr || !zones) return 0;
    const i = zones.findIndex(top => hr <= top);
    return i < 0 ? zones.length - 1 : i;
}

// --- Formatting ---------------------------------------------------------------

const formatPace = speed => {
    const sec = Math.round(1000 / speed);
    return `${Math.floor(sec / 60)}'${String(sec % 60).padStart(2, '0')}`;
};

const formatKm = m => `${(Math.round(m / 100) / 10).toString().replace('.', ',')} km`;

function formatRepDistance(m) {
    if (m < 2000) return `${Math.round(m / 100) * 100} m`;
    return formatKm(m);
}

function formatDuration(s) {
    const r = Math.round(s / 15) * 15;
    return r >= 60 ? `${Math.floor(r / 60)}'${String(r % 60).padStart(2, '0')}` : `${r}"`;
}

const median = xs => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)];
const cv = xs => {
    const m = xs.reduce((s, x) => s + x, 0) / xs.length;
    return Math.sqrt(xs.reduce((s, x) => s + (x - m) ** 2, 0) / xs.length) / m;
};

// Consecutive reps of similar distance (±20%) form one group
function groupReps(reps) {
    const groups = [];
    for (const r of reps) {
        const g = groups[groups.length - 1];
        if (g && Math.abs(r.distance - median(g.reps.map(x => x.distance))) / r.distance < 0.2) g.reps.push(r);
        else groups.push({ reps: [r] });
    }
    return groups;
}

function describeGroup(group, zones) {
    const reps = group.reps;
    const distance = reps.reduce((s, r) => s + r.distance, 0);
    const duration = reps.reduce((s, r) => s + r.duration, 0);
    const speed = distance / duration;
    const n = reps.length;

    // Time-based reps (e.g. 10 x 1') have steadier durations than distances
    const byTime = n >= 3 && cv(reps.map(r => r.duration)) < cv(reps.map(r => r.distance)) * 0.6;
    const unit = byTime ? formatDuration(median(reps.map(r => r.duration))) : formatRepDistance(median(reps.map(r => r.distance)));
    const count = n > 1 ? `${n} × ${unit}` : unit;

    let text;
    const repHr = reps.map(r => r.hr).filter(Boolean);
    if (median(reps.map(r => r.duration)) >= LONG_REP_S && repHr.length) {
        text = `${count} ${ZONE_PHRASES[ZONE_NAMES[hrZone(median(repHr), zones)]]} (${formatPace(speed)})`;
    } else {
        text = `${count} à ${formatPace(speed)}`;
    }

    // Short recoveries are given as a duration, long jogging ones as a distance
    const recoveries = reps.map(r => r.recovery).filter(Boolean);
    if (n > 1 && recoveries.length >= n - 1) {
        const duration = median(recoveries.map(r => r.duration));
        text += duration < LONG_REP_S
            ? `, récup ${formatDuration(duration)}`
            : `, récup ${formatKm(median(recoveries.map(r => r.distance)))}`;
    }
    return text;
}

// --- Main ---------------------------------------------------------------------

function detectIntervals({ time, distance, heartrate }, hrZones) {
    const { dist, hr, T } = resample(time, distance, heartrate);
    const v = smoothSpeed(dist, T);
    const avgHr = (a, b) => {
        if (!hr) return null;
        let sum = 0;
        for (let s = a; s < b; s++) sum += hr[s];
        return b > a ? sum / (b - a) : null;
    };
    // Per-km splits between two seconds, the last one may be partial
    const kmSplits = (start, end) => {
        const splits = [];
        let from = start;
        for (let s = start + 1; s <= end; s++) {
            if (dist[s] - dist[from] < 1000 && s < end) continue;
            if (dist[s] - dist[from] >= MIN_SPLIT_M) {
                splits.push({ distance: dist[s] - dist[from], duration: s - from, hr: avgHr(from, s) });
            }
            from = s;
        }
        return splits;
    };
    const segment = (type, start, end) => ({
        type,
        start,
        end,
        startKm: dist[start] / 1000,
        endKm: dist[end] / 1000,
        distance: dist[end] - dist[start],
        duration: end - start,
        // HR lags effort: skip the start of the segment
        hr: avgHr(start + Math.min(HR_LAG_S, Math.round((end - start) / 3)), end),
        splits: (type === 'work' || type === 'steady') && dist[end] - dist[start] > 1000 ? kmSplits(start, end) : [],
        // Quality volume: efforts, and steady runs above EF (set in steady())
        quality: type === 'work',
    });

    const steady = () => {
        const seg = segment('steady', 0, T);
        seg.hr = avgHr(0, T);
        const zone = ZONE_NAMES[hrZone(seg.hr, hrZones)];
        seg.quality = zone !== 'EF';
        const label = zone === 'EF'
            ? `${formatKm(seg.distance)} EF`
            : `${formatKm(seg.distance)} ${ZONE_PHRASES[zone]} (${formatPace(seg.distance / seg.duration)})`;
        return { label, segments: [seg] };
    };

    const moving = Array.from(v).filter(x => x > STOP_SPEED);
    if (moving.length < 60) return steady();
    const [slow, fast] = twoMeans(moving);
    if (fast / slow < MIN_SPEED_RATIO) return steady();
    const threshold = (slow + fast) / 2;

    // Per-second state with hysteresis, then runs of equal state
    let work = false;
    let runs = [];
    for (let s = 0; s <= T; s++) {
        if (!work && v[s] > threshold * (1 + HYSTERESIS)) work = true;
        else if (work && v[s] < threshold * (1 - HYSTERESIS)) work = false;
        const last = runs[runs.length - 1];
        if (last && last.work === work) last.end = s;
        else runs.push({ work, start: s, end: s });
    }
    runs = mergeShortRuns(runs);

    // Drop reps that are not clearly faster than the easy running around them (GPS noise, hills)
    for (;;) {
        const easy = [];
        for (const r of runs) if (!r.work) for (let s = r.start; s <= r.end; s++) if (v[s] > JOG_SPEED) easy.push(v[s]);
        // Only stops between fast parts: a steady run interrupted by traffic lights
        if (easy.length < MIN_EASY_JOG_S) return steady();
        const easyRef = median(easy);
        const weak = runs.filter(r => r.work && (dist[r.end] - dist[r.start]) / (r.end - r.start) < easyRef * MIN_REP_RATIO);
        if (!weak.length) break;
        weak.forEach(r => { r.work = false; });
        runs = mergeShortRuns(collapse(runs));
    }

    // Lone short accelerations (strides, sprint finish, fast start) are not a workout
    const workRuns = runs.filter(r => r.work);
    const lone = workRuns.filter(r => r.end - r.start < LONE_REP_S && workRuns.every(o => o === r
        || Math.max(o.start - r.end, r.start - o.end) > LONE_GAP_S));
    if (lone.length) {
        lone.forEach(r => { r.work = false; });
        runs = collapse(runs);
    }

    // A short stop inside a long effort is a pause, not a recovery
    runs.forEach((r, i) => {
        const prev = runs[i - 1], next = runs[i + 1];
        if (r.work || !prev || !next) return;
        const longest = Math.max(prev.end - prev.start, next.end - next.start);
        if (r.end - r.start < PAUSE_S && longest >= LONG_REP_S && r.end - r.start < longest * 0.1) r.work = true;
    });
    runs = collapse(runs);
    if (!runs.some(r => r.work)) return steady();

    // Name segments by position
    const firstWork = runs.findIndex(r => r.work);
    const lastWork = runs.length - 1 - [...runs].reverse().findIndex(r => r.work);
    const segments = runs.map((r, i) => segment(
        r.work ? 'work' : i < firstWork ? 'warmup' : i > lastWork ? 'cooldown' : 'recovery',
        r.start,
        r.end,
    ));

    // Attach the following recovery duration to each rep
    const reps = [];
    segments.forEach((s, i) => {
        if (s.type !== 'work') return;
        const next = segments[i + 1];
        reps.push({ ...s, recovery: next && next.type === 'recovery' ? next : null });
    });

    const parts = [];
    const warmup = segments.find(s => s.type === 'warmup');
    const cooldown = segments.find(s => s.type === 'cooldown');
    const hasCooldown = cooldown && cooldown.distance >= MIN_EDGE_M;
    if (warmup && warmup.distance >= MIN_EDGE_M) {
        // A long easy start with nothing after the reps is an easy run with a fast finish
        parts.push(!hasCooldown && reps.length === 1 && warmup.distance > reps[0].distance
            ? `${formatKm(warmup.distance)} EF`
            : `${formatKm(warmup.distance)} échauffement`);
    }
    groupReps(reps).forEach(g => parts.push(describeGroup(g, hrZones)));
    if (hasCooldown) parts.push(`${formatKm(cooldown.distance)} retour au calme`);

    return { label: parts.join(', '), segments };
}

module.exports = { detectIntervals, resample, smoothSpeed };
