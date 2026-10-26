// activity.js - Detail of one run: detected intervals, pace and HR charts sharing a distance axis

(function () {
    const id = new URLSearchParams(window.location.search).get('id');
    const $ = elId => document.getElementById(elId);

    const SVG_NS = 'http://www.w3.org/2000/svg';
    const MARGIN = { top: 8, right: 8, bottom: 24, left: 40 };
    const PACE_HEIGHT = 180;
    const HR_HEIGHT = 150;
    const SEGMENT_NAMES = {
        warmup: 'échauffement', work: 'effort', recovery: 'récup', cooldown: 'retour au calme', steady: 'continu',
    };

    const escapeHtml = str => str.replace(/[&<>"']/g, c => ({
        '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
    }[c]));

    const formatDate = iso => new Date(iso).toLocaleDateString('fr-FR', {
        weekday: 'long', day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC',
    });

    const formatKm = km => `${km.toFixed(km < 10 ? 2 : 1).replace('.', ',')} km`;

    function formatDuration(seconds) {
        const h = Math.floor(seconds / 3600);
        const m = Math.floor((seconds % 3600) / 60);
        const s = Math.round(seconds % 60);
        return h > 0 ? `${h}h${String(m).padStart(2, '0')}` : `${m}:${String(s).padStart(2, '0')}`;
    }

    // seconds per km -> 4'35
    const formatPace = sec => `${Math.floor(sec / 60)}'${String(Math.round(sec % 60)).padStart(2, '0')}`;

    const percentile = (xs, p) => {
        const sorted = xs.filter(x => x != null).sort((a, b) => a - b);
        return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))];
    };

    function el(name, attrs = {}, parent) {
        const node = document.createElementNS(SVG_NS, name);
        for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, v);
        if (parent) parent.appendChild(node);
        return node;
    }

    const stat = (label, value) => `
        <div class="activity-stat">
            <span class="activity-stat-label">${label}</span>
            <span class="activity-stat-value">${value}</span>
        </div>`;

    function renderHeader(a) {
        document.title = `${a.name} — Nicolas Gresset-Bourgeois`;
        $('activity-date').textContent = `// ${formatDate(a.date)}`;
        $('activity-name').textContent = a.name;
        $('activity-label').textContent = a.label;
        if (a.description) {
            $('activity-description').textContent = a.description;
            $('activity-description').hidden = false;
        }
        $('activity-stats').innerHTML = [
            stat('distance', formatKm(a.distance / 1000)),
            stat('temps', formatDuration(a.movingTime)),
            stat('allure', `${formatPace(1000 / a.averageSpeed)} /km`),
            stat('fc moy.', a.averageHr ? `${Math.round(a.averageHr)} bpm` : '—'),
        ].join('');
    }

    function renderSegments(a) {
        let rep = 0;
        const row = (cls, type, name, s) => `
            <li class="${cls}" data-type="${type}">
                <span class="segment-name">${name}</span>
                <span>${formatKm(s.distance / 1000)}</span>
                <span>${formatDuration(s.duration)}</span>
                <span>${formatPace(s.duration / (s.distance / 1000))} /km</span>
                <span>${s.hr ? `${s.hr} bpm` : '—'}</span>
            </li>`;
        $('segment-list').innerHTML = a.segments.map(s => {
            const name = s.type === 'work' ? `effort ${++rep}` : SEGMENT_NAMES[s.type];
            // Blocks over 1 km also list their per-km splits, indented
            const splits = s.splits.map((k, i) => row('segment segment--split', s.type, `km ${i + 1}`, k)).join('');
            return row('segment', s.type, name, s) + splits;
        }).join('');
    }

    // One line chart; both charts share the x scale so the crosshair lines up
    function lineChart(container, { height, values, domain, invert, tickFormat, showXAxis }, x, a) {
        const width = container.clientWidth;
        const innerH = height - MARGIN.top - MARGIN.bottom;
        const [lo, hi] = domain;
        const y = v => {
            const t = (Math.min(Math.max(v, lo), hi) - lo) / (hi - lo);
            return MARGIN.top + (invert ? t : 1 - t) * innerH;
        };

        container.innerHTML = '';
        const svg = el('svg', { width, height, viewBox: `0 0 ${width} ${height}`, 'aria-hidden': 'true' }, container);

        // Effort segments as a light band behind the line
        a.segments.filter(s => s.type === 'work').forEach(s => {
            el('rect', {
                x: x(s.startKm), y: MARGIN.top, width: Math.max(1, x(s.endKm) - x(s.startKm)), height: innerH,
                class: 'chart-band',
            }, svg);
        });

        for (let i = 0; i <= 3; i++) {
            const v = lo + ((hi - lo) / 3) * i;
            el('line', { x1: MARGIN.left, x2: width - MARGIN.right, y1: y(v), y2: y(v), class: 'chart-grid' }, svg);
            el('text', { x: MARGIN.left - 8, y: y(v), class: 'chart-tick', 'text-anchor': 'end', 'dominant-baseline': 'middle' }, svg)
                .textContent = tickFormat(v);
        }

        if (showXAxis) {
            const maxKm = a.series.km[a.series.km.length - 1];
            const step = [1, 2, 5, 10].find(s => maxKm / s <= 10);
            for (let km = 0; km <= maxKm; km += step) {
                el('text', { x: x(km), y: height - 6, class: 'chart-tick', 'text-anchor': 'middle' }, svg)
                    .textContent = `${km} km`;
            }
        }

        // Path with gaps where the value is missing (stops)
        let d = '';
        let pen = false;
        a.series.km.forEach((km, i) => {
            const v = values[i];
            if (v == null) { pen = false; return; }
            d += `${pen ? 'L' : 'M'}${x(km).toFixed(1)},${y(v).toFixed(1)}`;
            pen = true;
        });
        el('path', { d, class: `chart-line chart-line--${container.id}` }, svg);

        const cursor = el('line', { y1: MARGIN.top, y2: MARGIN.top + innerH, class: 'chart-cursor', visibility: 'hidden' }, svg);
        const hit = el('rect', {
            x: MARGIN.left, y: 0, width: width - MARGIN.left - MARGIN.right, height, class: 'chart-hit',
        }, svg);
        return { svg, cursor, hit, width };
    }

    function renderCharts(a) {
        const width = $('pace-chart').clientWidth;
        const maxKm = a.series.km[a.series.km.length - 1];
        const x = km => MARGIN.left + (km / maxKm) * (width - MARGIN.left - MARGIN.right);

        // Pace axis: fastest at the top, ignore walking outliers
        const paceLo = Math.floor(percentile(a.series.pace, 0.02) / 15) * 15;
        const paceHi = Math.min(Math.ceil(percentile(a.series.pace, 0.97) / 15) * 15, 600);
        const hrLo = Math.floor(percentile(a.series.hr, 0.01) / 10) * 10;
        const hrHi = Math.ceil(percentile(a.series.hr, 0.99) / 10) * 10;

        const charts = [
            lineChart($('pace-chart'), {
                height: PACE_HEIGHT, values: a.series.pace, domain: [paceLo, Math.max(paceHi, paceLo + 60)],
                invert: true, tickFormat: formatPace, showXAxis: false,
            }, x, a),
            lineChart($('hr-chart'), {
                height: HR_HEIGHT, values: a.series.hr, domain: [hrLo, Math.max(hrHi, hrLo + 20)],
                invert: false, tickFormat: Math.round, showXAxis: true,
            }, x, a),
        ];

        // Shared crosshair with a readout in the chart header
        const readout = $('chart-readout');
        const show = evt => {
            const box = evt.currentTarget.getBoundingClientRect();
            const km = ((evt.clientX - box.left) / box.width) * maxKm;
            let i = a.series.km.findIndex(k => k >= km);
            if (i < 0) i = a.series.km.length - 1;
            const cx = x(a.series.km[i]);
            charts.forEach(c => {
                c.cursor.setAttribute('x1', cx);
                c.cursor.setAttribute('x2', cx);
                c.cursor.setAttribute('visibility', 'visible');
            });
            const pace = a.series.pace[i], hr = a.series.hr[i];
            readout.textContent = `${formatKm(a.series.km[i])} · ${pace ? `${formatPace(pace)} /km` : 'arrêt'}${hr ? ` · ${hr} bpm` : ''}`;
        };
        const hide = () => {
            charts.forEach(c => c.cursor.setAttribute('visibility', 'hidden'));
            readout.textContent = '';
        };
        charts.forEach(c => {
            c.hit.addEventListener('pointermove', show);
            c.hit.addEventListener('pointerleave', hide);
        });
    }

    const fail = msg => {
        $('activity-name').textContent = msg;
        document.querySelector('main').hidden = true;
    };

    if (!id) return fail('Sortie introuvable');

    fetch(`/api/activity?id=${encodeURIComponent(id)}`)
        .then(r => { if (!r.ok) throw new Error(r.status); return r.json(); })
        .then(a => {
            renderHeader(a);
            renderSegments(a);
            renderCharts(a);
            let lastWidth = $('pace-chart').clientWidth;
            window.addEventListener('resize', () => {
                if ($('pace-chart').clientWidth !== lastWidth) { lastWidth = $('pace-chart').clientWidth; renderCharts(a); }
            });
        })
        .catch(() => fail('Impossible de charger cette sortie pour le moment.'));
})();
