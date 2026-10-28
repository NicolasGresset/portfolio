// nav.js - Builds the shared navigation, mobile menu toggle and active link highlighting
//
// Each page only holds an empty <nav class="nav"> placeholder; the links live here.

(function () {
    const LINKS = [
        // Hidden for now
        // { href: 'projects.html',     label: 'projets' },
        // { href: 'blog.html',         label: 'blog' },
        { href: 'cinema.html',       label: 'cinéma' },
        { href: 'sport.html',        label: 'sport' },
        { href: 'publications.html', label: 'publications' },
        { href: 'location.html',     label: 'location' },
    ];

    // Site root, resolved from this script's URL so pages in subfolders (blog/) work too
    const root = new URL('..', document.currentScript.src);

    const nav = document.querySelector('.nav');
    if (!nav) return;

    nav.innerHTML = `
        <div class="nav-inner">
            <a href="${new URL('index.html', root)}" class="nav-logo">ngb.</a>
            <button class="nav-toggle" aria-label="Ouvrir le menu de navigation" aria-expanded="false">
                <span></span><span></span><span></span>
            </button>
            <ul class="nav-links" role="list">
                ${LINKS.map(l => `<li><a href="${new URL(l.href, root)}">${l.label}</a></li>`).join('')}
            </ul>
        </div>`;

    const toggle = nav.querySelector('.nav-toggle');
    const links  = nav.querySelector('.nav-links');

    toggle.addEventListener('click', () => {
        const open = links.classList.toggle('open');
        toggle.setAttribute('aria-expanded', open ? 'true' : 'false');
    });

    // Close menu when a link is clicked
    links.querySelectorAll('a').forEach(a => {
        a.addEventListener('click', () => {
            links.classList.remove('open');
            toggle.setAttribute('aria-expanded', 'false');
        });
    });

    // Mark the current page link as active
    const path = window.location.pathname.split('/').pop() || 'index.html';
    links.querySelectorAll('a').forEach(a => {
        if (new URL(a.href).pathname.split('/').pop() === path) a.classList.add('active');
    });
})();
