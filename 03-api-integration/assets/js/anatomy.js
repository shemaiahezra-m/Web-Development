(() => {
  const API = "https://api.openf1.org/v1";
  const YEAR = 2024;
  const CACHE_TTL = 7 * 24 * 60 * 60 * 1000;
  const CACHE_PREFIX = "f1insider.openf1.anatomy.v2.";
  const inFlight = new Map();
  const savedResponses = new Map();
  const failedRequests = new Set();
  const features = [
    { id: "cockpit", label: "Telemetry" },
    { id: "strategy", label: "Stints" },
    { id: "overtakes", label: "Overtake Central" },
    { id: "control", label: "Race Control" }
  ];
  let meetings = [];
  let sessions = [];
  let drivers = [];
  let activeFeature = "cockpit";
  let activeSignal = "speed";
  let featureRequest = 0;
  let replayTimer;
  let activeSystem = "aero";
  let activeComponent = "front-wing";

  const $ = (selector, root = document) => root.querySelector(selector);
  const escapeHTML = (value) => String(value ?? "").replace(/[&<>"']/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#039;" })[character]);
  const queryString = (params) => new URLSearchParams(Object.entries(params).map(([key, value]) => [key, String(value)])).toString();
  const selectedSession = () => sessions.find((session) => String(session.session_key) === $("#sessionSelect").value);
  const selectedDriver = () => drivers.find((driver) => String(driver.driver_number) === $("#driverSelect").value);
  const selectedMeeting = () => meetings.find((meeting) => String(meeting.meeting_key) === $("#meetingSelect").value);
  const timeLabel = (date) => date ? new Date(date).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false }) : "—";
  const racingLoader = (label) => window.F1Motion?.loadingMarkup?.(label) || `<span role="status">${escapeHTML(label)}</span>`;
  const driverLabel = (number) => {
    const driver = drivers.find((item) => Number(item.driver_number) === Number(number));
    return driver ? `${driver.name_acronym} · ${driver.full_name}` : `Car ${number ?? "—"}`;
  };
  const showSavedDataNotice = (savedAt) => {
    const timestamp = Number.isFinite(savedAt)
      ? ` Last updated ${new Date(savedAt).toLocaleString([], { dateStyle: "medium", timeStyle: "short" })}.`
      : "";
    const status = $("#analysisDataStatus");
    if (status) {
      status.hidden = false;
      status.textContent = `Showing previously saved data. Live updates are temporarily unavailable.${timestamp}`;
    }
  };

  async function openF1(endpoint, params = {}) {
    const query = queryString(params);
    const url = `${API}/${endpoint}${query ? `?${query}` : ""}`;
    const cacheKey = endpoint === "meetings" && query === "year=2024"
      ? "f1-insider-jolpica-v1:openf1:meetings:2024"
      : CACHE_PREFIX + endpoint + "." + query;
    let cached = savedResponses.get(cacheKey);
    try {
      cached ||= JSON.parse(sessionStorage.getItem(cacheKey) || "null");
    } catch (_) {}
    if (!cached || !Number.isFinite(cached.savedAt) || !Array.isArray(cached.data)) cached = null;
    if (cached && Date.now() - cached.savedAt < CACHE_TTL) return cached.data;
    if (failedRequests.has(cacheKey)) {
      if (cached) { showSavedDataNotice(cached.savedAt); return cached.data; }
      throw new Error("OpenF1 is temporarily unavailable for this selection. Try again later.");
    }
    if (inFlight.has(cacheKey)) return inFlight.get(cacheKey);
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 25000);
    const request = fetch(url, { signal: controller.signal }).then(async (response) => {
      if (!response.ok) throw new Error(`OpenF1 request returned ${response.status}.`);
      const data = await response.json();
      if (!Array.isArray(data)) throw new Error("OpenF1 returned an unexpected response.");
      if (cached?.data.length && !data.length) throw new Error("The refresh returned no records; saved data was retained.");
      const entry = { savedAt: Date.now(), data };
      savedResponses.set(cacheKey, entry);
      try { sessionStorage.setItem(cacheKey, JSON.stringify(entry)); } catch (_) {}
      return data;
    }).catch(error => {
      failedRequests.add(cacheKey);
      if (cached) {
        showSavedDataNotice(cached.savedAt);
        return cached.data;
      }
      throw error;
    }).finally(() => { clearTimeout(timeout); inFlight.delete(cacheKey); });
    inFlight.set(cacheKey, request);
    return request;
  }

  function showState(message, error = false) {
    $("#featureContent").innerHTML = error
      ? `<p class="analysis-state error" role="status">${escapeHTML(message)}</p>`
      : `<div class="analysis-state">${racingLoader(message)}</div>`;
  }

  function renderFeatureTabs() {
    const select = $("#analysisCategory");
    if (!select) return;
    const sessionName = selectedSession()?.session_name || "";
    const available = features.filter(feature => feature.id !== "overtakes" || /race|sprint/i.test(sessionName));
    if (!available.some(feature => feature.id === activeFeature)) activeFeature = available[0]?.id || "cockpit";
    select.innerHTML = available.map(feature => `<option value="${feature.id}" ${feature.id === activeFeature ? "selected" : ""}>${escapeHTML(feature.label)}</option>`).join("");
  }

  function outputHead(title, note = "") {
    return `<div class="analysis-output-head"><div><h2>${escapeHTML(title)}</h2><p>${escapeHTML(selectedMeeting()?.meeting_name || "2024 race")}${selectedSession() ? ` · ${escapeHTML(selectedSession().session_name)}` : ""}</p></div>${note ? `<span class="analysis-output-note">${escapeHTML(note)}</span>` : ""}</div>`;
  }

  function getWindow(session) {
    const start = new Date(session.date_start);
    const end = new Date(start.getTime() + 120000);
    return { "date>": start.toISOString(), "date<": end.toISOString() };
  }

  const signals = {
    speed: { label: "Speed", field: "speed", unit: "km/h" },
    rpm: { label: "RPM", field: "rpm", unit: "rpm" },
    n_gear: { label: "Gear", field: "n_gear", unit: "gear" },
    throttle: { label: "Throttle", field: "throttle", unit: "%" },
    brake: { label: "Brake", field: "brake", unit: "%" }
  };

  function chartPoints(records, field) {
    const values = records.map((record) => Number(record[field])).filter((value) => Number.isFinite(value));
    if (!values.length) return "";
    const min = Math.min(...values);
    const range = Math.max(...values) - min || 1;
    return values.map((value, index) => `${24 + index / Math.max(1, values.length - 1) * 952},${224 - (value - min) / range * 190}`).join(" ");
  }

  function renderCockpit(records, session, driver) {
    const latest = records.at(-1) || {};
    const draw = () => {
      const signal = signals[activeSignal];
      const values = records.map((record) => Number(record[signal.field])).filter(Number.isFinite);
      const high = values.length ? Math.max(...values) : null;
      const current = Number(latest[signal.field]);
      const output = $("#cockpitChart");
      $("#cockpitStat").innerHTML = `<strong>${high === null ? "—" : Math.round(high).toLocaleString()}</strong> ${escapeHTML(signal.unit)} peak <span>· latest ${Number.isFinite(current) ? Math.round(current).toLocaleString() : "—"}</span>`;
      output.innerHTML = `<svg class="analysis-chart" viewBox="0 0 1000 250" role="img" aria-label="${escapeHTML(signal.label)} trace for ${escapeHTML(driver.full_name)}"><g>${[34,81,128,175,222].map((y) => `<line class="analysis-chart-grid" x1="24" y1="${y}" x2="976" y2="${y}"/>`).join("")}</g><polyline class="analysis-chart-path" points="${chartPoints(records, signal.field)}"/></svg>`;
      document.querySelectorAll("[data-signal]").forEach((button) => {
        button.classList.toggle("active", button.dataset.signal === activeSignal);
        button.setAttribute("aria-pressed", String(button.dataset.signal === activeSignal));
      });
    };
    $("#featureContent").innerHTML = `<div class="analysis-output">${outputHead("Inside the Cockpit", `${records.length} samples · first two minutes`)}<div class="analysis-signal-controls">${Object.entries(signals).map(([key, signal]) => `<button type="button" data-signal="${key}" class="${key === activeSignal ? "active" : ""}" aria-pressed="${key === activeSignal}">${signal.label}</button>`).join("")}</div><p class="analysis-stat" id="cockpitStat"></p><div class="analysis-visual" id="cockpitChart"></div></div>`;
    document.querySelectorAll("[data-signal]").forEach((button) => button.addEventListener("click", () => { activeSignal = button.dataset.signal; draw(); }));
    draw();
  }

  function renderReplay(records, driver) {
    if (!records.length) throw new Error("No location data is available for this driver and session.");
    const points = records.map((record) => ({ x: Number(record.x), y: Number(record.y), date: record.date })).filter((point) => Number.isFinite(point.x) && Number.isFinite(point.y));
    const minX = Math.min(...points.map((point) => point.x));
    const maxX = Math.max(...points.map((point) => point.x));
    const minY = Math.min(...points.map((point) => point.y));
    const maxY = Math.max(...points.map((point) => point.y));
    const plotted = points.map((point) => ({ x: 30 + ((point.x - minX) / (maxX - minX || 1)) * 840, y: 500 - ((point.y - minY) / (maxY - minY || 1)) * 440, date: point.date }));
    const path = plotted.map((point) => `${point.x},${point.y}`).join(" ");
    $("#featureContent").innerHTML = `<div class="analysis-output">${outputHead("Race Replay", `${driver.full_name} · location samples`)}<div class="replay-stage"><svg id="replayPlot" viewBox="0 0 900 540" role="img" aria-label="Recorded OpenF1 position trace for ${escapeHTML(driver.full_name)}"><polyline class="replay-path" points="${path}"/><circle class="replay-marker" id="replayMarker" cx="${plotted[0].x}" cy="${plotted[0].y}" r="11"/></svg><div class="replay-controls"><button class="replay-button" id="replayToggle" type="button">Play</button><input id="replayScrubber" type="range" min="0" max="${plotted.length - 1}" value="0" aria-label="Scrub position samples"><time id="replayTime">${timeLabel(plotted[0].date)}</time></div></div></div>`;
    const slider = $("#replayScrubber");
    const update = () => {
      const point = plotted[Number(slider.value)];
      $("#replayMarker").setAttribute("cx", point.x);
      $("#replayMarker").setAttribute("cy", point.y);
      $("#replayTime").textContent = timeLabel(point.date);
    };
    slider.addEventListener("input", update);
    $("#replayToggle").addEventListener("click", () => {
      const button = $("#replayToggle");
      const playing = button.textContent === "Play";
      button.textContent = playing ? "Pause" : "Play";
      clearInterval(replayTimer);
      if (playing) replayTimer = setInterval(() => { slider.value = Number(slider.value) >= plotted.length - 1 ? 0 : Number(slider.value) + 1; update(); }, 90);
    });
  }

  function getLapForEvent(event, laps) {
    const time = Date.parse(event.date);
    const driverLaps = laps.filter((lap) => Number(lap.driver_number) === Number(event.overtaking_driver_number) && Date.parse(lap.date_start) <= time).sort((a, b) => Date.parse(b.date_start) - Date.parse(a.date_start));
    return driverLaps[0]?.lap_number;
  }

  function renderOvertakes(events, laps) {
    const ordered = [...events].sort((a, b) => Date.parse(a.date) - Date.parse(b.date));
    $("#featureContent").innerHTML = `<div class="analysis-output">${outputHead("Overtake Central", `${events.length} recorded passes`)}${ordered.length ? `<div class="analysis-list">${ordered.map((event) => `<article class="analysis-event"><summary><time>${timeLabel(event.date)}</time><span class="analysis-event-kind">LAP ${escapeHTML(getLapForEvent(event, laps) ?? "—")}</span><strong>${escapeHTML(driverLabel(event.overtaking_driver_number))} passed ${escapeHTML(driverLabel(event.overtaken_driver_number))}</strong><span class="analysis-event-kind">P${escapeHTML(event.position ?? "—")}</span></summary></article>`).join("")}</div>` : `<p class="analysis-state">No overtakes were returned for this session.</p>`}</div>`;
  }

  function renderRaceControl(records) {
    const incidents = records.filter((event) => /flag|safety car|virtual safety|vsc|red flag|yellow|penalty|track limit|collision|investigation|drive-through|stop-go|black and white/i.test(event.message || event.category || ""))
      .sort((a, b) => Date.parse(a.date) - Date.parse(b.date));
    $("#featureContent").innerHTML = `<div class="analysis-output">${outputHead("Race Control", `${incidents.length} incident messages`)}${incidents.length ? `<div class="analysis-list">${incidents.map((event) => `<details class="analysis-event"><summary><time>${timeLabel(event.date)}</time><span class="analysis-event-kind">${escapeHTML(event.flag || event.category || "MESSAGE")}</span><strong>${escapeHTML(event.message)}</strong></summary><p>${event.lap_number ? `Lap ${escapeHTML(event.lap_number)} · ` : ""}${event.driver_number ? `${escapeHTML(driverLabel(event.driver_number))} · ` : ""}${escapeHTML(event.scope || "Race control message")}${event.sector ? ` · Sector ${escapeHTML(event.sector)}` : ""}</p></details>`).join("")}</div>` : `<p class="analysis-state">No incident messages were returned for this session.</p>`}</div>`;
  }

  function stintColor(compound) {
    return ({ SOFT: "#e10600", MEDIUM: "#ffd000", HARD: "#eeeeee", INTERMEDIATE: "#39c979", WET: "#3587df" })[String(compound || "").toUpperCase()] || "#85858c";
  }

  function renderStintRow(driver, stints) {
    const maximumLap = Math.max(1, ...stints.map((stint) => Number(stint.lap_end) || 0));
    const total = stints.reduce((sum, stint) => sum + Math.max(0, Number(stint.lap_end) - Number(stint.lap_start) + 1), 0);
    return `<div class="strategy-row"><div class="strategy-row-head"><span>${escapeHTML(driver.name_acronym)} · ${escapeHTML(driver.full_name)}</span><span>${stints.length} stints · ${total} laps recorded</span></div><div class="strategy-bar">${stints.map((stint) => `<span class="strategy-stint" style="width:${Math.max(1, (Number(stint.lap_end) - Number(stint.lap_start) + 1) / maximumLap * 100)}%;background:${stintColor(stint.compound)}" title="${escapeHTML(stint.compound)} · laps ${escapeHTML(stint.lap_start)}–${escapeHTML(stint.lap_end)}">${escapeHTML(stint.compound)}</span>`).join("")}</div></div>`;
  }

  async function renderStrategy(session, driver, requestId) {
    const teammate = drivers.find((item) => item.driver_number !== driver.driver_number && item.team_name === driver.team_name)
      || drivers.find((item) => item.driver_number !== driver.driver_number);
    const compareOptions = drivers.filter((item) => item.driver_number !== driver.driver_number).map((item) => `<option value="${item.driver_number}" ${item.driver_number === teammate?.driver_number ? "selected" : ""}>${escapeHTML(item.name_acronym)} · ${escapeHTML(item.team_name)}</option>`).join("");
    $("#featureContent").innerHTML = `<div class="analysis-output">${outputHead("Tire Strategy", "Compare the session stints")}${compareOptions ? `<div class="strategy-header"><label for="strategyCompare">Compare with<select class="strategy-compare" id="strategyCompare">${compareOptions}</select></label></div>` : ""}<div class="strategy-rows" id="strategyRows"><div class="analysis-state">${racingLoader("Loading tyre stints…")}</div></div></div>`;
    const compareNumber = Number($("#strategyCompare")?.value || teammate?.driver_number);
    const compareDriver = drivers.find((item) => Number(item.driver_number) === compareNumber);
    const [firstStints, secondStints] = await Promise.all([
      openF1("stints", { session_key: session.session_key, driver_number: driver.driver_number }),
      compareDriver ? openF1("stints", { session_key: session.session_key, driver_number: compareDriver.driver_number }) : Promise.resolve([])
    ]);
    if (requestId !== featureRequest) return;
    $("#strategyRows").innerHTML = `${firstStints.length ? renderStintRow(driver, firstStints) : `<p class="analysis-state">No stint records for ${escapeHTML(driver.name_acronym)}.</p>`}${compareDriver ? secondStints.length ? renderStintRow(compareDriver, secondStints) : `<p class="analysis-state">No stint records for ${escapeHTML(compareDriver.name_acronym)}.</p>` : ""}`;
    $("#strategyCompare")?.addEventListener("change", () => renderFeature());
  }

  async function renderGrid(session, requestId) {
    const [positions, results] = await Promise.all([
      openF1("position", { session_key: session.session_key }),
      openF1("session_result", { session_key: session.session_key })
    ]);
    if (requestId !== featureRequest) return;
    const opening = new Map();
    [...positions].sort((a, b) => Date.parse(a.date) - Date.parse(b.date)).forEach((item) => {
      if (!opening.has(Number(item.driver_number))) opening.set(Number(item.driver_number), Number(item.position));
    });
    const position = value => value === null || value === undefined || Number(value) < 1 ? null : Number(value);
    const ordered = [...results].sort((a, b) => (position(a.position) ?? Infinity) - (position(b.position) ?? Infinity));
    const rows = ordered.map((result) => {
      const start = opening.get(Number(result.driver_number));
      const finish = position(result.position);
      const status = result.dsq ? "DSQ" : result.dns ? "DNS" : result.dnf ? "DNF" : "—";
      return { driver: driverLabel(result.driver_number), start, finish, status, change: Number.isFinite(start) && finish !== null ? start - finish : null };
    });
    $("#featureContent").innerHTML = `<div class="analysis-output">${outputHead("Opening Position vs. Result", "First recorded position sample; not the official starting grid")}${positions.length ? "" : `<p class="analysis-state">OpenF1 returned no position samples for this session.</p>`}${rows.length ? `<div class="position-list">${rows.map((row) => `<div class="position-row"><strong>${escapeHTML(row.driver)}</strong><span>${row.start == null ? "—" : `P${row.start}`}</span><span class="position-line"><i style="left:${row.start == null ? 0 : (row.start - 1) / Math.max(1, rows.length - 1) * 100}%"></i>${row.finish === null ? "" : `<b style="left:${(row.finish - 1) / Math.max(1, rows.length - 1) * 100}%"></b>`}</span><span>${row.finish === null ? row.status : `P${escapeHTML(row.finish)}`}</span><span class="position-change ${row.change > 0 ? "gain" : ""}">${row.change == null ? "—" : `${row.change > 0 ? "+" : ""}${row.change}`}</span></div>`).join("")}</div>` : `<p class="analysis-state">No classification results were returned.</p>`}</div>`;
  }

  async function renderFeature() {
    const requestId = ++featureRequest;
    clearInterval(replayTimer);
    const root = $("#featureContent");
    const session = selectedSession();
    const driver = selectedDriver();
    if (!session || !driver) return;
    const feature = features.find((item) => item.id === activeFeature);
    root.setAttribute("aria-busy", "true");
    root.innerHTML = `<div class="analysis-state">${racingLoader(`Loading ${feature.label.toLowerCase()}…`)}</div>`;
    try {
      if (activeFeature === "cockpit") {
        const records = await openF1("car_data", { session_key: session.session_key, driver_number: driver.driver_number, ...getWindow(session) });
        if (requestId !== featureRequest) return;
        if (!records.length) throw new Error("No car telemetry was returned for this selection.");
        activeSignal = "speed";
        renderCockpit(records, session, driver);
      } else if (activeFeature === "replay") {
        const records = await openF1("location", { session_key: session.session_key, driver_number: driver.driver_number, ...getWindow(session) });
        if (requestId !== featureRequest) return;
        renderReplay(records, driver);
      } else if (activeFeature === "overtakes") {
        const [events, laps] = await Promise.all([openF1("overtakes", { session_key: session.session_key }), openF1("laps", { session_key: session.session_key })]);
        if (requestId !== featureRequest) return;
        renderOvertakes(events, laps);
      } else if (activeFeature === "control") {
        const records = await openF1("race_control", { session_key: session.session_key });
        if (requestId !== featureRequest) return;
        renderRaceControl(records);
      } else if (activeFeature === "strategy") {
        await renderStrategy(session, driver, requestId);
      } else {
        await renderGrid(session, requestId);
      }
    } catch (error) {
      if (requestId === featureRequest) $("#featureContent").innerHTML = `<p class="analysis-state error" role="status">${escapeHTML(error.message || "Race data could not be loaded.")}</p>`;
    } finally {
      if (requestId === featureRequest) root.setAttribute("aria-busy", "false");
    }
  }

  function populateSessions() {
    const meetingKey = Number($("#meetingSelect").value);
    const choices = sessions.filter((session) => Number(session.meeting_key) === meetingKey).sort((a, b) => Date.parse(a.date_start) - Date.parse(b.date_start));
    $("#sessionSelect").innerHTML = choices.map((session) => `<option value="${session.session_key}">${escapeHTML(session.session_name)}</option>`).join("");
    const preferred = choices.find((session) => session.session_name === "Race") || choices[0];
    if (preferred) $("#sessionSelect").value = String(preferred.session_key);
    renderFeatureTabs();
    return preferred;
  }

  async function loadDrivers() {
    const session = selectedSession();
    if (!session) return;
    const sessionKey = String(session.session_key);
    ++featureRequest;
    clearInterval(replayTimer);
    drivers = [];
    showState("Loading the selected session…");
    $("#driverSelect").disabled = true;
    $("#driverSelect").innerHTML = "<option>Loading drivers…</option>";
    try {
      const data = await openF1("drivers", { session_key: session.session_key });
      if (String($("#sessionSelect").value) !== sessionKey) return;
      drivers = data.sort((a, b) => Number(a.driver_number) - Number(b.driver_number));
      $("#driverSelect").innerHTML = drivers.map((driver) => `<option value="${driver.driver_number}">${escapeHTML(driver.name_acronym)} · ${escapeHTML(driver.full_name)}</option>`).join("");
      const defaultDriver = drivers.find((driver) => driver.name_acronym === "VER") || drivers[0];
      if (defaultDriver) $("#driverSelect").value = String(defaultDriver.driver_number);
      $("#driverSelect").disabled = false;
      renderFeature();
    } catch (error) {
      if (String($("#sessionSelect").value) !== sessionKey) return;
      $("#driverSelect").disabled = true;
      $("#driverSelect").innerHTML = "<option>Drivers unavailable</option>";
      showState(error.message || "Could not load the session drivers.", true);
    }
  }

  async function initializeAnalysis() {
    showState("Loading the 2024 race archive…");
    try {
      const [meetingData, sessionData] = await Promise.all([openF1("meetings", { year: YEAR }), openF1("sessions", { year: YEAR })]);
      sessions = sessionData;
      meetings = meetingData.filter((meeting) => sessions.some((session) => session.meeting_key === meeting.meeting_key)).sort((a, b) => Date.parse(a.date_start) - Date.parse(b.date_start));
      $("#meetingSelect").innerHTML = meetings.map((meeting) => `<option value="${meeting.meeting_key}">${escapeHTML(meeting.meeting_name)} · ${escapeHTML(meeting.country_name)}</option>`).join("");
      const british = meetings.find((meeting) => /british/i.test(meeting.meeting_name));
      if (british) $("#meetingSelect").value = String(british.meeting_key);
      if (!populateSessions()) throw new Error("No 2024 race sessions were found.");
      await loadDrivers();
      $("#meetingSelect").addEventListener("change", () => { populateSessions(); loadDrivers(); });
      $("#sessionSelect").addEventListener("change", () => { renderFeatureTabs(); loadDrivers(); });
      $("#driverSelect").addEventListener("change", renderFeature);
      $("#analysisCategory").addEventListener("change", event => { activeFeature = event.target.value; renderFeature(); });
    } catch (error) {
      showState(error.message || "The 2024 race archive could not be loaded.", true);
    }
  }

      const systems = [
        { id:"aero", no:"01", name:"Aerodynamics" },
        { id:"power", no:"02", name:"Power Unit" },
        { id:"chassis", no:"03", name:"Chassis & Safety" },
        { id:"suspension", no:"04", name:"Suspension & Braking" },
        { id:"wheels", no:"05", name:"Wheels & Tyres" },
      ]
      const components = [
        ["front-wing","Front Wing","aero",50,89,"Manages airflow around the front of the car while generating aerodynamic load.","Front axle balance and downstream airflow.","Nose / Floor"],
        ["rear-wing","Rear Wing","aero",50,10,"Generates rear-axle downforce and supports stability through fast corners.","Rear grip and aerodynamic drag.","DRS / Diffuser"],
        ["floor","Floor","aero",50,61,"Accelerates airflow beneath the car to create aerodynamic load.","Efficient underfloor downforce.","Diffuser / Sidepods"],
        ["diffuser","Diffuser","aero",50,20,"Expands and manages airflow as it exits beneath the floor.","Underfloor performance and stability.","Floor / Rear Wing"],
        ["nose","Nose","aero",50,76,"Supports the front wing and guides airflow toward the chassis.","Front airflow quality.","Front Wing / Impact Structure"],
        ["sidepods","Sidepods","aero",34,50,"House cooling hardware while shaping airflow around the car.","Cooling and aerodynamic efficiency.","Floor / Power Unit"],
        ["ice","V6 Engine","power",50,33,"The combustion element of the 2024 hybrid power unit.","Mechanical power generation.","Turbo / MGU-K"],
        ["turbo","Turbocharger","power",59,27,"Uses exhaust energy to compress intake air.","Supports power from the compact V6.","V6 / Exhaust"],
        ["mgu-k","MGU-K","power",62,40,"Recovers braking energy and delivers electrical power.","Hybrid recovery and deployment.","Energy Store"],
        ["energy","Energy Store","power",38,43,"Stores high-voltage electrical energy for the hybrid system.","Energy availability for deployment.","MGU-K / Electronics"],
        ["electronics","Control Electronics","power",61,49,"Manage high-voltage energy flow.","Coordinates recovery and delivery.","Energy Store / MGU-K"],
        ["exhaust","Exhaust System","power",41,23,"Routes combustion gases through the turbo and rear outlet.","Turbo operation and gas management.","V6 / Turbo"],
        ["monocoque","Monocoque","chassis",41,62,"The carbon-fibre survival cell at the car's structural centre.","Stiffness and driver protection.","Cockpit / Halo"],
        ["halo","Halo","chassis",42,49,"Titanium frontal protection around the cockpit.","Protects the driver's head area.","Cockpit / Monocoque"],
        ["cockpit","Cockpit","chassis",59,56,"Positions the driver within the survival cell.","Control, visibility, and restraint.","Halo / Seat"],
        ["front-impact","Front Impact Structure","chassis",50,80,"Absorbs energy in a frontal collision.","Reduces loads toward the survival cell.","Nose / Monocoque"],
        ["rear-impact","Rear Impact Structure","chassis",50,16,"Provides energy absorption behind the gearbox.","Rear collision protection.","Gearbox / Chassis"],
        ["front-suspension","Front Suspension","suspension",40,76,"Controls front wheel movement and tyre contact.","Mechanical grip and platform control.","Front Wheels"],
        ["rear-suspension","Rear Suspension","suspension",60,24,"Connects rear wheel assemblies to the gearbox.","Traction and rear stability.","Rear Wheels"],
        ["brake-discs","Brake Discs","suspension",20,82,"Convert kinetic energy into heat through friction.","High deceleration capability.","Calipers / Ducts"],
        ["calipers","Brake Calipers","suspension",80,24,"Apply brake pads to the rotating discs.","Controlled braking force.","Brake Discs"],
        ["ducts","Brake Ducts","suspension",32,87,"Route cooling air toward braking components.","Temperature management.","Brakes / Wheels"],
        ["front-tyres","Front Tyres","wheels",23,80,"Transmit steering, braking, and cornering forces.","Front grip and response.","Front Suspension"],
        ["rear-tyres","Rear Tyres","wheels",77,20,"Transmit power while supporting braking and cornering.","Traction and rear stability.","Rear Suspension"],
        ["rims","Wheel Rims","wheels",66,17,"Support the tyres and connect to the hubs.","Consistent tyre operation.","Tyres / Hubs"],
        ["assembly","Wheel Assembly","wheels",34,86,"Combines tyre, rim, hub, and braking hardware.","Transfers loads between car and circuit.","Suspension / Brakes"],
      ].map((c,i)=>({id:c[0],name:c[1],system:c[2],x:c[3],y:c[4],summary:c[5],impact:c[6],related:c[7],index:i+1}))

  function renderAnatomy() {
    const currentSystem = systems.find((system) => system.id === activeSystem);
    const visible = components.filter((component) => component.system === activeSystem);
    $("#systemTabs").innerHTML = systems.map((system) => `<button type="button" class="${system.id === activeSystem ? "active" : ""}" data-system="${system.id}" aria-pressed="${system.id === activeSystem}"><span>${system.no}</span>${system.name}</button>`).join("");
    document.querySelectorAll("[data-system]").forEach((button) => button.addEventListener("click", () => {
      activeSystem = button.dataset.system;
      activeComponent = components.find((component) => component.system === activeSystem).id;
      renderAnatomy();
    }));
    $("#hotspots").innerHTML = visible.map((component) => `<button type="button" class="hotspot ${component.id === activeComponent ? "active" : ""}" style="left:${component.x}%;top:${component.y}%" data-component="${component.id}" aria-label="${escapeHTML(component.name)}" aria-pressed="${component.id === activeComponent}" title="${escapeHTML(component.name)}">${String(component.index).padStart(2, "0")}<span>${escapeHTML(component.name)}</span></button>`).join("");
    document.querySelectorAll("[data-component]").forEach((button) => button.addEventListener("click", () => { activeComponent = button.dataset.component; renderAnatomy(); }));
    const component = components.find((item) => item.id === activeComponent);
    const system = systems.find((item) => item.id === component.system);
    $("#componentDetail").innerHTML = `<div class="component-detail-top"><span>${escapeHTML(system.name)}</span><strong>${String(component.index).padStart(2, "0")}</strong></div><h3>${escapeHTML(component.name)}</h3><p>${escapeHTML(component.summary)}</p><div class="component-function"><small>WHAT IT DOES</small><p>${escapeHTML(component.impact)}</p></div><div class="component-nav"><button type="button" id="prevComponent">← Previous</button><button type="button" id="nextComponent">Next →</button></div>`;
    const move = (step) => {
      const index = components.findIndex((item) => item.id === activeComponent);
      const next = components[(index + step + components.length) % components.length];
      activeComponent = next.id;
      activeSystem = next.system;
      renderAnatomy();
    };
    $("#prevComponent").addEventListener("click", () => move(-1));
    $("#nextComponent").addEventListener("click", () => move(1));
  }

  renderFeatureTabs();
  renderAnatomy();
  initializeAnalysis();
})();
