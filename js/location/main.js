// main.js - Meeting point prototype, entirely in the browser: the user's API keys, participants
// form with address autocompletion, OpenStreetMap map (Leaflet), computation progress, API call
// counters and results.

import { loadData, evaluate } from './engine.js';
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
    const KIND_LABELS = { bar: 'bar', square: 'place', metro: 'métro', bus: 'arrêt de bus' };
    const KIND_PLURALS = { bar: 'bars', square: 'places', metro: 'stations de métro', bus: 'arrêts de bus' };
    const PLACE_KINDS = { housenumber: 'adresse', street: 'voie', municipality: 'commune', locality: 'lieu-dit' };
    const COLORS = { candidate: '#7A90AA', best: '#EA580C', center: '#0C1A2E' };
    const STEPS = [
        { id: 'center',     label: 'Barycentre des participants' },
        { id: 'candidates', label: 'Lieux candidats (extrait local OSM + GTFS Tisséo)' },
        { id: 'matrix',     label: 'Temps marche, vélo, voiture (openrouteservice)' },
        { id: 'transit',    label: 'Temps en transports en commun (Tisséo)' },
        { id: 'result',     label: 'Sélection du lieu' },
        { id: 'routes',     label: 'Tracés des itinéraires (openrouteservice directions, Tisséo)' },
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

    function setStatus(text) {
        status.textContent = text || '';
        status.hidden = !text;
    }

    // ---- API keys (stored only in this browser) and the banner they drive ----
    const keysPanel  = document.getElementById('keys-panel');
    const keysForm   = document.getElementById('keys-form');
    const keysStatus = document.getElementById('keys-status');
    const orsInput    = document.getElementById('ors-key');
    const tisseoInput = document.getElementById('tisseo-key');
    let keys = loadKeys();
    let simulated = { transit: !keys.tisseo };

    function showKeys(message) {
        simulated = { transit: !keys.tisseo };
        orsInput.value = keys.ors || '';
        tisseoInput.value = keys.tisseo || '';
        keysPanel.open = !keys.ors;
        keysStatus.textContent = message || (keys.ors
            ? `Clé openrouteservice enregistrée${keys.tisseo ? ', clé Tisséo enregistrée' : ', pas de clé Tisséo'} (dans ce navigateur uniquement).`
            : 'Aucune clé enregistrée.');
        form.querySelector('[type="submit"]').disabled = !keys.ors;

        banner.hidden = false;
        banner.classList.toggle('location-banner--blocking', !keys.ors);
        if (!keys.ors) {
            banner.textContent = 'Saisissez votre clé openrouteservice dans « Clés API » pour utiliser le service.';
        } else if (simulated.transit) {
            banner.textContent = 'Mode test : pas de clé Tisséo, les temps en transports en commun sont simulés '
                + '(temps en voiture × 1,5).';
        } else {
            banner.hidden = true;
        }
        renderCalls();
    }

    keysForm.addEventListener('submit', e => {
        e.preventDefault();
        const persisted = saveKeys({ ors: orsInput.value.trim(), tisseo: tisseoInput.value.trim() });
        keys = loadKeys();
        showKeys(persisted ? null : 'Stockage local indisponible : clés gardées jusqu\'à la fermeture de la page.');
    });
    document.getElementById('keys-clear').addEventListener('click', () => {
        clearKeys();
        keys = {};
        showKeys('Clés effacées de ce navigateur.');
    });

    // ---- External API calls: last computation and whole session (since the page was loaded) ----
    const session = { geocode: 0, orsMatrix: 0, orsDirections: 0, tisseo: 0 };
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
            + row('Tisséo', 'tisseo', simulated.transit ? ' <span class="location-muted">(simulé, aucun appel)</span>' : '');
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
    let routeLayers = [];    // per participant: layer group holding its path to the chosen place
    let routeContext = null; // participants and chosen place of the displayed result

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
        row.querySelector('.participant-hint').textContent = place
            ? '✓ position enregistrée'
            : 'choisissez une proposition dans la liste';
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

    function refreshRows() {
        [...list.children].forEach((row, i) => {
            const legend = row.querySelector('legend');
            legend.textContent = `participant ${i + 1}`;
            legend.style.color = PARTICIPANT_COLORS[i];
            row.querySelector('[name="name"]').placeholder = `Participant ${i + 1}`;
            row.querySelector('[data-action="remove"]').hidden = list.children.length <= 1;
            updateMarker(row);
        });
        addBtn.disabled = list.children.length >= MAX_PARTICIPANTS;
    }

    list.addEventListener('input', e => {
        if (e.target.name === 'name') updateMarker(e.target.closest('.participant'));
    });
    list.addEventListener('change', e => {
        if (e.target.name === 'modes') clearResults();
    });

    list.addEventListener('click', e => {
        const button = e.target.closest('button[data-action]');
        if (!button) return;
        const row = button.closest('.participant');
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


    // ---- Map results ----
    function choiceText(choice) {
        return choice ? `${formatDuration(choice.seconds)} (${MODE_LABELS[choice.mode]})` : 'injoignable';
    }

    function drawCenter(center) {
        L.circleMarker([center.lat, center.lon], { radius: 4, color: COLORS.center, fillOpacity: 1, weight: 1 })
            .bindTooltip('barycentre')
            .addTo(resultLayer);
    }

    function drawCandidates(candidates, best = null) {
        candidates.forEach((c, j) => {
            if (j === best) return;
            L.circleMarker([c.lat, c.lon], { radius: 6, color: COLORS.candidate, fillOpacity: 0.7, weight: 1 })
                .bindPopup(`<strong>${escapeHtml(c.name)}</strong><br>${KIND_LABELS[c.kind]}`
                    + (c.score !== undefined
                        ? ` · ${c.score != null ? `total ${formatDuration(c.score)}` : 'injoignable pour un participant'}`
                        : ''))
                .addTo(resultLayer);
        });
    }

    const straightLine = (from, to, color) => L.polyline([[from.lat, from.lon], [to.lat, to.lon]],
        { color, weight: 2, dashArray: '4 6', opacity: 0.6 });

    // Replace a participant's straight line by the path of its retained mode:
    // solid for walk, bike, car and transit lines, dotted for walking parts of a transit trip
    function drawRoute(event) {
        const group = routeLayers[event.participant];
        if (!group || !event.legs) {
            const reason = event.simulated ? 'trajet simulé, pas de tracé' : event.error;
            group?.eachLayer(l => l.bindTooltip(reason || 'pas de tracé', { sticky: true }));
            return;
        }
        const color = PARTICIPANT_COLORS[event.participant];
        const name = routeContext.participants[event.participant].name;
        group.clearLayers();
        event.legs.forEach(leg => {
            const walking = leg.kind === 'walk' && event.mode === 'transit';
            const label = leg.kind === 'line'
                ? `${name} · ${leg.mode || 'ligne'} ${leg.line || ''}`
                : `${name} · ${MODE_LABELS[walking ? 'walk' : event.mode]}`;
            L.polyline(leg.path, walking
                ? { color, weight: 3, dashArray: '2 6', opacity: 0.9 }
                : { color, weight: 4, opacity: 0.8 })
                .bindTooltip(escapeHtml(label), { sticky: true })
                .addTo(group);
        });
    }

    function drawResult(data, rows) {
        resultLayer.clearLayers();
        drawCenter(data.center);
        drawCandidates(data.candidates, data.best);
        const best = data.best != null ? data.candidates[data.best] : null;
        const points = data.candidates.map(c => [c.lat, c.lon]);

        // Straight lines until the real paths arrive (route events)
        routeLayers = data.participants.map((p, i) => {
            points.push([p.lat, p.lon]);
            if (!best) return null;
            participantMarkers.get(rows[i])
                ?.bindPopup(`<strong>${escapeHtml(p.name)}</strong><br>${choiceText(best.choices[i])}`);
            return L.layerGroup([straightLine(p, best, PARTICIPANT_COLORS[i])]).addTo(resultLayer);
        });
        routeContext = { participants: data.participants, best };

        if (best) {
            L.circleMarker([best.lat, best.lon], { radius: 11, color: COLORS.best, fillOpacity: 0.9, weight: 3 })
                .bindPopup(`<strong>${escapeHtml(best.name)}</strong><br>${KIND_LABELS[best.kind]} · total ${formatDuration(best.score)}`)
                .addTo(resultLayer)
                .openPopup();
        }
        if (points.length) map.fitBounds(points, { padding: [30, 30], maxZoom: 16 });
    }

    // ---- Results tables ----
    function modeDetails(modeTimes, retained) {
        return Object.entries(modeTimes)
            .filter(([mode]) => mode !== retained)
            .map(([mode, t]) => `${MODE_LABELS[mode]} : ${t.seconds != null ? formatDuration(t.seconds) : escapeHtml(t.error)}`)
            .join(' · ') || '—';
    }

    function renderResults(data) {
        const best = data.best != null ? data.candidates[data.best] : null;
        const slotText = `${data.slot.from.slice(11)} – ${data.slot.to.slice(11)}`;
        const ranked = [...data.candidates].sort((a, b) => (a.score ?? Infinity) - (b.score ?? Infinity));

        const summary = best
            ? `<p class="location-best"><span class="location-swatch location-swatch--best"></span>
                   <strong>${escapeHtml(best.name)}</strong> (${KIND_LABELS[best.kind]}) —
                   temps total ${formatDuration(best.score)}, arrivée ${slotText}</p>
               <div class="location-table-wrap"><table class="location-table">
                   <thead><tr><th>Participant</th><th>Mode retenu</th><th>Temps</th><th>Autres modes</th></tr></thead>
                   <tbody>${data.participants.map((p, i) => `
                       <tr><td><span class="location-swatch" style="background: ${PARTICIPANT_COLORS[i]}"></span>
                           ${escapeHtml(p.name)}</td><td>${MODE_LABELS[best.choices[i].mode]}</td>
                           <td>${formatDuration(best.choices[i].seconds)}</td>
                           <td class="location-muted">${modeDetails(best.times[i], best.choices[i].mode)}</td></tr>`).join('')}
                   </tbody></table></div>`
            : `<p class="location-best">${data.candidates.length
                ? 'Aucun candidat n\'est atteignable par tous les participants.'
                : 'Aucun candidat trouvé autour du barycentre.'}</p>`;

        results.innerHTML = `
            <div class="chart-header"><h2 class="chart-title">Lieu retenu</h2></div>
            ${summary}
            ${data.candidates.length ? `
            <h3 class="location-subtitle">Candidats évalués</h3>
            <div class="location-table-wrap"><table class="location-table">
                <thead><tr><th>Candidat</th><th>Type</th><th>Au barycentre</th><th>Temps total</th></tr></thead>
                <tbody>${ranked.map(c => `
                    <tr${c === best ? ' class="location-row--best"' : ''}>
                        <td>${escapeHtml(c.name)}</td><td>${KIND_LABELS[c.kind]}</td><td>${c.distance} m</td>
                        <td>${c.score != null ? formatDuration(c.score) : '<span class="location-muted">injoignable</span>'}</td></tr>`).join('')}
                </tbody></table></div>` : ''}`;
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
            state.matrixModes = ORS_MODES.filter(m => participants.some(p => p.modes.includes(m)
                || (m === 'car' && event.simulated.transit && p.modes.includes('transit'))));
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
            else if (simulated.transit) setStep('transit', 'done', 'simulé : temps en voiture × 1,5');
            else if (event.total === 0) setStep('transit', 'done', 'aucun trajet dans le périmètre Tisséo');
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
            drawResult(event, rows);
            renderResults(event);
            break;
        }
        case 'route':
            drawRoute(event);
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

        setStatus('');
        clearResults();
        resetSteps();
        submit.disabled = true;
        lastRun = { orsMatrix: 0, orsDirections: 0, tisseo: 0 };
        running = true;
        renderCalls();
        const rows = participants.map(p => p.row);
        const state = {};
        try {
            const data = await getData();
            const input = { slot: slot.value, participants: participants.map(({ row, ...p }) => p) };
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
