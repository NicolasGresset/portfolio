// cinema.js - Load /api/cinema and render the Letterboxd diary, reviews flagged with spoilers hidden until clicked.
// Each card's director and main cast are filled in from /api/credits once shown.

// Shared with monthly-films.js, which is loaded after this script
window.cinemaData = fetch('/api/cinema')
    .then(r => { if (!r.ok) throw new Error(r.status); return r.json(); });

(function () {
    const list = document.getElementById('films-list');
    const more = document.getElementById('films-more');
    if (!list) return;

    const FIRST_PAGE = 10;
    const NEXT_PAGE = 20;

    const escapeHtml = str => str.replace(/[&<>"']/g, c => ({
        '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
    }[c]));

    const formatDate = iso => new Date(`${iso}T00:00:00Z`).toLocaleDateString('fr-FR', {
        day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC',
    });

    // Lowercase particles stay with the surname: "Guillermo del Toro" -> "G. del Toro"
    const PARTICLES = ['de', 'del', 'della', 'di', 'da', 'du', 'des', 'la', 'le', 'van', 'von', 'der', 'den', 'ten'];

    // "Alejandro G. Iñárritu" -> "A. G. Iñárritu", "Jean-Pierre Jeunet" -> "J.-P. Jeunet"
    function shortName(name) {
        const words = name.split(' ');
        let last = words.length - 1;
        while (last > 1 && PARTICLES.includes(words[last - 1])) last--;
        const initials = words.slice(0, last)
            .map(w => w.split('-').map(part => `${[...part][0]}.`).join('-'));
        return [...initials, ...words.slice(last)].join(' ');
    }

    // 3.5 -> ★★★½, as on Letterboxd
    const formatRating = r => '★'.repeat(Math.floor(r)) + (r % 1 ? '½' : '');

    function review(f) {
        if (!f.review.length) return '';
        const text = f.review.map(p => `<p>${escapeHtml(p)}</p>`).join('');
        if (!f.spoilers) return `<div class="film-review">${text}</div>`;
        return `
            <button class="film-spoiler" type="button">⚠ spoilers &mdash; cliquer pour révéler la critique</button>
            <div class="film-review" hidden>${text}</div>`;
    }

    // "de Réalisateur · avec Acteur 1, Acteur 2"; the line stays empty if TMDB has nothing
    function fillCredits(line) {
        fetch(`/api/credits?id=${encodeURIComponent(line.dataset.tmdb)}`)
            .then(r => { if (!r.ok) throw new Error(r.status); return r.json(); })
            .then(({ directors, cast }) => {
                const parts = [];
                if (directors.length) parts.push(`de ${directors.map(shortName).join(', ')}`);
                if (cast.length) parts.push(`avec ${cast.map(shortName).join(', ')}`);
                line.textContent = parts.join(' · ');
            })
            .catch(() => {});
    }

    // Poster and header (title and rating on one line, then date and credits), the review below across the whole card
    const renderFilm = f => `
        <article class="film-card">
            <a href="${escapeHtml(f.url)}" target="_blank" rel="noopener noreferrer" class="film-poster">
                ${f.poster ? `<img src="${escapeHtml(f.poster)}" alt="Affiche de ${escapeHtml(f.title)}" loading="lazy">` : ''}
            </a>
            <div class="film-header">
                <div class="film-title-line">
                    <a href="${escapeHtml(f.url)}" target="_blank" rel="noopener noreferrer" class="film-title">
                        ${escapeHtml(f.title)}${f.year ? `&nbsp;<span class="film-year">${f.year}</span>` : ''}
                    </a>
                    ${f.rating || f.liked ? `<p class="film-rating">${f.rating ? formatRating(f.rating) : ''}${f.liked ? ' <span class="film-like" aria-label="aimé">♥</span>' : ''}</p>` : ''}
                </div>
                <span class="film-date">${f.rewatch ? 'revu' : 'vu'} le ${formatDate(f.watched)}${f.viewings > 1 ? ` &middot; vu ${f.viewings} fois` : ''}</span>
                ${f.tmdbId ? `<p class="film-credits" data-tmdb="${escapeHtml(f.tmdbId)}"></p>` : ''}
            </div>
            ${f.review.length ? `<div class="film-text">${review(f)}</div>` : ''}
        </article>`;

    const renderStatus = msg => { list.innerHTML = `<p class="activities-status">${msg}</p>`; };

    list.addEventListener('click', e => {
        const button = e.target.closest('.film-spoiler');
        if (!button) return;
        button.nextElementSibling.hidden = false;
        button.remove();
    });

    window.cinemaData
        .then(({ films }) => {
            if (!films.length) return renderStatus('Aucun film récent.');
            let shown = 0;
            const showMore = () => {
                const count = shown ? NEXT_PAGE : FIRST_PAGE;
                list.insertAdjacentHTML('beforeend', films.slice(shown, shown + count).map(renderFilm).join(''));
                list.querySelectorAll('.film-credits:not(.is-loaded)').forEach(line => {
                    line.classList.add('is-loaded');
                    fillCredits(line);
                });
                shown += count;
                more.hidden = shown >= films.length;
            };
            list.innerHTML = '';
            showMore();
            more.addEventListener('click', showMore);
        })
        .catch(() => renderStatus('Impossible de charger les films pour le moment.'));
})();
