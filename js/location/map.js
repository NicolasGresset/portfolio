// map.js - Leaflet drawing on the page's OpenStreetMap map: barycenter, candidates and the
// participants' paths (participant markers stay with the form, in main.js)

import { escapeHtml } from '../format.js';
import { MODE_LABELS, COLORS, formatDuration } from './labels.js';

export const TOULOUSE = [43.6045, 1.4440]; // place du Capitole

export function createMap(elementId) {
    const map = L.map(elementId).setView(TOULOUSE, 12);
    L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
        maxZoom: 19,
        attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
    }).addTo(map);
    return map;
}

export function drawCenter(layer, center) {
    L.circleMarker([center.lat, center.lon], { radius: 4, color: COLORS.center, fillOpacity: 1, weight: 1, bubblingMouseEvents: false })
        .bindTooltip('barycentre')
        .addTo(layer);
}

// Candidates. proposals: indices of the best ones, numbered pins from 1; selected: the one shown,
// an orange pin (numbered if a proposal); the others are small grey pins, drawn only when all is
// true (demonstrator view). A click on a marker is not a click on the map (which places the active
// participant)
export function drawCandidates(layer, candidates, categoryLabels, { selected = null, proposals = [], all = true, onSelect = null } = {}) {
    candidates.forEach((c, j) => {
        const isSelected = j === selected;
        const rank = proposals.indexOf(j);
        if (rank < 0 && !isSelected && !all) return;
        const tooltip = `${rank >= 0 ? `${rank + 1}. ` : ''}${escapeHtml(c.name)} · ${categoryLabels[c.category]}`
            + (c.choices ? ` · ${c.score != null ? `total ${formatDuration(c.total)}, écart ${formatDuration(c.spread)}` : 'injoignable'}` : '');
        // Every place is a pin: numbered for the proposals, orange for the chosen one, small and
        // grey for the other candidates. Tip of a pin of size s: s / √2 below its center
        const small = rank < 0 && !isSelected;
        const size = small ? 14 : 26;
        const pinClass = `rank-pin${isSelected ? ' rank-pin--selected' : ''}${small ? ' rank-pin--small' : ''}`;
        const marker = L.marker([c.lat, c.lon], {
            icon: L.divIcon({ className: 'rank-marker', html: `<span class="${pinClass}"><span>${rank >= 0 ? rank + 1 : ''}</span></span>`,
                iconSize: [size, size], iconAnchor: [size / 2, Math.round(size / 2 + size / Math.SQRT2)], tooltipAnchor: [0, -size / 2] }),
            zIndexOffset: isSelected ? 1000 : small ? 0 : 500, keyboard: !!onSelect, title: '',
        });
        marker.bindTooltip(tooltip).addTo(layer);
        if (onSelect && c.score != null && !isSelected) marker.on('click', () => onSelect(j));
    });
}

const straightLine = (from, to, color) => L.polyline([[from.lat, from.lon], [to.lat, to.lon]],
    { color, weight: 2, dashArray: '4 6', opacity: 0.6 });

// A participant's path to the selected place: solid for walk, bike, car and transit lines,
// dotted for walking parts of a transit trip; a straight dashed line until it is known
// group: the participant's layer group, p: the participant, route: its route event (if known)
export function drawRoute(group, p, place, route, color) {
    group.clearLayers();
    if (!route?.legs) {
        const line = straightLine(p, place, color).addTo(group);
        if (route?.error) line.bindTooltip(route.error, { sticky: true });
        return;
    }
    route.legs.forEach(leg => {
        const walking = leg.kind === 'walk' && route.mode === 'transit';
        const label = leg.kind === 'line'
            ? `${p.label} · ${leg.mode || 'ligne'} ${leg.line || ''}`
            : `${p.label} · ${MODE_LABELS[walking ? 'walk' : route.mode]}`;
        if (!leg.path.length) return;
        L.polyline(leg.path, walking
            ? { color, weight: 3, dashArray: '2 6', opacity: 0.9 }
            : { color, weight: 4, opacity: 0.8 })
            .bindTooltip(escapeHtml(label), { sticky: true })
            .addTo(group);
    });
}
