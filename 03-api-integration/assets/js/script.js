

const JOLPICA_BASE = "https://api.jolpi.ca/ergast/f1/2024/";
const SEASON = 2024;
const TEAM_COLORS = [
    "#3671c6", "#ff8000", "#e80020", "#27f4d2", "#229971",
    "#ff87bc", "#b6babd", "#6692ff", "#64c4ff", "#52e252"
];
const T1_PORTRAIT_BASE = "https://api.t1f1.com/api/static/media/drivers/";
const OPENF1_MEETINGS_URL = "https://api.openf1.org/v1/meetings?year=2024";
const OPENF1_CACHE_TTL = 30 * 24 * 60 * 60 * 1000;
const COMMONS_CACHE_TTL = 7 * 24 * 60 * 60 * 1000;

let drivers = [];
let driverStandings = [];
let teams = [];
let teamStandings = [];
let races = [];
let apiLoaded = false;
const requestedPage = Number(new URLSearchParams(window.location.search).get("page"));
const initialPage = Number.isSafeInteger(requestedPage) && requestedPage > 0 ? requestedPage : 1;
let driverPage = document.body.dataset.page === "drivers" ? initialPage : 1;
let racePage = document.body.dataset.page === "races" ? initialPage : 1;
let activeDriver = 0;
let railMotionToken = 0;
let searchPage = document.body.dataset.page === "search" ? initialPage : 1;
let standingType = new URLSearchParams(window.location.search).get("tab") === "teams" ? "teams" : "drivers";
const pageSize = 10;
const errors = { drivers: "", teams: "", driverStandings: "", teamStandings: "", races: "" };
const CACHE_PREFIX = "f1-insider-jolpica-v1:";
const API_CACHE_TTL = 30 * 24 * 60 * 60 * 1000;
const inFlightRequests = new Map();
const failedRequestsThisSession = new Map();
const dataWarnings = new Set();
const memoryCache = new Map();
const unavailablePortraits = new Set();
try {
    const saved = JSON.parse(sessionStorage.getItem("f1insider.portrait-failures") || "null");
    if (saved && Date.now() - saved.savedAt < 60 * 60 * 1000 && Array.isArray(saved.urls)) {
        saved.urls.forEach(url => unavailablePortraits.add(url));
    }
} catch {}
const directoryState = {
    drivers: { records: [], total: 0, page: driverPage, loading: false, request: 0, error: "" },
    races: { records: [], total: 0, page: racePage, loading: false, request: 0, error: "" }
};
let allDriversLoaded = false;
let allRacesLoaded = false;
let raceVisualError = "";
let raceVisualsLoaded = false;
let raceMeetings = [];
let verifiedResultRounds = new Set();
const homePhotoCredits = new Map();

const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];
const driverGrid = $("#driverGrid");
const driverRail = $("#driverRail");
const teamGrid = $("#teamGrid");
const raceList = $("#raceList");
const standingsTable = $("#standingsTable");
const modal = $("#detailModal");
const modalContent = $("#modalContent");
const racingLoader = label => window.F1Motion?.loadingMarkup?.(label) || `<span role="status">${escapeHTML(label)}</span>`;
const checkeredFlagIcon = () => `<svg class="status-checkered-flag" viewBox="0 0 30 22" aria-hidden="true"><path d="M4 2v18"/><path class="flag-outline" d="M5 3h20v13H5z"/><path class="flag-square" d="M5 3h5v4H5zm10 0h5v4h-5zm5 4h5v5h-5zM10 7h5v5h-5zm-5 5h5v4H5zm10 0h5v4h-5z"/></svg>`;
const raceStatusMarkup = race => race.status === "COMPLETED" ? `${checkeredFlagIcon()}<span>${escapeHTML(race.status)}</span>` : `<span>${escapeHTML(race.status)}</span>`;

function escapeHTML(value) {
    return String(value ?? "").replace(/[&<>"']/g, character => ({
        "&": "&amp;",
        "<": "&lt;",
        ">": "&gt;",
        '"': "&quot;",
        "'": "&#039;"
    })[character]);
}

function formatValue(value) {
    return value === null || value === undefined || value === "" ? "—" : escapeHTML(value);
}

function numberOrNull(value) {
    if (value === null || value === undefined || value === "") return null;
    const number = Number(value);
    return Number.isFinite(number) ? number : null;
}

function teamColor(id) {
    if (TEAM_2024_COLORS[id]) return TEAM_2024_COLORS[id];
    const numericId = numberOrNull(id);
    if (numericId !== null) return TEAM_COLORS[Math.abs(numericId - 1) % TEAM_COLORS.length];
    const hash = String(id || "").split("").reduce((value, character) => value + character.charCodeAt(0), 0);
    return TEAM_COLORS[hash % TEAM_COLORS.length];
}

function portraitUrlFor2024Driver(driver) {
    return /^[A-Z]{3}$/.test(String(driver?.code || ""))
        ? `${T1_PORTRAIT_BASE}${encodeURIComponent(driver.code)}`
        : "";
}

function portraitInitials(driver) {
    const first = String(driver?.first || "").trim();
    const last = String(driver?.last || "").trim();
    return `${first[0] || "F"}${last[0] || (first.split(/\s+/)[1]?.[0] || "1")}`.toUpperCase();
}

function splitName(value) {
    const parts = String(value || "Unknown driver").trim().split(/\s+/).filter(Boolean);
    const last = parts.length > 1 ? parts.pop() : "";
    const first = parts.join(" ") || "Unknown";
    return { first, last, fullName: [first, last].filter(Boolean).join(" ") };
}

function driverSlug(driver) {
    return String(driver?.fullName || "")
        .normalize("NFKD")
        .replace(/[\u0300-\u036f]/g, "")
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-|-$/g, "");
}

async function fetchJson(url, sourceName) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 20000);
    try {
        const response = await fetch(url, { signal: controller.signal });
        let payload;
        try {
            payload = await response.json();
        } catch {
            throw new Error(`${sourceName} returned unreadable data.`);
        }
        if (!response.ok) {
            throw new Error(`${sourceName} request failed (HTTP ${response.status}).`);
        }
        return payload;
    } finally {
        clearTimeout(timeout);
    }
}

function jolpicaCollection(payload, collectionPath) {
    return collectionPath.reduce((value, key) => value?.[key], payload) || [];
}

const driverDirectoryPath = ["MRData", "DriverTable", "Drivers"];
const driverStandingsPath = ["MRData", "StandingsTable", "StandingsLists", "0", "DriverStandings"];
const constructorStandingsPath = ["MRData", "StandingsTable", "StandingsLists", "0", "ConstructorStandings"];
const raceCalendarPath = ["MRData", "RaceTable", "Races"];

function validJolpicaCollection(path, expectedSeason = SEASON) {
    return payload => Number(payload?.MRData?.StandingsTable?.StandingsLists?.[0]?.season || payload?.MRData?.RaceTable?.season || expectedSeason) === expectedSeason
        && Array.isArray(jolpicaCollection(payload, path))
        && jolpicaCollection(payload, path).length > 0;
}

function validJolpicaPage(path) {
    return payload => {
        const data = payload?.MRData;
        if (!data || !Number.isInteger(Number(data.total)) || Number(data.total) < 0) return false;
        if (!Number.isInteger(Number(data.offset)) || Number(data.offset) < 0 || Number(data.limit) < 1) return false;
        const table = data.StandingsTable || data.RaceTable || data.DriverTable;
        if (!table || Number(table.season) !== SEASON) return false;
        const rows = path.reduce((value, key) => value?.[key], payload);
        if (Array.isArray(rows)) return rows.length > 0 || Number(data.offset) >= Number(data.total);
        return Array.isArray(data.StandingsTable?.StandingsLists)
            && data.StandingsTable.StandingsLists.length === 0
            && Number(data.offset) >= Number(data.total);
    };
}

async function getJolpicaPage(endpoint, path, limit = 100, offset = 0) {
    const url = `${JOLPICA_BASE}${endpoint}?${new URLSearchParams({ limit, offset })}`;
    const result = await getCachedResource(`jolpica:page:${url}`, API_CACHE_TTL,
        () => fetchJson(url, "Jolpica"), validJolpicaPage(path));
    if (result.data) return result;
    const collections = {
        "driverstandings.json": "jolpica:driver-standings:2024",
        "constructorstandings.json": "jolpica:constructor-standings:2024",
        "races.json": "jolpica:races:2024"
    };
    const baseEndpoint = endpoint.split("/").at(-1);
    if (!collections[baseEndpoint]) return result;
    const fullUrl = `${JOLPICA_BASE}${baseEndpoint}?limit=100&offset=0`;
    const saved = readSessionCache(`jolpica:page:${fullUrl}`, validJolpicaCollection(path))
        || readSessionCache(collections[baseEndpoint], validJolpicaCollection(path));
    if (!saved || Number(saved.data.MRData.offset) !== 0) return result;
    const allRows = jolpicaCollection(saved.data, path);
    if (allRows.length !== Number(saved.data.MRData.total)) return result;
    let rows = allRows;
    const driver = endpoint.match(/^drivers\/([^/]+)\/driverstandings\.json$/);
    const constructor = endpoint.match(/^constructors\/([^/]+)\/constructorstandings\.json$/);
    const round = endpoint.match(/^(\d+)\/races\.json$/);
    if (driver) rows = rows.filter(row => row.Driver?.driverId === decodeURIComponent(driver[1]));
    else if (constructor) rows = rows.filter(row => row.Constructor?.constructorId === decodeURIComponent(constructor[1]));
    else if (round) rows = rows.filter(row => Number(row.round) === Number(round[1]));
    else if (endpoint !== baseEndpoint) return result;
    const data = structuredClone(saved.data);
    let target = data;
    path.slice(0, -1).forEach(key => { target = target[key]; });
    target[path.at(-1)] = rows.slice(offset, offset + limit);
    data.MRData.total = String(rows.length);
    data.MRData.offset = String(offset);
    data.MRData.limit = String(limit);
    return { ...result, data, source: "stale-session", message: saved
        ? savedDataNotice(saved.savedAt)
        : result.message };
}

async function getJolpicaCollection(endpoint, path) {
    const first = await getJolpicaPage(endpoint, path);
    if (!first.data) return first;
    const rows = [...jolpicaCollection(first.data, path)];
    const total = Number(first.data.MRData.total);
    if (!total) return first;
    let refreshWarning = first.error ? first : null;
    let offset = rows.length;
    while (offset < total) {
        const next = await getJolpicaPage(endpoint, path, 100, offset);
        if (!next.data) return { ...next, data: null };
        if (next.error) refreshWarning = next;
        const pageRows = jolpicaCollection(next.data, path);
        if (!pageRows.length) return { data: null, error: new Error("Jolpica pagination stopped before all records were returned."), message: "The complete archive could not be loaded." };
        rows.push(...pageRows);
        offset += pageRows.length;
    }
    const payload = structuredClone(first.data);
    let target = payload;
    path.slice(0, -1).forEach(key => { target = target[key]; });
    target[path.at(-1)] = rows;
    return { ...first, ...(refreshWarning ? { error: refreshWarning.error, message: refreshWarning.message, source: refreshWarning.source } : {}), data: payload };
}

async function loadDirectoryPage(kind, page) {
    const state = directoryState[kind];
    const request = ++state.request;
    state.loading = true;
    state.error = "";
    const mount = kind === "drivers" ? driverGrid : raceList;
    mount?.setAttribute("aria-busy", "true");
    if (mount) mount.innerHTML = `<div class="empty">${racingLoader(kind === "drivers" ? "Loading drivers…" : "Fetching race calendar…")}</div>`;
    const endpoint = kind === "drivers" ? "driverstandings.json" : "races.json";
    const path = kind === "drivers" ? driverStandingsPath : raceCalendarPath;
    const result = await getJolpicaPage(endpoint, path, pageSize, (page - 1) * pageSize);
    if (request !== state.request) return;
    if (result.data) {
        const total = Number(result.data.MRData.total);
        const pages = Math.max(1, Math.ceil(total / pageSize));
        if (page > pages) return loadDirectoryPage(kind, pages);
        const rows = jolpicaCollection(result.data, path);
        state.records = kind === "drivers" ? normalizeDrivers(rows.map(row => row.Driver), rows, []) : normalizeRaces(rows);
        if (kind === "races") state.records = state.records.map(applyRaceVisual);
        state.total = total;
        state.page = page;
        if (kind === "drivers") driverPage = page;
        else racePage = page;
        updatePageUrl(page);
    } else {
        state.error = result.message || "Could not load the selected archive page.";
    }
    state.loading = false;
    mount?.setAttribute("aria-busy", "false");
    if (result.error) {
        dataWarnings.add(result.message);
        updateDataStatus();
    }
    if (apiLoaded) kind === "drivers" ? renderDrivers() : renderRaces();
}

async function ensureSearchCollection(kind) {
    if (kind === "drivers" ? allDriversLoaded : allRacesLoaded) return true;
    const endpoint = kind === "drivers" ? "driverstandings.json" : "races.json";
    const path = kind === "drivers" ? driverStandingsPath : raceCalendarPath;
    const result = await getJolpicaCollection(endpoint, path);
    if (!result.data) throw new Error(result.message || "The archive search could not be loaded.");
    const rows = jolpicaCollection(result.data, path);
    if (kind === "drivers") {
        drivers = driverStandings = normalizeDrivers(rows.map(row => row.Driver), rows, []);
        allDriversLoaded = true;
    } else {
        races = normalizeRaces(rows).map(applyRaceVisual);
        allRacesLoaded = true;
    }
    if (result.error) { dataWarnings.add(result.message); updateDataStatus(); }
    return true;
}

function validOpenF1Meetings(payload) {
    return Array.isArray(payload)
        && payload.filter(meeting => Number(meeting?.year) === SEASON && meeting?.meeting_name?.includes("Grand Prix")).length >= 24;
}

function commonsSearchUrl(query) {
    const params = new URLSearchParams({
        action: "query",
        format: "json",
        origin: "*",
        generator: "search",
        gsrsearch: query,
        gsrnamespace: "6",
        gsrlimit: "30",
        prop: "imageinfo|categories",
        iiprop: "url|size|mime|extmetadata",
        iiurlwidth: "1600",
        cllimit: "max",
        clshow: "hidden"
    });
    return `https://commons.wikimedia.org/w/api.php?${params.toString()}`;
}

function commonsPlainText(value) {
    const element = document.createElement("div");
    element.innerHTML = String(value || "");
    return element.textContent.trim().replace(/\s+/g, " ");
}

function validCommonsSearch(payload) {
    return Boolean(payload && !payload.error && (payload.query || payload.batchcomplete !== undefined));
}

function commonsPhotoFromPage(page) {
    const info = page?.imageinfo?.[0];
    if (!/^image\/(jpeg|png|webp)$/i.test(info?.mime || "")) return null;
    const image = info.thumburl || info.url;
    if (!/^https:\/\//i.test(image || "") || !/^https:\/\//i.test(info.descriptionurl || "")) return null;
    const metadata = info.extmetadata || {};
    const artist = commonsPlainText(metadata.Artist?.value) || "Author not listed";
    const license = commonsPlainText(metadata.LicenseShortName?.value) || "License not listed";
    const licenseUrl = /^https:\/\//i.test(metadata.LicenseUrl?.value || "") ? metadata.LicenseUrl.value : info.descriptionurl;
    const apiCategories = commonsPlainText(metadata.Categories?.value)
        .split("|")
        .map(category => category.trim())
        .filter(Boolean);
    const categories = [...new Set([
        ...(page.categories || []).map(category => String(category.title || "").replace(/^Category:/, "")),
        ...apiCategories
    ])];
    return {
        image: (() => {
            const parsed = new URL(image);
            ["utm_source", "utm_campaign", "utm_content"].forEach(key => parsed.searchParams.delete(key));
            return parsed.href;
        })(),
        original: info.url,
        title: String(page.title || "Wikimedia Commons image").replace(/^File:/, ""),
        source: info.descriptionurl,
        artist,
        license,
        licenseUrl,
        description: commonsPlainText(metadata.ImageDescription?.value),
        date: commonsPlainText(metadata.DateTimeOriginal?.value || metadata.DateTime?.value),
        categories,
        width: Number(info.width) || 0,
        height: Number(info.height) || 0,
        searchIndex: Number(page.index) || 0
    };
}

function commonsPhotoCandidates(payload, predicate, usedImages, allowPortrait = false, scoreCandidate = null) {
    const excluded = /logo|flag|icon|diagram|map|poster|drawing|illustration|badge|emblem|track.?map|blueprint/i;
    return Object.values(payload?.query?.pages || {})
        .map(commonsPhotoFromPage)
        .filter(photo => photo
            && !usedImages.has(photo.image)
            && !excluded.test(photo.title)
            && photo.width >= (allowPortrait ? 700 : 900)
            && photo.height >= (allowPortrait ? 700 : 450)
            && (photo.width / photo.height >= 1.2 || (allowPortrait && photo.height / photo.width >= 0.9))
            && predicate(photo))
        .sort((a, b) => {
            if (typeof scoreCandidate === "function") {
                const scoreDifference = scoreCandidate(b) - scoreCandidate(a);
                if (scoreDifference) return scoreDifference;
            }
            return a.searchIndex - b.searchIndex;
        })
        .slice(0, 8);
}

function verifyCommonsImage(photo, allowPortrait = false) {
    return new Promise(resolve => {
        const image = new Image();
        const timeout = setTimeout(() => {
            image.src = "";
            resolve(false);
        }, 15000);
        image.onload = () => {
            clearTimeout(timeout);
            resolve(allowPortrait
                ? image.naturalWidth >= 700 && image.naturalHeight >= 700
                : image.naturalWidth >= 900 && image.naturalHeight >= 450);
        };
        image.onerror = () => {
            clearTimeout(timeout);
            resolve(false);
        };
        image.src = photo.image;
    });
}

async function chooseCommonsPhoto(payload, predicate, usedImages, allowPortrait = false, scoreCandidate = null) {
    for (const photo of commonsPhotoCandidates(payload, predicate, usedImages, allowPortrait, scoreCandidate)) {
        if (await verifyCommonsImage(photo, allowPortrait)) {
            usedImages.add(photo.image);
            return photo;
        }
    }
    return null;
}

function renderCommonsPhoto(mount, photo, section, alt, onError) {
    if (!mount) return false;
    if (!photo) {
        mount.innerHTML = "";
        mount.style.backgroundImage = "";
        mount.removeAttribute("role");
        mount.removeAttribute("aria-label");
        mount.classList.add("commons-photo-unavailable");
        mount.dataset.commonsPhoto = "unavailable";
        return false;
    }
    mount.dataset.commonsPhoto = "loaded";
    mount.classList.add("has-commons-photo");
    if (section === "hero") {
        mount.innerHTML = "";
        mount.style.backgroundImage = `url("${photo.image.replace(/["\\]/g, "\\$&")}")`;
        mount.style.backgroundSize = "cover";
        mount.style.backgroundPosition = "center 56%";
        mount.setAttribute("role", "img");
        mount.setAttribute("aria-label", alt);
    } else {
        mount.innerHTML = `<img class="commons-photo-image commons-photo-${section}" src="${escapeHTML(photo.image)}" alt="${escapeHTML(alt)}" loading="lazy" decoding="async">`;
    }
    const image = $("img", mount);
    image?.addEventListener("error", () => {
        mount.style.backgroundImage = "";
        image.remove();
        mount.dataset.commonsPhoto = "unavailable";
        mount.classList.remove("has-commons-photo");
        mount.classList.add("commons-photo-unavailable");
        onError?.();
    }, { once: true });
    return true;
}

function renderHomePhotoCredits() {
    const list = $("#photoCreditsList");
    if (!list) return;
    const credits = [...homePhotoCredits.values()];
    const brand = window.f1InsiderBrandCredit;
    if (brand?.source) credits.push({
        label: "Formula One mark",
        artist: brand.artist || "Creator not listed",
        license: brand.license || "License details on source page",
        licenseUrl: brand.licenseUrl || brand.source,
        source: brand.source
    });
    list.innerHTML = credits.map(credit => `<li><span><strong>${escapeHTML(credit.label)}</strong><small>${escapeHTML(credit.artist)}</small></span><span><a href="${escapeHTML(credit.source)}" target="_blank" rel="noopener noreferrer">Wikimedia Commons source</a><a href="${escapeHTML(credit.licenseUrl)}" target="_blank" rel="noopener noreferrer">${escapeHTML(credit.license)}</a></span></li>`).join("");
    $("#photoCredits")?.toggleAttribute("hidden", !credits.length);
}

window.addEventListener("f1insider:brand-credit", renderHomePhotoCredits);
$("#photoCreditsLink")?.addEventListener("click", () => {
    const details = $("#photoCredits details");
    if (details) details.open = true;
});

function commonsText(photo) {
    return normalizeMatchText(`${photo.title} ${photo.description}`);
}

async function loadHomeCommonsImages() {
    const sections = [
        {
            key: "commons-home-hero-v2",
            query: "Formula One race car racing circuit Grand Prix",
            select: photo => {
                const text = commonsText(photo);
                return /formula one|formula 1|\bf1\b|grand prix|\bgp\b/.test(text)
                    && /race|racing|car|lap|circuit|track/.test(text)
                    && !/indycar|nascar|formula e|formula 2|motogp/.test(text);
            },
            mount: $("#homeHeroVisual"),
            section: "hero",
            creditLabel: "Homepage hero",
            alt: "Formula One cars racing through a corner during a Grand Prix"
        },
        {
            key: "commons-home-explore-drivers-v3",
            query: "Max Verstappen 2024 portrait",
            select: photo => {
                const text = commonsText(photo);
                return /max verstappen/.test(text) && /2024/.test(text);
            },
            score: photo => (/portrait cropped/i.test(photo.title) ? 100 : 0)
                + Math.min(photo.width * photo.height / 1000000, 8),
            mount: $("#homeExploreDriversVisual"),
            section: "explore-driver",
            creditLabel: "Drivers feature",
            allowPortrait: true,
            alt: "Max Verstappen in his Red Bull racing suit at the 2024 Dutch Grand Prix podium ceremony"
        },
        {
            key: "commons-home-explore-teams-v3",
            query: "Lando Norris Chinese GP 2024",
            select: photo => {
                const text = commonsText(photo);
                return /lando norris/.test(text)
                    && /2024/.test(text)
                    && /chinese gp|chinese grand prix/.test(text)
                    && /race|raceday/.test(text);
            },
            score: photo => (/race/i.test(photo.title) ? 100 : 0)
                + Math.min(photo.width * photo.height / 1000000, 8),
            mount: $("#homeExploreTeamsVisual"),
            section: "explore-team",
            creditLabel: "Teams feature",
            alt: "Lando Norris driving McLaren during the 2024 Chinese Grand Prix"
        },
        {
            key: "commons-home-explore-races-v3",
            query: "2024 Spanish Grand Prix Ferrari",
            select: photo => {
                const text = commonsText(photo);
                return /2024 spanish grand prix/.test(text)
                    && !/safety car|medical car|course.?car|poster|logo|circuit map/.test(text);
            },
            score: photo => (/53811183158/.test(photo.title) ? 100 : 0)
                + Math.min(photo.width * photo.height / 1000000, 8),
            mount: $("#homeExploreRacesVisual"),
            section: "explore-race",
            creditLabel: "Grand Prix feature",
            alt: "Charles Leclerc's Ferrari racing through a corner at the 2024 Spanish Grand Prix"
        },
    ].filter(section => section.mount);
    if (!sections.length) return;

    const usedImages = new Set();
    for (const section of sections) {
        let photo;
        let resultSource = "session";
        const result = await getCachedResource(
            section.key,
            COMMONS_CACHE_TTL,
            () => fetchJson(commonsSearchUrl(section.query), "Wikimedia Commons"),
            validCommonsSearch,
            "Wikimedia Commons image search"
        );
        resultSource = result.source;
        if (result.data) {
            photo = await chooseCommonsPhoto(result.data, section.select, usedImages, section.allowPortrait, section.score);
        }

        renderCommonsPhoto(section.mount, photo, section.section, section.alt, () => {
            homePhotoCredits.delete(section.key);
            renderHomePhotoCredits();
        });
        if (photo) homePhotoCredits.set(section.key, { ...photo, label: section.creditLabel });
        else homePhotoCredits.delete(section.key);
        renderHomePhotoCredits();
        usedImages.add(photo?.image);
        if (!['session', 'stale-session'].includes(resultSource) && section !== sections[sections.length - 1]) {
            await new Promise(resolve => setTimeout(resolve, 1000));
        }
    }
}

const TEAM_MONOGRAMS = {
    mclaren: "MCL", ferrari: "FER", red_bull: "RBR", mercedes: "MER",
    aston_martin: "AMR", alpine: "ALP", haas: "HAA", rb: "RB",
    williams: "WIL", sauber: "SAU"
};

const TEAM_2024_CAR_MODELS = {
    red_bull: "RB20",
    mclaren: "MCL38",
    ferrari: "SF-24",
    mercedes: "W15",
    aston_martin: "AMR24",
    alpine: "A524",
    haas: "VF-24",
    rb: "VCARB 01",
    williams: "FW46",
    sauber: "C44"
};

const TEAM_2024_COLORS = {
    mclaren: "#ff8000",
    ferrari: "#e80020",
    red_bull: "#3671c6",
    mercedes: "#27f4d2",
    aston_martin: "#229971",
    alpine: "#ff87bc",
    haas: "#b6babd",
    rb: "#6692ff",
    williams: "#64c4ff",
    sauber: "#52e252"
};

function readSessionCache(key, isValid) {
    const memory = memoryCache.get(key);
    if (memory && isValid(memory.data)) return memory;
    try {
        const raw = sessionStorage.getItem(`${CACHE_PREFIX}${key}`);
        if (!raw) return null;
        const entry = JSON.parse(raw);
        if (!entry || !Number.isFinite(entry.savedAt) || !isValid(entry.data)) return null;
        return entry;
    } catch {
        return null;
    }
}

function writeSessionCache(key, data) {
    const entry = { savedAt: Date.now(), data };
    memoryCache.set(key, entry);
    try {
        sessionStorage.setItem(`${CACHE_PREFIX}${key}`, JSON.stringify(entry));
    } catch {
    }
}

function updatePageUrl(page) {
    const params = new URLSearchParams(window.location.search);
    if (page > 1) params.set("page", String(page));
    else params.delete("page");
    const query = params.toString();
    history.replaceState({}, "", `${window.location.pathname}${query ? `?${query}` : ""}`);
}

function friendlyApiError(error, sourceName, usingSavedData = false) {
    const message = getErrorMessage(error);
    return usingSavedData
        ? savedDataNotice()
        : `Could not load ${sourceName} data. ${message}`;
}

function savedDataNotice(savedAt) {
    const timestamp = Number.isFinite(savedAt)
        ? ` Last updated ${new Date(savedAt).toLocaleString([], { dateStyle: "medium", timeStyle: "short" })}.`
        : "";
    return `Showing previously saved data. Live updates are temporarily unavailable.${timestamp}`;
}

async function getCachedResource(key, ttl, loader, isValid, sourceName = "Jolpica") {
    const cached = readSessionCache(key, isValid);
    const isFresh = cached && Date.now() - cached.savedAt < ttl;
    if (isFresh) return { data: cached.data, source: "session", error: null };

    if (failedRequestsThisSession.has(key)) {
        const error = failedRequestsThisSession.get(key);
        return {
            data: cached?.data ?? null,
            source: cached ? "stale-session" : "none",
            error,
            message: cached ? savedDataNotice(cached.savedAt) : friendlyApiError(error, sourceName)
        };
    }

    if (inFlightRequests.has(key)) return inFlightRequests.get(key);

    const request = (async () => {
        try {
            const data = await loader();
            if (!isValid(data)) throw new Error("The API returned an empty or invalid data set.");
            const count = value => {
                if (Array.isArray(value)) return value.length;
                const data = value?.MRData;
                const rows = data?.DriverTable?.Drivers || data?.RaceTable?.Races
                    || data?.StandingsTable?.StandingsLists?.[0]?.DriverStandings
                    || data?.StandingsTable?.StandingsLists?.[0]?.ConstructorStandings;
                return rows ? rows.length : data ? 0 : null;
            };
            if (cached && count(cached.data) > 0 && count(data) === 0) {
                throw new Error("The refresh returned no records; the saved data was retained.");
            }
            writeSessionCache(key, data);
            return { data, source: "network", error: null };
        } catch (error) {
            failedRequestsThisSession.set(key, error);
            return {
                data: cached?.data ?? null,
                source: cached ? "stale-session" : "none",
                error,
                message: cached ? savedDataNotice(cached.savedAt) : friendlyApiError(error, sourceName)
            };
        } finally {
            inFlightRequests.delete(key);
        }
    })();

    inFlightRequests.set(key, request);
    return request;
}

function normalizeDrivers(directoryRows, standingsRows, constructors) {
    const standingsById = new Map(standingsRows.map(row => [row?.Driver?.driverId, row]));
    const constructorNames = new Map(constructors.map(row => [row?.Constructor?.constructorId, row?.Constructor?.name]));

    return directoryRows.map((source, index) => {
        const id = source?.driverId || `driver-${index}`;
        const standing = standingsById.get(id) || (source?.code
            ? standingsRows.find(row => row?.Driver?.code === source.code)
            : null);
        const associations = Array.isArray(standing?.Constructors) ? standing.Constructors : [];
        const teamIds = [...new Set(associations.map(item => item?.constructorId).filter(Boolean))];
        const teamNames = [...new Set(associations.map(item =>
            constructorNames.get(item?.constructorId) || item?.name
        ).filter(Boolean))];
        const code = String(source?.code || "").toUpperCase();
        const name = {
            first: source?.givenName || "Unknown",
            last: source?.familyName || "",
            fullName: [source?.givenName, source?.familyName].filter(Boolean).join(" ") || "Unknown driver"
        };
        const portraitUrl = portraitUrlFor2024Driver({ code });

        return {
            id,
            number: source?.permanentNumber || null,
            ...name,
            code: code || "—",
            nationality: source?.nationality || "Nationality unavailable",
            dateOfBirth: source?.dateOfBirth || null,
            position: numberOrNull(standing?.position),
            points: numberOrNull(standing?.points),
            wins: numberOrNull(standing?.wins),
            teamIds,
            teamId: teamIds[0] || null,
            teamNames,
            team: teamNames.join(" / ") || "Team unavailable",
            color: teamColor(teamIds[0]),
            image: portraitUrl,
            imageSource: portraitUrl ? "t1" : ""
        };
    }).sort((a, b) => (a.position ?? Number.MAX_SAFE_INTEGER) - (b.position ?? Number.MAX_SAFE_INTEGER));
}

function normalizeTeamStandings(rows, driverRows) {
    return rows.map((row, index) => {
        const constructor = row?.Constructor || {};
        const lineupDrivers = driverRows.filter(driver => driver.teamIds.includes(constructor.constructorId));
        const driverLineup = lineupDrivers.map(driver => driver.fullName);
        return {
            id: constructor.constructorId || `constructor-${index}`,
            position: numberOrNull(row?.position),
            name: constructor.name || "Unknown constructor",
            nationality: constructor.nationality || "Nationality unavailable",
            points: numberOrNull(row?.points),
            wins: numberOrNull(row?.wins),
            logo: "",
            monogram: TEAM_MONOGRAMS[constructor.constructorId] || "F1",
            color: TEAM_2024_COLORS[constructor.constructorId] || teamColor(constructor.constructorId),
            driverLineup,
            lineupDrivers,
            driverCount: driverRows.length ? driverLineup.length : null
        };
    });
}

function formatRaceDate(date) {
    if (!date) return "Date unavailable";
    const parsed = new Date(`${date}T00:00:00Z`);
    return Number.isNaN(parsed.getTime())
        ? "Date unavailable"
        : parsed.toLocaleDateString("en-US", { timeZone: "UTC", month: "short", day: "numeric", year: "numeric" });
}

function normalizeSession(session) {
    if (!session?.date) return null;
    const time = session.time ? ` · ${String(session.time).replace(/Z$/, " UTC")}` : "";
    return `${formatRaceDate(session.date)}${time}`;
}

function normalizeRaces(rows) {
    return rows.map(row => {
        const location = row?.Circuit?.Location || {};
        const city = location.locality || "";
        const country = location.country || "";
        const sessions = [
            ["FP1", row?.FirstPractice],
            ["FP2", row?.SecondPractice],
            ["FP3", row?.ThirdPractice],
            ["Qualifying", row?.Qualifying],
            ["Sprint qualifying", row?.SprintQualifying],
            ["Sprint", row?.Sprint]
        ].filter(([, value]) => value?.date).map(([label, value]) => `${label}: ${normalizeSession(value)}`);
        return {
            round: numberOrNull(row?.round),
            name: row?.raceName || "Grand Prix",
            date: formatRaceDate(row?.date),
            dateIso: row?.date || "",
            dateValue: row?.date ? Date.parse(`${row.date}T00:00:00Z`) : Number.MAX_SAFE_INTEGER,
            time: row?.time ? String(row.time).replace(/Z$/, " UTC") : "Time unavailable",
            circuit: row?.Circuit?.circuitName || "Circuit information unavailable",
            location: [city, country].filter(Boolean).join(", ") || "Location unavailable",
            locality: city,
            country,
            status: raceStatus(row),
            sessions
        };
    }).sort((a, b) => a.round - b.round);
}

function raceStatus(row) {
    if (verifiedResultRounds.has(Number(row?.round))) return "COMPLETED";
    const date = row?.dateIso || row?.date;
    return date && Date.parse(`${date}T23:59:59Z`) > Date.now()
        ? "SCHEDULED"
        : "RESULT NOT VERIFIED";
}

async function loadVerifiedRaceResults() {
    const result = await getJolpicaCollection("results/1.json", raceCalendarPath);
    if (result.data) {
        verifiedResultRounds = new Set(jolpicaCollection(result.data, raceCalendarPath)
            .filter(race => Array.isArray(race?.Results) && race.Results.length > 0)
            .map(race => Number(race.round))
            .filter(Number.isFinite));
    }
    if (result.error) dataWarnings.add(result.message);
    return result;
}

function normalizeMatchText(value) {
    return String(value || "").normalize("NFKD").replace(/[\u0300-\u036f]/g, "")
        .toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

function normalizedCountry(value) {
    const country = normalizeMatchText(value);
    if (["usa", "us", "united states of america"].includes(country)) return "united states";
    if (["uk", "great britain"].includes(country)) return "united kingdom";
    if (["uae"].includes(country)) return "united arab emirates";
    return country;
}

function openF1LocationMatches(race, meeting) {
    const locality = normalizeMatchText(race.locality);
    const meetingLocation = normalizeMatchText(meeting?.location);
    const circuitLocation = normalizeMatchText(meeting?.circuit_short_name);
    const localityAliases = {
        "monte carlo": ["monaco"],
        spa: ["spa francorchamps"],
        "abu dhabi": ["yas island"]
    };

    if (!locality || !meetingLocation) return false;
    return locality === meetingLocation || locality === circuitLocation ||
        (localityAliases[locality] || []).includes(meetingLocation);
}

function matchOpenF1Meeting(race, meetings) {
    const date = race.dateIso;
    const name = normalizeMatchText(race.name);
    const country = normalizedCountry(race.country);
    return meetings.find(meeting => {
        if (Number(meeting?.year) !== SEASON || meeting?.is_cancelled) return false;
        if (normalizeMatchText(meeting?.meeting_name) !== name) return false;
        if (normalizedCountry(meeting?.country_name) !== country) return false;
        if (!openF1LocationMatches(race, meeting)) return false;
        const start = String(meeting?.date_start || "").slice(0, 10);
        const end = String(meeting?.date_end || "").slice(0, 10);
        return Boolean(date && start && end && date >= start && date <= end);
    }) || null;
}

function applyRaceVisual(race) {
    const meeting = matchOpenF1Meeting(race, raceMeetings);
    if (!meeting) return race;
    return {
        ...race,
        flag: /^https:\/\//i.test(meeting.country_flag || "") ? meeting.country_flag : "",
        meetingName: meeting.meeting_name || "",
        circuitType: meeting.circuit_type || "",
        visual: /^https:\/\//i.test(meeting.circuit_image || "") ? {
            image: meeting.circuit_image,
            alt: `${meeting.circuit_short_name || race.circuit} circuit illustration`,
            kind: "circuit",
            credit: "Circuit illustration · Formula 1 via OpenF1"
        } : null
    };
}

async function loadRaceVisualData() {
    const hasHomeRaceVisuals = $("#homeEventVisual");
    if ((!raceList && !hasHomeRaceVisuals && !$("#viewDetail")) || (!races.length && !directoryState.races.records.length)) return;
    const result = await getCachedResource(
        "openf1:meetings:2024",
        OPENF1_CACHE_TTL,
        () => fetchJson(OPENF1_MEETINGS_URL, "OpenF1"),
        validOpenF1Meetings,
        "OpenF1 circuit artwork"
    );

    raceVisualError = result.error && !result.data ? result.message : "";
    if (result.error) {
        dataWarnings.add(result.message);
        updateDataStatus();
    }
    raceVisualsLoaded = true;
    if (result.data) {
        raceMeetings = result.data;
        races = races.map(applyRaceVisual);
        directoryState.races.records = directoryState.races.records.map(applyRaceVisual);
    }
    updateDataStatus();
    if (raceList) renderRaces();
    renderHomeRaceVisuals();
    if (document.body.dataset.page === "view") renderViewPage();
}

function renderHomeRaceVisuals() {
    const eventVisual = $("#homeEventVisual");
    if (!eventVisual) return;

    const makeCircuitMarkup = (race, visualClass, fallbackText) => {
        const image = race?.visual?.image
            ? `<img class="home-circuit-image ${visualClass}" src="${escapeHTML(race.visual.image)}" alt="${escapeHTML(race.name)} circuit illustration" loading="lazy" decoding="async">`
            : "";
        const flag = race?.flag
            ? `<img class="race-flag home-race-flag" src="${escapeHTML(race.flag)}" alt="${escapeHTML(race.country)} flag" loading="lazy">`
            : "";
        const fallback = raceVisualsLoaded ? "CIRCUIT ARTWORK UNAVAILABLE" : fallbackText;
        return `${image}${flag}<span class="home-circuit-fallback" ${image ? "hidden" : ""}>${fallback}</span>`;
    };

    if (eventVisual) {
        const britishGp = races.find(race => race.round === 12);
        eventVisual.innerHTML = makeCircuitMarkup(britishGp, "event-circuit-image", "CIRCUIT ARTWORK LOADING");
        bindRaceVisualFallbacks(eventVisual);
    }

}

function recordResourceError(result, section) {
    if (!result.error) return;
    dataWarnings.add(result.message);
    if (!result.data) errors[section] = result.message;
}

function updateDataStatus() {
    const status = $(".topline span:last-child");
    const notices = [...dataWarnings].filter(Boolean);
    if (status) status.textContent = notices.length
        ? notices.join(" · ")
        : "Jolpica championship data · 2024 season";
    let visibleStatus = $("#apiDataStatus");
    if (notices.length && !visibleStatus) {
        visibleStatus = document.createElement("p");
        visibleStatus.id = "apiDataStatus";
        visibleStatus.className = "api-data-status";
        visibleStatus.setAttribute("role", "status");
        $("main")?.prepend(visibleStatus);
    }
    if (visibleStatus) {
        visibleStatus.hidden = !notices.length;
        visibleStatus.textContent = notices.join(" · ");
    }
}

async function loadApiData() {
    const page = document.body.dataset.page;
    if (page === "view") {
        await loadIndividualRecord();
        apiLoaded = true;
        updateDataStatus();
        return;
    }
    const tasks = [];
    const loadDrivers = async () => {
        const result = await getJolpicaCollection("driverstandings.json", driverStandingsPath);
        recordResourceError(result, "drivers");
        recordResourceError(result, "driverStandings");
        if (result.data) {
            const rows = jolpicaCollection(result.data, driverStandingsPath);
            drivers = driverStandings = normalizeDrivers(rows.map(row => row.Driver), rows, []);
            allDriversLoaded = true;
        }
    };
    const loadConstructors = async () => {
        const result = await getJolpicaCollection("constructorstandings.json", constructorStandingsPath);
        recordResourceError(result, "teams");
        recordResourceError(result, "teamStandings");
        if (result.data) teams = teamStandings = normalizeTeamStandings(jolpicaCollection(result.data, constructorStandingsPath), []);
    };
    const loadRaces = async () => {
        const result = await getJolpicaCollection("races.json", raceCalendarPath);
        recordResourceError(result, "races");
        if (result.data) {
            races = normalizeRaces(jolpicaCollection(result.data, raceCalendarPath));
            allRacesLoaded = true;
        }
    };
    if (["home", "teams", "drivers", "standings", "search"].includes(page)) tasks.push(loadDrivers());
    if (["home", "teams", "drivers", "standings", "search"].includes(page)) tasks.push(loadConstructors());
    if (["home", "races", "search"].includes(page)) tasks.push(loadRaces());
    if (["home", "races", "search"].includes(page)) tasks.push(loadVerifiedRaceResults());
    await Promise.all(tasks);
    races = races.map(race => ({ ...race, status: raceStatus(race) }));
    if (page === "drivers") {
        directoryState.drivers.records = drivers.slice((driverPage - 1) * pageSize, driverPage * pageSize);
        directoryState.drivers.total = drivers.length;
        directoryState.drivers.page = driverPage;
    }
    if (page === "races") {
        directoryState.races.records = races.slice((racePage - 1) * pageSize, racePage * pageSize);
        directoryState.races.total = races.length;
        directoryState.races.page = racePage;
    } else directoryState.races.records = directoryState.races.records.map(race => ({ ...race, status: raceStatus(race) }));
    teams = teamStandings = teams.map(team => {
        const lineupDrivers = drivers.filter(driver => driver.teamIds.includes(team.id));
        return { ...team, lineupDrivers, driverLineup: lineupDrivers.map(driver => driver.fullName), driverCount: lineupDrivers.length };
    });
    apiLoaded = true;
    updateDataStatus();
}

async function loadIndividualRecord() {
    const params = new URLSearchParams(window.location.search);
    const type = params.get("type");
    const id = params.get("id") || "";
    if (!["driver", "team", "race"].includes(type) || !id) return;
    const safeId = encodeURIComponent(id);
    const endpoint = type === "driver" ? `drivers/${safeId}/driverstandings.json`
        : type === "team" ? `constructors/${safeId}/constructorstandings.json`
        : /^\d+$/.test(id) ? `${safeId}/races.json` : "races.json";
    const path = type === "driver" ? driverStandingsPath : type === "team" ? constructorStandingsPath : raceCalendarPath;
    const result = await getJolpicaCollection(endpoint, path);
    if (!result.data) {
        errors[type === "driver" ? "drivers" : type === "team" ? "teams" : "races"] = result.message;
        return;
    }
    if (result.error) dataWarnings.add(result.message);
    const rows = jolpicaCollection(result.data, path);
    if (type === "driver") {
        if (rows.length) drivers = normalizeDrivers(rows.map(row => row.Driver), rows, []);
        else {
            const identity = await getJolpicaCollection(`drivers/${safeId}.json`, driverDirectoryPath);
            const directory = identity.data ? jolpicaCollection(identity.data, driverDirectoryPath) : [];
            if (directory.length) drivers = normalizeDrivers(directory, [], []);
            else if (/[-]/.test(id) || /^[A-Za-z]{3}$/.test(id)) {
                await ensureSearchCollection("drivers");
                const record = drivers.find(driver => driverSlug(driver) === id.toLowerCase() || driver.code.toLowerCase() === id.toLowerCase());
                if (record) {
                    params.set("id", record.id);
                    history.replaceState({}, "", `${window.location.pathname}?${params}`);
                }
            }
        }
    } else if (type === "team") {
        teams = teamStandings = normalizeTeamStandings(rows, []);
        const team = teams[0];
        if (team) {
            const saved = readSessionCache(`jolpica:page:${JOLPICA_BASE}driverstandings.json?limit=100&offset=0`, validJolpicaCollection(driverStandingsPath))
                || readSessionCache("jolpica:driver-standings:2024", validJolpicaCollection(driverStandingsPath));
            const savedRows = saved ? jolpicaCollection(saved.data, driverStandingsPath) : [];
            const completeSnapshot = saved && savedRows.length === Number(saved.data.MRData.total);
            const lineup = completeSnapshot && Date.now() - saved.savedAt < API_CACHE_TTL ? null
                : await getJolpicaCollection(`constructors/${encodeURIComponent(team.id)}/drivers.json`, driverDirectoryPath);
            if (lineup?.data) {
                team.lineupDrivers = normalizeDrivers(jolpicaCollection(lineup.data, driverDirectoryPath), [], []).map(driver => ({
                    ...driver, teamIds: [team.id], teamId: team.id, team: team.name, color: team.color
                }));
            } else if (completeSnapshot) {
                team.lineupDrivers = normalizeDrivers(savedRows.map(row => row.Driver), savedRows, rows).filter(driver => driver.teamIds.includes(team.id));
            }
            team.driverLineup = team.lineupDrivers.map(driver => driver.fullName);
            team.driverCount = lineup?.data || completeSnapshot ? team.driverLineup.length : null;
            if (lineup?.error) dataWarnings.add(lineup.message);
        }
    } else {
        await loadVerifiedRaceResults();
        races = normalizeRaces(rows);
    }
}

function getErrorMessage(error) {
    return error instanceof Error ? error.message : "Unable to load Formula 1 data.";
}

function renderPagination(container, totalPages, currentPage, onSelect) {
    if (!container) return;
    container.innerHTML = `<div class="pagination-controls" role="group" aria-label="List pagination">
        <button class="page-link" data-page="${Math.max(1, currentPage - 1)}" ${currentPage === 1 ? "disabled" : ""} aria-label="Previous page">← Previous</button>
        <span class="page-indicator" aria-live="polite">${String(currentPage).padStart(2, "0")} / ${String(totalPages).padStart(2, "0")}</span>
        <button class="page-link" data-page="${Math.min(totalPages, currentPage + 1)}" ${currentPage === totalPages ? "disabled" : ""} aria-label="Next page">Next →</button>
    </div>`;
    $$('button[data-page]', container).forEach(button => {
        button.addEventListener("click", async () => {
            if (container.dataset.changing === "true") return;
            const page = Number(button.dataset.page);
            const list = container.previousElementSibling;
            const animate = list && !document.documentElement.classList.contains("reduce-motion");
            const height = list?.getBoundingClientRect().height || 0;
            container.dataset.changing = "true";
            container.setAttribute("aria-busy", "true");
            $$('button', container).forEach(control => { control.disabled = true; });
            if (list) list.style.minHeight = `${height}px`;
            try {
                if (animate) {
                    list.classList.add("motion-page-exit");
                    await new Promise(resolve => setTimeout(resolve, 125));
                }
                await onSelect(page);
                if (!directoryState.drivers.error && !directoryState.races.error) updatePageUrl(page);
            } finally {
                container.dataset.changing = "false";
                container.setAttribute("aria-busy", "false");
                if (list) {
                    list.classList.remove("motion-page-exit");
                    list.style.minHeight = "";
                }
                requestAnimationFrame(() => {
                    const controls = $$('button[data-page]', container);
                    const indicator = $(".page-indicator", container)?.textContent.split("/").map(Number) || [currentPage, totalPages];
                    if (controls[0]) controls[0].disabled = indicator[0] <= 1;
                    if (controls[1]) controls[1].disabled = indicator[0] >= indicator[1];
                });
            }
        });
    });
}

function renderLoadingStates() {
    if (driverRail) driverRail.innerHTML = `<div class="empty">${racingLoader("Loading drivers…")}</div>`;
    if (driverGrid) driverGrid.innerHTML = `<div class="empty">${racingLoader("Loading driver directory…")}</div>`;
    if (teamGrid) teamGrid.innerHTML = `<div class="empty">${racingLoader("Loading teams…")}</div>`;
    if (standingsTable) standingsTable.innerHTML = `<div class="empty">${racingLoader("Loading standings…")}</div>`;
    if (raceList) raceList.innerHTML = `<div class="empty">${racingLoader("Fetching race calendar…")}</div>`;
    const searchStatus = $("#searchStatus");
    if (searchStatus) searchStatus.innerHTML = racingLoader("Loading archive search…");
    const viewDetail = $("#viewDetail");
    if (viewDetail) viewDetail.innerHTML = `<div class="empty">${racingLoader("Loading archive record…")}</div>`;
    const portraitStatus = $("#portraitStatus");
    if (portraitStatus) portraitStatus.textContent = "T1API portraits are checked as each image loads.";
}

function portraitMarkup(driver, placement) {
    const initials = portraitInitials(driver);
    const colorStyle = `--team:${escapeHTML(driver.color || "#777b82")}`;
    if (!driver.image || unavailablePortraits.has(driver.image)) {
        return `<span class="portrait-placeholder ${placement}-placeholder" style="${colorStyle}" aria-hidden="true">${escapeHTML(initials)}</span>`;
    }

    return `<img class="${placement}-portrait driver-portrait t1-portrait"
        src="${escapeHTML(driver.image)}"
        data-fallback-initials="${escapeHTML(initials)}" data-team-color="${escapeHTML(driver.color || "#777b82")}"
        alt="${escapeHTML(driver.fullName)} portrait" loading="lazy" decoding="async">`;
}

function bindPortraitFallbacks(root) {
    if (!root) return;
    $$("img.driver-portrait", root).forEach(image => {
        image.addEventListener("error", () => {
            unavailablePortraits.add(image.getAttribute("src"));
            try { sessionStorage.setItem("f1insider.portrait-failures", JSON.stringify({ savedAt: Date.now(), urls: [...unavailablePortraits] })); } catch {}
            const heroVisual = image.closest(".hero-api-visual");
            if (heroVisual) {
                image.remove();
                heroVisual.classList.add("portrait-unavailable");
                return;
            }
            const placeholder = document.createElement("span");
            const placement = image.closest(".profile-visual") ? "profile" :
                image.closest(".team-driver") ? "team" :
                    image.closest(".standing-name") ? "standing" :
                image.classList.contains("rail-portrait") ? "rail" :
                    image.classList.contains("modal-portrait") ? "modal" : "driver";
            placeholder.className = placement === "profile"
                ? "profile-portrait-placeholder portrait-placeholder"
                : `${placement}-placeholder portrait-placeholder`;
            placeholder.style.setProperty("--team", image.dataset.teamColor || "#777b82");
            placeholder.setAttribute("aria-hidden", "true");
            placeholder.textContent = image.dataset.fallbackInitials || "F1";
            image.replaceWith(placeholder);
        });
    });
}

function bindTeamLogoFallbacks(root) {
    if (!root) return;
    $$("img.team-logo-image", root).forEach(image => {
        image.addEventListener("error", () => {
            const fallback = document.createElement("span");
            fallback.className = image.closest(".team-car-mark")
                ? "team-car-monogram"
                : image.closest(".team-card-logo") ? "team-card-monogram"
                : image.closest(".team-logo") ? "team-monogram" : "team-modal-mark";
            if (!image.closest(".team-logo")) fallback.style.setProperty("--team", image.dataset.teamColor || "#777b82");
            fallback.setAttribute("aria-hidden", "true");
            fallback.textContent = image.dataset.fallbackMonogram || "F1";
            image.replaceWith(fallback);
        }, { once: true });
    });
}

function renderSpotlightAndTicker() {
    const portraitStatus = $("#portraitStatus");
    if (portraitStatus) {
        portraitStatus.textContent = "T1API portraits load by 2024 Jolpica driver code; unavailable images use initials.";
    }

    const leader = [...driverStandings].sort((a, b) =>
        (a.position ?? Number.MAX_SAFE_INTEGER) - (b.position ?? Number.MAX_SAFE_INTEGER)
    )[0];
    const ticker = $$(".ticker > div");
    if (!leader) {
        if (ticker[1]) ticker[1].innerHTML = "2024 <span>DRIVER DATA UNAVAILABLE</span>";
    } else if (ticker[1]) {
        ticker[1].innerHTML = `<b>P${leader.position}</b> ${escapeHTML(leader.fullName)} <span>${formatValue(leader.points)} PTS</span>`;
    }

    const constructorLeader = [...teamStandings].sort((a, b) => a.position - b.position)[0];
    if (ticker[2] && constructorLeader) {
        ticker[2].innerHTML = `<b>P${constructorLeader.position}</b> ${escapeHTML(constructorLeader.name)} <span>${formatValue(constructorLeader.points)} PTS</span>`;
    } else if (ticker[2]) {
        ticker[2].innerHTML = "2024 <span>CONSTRUCTOR DATA UNAVAILABLE</span>";
    }
    if (ticker[3]) {
        ticker[3].innerHTML = races.length
            ? `<b>${races.length}</b> Grand Prix <span>2024 calendar</span>`
            : "2024 <span>RACE CALENDAR UNAVAILABLE</span>";
    }

    const feature = $(".event-panel");
    if (feature) {
        const eventNote = $("small", feature);
        const featuredRace = races.find(race => race.round === 12);
        if (featuredRace) {
            if (eventNote) eventNote.textContent = "2024 Jolpica calendar / Round 12";
            const eventTitle = $("h2", feature);
            const stats = $$(".event-meta b", feature);
            if (eventTitle) {
                const grandPrixName = featuredRace.name.replace(/\s+Grand Prix$/i, "").toUpperCase();
                eventTitle.innerHTML = `${escapeHTML(grandPrixName)}<br>GRAND PRIX`;
            }
            if (stats[0]) stats[0].textContent = featuredRace.circuit;
            if (stats[1]) stats[1].textContent = featuredRace.date;
        } else {
            if (eventNote) eventNote.textContent = "2024 archive / Round 12 unavailable";
            const eventTitle = $("h2", feature);
            const stats = $$(".event-meta b", feature);
            if (eventTitle) eventTitle.innerHTML = "RACE<br>DETAILS";
            if (stats[0]) stats[0].textContent = "—";
            if (stats[1]) stats[1].textContent = "—";
        }
    }

}

function renderRail() {
    if (!driverRail) return;
    if (!apiLoaded) return;
    const insight = $("#driverInsight");
    if (errors.drivers) {
        driverRail.innerHTML = `<div class="empty">${escapeHTML(errors.drivers)}</div>`;
        if (insight) insight.textContent = "2024 driver insight is unavailable.";
        return;
    }
    if (!drivers.length) {
        driverRail.innerHTML = '<div class="empty">NO 2024 DRIVER DATA.</div>';
        if (insight) insight.textContent = "2024 driver insight is unavailable.";
        return;
    }

    const railDrivers = drivers.slice(0, Math.min(5, drivers.length));
    activeDriver = Math.min(activeDriver, railDrivers.length - 1);
    const featuredDriver = railDrivers[activeDriver];
    updateDriverInsight(featuredDriver, false);
    driverRail.innerHTML = railDrivers.map((driver, index) => `
        <button class="rail-card ${index === activeDriver ? "active" : ""}"
            style="--team:${driver.color}" data-index="${index}"
            aria-pressed="${index === activeDriver}"
            aria-label="${escapeHTML(driver.fullName)}, ${SEASON} season driver">
            ${portraitMarkup(driver, "rail")}
            <div class="rail-info">
                <small>${escapeHTML(driver.code)} / ${SEASON} SEASON</small>
                <h3>${escapeHTML(driver.first)}<span>${escapeHTML(driver.last)}</span></h3>
                <p>${escapeHTML(driver.team)}</p>
                <div class="rail-stats"><span>${formatValue(driver.points)} PTS</span><span>${formatValue(driver.wins)} WINS</span><span>#${formatValue(driver.number)}</span></div>
            </div>
        </button>
    `).join("");

    $$('.rail-card', driverRail).forEach(card => {
        card.addEventListener("click", () => {
            const index = Number(card.dataset.index);
            if (index === activeDriver) openDetail("driver", railDrivers[index]);
            else selectRailDriver(index, railDrivers);
        });
    });
    bindPortraitFallbacks(driverRail);
}

function driverInsightText(driver) {
    return driver.position !== null && driver.points !== null
        ? `${driver.fullName} closes the ${SEASON} season P${driver.position} with ${driver.points} championship points.`
        : `${driver.fullName} has no final ${SEASON} championship classification.`;
}

function updateDriverInsight(driver, animate = true) {
    const insight = $("#driverInsight");
    if (!insight) return;
    const text = driverInsightText(driver);
    if (!animate || document.documentElement.classList.contains("reduce-motion")) {
        insight.textContent = text;
        insight.classList.remove("is-changing");
        return;
    }
    const token = String((Number(insight.dataset.motionToken) || 0) + 1);
    insight.dataset.motionToken = token;
    insight.classList.add("is-changing");
    window.setTimeout(() => {
        if (insight.dataset.motionToken !== token) return;
        insight.textContent = text;
        requestAnimationFrame(() => insight.classList.remove("is-changing"));
    }, 140);
}

function selectRailDriver(index, railDrivers) {
    if (index < 0 || index >= railDrivers.length || index === activeDriver) return;
    const previousIndex = activeDriver;
    const token = ++railMotionToken;
    const cards = $$(".rail-card", driverRail);
    cards.forEach(card => card.classList.remove("is-entering", "is-leaving"));
    cards.find(card => Number(card.dataset.index) === previousIndex)?.classList.add("is-leaving");
    cards.find(card => Number(card.dataset.index) === index)?.classList.add("is-entering");
    activeDriver = index;
    cards.forEach(card => {
        const selected = Number(card.dataset.index) === index;
        card.classList.toggle("active", selected);
        card.setAttribute("aria-pressed", String(selected));
    });
    updateDriverInsight(railDrivers[index]);
    window.setTimeout(() => {
        if (token === railMotionToken) cards.forEach(card => card.classList.remove("is-entering", "is-leaving"));
    }, 760);
}

function prepareFilterToolbars() {
    const tools = $("body[data-page='teams'] .directory-tools");
    if (tools && !tools.dataset.filterScope) {
        tools.className = "directory-tools filter-toolbar";
        tools.dataset.filterScope = "teams";
        tools.innerHTML = `<div class="filter-primary"><input class="search form-control" id="teamSearch" type="search" placeholder="Search constructor…" aria-label="Search teams" data-param="q" data-chip-label="Search"><button class="filter-toggle" type="button" aria-expanded="false" aria-controls="teamFilters">Filters</button><div class="count" role="status"><b id="teamCount">0</b>results</div><div class="view-toggle" role="group" aria-label="Team view"><button type="button" data-view-for="teams" data-view="grid" aria-pressed="true">Grid</button><button type="button" data-view-for="teams" data-view="list" aria-pressed="false">List</button></div></div><div class="filter-panel" id="teamFilters"><label>Nationality<select class="search form-select" id="teamNationalityFilter" data-param="nationality" data-chip-label="Nationality"><option value="">All nationalities</option></select></label><label>Sort<select class="search form-select" id="teamSort" data-param="sort" data-default="position" data-chip-label="Sort"><option value="position">Championship position</option><option value="points">Points</option><option value="wins">Wins</option></select></label><button class="clear-filters" type="button">Clear all</button></div><div class="active-filters" aria-live="polite"></div>`;
    }
}

function populateSelect(select, values, firstLabel) {
    if (!select) return;
    const current = select.value || new URLSearchParams(location.search).get(select.dataset.param) || "";
    select.innerHTML = `<option value="">${escapeHTML(firstLabel)}</option>${[...new Set(values.filter(Boolean))].sort((a, b) => String(a).localeCompare(String(b))).map(value => `<option value="${escapeHTML(value)}">${escapeHTML(value)}</option>`).join("")}`;
    if ([...select.options].some(option => option.value === current)) select.value = current;
}

function populateFilterOptions() {
    populateSelect($("#driverNationalityFilter"), drivers.map(driver => driver.nationality), "All nationalities");
    populateSelect($("#teamNationalityFilter"), teams.map(team => team.nationality), "All nationalities");
    populateSelect($("#raceCountryFilter"), races.map(race => race.country), "All countries");
    populateSelect($("#raceStatusFilter"), races.map(race => race.status), "All statuses");
    const teamOptions = teams.map(team => ({ id: team.id, name: team.name }));
    [$("#driverTeamFilter"), $("#standingsTeamFilter")].forEach(select => {
        if (!select) return;
        const current = select.value || new URLSearchParams(location.search).get("team") || "";
        select.innerHTML = `<option value="">All teams</option>${teamOptions.map(team => `<option value="${escapeHTML(team.id)}">${escapeHTML(team.name)}</option>`).join("")}`;
        if (teamOptions.some(team => team.id === current)) select.value = current;
    });
}

function restoreBrowseControls() {
    const params = new URLSearchParams(location.search);
    $$('[data-param]').forEach(control => {
        const value = params.get(control.dataset.param);
        if (value === null) return;
        if (control.tagName !== "SELECT" || [...control.options].some(option => option.value === value)) control.value = value;
    });
    $$("[data-view-for]").forEach(button => {
        const scope = button.dataset.viewFor;
        const fallback = scope === "races" ? "list" : "grid";
        const active = (params.get("view") || fallback) === button.dataset.view;
        button.setAttribute("aria-pressed", String(active));
    });
}

function selectedView(scope) {
    return $(`[data-view-for="${scope}"][aria-pressed="true"]`)?.dataset.view || (scope === "races" ? "list" : "grid");
}

function sortBrowseRecords(records, key) {
    const sorted = [...records];
    if (key === "name") return sorted.sort((a, b) => String(a.fullName || a.name).localeCompare(String(b.fullName || b.name)));
    if (key === "date") return sorted.sort((a, b) => a.dateValue - b.dateValue);
    if (key === "points" || key === "wins") return sorted.sort((a, b) => (b[key] ?? -1) - (a[key] ?? -1) || (a.position ?? Infinity) - (b.position ?? Infinity));
    return sorted.sort((a, b) => (a.position ?? a.round ?? Infinity) - (b.position ?? b.round ?? Infinity));
}

function syncBrowseUrl(scope, page = 1) {
    const params = new URLSearchParams(location.search);
    const toolbar = $(`[data-filter-scope="${scope}"]`);
    $$('[data-param]', toolbar).forEach(control => {
        const fallback = control.dataset.default || "";
        if (control.value && control.value !== fallback) params.set(control.dataset.param, control.value);
        else params.delete(control.dataset.param);
    });
    const view = selectedView(scope);
    const defaultView = scope === "races" ? "list" : "grid";
    if (view !== defaultView) params.set("view", view); else params.delete("view");
    if (page > 1) params.set("page", String(page)); else params.delete("page");
    history.replaceState({}, "", `${location.pathname}${params.size ? `?${params}` : ""}`);
}

function renderFilterMeta(scope) {
    const toolbar = $(`[data-filter-scope="${scope}"]`);
    if (!toolbar) return;
    const chips = $(".active-filters", toolbar);
    const controls = $$('[data-param]', toolbar).filter(control => control.value && control.value !== (control.dataset.default || ""));
    chips.innerHTML = controls.map(control => {
        const display = control.tagName === "SELECT" ? control.selectedOptions[0]?.textContent : control.value;
        return `<button type="button" data-remove-param="${escapeHTML(control.dataset.param)}" aria-label="Remove ${escapeHTML(control.dataset.chipLabel)} filter"><span>${escapeHTML(control.dataset.chipLabel)}: ${escapeHTML(display)}</span><b aria-hidden="true">×</b></button>`;
    }).join("");
    chips.hidden = !controls.length;
}

function detailUrl(type, id) {
    const returnTo = `${location.pathname.split('/').pop() || 'index.html'}${location.search}`;
    return `view.html?type=${type}&id=${encodeURIComponent(id)}&return=${encodeURIComponent(returnTo)}`;
}

function renderDrivers() {
    if (!driverGrid) return;
    if (!apiLoaded) return;
    if (errors.drivers) {
        driverGrid.innerHTML = `<div class="empty">${escapeHTML(errors.drivers)}</div>`;
        $("#driverCount").textContent = "—";
        renderPagination($("#driverPagination"), 1, 1, () => {});
        return;
    }

    const query = normalizeMatchText($("#driverSearch")?.value || "");
    const selectedTeam = $("#driverTeamFilter")?.value || "";
    const nationality = $("#driverNationalityFilter")?.value || "";
    const sort = $("#driverSort")?.value || "position";
    const native = !query && !selectedTeam && !nationality && sort === "position";
    const state = directoryState.drivers;
    if (state.loading) return;
    if (state.error) {
        driverGrid.innerHTML = `<div class="empty" role="status">${escapeHTML(state.error)}</div>`;
        $("#driverCount").textContent = "—";
        renderPagination($("#driverPagination"), Math.max(1, Math.ceil(state.total / pageSize)), state.page, page => loadDirectoryPage("drivers", page));
        return;
    }
    const filtered = drivers.filter(driver => {
        const matchesQuery = normalizeMatchText(`${driver.fullName} ${driver.code} ${driver.number ?? ""}`).includes(query);
        return matchesQuery && (!selectedTeam || driver.teamIds.includes(selectedTeam)) && (!nationality || driver.nationality === nationality);
    });
    const ordered = sortBrowseRecords(filtered, sort);
    const pages = Math.max(1, Math.ceil((native ? state.total : filtered.length) / pageSize));
    driverPage = Math.min(driverPage, pages);
    const visible = native ? state.records : ordered.slice((driverPage - 1) * pageSize, driverPage * pageSize);

    $("#driverCount").textContent = String(native ? state.total : filtered.length);
    driverGrid.innerHTML = visible.length ? visible.map(driver => `
        <div class="col-12 col-md-6 col-xl-3">
        <a class="driver-card card" style="--team:${driver.color}" href="${detailUrl("driver", driver.id)}" aria-label="View ${escapeHTML(driver.fullName)} profile">
            ${portraitMarkup(driver, "driver")}
            <div>
            <small>${driver.position === null ? "NO STANDINGS" : `P${driver.position}`} / #${formatValue(driver.number)} / ${escapeHTML(driver.code)}</small>
                <h3>${escapeHTML(driver.first)}${driver.last ? `<br>${escapeHTML(driver.last)}` : ""}</h3>
                <p>${escapeHTML(driver.team)} · ${SEASON} SEASON</p>
            </div>
        </a></div>
    `).join("") : '<div class="empty">No drivers match the selected filters.</div>';
    driverGrid.classList.toggle("is-list-view", selectedView("drivers") === "list");
    renderFilterMeta("drivers");

    renderPagination($("#driverPagination"), pages, driverPage, page => {
        if (native) return loadDirectoryPage("drivers", page);
        driverPage = page;
        syncBrowseUrl("drivers", page);
        renderDrivers();
    });

    bindPortraitFallbacks(driverGrid);
}

function renderTeams() {
    if (!teamGrid) return;
    if (!apiLoaded) return;
    if (errors.teams) {
        teamGrid.innerHTML = `<div class="empty">${escapeHTML(errors.teams)}</div>`;
        $("#teamCount").textContent = "—";
        return;
    }

    const query = normalizeMatchText($("#teamSearch")?.value || "");
    const nationality = $("#teamNationalityFilter")?.value || "";
    const sort = $("#teamSort")?.value || "position";
    const filtered = sortBrowseRecords(teams.filter(team => normalizeMatchText(team.name).includes(query)
        && (!nationality || team.nationality === nationality)), sort);
    $("#teamCount").textContent = String(filtered.length);
    teamGrid.innerHTML = filtered.length ? filtered.map(team => {
        const visualColor = TEAM_2024_COLORS[team.id] || team.color;
        return `
        <div class="team-card-item col-12 col-lg-6">
            <button class="team-card card" style="--team:${escapeHTML(visualColor)}" data-id="${escapeHTML(team.id)}" data-short="${escapeHTML(team.monogram)}" aria-label="View ${escapeHTML(team.name)} team details">
                <div class="team-card-copy">
                    <div class="team-card-heading">
                        <span class="team-position">${team.position === null ? "P—" : `P${team.position}`}</span>
                    <div class="team-card-identity">
                        <h3>${escapeHTML(team.name)}</h3>
                        <span class="team-nationality">${escapeHTML(team.nationality)}</span>
                    </div>
                    <span class="team-card-logo" aria-label="${team.logo ? `${escapeHTML(team.name)} logo` : `${escapeHTML(team.name)} monogram fallback`}">${team.logo
                        ? `<img class="team-logo-image" src="${escapeHTML(team.logo)}" data-fallback-monogram="${escapeHTML(team.monogram)}" data-team-color="${escapeHTML(visualColor)}" alt="${escapeHTML(team.name)} logo" loading="lazy">`
                        : `<b aria-hidden="true">${escapeHTML(team.monogram)}</b>`
                    }</span>
                </div>
                    <div class="team-driver-lineup">
                        ${(team.lineupDrivers || []).length
                            ? team.lineupDrivers.map(driver => `
                                <span class="team-driver">
                                    ${portraitMarkup(driver, "team")}
                                    <span>${escapeHTML(driver.fullName)}</span>
                                </span>
                            `).join("")
                            : `<span class="team-lineup-unavailable">Driver lineup unavailable</span>`
                        }
                    </div>
                </div>
                <div class="team-card-stats">
                    <div><small>POINTS</small><strong>${formatValue(team.points)}</strong></div>
                    <div><small>WINS</small><strong>${formatValue(team.wins)}</strong></div>
                    <div><small>2024 CAR · LOCAL REFERENCE</small><strong>${escapeHTML(TEAM_2024_CAR_MODELS[team.id] || "—")}</strong></div>
                </div>
            </button>
        </div>
    `;
    }).join("") : '<div class="empty">No constructors match the selected filters.</div>';
    teamGrid.classList.toggle("is-list-view", selectedView("teams") === "list");
    renderFilterMeta("teams");

    $$('.team-card', teamGrid).forEach(card => {
        card.addEventListener("click", () => {
            const team = teams.find(item => String(item.id) === card.dataset.id);
            if (team) openDetail("team", team);
        });
    });
    bindPortraitFallbacks(teamGrid);
    bindTeamLogoFallbacks(teamGrid);
}

function raceCode(location) {
    const country = String(location || "").split(",").pop().trim().toLowerCase();
    const codes = {
        australia: "AU", china: "CN", japan: "JP", bahrain: "BH",
        "saudi arabia": "SA", "united states": "US", usa: "US", canada: "CA", monaco: "MC",
        spain: "ES", austria: "AT", "united kingdom": "GB", italy: "IT",
        singapore: "SG", mexico: "MX", brazil: "BR", qatar: "QA",
        "united arab emirates": "AE", hungary: "HU", belgium: "BE", netherlands: "NL",
        azerbaijan: "AZ", france: "FR", germany: "DE", russia: "RU"
    };
    return codes[country] || "GP";
}

function renderRaces() {
    if (!raceList) return;
    if (!apiLoaded) return;
    if (errors.races) {
        $("#raceCount").textContent = "—";
        raceList.innerHTML = `<div class="empty">${escapeHTML(errors.races)}</div>`;
        renderPagination($("#racePagination"), 1, 1, () => {});
        const description = $("#races .section-heading > p");
        if (description) description.textContent = `2024 race calendar unavailable: ${errors.races}`;
        return;
    }
    const query = normalizeMatchText($("#raceSearch")?.value || "");
    const country = $("#raceCountryFilter")?.value || "";
    const status = $("#raceStatusFilter")?.value || "";
    const sort = $("#raceSort")?.value || "round";
    const native = !query && !country && !status && sort === "round";
    const state = directoryState.races;
    if (state.loading) return;
    if (state.error) {
        raceList.innerHTML = `<div class="empty" role="status">${escapeHTML(state.error)}</div>`;
        $("#raceCount").textContent = "—";
        renderPagination($("#racePagination"), Math.max(1, Math.ceil(state.total / pageSize)), state.page, page => loadDirectoryPage("races", page));
        return;
    }
    const filtered = sortBrowseRecords(races.filter(race => normalizeMatchText(`${race.name} ${race.circuit}`).includes(query)
        && (!country || race.country === country) && (!status || race.status === status)), sort);
    const pages = Math.max(1, Math.ceil((native ? state.total : filtered.length) / pageSize));
    racePage = Math.min(racePage, pages);
    const visible = native ? state.records : filtered.slice((racePage - 1) * pageSize, racePage * pageSize);
    $("#raceCount").textContent = String(native ? state.total : filtered.length);
    const raceDescription = $("#races .section-heading > p");
    if (raceDescription) {
        raceDescription.textContent = errors.races
            ? `2024 race calendar unavailable: ${errors.races}`
            : "The complete 2024 Grand Prix calendar from Jolpica. Completion is verified against returned race results.";
    }
    const footerNote = $(".footer-main > p");
    if (footerNote) {
        footerNote.textContent = "2024 driver, constructor, and race calendar data from Jolpica. Driver portraits from T1API.";
    }
    const copyrightNote = $(".copyright span:first-child");
    if (copyrightNote) copyrightNote.textContent = "2024 calendar · Jolpica · Circuit artwork via OpenF1 / Formula 1";
    if (raceVisualError && raceDescription) {
        raceDescription.textContent += " Circuit artwork is temporarily unavailable; race calendar data remains available.";
    }
    raceList.innerHTML = visible.length ? visible.map(race => {
        const visual = race.visual;
        const flag = race.flag ? `<img class="race-flag" src="${escapeHTML(race.flag)}" alt="" loading="lazy"><span>${escapeHTML(raceCode(race.location))}</span>` : `<span>${escapeHTML(raceCode(race.location))}</span>`;
        const credit = visual?.credit || (raceVisualsLoaded ? "Circuit artwork unavailable" : "Circuit artwork loading");
        return `
            <button class="race-card card col-12 col-md-6 col-xl-4" data-round="${race.round}" aria-label="Open ${escapeHTML(race.name)} details">
                <span class="race-visual is-circuit">
                    ${visual?.image ? `<img class="race-card-image" src="${escapeHTML(visual.image)}" alt="${escapeHTML(visual.alt)}" loading="lazy" decoding="async">` : ""}
                    <span class="race-visual-fallback" ${visual?.image ? "hidden" : ""}>${raceVisualsLoaded ? "CIRCUIT ARTWORK UNAVAILABLE" : "CIRCUIT ARTWORK LOADING"}</span>
                    <span class="race-round">ROUND ${String(race.round).padStart(2, "0")}</span>
                    <span class="race-image-kind">${visual?.image ? "CIRCUIT ILLUSTRATION" : "VISUAL UNAVAILABLE"}</span>
                </span>
                <span class="race-card-copy">
                    <span class="race-card-kicker">${flag}<span>${SEASON} SEASON</span></span>
                    <h3>${escapeHTML(race.name)}</h3>
                    <span class="race-circuit">${escapeHTML(race.circuit)}${race.circuitType ? ` · ${escapeHTML(race.circuitType)}` : ""}</span>
                    <span class="race-meta"><span>${escapeHTML(race.date)}</span><span>${escapeHTML(race.location)}</span></span>
                    <span class="race-stats"><span><small>RACE TIME · UTC</small>${escapeHTML(race.time)}</span><span><small>STATUS</small><span class="race-status-value">${raceStatusMarkup(race)}</span></span></span>
                    <span class="race-attribution">${escapeHTML(credit)}</span>
                    <span class="race-open" aria-hidden="true">VIEW RACE DETAILS <b>→</b></span>
                </span>
            </button>
        `;
    }).join("") : '<div class="empty">No races match the selected filters.</div>';
    raceList.classList.toggle("is-calendar-view", selectedView("races") === "calendar");
    renderFilterMeta("races");

    bindRaceVisualFallbacks(raceList);

    renderPagination($("#racePagination"), pages, racePage, page => {
        if (native) return loadDirectoryPage("races", page);
        racePage = page;
        syncBrowseUrl("races", page);
        renderRaces();
    });

    $$('.race-card', raceList).forEach(card => {
        card.addEventListener("click", () => {
            const race = visible.find(item => item.round === Number(card.dataset.round));
            if (race) openDetail("race", race);
        });
    });
}

function bindRaceVisualFallbacks(root) {
    if (!root) return;
    $$("img.race-card-image, img.race-modal-image, img.home-circuit-image", root).forEach(image => {
        image.addEventListener("error", () => {
            image.hidden = true;
            const fallback = image.closest(".race-visual, .race-modal-visual, .event-panel-visual")
                ?.querySelector(".race-visual-fallback, .race-modal-fallback, .home-circuit-fallback");
            fallback?.removeAttribute("hidden");
        }, { once: true });
    });
    $$("img.race-flag", root).forEach(image => image.addEventListener("error", () => image.remove(), { once: true }));
}

function renderStandings() {
    if (!standingsTable || !apiLoaded) return;
    const error = standingType === "drivers" ? errors.driverStandings : errors.teamStandings;
    if (error) {
        standingsTable.innerHTML = `<div class="empty">${escapeHTML(error)}</div>`;
        if ($("#standingsCount")) $("#standingsCount").textContent = "—";
        return;
    }

    const query = normalizeMatchText($("#standingsSearch")?.value || "");
    const team = $("#standingsTeamFilter")?.value || "";
    const sort = $("#standingsSort")?.value || "position";
    const records = sortBrowseRecords((standingType === "drivers" ? driverStandings : teamStandings).filter(record =>
        normalizeMatchText(record.fullName || record.name).includes(query)
        && (standingType !== "drivers" || !team || record.teamIds.includes(team))), sort);
    const search = $("#standingsSearch");
    if (search) search.placeholder = standingType === "drivers" ? "Search driver standings…" : "Search constructor standings…";
    $("#standingsTeamFilterLabel")?.toggleAttribute("hidden", standingType !== "drivers");
    if ($("#standingsCount")) $("#standingsCount").textContent = String(records.length);
    standingsTable.innerHTML = records.length ? records.map((record, index) => {
        const name = standingType === "drivers" ? record.fullName : record.name;
        const detail = standingType === "drivers" ? record.team : "2024 CONSTRUCTOR";
        const color = record.color || teamColor(record.id);
        const type = standingType === "drivers" ? "driver" : "team";
        return `
            <a class="standing-row ${record.position <= 3 ? `top podium-${record.position}` : ""}" href="${detailUrl(type, record.id)}" aria-label="View ${escapeHTML(name || "Unknown")} details">
                <span>${record.position === null ? "—" : String(record.position).padStart(2, "0")}</span>
                <span class="standing-name">${standingType === "drivers" ? portraitMarkup(record, "standing") : ""}<i style="background:${color}"></i>${escapeHTML(name || "Unknown")}</span>
                <span>${escapeHTML(detail || "Unknown team")}</span>
                <strong>${formatValue(record.points)} PTS</strong>
            </a>
        `;
    }).join("") : '<div class="empty" role="status">No standings match the selected filters.</div>';
    renderFilterMeta("standings");
    bindPortraitFallbacks(standingsTable);
}

function homeStandingMarkup(records, type) {
    return records.slice(0, 5).map((record, index) => {
        const name = type === "drivers" ? record.fullName : record.name;
        const detail = type === "drivers" ? record.team : "2024 CONSTRUCTOR";
        const color = type === "drivers" ? record.color : record.color || teamColor(record.id);
        return `<a class="standing-row ${index < 3 ? "top" : ""}" href="view.html?type=${type === "drivers" ? "driver" : "team"}&id=${encodeURIComponent(record.id)}">
            <span>${record.position === null ? "—" : String(record.position).padStart(2, "0")}</span>
            <span class="standing-name">${type === "drivers" ? portraitMarkup(record, "standing") : ""}<i style="background:${color}"></i>${escapeHTML(name || "Unknown")}</span>
            <span>${escapeHTML(detail || "Unknown team")}</span>
            <strong>${formatValue(record.points)} PTS</strong>
        </a>`;
    }).join("");
}

function renderHomePreviews() {
    const homeDrivers = $("#homeDriverStandings");
    const homeTeams = $("#homeTeamStandings");
    if (!homeDrivers && !homeTeams) return;

    if (homeDrivers) {
        homeDrivers.innerHTML = driverStandings.length
            ? homeStandingMarkup(driverStandings, "drivers")
            : '<div class="empty">DRIVER STANDINGS UNAVAILABLE.</div>';
    }
    if (homeTeams) {
        homeTeams.innerHTML = teamStandings.length
            ? homeStandingMarkup(teamStandings, "teams")
            : '<div class="empty">CONSTRUCTOR STANDINGS UNAVAILABLE.</div>';
    }
    if (homeDrivers) bindPortraitFallbacks(homeDrivers);
}

function openDetail(type, record) {
    if (!modal || !modalContent || !record) return;
    const isDriver = type === "driver";
    const isTeam = type === "team";
    const title = isDriver ? record.fullName : record.name;
    const subtitle = isDriver
        ? `#${formatValue(record.number)} · ${record.team} · 2024 SEASON`
        : isTeam
            ? `2024 SEASON · Nationality: ${record.nationality} · Drivers: ${(record.driverLineup || []).map(escapeHTML).join(", ") || "Unavailable"}`
            : `2024 RACE · ${record.circuit} · ${record.date} · ${record.location} · ${record.time}${record.sessions?.length ? ` · ${record.sessions.join(" · ")}` : ""}`;
    const stats = isDriver
        ? [["POSITION", record.position === null ? "—" : `P${record.position}`], ["POINTS", record.points], ["WINS", record.wins], ["NATIONALITY", record.nationality], ["DATE OF BIRTH", record.dateOfBirth || "—"]]
        : isTeam
            ? [["POSITION", record.position === null ? "—" : `P${record.position}`], ["POINTS", record.points], ["WINS", record.wins]]
            : [["ROUND", record.round], ["RACE TIME", record.time], ["STATUS", record.status]];
    const recordUrl = detailUrl(type, isDriver || isTeam ? record.id : record.round);
    const imageMarkup = isDriver
        ? portraitMarkup(record, "modal")
        : isTeam && record.logo
                ? `<img class="team-modal-logo team-logo-image" src="${escapeHTML(record.logo)}" data-fallback-monogram="${escapeHTML(record.monogram)}" data-team-color="${escapeHTML(record.color)}" alt="${escapeHTML(record.name)} logo">`
            : !isTeam && record.visual?.image
                ? `<figure class="race-modal-visual is-circuit">
                    <img class="race-modal-image" src="${escapeHTML(record.visual.image)}" alt="${escapeHTML(record.visual.alt)}">
                    <span class="race-modal-fallback" hidden>RACE VISUAL UNAVAILABLE</span>
                    <figcaption>Circuit illustration · <a href="https://openf1.org/" target="_blank" rel="noopener noreferrer">OpenF1</a> / Formula 1</figcaption>
                </figure>`
            : !isTeam
                ? `<div class="race-modal-visual race-modal-empty"><span>2024 RACE ARCHIVE</span><b>${String(record.round).padStart(2, "0")}</b></div>`
                : `<div class="team-modal-mark" style="--team:${escapeHTML(record.color)}" aria-hidden="true">${escapeHTML(record.monogram)}</div>`;

    modalContent.innerHTML = `
        ${imageMarkup}
        <div class="modal-copy">
            <p class="eyebrow">${escapeHTML(type)} profile · ${SEASON} season</p>
            <h2>${escapeHTML(title || "Unknown")}</h2>
            <p>${escapeHTML(subtitle)}</p>
            <div class="modal-data">
                ${stats.map(([label, value]) => `<div><small>${escapeHTML(label)}</small><b class="${!isDriver && !isTeam && label === "STATUS" ? "race-status-value" : ""}">${!isDriver && !isTeam && label === "STATUS" ? raceStatusMarkup(record) : formatValue(value)}</b></div>`).join("")}
            </div>
            <a class="cta red modal-detail-link" href="${recordUrl}">Open full details →</a>
            ${!isDriver && !isTeam && record.sessions?.length ? `<div class="modal-sessions"><h3>AVAILABLE WEEKEND SESSIONS</h3><ul>${record.sessions.map(session => `<li>${escapeHTML(session)}</li>`).join("")}</ul></div>` : ""}
        </div>
    `;
    bindPortraitFallbacks(modalContent);
    bindTeamLogoFallbacks(modalContent);
    bindRaceVisualFallbacks(modalContent);
    bootstrap.Modal.getOrCreateInstance(modal).show();
}

function updateChampionshipLabels() {
    const topLine = $(".topline span:last-child");
    if (topLine) topLine.textContent = "Jolpica championship data · 2024 season";
    const standingsDescription = $("#standings .section-heading > p");
    if (standingsDescription) standingsDescription.textContent = "Final 2024 driver and constructor rankings from Jolpica.";
}

function setupInteractions() {
    let driverSearchTimer;
    let raceSearchTimer;
    const updateDirectorySearch = async kind => {
        const state = directoryState[kind];
        const request = ++state.request;
        state.loading = true;
        state.error = "";
        const mount = kind === "drivers" ? driverGrid : raceList;
        mount.setAttribute("aria-busy", "true");
        mount.innerHTML = `<div class="empty">${racingLoader(kind === "drivers" ? "Loading drivers…" : "Fetching race calendar…")}</div>`;
        try {
            const toolbar = $(`[data-filter-scope="${kind}"]`);
            const filtered = $$('[data-param]', toolbar).some(control => control.value && control.value !== (control.dataset.default || ""));
            if (filtered) await ensureSearchCollection(kind);
            else {
                syncBrowseUrl(kind, 1);
                await loadDirectoryPage(kind, 1);
                return;
            }
            if (request !== state.request) return;
            if (kind === "drivers") driverPage = 1;
            else racePage = 1;
            syncBrowseUrl(kind, 1);
        } catch (error) {
            if (request !== state.request) return;
            state.error = getErrorMessage(error);
        } finally {
            if (request === state.request) {
                state.loading = false;
                mount.setAttribute("aria-busy", "false");
                kind === "drivers" ? renderDrivers() : renderRaces();
            }
        }
    };
    const applyBrowseChange = scope => {
        if (scope === "drivers") return updateDirectorySearch("drivers");
        if (scope === "races") return updateDirectorySearch("races");
        syncBrowseUrl(scope, 1);
        scope === "teams" ? renderTeams() : renderStandings();
    };
    $$(".filter-toolbar").forEach(toolbar => {
        const scope = toolbar.dataset.filterScope;
        $(".filter-toggle", toolbar)?.addEventListener("click", event => {
            const expanded = event.currentTarget.getAttribute("aria-expanded") !== "true";
            event.currentTarget.setAttribute("aria-expanded", String(expanded));
            $(".filter-panel", toolbar)?.classList.toggle("is-open", expanded);
        });
        $$('select[data-param]', toolbar).forEach(control => control.addEventListener("change", () => applyBrowseChange(scope)));
        const input = $('input[data-param]', toolbar);
        input?.addEventListener("input", () => {
            if (scope === "drivers") { clearTimeout(driverSearchTimer); driverSearchTimer = setTimeout(() => applyBrowseChange(scope), 150); }
            else if (scope === "races") { clearTimeout(raceSearchTimer); raceSearchTimer = setTimeout(() => applyBrowseChange(scope), 150); }
            else applyBrowseChange(scope);
        });
        $(".clear-filters", toolbar)?.addEventListener("click", () => {
            $$('[data-param]', toolbar).forEach(control => { control.value = control.dataset.default || ""; });
            applyBrowseChange(scope);
        });
        $(".active-filters", toolbar)?.addEventListener("click", event => {
            const chip = event.target.closest("[data-remove-param]");
            if (!chip) return;
            const control = $(`[data-param="${CSS.escape(chip.dataset.removeParam)}"]`, toolbar);
            if (control) control.value = control.dataset.default || "";
            applyBrowseChange(scope);
        });
    });
    $$('[data-view-for]').forEach(button => button.addEventListener("click", () => {
        const scope = button.dataset.viewFor;
        $$(`[data-view-for="${scope}"]`).forEach(item => item.setAttribute("aria-pressed", String(item === button)));
        syncBrowseUrl(scope, Number(new URLSearchParams(location.search).get("page")) || 1);
        scope === "drivers" ? renderDrivers() : scope === "teams" ? renderTeams() : renderRaces();
    }));
    const searchForm = $("#searchForm");
    const searchInput = $("#siteSearch");
    const params = new URLSearchParams(window.location.search);
    if (searchInput) searchInput.value = params.get("q") || "";
    if ($("#standingsSearch")) $("#standingsSearch").value = params.get("q") || "";
    $$(".tabs button[data-tab]").forEach(button => {
        button.classList.toggle("active", button.dataset.tab === standingType);
        button.setAttribute("aria-pressed", String(button.dataset.tab === standingType));
    });
    searchForm?.addEventListener("submit", event => {
        event.preventDefault();
        searchPage = 1;
        updateSearchUrl(searchInput?.value || "", "push");
        renderSearchResults();
    });
    searchInput?.addEventListener("input", () => {
        searchPage = 1;
        updateSearchUrl(searchInput.value, "replace");
        renderSearchResults();
    });
    window.addEventListener("popstate", () => {
        if (!searchInput) return;
        const params = new URLSearchParams(window.location.search);
        searchInput.value = params.get("q") || "";
        searchPage = Math.max(1, Math.floor(Number(params.get("page")) || 1));
        renderSearchResults();
    });

    $("#prevDriver")?.addEventListener("click", () => {
        if (!drivers.length) return;
        const railDrivers = drivers.slice(0, 5);
        selectRailDriver((activeDriver - 1 + railDrivers.length) % railDrivers.length, railDrivers);
    });
    $("#nextDriver")?.addEventListener("click", () => {
        if (!drivers.length) return;
        const railDrivers = drivers.slice(0, 5);
        selectRailDriver((activeDriver + 1) % railDrivers.length, railDrivers);
    });

    $$(".tabs button").forEach(button => button.addEventListener("click", () => {
        $$(".tabs button").forEach(tab => {
            tab.classList.toggle("active", tab === button);
            tab.setAttribute("aria-pressed", String(tab === button));
        });
        standingType = button.dataset.tab;
        if (standingType !== "drivers" && $("#standingsTeamFilter")) $("#standingsTeamFilter").value = "";
        const params = new URLSearchParams(window.location.search);
        params.set("tab", standingType);
        if (standingType !== "drivers") params.delete("team");
        params.delete("page");
        history.replaceState({}, "", `${window.location.pathname}?${params}`);
        renderStandings();
    }));

    $$("nav a").forEach(link => link.addEventListener("click", () => {
        const nav = $("#nav");
        if (nav?.classList.contains("show")) bootstrap.Collapse.getOrCreateInstance(nav).hide();
    }));

}

function setupScrollEffects() {
    const revealItems = $$(".rail-head, .driver-rail, .directory-tools, .team-grid, .race-list, .standings");
    revealItems.forEach(item => item.classList.add("reveal"));

    if ("IntersectionObserver" in window) {
        const revealObserver = new IntersectionObserver(entries => {
            entries.forEach(entry => {
                if (!entry.isIntersecting) return;
                entry.target.classList.add("visible");
                revealObserver.unobserve(entry.target);
            });
        }, { threshold: 0.08 });
        revealItems.forEach(item => revealObserver.observe(item));

        const navLinks = $$("#nav a");
        const sections = $$("main section[id]");
        if (document.body.dataset.page === "home") {
            const sectionObserver = new IntersectionObserver(entries => {
                entries.forEach(entry => {
                    if (!entry.isIntersecting || entry.target.id !== "home") return;
                    navLinks.forEach(link => link.classList.toggle("active", link.getAttribute("href") === "index.html"));
                });
            }, { rootMargin: "-35% 0px -55% 0px" });
            sections.forEach(section => sectionObserver.observe(section));
        }
    } else {
        revealItems.forEach(item => item.classList.add("visible"));
    }
}

function setActivePageNavigation() {
    let activePage = document.body.dataset.page || "home";
    if (activePage === "view") {
        const type = new URLSearchParams(window.location.search).get("type");
        activePage = type === "team" ? "teams" : type === "race" ? "races" : "drivers";
    }
    $$("#nav a").forEach(link => {
        const page = (link.getAttribute("href") || "index.html").replace(".html", "") || "index";
        link.classList.toggle("active", activePage === "home" ? page === "index" : page === activePage);
    });
}

function updateSearchUrl(value, method) {
    const params = new URLSearchParams(window.location.search);
    const query = String(value || '').trim();
    if (query) params.set('q', query);
    else params.delete('q');
    params.delete('page');
    const nextUrl = `${window.location.pathname}${params.toString() ? `?${params}` : ''}`;
    history[method === 'push' ? 'pushState' : 'replaceState']({}, '', nextUrl);
}

function renderSearchResults() {
    const resultsRoot = $('#searchResults');
    const status = $('#searchStatus');
    if (!resultsRoot || !status || !apiLoaded) return;
    const query = normalizeMatchText($('#siteSearch')?.value || '');
    if (!query) {
        status.textContent = 'Enter a driver, constructor, or Grand Prix to search the 2024 archive.';
        resultsRoot.innerHTML = '';
        if ($('#searchPagination')) $('#searchPagination').innerHTML = '';
        return;
    }
    const results = [];
    for (const driver of drivers) {
        if (normalizeMatchText(`${driver.fullName} ${driver.team} ${driver.nationality} ${driver.code} ${driver.number}`).includes(query)) {
            results.push({ type: 'driver', title: driver.fullName, description: `${driver.team} · ${driver.nationality}`, url: detailUrl('driver', driver.id) });
        }
    }
    for (const team of teams) {
        if (normalizeMatchText(`${team.name} ${team.nationality} ${(team.driverLineup || []).join(' ')}`).includes(query)) {
            results.push({ type: 'team', title: team.name, description: `2024 constructor · ${team.nationality}`, url: detailUrl('team', team.id) });
        }
    }
    for (const race of races) {
        if (normalizeMatchText(`${race.name} ${race.circuit} ${race.location} ${race.country} ${race.date} round ${race.round}`).includes(query)) {
            results.push({ type: 'race', title: race.name, description: `Round ${race.round} · ${race.circuit} · ${race.location}`, url: detailUrl('race', race.round) });
        }
    }
    const score = item => normalizeMatchText(item.title) === query ? 2 : normalizeMatchText(item.title).startsWith(query) ? 1 : 0;
    results.sort((a, b) => score(b) - score(a));
    const pages = Math.max(1, Math.ceil(results.length / pageSize));
    searchPage = Math.min(searchPage, pages);
    const unavailable = Object.entries({ drivers: errors.drivers, constructors: errors.teams, races: errors.races }).filter(([, error]) => error).map(([name]) => name);
    status.textContent = results.length ? `${results.length} result${results.length === 1 ? '' : 's'} for “${query}”.` : `No 2024 archive records found for “${query}”.`;
    if (unavailable.length) status.textContent += ` Partial results: ${unavailable.join(', ')} unavailable.`;
    resultsRoot.innerHTML = results.length ? results.slice((searchPage - 1) * pageSize, searchPage * pageSize).map(item => `
        <div class="col-12 col-md-6 col-xl-4">
            <a class="search-result card" href="${item.url}">
                <small>${escapeHTML(item.type)} · 2024 ARCHIVE</small>
                <h3>${escapeHTML(item.title)}</h3>
                <p>${escapeHTML(item.description)}</p>
                <b>View details →</b>
            </a>
        </div>
    `).join('') : '<div class="empty" role="status">Try a different name, team, circuit, or country.</div>';
    renderPagination($('#searchPagination'), pages, searchPage, page => {
        searchPage = page;
        renderSearchResults();
    });
}

function viewListUrl(type) {
    const requestedReturn = new URLSearchParams(location.search).get("return");
    if (requestedReturn && /^(drivers|teams|races|standings)\.html(?:\?[^#]*)?$/.test(requestedReturn)) return requestedReturn;
    if (type === 'driver') return 'drivers.html';
    if (type === 'team') return 'teams.html';
    return 'races.html';
}

function renderViewError(message, type) {
    const mount = $('#viewDetail');
    if (!mount) return;
    mount.innerHTML = `<div class="view-state"><p class="eyebrow">RECORD UNAVAILABLE</p><h1>NO MATCH ON THIS GRID.</h1><p>${escapeHTML(message)}</p><a class="profile-back" href="${viewListUrl(type)}">← BACK TO ${type === 'team' ? 'TEAMS' : type === 'race' ? 'RACES' : 'DRIVERS'}</a></div>`;
}

function renderViewPage() {
    const queryString = window.location.search;
    const urlParams = new URLSearchParams(queryString);
    const type = (urlParams.get('type') || '').toLowerCase();
    const id = urlParams.get('id') || '';
    const mount = $('#viewDetail');
    if (!mount) return;
    if (!['driver', 'team', 'race'].includes(type) || !id) {
        renderViewError('Choose a driver, constructor, or race using its details link.', type);
        return;
    }
    let record;
    if (type === 'driver') {
        const driverId = id.toLowerCase().replace(/[_\s]+/g, "-");
        record = drivers.find(item => driverSlug(item) === driverId || item.id === id || item.code.toLowerCase() === id.toLowerCase());
    } else if (type === 'team') {
        record = teams.find(item => item.id === id || item.name.toLowerCase().replace(/[^a-z0-9]+/g, '-') === id.toLowerCase());
    } else {
        const round = Number(id);
        const raceId = id.toLowerCase();
        record = races.find(item => item.round === round || [item.name, item.circuit, item.location, item.country].some(value => {
            const slug = String(value || "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
            return slug === raceId || slug.split("-").includes(raceId);
        }));
    }
    if (!record) {
        renderViewError(errors[type === 'driver' ? 'drivers' : type === 'team' ? 'teams' : 'races'] || 'The selected record is not in the available 2024 Jolpica data.', type);
        return;
    }
    document.title = `${type === 'driver' ? record.fullName : record.name} — F1 INSIDER`;
    const backUrl = viewListUrl(type);
    const backLabel = type === 'driver' ? 'DRIVERS' : type === 'team' ? 'TEAMS' : 'RACES';
    if (type === 'driver') {
        const position = record.position === null ? '—' : `P${record.position}`;
        mount.innerHTML = `
            <div class="view-topline"><a class="profile-back" href="${backUrl}">← BACK TO ${backLabel}</a><span>2024 SEASON</span><strong>${position}</strong></div>
            <div class="profile-layout view-profile-layout" style="--team:${escapeHTML(record.color)}">
                <div class="profile-copy"><p class="profile-kicker">DRIVER PROFILE / ${escapeHTML(record.code)}</p><p class="profile-first-name">${escapeHTML(record.first)}</p><h1 class="profile-last-name">${escapeHTML(record.last || record.first)}</h1><p class="profile-team">${escapeHTML(record.team)}</p><div class="profile-bio"><span>${formatValue(record.nationality)}</span><span>BORN · ${formatValue(record.dateOfBirth)}</span><span>CAR NUMBER · ${formatValue(record.number)}</span></div><div class="profile-stats"><div><small>CHAMPIONSHIP POSITION</small><strong>${position}</strong></div><div><small>CHAMPIONSHIP POINTS</small><strong>${formatValue(record.points)}</strong></div><div><small>RACE WINS</small><strong>${formatValue(record.wins)}</strong></div></div></div>
                <div class="profile-visual">${portraitMarkup(record, 'profile')}<span class="profile-number">${record.number === null ? '' : `#${escapeHTML(record.number)}`}</span></div>
            </div>`;
        bindPortraitFallbacks(mount);
        return;
    }
    if (type === 'team') {
        mount.innerHTML = `
            <div class="view-record" style="--team:${escapeHTML(record.color)}"><div class="view-record-copy"><a class="profile-back" href="${backUrl}">← BACK TO ${backLabel}</a><p class="eyebrow">2024 CONSTRUCTOR · P${formatValue(record.position)}</p><h1>${escapeHTML(record.name)}</h1><p>${escapeHTML(record.nationality)} · ${formatValue(record.points)} points · ${formatValue(record.wins)} wins</p><div class="view-record-stats"><span>POSITION <b>P${formatValue(record.position)}</b></span><span>POINTS <b>${formatValue(record.points)}</b></span><span>WINS <b>${formatValue(record.wins)}</b></span></div><h2>2024 DRIVER LINEUP</h2><div class="view-lineup">${(record.lineupDrivers || []).map(driver => `<a href="view.html?type=driver&id=${encodeURIComponent(driver.id)}">${portraitMarkup(driver, 'team')}<span>${escapeHTML(driver.fullName)}</span></a>`).join('') || '<p>Driver lineup unavailable.</p>'}</div></div><div class="view-record-art" aria-hidden="true"><span>${escapeHTML(record.monogram)}</span><strong>${escapeHTML(TEAM_2024_CAR_MODELS[record.id] || '2024 CONSTRUCTOR')}</strong></div></div>`;
        bindPortraitFallbacks(mount);
        return;
    }
    const circuitImage = record.visual?.image ? `<figure class="view-circuit race-modal-visual is-circuit"><img class="race-modal-image" src="${escapeHTML(record.visual.image)}" alt="${escapeHTML(record.visual.alt)}"><span class="race-modal-fallback" hidden>CIRCUIT ILLUSTRATION UNAVAILABLE</span><figcaption>OpenF1 circuit illustration</figcaption></figure>` : `<div class="view-record-art"><span>${String(record.round).padStart(2, '0')}</span><strong>2024 RACE ARCHIVE</strong></div>`;
    mount.innerHTML = `<div class="view-record view-race-record">${circuitImage}<div class="view-record-copy"><a class="profile-back" href="${backUrl}">← BACK TO ${backLabel}</a><p class="eyebrow">2024 GRAND PRIX · ROUND ${String(record.round).padStart(2, '0')}</p><h1>${escapeHTML(record.name)}</h1><p>${escapeHTML(record.circuit)} · ${escapeHTML(record.location)}</p><div class="view-record-stats"><span>DATE <b>${escapeHTML(record.date)}</b></span><span>RACE TIME <b>${escapeHTML(record.time)}</b></span><span>STATUS <b class="race-status-value">${raceStatusMarkup(record)}</b></span></div><h2>WEEKEND SESSIONS</h2><ul class="view-session-list">${record.sessions?.map(session => `<li>${escapeHTML(session)}</li>`).join('') || '<li>Session schedule unavailable.</li>'}</ul></div></div>`;
    bindRaceVisualFallbacks(mount);}

function initialize() {
    prepareFilterToolbars();
    restoreBrowseControls();
    updateChampionshipLabels();
    setActivePageNavigation();
    renderLoadingStates();
    setupInteractions();
    setupScrollEffects();
    if (document.body.dataset.page === "home") loadHomeCommonsImages();
    loadApiData().then(async () => {
        populateFilterOptions();
        restoreBrowseControls();
        if (document.body.dataset.page === "drivers" && $$('[data-param]', $("[data-filter-scope='drivers']")).some(control => control.value && control.value !== (control.dataset.default || ""))) await ensureSearchCollection("drivers");
        if (document.body.dataset.page === "races" && $$('[data-param]', $("[data-filter-scope='races']")).some(control => control.value && control.value !== (control.dataset.default || ""))) await ensureSearchCollection("races");
        renderSpotlightAndTicker();
        renderRail();
        renderDrivers();
        renderTeams();
        renderRaces();
        renderStandings();
        renderHomePreviews();
        if (document.body.dataset.page === 'search') renderSearchResults();
        if (document.body.dataset.page === 'view') renderViewPage();
        if (raceList || $('#homeEventVisual') || $('#viewDetail')) {
            loadRaceVisualData().catch(error => {
                raceVisualError = getErrorMessage(error);
                raceVisualsLoaded = true;
                if (raceList) renderRaces();
                renderHomeRaceVisuals();
            });
        }
    }).catch(error => {
        apiLoaded = true;
        errors.drivers = errors.driverStandings = errors.teams = errors.teamStandings = errors.races = getErrorMessage(error);
        const errorText = escapeHTML(getErrorMessage(error));
        if (driverGrid) driverGrid.innerHTML = `<div class="empty">${errorText}</div>`;
        if (teamGrid) teamGrid.innerHTML = `<div class="empty">${errorText}</div>`;
        if (raceList) raceList.innerHTML = `<div class="empty">${errorText}</div>`;
        if (standingsTable) standingsTable.innerHTML = `<div class="empty">${errorText}</div>`;
        if ($('#searchStatus')) $('#searchStatus').textContent = `Search data unavailable. ${getErrorMessage(error)}`;
        if ($('#viewDetail')) renderViewError(getErrorMessage(error), new URLSearchParams(window.location.search).get('type') || 'driver');
    });
}

initialize();
