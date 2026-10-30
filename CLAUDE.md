# Notes for Claude Code sessions

Personal site gresset-bourgeois.fr. GitHub `NicolasGresset/portfolio` (public), deployed by Vercel from `main`.
This file is excluded from the deployment (`.vercelignore`) but versioned on GitHub. So are
`blog.html` and `data/posts.json` until the blog is written.

## Working rules

- UI text in French; code, names, comments, logs and docs in English. PEP8 for any Python.
- Never hard-code or commit keys; never print secret values (redact `.env`).
- List methodological choices (scoring, candidates, time handling, data sources, new external
  services) with trade-offs and ask before coding them. The user likes to measure and test before deciding.
- Commit often on `main`; **push only when the user asks** (each push triggers a Vercel deploy).
- Keep API usage conservative.

## Site layout

- Vanilla HTML/CSS/JS, no build step. Pages at the root (`index.html`, `sport.html`, `projects.html`, …),
  shared navigation and footer in `js/layout.js`. Styles: `css/fonts.css` and `css/base.css` (variables,
  shared components) on every page, then the page's own file (`home`, `sport` for sport and run detail,
  `cinema`, `publications`, `article` for legal, projects and long-form pages).
- `api/*.js`: Vercel serverless functions for the sport and cinema pages only (keys in Vercel env, see `.env.example`).
- Local dev: `node --env-file=.env scripts/dev-server.js`; it sends `vercel.json`'s headers, and
  `CSP_REPORT=1` (or `only`, not enforced) logs Content-Security-Policy violations.
- `vercel.json`: `cleanUrls` (pages served at `/sport`, `/sport.html` 308-redirects there, so internal
  links omit `.html`), `redirects` (old Rendez-vous URLs; the dev server applies both),
  Content-Security-Policy for every path, long cache for `assets/fonts/`. **Any new
  external service called from a page (fetch, image, script) must be added to the CSP**, and the
  third-party list of `legal.html` (English legal notice and privacy page) kept true.
- Fonts (`assets/fonts`) are served by the site: no third-party request on load besides what
  `legal.html` lists. The site sets no cookies and uses no local storage.
- Browser tests: headless Firefox (`/snap/bin/firefox`) against the dev server, driven through
  WebDriver BiDi by `scripts/firefox-bidi.js` (`withFirefox(async ({ send, context, evaluate,
  screenshot, errors }) => …)`: navigation, in-page scenarios, console errors, screenshots under
  `~/snap/firefox/common/shots`). Always go through it, never launch Firefox by hand: it picks a
  free port (`--remote-debugging-port 0`), uses a fresh profile it deletes, and closes with
  `browser.close`. Pitfalls it avoids (2026-10-29): the snap launcher hides Firefox's arguments, so
  `pgrep -f <profile>` never finds it and a kill hits only its shell (Firefox survives, keeps its
  port: "exit 69" on the next start, and recreates its profile after `rm`); a Bash background task
  killed by hand reports "failed, exit 143/144", which is not a Firefox failure. Startup ~9 s.
  The dev server's port 3000 is often already taken by the user's own server: reuse it.
- `scripts/` is not deployed.

## Rendez-vous (moved out on 2026-10-30)

The meeting point tool, born here as the "location" page, now has its own repository
(`NicolasGresset/rendez-vous`, cloned in `~/repos/rendez-vous`, with its own CLAUDE.md, notes and
next steps: home server, better algorithm) and Vercel project, at `rendez-vous.gresset-bourgeois.fr`.
The history of its files stays here, deleted in one commit. What remains of it in this site:
`projects.html` (a paragraph and links), the `redirects` of `vercel.json` (`/rendez-vous`,
`/location`, with or without `.html`); `legal.html` does not mention it (the user's choice). Tool work goes to its own
repository, not here.

## Open topics (update when they move)

- Site audit 2026-10-28: done (fonts self-hosted, query parameters refused on api/,
  /api/activity limited to the owner's runs, any of them by id being accepted by the user, TMDB
  cached 180 days, posters 300x450, legal page, CSP). Still open:
  - /api/credits accepts any TMDB id (each new one is a TMDB call): check it against /api/cinema?
  - Vercel Firewall rate limit on /api/* (dashboard, the user's call).
- Ideas for later (stated by the user, 2026-10-28):
  - Make sure the repository holds no dead code.
- CSS refactored 2026-10-28 (dead rules removed, 7-step font size scale `--text-2xs`…`--text-2xl`,
  color / radius variables, shared components in `base.css`, one file per page, mobile rules nested
  in their rule with native CSS nesting, so browsers from 2023 on). Checked by comparing screenshots
  and computed styles of every page, desktop and mobile, before and after each step.
- Before publishing a blog article: the drafts in `_drafts/` load KaTeX, Plotly and Google Fonts from
  CDNs and use inline scripts, all blocked by the CSP (and Google Fonts sends visitors' IPs to
  Google); `blog.html` also has an inline script. Self-host or move them to files,
  or extend the CSP, when they are written.
