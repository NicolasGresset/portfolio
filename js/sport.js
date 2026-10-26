// sport.js - Load /api/sport and render recent runs and rides

// Shared with weekly-distance.js, which is loaded after this script
window.sportData = fetch('/api/sport')
    .then(r => { if (!r.ok) throw new Error(r.status); return r.json(); });

(function () {
    const grid = document.getElementById('activities-grid');
    if (!grid) return;

    const KIND_LABELS = { run: 'course', ride: 'vélo' };

    const escapeHtml = str => str.replace(/[&<>"']/g, c => ({
        '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
    }[c]));

    const formatDate = iso => new Date(iso).toLocaleDateString('fr-FR', {
        day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC',
    });

    const formatDistance = meters => `${(meters / 1000).toFixed(1).replace('.', ',')} km`;

    function formatDuration(seconds) {
        const h = Math.floor(seconds / 3600);
        const m = Math.floor((seconds % 3600) / 60);
        const s = seconds % 60;
        return h > 0
            ? `${h}h${String(m).padStart(2, '0')}`
            : `${m}:${String(s).padStart(2, '0')}`;
    }

    // Runs: pace in min/km. Rides: speed in km/h.
    function formatPace(a) {
        if (!a.averageSpeed) return '—';
        if (a.kind === 'ride') return `${(a.averageSpeed * 3.6).toFixed(1).replace('.', ',')} km/h`;
        const secPerKm = Math.round(1000 / a.averageSpeed);
        return `${Math.floor(secPerKm / 60)}:${String(secPerKm % 60).padStart(2, '0')} /km`;
    }

    const stat = (label, value) => `
        <div class="activity-stat">
            <span class="activity-stat-label">${label}</span>
            <span class="activity-stat-value">${value}</span>
        </div>`;

    const renderStatus = msg => { grid.innerHTML = `<p class="activities-status">${msg}</p>`; };

    window.sportData
        .then(({ activities }) => {
            if (!activities.length) return renderStatus('Aucune activité récente.');
            // Only runs have a detail page
            grid.innerHTML = activities.map(a => {
                const open = a.kind === 'run'
                    ? `<a href="activite.html?id=${encodeURIComponent(a.id)}" class="activity-card" data-kind="run">`
                    : `<article class="activity-card" data-kind="${a.kind}">`;
                return `
                ${open}
                    <div class="activity-card-header">
                        <span class="activity-kind">${KIND_LABELS[a.kind]}</span>
                        <span class="activity-date">${formatDate(a.date)}</span>
                    </div>
                    <p class="activity-title">${escapeHtml(a.name)}</p>
                    ${a.label ? `<p class="activity-card-label">${escapeHtml(a.label)}</p>` : ''}
                    <div class="activity-stats">
                        ${stat('distance', formatDistance(a.distance))}
                        ${stat('temps', formatDuration(a.movingTime))}
                        ${stat(a.kind === 'ride' ? 'vitesse' : 'allure', formatPace(a))}
                        ${stat('fc moy.', a.averageHr ? `${Math.round(a.averageHr)} bpm` : '—')}
                    </div>
                ${a.kind === 'run' ? '</a>' : '</article>'}`;
            }).join('');
        })
        .catch(() => renderStatus('Impossible de charger les activités pour le moment.'));
})();
