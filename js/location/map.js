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

// Candidates. proposals: indices of the best ones, numbered from 1; selected: the one shown, in
// orange; the others are grey dots, drawn only when all is true (demonstrator view). A click on
// a marker is not a click on the map (which places the active participant)
export function drawCandidates(layer, candidates, categoryLabels, { selected = null, proposals = [], all = true, onSelect = null } = {}) {
    candidates.forEach((c, j) => {
        const isSelected = j === selected;
        const rank = proposals.indexOf(j);
        if (rank < 0 && !isSelected && !all) return;
        const tooltip = `${rank >= 0 ? `${rank + 1}. ` : ''}${escapeHtml(c.name)} · ${categoryLabels[c.category]}`
            + (c.choices ? ` · ${c.score != null ? `total ${formatDuration(c.total)}, écart ${formatDuration(c.spread)}` : 'injoignable'}` : '');
        const marker = rank >= 0
            ? L.marker([c.lat, c.lon], {
                // Pin 26 px wide: its tip, 26 / √2 below its center, on the place
                icon: L.divIcon({ className: `rank-marker${isSelected ? ' rank-marker--selected' : ''}`,
                    html: `<span class="rank-pin"><span>${rank + 1}</span></span>`,
                    iconSize: [26, 26], iconAnchor: [13, 31], tooltipAnchor: [0, -13] }),
                zIndexOffset: isSelected ? 1000 : 500, keyboard: !!onSelect, title: '',
            })
            : L.circleMarker([c.lat, c.lon], isSelected
                ? { radius: 11, color: COLORS.best, fillOpacity: 0.9, weight: 3, bubblingMouseEvents: false }
                : { radius: 6, color: COLORS.candidate, fillOpacity: 0.7, weight: 1, bubblingMouseEvents: false });
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
