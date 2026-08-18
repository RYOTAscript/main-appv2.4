/*
 * Global tooltip — replaces the OS/native `title=` hover tooltip everywhere with
 * a single styled box that matches the weather widget's tooltip (same font,
 * colours, radius). Native `title` tooltips render in the OS font and can't be
 * restyled with CSS, so we suppress them and draw our own instead.
 *
 * How it works: on hover we walk up to the nearest element carrying a `title`,
 * stash that text in `data-app-title` and strip the real `title` (so the browser
 * doesn't also pop its own tooltip), then position a fixed-position box near the
 * element. Because the box is appended to <body> it inherits the app font
 * ('Inter'), exactly like the weather tooltip does.
 */
(function () {
    let tipEl = null;
    let currentTarget = null;
    let showTimer = null;

    function ensureEl() {
        if (tipEl) return tipEl;
        tipEl = document.createElement('div');
        tipEl.className = 'app-tooltip';
        tipEl.setAttribute('role', 'tooltip');
        document.body.appendChild(tipEl);
        return tipEl;
    }

    // Nearest ancestor (incl. self) that has hover text.
    function findHolder(el) {
        while (el && el.nodeType === 1 && el !== document.body) {
            if (el.hasAttribute('data-app-title') ||
                (el.hasAttribute('title') && el.getAttribute('title').trim() !== '')) {
                return el;
            }
            // Strip empty titles so they never linger as native tooltips.
            if (el.hasAttribute('title') && el.getAttribute('title').trim() === '') {
                el.removeAttribute('title');
            }
            el = el.parentElement;
        }
        return null;
    }

    function textFor(el) {
        if (el.hasAttribute('title')) {
            const t = el.getAttribute('title');
            el.setAttribute('data-app-title', t);
            el.removeAttribute('title');
        }
        return (el.getAttribute('data-app-title') || '').trim();
    }

    function position(el) {
        const tip = tipEl;
        const r = el.getBoundingClientRect();
        // Measure after content is set.
        const tr = tip.getBoundingClientRect();
        const pad = 6;
        let left = r.left + r.width / 2 - tr.width / 2;
        let top = r.top - tr.height - 8; // prefer above, like the weather tooltip

        if (left < pad) left = pad;
        if (left + tr.width > window.innerWidth - pad) {
            left = window.innerWidth - pad - tr.width;
        }
        // If it would clip off the top, flip below the element.
        if (top < pad) top = r.bottom + 8;

        tip.style.left = Math.round(left) + 'px';
        tip.style.top = Math.round(top) + 'px';
    }

    function show(el) {
        const text = textFor(el);
        if (!text) return;
        const tip = ensureEl();
        tip.textContent = text;
        // Reset position before measuring so a stale offset can't shrink it.
        tip.style.left = '0px';
        tip.style.top = '0px';
        tip.classList.add('is-visible');
        position(el);
        currentTarget = el;
    }

    function hide() {
        clearTimeout(showTimer);
        showTimer = null;
        if (tipEl) tipEl.classList.remove('is-visible');
        currentTarget = null;
    }

    document.addEventListener('mouseover', function (e) {
        const el = findHolder(e.target);
        if (!el) return;
        if (el === currentTarget) return;
        hide();
        // Small delay mirrors native tooltip feel and avoids flicker while
        // sweeping the cursor across a toolbar.
        showTimer = setTimeout(function () { show(el); }, 350);
    });

    document.addEventListener('mouseout', function (e) {
        if (!currentTarget && !showTimer) return;
        const to = e.relatedTarget;
        if (to && currentTarget && currentTarget.contains(to)) return;
        // Still inside the same holder? keep it.
        if (to && findHolder(to) === currentTarget && currentTarget) return;
        hide();
    });

    // Any interaction / movement of the layout should dismiss it.
    document.addEventListener('mousedown', hide, true);
    document.addEventListener('wheel', hide, true);
    window.addEventListener('scroll', hide, true);
    window.addEventListener('blur', hide);
})();
