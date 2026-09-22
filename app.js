const STYLE = "https://tiles.openfreemap.org/styles/dark";
const OSRM = "https://router.project-osrm.org/route/v1";
const PHOTON = "https://photon.komoot.io";

const state = {
  pos: { lng: -118.2437, lat: 34.0522 },
  heading: 0,
  speed: 0,
  follow: true,
  dest: null,
  route: null,
  profile: "driving",
  lastReverse: 0,
};

const $ = (id) => document.getElementById(id);

const map = new maplibregl.Map({
  container: "map",
  style: STYLE,
  center: [state.pos.lng, state.pos.lat],
  zoom: 13,
  pitch: 0,
  attributionControl: true,
});

const radar = new maplibregl.Map({
  container: "radar",
  style: STYLE,
  center: [state.pos.lng, state.pos.lat],
  zoom: 15.2,
  interactive: false,
  attributionControl: false,
  fadeDuration: 0,
});

const elBlip = document.createElement("div");
elBlip.className = "blip";
const blip = new maplibregl.Marker({ element: elBlip, rotationAlignment: "map" })
  .setLngLat([state.pos.lng, state.pos.lat])
  .addTo(map);

const elBlip2 = document.createElement("div");
elBlip2.className = "blip";
const blip2 = new maplibregl.Marker({ element: elBlip2, rotationAlignment: "map" })
  .setLngLat([state.pos.lng, state.pos.lat])
  .addTo(radar);

let wayMarker = null;

function restyle(m) {
  const style = m.getStyle();
  if (!style || !style.layers) return;
  for (const layer of style.layers) {
    const id = layer.id || "";
    if (id.includes("poi") || id.includes("housenumber")) {
      m.setLayoutProperty(id, "visibility", "none");
    }
    try {
      if (layer.type === "fill" && /water|ocean|river/.test(id)) {
        m.setPaintProperty(id, "fill-color", "#16343c");
      }
      if (layer.type === "line" && /motorway|trunk|primary/.test(id)) {
        if (m.getPaintProperty(id, "line-color") !== undefined) {
          m.setPaintProperty(id, "line-color", "#c9b48a");
        }
      }
    } catch (_) {}
  }
}

map.on("load", () => {
  restyle(map);
  map.addSource("route", {
    type: "geojson",
    data: { type: "FeatureCollection", features: [] },
  });
  map.addLayer({
    id: "route-glow",
    type: "line",
    source: "route",
    paint: { "line-color": "#5a1e80", "line-width": 12, "line-opacity": 0.35 },
    layout: { "line-cap": "round", "line-join": "round" },
  });
  map.addLayer({
    id: "route-line",
    type: "line",
    source: "route",
    paint: { "line-color": "#c56bff", "line-width": 5, "line-opacity": 0.95 },
    layout: { "line-cap": "round", "line-join": "round" },
  });
});
radar.on("load", () => restyle(radar));

map.on("dragstart", () => { state.follow = false; $("btn-follow").classList.remove("on"); });
map.on("click", (e) => { setDest(e.lngLat.lng, e.lngLat.lat); });

function setDest(lng, lat) {
  state.dest = { lng, lat };
  if (wayMarker) wayMarker.remove();
  const el = document.createElement("div");
  el.className = "way";
  wayMarker = new maplibregl.Marker({ element: el }).setLngLat([lng, lat]).addTo(map);
  routeTo();
}

async function routeTo() {
  if (!state.dest) return;
  const a = `${state.pos.lng},${state.pos.lat}`;
  const b = `${state.dest.lng},${state.dest.lat}`;
  $("maneuver-text").textContent = "ROUTING";
  try {
    const url = `${OSRM}/${state.profile}/${a};${b}?overview=full&geometries=geojson&steps=true`;
    const res = await fetch(url);
    const data = await res.json();
    const route = data.routes && data.routes[0];
    if (!route) throw new Error("no route");
    state.route = route;
    map.getSource("route")?.setData(route.geometry);
    paintHud();
  } catch (err) {
    $("maneuver-text").textContent = "NO ROUTE";
    $("maneuver-sub").textContent = "click another point";
  }
}

function clearDest() {
  state.dest = null;
  state.route = null;
  if (wayMarker) { wayMarker.remove(); wayMarker = null; }
  map.getSource("route")?.setData({ type: "FeatureCollection", features: [] });
  $("maneuver-text").textContent = "SET A POINT";
  $("maneuver-sub").textContent = "click the map · one destination";
  $("eta").textContent = "—";
  $("dist").textContent = "—";
}

function fmtKm(m) {
  if (m < 1000) return Math.round(m) + " m";
  return (m / 1000).toFixed(m > 10000 ? 0 : 1) + " km";
}
function fmtMi(m) {
  const miles = m / 1609.34;
  if (m < 400) return Math.round(m * 3.28084) + " ft";
  return miles.toFixed(miles >= 10 ? 0 : 1) + " mi";
}
function fmtTime(s) {
  if (s < 60) return "<1 min";
  if (s < 3600) return Math.round(s / 60) + " min";
  const h = Math.floor(s / 3600);
  const m = Math.round((s % 3600) / 60);
  return h + "h " + m + "m";
}

function modifierArrow(mod, type) {
  const t = (type || "") + " " + (mod || "");
  if (/uturn/.test(t)) return "U-TURN";
  if (/sharp right/.test(t)) return "HARD RIGHT";
  if (/sharp left/.test(t)) return "HARD LEFT";
  if (/slight right/.test(t)) return "BEAR RIGHT";
  if (/slight left/.test(t)) return "BEAR LEFT";
  if (/right/.test(t)) return "RIGHT";
  if (/left/.test(t)) return "LEFT";
  if (/arrive/.test(t)) return "ARRIVE";
  if (/roundabout/.test(t)) return "CIRCLE";
  return "AHEAD";
}

function paintHud() {
  const mph = state.speed ? state.speed * 2.23694 : 0;
  $("spd").textContent = mph < 0.8 ? "0" : Math.round(mph);
  if (!state.route) return;
  $("eta").textContent = fmtTime(state.route.duration);
  $("dist").textContent = fmtMi(state.route.distance);
  const step = state.route.legs?.[0]?.steps?.[0];
  if (step) {
    const name = step.name || "road";
    $("maneuver-text").textContent = modifierArrow(step.maneuver?.modifier, step.maneuver?.type);
    $("maneuver-sub").textContent = fmtMi(step.distance) + " · " + name;
  }
}

function applyPos() {
  blip.setLngLat([state.pos.lng, state.pos.lat]);
  blip.setRotation(state.heading);
  blip2.setLngLat([state.pos.lng, state.pos.lat]);
  blip2.setRotation(state.heading);
  radar.setCenter([state.pos.lng, state.pos.lat]);
  radar.setBearing(state.heading);
  if (state.follow) {
    map.setCenter([state.pos.lng, state.pos.lat]);
  }
  paintHud();
}

async function reverse(lng, lat) {
  try {
    const res = await fetch(`${PHOTON}/reverse?lon=${lng}&lat=${lat}`);
    const data = await res.json();
    const p = data.features?.[0]?.properties || {};
    const street = p.street || p.name || p.city || "unknown road";
    const city = p.city || p.county || p.state || "";
    $("street").textContent = street;
    $("place").textContent = city;
  } catch (_) {}
}

function watch() {
  if (!navigator.geolocation) return;
  navigator.geolocation.watchPosition(
    (fix) => {
      state.pos = { lng: fix.coords.longitude, lat: fix.coords.latitude };
      if (typeof fix.coords.heading === "number" && !Number.isNaN(fix.coords.heading)) {
        state.heading = fix.coords.heading;
      }
      state.speed = fix.coords.speed || 0;
      applyPos();
      const now = Date.now();
      if (now - state.lastReverse > 8000) {
        state.lastReverse = now;
        reverse(state.pos.lng, state.pos.lat);
      }
      if (state.dest) {
        const wait = state._lastRouteAt || 0;
        if (now - wait > 12000) {
          state._lastRouteAt = now;
          routeTo();
        }
      }
    },
    () => {},
    { enableHighAccuracy: true, maximumAge: 1000, timeout: 10000 }
  );
}

async function search(q) {
  const box = $("results");
  if (!q || q.length < 2) { box.style.display = "none"; box.innerHTML = ""; return; }
  const res = await fetch(`${PHOTON}/api/?q=${encodeURIComponent(q)}&limit=6`);
  const data = await res.json();
  const feats = data.features || [];
  box.innerHTML = feats.map((f, i) => {
    const p = f.properties || {};
    const label = [p.name, p.street, p.city, p.state, p.country].filter(Boolean).join(" · ");
    return `<button type="button" data-i="${i}">${label}</button>`;
  }).join("");
  box.style.display = feats.length ? "block" : "none";
  box.querySelectorAll("button").forEach((btn) => {
    btn.addEventListener("click", () => {
      const f = feats[+btn.dataset.i];
      const [lng, lat] = f.geometry.coordinates;
      setDest(lng, lat);
      map.flyTo({ center: [lng, lat], zoom: 14 });
      state.follow = false;
      $("btn-follow").classList.remove("on");
      box.style.display = "none";
      $("q").value = btn.textContent;
    });
  });
}

$("q").addEventListener("input", (e) => search(e.target.value.trim()));
$("q").addEventListener("keydown", (e) => {
  if (e.key === "Escape") $("results").style.display = "none";
  if (e.key === "Enter") {
    const first = $("results").querySelector("button");
    if (first) first.click();
  }
});

$("btn-follow").addEventListener("click", () => {
  state.follow = true;
  $("btn-follow").classList.add("on");
  map.easeTo({ center: [state.pos.lng, state.pos.lat], bearing: 0, duration: 400 });
});
$("btn-clear").addEventListener("click", clearDest);
$("btn-mode").addEventListener("click", () => {
  state.profile = state.profile === "driving" ? "foot" : "driving";
  $("btn-mode").textContent = state.profile === "driving" ? "CAR" : "FT";
  if (state.dest) routeTo();
});

watch();
reverse(state.pos.lng, state.pos.lat);
applyPos();
$("btn-follow").classList.add("on");
