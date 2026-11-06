(() => {
    const root = document.documentElement;
    const reducedMotion = window.matchMedia?.("(prefers-reduced-motion: reduce)");
    const syncMotionPreference = () => {
        root.classList.toggle("reduce-motion", Boolean(reducedMotion?.matches));
        if (reducedMotion?.matches) {
            root.classList.remove("page-entering", "page-leaving");
            document.querySelectorAll(".motion-reveal").forEach(element => element.classList.add("motion-visible"));
        }
    };
    syncMotionPreference();
    reducedMotion?.addEventListener?.("change", syncMotionPreference);

    const flagSvg = `<svg class="racing-loader-flag" viewBox="0 0 34 24" aria-hidden="true"><path class="racing-loader-pole" d="M4 2v20"/><path class="racing-loader-cloth" d="M5 3h24v15H5z"/><path d="M5 3h6v5H5zm12 0h6v5h-6zm6 5h6v5h-6zM11 8h6v5h-6zm-6 5h6v5H5zm12 0h6v5h-6z"/></svg>`;
    const loadingMarkup = label => `<span class="racing-loader" role="status"><span class="racing-loader-track">${flagSvg}<i aria-hidden="true"></i></span><span>${String(label || "Loading…")}</span></span>`;
    window.F1Motion = { ...(window.F1Motion || {}), flagSvg, loadingMarkup };

    const showStartLights = () => {
        if (document.body.dataset.page !== "home" || root.classList.contains("reduce-motion")) return;
        try {
            if (sessionStorage.getItem("f1insider.start-lights-shown")) return;
            sessionStorage.setItem("f1insider.start-lights-shown", "1");
        } catch (_) {}
        const loader = document.createElement("div");
        loader.className = "start-lights-loader";
        loader.setAttribute("aria-label", "F1 INSIDER loading");
        loader.innerHTML = `<div class="start-lights-brand"><strong>F1</strong><span>INSIDER</span></div><div class="start-lights-gantry" aria-hidden="true">${Array.from({ length: 5 }, (_, index) => `<i style="--light:${index}"></i>`).join("")}</div><p>READY FOR LIGHTS OUT</p>`;
        document.body.append(loader);
        requestAnimationFrame(() => loader.classList.add("is-running"));
        window.setTimeout(() => loader.classList.add("is-lights-out"), 610);
        window.setTimeout(() => loader.classList.add("is-finished"), 760);
        window.setTimeout(() => loader.remove(), 980);
    };
    showStartLights();

    const transitionLine = document.createElement("span");
    transitionLine.className = "race-transition-line";
    transitionLine.setAttribute("aria-hidden", "true");
    document.body.append(transitionLine);

    const revealSelector = [
        ".section-heading > *", ".driver-card", ".team-card-item", ".race-card", ".standing-row",
        ".rail-card", ".explore-card", ".event-panel", ".ticker > div",
        ".analysis-hero-copy", ".analysis-telemetry-art", ".analysis-selectors", ".feature-tabs",
        ".analysis-output", ".anatomy-heading", ".system-tabs", ".anatomy-layout", ".view-record",
        ".profile-layout", ".modal-copy", ".home-standing-grid > div", ".search-result",
        ".component-detail", ".car-stage", ".directory-tools", ".pagination", ".empty"
    ].join(",");

    let revealObserver = null;
    const observed = new WeakSet();
    const revealWithin = (scope = document) => {
        if (!revealObserver || root.classList.contains("reduce-motion")) return;
        const elements = [];
        if (scope instanceof Element && scope.matches(revealSelector)) elements.push(scope);
        elements.push(...scope.querySelectorAll(revealSelector));
        elements.forEach(element => {
            if (!element.isConnected || !element.parentElement) return;
            if (observed.has(element)) return;
            observed.add(element);
            const column = element.matches(".driver-card, .search-result") ? element.parentElement : element;
            const siblings = [...column.parentElement.children];
            element.style.setProperty("--motion-order", String(Math.min(siblings.indexOf(column), 6)));
            element.classList.add("motion-reveal");
            revealObserver.observe(element);
        });
    };

    if ("IntersectionObserver" in window && !root.classList.contains("reduce-motion")) {
        revealObserver = new IntersectionObserver(entries => {
            entries.forEach(entry => {
                if (!entry.isIntersecting) return;
                entry.target.classList.add("motion-visible");
                revealObserver.unobserve(entry.target);
            });
        }, { threshold: 0.08, rootMargin: "0px 0px -5% 0px" });

        document.body.classList.add("motion-ready");
        revealWithin();
        const contentObserver = new MutationObserver(records => {
            records.forEach(record => {
                record.removedNodes.forEach(node => {
                    if (!(node instanceof Element)) return;
                    revealObserver.unobserve(node);
                    node.querySelectorAll(".motion-reveal").forEach(element => revealObserver.unobserve(element));
                });
                record.addedNodes.forEach(node => {
                    if (node.nodeType === Node.ELEMENT_NODE) revealWithin(node);
                });
            });
        });
        contentObserver.observe(document.querySelector("main") || document.body, { childList: true, subtree: true });
    }

    root.classList.add("page-entering");
    window.setTimeout(() => root.classList.remove("page-entering"), root.classList.contains("reduce-motion") ? 0 : 700);
    window.addEventListener("pageshow", () => root.classList.remove("page-leaving"));

    const images = new WeakSet();
    const watchImages = scope => {
        const candidates = scope instanceof HTMLImageElement ? [scope] : [...scope.querySelectorAll("img")];
        candidates.forEach(image => {
            if (images.has(image) || !image.closest("main, .modal")) return;
            images.add(image);
            image.classList.add("motion-image");
            const finish = () => image.classList.remove("motion-image-pending");
            if (!image.complete) image.classList.add("motion-image-pending");
            image.addEventListener("load", finish, { once: true });
            image.addEventListener("error", finish, { once: true });
        });
    };
    watchImages(document);
    new MutationObserver(records => records.forEach(record => record.addedNodes.forEach(node => {
        if (node instanceof Element && node.isConnected) watchImages(node);
    }))).observe(document.body, { subtree: true, childList: true });

    const nav = document.querySelector("#nav");
    if (nav) {
        const indicator = document.createElement("span");
        indicator.className = "nav-motion-indicator";
        indicator.setAttribute("aria-hidden", "true");
        nav.append(indicator);
        nav.classList.add("has-motion-indicator");
        const move = link => {
            if (!link || !link.getClientRects().length) { indicator.style.opacity = "0"; return; }
            const bounds = link.getBoundingClientRect();
            const base = nav.getBoundingClientRect();
            indicator.style.transform = `translate3d(${bounds.left - base.left}px, ${bounds.bottom - base.top - 3}px, 0) scaleX(${bounds.width})`;
            indicator.style.opacity = "1";
        };
        const restore = () => move(nav.querySelector("a.active"));
        window.addEventListener("pageshow", restore);
        nav.querySelectorAll("a").forEach(link => {
            link.addEventListener("mouseenter", () => move(link));
            link.addEventListener("focus", () => move(link));
            link.addEventListener("blur", restore);
        });
        nav.addEventListener("mouseleave", restore);
        nav.addEventListener("shown.bs.collapse", restore);
        if ("ResizeObserver" in window) new ResizeObserver(restore).observe(nav);
        new MutationObserver(restore).observe(nav, { subtree: true, attributes: true, attributeFilter: ["class"] });
        document.fonts?.ready.then(restore);
        requestAnimationFrame(restore);
    }

    if (!root.classList.contains("reduce-motion")) {
        document.addEventListener("click", event => {
            if (root.classList.contains("reduce-motion")) return;
            const link = event.target.closest("a[href]");
            if (!link || event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
            if (link.target === "_blank" || link.hasAttribute("download")) return;
            const destination = new URL(link.href, window.location.href);
            if (destination.origin !== window.location.origin || destination.pathname === window.location.pathname) return;
            event.preventDefault();
            root.classList.add("page-leaving");
            transitionLine.classList.remove("is-active");
            requestAnimationFrame(() => transitionLine.classList.add("is-active"));
            window.setTimeout(() => window.location.assign(destination.href), 180);
        });
    }
})();
