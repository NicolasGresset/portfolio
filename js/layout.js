// layout.js - Builds the shared navigation (mobile menu toggle, active link highlighting) and footer
//
// Each page only holds empty <nav class="nav"> and <footer class="footer"> placeholders; their
// content lives here.

(function () {
    const LINKS = [
        { href: 'projects',          label: 'projets' },
        // Hidden for now
        // { href: 'blog',              label: 'blog' },
        { href: 'cinema',            label: 'cinéma' },
        { href: 'sport',             label: 'sport' },
        { href: 'publications',      label: 'publications' },
    ];

    // Site root, resolved from this script's URL so pages in subfolders (blog/) work too
    const root = new URL('..', document.currentScript.src);

    const footer = document.querySelector('.footer');
    if (footer) {
        footer.innerHTML = `
            <div class="footer-inner">
                <span class="footer-text">© ${new Date().getFullYear()} Nicolas Gresset-Bourgeois</span>
                <span class="footer-text">Toulouse, France
                    &middot; <a href="${new URL('legal', root)}">mentions légales et confidentialité</a></span>
            </div>`;
    }

    const nav = document.querySelector('.nav');
    if (!nav) return;

    nav.innerHTML = `
        <div class="nav-inner">
            <a href="${root}" class="nav-logo">ngb.</a>
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

    // Mark the current page link as active (clean URLs: /sport, with /sport.html accepted too)
    const page = url => url.pathname.split('/').pop().replace(/\.html$/, '');
    links.querySelectorAll('a').forEach(a => {
        if (page(new URL(a.href)) === page(window.location)) a.classList.add('active');
    });
})();
