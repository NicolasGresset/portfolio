// format.js - Formatting helpers shared by the pages' scripts (ES module)

export const escapeHtml = str => String(str).replace(/[&<>"']/g, c => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
}[c]));

// Activity duration: 1h05 from an hour, else 42:07
export function formatDuration(seconds) {
    const total = Math.round(seconds);
    const h = Math.floor(total / 3600);
    const m = Math.floor((total % 3600) / 60);
    const s = total % 60;
    return h > 0 ? `${h}h${String(m).padStart(2, '0')}` : `${m}:${String(s).padStart(2, '0')}`;
}

// One labelled figure of an activity card or header
export const activityStat = (label, value) => `
    <div class="activity-stat">
        <span class="activity-stat-label">${label}</span>
        <span class="activity-stat-value">${value}</span>
    </div>`;
