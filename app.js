const STYLE = "https://tiles.openfreemap.org/styles/dark";
const OSRM = "https://router.project-osrm.org";
const PHOTON = "https://photon.komoot.io";
const SAT = "https://services.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}";
const state = {
  pos: { lng: -118.2437, lat: 34.0522 }, heading: 0, speed: 0,
  follow: true, cam: false, sat: false, voice: false,
  dest: null, destName: "", routes: [], routeIndex: 0, route: null,
  profile: "driving", lastReverse: 0, lastRouteAt: 0, gotFix: false,
  lastSpoken: "", arrived: false,
};
const $ = (id) => document.getElementById(id);
const map = new maplibregl.Map({ container: "map", style: STYLE, center: [state.pos.lng, state.pos.lat], zoom: 13.2, attributionControl: true });
const radar = new maplibregl.Map({ container: "radar", style: STYLE, center: [state.pos.lng, state.pos.lat], zoom: 15.4, interactive: false, attributionControl: false, fadeDuration: 0 });
function makeBlip() {
  const el = document.createElement("div"); el.className = "blip";
  return new maplibregl.Marker({ element: el, rotationAlignment: "map" }).setLngLat([state.pos.lng, state.pos.lat]);
}
const blip = makeBlip().addTo(map);
const blip2 = makeBlip().addTo(radar);
let wayMarker = null;
function hideClutter(m) {
  const style = m.getStyle(); if (!style?.layers) return;
  for (const layer of style.layers) {
    const id = layer.id || "";
    if (/poi|housenumber|airport/.test(id)) { try { m.setLayoutProperty(id, "visibility", "none"); } catch (_) {} }
    try {
      if (layer.type === "fill" && /water|ocean|river/.test(id)) m.setPaintProperty(id, "fill-color", "#14343c");
      if (layer.type === "line" && /motorway|trunk|primary/.test(id) && m.getPaintProperty(id, "line-color") !== undefined) m.setPaintProperty(id, "line-color", "#d2c09a");
    } catch (_) {}
  }
}
function addSat(m) {
  if (!m.getSource("sat")) m.addSource("sat", { type: "raster", tiles: [SAT], tileSize: 256, maxzoom: 19, attribution: "Esri" });
  if (!m.getLayer("sat")) {
    const first = m.getStyle().layers[0]?.id;
    m.addLayer({ id: "sat", type: "raster", source: "sat", paint: { "raster-saturation": -0.2, "raster-contrast": 0.14, "raster-brightness-min": 0.04 } }, first);
  }
}
function setSat(on) {
  state.sat = on; $("btn-sat").classList.toggle("on", on);
  for (const m of [map, radar]) {
    if (!m.isStyleLoaded()) continue;
    if (on) addSat(m);
    for (const layer of m.getStyle().layers) {
      const id = layer.id;
      if (id === "sat" || id.startsWith("route") || id === "done-line") continue;
      const hideFill = on && (layer.type === "fill" || layer.type === "fill-extrusion" || (layer.type === "line" && /transport|road|bridge|tunnel|aeroway/.test(id)));
      try {
        if (hideFill) m.setLayoutProperty(id, "visibility", "none");
        else if (layer.type !== "raster") {
          if (/poi|housenumber/.test(id)) m.setLayoutProperty(id, "visibility", "none");
          else m.setLayoutProperty(id, "visibility", "visible");
        }
      } catch (_) {}
    }
    if (m.getLayer("sat")) m.setLayoutProperty("sat", "visibility", on ? "visible" : "none");
  }
}
function emptyFC() { return { type: "FeatureCollection", features: [] }; }
function lineFC(coords) { return { type: "Feature", geometry: { type: "LineString", coordinates: coords } }; }
function addRouteLayers(m) {
  if (m.getSource("route")) return;
  m.addSource("route", { type: "geojson", data: emptyFC() });
  m.addSource("done", { type: "geojson", data: emptyFC() });
  m.addLayer({ id: "done-line", type: "line", source: "done", paint: { "line-color": "#6a5a78", "line-width": 4, "line-opacity": 0.45 }, layout: { "line-cap": "round", "line-join": "round" } });
  m.addLayer({ id: "route-glow", type: "line", source: "route", paint: { "line-color": "#4a176c", "line-width": 14, "line-opacity": 0.4 }, layout: { "line-cap": "round", "line-join": "round" } });
  m.addLayer({ id: "route-line", type: "line", source: "route", paint: { "line-color": "#d16cff", "line-width": 5, "line-opacity": 0.98 }, layout: { "line-cap": "round", "line-join": "round" } });
}
function onReady(m, fn) { if (m.isStyleLoaded()) fn(); else m.once("load", fn); }
onReady(map, () => { hideClutter(map); addRouteLayers(map); bootHash(); });
onReady(radar, () => { hideClutter(radar); addRouteLayers(radar); });
map.on("dragstart", () => { state.follow = false; state.cam = false; $("btn-follow").classList.remove("on"); $("btn-cam").classList.remove("on"); });
map.on("click", (e) => {
  if (e.originalEvent && e.originalEvent.target.closest(".tools, .search, .radar-wrap")) return;
  pin(e.lngLat.lng, e.lngLat.lat);
});
function haversine(a, b) {
  const R = 6371000, to = (d) => d * Math.PI / 180;
  const dLat = to(b.lat - a.lat), dLng = to(b.lng - a.lng);
  const s = Math.sin(dLat / 2) ** 2 + Math.cos(to(a.lat)) * Math.cos(to(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(s));
}
function lineLength(coords) {
  let n = 0;
  for (let i = 1; i < coords.length; i++) n += haversine({ lng: coords[i-1][0], lat: coords[i-1][1] }, { lng: coords[i][0], lat: coords[i][1] });
  return n;
}
function nearestIndex(coords, pos) {
  let best = 0, d = Infinity;
  for (let i = 0; i < coords.length; i++) {
    const x = haversine(pos, { lng: coords[i][0], lat: coords[i][1] });
    if (x < d) { d = x; best = i; }
  }
  return { i: best, d };
}
async function snap(lng, lat) {
  try {
    const res = await fetch(`${OSRM}/nearest/v1/${state.profile}/${lng},${lat}`);
    const data = await res.json();
    const wp = data.waypoints && data.waypoints[0];
    if (wp) return { lng: wp.location[0], lat: wp.location[1] };
  } catch (_) {}
  return { lng, lat };
}
async function pin(lng, lat, name) {
  const snapped = await snap(lng, lat);
  state.dest = snapped; state.destName = name || ""; state.arrived = false;
  $("arrive").classList.remove("on"); $("hint").classList.add("off");
  if (wayMarker) wayMarker.remove();
  const el = document.createElement("div"); el.className = "way";
  wayMarker = new maplibregl.Marker({ element: el }).setLngLat([snapped.lng, snapped.lat]).addTo(map);
  if (!name) reverseDest(snapped.lng, snapped.lat);
  writeHash();
  try { localStorage.setItem("los-dest", JSON.stringify({ ...snapped, name: state.destName })); } catch (_) {}
  await routeTo({ fit: !state.cam });
}
async function reverseDest(lng, lat) {
  try {
    const res = await fetch(`${PHOTON}/reverse?lon=${lng}&lat=${lat}`);
    const data = await res.json();
    const p = data.features?.[0]?.properties || {};
    state.destName = p.name || p.street || p.city || "";
    writeHash(); paintHud();
  } catch (_) {}
}
async function routeTo({ fit } = {}) {
  if (!state.dest) return;
  const a = `${state.pos.lng},${state.pos.lat}`;
  const b = `${state.dest.lng},${state.dest.lat}`;
  $("maneuver-text").textContent = "ROUTING";
  try {
    const res = await fetch(`${OSRM}/route/v1/${state.profile}/${a};${b}?overview=full&geometries=geojson&steps=true&alternatives=true`);
    const data = await res.json();
    const routes = data.routes || [];
    if (!routes.length) throw new Error("no route");
    state.routes = routes;
    if (state.routeIndex >= routes.length) state.routeIndex = 0;
    applyRoute(routes[state.routeIndex], { fit });
  } catch (_) {
    $("maneuver-text").textContent = "NO ROUTE";
    $("maneuver-sub").textContent = "try another point";
  }
}
function applyRoute(route, { fit } = {}) {
  state.route = route; state.lastRouteAt = Date.now(); paintRouteProgress();
  if (fit && route.geometry?.coordinates?.length) {
    const coords = route.geometry.coordinates;
    const bds = coords.reduce((acc, c) => acc.extend(c), new maplibregl.LngLatBounds(coords[0], coords[0]));
    map.fitBounds(bds, { padding: { top: 90, bottom: 140, left: 40, right: 70 }, duration: 700, maxZoom: 15.5 });
    state.follow = false; $("btn-follow").classList.remove("on");
  }
  paintHud();
}
function paintRouteProgress() {
  if (!state.route?.geometry?.coordinates) return;
  const coords = state.route.geometry.coordinates;
  const near = nearestIndex(coords, state.pos);
  const done = coords.slice(0, Math.max(1, near.i + 1));
  const left = coords.slice(near.i);
  map.getSource("done")?.setData(lineFC(done));
  map.getSource("route")?.setData(lineFC(left.length > 1 ? left : coords.slice(-2)));
  radar.getSource("route")?.setData(lineFC(left.length > 1 ? left : coords));
}
function clearDest() {
  state.dest = null; state.destName = ""; state.route = null; state.routes = [];
  state.arrived = false; state.lastSpoken = "";
  if (wayMarker) { wayMarker.remove(); wayMarker = null; }
  map.getSource("route")?.setData(emptyFC());
  map.getSource("done")?.setData(emptyFC());
  radar.getSource("route")?.setData(emptyFC());
  $("hint").classList.remove("off"); $("arrive").classList.remove("on");
  $("maneuver-text").textContent = "NO WAYPOINT";
  $("maneuver-sub").textContent = "one destination. nothing else.";
  $("eta").textContent = "—"; $("dist").textContent = "—";
  history.replaceState(null, "", location.pathname);
  try { localStorage.removeItem("los-dest"); } catch (_) {}
}
function fmtMi(m) {
  if (m < 400) return Math.round(m * 3.28084) + " FT";
  const miles = m / 1609.34;
  return miles.toFixed(miles >= 10 ? 0 : 1) + " MI";
}
function fmtTime(s) {
  if (s < 60) return "<1 MIN";
  if (s < 3600) return Math.round(s / 60) + " MIN";
  return Math.floor(s / 3600) + "H " + Math.round((s % 3600) / 60) + "M";
}
function modifierArrow(mod, type) {
  const t = `${type || ""} ${mod || ""}`.toLowerCase();
  if (t.includes("uturn")) return "U-TURN";
  if (t.includes("sharp right")) return "HARD RIGHT";
  if (t.includes("sharp left")) return "HARD LEFT";
  if (t.includes("slight right")) return "BEAR RIGHT";
  if (t.includes("slight left")) return "BEAR LEFT";
  if (t.includes("right")) return "RIGHT";
  if (t.includes("left")) return "LEFT";
  if (t.includes("arrive")) return "ARRIVE";
  if (t.includes("roundabout") || t.includes("rotary")) return "CIRCLE";
  return "AHEAD";
}
function activeStep(route, pos) {
  const steps = route.legs?.[0]?.steps || [];
  if (!steps.length) return null;
  for (let i = 0; i < steps.length; i++) {
    const loc = steps[i].maneuver?.location; if (!loc) continue;
    if (haversine(pos, { lng: loc[0], lat: loc[1] }) > 40 || i === steps.length - 1) return steps[i];
  }
  return steps.at(-1);
}
function speak(text) {
  if (!state.voice || !window.speechSynthesis) return;
  if (text === state.lastSpoken) return;
  state.lastSpoken = text;
  speechSynthesis.cancel();
  const u = new SpeechSynthesisUtterance(text.toLowerCase());
  u.rate = 1.05; u.pitch = 0.95; speechSynthesis.speak(u);
}
function paintHud() {
  const mph = state.speed ? state.speed * 2.23694 : 0;
  $("spd").textContent = mph < 0.8 ? "0" : String(Math.round(mph));
  $("rose").style.transform = `rotate(${-state.heading}deg)`;
  if (!state.route) return;
  const coords = state.route.geometry?.coordinates || [];
  const left = coords.slice(nearestIndex(coords, state.pos).i);
  const remainM = left.length > 1 ? lineLength(left) : state.route.distance;
  const frac = state.route.distance ? remainM / state.route.distance : 1;
  $("eta").textContent = fmtTime(state.route.duration * frac);
  $("dist").textContent = fmtMi(remainM);
  const step = activeStep(state.route, state.pos);
  if (step) {
    const call = modifierArrow(step.maneuver?.modifier, step.maneuver?.type);
    const road = step.name || state.destName || "ROAD";
    $("maneuver-text").textContent = call;
    $("maneuver-sub").textContent = `${fmtMi(step.distance)} · ${road}`;
    speak(`${call} ${step.distance < 400 ? "soon" : ""} ${road}`);
  }
  if (state.dest && haversine(state.pos, state.dest) < 35 && !state.arrived) {
    state.arrived = true; $("arrive").classList.add("on");
    $("maneuver-text").textContent = "ARRIVE"; speak("arrived");
  }
}
function applyPos() {
  blip.setLngLat([state.pos.lng, state.pos.lat]).setRotation(state.heading);
  blip2.setLngLat([state.pos.lng, state.pos.lat]).setRotation(state.heading);
  radar.setCenter([state.pos.lng, state.pos.lat]); radar.setBearing(state.heading);
  if (state.cam) {
    map.jumpTo({ center: [state.pos.lng, state.pos.lat], bearing: state.heading, pitch: 55, zoom: Math.max(map.getZoom(), 16) });
  } else if (state.follow) {
    map.setCenter([state.pos.lng, state.pos.lat]);
    if (map.getPitch() > 5) map.setPitch(0);
    if (Math.abs(map.getBearing()) > 2) map.setBearing(0);
  }
  if (state.route) paintRouteProgress();
  paintHud();
}
async function reverseHere(lng, lat) {
  try {
    const res = await fetch(`${PHOTON}/reverse?lon=${lng}&lat=${lat}`);
    const data = await res.json();
    const p = data.features?.[0]?.properties || {};
    $("street").textContent = p.street || p.name || p.city || "unknown road";
    $("place").textContent = [p.city, p.state].filter(Boolean).join(" · ") || "";
  } catch (_) {}
}
function watch() {
  if (!navigator.geolocation) return;
  navigator.geolocation.watchPosition((fix) => {
    state.pos = { lng: fix.coords.longitude, lat: fix.coords.latitude };
    if (typeof fix.coords.heading === "number" && !Number.isNaN(fix.coords.heading) && fix.coords.speed > 1) state.heading = fix.coords.heading;
    state.speed = fix.coords.speed || 0;
    if (!state.gotFix) { state.gotFix = true; map.easeTo({ center: [state.pos.lng, state.pos.lat], zoom: 14.2, duration: 800 }); }
    applyPos();
    const now = Date.now();
    if (now - state.lastReverse > 7000) { state.lastReverse = now; reverseHere(state.pos.lng, state.pos.lat); }
    if (state.dest && state.route) {
      const off = nearestIndex(state.route.geometry?.coordinates || [], state.pos).d;
      if (off > 80 && now - state.lastRouteAt > 8000) routeTo();
    }
  }, () => {}, { enableHighAccuracy: true, maximumAge: 600, timeout: 10000 });
}
function enableCompass() {
  const apply = (heading) => {
    if (typeof heading === "number" && !Number.isNaN(heading) && (state.speed || 0) < 1.2) { state.heading = heading; applyPos(); }
  };
  const onOrient = (e) => {
    if (typeof e.webkitCompassHeading === "number") apply(e.webkitCompassHeading);
    else if (typeof e.alpha === "number") apply((360 - e.alpha) % 360);
  };
  if (window.DeviceOrientationEvent && DeviceOrientationEvent.requestPermission) {
    DeviceOrientationEvent.requestPermission().then((s) => { if (s === "granted") window.addEventListener("deviceorientation", onOrient, true); }).catch(() => {});
  } else {
    window.addEventListener("deviceorientationabsolute", onOrient, true);
    window.addEventListener("deviceorientation", onOrient, true);
  }
}
let searchTimer = 0;
async function search(q) {
  const box = $("results");
  if (!q || q.length < 2) { box.style.display = "none"; box.innerHTML = ""; return; }
  const res = await fetch(`${PHOTON}/api/?q=${encodeURIComponent(q)}&limit=6&lat=${state.pos.lat}&lon=${state.pos.lng}`);
  const data = await res.json();
  const feats = data.features || [];
  box.innerHTML = feats.map((f, i) => {
    const p = f.properties || {};
    return `<button type="button" data-i="${i}">${[p.name, p.street, p.city, p.state].filter(Boolean).join(" · ")}</button>`;
  }).join("");
  box.style.display = feats.length ? "block" : "none";
  box.querySelectorAll("button").forEach((btn) => {
    btn.addEventListener("click", () => {
      const f = feats[+btn.dataset.i]; const [lng, lat] = f.geometry.coordinates; const p = f.properties || {};
      pin(lng, lat, p.name || p.street || btn.textContent);
      box.style.display = "none"; $("q").value = btn.textContent;
    });
  });
}
function writeHash() {
  if (!state.dest) return;
  history.replaceState(null, "", `#${state.dest.lat.toFixed(5)},${state.dest.lng.toFixed(5)},${encodeURIComponent(state.destName || "")}`);
}
function bootHash() {
  const raw = decodeURIComponent((location.hash || "").replace(/^#/, ""));
  if (raw) {
    const [lat, lng, ...rest] = raw.split(",");
    if (lat && lng) pin(parseFloat(lng), parseFloat(lat), rest.join(",") || "");
    return;
  }
  try {
    const saved = JSON.parse(localStorage.getItem("los-dest") || "null");
    if (saved?.lat && saved?.lng) pin(saved.lng, saved.lat, saved.name || "");
  } catch (_) {}
}
$("q").addEventListener("input", (e) => { clearTimeout(searchTimer); searchTimer = setTimeout(() => search(e.target.value.trim()), 160); });
$("q").addEventListener("keydown", (e) => {
  if (e.key === "Escape") $("results").style.display = "none";
  if (e.key === "Enter") $("results").querySelector("button")?.click();
});
window.addEventListener("keydown", (e) => {
  if (e.key === "/" && document.activeElement !== $("q")) { e.preventDefault(); $("q").focus(); }
  if (e.key === "Escape") clearDest();
});
$("btn-follow").addEventListener("click", () => {
  state.follow = true; state.cam = false;
  $("btn-follow").classList.add("on"); $("btn-cam").classList.remove("on");
  map.easeTo({ center: [state.pos.lng, state.pos.lat], bearing: 0, pitch: 0, duration: 400 });
  enableCompass();
});
$("btn-cam").addEventListener("click", () => {
  state.cam = !state.cam; state.follow = state.cam;
  $("btn-cam").classList.toggle("on", state.cam);
  $("btn-follow").classList.toggle("on", state.follow);
  enableCompass(); applyPos();
});
$("btn-clear").addEventListener("click", clearDest);
$("btn-mode").addEventListener("click", () => {
  state.profile = state.profile === "driving" ? "foot" : "driving";
  $("btn-mode").textContent = state.profile === "driving" ? "CAR" : "FT";
  if (state.dest) routeTo({ fit: true });
});
$("btn-sat").addEventListener("click", () => setSat(!state.sat));
$("btn-voice").addEventListener("click", () => {
  state.voice = !state.voice; $("btn-voice").classList.toggle("on", state.voice);
  if (state.voice) speak("voice on");
});
$("btn-alt").addEventListener("click", () => {
  if (state.routes.length < 2) return;
  state.routeIndex = (state.routeIndex + 1) % state.routes.length;
  applyRoute(state.routes[state.routeIndex], { fit: true });
});
$("btn-in").addEventListener("click", () => map.zoomIn({ duration: 200 }));
$("btn-out").addEventListener("click", () => map.zoomOut({ duration: 200 }));
$("btn-share").addEventListener("click", async () => {
  writeHash();
  try { await navigator.clipboard.writeText(location.href); $("btn-share").textContent = "OK"; }
  catch (_) { $("btn-share").textContent = "#"; }
  setTimeout(() => { $("btn-share").textContent = "LNK"; }, 900);
});
$("radar-wrap").addEventListener("click", () => $("btn-follow").click());
watch();
reverseHere(state.pos.lng, state.pos.lat);
applyPos();
