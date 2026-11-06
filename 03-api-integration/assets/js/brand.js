(() => {
  const CACHE_KEY = "f1insider.commons.formula-one-mark.v1";
  const CACHE_TTL = 30 * 24 * 60 * 60 * 1000;
  const logoImages = [...document.querySelectorAll(".brand-f1-image")];
  const favicon = document.querySelector("#siteFavicon");
  if (!logoImages.length && !favicon) return;

  function applyLogo(asset) {
    window.f1InsiderBrandCredit = asset;
    window.dispatchEvent(new CustomEvent("f1insider:brand-credit", { detail: asset }));
    if (favicon) {
      const icon = new Image();
      icon.onload = () => {
        favicon.href = asset.favicon || asset.image;
        if (asset.favicon) favicon.type = "image/svg+xml";
        else favicon.removeAttribute("type");
      };
      icon.onerror = () => {
        favicon.removeAttribute("type");
        favicon.href = asset.favicon ? asset.image : "data:,";
      };
      icon.src = asset.favicon || asset.image;
    }
    logoImages.forEach(image => {
      const fallback = image.parentElement.querySelector(".brand-f1-fallback");
      const showFallback = () => {
        image.classList.remove("is-loaded");
        image.hidden = true;
        if (fallback) fallback.hidden = false;
      };
      image.addEventListener("load", () => {
        image.classList.add("is-loaded");
        image.hidden = false;
        if (fallback) fallback.hidden = true;
      }, { once: true });
      image.addEventListener("error", showFallback, { once: true });
      image.src = asset.image;
      image.title = "Formula One mark";
      image.hidden = false;
      if (image.complete && image.naturalWidth > 0) {
        image.classList.add("is-loaded");
        if (fallback) fallback.hidden = true;
      }
    });
  }

  async function loadLogo() {
    let cached;
    try {
      cached = JSON.parse(sessionStorage.getItem(CACHE_KEY) || "null");
    } catch (_) {}
    if (cached?.asset?.image && Date.now() - cached.savedAt < CACHE_TTL) {
      applyLogo(cached.asset);
      return;
    }

    const params = new URLSearchParams({
      action: "query",
      format: "json",
      origin: "*",
      titles: "File:Formula One logo.svg",
      prop: "imageinfo",
      iiprop: "url|mime|size|extmetadata",
      iiurlwidth: "600"
    });

    try {
      const response = await fetch(`https://commons.wikimedia.org/w/api.php?${params}`);
      if (!response.ok) throw new Error(`Commons returned HTTP ${response.status}.`);
      const payload = await response.json();
      const page = Object.values(payload?.query?.pages || {})[0];
      const info = page?.imageinfo?.[0];
      const metadata = info?.extmetadata || {};
      const license = metadata.LicenseShortName?.value?.replace(/<[^>]*>/g, "").trim();
      const artist = metadata.Artist?.value?.replace(/<[^>]*>/g, "").trim();
      const licenseUrl = /^https:\/\//i.test(metadata.LicenseUrl?.value || "") ? metadata.LicenseUrl.value : info.descriptionurl;
      if (page?.missing !== undefined || info?.mime !== "image/svg+xml" || !info?.thumburl || !license) {
        throw new Error("Commons did not return the verified Formula One logo asset.");
      }
      const asset = {
        image: info.thumburl,
        favicon: /^https:\/\//i.test(info.url || "") ? info.url : "",
        title: String(page.title || "Formula One logo").replace(/^File:/, ""),
        artist: artist || "Creator not listed",
        license,
        licenseUrl,
        source: info.descriptionurl || ""
      };
      const check = new Image();
      check.onload = () => {
        try { sessionStorage.setItem(CACHE_KEY, JSON.stringify({ savedAt: Date.now(), asset })); } catch (_) {}
        applyLogo(asset);
      };
      check.onerror = () => {
        if (cached?.asset?.image) applyLogo(cached.asset);
        console.warn("[F1 INSIDER brand] Commons logo thumbnail could not be loaded; retaining the text mark.");
      };
      check.src = asset.image;
    } catch (error) {
      if (cached?.asset?.image) applyLogo(cached.asset);
      console.warn("[F1 INSIDER brand] Could not load the Commons logo; retaining the text mark.", error);
    }
  }

  loadLogo();
})();
