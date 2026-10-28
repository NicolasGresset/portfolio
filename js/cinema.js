// cinema.js - Load /api/cinema and render the Letterboxd diary, reviews flagged with spoilers hidden until clicked.
// Each card's director and main cast are filled in from /api/credits once shown.

// Shared with monthly-films.js, which is loaded after this script
window.cinemaData = fetch('/api/cinema')
    .then(r => { if (!r.ok) throw new Error(r.status); return r.json(); });

(function () {
    const list = document.getElementById('films-list');
    const more = document.getElementById('films-more');
    if (!list) return;

    const PAGE = 10;

    const escapeHtml = str => str.replace(/[&<>"']/g, c => ({
        '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
    }[c]));

    const formatDate = iso => new Date(`${iso}T00:00:00Z`).toLocaleDateString('fr-FR', {
        day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC',
    });

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
                if (directors.length) parts.push(`de ${directors.join(', ')}`);
                if (cast.length) parts.push(`avec ${cast.join(', ')}`);
                line.textContent = parts.join(' · ');
            })
            .catch(() => {});
    }

    const renderFilm = f => `
        <article class="film-card">
            <a href="${escapeHtml(f.url)}" target="_blank" rel="noopener noreferrer" class="film-poster">
                ${f.poster ? `<img src="${escapeHtml(f.poster)}" alt="Affiche de ${escapeHtml(f.title)}" loading="lazy">` : ''}
            </a>
            <div class="film-body">
                <div class="film-header">
                    <a href="${escapeHtml(f.url)}" target="_blank" rel="noopener noreferrer" class="film-title">
                        ${escapeHtml(f.title)}${f.year ? ` <span class="film-year">${f.year}</span>` : ''}
                    </a>
                    <span class="film-date">${f.rewatch ? 'revu' : 'vu'} le ${formatDate(f.watched)}${f.viewings > 1 ? ` &middot; vu ${f.viewings} fois` : ''}</span>
                </div>
                ${f.tmdbId ? `<p class="film-credits" data-tmdb="${escapeHtml(f.tmdbId)}"></p>` : ''}
                ${f.rating || f.liked ? `<p class="film-rating">${f.rating ? formatRating(f.rating) : ''}${f.liked ? ' <span class="film-like" aria-label="aimé">♥</span>' : ''}</p>` : ''}
                ${review(f)}
            </div>
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
                list.insertAdjacentHTML('beforeend', films.slice(shown, shown + PAGE).map(renderFilm).join(''));
                list.querySelectorAll('.film-credits:not(.is-loaded)').forEach(line => {
                    line.classList.add('is-loaded');
                    fillCredits(line);
                });
                shown += PAGE;
                more.hidden = shown >= films.length;
            };
            list.innerHTML = '';
            showMore();
            more.addEventListener('click', showMore);
        })
        .catch(() => renderStatus('Impossible de charger les films pour le moment.'));
})();
