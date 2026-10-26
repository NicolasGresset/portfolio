// nav.js - Mobile menu toggle and active link highlighting

(function () {
    const toggle = document.querySelector('.nav-toggle');
    const links  = document.querySelector('.nav-links');

    if (toggle && links) {
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
    }

    // Mark the current page link as active
    const path = window.location.pathname.split('/').pop() || 'index.html';
    document.querySelectorAll('.nav-links a').forEach(a => {
        const href = (a.getAttribute('href') || '').split('#')[0];
        if (href && href === path) a.classList.add('active');
    });
})();
