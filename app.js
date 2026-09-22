const STYLE = "https://tiles.openfreemap.org/styles/dark";
const OSRM = "https://router.project-osrm.org";
const PHOTON = "https://photon.komoot.io";
const SAT = "https://services.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}";

const state = {
  pos: { lng: -118.2437, lat: 34.0522 },
  heading: 0, speed: 0, follow: true,
  dest: null, destName: "", route: null,
  profile: "driving", sat: false,
  lastReverse: 0, lastRouteAt: 0, gotFix: false,
};
const $ = (id) => document.getElementById(id);

const map = new maplibregl.Map({ container: "map", style: STYLE, center: [state.pos.lng, state.pos.lat], zoom: 13.2, attributionControl: true });
const radar = new maplibregl.Map({ container: "radar", style: STYLE, center: [state.pos.lng, state.pos.lat], zoom: 15.4, interactive: false, attributionControl: false, fadeDuration: 0 });

function makeBlip() {
  const el = document.createElement("div");
  el.className = "blip";
  return new maplibregl.Marker({ element: el, rotationAlignment: "map" }).setLngLat([state.pos.lng, state.pos.lat]);
}
const blip = makeBlip().addTo(map);
const blip2 = makeBlip().addTo(radar);
let wayMarker = null;

function hideClutter(m) {
  const style = m.getStyle();
  if (!style?.layers) return;
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
    m.addLayer({ id: "sat", type: "raster", source: "sat", paint: { "raster-saturation": -0.18, "raster-contrast": 0.12, "raster-brightness-min": 0.05 } }, first);
  }
}
function setSat(on) {
  state.sat = on;
  $("btn-sat").classList.toggle("on", on);
  for (const m of [map, radar]) {
    if (!m.isStyleLoaded()) continue;
    if (on) addSat(m);
    for (const layer of m.getStyle().layers) {
      const id = layer.id;
      if (id === "sat" || id.startsWith("route")) continue;
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
function addRouteLayers(m) {
  if (m.getSource("route")) return;
  m.addSource("route", { type: "geojson", data: emptyFC() });
  m.addLayer({ id: "route-glow", type: "line", source: "route", paint: { "line-color": "#4a176c", "line-width": 14, "line-opacity": 0.4 }, layout: { "line-cap": "round", "line-join": "round" } });
  m.addLayer({ id: "route-line", type: "line", source: "route", paint: { "line-color": "#d16cff", "line-width": 5, "line-opacity": 0.98 }, layout: { "line-cap": "round", "line-join": "round" } });
}
function onReady(m, fn) { if (m.isStyleLoaded()) fn(); else m.once("load", fn); }
onReady(map, () => { hideClutter(map); addRouteLayers(map); });
onReady(radar, () => { hideClutter(radar); addRouteLayers(radar); });

map.on("dragstart", () => { state.follow = false; $("btn-follow").classList.remove("on"); });
map.on("click", (e) => {
  if (e.originalEvent && e.originalEvent.target.closest(".tools, .search")) return;
  pin(e.lngLat.lng, e.lngLat.lat);
});

function haversine(a, b) {
  const R = 6371000, to = (d) => d * Math.PI / 180;
  const dLat = to(b.lat - a.lat), dLng = to(b.lng - a.lng);
  const s = Math.sin(dLat/2)**2 + Math.cos(to(a.lat))*Math.cos(to(b.lat))*Math.sin(dLng/2)**2;
  return 2 * R * Math.asin(Math.sqrt(s));
}
function minDistToLine(pos, coords) {
  let best = Infinity;
  for (const c of coords) {
    const d = haversine(pos, { lng: c[0], lat: c[1] });
    if (d < best) best = d;
  }
  return best;
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
  state.dest = snapped; state.destName = name || "";
  $("hint").classList.add("off");
  if (wayMarker) wayMarker.remove();
  const el = document.createElement("div"); el.className = "way";
  wayMarker = new maplibregl.Marker({ element: el }).setLngLat([snapped.lng, snapped.lat]).addTo(map);
  if (!name) reverseDest(snapped.lng, snapped.lat);
  await routeTo({ fit: true });
}
async function reverseDest(lng, lat) {
  try {
    const res = await fetch(`${PHOTON}/reverse?lon=${lng}&lat=${lat}`);
    const data = await res.json();
    const p = data.features?.[0]?.properties || {};
    state.destName = p.name || p.street || p.city || "";
    paintHud();
  } catch (_) {}
}
async function routeTo({ fit } = {}) {
  if (!state.dest) return;
  const a = `${state.pos.lng},${state.pos.lat}`;
  const b = `${state.dest.lng},${state.dest.lat}`;
  $("maneuver-text").textContent = "ROUTING";
  try {
    const res = await fetch(`${OSRM}/route/v1/${state.profile}/${a};${b}?overview=full&geometries=geojson&steps=true`);
    const data = await res.json();
    const route = data.routes && data.routes[0];
    if (!route) throw new Error("no route");
    state.route = route; state.lastRouteAt = Date.now();
    const geo = route.geometry;
    map.getSource("route")?.setData(geo);
    radar.getSource("route")?.setData(geo);
    if (fit && geo.coordinates?.length) {
      const bds = geo.coordinates.reduce((acc, c) => acc.extend(c), new maplibregl.LngLatBounds(geo.coordinates[0], geo.coordinates[0]));
      map.fitBounds(bds, { padding: { top: 90, bottom: 140, left: 40, right: 70 }, duration: 700, maxZoom: 15.5 });
      state.follow = false; $("btn-follow").classList.remove("on");
    }
    paintHud();
  } catch (_) {
    $("maneuver-text").textContent = "NO ROUTE";
    $("maneuver-sub").textContent = "try another point";
  }
}
function clearDest() {
  state.dest = null; state.destName = ""; state.route = null;
  if (wayMarker) { wayMarker.remove(); wayMarker = null; }
  map.getSource("route")?.setData(emptyFC());
  radar.getSource("route")?.setData(emptyFC());
  $("hint").classList.remove("off");
  $("maneuver-text").textContent = "NO WAYPOINT";
  $("maneuver-sub").textContent = "one destination. nothing else.";
  $("eta").textContent = "—"; $("dist").textContent = "—";
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
    const loc = steps[i].maneuver?.location;
    if (!loc) continue;
    const d = haversine(pos, { lng: loc[0], lat: loc[1] });
    if (d > 35 || i === steps.length - 1) return steps[i];
  }
  return steps.at(-1);
}
function paintHud() {
  const mph = state.speed ? state.speed * 2.23694 : 0;
  $("spd").textContent = mph < 0.8 ? "0" : String(Math.round(mph));
  $("rose").style.transform = `rotate(${-state.heading}deg)`;
  if (!state.route) return;
  $("eta").textContent = fmtTime(state.route.duration);
  $("dist").textContent = fmtMi(state.route.distance);
  const step = activeStep(state.route, state.pos);
  if (step) {
    $("maneuver-text").textContent = modifierArrow(step.maneuver?.modifier, step.maneuver?.type);
    const road = step.name || state.destName || "ROAD";
    $("maneuver-sub").textContent = `${fmtMi(step.distance)} · ${road}`;
  }
}
function applyPos() {
  blip.setLngLat([state.pos.lng, state.pos.lat]).setRotation(state.heading);
  blip2.setLngLat([state.pos.lng, state.pos.lat]).setRotation(state.heading);
  radar.setCenter([state.pos.lng, state.pos.lat]);
  radar.setBearing(state.heading);
  if (state.follow) map.setCenter([state.pos.lng, state.pos.lat]);
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
    if (typeof fix.coords.heading === "number" && !Number.isNaN(fix.coords.heading)) state.heading = fix.coords.heading;
    state.speed = fix.coords.speed || 0;
    if (!state.gotFix) {
      state.gotFix = true;
      map.easeTo({ center: [state.pos.lng, state.pos.lat], zoom: 14.2, duration: 800 });
    }
    applyPos();
    const now = Date.now();
    if (now - state.lastReverse > 7000) { state.lastReverse = now; reverseHere(state.pos.lng, state.pos.lat); }
    if (state.dest && state.route) {
      const off = minDistToLine(state.pos, state.route.geometry?.coordinates || []);
      if (off > 70 && now - state.lastRouteAt > 8000) routeTo();
    } else if (state.dest && now - state.lastRouteAt > 10000) routeTo();
  }, () => {}, { enableHighAccuracy: true, maximumAge: 800, timeout: 10000 });
}
let searchTimer = 0;
async function search(q) {
  const box = $("results");
  if (!q || q.length < 2) { box.style.display = "none"; box.innerHTML = ""; return; }
  const res = await fetch(`${PHOTON}/api/?q=${encodeURIComponent(q)}&limit=6`);
  const data = await res.json();
  const feats = data.features || [];
  box.innerHTML = feats.map((f, i) => {
    const p = f.properties || {};
    const label = [p.name, p.street, p.city, p.state].filter(Boolean).join(" · ");
    return `<button type="button" data-i="${i}">${label}</button>`;
  }).join("");
  box.style.display = feats.length ? "block" : "none";
  box.querySelectorAll("button").forEach((btn) => {
    btn.addEventListener("click", () => {
      const f = feats[+btn.dataset.i];
      const [lng, lat] = f.geometry.coordinates;
      const p = f.properties || {};
      pin(lng, lat, p.name || p.street || btn.textContent);
      box.style.display = "none";
      $("q").value = btn.textContent;
    });
  });
}
$("q").addEventListener("input", (e) => { clearTimeout(searchTimer); searchTimer = setTimeout(() => search(e.target.value.trim()), 160); });
$("q").addEventListener("keydown", (e) => {
  if (e.key === "Escape") $("results").style.display = "none";
  if (e.key === "Enter") $("results").querySelector("button")?.click();
});
window.addEventListener("keydown", (e) => {
  if (e.key === "/" && document.activeElement !== $("q")) { e.preventDefault(); $("q").focus(); }
});
$("btn-follow").addEventListener("click", () => {
  state.follow = true; $("btn-follow").classList.add("on");
  map.easeTo({ center: [state.pos.lng, state.pos.lat], bearing: 0, duration: 400 });
});
$("btn-clear").addEventListener("click", clearDest);
$("btn-mode").addEventListener("click", () => {
  state.profile = state.profile === "driving" ? "foot" : "driving";
  $("btn-mode").textContent = state.profile === "driving" ? "CAR" : "FT";
  if (state.dest) routeTo({ fit: true });
});
$("btn-sat").addEventListener("click", () => setSat(!state.sat));
watch();
reverseHere(state.pos.lng, state.pos.lat);
applyPos();
