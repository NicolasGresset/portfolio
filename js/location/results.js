// results.js - HTML of the results: the best places (proposals), the chosen one (the best by
// default, or picked among the proposals, on the map or, in the demonstrator view, in the list of
// every candidate), links to it on OpenStreetMap and Google Maps, and each participant's trip to it
// (mode and time, the steps folded in the practical view)

import { escapeHtml } from '../format.js';
import { MODE_LABELS, formatDuration } from './labels.js';

const formatClock = iso => new Date(iso).toLocaleTimeString('fr-FR', {
    hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Paris',
});

export const PROPOSALS = 3; // best places offered: the group may prefer one it knows
export const METRIC_LABELS = { total: 'temps total', fair: 'moyenne + écart' };

export function choiceText(choice) {
    return choice ? `${formatDuration(choice.seconds)} (${MODE_LABELS[choice.mode]})` : 'injoignable';
}

// Transitous names the trip's ends START and END
const stopName = (name, fallback) => (!name || name === 'START' || name === 'END' ? fallback : name);

// Readable text on a line's color
function textOn(hex) {
    const [r, g, b] = [1, 3, 5].map(k => parseInt(hex.slice(k, k + 2), 16));
    return 0.299 * r + 0.587 * g + 0.114 * b > 150 ? '#0C1A2E' : '#FFFFFF';
}

// A line's badge, in its color when known
function lineBadge(leg) {
    return leg.color
        ? `<span class="line-badge" style="background: ${leg.color}; color: ${textOn(leg.color)}">${escapeHtml(leg.line || leg.mode)}</span>`
        : `<span class="line-badge">${escapeHtml(leg.line || leg.mode)}</span>`;
}

// Steps of a transit trip: departure, walks, lines with direction and stops, arrival
function transitSteps(trip, placeName) {
    const lines = trip.legs.filter(l => l.kind === 'line');
    const items = [`<li class="trip-step trip-step--time">Départ ${formatClock(trip.departure)}</li>`];
    trip.legs.forEach((leg, k) => {
        if (leg.kind === 'walk') {
            if (leg.seconds < 60) return;
            const target = k === trip.legs.length - 1 ? placeName : stopName(leg.to, 'l\'arrêt');
            items.push(`<li class="trip-step trip-step--walk">Marche ${formatDuration(leg.seconds)} jusqu'à ${escapeHtml(target)}</li>`);
            return;
        }
        items.push(`<li class="trip-step trip-step--line">
            ${lineBadge(leg)} <strong>${escapeHtml(leg.mode)}${leg.line ? ` ${escapeHtml(leg.line)}` : ''}</strong>
            ${leg.headsign ? `direction ${escapeHtml(leg.headsign)}` : ''}
            <span class="trip-step-detail">${escapeHtml(stopName(leg.from, ''))} ${formatClock(leg.departure)}
                → ${escapeHtml(stopName(leg.to, ''))} ${formatClock(leg.arrival)}
                ${leg.stops != null ? `· ${leg.stops} arrêt${leg.stops > 1 ? 's' : ''}` : ''}</span></li>`);
    });
    items.push(`<li class="trip-step trip-step--time">Arrivée ${formatClock(trip.arrival)}`
        + `${lines.length > 1 ? ` · ${lines.length - 1} correspondance${lines.length > 2 ? 's' : ''}` : ''}`
        + `${trip.wait >= 60 ? ` · en avance, ${formatDuration(trip.wait)} d'attente comptées` : ''}</li>`);
    return `<ol class="trip-steps">${items.join('')}</ol>`;
}

function modeDetails(modeTimes, retained) {
    return Object.entries(modeTimes)
        .filter(([mode]) => mode !== retained)
        .map(([mode, t]) => `${MODE_LABELS[mode]} : ${t.seconds != null ? formatDuration(t.seconds) : escapeHtml(t.error)}`)
        .join(' · ');
}

const placeAddress = place => [place.street, [place.postcode, place.city].filter(Boolean).join(' ')]
    .filter(Boolean).join(', ');

// The place on OpenStreetMap (its own page for an OSM feature, a marker for a Tisséo stop) and on
// Google Maps (searched by name and address, which finds its page there; by position otherwise)
export function placeLinks(place) {
    const { lat, lon } = place;
    const osm = /^(node|way|relation)\//.test(place.id)
        ? `https://www.openstreetmap.org/${place.id}`
        : `https://www.openstreetmap.org/?mlat=${lat}&mlon=${lon}#map=19/${lat}/${lon}`;
    const address = placeAddress(place);
    const query = osm.includes('?') || !address ? `${lat},${lon}` : `${place.name}, ${address}`;
    return { osm, google: `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(query)}` };
}

// Text sent by the share button: the place, its address, the slot and its OpenStreetMap link
export function shareText(place, slot) {
    const address = placeAddress(place);
    return `${place.name}${address ? `, ${address}` : ''} — arrivée ${slot.from.slice(11)} – ${slot.to.slice(11)}`;
}

// A participant's trip: numbered disc, lines taken, mode and time, then the details (steps,
// other modes), folded in the practical view, shown in the demonstrator view
function tripCard(p, i, place, demo) {
    const choice = place.choices[i];
    const others = modeDetails(place.times[i], choice.mode);
    const trip = choice.mode === 'transit' ? place.times[i].transit.trip : null;
    const lines = trip ? trip.legs.filter(l => l.kind === 'line') : [];
    const details = `
        ${trip ? transitSteps(trip, place.name)
            : `<p class="trip-card-direct">Trajet direct${choice.mode === 'car' ? ', dont 5 min pour se garer' : ''}.</p>`}
        ${others ? `<p class="location-muted">Autres modes : ${others}</p>` : ''}`;
    return `
        <article class="trip-card" style="--participant: ${p.color}">
            <h3 class="trip-card-title"><span class="participant-number" aria-hidden="true">${i + 1}</span>
                <span class="visually-hidden">${escapeHtml(p.label)}</span>
                ${lines.length ? `<span class="trip-card-lines">${lines.map(lineBadge).join(' → ')}</span>` : ''}
                <span class="trip-card-mode">${MODE_LABELS[choice.mode]} · ${formatDuration(choice.seconds)}</span></h3>
            ${place.times[i].transit?.failed ? `<p class="location-warning">Transports en commun inconnus pour
                ce trajet (${escapeHtml(place.times[i].transit.error)}) : le temps retenu peut être trop long.</p>` : ''}
            ${demo ? details : `<details class="trip-details"><summary>Voir l'itinéraire</summary>${details}</details>`}
        </article>`;
}

function proposalButton(c, j, rank, selected) {
    return `
        <li><button type="button" class="proposal" data-place="${j}" aria-pressed="${j === selected}">
            <span class="rank-pin proposal-rank"><span>${rank + 1}</span></span>
            <span class="proposal-name">${escapeHtml(c.name)}</span>
            <span class="proposal-times">total ${formatDuration(c.total)} · écart ${formatDuration(c.spread)}</span>
        </button></li>`;
}

// HTML of the results for the candidate `selected` of a result event; demo: the list of every
// candidate with its score, to pick any of them
export function resultsHtml(data, selected, categoryLabels, { demo = false } = {}) {
    const place = selected != null ? data.candidates[selected] : null;
    const slotText = `${data.slot.from.slice(11)} – ${data.slot.to.slice(11)}`;

    if (!place) {
        return `
            <div class="chart-header"><h2 class="chart-title">Propositions</h2></div>
            <p class="location-best">${data.candidates.length
                ? 'Aucun candidat n\'est atteignable par tous les participants.'
                : 'Aucun candidat trouvé à moins de 5 km du barycentre : essayez d\'autres types de lieux.'}</p>`;
    }

    const ranked = [...data.ranking, ...data.candidates.map((_, j) => j).filter(j => !data.ranking.includes(j))];
    const options = ranked.map(j => {
        const c = data.candidates[j];
        return `
        <option value="${j}"${j === selected ? ' selected' : ''}${c.score == null ? ' disabled' : ''}>
            ${escapeHtml(c.name)} (${categoryLabels[c.category]}) — ${c.score != null ? `score ${formatDuration(c.score)}` : 'injoignable'}${c.incomplete ? ' · incomplet' : ''}
        </option>`;
    }).join('');
    const proposals = data.ranking.slice(0, PROPOSALS);
    const links = placeLinks(place);
    const external = 'target="_blank" rel="noopener noreferrer"';

    return `
        <div class="chart-header">
            <h2 class="chart-title">Propositions</h2>
            ${demo ? `<label class="location-field location-place-select">
                <span>Tous les candidats (score : ${METRIC_LABELS[data.metric]})</span>
                <select id="place-select">${options}</select>
            </label>` : ''}
        </div>
        <p class="location-muted location-ranking">Classées par ${METRIC_LABELS[data.metric]} (réglages) :
            ${data.metric === 'fair' ? 'trajet moyen plus écart entre le plus long et le plus court' : 'somme des trajets de tous'}.</p>
        <ol class="proposals">${proposals.map((j, rank) => proposalButton(data.candidates[j], j, rank, selected)).join('')}</ol>
        <p class="location-best"><span class="rank-pin rank-pin--selected location-swatch--rank"></span>
            <strong>${escapeHtml(place.name)}</strong>
            <span>(${categoryLabels[place.category]})${placeAddress(place) ? ` · ${escapeHtml(placeAddress(place))}` : ''} — arrivée ${slotText}</span></p>
        <p class="location-share">
            <a class="location-button" href="${links.osm}" ${external}>OpenStreetMap ↗</a>
            <a class="location-button" href="${links.google}" ${external}>Google Maps ↗</a>
            <button type="button" class="location-button" id="place-share">Partager le lieu</button>
            <span class="location-muted" id="place-share-status" role="status"></span>
        </p>
        ${place.incomplete ? `<p class="location-warning">Calcul incomplet pour ce lieu : des trajets en transports
            en commun ont échoué deux fois${selected === data.best ? ', et aucun lieu au calcul complet n\'est atteignable par tous' : ''}.</p>` : ''}
        <div class="trip-cards">${data.participants.map((p, i) => tripCard(p, i, place, demo)).join('')}</div>`;
}
