// main.js - Meeting point prototype, entirely in the browser: the user's API keys, participants
// form with address autocompletion, computation progress, API call counters and the glue between
// the engine and the page's other modules (search, slots, map, results).

import { loadData, evaluate, placeRoutes } from './engine.js';
import { loadKeys, saveKeys, clearKeys } from './keys.js';
import { createPlaceSearch } from './search.js';
import { slotPicker } from './slots.js';
import { TOULOUSE, createMap, drawCenter, drawCandidates, drawRoute as drawPath } from './map.js';
import { resultsHtml, choiceText } from './results.js';
import { MODE_LABELS, PARTICIPANT_COLORS } from './labels.js';
import { escapeHtml } from '../format.js';

(function () {
    const form = document.getElementById('location-form');
    if (!form || !window.L) return;

    const MAX_PARTICIPANTS = 5;
    const MIN_QUERY_LENGTH = 3;       // Géoplateforme suggestions
    const MIN_LOCAL_QUERY_LENGTH = 2; // local place suggestions
    const SUGGEST_DELAY_MS = 250;
    const ORS_MODES = ['walk', 'bike', 'car'];
    const DEFAULT_MODES = ['walk', 'transit']; // checked for every new participant
    // Plurals of the candidate categories; every category's label comes with the data
    const CATEGORY_PLURALS = {
        'amenity=bar': 'bars', 'amenity=restaurant': 'restaurants', metro: 'stations de métro', bus: 'arrêts de bus',
    };
    const PLACE_KINDS = { housenumber: 'adresse', street: 'voie', municipality: 'commune', locality: 'lieu-dit' };
    const STEPS = [
        { id: 'center',     label: 'Barycentre des participants' },
        { id: 'candidates', label: 'Lieux candidats (extrait local OSM + GTFS Tisséo)' },
        { id: 'matrix',     label: 'Temps marche, vélo, voiture (openrouteservice)' },
        { id: 'transit',    label: 'Temps en transports en commun' },
        { id: 'result',     label: 'Sélection du lieu' },
        { id: 'routes',     label: 'Tracés des itinéraires (openrouteservice directions, trajets en transports en commun)' },
    ];

    const list    = document.getElementById('participants');
    const addBtn  = document.getElementById('add-participant');
    const slot    = document.getElementById('slot');
    const status  = document.getElementById('location-status');
    const results = document.getElementById('location-results');
    const banner  = document.getElementById('location-banner');
    const steps   = document.getElementById('progress-steps');
    const callsEl = document.getElementById('location-calls');

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
    const tisseoInput = document.getElementById('tisseo-key');
    const tisseoEngine = form.querySelector('[name="transit-engine"][value="tisseo"]');
    const engineHint = document.getElementById('transit-engine-hint');
    const ENGINE_NAMES = { transitous: 'Transitous', tisseo: 'Tisséo' };
    let keys = loadKeys();

    function showKeys(message) {
        orsInput.value = keys.ors || '';
        tisseoInput.value = keys.tisseo || '';
        keysPanel.open = !keys.ors;
        const saved = [keys.ors && 'openrouteservice', keys.tisseo && 'Tisséo'].filter(Boolean);
        keysStatus.textContent = message || (saved.length
            ? `Clé${saved.length > 1 ? 's' : ''} ${saved.join(' et ')} enregistrée${saved.length > 1 ? 's' : ''} (dans ce navigateur uniquement).`
            : 'Aucune clé enregistrée.');
        // Tisséo needs the visitor's own key; without it, back to Transitous
        tisseoEngine.disabled = !keys.tisseo;
        if (!keys.tisseo && tisseoEngine.checked) form.querySelector('[name="transit-engine"][value="transitous"]').checked = true;
        engineHint.textContent = keys.tisseo ? '' : 'Tisséo : saisissez votre clé dans « Clés API ».';
        form.querySelector('[type="submit"]').disabled = !keys.ors;
        banner.hidden = !!keys.ors;
        banner.textContent = 'Saisissez votre clé openrouteservice dans « Clé API » pour utiliser le service.';
    }

    keysForm.addEventListener('submit', e => {
        e.preventDefault();
        const persisted = saveKeys({ ors: orsInput.value.trim(), tisseo: tisseoInput.value.trim() });
        keys = loadKeys();
        showKeys(persisted ? null : 'Stockage local indisponible : clé gardée jusqu\'à la fermeture de la page.');
    });
    document.getElementById('keys-clear').addEventListener('click', () => {
        clearKeys();
        keys = {};
        showKeys('Clés effacées de ce navigateur.');
    });

    // ---- External API calls: last computation and whole session (since the page was loaded) ----
    const session = { geocode: 0, orsMatrix: 0, orsDirections: 0, transitous: 0, tisseo: 0 };
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
            + row('Transitous', 'transitous', ' <span class="location-muted">(au-delà de 720/24 h, se coordonner avec Transitous)</span>')
            + row('Tisséo', 'tisseo', ' <span class="location-muted">(2 appels par trajet)</span>');
    }
    renderCalls();

    // ---- Arrival slot (slots.js) ----
    const slotValue = slotPicker(slot, document.getElementById('slot-options'));

    // ---- Map (map.js) ----
    const map = createMap('location-map');
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

    // Places (with their precomputed addresses) and category labels, loaded once per page, as
    // soon as the page is shown (see loadPlaceIndex below)
    let dataPromise = null;
    let categoryLabels = {};
    const getData = () => {
        dataPromise = dataPromise || loadData()
            .then(data => { categoryLabels = data.categories; return data; })
            .catch(err => { dataPromise = null; throw err; });
        return dataPromise;
    };

    // ---- Local place search (search.js), without any call ----
    let placeSearch = null; // search(text, origin), once the places are loaded and indexed

    function loadPlaceIndex() {
        return getData()
            .then(data => { placeSearch = placeSearch || createPlaceSearch(data); })
            .catch(err => console.error(err));
    }


    // Load the places and build the search index as soon as the page is shown (after its own
    // resources, so the map is not slowed down): the search is ready before the first address is typed
    if (document.readyState === 'complete') loadPlaceIndex();
    else window.addEventListener('load', loadPlaceIndex, { once: true });

    // Center of the participants already located, the Capitole (TOULOUSE) if none
    function searchOrigin() {
        const located = [...list.children].filter(r => r.dataset.lat);
        if (!located.length) return { lat: TOULOUSE[0], lon: TOULOUSE[1] };
        return {
            lat: located.reduce((s, r) => s + Number(r.dataset.lat), 0) / located.length,
            lon: located.reduce((s, r) => s + Number(r.dataset.lon), 0) / located.length,
        };
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
            focusNextParticipant(row);
        };
        // Local places (name, tag and address) first, then Géoplateforme addresses;
        // pending: Géoplateforme has not answered yet, so "no result" is not shown
        const render = (pending = false) => {
            if (!options.length && pending) return close();
            box.innerHTML = options.length
                ? options.map((o, i) => `
                    <li role="option" id="${box.id}-${i}" aria-selected="false" data-index="${i}">
                        ${o.name
                            ? `<strong>${escapeHtml(o.name)}</strong> <span class="address-tag">${escapeHtml(o.kind)}</span>
                               <span class="address-detail">${escapeHtml(o.address)}</span>`
                            : `${escapeHtml(o.label)} <span class="location-muted">${escapeHtml(o.kind)}</span>`}</li>`).join('')
                : '<li class="address-empty">Aucun résultat en Haute-Garonne</li>';
            box.hidden = false;
            input.setAttribute('aria-expanded', 'true');
            active = -1;
        };

        input.addEventListener('input', async () => {
            if (row.dataset.lat) setPosition(row, null);
            clearTimeout(timer);
            const id = ++requestId; // answers to older queries are ignored
            const text = input.value.trim();
            if (text.length < MIN_LOCAL_QUERY_LENGTH) return close();
            if (!placeSearch) await loadPlaceIndex(); // typed before the data file arrived
            if (id !== requestId) return;
            const local = placeSearch ? placeSearch(text, searchOrigin()) : [];
            options = local;
            render(true);
            if (text.length < MIN_QUERY_LENGTH) return;
            timer = setTimeout(async () => {
                try {
                    const found = await suggestPlaces(text);
                    if (id !== requestId) return;
                    options = [...local, ...found];
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
    // Keyboard flow on computers: Tab goes from name to address to the next name; Enter in a
    // name goes to its address; choosing an address goes to the next participant to fill,
    // or to "Trouver le lieu". Not on touch screens, where focusing opens the keyboard.
    const finePointer = window.matchMedia('(pointer: fine)').matches;

    function focusNextParticipant(row) {
        if (!finePointer) return;
        const rows = [...list.children];
        const next = rows.slice(rows.indexOf(row) + 1).find(r => !r.classList.contains('participant--collapsed'));
        (next ? next.querySelector('[name="name"]') : form.querySelector('[type="submit"]')).focus();
    }

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
                <input type="text" name="name" maxlength="40" autocomplete="off">
            </label>
            <div class="location-field participant-address">
                <label for="address-${uid}">Adresse ou lieu</label>
                <input type="text" id="address-${uid}" name="address" placeholder="ex. place du Capitole"
                    autocomplete="off" role="combobox" aria-autocomplete="list" aria-expanded="false"
                    aria-controls="address-options-${uid}">
                <ul class="address-options" id="address-options-${uid}" role="listbox" hidden></ul>
                <span class="participant-hint">choisissez une proposition dans la liste</span>
            </div>
            <button type="button" class="location-button" data-action="locate" tabindex="-1">ma position actuelle</button>
            <div class="participant-modes chips" role="group" aria-label="Modes de transport">
                ${Object.entries(MODE_LABELS).map(([mode, label]) => `
                    <label class="chip"><input type="checkbox" name="modes" value="${mode}" tabindex="-1"${DEFAULT_MODES.includes(mode) ? ' checked' : ''}><span>${label}</span></label>
                `).join('')}
            </div>
            <button type="button" class="location-button location-button--ghost" data-action="remove" tabindex="-1" aria-label="Retirer ce participant">retirer</button>`;
        list.appendChild(row);
        attachAutocomplete(row);
        refreshRows();
        return row;
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

    list.addEventListener('keydown', e => {
        if (e.key !== 'Enter' || e.target.name !== 'name') return;
        e.preventDefault();
        e.target.closest('.participant').querySelector('[name="address"]').focus();
    });

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
            // The exact position is kept at once; the address, which only describes it, follows
            setPosition(row, { lat, lon, label: 'ma position (adresse en cours…)' });
            button.disabled = false;
            const label = await reverseGeocode(lat, lon);
            if (row.dataset.lat !== String(lat) || row.dataset.lon !== String(lon)) return; // edited meanwhile
            row.querySelector('[name="address"]').value = label || 'ma position actuelle';
            updateSummary(row);
        }, () => {
            setStatus('Position refusée ou introuvable.');
            button.disabled = false;
        }, { enableHighAccuracy: true, timeout: 10000 });
    });

    addBtn.addEventListener('click', () => {
        const row = addParticipant();
        if (finePointer) row.querySelector('[name="name"]').focus();
    });
    const firstRow = addParticipant();
    addParticipant();
    if (finePointer) firstRow.querySelector('[name="name"]').focus();

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
        candidates.forEach(c => { counts[c.category] = (counts[c.category] || 0) + 1; });
        const parts = Object.entries(counts)
            .map(([category, n]) => `${n} ${n > 1 ? CATEGORY_PLURALS[category] : categoryLabels[category]}`);
        return `${candidates.length} lieu${candidates.length > 1 ? 'x' : ''}${parts.length ? ` : ${parts.join(', ')}` : ''}`;
    }

    // ---- Results (results.js): the chosen place, each participant's trip to it, and the paths
    //      on the map ----
    function drawRoute(i) {
        const place = current.data.candidates[current.selected];
        const route = current.routes.get(place.id)?.get(i);
        drawPath(routeLayers[i], current.data.participants[i], place, route, PARTICIPANT_COLORS[i]);
    }

    function drawSelection(fit) {
        const { data, rows, selected } = current;
        const place = data.candidates[selected];
        resultLayer.clearLayers();
        drawCenter(resultLayer, data.center);
        drawCandidates(resultLayer, data.candidates, categoryLabels, selected, selectPlace);
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

    function renderResults() {
        results.innerHTML = resultsHtml(current.data, current.selected, categoryLabels);
        results.querySelector('#place-select')?.addEventListener('change', e => selectPlace(Number(e.target.value)));
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
            setStep('candidates', 'running', 'recherche autour du barycentre…');
            resultLayer.clearLayers();
            drawCenter(resultLayer, event.center);
            state.matrixModes = ORS_MODES.filter(m => participants.some(p => p.modes.includes(m)));
            state.matrixDone = [];
            break;
        }
        case 'candidates':
            setStep('candidates', 'done', `${describeCandidates(event.candidates)} `
                + `à moins de ${(event.radius / 1000).toLocaleString('fr-FR')} km `
                + `(données OSM du ${event.sources.osm || '—'}, GTFS du ${event.sources.gtfs})`);
            drawCandidates(resultLayer, event.candidates, categoryLabels);
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
            else {
                const failed = event.errors ? `, ${event.errors} en erreur après 2 essais` : '';
                setStep('transit', event.done === event.total ? 'done' : 'running',
                    `${event.done}/${event.total} trajets (${ENGINE_NAMES[event.engine]})${failed}`);
            }
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

    // Other place types or another transit engine make the displayed result stale
    document.getElementById('categories').addEventListener('change', clearResults);
    document.getElementById('transit-engine').addEventListener('change', clearResults);

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
        lastRun = { orsMatrix: 0, orsDirections: 0, transitous: 0, tisseo: 0 };
        running = true;
        renderCalls();
        const rows = participants.map(p => p.row);
        const state = {};
        try {
            const data = await getData();
            const transitEngine = form.querySelector('[name="transit-engine"]:checked').value;
            const input = { slot: slotValue(), categories, transitEngine, participants: participants.map(({ row, ...p }) => p) };
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
