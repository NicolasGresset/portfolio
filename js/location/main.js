// main.js - Meeting point prototype, entirely in the browser: the user's API keys and settings
// (practical or demonstrator view, score), participants form with address autocompletion,
// computation progress, API call counters and the glue between the engine and the page's other
// modules (search, slots, map, results).

import { loadData, evaluate, placeRoutes, rankCandidates } from './engine.js';
import { loadKeys, saveKeys, clearKeys, loadSettings, saveSettings } from './keys.js';
import { createPlaceSearch } from './search.js';
import { slotPicker } from './slots.js';
import { TOULOUSE, createMap, drawCenter, drawCandidates, drawRoute as drawPath } from './map.js';
import { resultsHtml, choiceText, placeLinks, shareText, PROPOSALS, METRIC_LABELS } from './results.js';
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
    // Modes checked for every new participant: without an openrouteservice key, only those it
    // does not need, so that a first visit can run at once
    const defaultModes = () => (keys.ors ? ['walk', 'transit'] : ['transit']);
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
    const layout  = document.querySelector('.location-layout');
    const progressBar  = document.getElementById('progress-bar');
    const progressText = document.getElementById('progress-text');

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
    // The transit engine is picked in the settings panel, outside the participants form
    const engineInput = value => document.querySelector(`[name="transit-engine"][value="${value}"]`);
    const tisseoEngine = engineInput('tisseo');
    const engineHint = document.getElementById('transit-engine-hint');
    const keysSummary = document.getElementById('keys-summary');
    const candidateCount = document.getElementById('candidate-count');
    const ENGINE_NAMES = { transitous: 'Transitous', tisseo: 'Tisséo' };
    let keys = loadKeys();

    function showKeys(message) {
        orsInput.value = keys.ors || '';
        tisseoInput.value = keys.tisseo || '';
        // Folded: no key is needed for a bus/metro computation (the banner says when one is)
        const saved = [keys.ors && 'openrouteservice', keys.tisseo && 'Tisséo'].filter(Boolean);
        keysStatus.textContent = message || (saved.length
            ? `Clé${saved.length > 1 ? 's' : ''} ${saved.join(' et ')} enregistrée${saved.length > 1 ? 's' : ''} (dans ce navigateur uniquement).`
            : 'Aucune clé enregistrée.');
        // Tisséo needs the visitor's own key; without it, back to Transitous
        tisseoEngine.disabled = !keys.tisseo;
        if (!keys.tisseo && tisseoEngine.checked) engineInput('transitous').checked = true;
        engineHint.textContent = keys.tisseo ? '' : 'Tisséo : saisissez votre clé ci-dessus.';
        showSettingsSummary();
        updateSubmit();
    }

    // The folded settings line: each key's state and the transit engine
    function showSettingsSummary() {
        const engine = ENGINE_NAMES[checkedValue('transit-engine')];
        keysSummary.textContent = `${isDemo() ? 'démonstrateur' : 'pratique'} · ${METRIC_LABELS[checkedValue('score-metric')]}`
            + ` · openrouteservice ${keys.ors ? '✓' : 'à renseigner'} · Tisséo ${keys.tisseo ? '✓' : 'facultative'}`
            + ` · bus/métro : ${engine} · ${candidateCount.value} lieux`;
    }

    // ---- Settings, kept in this browser: view, score, number of candidates, transit engine ----
    const checkedValue = name => document.querySelector(`[name="${name}"]:checked`).value;
    const isDemo = () => checkedValue('view-mode') === 'demo';
    const SETTING_RADIOS = { view: 'view-mode', metric: 'score-metric', engine: 'transit-engine' };

    function restoreSettings() {
        const saved = loadSettings();
        Object.entries(SETTING_RADIOS).forEach(([key, name]) => {
            const input = saved[key] && document.querySelector(`[name="${name}"][value="${CSS.escape(saved[key])}"]`);
            if (input) input.checked = true;
        });
        if ([...candidateCount.options].some(o => o.value === saved.candidates)) candidateCount.value = saved.candidates;
    }

    function storeSettings() {
        saveSettings({ ...Object.fromEntries(Object.entries(SETTING_RADIOS).map(([key, name]) => [key, checkedValue(name)])),
            candidates: candidateCount.value });
    }

    // openrouteservice computes walking, cycling and driving only: without its key, a computation
    // with bus/metro participants only can still run. Returns why it cannot, or null
    function submitBlocker() {
        const needsOrs = [...list.querySelectorAll('[name="modes"]:checked')].some(c => ORS_MODES.includes(c.value));
        return needsOrs && !keys.ors
            ? 'La marche, le vélo et la voiture sont calculés par openrouteservice : saisissez votre clé dans les réglages, ou ne gardez que bus/métro.'
            : null;
    }

    // A blocked button stays clickable (a disabled one gets no hover, and phones have none):
    // its title and the banner say why, and a click opens the keys panel
    function updateSubmit() {
        const reason = submitBlocker();
        const submit = form.querySelector('[type="submit"]');
        submit.setAttribute('aria-disabled', reason ? 'true' : 'false');
        submit.title = reason || '';
        banner.hidden = !reason;
        banner.textContent = reason || '';
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

    // Computers (mouse or touchpad): keyboard flow between the fields, draggable participant points
    const finePointer = window.matchMedia('(pointer: fine)').matches;

    // ---- Map (map.js) ----
    const map = createMap('location-map');
    const mapElement = document.getElementById('location-map');
    const mapHint = document.getElementById('map-hint');
    const participantMarkers = new Map(); // participant row -> marker
    const resultLayer = L.layerGroup().addTo(map);
    let routeLayers = [];    // per participant: layer group holding its path to the selected place
    // Displayed result: { data (result event), rows, selected (candidate index),
    // routes (place id -> participant index -> route event) }
    let current = null;

    // Participants are told apart by their number and color (no name field)
    const participantLabel = row => `participant ${[...list.children].indexOf(row) + 1}`;

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
            return updateMapHint();
        }
        const latLng = [Number(row.dataset.lat), Number(row.dataset.lon)];
        if (!marker) {
            // A click on a participant's point does not place the active participant there
            marker = L.circleMarker(latLng, {
                radius: 8, fillOpacity: 0.9, weight: 2, bubblingMouseEvents: false,
                className: finePointer ? 'participant-marker' : '',
            }).addTo(map);
            if (finePointer) makeDraggable(marker, row);
            participantMarkers.set(row, marker);
        }
        marker.setLatLng(latLng).setStyle({ color: colorOf(row) }).unbindPopup()
            .bindTooltip(participantLabel(row), { permanent: true, direction: 'top', offset: [0, -8] });
        updateMapHint();
    }

    // ---- Placing participants on the map: a click places the active participant (the one
    //      whose card was used last), dragging a participant's point moves it (computers only) ----
    const DOUBLE_CLICK_MS = 300;
    const DRAG_THRESHOLD_PX = 3;
    let activeRow = null;
    let clickTimer = null;
    let dragJustEnded = false;

    function setActive(row) {
        activeRow = row;
        [...list.children].forEach(r => r.classList.toggle('participant--active', r === row));
        mapElement.classList.toggle('location-map--picking', !!row);
        updateMapHint();
    }

    function updateMapHint() {
        const dragHint = finePointer && participantMarkers.size ? ' Glissez un point pour le déplacer.' : '';
        if (!activeRow) {
            mapHint.textContent = `Choisissez un participant pour le placer sur la carte.${dragHint}`;
            return;
        }
        const name = document.createElement('strong');
        name.textContent = participantLabel(activeRow);
        name.style.color = colorOf(activeRow);
        mapHint.replaceChildren('Cliquez sur la carte pour placer ', name, `.${dragHint}`);
    }

    // First participant without a position after row (then from the top), null if all are placed
    function nextToFill(row) {
        const rows = [...list.children];
        const start = rows.indexOf(row) + 1;
        return [...rows.slice(start), ...rows.slice(0, start)].find(r => !r.dataset.lat) || null;
    }

    // Once the active participant is placed, the next one to fill becomes active
    function placed(row) {
        if (activeRow === row) setActive(nextToFill(row));
    }

    // The exact position is kept at once; the address, which only describes it, follows
    async function placeAt(row, lat, lon, fallbackLabel, options) {
        setPosition(row, { lat, lon, label: `${fallbackLabel} (adresse en cours…)` }, options);
        placed(row);
        const label = await reverseGeocode(lat, lon);
        if (row.dataset.lat !== String(lat) || row.dataset.lon !== String(lon)) return; // moved meanwhile
        row.querySelector('[name="address"]').value = label || fallbackLabel;
    }

    // A double click (or double tap) only zooms: a single click waits to be sure it is one
    map.on('click', e => {
        if (dragJustEnded) return;
        if (clickTimer) {
            clearTimeout(clickTimer);
            clickTimer = null;
            return;
        }
        clickTimer = setTimeout(() => {
            clickTimer = null;
            // The map does not move under the cursor: the clicked point stays in view
            if (activeRow) placeAt(activeRow, e.latlng.lat, e.latlng.lng, 'point sur la carte', { fit: false });
        }, DOUBLE_CLICK_MS);
    });

    // Leaflet only drags its image markers: a participant's circle follows the mouse by hand,
    // listened on its own element so that the map does not pan at the same time
    function makeDraggable(marker, row) {
        marker.getElement().addEventListener('mousedown', down => {
            if (down.button !== 0) return;
            down.preventDefault();
            down.stopPropagation();
            const start = marker.getLatLng();
            let moved = false;
            mapElement.classList.add('location-map--dragging');
            const move = e => {
                moved = moved || Math.hypot(e.clientX - down.clientX, e.clientY - down.clientY) > DRAG_THRESHOLD_PX;
                if (moved) marker.setLatLng(map.mouseEventToLatLng(e));
            };
            const up = () => {
                document.removeEventListener('mousemove', move);
                mapElement.classList.remove('location-map--dragging');
                if (!moved) return marker.setLatLng(start);
                // The click that follows a drop is not a click on the map
                dragJustEnded = true;
                setTimeout(() => { dragJustEnded = false; });
                const { lat, lng } = marker.getLatLng();
                placeAt(row, lat, lng, 'point sur la carte', { fit: false });
            };
            document.addEventListener('mousemove', move);
            document.addEventListener('mouseup', up, { once: true });
        });
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

    // fit: false when the position was picked on the map, which then stays where it is
    function setPosition(row, place, { fit = true } = {}) {
        if (place) {
            row.dataset.lat = place.lat;
            row.dataset.lon = place.lon;
            row.querySelector('[name="address"]').value = place.label;
        } else {
            delete row.dataset.lat;
            delete row.dataset.lon;
        }
        row.classList.toggle('participant--located', !!place);
        // How to pick an address is said once, above the participants
        row.querySelector('.participant-hint').textContent = place ? '✓ position enregistrée' : '';
        updateMarker(row);
        clearResults();
        if (place && fit) fitParticipants();
    }

    function attachAutocomplete(row) {
        const input = row.querySelector('[name="address"]');
        const box = row.querySelector('.address-options');
        let options = [];
        let active = -1;
        let timer = null;
        let requestId = 0;

        // Touch screens: the keyboard covers the lower part of the screen, where the suggestions
        // open; the field moves to the top of the screen, below the navigation, to leave them room
        // (after the tap's own events: they would interrupt a smooth scroll started during them)
        input.addEventListener('focus', () => {
            if (!finePointer) setTimeout(() => scrollToSection(row.querySelector('.participant-address')), 50);
        });

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
            // A Géoplateforme answer still to come must not open the list again
            clearTimeout(timer);
            requestId++;
            setPosition(row, options[index]);
            placed(row);
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
    // Keyboard flow on computers: Tab goes from address to address; choosing an address goes to
    // the next participant to fill, or to "Trouver le lieu". Not on touch screens, where focusing
    // opens the keyboard.

    function focusNextParticipant(row) {
        if (!finePointer) return;
        const rows = [...list.children];
        const next = rows.slice(rows.indexOf(row) + 1).find(r => !r.dataset.lat);
        (next ? next.querySelector('[name="address"]') : form.querySelector('[type="submit"]')).focus();
    }

    let rowCounter = 0;
    function addParticipant() {
        const uid = ++rowCounter;
        const row = document.createElement('fieldset');
        row.className = 'participant';
        row.innerHTML = `
            <legend class="participant-legend"></legend>
            <div class="location-field participant-address">
                <label class="visually-hidden" for="address-${uid}">Adresse ou lieu</label>
                <!-- Address field and position button: one control for one thing, the place -->
                <div class="address-group">
                    <input type="text" id="address-${uid}" name="address" placeholder="Adresse ou lieu"
                        autocomplete="off" role="combobox" aria-autocomplete="list" aria-expanded="false"
                        aria-controls="address-options-${uid}">
                    <!-- Own drawing (a target): no third-party icon -->
                    <button type="button" class="location-button location-button--icon" data-action="locate" tabindex="-1"
                    aria-label="Ma position actuelle" title="Ma position actuelle">
                    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"
                        stroke-linecap="round" aria-hidden="true"><circle cx="12" cy="12" r="7"/><circle cx="12" cy="12" r="2.5"
                        fill="currentColor" stroke="none"/><path d="M12 1v4M12 19v4M1 12h4M19 12h4"/></svg>
            </button>
                    <ul class="address-options" id="address-options-${uid}" role="listbox" hidden></ul>
                </div>
                <span class="participant-hint"></span>
            </div>
            <div class="participant-modes chips" role="group" aria-label="Modes de transport">
                ${Object.entries(MODE_LABELS).map(([mode, label]) => `
                    <label class="chip"><input type="checkbox" name="modes" value="${mode}" tabindex="-1"${defaultModes().includes(mode) ? ' checked' : ''}><span>${label}</span></label>
                `).join('')}
            </div>
            <button type="button" class="location-button location-button--ghost participant-remove" data-action="remove" tabindex="-1"
                aria-label="Retirer ce participant" title="Retirer ce participant">×</button>`;
        list.appendChild(row);
        attachAutocomplete(row);
        refreshRows();
        return row;
    }

    function refreshRows() {
        [...list.children].forEach((row, i) => {
            // A disc in the participant's color with its number; the label for screen readers only
            const legend = row.querySelector('legend');
            legend.innerHTML = `<span class="participant-number" aria-hidden="true">${i + 1}</span>
                <span class="visually-hidden">participant ${i + 1}</span>`;
            row.style.setProperty('--participant', PARTICIPANT_COLORS[i]);
            row.querySelector('[data-action="remove"]').hidden = list.children.length <= 1;
            updateMarker(row);
        });
        addBtn.hidden = list.children.length >= MAX_PARTICIPANTS;
        updateSubmit();
    }

    // The participant whose card is used is the one a click on the map places
    list.addEventListener('focusin', e => setActive(e.target.closest('.participant')));
    // pointerdown, before the suggestion chosen with mousedown moves on to the next participant
    list.addEventListener('pointerdown', e => {
        const row = e.target.closest('.participant');
        if (row && row !== activeRow) setActive(row);
    });

    list.addEventListener('change', e => {
        if (e.target.name !== 'modes') return;
        updateSubmit();
        clearResults();
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
            if (activeRow === row) setActive(nextToFill(null));
            clearResults();
            return;
        }
        if (!navigator.geolocation) return setStatus('Géolocalisation non disponible dans ce navigateur.');
        button.disabled = true;
        navigator.geolocation.getCurrentPosition(pos => {
            button.disabled = false;
            placeAt(row, pos.coords.latitude, pos.coords.longitude, 'ma position actuelle');
        }, () => {
            setStatus('Position refusée ou introuvable.');
            button.disabled = false;
        }, { enableHighAccuracy: true, timeout: 10000 });
    });

    addBtn.addEventListener('click', () => {
        const row = addParticipant();
        setActive(row);
        if (finePointer) row.querySelector('[name="address"]').focus();
    });
    const firstRow = addParticipant();
    addParticipant();
    addParticipant();
    setActive(firstRow);
    if (finePointer) firstRow.querySelector('[name="address"]').focus();

    // Participants left untouched (no address) are ignored: three are shown by default
    function readParticipants() {
        const untouched = row => !row.dataset.lat && !row.querySelector('[name="address"]').value.trim();
        const rows = [...list.children].filter(row => !untouched(row));
        if (!rows.length) throw new Error('Choisissez une adresse pour au moins un participant.');
        return rows.map(row => {
            const label = participantLabel(row);
            const modes = [...row.querySelectorAll('[name="modes"]:checked')].map(c => c.value);
            if (!row.dataset.lat) {
                row.querySelector('[name="address"]').focus();
                throw new Error(`Choisissez une adresse dans la liste, un point sur la carte ou « ma position actuelle » pour le ${label}.`);
            }
            if (!modes.length) throw new Error(`Choisissez au moins un mode de transport pour le ${label}.`);
            // Label and color go with the participant: an ignored one before it must not shift the others'
            return { label, modes, lat: Number(row.dataset.lat), lon: Number(row.dataset.lon), color: colorOf(row), row };
        });
    }

    // ---- Progress steps ----
    function resetSteps() {
        steps.innerHTML = STEPS.map(s => `
            <li class="progress-step" data-step="${s.id}" data-state="pending">
                <span class="progress-label">${s.label}</span>
                <span class="progress-detail location-muted"></span></li>`).join('');
        steps.hidden = false;
        setProgress(0, 'Recherche des lieux candidats…');
        document.getElementById('location-progress').hidden = false;
    }

    // Practical view: one bar and one line; the transit journeys are most of the waiting
    function setProgress(fraction, text) {
        progressBar.value = fraction;
        progressText.textContent = text;
    }

    function setStep(id, state, detail) {
        const li = steps.querySelector(`[data-step="${id}"]`);
        li.dataset.state = state;
        if (detail != null) li.querySelector('.progress-detail').textContent = detail;
    }

    function failRunningStep(message) {
        const running = steps.querySelector('[data-state="running"]') || steps.querySelector('[data-state="pending"]');
        if (running) setStep(running.dataset.step, 'error', message);
        setProgress(progressBar.value, `Échec : ${message}`);
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
        const p = current.data.participants[i];
        drawPath(routeLayers[i], p, place, route, p.color);
    }

    // Practical view: the proposals only; demonstrator view: the barycenter and every candidate too
    function drawSelection(fit) {
        const { data, rows, selected } = current;
        const place = data.candidates[selected];
        const demo = isDemo();
        resultLayer.clearLayers();
        if (demo) drawCenter(resultLayer, data.center);
        drawCandidates(resultLayer, data.candidates, categoryLabels,
            { selected, proposals: data.ranking.slice(0, PROPOSALS), all: demo, onSelect: selectPlace });
        routeLayers = data.participants.map((p, i) => {
            participantMarkers.get(rows[i])
                ?.bindPopup(`<strong>${escapeHtml(p.label)}</strong><br>${choiceText(place?.choices[i])}`);
            return place ? L.layerGroup().addTo(resultLayer) : null;
        });
        if (place) data.participants.forEach((_, i) => drawRoute(i));
        if (fit) {
            const shown = demo ? data.candidates : data.ranking.slice(0, PROPOSALS).map(j => data.candidates[j]);
            const points = [...shown.map(c => [c.lat, c.lon]), ...data.participants.map(p => [p.lat, p.lon])];
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
        results.innerHTML = resultsHtml(current.data, current.selected, categoryLabels, { demo: isDemo() });
        results.querySelector('#place-select')?.addEventListener('change', e => selectPlace(Number(e.target.value)));
        results.querySelectorAll('.proposal').forEach(button =>
            button.addEventListener('click', () => selectPlace(Number(button.dataset.place))));
        results.querySelector('#place-share')?.addEventListener('click', sharePlace);
        results.hidden = false;
    }

    // Phones: the system share sheet (messaging apps); otherwise the text and the OpenStreetMap
    // link are copied, to paste in a message. Nothing goes through this site
    async function sharePlace() {
        const place = current.data.candidates[current.selected];
        const text = shareText(place, current.data.slot);
        const url = placeLinks(place).osm;
        const shareStatus = results.querySelector('#place-share-status');
        try {
            if (navigator.share) return await navigator.share({ title: place.name, text, url });
            await navigator.clipboard.writeText(`${text}\n${url}`);
            shareStatus.textContent = 'Copié : à coller dans un message.';
        } catch (err) {
            if (err.name === 'AbortError') return; // share sheet closed
            console.error(err);
            shareStatus.textContent = 'Partage impossible : utilisez les liens ci-contre.';
        }
    }

    // Another score ranks the places again from the times already known: no new call (except
    // the openrouteservice paths of a new best place, if not fetched yet)
    function rerank() {
        if (!current) return;
        const { data } = current;
        data.metric = checkedValue('score-metric');
        data.ranking = rankCandidates(data.candidates, data.metric);
        data.best = data.ranking.length ? data.ranking[0] : null;
        if (data.best != null && data.best !== current.selected) return selectPlace(data.best);
        renderResults();
        drawSelection(false);
    }

    function applyView() {
        layout.classList.toggle('location--demo', isDemo());
        if (!current) return;
        renderResults();
        drawSelection(false);
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
            if (isDemo()) drawCenter(resultLayer, event.center);
            state.matrixModes = ORS_MODES.filter(m => participants.some(p => p.modes.includes(m)));
            state.matrixDone = [];
            break;
        }
        case 'candidates':
            setStep('candidates', 'done', `${describeCandidates(event.candidates)} `
                + `à moins de ${(event.radius / 1000).toLocaleString('fr-FR')} km `
                + `(données OSM du ${event.sources.osm || '—'}, GTFS du ${event.sources.gtfs})`);
            if (isDemo()) drawCandidates(resultLayer, event.candidates, categoryLabels);
            setProgress(0.05, `${describeCandidates(event.candidates)} : calcul des trajets…`);
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
                setProgress(0.05 + 0.85 * event.done / event.total, `Trajets en bus/métro : ${event.done}/${event.total}${failed}`);
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
            setProgress(0.95, event.best != null ? 'Tracé des itinéraires…' : 'Aucun lieu atteignable par tous.');
            current = { data: event, rows, selected: event.best, routes: new Map() };
            drawSelection(true);
            renderResults();
            // Score changed during the computation
            if (event.metric !== checkedValue('score-metric')) rerank();
            scrollToSection(results);
            break;
        }
        case 'route':
            storeRoute(event);
            setStep('routes', 'running', `${++state.routesDone}/${state.routesTotal}`);
            break;
        case 'done':
            setStep('routes', 'done');
            setProgress(1, `Terminé en ${Math.round((performance.now() - state.startedAt) / 1000)} s.`);
            break;
        default:
            break;
        }
    }

    // Other place types, candidates or transit engine make the displayed result stale; another
    // score or view only changes how it is ranked or shown
    document.getElementById('categories').addEventListener('change', clearResults);
    [candidateCount, document.getElementById('transit-engine')].forEach(input => input.addEventListener('change', () => {
        storeSettings();
        showSettingsSummary();
        clearResults();
    }));
    document.getElementById('score-metric').addEventListener('change', () => {
        storeSettings();
        showSettingsSummary();
        rerank();
    });
    document.getElementById('view-mode').addEventListener('change', () => {
        storeSettings();
        showSettingsSummary();
        applyView();
    });

    form.addEventListener('submit', async e => {
        e.preventDefault();
        const reason = submitBlocker();
        if (reason) {
            keysPanel.open = true;
            return setStatus(reason);
        }
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
        setActive(null); // a click on the result map no longer moves anyone
        clearResults();
        resetSteps();
        scrollToSection(document.getElementById('location-progress'));
        submit.disabled = true;
        lastRun = { orsMatrix: 0, orsDirections: 0, transitous: 0, tisseo: 0 };
        running = true;
        renderCalls();
        const rows = participants.map(p => p.row);
        const state = { startedAt: performance.now() };
        try {
            const data = await getData();
            const input = { slot: slotValue(), categories, transitEngine: checkedValue('transit-engine'),
                maxCandidates: Number(candidateCount.value), metric: checkedValue('score-metric'),
                participants: participants.map(({ row, ...p }) => p) };
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
            submit.disabled = false;
            renderCalls();
        }
    });

    restoreSettings();
    applyView();
    showKeys();
})();
