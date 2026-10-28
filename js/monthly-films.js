// monthly-films.js - Films watched per month as SVG columns, count on each cap

import { cinemaData } from './cinema.js';

(function () {
    const plot = document.getElementById('monthly-films-chart');
    if (!plot) return;

    const SVG_NS = 'http://www.w3.org/2000/svg';
    const HEIGHT = 240;
    const MARGIN = { top: 20, right: 8, bottom: 40, left: 28 };
    const MAX_BAR = 24;
    const RADIUS = 4;
    const MIN_SHORT_LABEL = 36; // px per month below which "oct." becomes "O"

    // Month on the first axis line ("oct." or "O" when narrow), year on the second
    const formatMonth = (ym, narrow) => new Date(`${ym}-01T00:00:00Z`)
        .toLocaleDateString('fr-FR', { month: narrow ? 'narrow' : 'short', timeZone: 'UTC' });

    // Axis max as 4 integer steps of 1, 2, 3 or 5 x 10^n, so the 4 ticks are whole films
    function niceMax(value) {
        const quarter = Math.max(1, value / 4);
        const pow = 10 ** Math.floor(Math.log10(quarter));
        return 4 * [1, 2, 3, 5, 10].find(m => m * pow >= quarter) * pow;
    }

    function el(name, attrs = {}, parent) {
        const node = document.createElementNS(SVG_NS, name);
        for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, v);
        if (parent) parent.appendChild(node);
        return node;
    }

    // Column with rounded top corners
    function columnPath(x, y, w, h) {
        const r = Math.min(RADIUS, h, w / 2);
        return `M${x},${y + h} V${y + r} Q${x},${y} ${x + r},${y} H${x + w - r} Q${x + w},${y} ${x + w},${y + r} V${y + h} Z`;
    }

    function render(months) {
        const width = plot.clientWidth;
        const innerW = width - MARGIN.left - MARGIN.right;
        const innerH = HEIGHT - MARGIN.top - MARGIN.bottom;
        const band = innerW / months.length;
        const barW = Math.min(MAX_BAR, band * 0.7);
        const narrow = band < MIN_SHORT_LABEL;
        const yMax = niceMax(Math.max(...months.map(m => m.count)));
        const y = v => MARGIN.top + innerH - (v / yMax) * innerH;

        plot.innerHTML = '';
        const svg = el('svg', {
            width, height: HEIGHT, viewBox: `0 0 ${width} ${HEIGHT}`, role: 'img',
            'aria-label': `Films vus par mois sur les ${months.length} derniers mois`,
        }, plot);

        // Gridlines and y-axis ticks
        for (let i = 0; i <= 4; i++) {
            const v = (yMax / 4) * i;
            el('line', { x1: MARGIN.left, x2: width - MARGIN.right, y1: y(v), y2: y(v), class: 'chart-grid' }, svg);
            el('text', { x: MARGIN.left - 8, y: y(v), class: 'chart-tick', 'text-anchor': 'end', 'dominant-baseline': 'middle' }, svg)
                .textContent = Math.round(v);
        }

        months.forEach((m, i) => {
            const cx = MARGIN.left + band * i + band / 2;
            if (m.count > 0) {
                el('path', { d: columnPath(cx - barW / 2, y(m.count), barW, y(0) - y(m.count)), class: 'chart-bar chart-bar--films' }, svg);
                el('text', { x: cx, y: y(m.count) - 6, class: 'chart-value', 'text-anchor': 'middle' }, svg)
                    .textContent = m.count;
            }
            el('text', { x: cx, y: HEIGHT - 22, class: 'chart-tick', 'text-anchor': 'middle' }, svg)
                .textContent = formatMonth(m.month, narrow);
            // Year under each January, and under the first month unless a January follows closely,
            // left-aligned so it never overflows
            const firstYear = i === 0 && !months.slice(1, 3).some(n => n.month.endsWith('-01'));
            if (firstYear || m.month.endsWith('-01')) {
                el('text', { x: cx - band / 2 + 2, y: HEIGHT - 6, class: 'chart-tick chart-tick--year', 'text-anchor': 'start' }, svg)
                    .textContent = m.month.slice(0, 4);
            }
        });
    }

    // Loaded by cinema.js
    cinemaData
        .then(({ months }) => {
            if (!months.length) {
                plot.innerHTML = '<p class="activities-status">Pas encore assez de films pour ce graphique.</p>';
                return;
            }
            render(months);
            let lastWidth = plot.clientWidth;
            window.addEventListener('resize', () => {
                if (plot.clientWidth !== lastWidth) { lastWidth = plot.clientWidth; render(months); }
            });
        })
        .catch(() => {
            plot.innerHTML = '<p class="activities-status">Impossible de charger les films pour le moment.</p>';
        });
})();
