// voronoi.js - Animated Voronoi background using Bowyer-Watson Delaunay triangulation

(function () {
    const canvas = document.getElementById('voronoi-canvas');
    if (!canvas) return;

    const ctx = canvas.getContext('2d');
    const N = 38;              // points visible on screen
    const SPEED = 0.28;
    // Points also live in a margin around the screen, so border cells extend past
    // the edges instead of ending abruptly (hull artifacts stay off-screen)
    const MARGIN_RATIO = 0.2;

    let W, H, m, pts = [], vels = [];

    function resize() {
        W = canvas.width  = window.innerWidth;
        H = canvas.height = window.innerHeight;
        m = Math.max(W, H) * MARGIN_RATIO;
    }

    function init() {
        resize();
        // Same density as N points on screen, over the screen plus its margin
        const count = Math.round(N * ((W + 2 * m) * (H + 2 * m)) / (W * H));
        for (let i = 0; i < count; i++) {
            pts.push({ x: -m + Math.random() * (W + 2 * m), y: -m + Math.random() * (H + 2 * m) });
            const a = Math.random() * Math.PI * 2;
            vels.push({ vx: Math.cos(a) * SPEED, vy: Math.sin(a) * SPEED });
        }
    }

    // Circumcenter of triangle with vertices (ax,ay) (bx,by) (cx,cy)
    function circumcenter(ax, ay, bx, by, cx, cy) {
        const D = 2 * (ax * (by - cy) + bx * (cy - ay) + cx * (ay - by));
        if (Math.abs(D) < 1e-10) return null;
        const aa = ax * ax + ay * ay;
        const bb = bx * bx + by * by;
        const cc = cx * cx + cy * cy;
        return {
            x: (aa * (by - cy) + bb * (cy - ay) + cc * (ay - by)) / D,
            y: (aa * (cx - bx) + bb * (ax - cx) + cc * (bx - ax)) / D,
        };
    }

    // Returns true if point (px,py) is strictly inside the circumcircle of triangle
    function inCircumcircle(ax, ay, bx, by, cx, cy, px, py) {
        const D = 2 * (ax * (by - cy) + bx * (cy - ay) + cx * (ay - by));
        if (Math.abs(D) < 1e-10) return false;
        const aa = ax * ax + ay * ay;
        const bb = bx * bx + by * by;
        const cc = cx * cx + cy * cy;
        const ux = (aa * (by - cy) + bb * (cy - ay) + cc * (ay - by)) / D;
        const uy = (aa * (cx - bx) + bb * (ax - cx) + cc * (bx - ax)) / D;
        const r2 = (ax - ux) * (ax - ux) + (ay - uy) * (ay - uy);
        return (px - ux) * (px - ux) + (py - uy) * (py - uy) < r2 - 1e-10;
    }

    // Bowyer-Watson incremental Delaunay triangulation.
    // Returns array of triangles, each as [i, j, k] indices into `points`.
    function computeDelaunay(points) {
        const n = points.length;
        const M = Math.max(W, H) * 20;

        // Super-triangle vertices appended at indices n, n+1, n+2
        const ep = [
            ...points,
            { x: W / 2,     y: -M       },
            { x: W + M * 2, y: H + M    },
            { x: -M * 2,    y: H + M    },
        ];

        let tris = [[n, n + 1, n + 2]];

        for (let pi = 0; pi < n; pi++) {
            const { x: px, y: py } = ep[pi];

            // Find triangles whose circumcircle contains the new point
            const badIdx = [];
            for (let ti = 0; ti < tris.length; ti++) {
                const [i, j, k] = tris[ti];
                if (inCircumcircle(
                    ep[i].x, ep[i].y,
                    ep[j].x, ep[j].y,
                    ep[k].x, ep[k].y,
                    px, py
                )) {
                    badIdx.push(ti);
                }
            }

            const badSet = new Set(badIdx);

            // Collect boundary edges (edges not shared between two bad triangles)
            const boundary = [];
            for (const ti of badIdx) {
                const [i, j, k] = tris[ti];
                // Each directed edge; if the reverse appears in another bad tri, it's internal
                for (const [a, b] of [[i, j], [j, k], [k, i]]) {
                    let shared = false;
                    for (const tj of badIdx) {
                        if (tj === ti) continue;
                        const [p, q, r] = tris[tj];
                        if ((p === b && q === a) || (q === b && r === a) || (r === b && p === a)) {
                            shared = true;
                            break;
                        }
                    }
                    if (!shared) boundary.push([a, b]);
                }
            }

            tris = tris.filter((_, ti) => !badSet.has(ti));
            for (const [a, b] of boundary) tris.push([a, b, pi]);
        }

        // Discard triangles that include super-triangle vertices
        return tris.filter(t => !t.some(i => i >= n));
    }

    function update() {
        for (let i = 0; i < pts.length; i++) {
            pts[i].x += vels[i].vx;
            pts[i].y += vels[i].vy;
            if (pts[i].x < -m || pts[i].x > W + m) { vels[i].vx *= -1; pts[i].x = Math.max(-m, Math.min(W + m, pts[i].x)); }
            if (pts[i].y < -m || pts[i].y > H + m) { vels[i].vy *= -1; pts[i].y = Math.max(-m, Math.min(H + m, pts[i].y)); }
        }
    }

    function draw() {
        ctx.clearRect(0, 0, W, H);

        let tris;
        try { tris = computeDelaunay(pts); } catch (_) { return; }

        // Map each Delaunay edge to the circumcenters of adjacent triangles —
        // connecting those circumcenters gives the Voronoi edges (dual graph).
        const edgeMap = new Map();
        for (const [ai, bi, ci] of tris) {
            const a = pts[ai], b = pts[bi], c = pts[ci];
            const cc = circumcenter(a.x, a.y, b.x, b.y, c.x, c.y);
            if (!cc) continue;
            for (const [p, q] of [[ai, bi], [bi, ci], [ai, ci]]) {
                const key = p < q ? `${p},${q}` : `${q},${p}`;
                if (!edgeMap.has(key)) edgeMap.set(key, []);
                edgeMap.get(key).push(cc);
            }
        }

        // Draw Voronoi edges
        ctx.strokeStyle = 'rgba(37, 99, 235, 0.45)';
        ctx.lineWidth = 0.75;
        ctx.beginPath();
        for (const ccs of edgeMap.values()) {
            if (ccs.length === 2) {
                ctx.moveTo(ccs[0].x, ccs[0].y);
                ctx.lineTo(ccs[1].x, ccs[1].y);
            }
        }
        ctx.stroke();

        // Draw seed points as small dots
        ctx.fillStyle = 'rgba(37, 99, 235, 0.55)';
        for (const p of pts) {
            ctx.beginPath();
            ctx.arc(p.x, p.y, 1.8, 0, Math.PI * 2);
            ctx.fill();
        }
    }

    let lastTs = 0;
    function loop(ts) {
        requestAnimationFrame(loop);
        if (ts - lastTs < 16) return; // target ~60 fps
        lastTs = ts;
        update();
        draw();
    }

    init();
    requestAnimationFrame(loop);

    // Keep each point at the same relative position in the (screen + margin) area,
    // so the diagram stretches with the viewport (window resize, zoom, device emulation)
    window.addEventListener('resize', () => {
        const oldW = W, oldH = H, oldM = m;
        resize();
        pts = pts.map(p => ({
            x: -m + (p.x + oldM) / (oldW + 2 * oldM) * (W + 2 * m),
            y: -m + (p.y + oldM) / (oldH + 2 * oldM) * (H + 2 * m),
        }));
    });
})();
