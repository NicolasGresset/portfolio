// main.js - Meeting point prototype, entirely in the browser: the user's API keys, participants
// form with address autocompletion, OpenStreetMap map (Leaflet), computation progress, API call
// counters and results.

import { loadData, evaluate, placeRoutes } from './engine.js';
import { loadKeys, saveKeys, clearKeys } from './keys.js';

(function () {
    const form = document.getElementById('location-form');
    if (!form || !window.L) return;

    const MAX_PARTICIPANTS = 5;
    const TOULOUSE = [43.6045, 1.4440];
    const MIN_QUERY_LENGTH = 3;
    const SUGGEST_DELAY_MS = 250;
    const ORS_MODES = ['walk', 'bike', 'car'];
    const MODE_LABELS = { walk: 'marche', bike: 'vélo', car: 'voiture', transit: 'transports en commun' };
    const KIND_LABELS = { bar: 'bar', restaurant: 'restaurant', metro: 'métro', bus: 'arrêt de bus' };
    const KIND_PLURALS = { bar: 'bars', restaurant: 'restaurants', metro: 'stations de métro', bus: 'arrêts de bus' };
    const PLACE_KINDS = { housenumber: 'adresse', street: 'voie', municipality: 'commune', locality: 'lieu-dit' };
    const COLORS = { candidate: '#7A90AA', best: '#EA580C', center: '#0C1A2E' };
    const STEPS = [
        { id: 'center',     label: 'Barycentre des participants' },
        { id: 'candidates', label: 'Lieux candidats (extrait local OSM + GTFS Tisséo)' },
        { id: 'matrix',     label: 'Temps marche, vélo, voiture (openrouteservice)' },
        { id: 'transit',    label: 'Temps en transports en commun (Transitous)' },
        { id: 'result',     label: 'Sélection du lieu' },
        { id: 'routes',     label: 'Tracés des itinéraires (openrouteservice directions, Transitous)' },
    ];
    // One color per participant (marker and path), none reused for candidates or the chosen place
    const PARTICIPANT_COLORS = ['#2563EB', '#9333EA', '#0D9488', '#DB2777', '#65A30D'];

    const list    = document.getElementById('participants');
    const addBtn  = document.getElementById('add-participant');
    const slot    = document.getElementById('slot');
    const status  = document.getElementById('location-status');
    const results = document.getElementById('location-results');
    const banner  = document.getElementById('location-banner');
    const steps   = document.getElementById('progress-steps');
    const callsEl = document.getElementById('location-calls');

    const escapeHtml = str => String(str).replace(/[&<>"']/g, c => ({
        '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
    }[c]));

    function formatDuration(seconds) {
        const minutes = Math.round(seconds / 60);
        return minutes < 60 ? `${minutes} min` : `${Math.floor(minutes / 60)} h ${String(minutes % 60).padStart(2, '0')}`;
    }

    // Bring a section into view (below the fixed navigation, see scroll-margin-top in the CSS)
    function scrollToSection(el) {
        const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
        el.scrollIntoView({ behavior: reduced ? 'auto' : 'smooth', block: 'start' });
    }

    function setStatus(text) {
        status.textContent = text || '';
        status.hidden = !text;
    }

    // ---- API keys (stored only in this browser) and the banner they drive ----
    const keysPanel  = document.getElementById('keys-panel');
    const keysForm   = document.getElementById('keys-form');
    const keysStatus = document.getElementById('keys-status');
    const orsInput   = document.getElementById('ors-key');
    let keys = loadKeys();

    function showKeys(message) {
        orsInput.value = keys.ors || '';
        keysPanel.open = !keys.ors;
        keysStatus.textContent = message || (keys.ors
            ? 'Clé openrouteservice enregistrée (dans ce navigateur uniquement).'
            : 'Aucune clé enregistrée.');
        form.querySelector('[type="submit"]').disabled = !keys.ors;
        banner.hidden = !!keys.ors;
        banner.textContent = 'Saisissez votre clé openrouteservice dans « Clé API » pour utiliser le service.';
    }

    keysForm.addEventListener('submit', e => {
        e.preventDefault();
        const persisted = saveKeys({ ors: orsInput.value.trim() });
        keys = loadKeys();
        showKeys(persisted ? null : 'Stockage local indisponible : clé gardée jusqu\'à la fermeture de la page.');
    });
    document.getElementById('keys-clear').addEventListener('click', () => {
        clearKeys();
        keys = {};
        showKeys('Clé effacée de ce navigateur.');
    });

    // ---- External API calls: last computation and whole session (since the page was loaded) ----
    const session = { geocode: 0, orsMatrix: 0, orsDirections: 0, transitous: 0 };
    let lastRun = null;   // calls of the last (or running) computation
    let running = false;  // lastRun is not yet added to session
    // { limit, remaining, reset } per openrouteservice service, from its last answer
    const orsQuota = { matrix: null, directions: null };

    function renderCalls() {
        const last = key => (lastRun ? lastRun[key] : 0);
        const total = key => session[key] + (running ? last(key) : 0);
        const row = (name, key, note = '') => `
            <div class="location-calls-row"><dt>${name}</dt>
            <dd>${key !== 'geocode' ? `${last(key)} <span class="location-muted">dernier calcul</span> · ` : ''}${total(key)}
                <span class="location-muted">session</span>${note}</dd></div>`;
        const quota = q => (q?.remaining != null
            ? ` · <strong>quota restant ${q.remaining}/${q.limit}</strong>`
                + (q.reset ? ` <span class="location-muted">(réinitialisé à ${new Date(q.reset * 1000)
                    .toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' })})</span>` : '')
            : '');
        callsEl.innerHTML = row('Géocodage (Géoplateforme)', 'geocode')
            + row('openrouteservice matrix', 'orsMatrix', quota(orsQuota.matrix))
            + row('openrouteservice directions', 'orsDirections', quota(orsQuota.directions))
            + row('Transitous', 'transitous', ' <span class="location-muted">(au-delà de 720/24 h, se coordonner avec Transitous)</span>');
    }
    renderCalls();

    // ---- Arrival slot: 15 min ranges, default to the first one starting in 30 min or more ----
    (function fillSlots() {
        const now = new Date();
        const soon = now.getHours() * 60 + now.getMinutes() + 30;
        const hhmm = minutes => `${String(Math.floor(minutes / 60) % 24).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`;
        let selected = false;
        for (let m = 6 * 60; m < 24 * 60; m += 15) {
            const option = new Option(`${hhmm(m)} – ${hhmm(m + 15)}`, hhmm(m));
            if (!selected && m >= soon) { option.selected = true; selected = true; }
            slot.add(option);
        }
    })();

    // ---- Map ----
    const map = L.map('location-map').setView(TOULOUSE, 12);
    L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
        maxZoom: 19,
        attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
    }).addTo(map);
    const participantMarkers = new Map(); // participant row -> marker
    const resultLayer = L.layerGroup().addTo(map);
    let routeLayers = [];    // per participant: layer group holding its path to the selected place
    // Displayed result: { data (result event), rows, selected (candidate index),
    // routes (place id -> participant index -> route event) }
    let current = null;

    const participantName = row => row.querySelector('[name="name"]').value.trim()
        || `Participant ${[...list.children].indexOf(row) + 1}`;

    const colorOf = row => PARTICIPANT_COLORS[[...list.children].indexOf(row) % PARTICIPANT_COLORS.length];

    function fitParticipants() {
        const points = [...participantMarkers.values()].map(m => m.getLatLng());
        if (points.length === 1) map.setView(points[0], 14);
        else if (points.length > 1) map.fitBounds(points, { padding: [40, 40], maxZoom: 15 });
    }

    function updateMarker(row) {
        let marker = participantMarkers.get(row);
        if (!row.dataset.lat) {
            if (marker) { marker.remove(); participantMarkers.delete(row); }
            return;
        }
        const latLng = [Number(row.dataset.lat), Number(row.dataset.lon)];
        if (!marker) {
            marker = L.circleMarker(latLng, { radius: 8, fillOpacity: 0.9, weight: 2 }).addTo(map);
            participantMarkers.set(row, marker);
        }
        marker.setLatLng(latLng).setStyle({ color: colorOf(row) }).unbindPopup()
            .bindTooltip(escapeHtml(participantName(row)), { permanent: true, direction: 'top', offset: [0, -8] });
    }

    // Any change to the participants makes the displayed result stale
    function clearResults() {
        resultLayer.clearLayers();
        routeLayers = [];
        current = null;
        participantMarkers.forEach(m => m.unbindPopup());
        results.hidden = true;
    }

    // ---- Address autocompletion (French national address base, IGN Géoplateforme),
    //      restricted to Haute-Garonne: addresses and points of interest ----
    async function suggestPlaces(text) {
        const params = new URLSearchParams({
            text,
            terr:             '31',
            type:             'StreetAddress,PositionOfInterest',
            maximumResponses: 6,
            lonlat:           `${TOULOUSE[1]},${TOULOUSE[0]}`,
        });
        session.geocode++;
        renderCalls();
        const res = await fetch(`https://data.geopf.fr/geocodage/completion/?${params}`);
        if (!res.ok) throw new Error(`Geocoding completion failed: ${res.status}`);
        return ((await res.json()).results || []).map(r => ({
            label: r.fulltext, kind: PLACE_KINDS[r.kind] || r.kind || '', lat: r.y, lon: r.x,
        }));
    }

    // Nearest address of a position, null if none or unavailable
    async function reverseGeocode(lat, lon) {
        session.geocode++;
        renderCalls();
        try {
            const res = await fetch(`https://data.geopf.fr/geocodage/reverse?${new URLSearchParams({ lat, lon, limit: 1 })}`);
            if (!res.ok) throw new Error(`Reverse geocoding failed: ${res.status}`);
            return (await res.json()).features?.[0]?.properties.label || null;
        } catch (err) {
            console.error(err);
            return null;
        }
    }

    function setPosition(row, place) {
        if (place) {
            row.dataset.lat = place.lat;
            row.dataset.lon = place.lon;
            row.querySelector('[name="address"]').value = place.label;
        } else {
            delete row.dataset.lat;
            delete row.dataset.lon;
        }
        row.classList.toggle('participant--located', !!place);
        // A located participant folds into a one-line summary, unfolded again by "modifier"
        row.classList.toggle('participant--collapsed', !!place);
        row.querySelector('.participant-hint').textContent = place
            ? '✓ position enregistrée'
            : 'choisissez une proposition dans la liste';
        updateSummary(row);
        updateMarker(row);
        clearResults();
        if (place) fitParticipants();
    }

    function attachAutocomplete(row) {
        const input = row.querySelector('[name="address"]');
        const box = row.querySelector('.address-options');
        let options = [];
        let active = -1;
        let timer = null;
        let requestId = 0;

        const close = () => {
            box.hidden = true;
            input.setAttribute('aria-expanded', 'false');
            input.removeAttribute('aria-activedescendant');
            active = -1;
        };
        const highlight = index => {
            active = index;
            [...box.children].forEach((li, i) => li.setAttribute('aria-selected', i === index ? 'true' : 'false'));
            if (index >= 0) input.setAttribute('aria-activedescendant', box.children[index].id);
        };
        const choose = index => {
            if (!options[index]) return;
            setPosition(row, options[index]);
            close();
        };
        const render = () => {
            box.innerHTML = options.length
                ? options.map((o, i) => `
                    <li role="option" id="${box.id}-${i}" aria-selected="false" data-index="${i}">
                        ${escapeHtml(o.label)} <span class="location-muted">${escapeHtml(o.kind)}</span></li>`).join('')
                : '<li class="address-empty">Aucun résultat en Haute-Garonne</li>';
            box.hidden = false;
            input.setAttribute('aria-expanded', 'true');
            active = -1;
        };

        input.addEventListener('input', () => {
            if (row.dataset.lat) setPosition(row, null);
            clearTimeout(timer);
            const text = input.value.trim();
            if (text.length < MIN_QUERY_LENGTH) return close();
            timer = setTimeout(async () => {
                const id = ++requestId;
                try {
                    const found = await suggestPlaces(text);
                    if (id !== requestId) return; // a newer query was sent meanwhile
                    options = found;
                    render();
                } catch (err) {
                    console.error(err);
                    row.querySelector('.participant-hint').textContent = 'géocodage indisponible';
                }
            }, SUGGEST_DELAY_MS);
        });

        input.addEventListener('keydown', e => {
            if (box.hidden || !options.length) return;
            if (e.key === 'ArrowDown') { e.preventDefault(); highlight((active + 1) % options.length); }
            else if (e.key === 'ArrowUp') { e.preventDefault(); highlight((active - 1 + options.length) % options.length); }
            else if (e.key === 'Enter') { e.preventDefault(); choose(active >= 0 ? active : 0); }
            else if (e.key === 'Escape') close();
        });

        // mousedown fires before the input blur, so the click is not lost
        box.addEventListener('mousedown', e => {
            const li = e.target.closest('li[data-index]');
            if (!li) return;
            e.preventDefault();
            choose(Number(li.dataset.index));
        });
        input.addEventListener('blur', close);
    }

    // ---- Participants form ----
    let rowCounter = 0;
    function addParticipant() {
        const uid = ++rowCounter;
        const row = document.createElement('fieldset');
        row.className = 'participant';
        row.innerHTML = `
            <legend class="participant-legend"></legend>
            <div class="participant-summary">
                <span class="participant-summary-text"></span>
                <button type="button" class="location-button location-button--ghost" data-action="edit">modifier</button>
            </div>
            <label class="location-field">
                <span>Nom</span>
                <input type="text" name="name" maxlength="40">
            </label>
            <div class="location-field participant-address">
                <label for="address-${uid}">Adresse ou lieu</label>
                <input type="text" id="address-${uid}" name="address" placeholder="ex. place du Capitole"
                    autocomplete="off" role="combobox" aria-autocomplete="list" aria-expanded="false"
                    aria-controls="address-options-${uid}">
                <ul class="address-options" id="address-options-${uid}" role="listbox" hidden></ul>
                <span class="participant-hint">choisissez une proposition dans la liste</span>
            </div>
            <button type="button" class="location-button" data-action="locate">ma position actuelle</button>
            <div class="participant-modes" role="group" aria-label="Modes de transport">
                ${Object.entries(MODE_LABELS).map(([mode, label]) => `
                    <label><input type="checkbox" name="modes" value="${mode}"${mode === 'transit' ? ' checked' : ''}> ${label}</label>
                `).join('')}
            </div>
            <button type="button" class="location-button location-button--ghost" data-action="remove" aria-label="Retirer ce participant">retirer</button>`;
        list.appendChild(row);
        attachAutocomplete(row);
        refreshRows();
    }

    function updateSummary(row) {
        const modes = [...row.querySelectorAll('[name="modes"]:checked')].map(c => MODE_LABELS[c.value]);
        row.querySelector('.participant-summary-text').innerHTML = `<strong>${escapeHtml(participantName(row))}</strong>
            · ${escapeHtml(row.querySelector('[name="address"]').value)}
            · <span class="${modes.length ? '' : 'participant-summary-warning'}">${escapeHtml(modes.join(', ') || 'aucun mode')}</span>`;
    }

    function refreshRows() {
        [...list.children].forEach((row, i) => {
            const legend = row.querySelector('legend');
            legend.textContent = `participant ${i + 1}`;
            legend.style.color = PARTICIPANT_COLORS[i];
            row.querySelector('[name="name"]').placeholder = `Participant ${i + 1}`;
            row.querySelector('[data-action="remove"]').hidden = list.children.length <= 1;
            updateSummary(row);
            updateMarker(row);
        });
        addBtn.disabled = list.children.length >= MAX_PARTICIPANTS;
    }

    list.addEventListener('input', e => {
        if (e.target.name !== 'name') return;
        const row = e.target.closest('.participant');
        updateSummary(row);
        updateMarker(row);
    });
    list.addEventListener('change', e => {
        if (e.target.name !== 'modes') return;
        updateSummary(e.target.closest('.participant'));
        clearResults();
    });

    list.addEventListener('click', e => {
        const button = e.target.closest('button[data-action]');
        if (!button) return;
        const row = button.closest('.participant');
        if (button.dataset.action === 'edit') {
            row.classList.remove('participant--collapsed');
            row.querySelector('[name="address"]').focus();
            return;
        }
        if (button.dataset.action === 'remove') {
            participantMarkers.get(row)?.remove();
            participantMarkers.delete(row);
            row.remove();
            refreshRows();
            clearResults();
            return;
        }
        if (!navigator.geolocation) return setStatus('Géolocalisation non disponible dans ce navigateur.');
        button.disabled = true;
        navigator.geolocation.getCurrentPosition(async pos => {
            const { latitude: lat, longitude: lon } = pos.coords;
            const label = await reverseGeocode(lat, lon);
            // The exact position is kept: the address only describes it
            setPosition(row, { lat, lon, label: label || 'ma position actuelle' });
            button.disabled = false;
        }, () => {
            setStatus('Position refusée ou introuvable.');
            button.disabled = false;
        }, { enableHighAccuracy: true, timeout: 10000 });
    });

    addBtn.addEventListener('click', addParticipant);
    addParticipant();
    addParticipant();

    function readParticipants() {
        return [...list.children].map(row => {
            const name = participantName(row);
            const modes = [...row.querySelectorAll('[name="modes"]:checked')].map(c => c.value);
            if (!row.dataset.lat) {
                row.querySelector('[name="address"]').focus();
                throw new Error(`Choisissez une adresse dans la liste (ou « ma position actuelle ») pour ${name}.`);
            }
            if (!modes.length) throw new Error(`Choisissez au moins un mode de transport pour ${name}.`);
            return { name, modes, lat: Number(row.dataset.lat), lon: Number(row.dataset.lon), row };
        });
    }

    // ---- Progress steps ----
    function resetSteps() {
        steps.innerHTML = STEPS.map(s => `
            <li class="progress-step" data-step="${s.id}" data-state="pending">
                <span class="progress-label">${s.label}</span>
                <span class="progress-detail location-muted"></span></li>`).join('');
        steps.hidden = false;
    }

    function setStep(id, state, detail) {
        const li = steps.querySelector(`[data-step="${id}"]`);
        li.dataset.state = state;
        if (detail != null) li.querySelector('.progress-detail').textContent = detail;
    }

    function failRunningStep(message) {
        const running = steps.querySelector('[data-state="running"]') || steps.querySelector('[data-state="pending"]');
        if (running) setStep(running.dataset.step, 'error', message);
    }

    function describeCandidates(candidates) {
        const counts = {};
        candidates.forEach(c => { counts[c.kind] = (counts[c.kind] || 0) + 1; });
        const parts = Object.entries(counts).map(([kind, n]) => `${n} ${n > 1 ? KIND_PLURALS[kind] : KIND_LABELS[kind]}`);
        return `${candidates.length} lieu${candidates.length > 1 ? 'x' : ''}${parts.length ? ` : ${parts.join(', ')}` : ''}`;
    }


    // ---- Results: the chosen place (best by default, or picked in the list or on the map),
    //      each participant's trip to it, and the paths on the map ----
    const formatClock = iso => new Date(iso).toLocaleTimeString('fr-FR', {
        hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Paris',
    });

    function choiceText(choice) {
        return choice ? `${formatDuration(choice.seconds)} (${MODE_LABELS[choice.mode]})` : 'injoignable';
    }

    function drawCenter(center) {
        L.circleMarker([center.lat, center.lon], { radius: 4, color: COLORS.center, fillOpacity: 1, weight: 1 })
            .bindTooltip('barycentre')
            .addTo(resultLayer);
    }

    // Candidates in grey (clickable once evaluated), the selected one in orange
    function drawCandidates(candidates, selected = null) {
        candidates.forEach((c, j) => {
            const isSelected = j === selected;
            const marker = L.circleMarker([c.lat, c.lon], isSelected
                ? { radius: 11, color: COLORS.best, fillOpacity: 0.9, weight: 3 }
                : { radius: 6, color: COLORS.candidate, fillOpacity: 0.7, weight: 1 })
                .bindTooltip(`${escapeHtml(c.name)} · ${KIND_LABELS[c.kind]}`
                    + (c.score !== undefined ? ` · ${c.score != null ? `total ${formatDuration(c.score)}` : 'injoignable'}` : ''))
                .addTo(resultLayer);
            if (c.score != null && !isSelected) marker.on('click', () => selectPlace(j));
        });
    }

    const straightLine = (from, to, color) => L.polyline([[from.lat, from.lon], [to.lat, to.lon]],
        { color, weight: 2, dashArray: '4 6', opacity: 0.6 });

    // A participant's path to the selected place: solid for walk, bike, car and transit lines,
    // dotted for walking parts of a transit trip; a straight dashed line until it is known
    function drawRoute(i) {
        const place = current.data.candidates[current.selected];
        const p = current.data.participants[i];
        const color = PARTICIPANT_COLORS[i];
        const route = current.routes.get(place.id)?.get(i);
        const group = routeLayers[i];
        group.clearLayers();
        if (!route?.legs) {
            const line = straightLine(p, place, color).addTo(group);
            if (route?.error) line.bindTooltip(route.error, { sticky: true });
            return;
        }
        route.legs.forEach(leg => {
            const walking = leg.kind === 'walk' && route.mode === 'transit';
            const label = leg.kind === 'line'
                ? `${p.name} · ${leg.mode || 'ligne'} ${leg.line || ''}`
                : `${p.name} · ${MODE_LABELS[walking ? 'walk' : route.mode]}`;
            if (!leg.path.length) return;
            L.polyline(leg.path, walking
                ? { color, weight: 3, dashArray: '2 6', opacity: 0.9 }
                : { color, weight: 4, opacity: 0.8 })
                .bindTooltip(escapeHtml(label), { sticky: true })
                .addTo(group);
        });
    }

    function drawSelection(fit) {
        const { data, rows, selected } = current;
        const place = data.candidates[selected];
        resultLayer.clearLayers();
        drawCenter(data.center);
        drawCandidates(data.candidates, selected);
        routeLayers = data.participants.map((p, i) => {
            participantMarkers.get(rows[i])
                ?.bindPopup(`<strong>${escapeHtml(p.name)}</strong><br>${choiceText(place?.choices[i])}`);
            return place ? L.layerGroup().addTo(resultLayer) : null;
        });
        if (place) data.participants.forEach((_, i) => drawRoute(i));
        if (fit) {
            const points = [...data.candidates.map(c => [c.lat, c.lon]), ...data.participants.map(p => [p.lat, p.lon])];
            if (points.length) map.fitBounds(points, { padding: [30, 30], maxZoom: 16 });
        }
    }

    // Route events, from the computation or from a later selection, kept per place
    function storeRoute(event) {
        if (!current) return;
        if (!current.routes.has(event.place)) current.routes.set(event.place, new Map());
        current.routes.get(event.place).set(event.participant, event);
        if (current.data.candidates[current.selected]?.id === event.place) drawRoute(event.participant);
    }

    // Show another place; its openrouteservice paths are fetched once, only when it is shown
    async function selectPlace(j) {
        if (!current || j === current.selected || current.data.candidates[j]?.score == null) return;
        current.selected = j;
        renderResults();
        drawSelection(false);
        const place = current.data.candidates[j];
        if (current.routes.has(place.id)) return;
        current.routes.set(place.id, new Map());
        const before = lastRun.orsDirections;
        await placeRoutes(current.data.participants, place, keys, lastRun, event => {
            if (event.orsQuota) orsQuota.directions = event.orsQuota;
            storeRoute(event);
            renderCalls();
        });
        if (!running) session.orsDirections += lastRun.orsDirections - before;
        renderCalls();
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
                    · ${leg.stops} arrêt${leg.stops > 1 ? 's' : ''}</span></li>`);
        });
        items.push(`<li class="trip-step trip-step--time">Arrivée ${formatClock(trip.arrival)}`
            + `${lines.length > 1 ? ` · ${lines.length - 1} correspondance${lines.length > 2 ? 's' : ''}` : ''}</li>`);
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
            </article>`;
    }

    function renderResults() {
        const { data, selected } = current;
        const place = selected != null ? data.candidates[selected] : null;
        const best = data.best != null ? data.candidates[data.best] : null;
        const slotText = `${data.slot.from.slice(11)} – ${data.slot.to.slice(11)}`;

        if (!place) {
            results.innerHTML = `
                <div class="chart-header"><h2 class="chart-title">Lieu retenu</h2></div>
                <p class="location-best">${data.candidates.length
                    ? 'Aucun candidat n\'est atteignable par tous les participants.'
                    : 'Aucun candidat trouvé autour du barycentre.'}</p>`;
            results.hidden = false;
            return;
        }

        const ranked = data.candidates.map((c, j) => ({ c, j }))
            .sort((a, b) => (a.c.score ?? Infinity) - (b.c.score ?? Infinity));
        const options = ranked.map(({ c, j }) => `
            <option value="${j}"${j === selected ? ' selected' : ''}${c.score == null ? ' disabled' : ''}>
                ${escapeHtml(c.name)} (${KIND_LABELS[c.kind]}) — ${c.score != null ? formatDuration(c.score) : 'injoignable'}${j === data.best ? ' · retenu' : ''}
            </option>`).join('');

        results.innerHTML = `
            <div class="chart-header">
                <h2 class="chart-title">${place === best ? 'Lieu retenu' : 'Lieu choisi'}</h2>
                <label class="location-field location-place-select">
                    <span>Autres lieux</span>
                    <select id="place-select">${options}</select>
                </label>
            </div>
            <p class="location-best"><span class="location-swatch location-swatch--best"></span>
                <strong>${escapeHtml(place.name)}</strong> (${KIND_LABELS[place.kind]}) — arrivée ${slotText}</p>
            <div class="trip-cards">${data.participants.map((p, i) => tripCard(p, i, place)).join('')}</div>`;
        results.querySelector('#place-select').addEventListener('change', e => selectPlace(Number(e.target.value)));
        results.hidden = false;
    }

    // ---- Run ----
    function handleEvent(event, participants, rows, state) {
        // Calls answer in parallel: within a run, keep the lowest remaining count of each service
        const quota = event.orsQuota;
        if (quota) {
            state.quotaSeen = state.quotaSeen || {};
            if (!state.quotaSeen[quota.service] || quota.remaining < orsQuota[quota.service].remaining) {
                orsQuota[quota.service] = quota;
                state.quotaSeen[quota.service] = true;
                renderCalls();
            }
        }

        switch (event.type) {
        case 'start': {
            setStep('center', 'done', `${event.center.lat.toFixed(4)}, ${event.center.lon.toFixed(4)}`);
            setStep('candidates', 'running', 'recherche à 1 km autour du barycentre…');
            resultLayer.clearLayers();
            drawCenter(event.center);
            state.matrixModes = ORS_MODES.filter(m => participants.some(p => p.modes.includes(m)));
            state.matrixDone = [];
            break;
        }
        case 'candidates':
            setStep('candidates', 'done', `${describeCandidates(event.candidates)} `
                + `(données OSM du ${event.sources.osm || '—'}, GTFS du ${event.sources.gtfs})`);
            drawCandidates(event.candidates);
            setStep('matrix', state.matrixModes.length ? 'running' : 'done',
                state.matrixModes.length ? `0/${state.matrixModes.length} matrice(s)` : 'aucun participant concerné');
            break;
        case 'matrix':
            state.matrixDone.push(MODE_LABELS[event.mode]);
            setStep('matrix', 'running', `${state.matrixDone.length}/${state.matrixModes.length} matrice(s) : `
                + `${state.matrixDone.join(', ')} (${event.sources} × ${event.destinations} temps chacune)`);
            break;
        case 'transit': {
            if (state.matrixModes.length) setStep('matrix', 'done');
            const usesTransit = participants.some(p => p.modes.includes('transit'));
            if (!usesTransit) setStep('transit', 'done', 'aucun participant concerné');
            else setStep('transit', event.done === event.total ? 'done' : 'running', `${event.done}/${event.total} trajets`);
            if (event.done === event.total) setStep('result', 'running');
            break;
        }
        case 'result': {
            const reachable = event.candidates.filter(c => c.score != null).length;
            STEPS.forEach(s => {
                const li = steps.querySelector(`[data-step="${s.id}"]`);
                if (s.id !== 'routes' && li.dataset.state !== 'done') setStep(s.id, 'done', s.id === 'result' ? null : '—');
            });
            setStep('result', 'done', event.best != null
                ? `${reachable}/${event.candidates.length} candidats atteignables par tous`
                : 'aucun lieu retenu');
            state.routesTotal = event.best != null ? event.participants.length : 0;
            state.routesDone = 0;
            setStep('routes', state.routesTotal ? 'running' : 'done',
                state.routesTotal ? `0/${state.routesTotal}` : 'aucun lieu retenu');
            current = { data: event, rows, selected: event.best, routes: new Map() };
            drawSelection(true);
            renderResults();
            scrollToSection(results);
            break;
        }
        case 'route':
            storeRoute(event);
            setStep('routes', 'running', `${++state.routesDone}/${state.routesTotal}`);
            break;
        case 'done':
            setStep('routes', 'done');
            break;
        default:
            break;
        }
    }

    // Candidate places, loaded once per page
    let dataPromise = null;
    const getData = () => {
        dataPromise = dataPromise || loadData().catch(err => { dataPromise = null; throw err; });
        return dataPromise;
    };

    // Other place types make the displayed result stale
    document.getElementById('categories').addEventListener('change', clearResults);

    form.addEventListener('submit', async e => {
        e.preventDefault();
        if (!keys.ors) return showKeys();
        const submit = form.querySelector('[type="submit"]');
        let participants;
        try {
            participants = readParticipants();
        } catch (err) {
            return setStatus(err.message);
        }
        const categories = [...form.querySelectorAll('[name="categories"]:checked')].map(c => c.value);
        if (!categories.length) return setStatus('Choisissez au moins un type de lieu.');

        setStatus('');
        clearResults();
        resetSteps();
        scrollToSection(document.getElementById('location-progress'));
        submit.disabled = true;
        lastRun = { orsMatrix: 0, orsDirections: 0, transitous: 0 };
        running = true;
        renderCalls();
        const rows = participants.map(p => p.row);
        const state = {};
        try {
            const data = await getData();
            const input = { slot: slot.value, categories, participants: participants.map(({ row, ...p }) => p) };
            // lastRun is updated by the engine as calls are made
            await evaluate(input, keys, data, lastRun, event => {
                handleEvent(event, participants, rows, state);
                renderCalls();
            });
        } catch (err) {
            console.error(err);
            failRunningStep(err.message || 'calcul impossible');
            setStatus(err.message || 'Calcul impossible.');
        } finally {
            Object.keys(lastRun).forEach(k => { session[k] += lastRun[k]; });
            running = false;
            submit.disabled = !keys.ors;
            renderCalls();
        }
    });

    showKeys();
})();
