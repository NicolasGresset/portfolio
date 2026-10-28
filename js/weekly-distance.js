// weekly-distance.js - Weekly running distance as stacked SVG columns (easy below, quality above), total on each cap

import { sportData } from './sport.js';

(function () {
    const plot  = document.getElementById('weekly-distance-chart');
    if (!plot) return;

    const SVG_NS = 'http://www.w3.org/2000/svg';
    const HEIGHT = 240;
    const MARGIN = { top: 20, right: 8, bottom: 28, left: 36 };
    const MAX_BAR = 24;
    const RADIUS = 4;
    const GAP = 2;
    const SERIES = ['easy', 'quality']; // bottom to top, colors in css/sport.css
    const LABEL_W = 52; // px needed by a week label such as "14 sept."

    const formatWeek = iso => new Date(`${iso}T00:00:00Z`)
        .toLocaleDateString('fr-FR', { day: 'numeric', month: 'short', timeZone: 'UTC' });

    const formatKm = km => km.toFixed(1).replace('.', ',');

    // Round the axis max up to 1, 2 or 5 x 10^n so ticks land on clean numbers
    function niceMax(value) {
        if (value <= 0) return 10;
        const pow = 10 ** Math.floor(Math.log10(value));
        const step = [1, 2, 5, 10].find(m => m * pow >= value / 4);
        return Math.ceil(value / (step * pow)) * step * pow;
    }

    function el(name, attrs = {}, parent) {
        const node = document.createElementNS(SVG_NS, name);
        for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, v);
        if (parent) parent.appendChild(node);
        return node;
    }

    // Column segment, rounded top corners only for the topmost one
    function columnPath(x, y, w, h, rounded) {
        const r = rounded ? Math.min(RADIUS, h, w / 2) : 0;
        return `M${x},${y + h} V${y + r} Q${x},${y} ${x + r},${y} H${x + w - r} Q${x + w},${y} ${x + w},${y + r} V${y + h} Z`;
    }

    function render(weeks) {
        const width = plot.clientWidth;
        const innerW = width - MARGIN.left - MARGIN.right;
        const innerH = HEIGHT - MARGIN.top - MARGIN.bottom;
        const band = innerW / weeks.length;
        const barW = Math.min(MAX_BAR, band * 0.7);
        const total = w => w.easy + w.quality;
        const yMax = niceMax(Math.max(...weeks.map(total)));
        const y = v => MARGIN.top + innerH - (v / yMax) * innerH;

        plot.innerHTML = '';
        const svg = el('svg', {
            width, height: HEIGHT, viewBox: `0 0 ${width} ${HEIGHT}`, role: 'img',
            'aria-label': `Kilomètres de course par semaine sur les ${weeks.length} dernières semaines`,
        }, plot);

        // Gridlines and y-axis ticks
        for (let i = 0; i <= 4; i++) {
            const v = (yMax / 4) * i;
            el('line', { x1: MARGIN.left, x2: width - MARGIN.right, y1: y(v), y2: y(v), class: 'chart-grid' }, svg);
            el('text', { x: MARGIN.left - 8, y: y(v), class: 'chart-tick', 'text-anchor': 'end', 'dominant-baseline': 'middle' }, svg)
                .textContent = Math.round(v);
        }

        // On narrow screens label every n-th week, always including the current one
        const labelStep = Math.ceil(LABEL_W / band);

        weeks.forEach((w, i) => {
            const cx = MARGIN.left + band * i + band / 2;
            // Stack bottom-up with a surface gap between segments
            const present = SERIES.filter(k => w[k] > 0);
            let base = 0;
            present.forEach((k, j) => {
                const top = y(base + w[k]);
                const bottom = y(base) - (j > 0 ? GAP : 0);
                if (bottom - top > 0) {
                    el('path', {
                        d: columnPath(cx - barW / 2, top, barW, bottom - top, j === present.length - 1),
                        class: `chart-bar chart-bar--${k}`,
                    }, svg);
                }
                base += w[k];
            });
            if (base > 0) {
                el('text', { x: cx, y: y(base) - 6, class: 'chart-value', 'text-anchor': 'middle' }, svg)
                    .textContent = formatKm(base);
            }
            if ((weeks.length - 1 - i) % labelStep === 0) {
                el('text', { x: cx, y: HEIGHT - 8, class: 'chart-tick', 'text-anchor': 'middle' }, svg)
                    .textContent = formatWeek(w.week);
            }
        });
    }

    // Loaded by sport.js
    sportData
        .then(({ weeks }) => {
            render(weeks);
            let lastWidth = plot.clientWidth;
            window.addEventListener('resize', () => {
                if (plot.clientWidth !== lastWidth) { lastWidth = plot.clientWidth; render(weeks); }
            });
        })
        .catch(() => {
            plot.innerHTML = '<p class="activities-status">Impossible de charger les kilomètres pour le moment.</p>';
        });
})();
