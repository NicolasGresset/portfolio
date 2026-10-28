// results.js - HTML of the results: the chosen place (best by default, or picked in the list or on
// the map), the other places to pick from, and each participant's trip to it

import { escapeHtml } from '../format.js';
import { MODE_LABELS, PARTICIPANT_COLORS, formatDuration } from './labels.js';

const formatClock = iso => new Date(iso).toLocaleTimeString('fr-FR', {
    hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Paris',
});

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
        const badge = leg.color
            ? `<span class="line-badge" style="background: ${leg.color}; color: ${textOn(leg.color)}">${escapeHtml(leg.line || leg.mode)}</span>`
            : `<span class="line-badge">${escapeHtml(leg.line || leg.mode)}</span>`;
        items.push(`<li class="trip-step trip-step--line">
            ${badge} <strong>${escapeHtml(leg.mode)}${leg.line ? ` ${escapeHtml(leg.line)}` : ''}</strong>
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

function tripCard(p, i, place) {
    const choice = place.choices[i];
    const others = modeDetails(place.times[i], choice.mode);
    const trip = choice.mode === 'transit' ? place.times[i].transit.trip : null;
    return `
        <article class="trip-card" style="--participant: ${PARTICIPANT_COLORS[i]}">
            <h3 class="trip-card-title"><span class="location-swatch" style="background: ${PARTICIPANT_COLORS[i]}"></span>
                ${escapeHtml(p.name)} <span class="trip-card-mode">${MODE_LABELS[choice.mode]} · ${formatDuration(choice.seconds)}</span></h3>
            ${trip ? transitSteps(trip, place.name)
                : `<p class="trip-card-direct">Trajet direct${choice.mode === 'car' ? ', dont 5 min pour se garer' : ''}.</p>`}
            ${others ? `<p class="location-muted">Autres modes : ${others}</p>` : ''}
            ${place.times[i].transit?.failed ? `<p class="location-warning">Transports en commun inconnus pour
                ce trajet (${escapeHtml(place.times[i].transit.error)}) : le temps retenu peut être trop long.</p>` : ''}
        </article>`;
}

// HTML of the results for the candidate `selected` of a result event
export function resultsHtml(data, selected, categoryLabels) {
    const place = selected != null ? data.candidates[selected] : null;
    const best = data.best != null ? data.candidates[data.best] : null;
    const slotText = `${data.slot.from.slice(11)} – ${data.slot.to.slice(11)}`;

    if (!place) {
        return `
            <div class="chart-header"><h2 class="chart-title">Lieu retenu</h2></div>
            <p class="location-best">${data.candidates.length
                ? 'Aucun candidat n\'est atteignable par tous les participants.'
                : 'Aucun candidat trouvé à moins de 5 km du barycentre : essayez d\'autres types de lieux.'}</p>`;
    }

    const ranked = data.candidates.map((c, j) => ({ c, j }))
        .sort((a, b) => (a.c.score ?? Infinity) - (b.c.score ?? Infinity));
    const options = ranked.map(({ c, j }) => `
        <option value="${j}"${j === selected ? ' selected' : ''}${c.score == null ? ' disabled' : ''}>
            ${escapeHtml(c.name)} (${categoryLabels[c.category]}) — ${c.score != null ? formatDuration(c.score) : 'injoignable'}${c.incomplete ? ' · incomplet' : ''}${j === data.best ? ' · retenu' : ''}
        </option>`).join('');

    return `
        <div class="chart-header">
            <h2 class="chart-title">${place === best ? 'Lieu retenu' : 'Lieu choisi'}</h2>
            <label class="location-field location-place-select">
                <span>Autres lieux</span>
                <select id="place-select">${options}</select>
            </label>
        </div>
        <p class="location-best"><span class="location-swatch location-swatch--best"></span>
            <strong>${escapeHtml(place.name)}</strong> (${categoryLabels[place.category]}) — arrivée ${slotText}</p>
        ${place.incomplete ? `<p class="location-warning">Calcul incomplet pour ce lieu : des trajets en transports
            en commun ont échoué deux fois${place === best ? ', et aucun lieu au calcul complet n\'est atteignable par tous' : ''}.</p>` : ''}
        <div class="trip-cards">${data.participants.map((p, i) => tripCard(p, i, place)).join('')}</div>`;
}
