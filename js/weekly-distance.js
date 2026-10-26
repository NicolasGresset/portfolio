// weekly-distance.js - Weekly running distance as SVG columns, value labelled on each cap

(function () {
    const plot  = document.getElementById('weekly-distance-chart');
    if (!plot) return;

    const SVG_NS = 'http://www.w3.org/2000/svg';
    const HEIGHT = 240;
    const MARGIN = { top: 20, right: 8, bottom: 28, left: 36 };
    const MAX_BAR = 24;
    const RADIUS = 4;

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

    // Column with rounded top corners, square at the baseline
    function columnPath(x, y, w, h) {
        const r = Math.min(RADIUS, h, w / 2);
        return `M${x},${y + h} V${y + r} Q${x},${y} ${x + r},${y} H${x + w - r} Q${x + w},${y} ${x + w},${y + r} V${y + h} Z`;
    }

    function render(weeks) {
        const width = plot.clientWidth;
        const innerW = width - MARGIN.left - MARGIN.right;
        const innerH = HEIGHT - MARGIN.top - MARGIN.bottom;
        const band = innerW / weeks.length;
        const barW = Math.min(MAX_BAR, band * 0.7);
        const yMax = niceMax(Math.max(...weeks.map(w => w.km)));
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

        weeks.forEach((w, i) => {
            const cx = MARGIN.left + band * i + band / 2;
            const h = y(0) - y(w.km);
            if (h > 0) {
                el('path', { d: columnPath(cx - barW / 2, y(w.km), barW, h), class: 'chart-bar' }, svg);
                el('text', { x: cx, y: y(w.km) - 6, class: 'chart-value', 'text-anchor': 'middle' }, svg)
                    .textContent = formatKm(w.km);
            }
            el('text', { x: cx, y: HEIGHT - 8, class: 'chart-tick', 'text-anchor': 'middle' }, svg)
                .textContent = formatWeek(w.week);
        });
    }

    fetch('/api/weekly-distance')
        .then(r => { if (!r.ok) throw new Error(r.status); return r.json(); })
        .then(weeks => {
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
