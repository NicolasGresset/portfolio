// publications.js - Publications from HAL (public API, no key), rendered into #publications-list
//
// The list element may set data-limit="3" to show only the most recent ones (home page)
// and data-group-by-year to add a heading per year (publications page).

(function () {
    const list = document.getElementById('publications-list');
    if (!list) return;

    const ID_HAL = 'nicolas-gresset-bourgeois';
    const MY_NAME = 'Nicolas Gresset-Bourgeois';
    const FIELDS = [
        'halId_s', 'uri_s', 'docType_s', 'title_s', 'authFullName_s', 'producedDate_s', 'producedDateY_i',
        'conferenceTitle_s', 'journalTitle_s', 'bookTitle_s', 'city_s', 'doiId_s', 'fileMain_s',
        'abstract_s', 'label_bibtex',
    ].join(',');
    const API_URL = 'https://api.archives-ouvertes.fr/search/'
        + `?q=authIdHal_s:${ID_HAL}&fl=${FIELDS}&sort=producedDate_s%20desc&rows=100&wt=json`;

    const DOC_TYPES = {
        ART: 'revue', COMM: 'conférence', POSTER: 'poster', THESE: 'thèse', HDR: 'HDR',
        OUV: 'ouvrage', COUV: 'chapitre', REPORT: 'rapport', UNDEFINED: 'preprint', OTHER: 'autre',
    };

    // DOIs missing from HAL records (remove an entry once the DOI is filled in on HAL)
    const DOI_OVERRIDES = {
        'hal-05662368': '10.1145/3789240.3827584',
    };

    // Not on HAL yet: shown first on the full page only
    const THESIS = {
        title: 'Étude des protocoles de communication pour les nanosatellites',
        meta: 'Thèse en cours · Université de Toulouse · 2024–2027',
    };

    const escapeHtml = str => String(str).replace(/[&<>"']/g, c => ({
        '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
    }[c]));

    const formatMonth = iso => new Date(`${iso.slice(0, 7)}-01T00:00:00Z`)
        .toLocaleDateString('fr-FR', { month: 'long', year: 'numeric', timeZone: 'UTC' });

    const authors = names => names
        .map(n => (n === MY_NAME ? `<strong>${escapeHtml(n)}</strong>` : escapeHtml(n)))
        .join(', ');

    const link = (href, label) =>
        `<a href="${escapeHtml(href)}" class="publication-link" target="_blank" rel="noopener noreferrer">${label}</a>`;

    // Crossref returns BibTeX on one line: put each field on its own line
    const formatBibtex = bib => bib.trim()
        .replace(/,\s*(?=[A-Za-z_]+\s*=)/g, ',\n  ')
        .replace(/\s*}\s*$/, '\n}');

    // Publisher's BibTeX through the DOI when there is one, HAL's otherwise
    function loadBibtex(details) {
        const pre = details.querySelector('pre');
        if (pre.dataset.loaded) return;
        pre.dataset.loaded = 'true';
        const { doi, halBibtex } = details.dataset;
        if (!doi) { pre.textContent = halBibtex; return; }
        pre.textContent = 'Chargement…';
        fetch(`https://doi.org/${doi}`, { headers: { Accept: 'application/x-bibtex' } })
            .then(r => { if (!r.ok) throw new Error(r.status); return r.text(); })
            .then(bib => { pre.textContent = formatBibtex(bib); })
            .catch(() => { pre.textContent = halBibtex; });
    }

    function renderDoc(d) {
        const venue = d.conferenceTitle_s || d.journalTitle_s || d.bookTitle_s;
        const meta = [venue, d.city_s, d.producedDate_s && formatMonth(d.producedDate_s)].filter(Boolean);
        const doi = d.doiId_s || DOI_OVERRIDES[d.halId_s];
        const links = [
            d.fileMain_s && link(d.fileMain_s, 'PDF ↗'),
            link(d.uri_s, 'HAL ↗'),
            doi && link(`https://doi.org/${doi}`, 'DOI ↗'),
        ].filter(Boolean);
        const abstract = d.abstract_s && d.abstract_s[0];
        return `
            <article class="publication-item">
                <span class="tag">${DOC_TYPES[d.docType_s] || DOC_TYPES.OTHER}</span>
                <h3 class="publication-title">${escapeHtml(d.title_s[0])}</h3>
                <p class="publication-authors">${authors(d.authFullName_s || [])}</p>
                <p class="publication-meta">${meta.map(escapeHtml).join(' &middot; ')}</p>
                <div class="publication-links">${links.join('')}</div>
                ${abstract ? `
                <details class="publication-extra">
                    <summary>résumé</summary>
                    <p class="publication-abstract">${escapeHtml(abstract)}</p>
                </details>` : ''}
                <details class="publication-extra publication-bibtex"
                    data-doi="${escapeHtml(doi || '')}" data-hal-bibtex="${escapeHtml(d.label_bibtex || '')}">
                    <summary>BibTeX</summary>
                    <pre></pre>
                    <button type="button" class="publication-copy">copier</button>
                </details>
            </article>`;
    }

    const thesisHtml = `
        <article class="publication-item pending">
            <span class="tag">thèse</span>
            <h3 class="publication-title">${THESIS.title}</h3>
            <p class="publication-meta">${THESIS.meta}</p>
        </article>`;

    // BibTeX is fetched on first opening, copied on demand
    list.addEventListener('toggle', evt => {
        if (evt.target.matches('.publication-bibtex') && evt.target.open) loadBibtex(evt.target);
    }, true);
    list.addEventListener('click', evt => {
        const button = evt.target.closest('.publication-copy');
        if (!button) return;
        navigator.clipboard.writeText(button.previousElementSibling.textContent)
            .then(() => { button.textContent = 'copié ✓'; setTimeout(() => { button.textContent = 'copier'; }, 1500); });
    });

    const limit = Number(list.dataset.limit) || Infinity;
    const groupByYear = 'groupByYear' in list.dataset;

    fetch(API_URL)
        .then(r => { if (!r.ok) throw new Error(r.status); return r.json(); })
        .then(({ response }) => {
            const docs = response.docs.slice(0, limit);
            if (!groupByYear) {
                list.innerHTML = docs.map(renderDoc).join('') || thesisHtml;
                return;
            }
            const years = [...new Set(docs.map(d => d.producedDateY_i))];
            list.innerHTML = thesisHtml + years.map(y => `
                <h2 class="publication-year">${y}</h2>
                ${docs.filter(d => d.producedDateY_i === y).map(renderDoc).join('')}`).join('');
        })
        .catch(() => {
            list.innerHTML = `<p class="activities-status">Impossible de joindre HAL pour le moment &mdash;
                <a href="https://hal.science/search/index/?q=authIdHal_s:${ID_HAL}" target="_blank" rel="noopener noreferrer">voir mes publications sur HAL ↗</a></p>`;
        });
})();
