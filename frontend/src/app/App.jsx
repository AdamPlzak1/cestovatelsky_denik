import React, { useState, useEffect, useRef, useCallback, useMemo } from "react";
import { createClient } from "@supabase/supabase-js";
import {
  Plus, ChevronLeft, Camera, X, Play, Pause, MapPin,
  SkipBack, SkipForward, Music, Trash2, Calendar, Search, Loader2, Route as RouteIcon,
  Plane, Car, Bike, Footprints, Ship, ChevronUp, ChevronDown, Utensils, Sparkles, Star,
  ExternalLink, Pencil, RefreshCw, Share2
} from "lucide-react";

// ---------------------------------------------------------------------
// Cestovatelský deník
// Výlety → dny → pojmenované zastávky na skutečné mapě → fotky
// přiřazené ke konkrétní zastávce. Prezentace prochází: mapa dne →
// každá zastávka se svou mapou → její fotky → další zastávka…
//
// Data se ukládají přímo do vyhrazeného Supabase projektu (samostatný
// od Fapalixu) přes jeho REST API — přežije zavření appky i telefonu.
// Hudba k prezentaci se nahrává čerstvě při každém spuštění (zvukové
// soubory jsou moc velké na trvalé uložení).
// ---------------------------------------------------------------------

const PALETTE = {
  ink: "#1F2A44",
  paper: "#E9EFEA",
  paperDeep: "#DCE6DF",
  coral: "#D9622B",
  gold: "#B98A32",
  teal: "#2F6E64",
  cream: "#F4EFE3",
};

const SUPABASE_URL = "https://pevddyppgihtgwxvcrfp.supabase.co";
const SUPABASE_ANON_KEY =
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InBldmRkeXBwZ2lodGd3eHZjcmZwIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODcxNjgxMjAsImV4cCI6MjEwMjc0NDEyMH0.53gXWQr6L3l7QIRf9SIf2qgc6HmaWlg6xR-l1HMpqm0";

async function sb(path, options = {}) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    ...options,
    headers: {
      apikey: SUPABASE_ANON_KEY,
      Authorization: `Bearer ${SUPABASE_ANON_KEY}`,
      "Content-Type": "application/json",
      Prefer: options.prefer || "return=representation",
      ...(options.headers || {}),
    },
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Supabase ${res.status}: ${text}`);
  }
  if (res.status === 204) return null;
  const text = await res.text();
  return text ? JSON.parse(text) : null;
}

const STORAGE_BUCKET = "trip-photos";

// Nahraje fotku (Blob) do Supabase Storage a vrátí veřejnou URL. V databázi
// se pak ukládá jen tahle krátká URL, ne obsah fotky — šetří to přenos dat
// (Egress) při každém načtení i realtime aktualizaci.
async function uploadPhotoBlob(blob, path) {
  const res = await fetch(`${SUPABASE_URL}/storage/v1/object/${STORAGE_BUCKET}/${path}`, {
    method: "POST",
    headers: {
      apikey: SUPABASE_ANON_KEY,
      Authorization: `Bearer ${SUPABASE_ANON_KEY}`,
      "Content-Type": blob.type || "image/jpeg",
      "x-upsert": "true",
    },
    body: blob,
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Nahrání fotky selhalo: ${res.status} ${text}`);
  }
  return `${SUPABASE_URL}/storage/v1/object/public/${STORAGE_BUCKET}/${path}`;
}

// Nejlepší snaha o smazání souboru ze Storage (nekritické — pokud selže,
// jen zůstane osamocený soubor, appka na to nijak nezávisí).
function deletePhotoFromStorage(url) {
  const prefix = `${SUPABASE_URL}/storage/v1/object/public/${STORAGE_BUCKET}/`;
  if (!url || !url.startsWith(prefix)) return;
  const path = url.slice(prefix.length);
  fetch(`${SUPABASE_URL}/storage/v1/object/${STORAGE_BUCKET}/${path}`, {
    method: "DELETE",
    headers: { apikey: SUPABASE_ANON_KEY, Authorization: `Bearer ${SUPABASE_ANON_KEY}` },
  }).catch(() => {});
}

// Klient jen pro realtime odběr změn (CRUD operace jedou přes sb() výše).
const supabaseClient = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

// Lokální "upsert"/"remove" pro pole podle id — používá se při zpracování
// realtime zpráv, ať appka nemusí po každé změně nic znovu stahovat.
function upsertById(arr, item) {
  const idx = arr.findIndex((x) => x.id === item.id);
  if (idx === -1) return [...arr, item];
  const next = [...arr];
  next[idx] = { ...next[idx], ...item };
  return next;
}
function removeById(arr, id) {
  return arr.filter((x) => x.id !== id);
}

function uid() {
  return Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
}

function todayISO() {
  return new Date().toISOString().slice(0, 10);
}

function formatDateCz(iso) {
  if (!iso) return "";
  const [y, m, d] = iso.split("-");
  return `${d}. ${m}. ${y}`;
}

function formatRangeCz(startISO, endISO) {
  if (!startISO) return "Bez data";
  if (!endISO || endISO === startISO) return formatDateCz(startISO);
  return `${formatDateCz(startISO)} – ${formatDateCz(endISO)}`;
}

// Zmenší a zkomprimuje fotku na rozumnou velikost a vrátí ji jako Blob
// (nahraje se do Supabase Storage — v databázi zůstává jen krátký odkaz).
function compressImage(file, maxDim = 1000, quality = 0.72) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const img = new Image();
      img.onload = () => {
        let { width, height } = img;
        if (width > height && width > maxDim) {
          height = Math.round((height * maxDim) / width);
          width = maxDim;
        } else if (height > maxDim) {
          width = Math.round((width * maxDim) / height);
          height = maxDim;
        }
        const canvas = document.createElement("canvas");
        canvas.width = width;
        canvas.height = height;
        const ctx = canvas.getContext("2d");
        ctx.drawImage(img, 0, 0, width, height);
        canvas.toBlob((blob) => (blob ? resolve(blob) : reject(new Error("toBlob selhalo"))), "image/jpeg", quality);
      };
      img.onerror = reject;
      img.src = reader.result;
    };
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

const TRANSPORT_ICONS = { plane: Plane, car: Car, bike: Bike, walk: Footprints, boat: Ship };
const TRANSPORT_EMOJI = { plane: "✈️", car: "🚗", bike: "🚲", walk: "🚶", boat: "⛵" };
const TRANSPORT_OPTIONS = [
  { value: "car", label: "Auto" },
  { value: "plane", label: "Letadlo" },
  { value: "bike", label: "Kolo" },
  { value: "walk", label: "Pěšky" },
  { value: "boat", label: "Loď" },
];

// -------------------- Stamp badge (signature element) ------------------

function StampBadge({ label, color = PALETTE.coral, size = 64 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 100 100" style={{ flexShrink: 0 }}>
      <circle cx="50" cy="50" r="44" fill="none" stroke={color} strokeWidth="2.5" strokeDasharray="4 3" />
      <circle cx="50" cy="50" r="36" fill="none" stroke={color} strokeWidth="1.2" />
      <text
        x="50" y="55" textAnchor="middle"
        fontSize="11" fontWeight="700" fill={color}
        style={{ fontFamily: "'Fraunces', serif", letterSpacing: "0.5px" }}
      >
        {label}
      </text>
    </svg>
  );
}

function StopBadge({ index, total, size = 24, kind = "stop", transport }) {
  const color = index === 0 ? PALETTE.teal : index === total - 1 ? PALETTE.coral : PALETTE.gold;
  const TransportIcon = kind === "route" ? (TRANSPORT_ICONS[transport] || RouteIcon) : null;
  return (
    <div style={{
      width: size, height: size, borderRadius: "50%", background: color, color: "#fff",
      display: "flex", alignItems: "center", justifyContent: "center",
      fontSize: size * 0.46, fontWeight: 700, flexShrink: 0,
    }}>
      {kind === "route" ? <TransportIcon size={size * 0.55} /> : index + 1}
    </div>
  );
}

// -------------------- Route map (real map via Leaflet / OpenStreetMap) --

const LEAFLET_CSS = "https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/leaflet.min.css";
const LEAFLET_JS = "https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/leaflet.min.js";

function loadLeaflet() {
  if (window.L) return Promise.resolve(window.L);
  if (window.__leafletLoadingPromise) return window.__leafletLoadingPromise;
  window.__leafletLoadingPromise = new Promise((resolve, reject) => {
    if (!document.querySelector(`link[href="${LEAFLET_CSS}"]`)) {
      const link = document.createElement("link");
      link.rel = "stylesheet";
      link.href = LEAFLET_CSS;
      document.head.appendChild(link);
    }
    const script = document.createElement("script");
    script.src = LEAFLET_JS;
    script.onload = () => resolve(window.L);
    script.onerror = () => reject(new Error("Leaflet se nepodařilo načíst"));
    document.head.appendChild(script);
  });
  return window.__leafletLoadingPromise;
}

async function geocodePlace(query) {
  const url = `https://nominatim.openstreetmap.org/search?format=json&limit=5&q=${encodeURIComponent(query)}`;
  const res = await fetch(url, { headers: { Accept: "application/json" } });
  if (!res.ok) throw new Error("Vyhledávání se nezdařilo");
  return res.json();
}

// Rozbalí položky dne (zastávka = 1 bod, cesta = 2 body odkud/kam) na
// plochý seznam geografických bodů pro vykreslení na mapě.
function flattenToGeoDots(points) {
  const dots = [];
  points.forEach((p) => {
    if (p.kind === "route" && p.toLat != null && p.toLng != null) {
      dots.push({ id: `${p.id}:from`, ownerId: p.id, lat: p.lat, lng: p.lng, label: p.label });
      dots.push({ id: `${p.id}:to`, ownerId: p.id, lat: p.toLat, lng: p.toLng, label: p.toLabel });
    } else {
      dots.push({ id: p.id, ownerId: p.id, lat: p.lat, lng: p.lng, label: p.label });
    }
  });
  return dots;
}

/**
 * points: [{ id, kind: 'stop'|'route', lat, lng, label, toLat?, toLng?, toLabel? }]
 * onAddPoint({lat,lng,label}): voláno při klepnutí na mapu nebo výběru z vyhledávání
 * focusItemId: zúží a vycentruje mapu na danou položku (u cesty na oba její body), ostatní ztlumí
 * showLabelsAlways: trvalé popisky u všech pojmenovaných bodů
 */
function RouteMap({ points, onAddPoint, editable, height = 220, focusItemId = null, showLabelsAlways = false }) {
  const containerRef = useRef(null);
  const mapRef = useRef(null);
  const layerRef = useRef(null);
  const [ready, setReady] = useState(false);
  const [mapError, setMapError] = useState(false);
  const [query, setQuery] = useState("");
  const [results, setResults] = useState([]);
  const [searching, setSearching] = useState(false);

  const onAddPointRef = useRef(onAddPoint);
  onAddPointRef.current = onAddPoint;

  const geoDots = flattenToGeoDots(points);

  useEffect(() => {
    let cancelled = false;
    loadLeaflet()
      .then((L) => {
        if (cancelled || !containerRef.current || mapRef.current) return;
        const start = geoDots[0] ? [geoDots[0].lat, geoDots[0].lng] : [49.82, 15.47];
        const map = L.map(containerRef.current, {
          zoomControl: editable,
          scrollWheelZoom: editable,
          dragging: true,
          tap: true,
        }).setView(start, geoDots.length ? 12 : 7);

        L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
          maxZoom: 19,
          attribution: "© OpenStreetMap",
        }).addTo(map);

        layerRef.current = L.layerGroup().addTo(map);
        mapRef.current = map;

        if (editable) {
          map.on("click", (e) => {
            onAddPointRef.current?.({ lat: e.latlng.lat, lng: e.latlng.lng, label: "" });
          });
        }
        setReady(true);
        setTimeout(() => map.invalidateSize(), 150);
      })
      .catch(() => setMapError(true));

    return () => {
      cancelled = true;
      if (mapRef.current) {
        mapRef.current.remove();
        mapRef.current = null;
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (!ready || !mapRef.current || !window.L) return;
    const L = window.L;
    layerRef.current.clearLayers();

    if (geoDots.length > 0) {
      if (geoDots.length > 1) {
        const latlngs = geoDots.map((d) => [d.lat, d.lng]);
        L.polyline(latlngs, { color: PALETTE.coral, weight: 3, dashArray: "1 8", lineCap: "round" }).addTo(layerRef.current);
      }

      geoDots.forEach((d, i) => {
        const isFocused = focusItemId === d.ownerId;
        const isDimmed = focusItemId && !isFocused;
        const baseColor = i === 0 ? PALETTE.teal : i === geoDots.length - 1 ? PALETTE.coral : PALETTE.gold;

        const marker = L.circleMarker([d.lat, d.lng], {
          radius: isFocused ? 10 : isDimmed ? 4 : 6,
          weight: isFocused ? 3 : 2,
          color: "#fff",
          fillColor: baseColor,
          fillOpacity: isDimmed ? 0.35 : 1,
        }).addTo(layerRef.current);

        if (d.label && (isFocused || showLabelsAlways)) {
          marker.bindTooltip(d.label, { permanent: true, direction: "top", offset: [0, -6], className: "cd-map-label" });
        }
      });

      // Piktogram dopravního prostředku uprostřed každé cesty (odkud → kam).
      points.forEach((p) => {
        if (p.kind !== "route" || p.toLat == null || p.toLng == null) return;
        const isFocused = focusItemId === p.id;
        const isDimmed = focusItemId && !isFocused;
        const midLat = (p.lat + p.toLat) / 2;
        const midLng = (p.lng + p.toLng) / 2;
        const emoji = TRANSPORT_EMOJI[p.transport] || TRANSPORT_EMOJI.car;
        const icon = L.divIcon({
          className: "",
          html: `<div style="width:28px;height:28px;border-radius:50%;background:${isDimmed ? "rgba(217,98,43,0.4)" : "#fff"};display:flex;align-items:center;justify-content:center;font-size:15px;box-shadow:0 0 0 2px ${isDimmed ? "rgba(217,98,43,0.4)" : PALETTE.coral};">${emoji}</div>`,
          iconSize: [28, 28],
          iconAnchor: [14, 14],
        });
        L.marker([midLat, midLng], { icon, interactive: false }).addTo(layerRef.current);
      });

      if (focusItemId) {
        const focusedDots = geoDots.filter((d) => d.ownerId === focusItemId);
        if (focusedDots.length > 1) {
          mapRef.current.fitBounds(focusedDots.map((d) => [d.lat, d.lng]), { padding: [40, 40] });
        } else if (focusedDots.length === 1) {
          mapRef.current.setView([focusedDots[0].lat, focusedDots[0].lng], 15);
        }
      } else if (geoDots.length > 1) {
        mapRef.current.fitBounds(geoDots.map((d) => [d.lat, d.lng]), { padding: [30, 30] });
      } else {
        mapRef.current.setView([geoDots[0].lat, geoDots[0].lng], 13);
      }
      setTimeout(() => mapRef.current && mapRef.current.invalidateSize(), 100);
    }
  }, [points, ready, focusItemId, showLabelsAlways]);

  const runSearch = async (e) => {
    e.preventDefault();
    if (!query.trim()) return;
    setSearching(true);
    setResults([]);
    try {
      setResults(await geocodePlace(query.trim()));
    } catch {
      setResults([]);
    }
    setSearching(false);
  };

  const pickResult = (r) => {
    const lat = parseFloat(r.lat);
    const lng = parseFloat(r.lon);
    onAddPoint?.({ lat, lng, label: r.display_name.split(",")[0] });
    setResults([]);
    setQuery("");
    if (mapRef.current) mapRef.current.setView([lat, lng], 13);
  };

  return (
    <div>
      {editable && (
        <form onSubmit={runSearch} style={{ display: "flex", gap: 6, marginBottom: 8 }}>
          <div style={{ position: "relative", flex: 1 }}>
            <Search size={14} color={PALETTE.ink} style={{ position: "absolute", left: 10, top: "50%", transform: "translateY(-50%)", opacity: 0.4 }} />
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Najít místo, např. Sintra"
              style={{ ...inputStyle, width: "100%", paddingLeft: 30 }}
            />
          </div>
          <button type="submit" style={{ ...btnGhost, padding: "0 14px" }} disabled={searching}>
            {searching ? <Loader2 size={15} className="cd-spin" /> : "Najít"}
          </button>
        </form>
      )}

      {results.length > 0 && (
        <div style={{ background: "#fff", border: `1px solid ${PALETTE.paperDeep}`, borderRadius: 10, marginBottom: 8, overflow: "hidden" }}>
          {results.map((r, i) => (
            <button
              key={i}
              onClick={() => pickResult(r)}
              style={{
                display: "block", width: "100%", textAlign: "left", padding: "9px 12px",
                fontSize: 12.5, border: "none", borderTop: i > 0 ? `1px solid ${PALETTE.paperDeep}` : "none",
                background: "transparent", cursor: "pointer", color: PALETTE.ink,
              }}
            >
              {r.display_name}
            </button>
          ))}
        </div>
      )}

      <div style={{ borderRadius: 14, border: `1.5px solid ${PALETTE.paperDeep}`, position: "relative", overflow: "hidden", height, background: PALETTE.cream }}>
        <div ref={containerRef} style={{ width: "100%", height: "100%" }} />
        {mapError && (
          <div style={{ position: "absolute", inset: 0, display: "flex", alignItems: "center", justifyContent: "center", padding: 20, textAlign: "center", fontSize: 12.5, color: PALETTE.ink, opacity: 0.6 }}>
            Mapu se nepodařilo načíst — zkontroluj připojení k internetu.
          </div>
        )}
        {editable && !mapError && (
          <div style={{ position: "absolute", bottom: 8, left: 8, right: 8, fontSize: 11, color: PALETTE.ink, background: "rgba(244,239,227,0.85)", borderRadius: 8, padding: "5px 8px", textAlign: "center", pointerEvents: "none" }}>
            Klepni na mapu pro přidání zastávky, nebo ji vyhledej nahoře
          </div>
        )}
      </div>
    </div>
  );
}

// -------------------- Trip list screen -----------------------------------

function TripListScreen({ trips, onOpenTrip, onCreateTrip, dbStatus, dbError, lastSavedAt, onRefresh }) {
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState("");

  const submit = (e) => {
    e.preventDefault();
    if (!name.trim()) return;
    onCreateTrip(name.trim());
    setName("");
    setCreating(false);
  };

  return (
    <div style={{ padding: "20px 18px 90px" }}>
      <h1 style={{ fontFamily: "'Fraunces', serif", fontWeight: 700, fontSize: 28, color: PALETTE.ink, margin: 0 }}>
        Cestovatelský deník
      </h1>
      <p style={{ color: PALETTE.ink, opacity: 0.55, fontSize: 13, margin: "4px 0 4px" }}>
        {trips.length === 0 ? "Zatím žádné výlety" : `${trips.length} ${trips.length === 1 ? "výlet" : trips.length < 5 ? "výlety" : "výletů"}`}
      </p>
      <div style={{ display: "flex", alignItems: "center", gap: 6, margin: "0 0 8px" }}>
        <p style={{ fontSize: 11.5, margin: 0, color: dbStatus === "error" ? "#B4432E" : PALETTE.teal, flex: 1 }}>
          {dbStatus === "loading" && "Připojuji databázi…"}
          {dbStatus === "ok" && (lastSavedAt ? `Naposledy uloženo ${new Date(lastSavedAt).toLocaleTimeString("cs-CZ", { hour: "2-digit", minute: "2-digit" })}` : "Databáze připojena")}
          {dbStatus === "error" && "Poslední akce se nepodařila uložit — zkontroluj připojení"}
        </p>
        <button onClick={onRefresh} title="Obnovit — zobrazit změny od ostatních" style={{ background: "none", border: "none", color: PALETTE.teal, opacity: 0.7, cursor: "pointer", padding: 2, display: "flex" }}>
          <RefreshCw size={13} />
        </button>
      </div>
      {dbStatus === "error" && dbError && (
        <p style={{
          fontSize: 10.5, fontFamily: "monospace", background: "#fff", border: `1px solid ${PALETTE.paperDeep}`,
          borderRadius: 8, padding: "8px 10px", margin: "0 0 16px", color: "#B4432E", wordBreak: "break-word",
        }}>
          {dbError}
        </p>
      )}

      {trips.length === 0 && !creating && (
        <div style={{ border: `1.5px dashed ${PALETTE.gold}`, borderRadius: 16, padding: "36px 20px", textAlign: "center", color: PALETTE.ink }}>
          <MapPin size={26} color={PALETTE.gold} style={{ marginBottom: 10 }} />
          <p style={{ margin: 0, fontSize: 14, opacity: 0.7 }}>Založ první výlet a začni zapisovat dny, fotky a trasy.</p>
        </div>
      )}

      <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
        {trips.map((trip) => (
          <button
            key={trip.id}
            onClick={() => onOpenTrip(trip.id)}
            style={{ display: "flex", alignItems: "center", gap: 14, background: PALETTE.cream, border: `1px solid ${PALETTE.paperDeep}`, borderRadius: 16, padding: "14px 16px", textAlign: "left", cursor: "pointer" }}
          >
            <StampBadge label={trip.days.length > 0 ? `${trip.days.length}D` : "0D"} size={52} />
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ fontFamily: "'Fraunces', serif", fontWeight: 600, fontSize: 17, color: PALETTE.ink, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
                {trip.name}
              </div>
              <div style={{ fontSize: 12.5, color: PALETTE.ink, opacity: 0.55, marginTop: 2 }}>
                {formatRangeCz(trip.days[0]?.date, trip.days[trip.days.length - 1]?.date)}
              </div>
            </div>
          </button>
        ))}
      </div>

      {creating ? (
        <form onSubmit={submit} style={{ marginTop: 16, background: PALETTE.cream, borderRadius: 16, padding: 14, border: `1px solid ${PALETTE.paperDeep}` }}>
          <input
            autoFocus
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Název výletu, např. Portugalsko 2026"
            style={{ width: "100%", border: `1px solid ${PALETTE.paperDeep}`, borderRadius: 10, padding: "10px 12px", fontSize: 15, boxSizing: "border-box", fontFamily: "inherit", background: "#fff", color: PALETTE.ink }}
          />
          <div style={{ display: "flex", gap: 8, marginTop: 10 }}>
            <button type="submit" style={btnPrimary}>Založit</button>
            <button type="button" onClick={() => setCreating(false)} style={btnGhost}>Zrušit</button>
          </div>
        </form>
      ) : (
        <button onClick={() => setCreating(true)} style={{ marginTop: 16, width: "100%", display: "flex", alignItems: "center", justifyContent: "center", gap: 8, padding: "13px 0", borderRadius: 14, border: "none", background: PALETTE.ink, color: PALETTE.cream, fontSize: 15, fontWeight: 600, cursor: "pointer" }}>
          <Plus size={18} /> Nový výlet
        </button>
      )}
    </div>
  );
}

// -------------------- Trip detail screen (list of days) ------------------

function TripDetailScreen({ trip, photoCounts, onBack, onAddDay, onOpenDay, onStartPresentation, onPlayDay, onOpenRestaurants, onOpenHighlights, onOpenFavorites, onDeleteTrip }) {
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [shareFeedback, setShareFeedback] = useState("");

  const handleShare = async () => {
    const shareUrl = `${window.location.origin}${window.location.pathname}?guest=1&trip=${trip.id}`;
    const shareText = "Sdílím s tebou náš cestovatelský deník 🧭 — odkaz je jen pro tebe, prosím nepřeposílej ho dál nikomu jinému.";
    if (navigator.share) {
      try {
        await navigator.share({ title: "Cestovatelský deník", text: shareText, url: shareUrl });
      } catch {
        // uživatel sdílení zrušil — nic neděláme
      }
      return;
    }
    try {
      await navigator.clipboard.writeText(`${shareText}\n${shareUrl}`);
      setShareFeedback("Odkaz zkopírován do schránky");
      setTimeout(() => setShareFeedback(""), 3000);
    } catch {
      window.prompt("Zkopíruj tenhle odkaz:", shareUrl);
    }
  };

  return (
    <div style={{ padding: "16px 18px 90px" }}>
      <TopBar onBack={onBack} title={trip.name} />

      <button onClick={handleShare} style={{ ...btnGhost, width: "100%", marginTop: 14, display: "flex", alignItems: "center", justifyContent: "center", gap: 8 }}>
        <Share2 size={15} /> {shareFeedback || "Sdílet s rodinou a přáteli"}
      </button>

      <div style={{ display: "flex", gap: 8, margin: "10px 0 10px" }}>
        <button onClick={onAddDay} style={{ ...btnPrimary, flex: 1 }}>
          <Plus size={16} style={{ marginRight: 6, verticalAlign: -3 }} /> Přidat den
        </button>
        {trip.days.length > 0 && (
          <button onClick={onStartPresentation} style={{ ...btnAccent, flex: 1 }}>
            <Play size={15} style={{ marginRight: 6, verticalAlign: -2 }} fill={PALETTE.cream} /> Celková prezentace
          </button>
        )}
      </div>

      <div style={{ display: "flex", gap: 8, marginBottom: 20 }}>
        <button onClick={onOpenRestaurants} style={{ ...btnGhost, flex: 1, fontSize: 12.5, padding: "9px 0" }}>
          <Utensils size={14} style={{ marginRight: 5, verticalAlign: -2 }} /> Jídlo
        </button>
        <button onClick={onOpenHighlights} style={{ ...btnGhost, flex: 1, fontSize: 12.5, padding: "9px 0" }}>
          <Sparkles size={14} style={{ marginRight: 5, verticalAlign: -2 }} /> Zajímavosti
        </button>
        <button onClick={onOpenFavorites} style={{ ...btnGhost, flex: 1, fontSize: 12.5, padding: "9px 0" }}>
          <Star size={14} style={{ marginRight: 5, verticalAlign: -2 }} /> Místa
        </button>
      </div>

      {trip.days.length === 0 ? (
        <EmptyHint text="Přidej první den cesty — zastávky, fotky a mapu doplníš uvnitř." />
      ) : (
        <div style={{ position: "relative", paddingLeft: 22 }}>
          <div style={{ position: "absolute", left: 6, top: 6, bottom: 6, width: 2, background: `repeating-linear-gradient(to bottom, ${PALETTE.gold} 0 6px, transparent 6px 11px)` }} />
          <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
            {trip.days.map((day, i) => (
              <div
                key={day.id}
                style={{ position: "relative", background: PALETTE.cream, border: `1px solid ${PALETTE.paperDeep}`, borderRadius: 14, padding: "12px 14px" }}
              >
                <div style={{ position: "absolute", left: -22, top: 18, width: 12, height: 12, borderRadius: "50%", background: PALETTE.coral, border: "2px solid " + PALETTE.paper }} />
                <button
                  onClick={() => onOpenDay(day.id)}
                  style={{ display: "block", width: "100%", textAlign: "left", background: "none", border: "none", padding: 0, cursor: "pointer" }}
                >
                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                    <div style={{ fontFamily: "'Fraunces', serif", fontWeight: 600, fontSize: 15.5, color: PALETTE.ink }}>
                      {day.title || `Den ${i + 1}`}
                    </div>
                    <span style={{ fontSize: 12, color: PALETTE.ink, opacity: 0.5 }}>{formatDateCz(day.date)}</span>
                  </div>
                </button>
                <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginTop: 4 }}>
                  <div style={{ fontSize: 12.5, color: PALETTE.teal }}>
                    {photoCounts[day.id] || 0} {(photoCounts[day.id] || 0) === 1 ? "fotka" : "fotek"} · {(day.points?.length || 0)} {(day.points?.length || 0) === 1 ? "zastávka" : "zastávek"}
                  </div>
                  <button
                    onClick={() => onPlayDay(day.id)}
                    aria-label="Přehrát prezentaci dne"
                    style={{ width: 26, height: 26, borderRadius: "50%", background: PALETTE.coral, border: "none", display: "flex", alignItems: "center", justifyContent: "center", cursor: "pointer", flexShrink: 0 }}
                  >
                    <Play size={12} color="#fff" fill="#fff" style={{ marginLeft: 1.5 }} />
                  </button>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      <div style={{ marginTop: 28, textAlign: "center" }}>
        {confirmDelete ? (
          <div style={{ fontSize: 13, color: PALETTE.ink }}>
            Smazat celý výlet i se dny a fotkami?
            <div style={{ display: "flex", gap: 8, justifyContent: "center", marginTop: 8 }}>
              <button onClick={onDeleteTrip} style={btnDanger}>Smazat</button>
              <button onClick={() => setConfirmDelete(false)} style={btnGhost}>Zrušit</button>
            </div>
          </div>
        ) : (
          <button onClick={() => setConfirmDelete(true)} style={{ background: "none", border: "none", color: PALETTE.ink, opacity: 0.4, fontSize: 12.5, cursor: "pointer" }}>
            Smazat tento výlet
          </button>
        )}
      </div>
    </div>
  );
}

// -------------------- Day detail screen -----------------------------------

function PhotoStrip({ photos, pendingCount = 0, onOpen, onAdd }) {
  return (
    <div style={{ display: "flex", gap: 7, overflowX: "auto", paddingBottom: 2 }}>
      {photos.map((photo) => (
        <div
          key={photo.id}
          onClick={() => onOpen(photo)}
          style={{ flex: "0 0 auto", width: 62, height: 62, borderRadius: 9, overflow: "hidden", border: `1px solid ${PALETTE.paperDeep}`, cursor: "pointer" }}
        >
          <img src={photo.src} alt="" style={{ width: "100%", height: "100%", objectFit: "cover", display: "block" }} />
        </div>
      ))}
      {Array.from({ length: pendingCount }).map((_, i) => (
        <div
          key={`pending-${i}`}
          style={{ flex: "0 0 auto", width: 62, height: 62, borderRadius: 9, border: `1px solid ${PALETTE.paperDeep}`, background: PALETTE.paperDeep, display: "flex", alignItems: "center", justifyContent: "center" }}
        >
          <Loader2 size={18} className="cd-spin" color={PALETTE.teal} />
        </div>
      ))}
      <button
        onClick={onAdd}
        style={{ flex: "0 0 auto", width: 62, height: 62, borderRadius: 9, border: `1.5px dashed ${PALETTE.gold}`, background: "transparent", display: "flex", alignItems: "center", justifyContent: "center", cursor: "pointer", color: PALETTE.gold }}
      >
        <Camera size={17} />
      </button>
    </div>
  );
}

function ItemRow({ item, index, total, photos, pendingCount, onRenameFrom, onRenameTo, onRenameNote, onSetTransport, onRemove, onMoveUp, onMoveDown, onOpenPhoto, onAddPhoto }) {
  const [fromLabel, setFromLabel] = useState(item.label);
  const [toLabel, setToLabel] = useState(item.toLabel || "");
  const [note, setNote] = useState(item.note || "");

  useEffect(() => {
    const t = setTimeout(() => { if (fromLabel !== item.label) onRenameFrom(item.id, fromLabel); }, 500);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fromLabel]);

  useEffect(() => {
    if (item.kind !== "route") return;
    const t = setTimeout(() => { if (toLabel !== (item.toLabel || "")) onRenameTo(item.id, toLabel); }, 500);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [toLabel]);

  useEffect(() => {
    const t = setTimeout(() => { if (note !== (item.note || "")) onRenameNote(item.id, note); }, 500);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [note]);

  return (
    <div style={{ background: PALETTE.cream, border: `1px solid ${PALETTE.paperDeep}`, borderRadius: 12, padding: 10 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
          <button
            onClick={() => onMoveUp(item.id)}
            disabled={index === 0}
            style={{ background: "none", border: "none", color: PALETTE.ink, opacity: index === 0 ? 0.2 : 0.5, cursor: index === 0 ? "default" : "pointer", padding: 1, lineHeight: 0 }}
          >
            <ChevronUp size={15} />
          </button>
          <button
            onClick={() => onMoveDown(item.id)}
            disabled={index === total - 1}
            style={{ background: "none", border: "none", color: PALETTE.ink, opacity: index === total - 1 ? 0.2 : 0.5, cursor: index === total - 1 ? "default" : "pointer", padding: 1, lineHeight: 0 }}
          >
            <ChevronDown size={15} />
          </button>
        </div>
        <StopBadge index={index} total={total} kind={item.kind} transport={item.transport} />
        {item.kind === "route" ? (
          <div style={{ flex: 1, display: "flex", flexDirection: "column", gap: 6 }}>
            <input
              value={fromLabel}
              onChange={(e) => setFromLabel(e.target.value)}
              placeholder="Odkud"
              style={{ ...inputStyle, background: "#fff" }}
            />
            <input
              value={toLabel}
              onChange={(e) => setToLabel(e.target.value)}
              placeholder="Kam"
              style={{ ...inputStyle, background: "#fff" }}
            />
            <div style={{ display: "flex", gap: 6 }}>
              {TRANSPORT_OPTIONS.map((opt) => {
                const Icon = TRANSPORT_ICONS[opt.value];
                const active = (item.transport || "car") === opt.value;
                return (
                  <button
                    key={opt.value}
                    onClick={() => onSetTransport(item.id, opt.value)}
                    title={opt.label}
                    style={{
                      flex: 1, padding: "7px 0", borderRadius: 8, cursor: "pointer",
                      border: `1.5px solid ${active ? PALETTE.coral : PALETTE.paperDeep}`,
                      background: active ? PALETTE.coral : "#fff",
                      color: active ? "#fff" : PALETTE.ink,
                      display: "flex", alignItems: "center", justifyContent: "center",
                    }}
                  >
                    <Icon size={15} />
                  </button>
                );
              })}
            </div>
          </div>
        ) : (
          <input
            value={fromLabel}
            onChange={(e) => setFromLabel(e.target.value)}
            placeholder={`Zastávka ${index + 1}`}
            style={{ ...inputStyle, flex: 1, background: "#fff" }}
          />
        )}
        <button onClick={() => onRemove(item.id)} style={{ background: "none", border: "none", color: PALETTE.ink, opacity: 0.4, cursor: "pointer", padding: 4, alignSelf: item.kind === "route" ? "flex-start" : "center" }}>
          <X size={16} />
        </button>
      </div>
      <textarea
        value={note}
        onChange={(e) => setNote(e.target.value)}
        placeholder="Poznámka (zobrazí se i v prezentaci)"
        rows={2}
        style={{ ...inputStyle, width: "100%", marginTop: 8, background: "#fff", resize: "vertical", fontFamily: "inherit" }}
      />
      <div style={{ marginTop: 8 }}>
        <PhotoStrip photos={photos} pendingCount={pendingCount} onOpen={onOpenPhoto} onAdd={() => onAddPhoto(item.id)} />
      </div>
    </div>
  );
}

function DayDetailScreen({ day, photos, onBack, onUpdateDay, onAddItem, onRenameItem, onRemoveItem, onReorderItems, onAddPhoto, onRemovePhoto }) {
  const fileInputRef = useRef(null);
  const uploadTargetRef = useRef(null);
  const [title, setTitle] = useState(day.title || "");
  const [date, setDate] = useState(day.date || todayISO());
  const [pendingUploads, setPendingUploads] = useState([]); // [{ tempId, pointId }]
  const [viewerPhoto, setViewerPhoto] = useState(null);
  const [mode, setMode] = useState("stop"); // "stop" | "route"
  const [routeDraft, setRouteDraft] = useState(null); // { lat, lng, label } — první vybraný bod cesty

  useEffect(() => {
    const t = setTimeout(() => {
      if (title !== day.title || date !== day.date) onUpdateDay({ title, date });
    }, 400);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [title, date]);

  const openFilePicker = (pointId) => {
    uploadTargetRef.current = pointId;
    fileInputRef.current?.click();
  };

  // Klepnutí na mapu nebo výběr z vyhledávání — v režimu "zastávka" rovnou
  // vytvoří bod, v režimu "cesta" nejdřív zachytí "odkud" a napodruhé "kam".
  const handleRawPoint = (point) => {
    if (mode === "stop") {
      onAddItem({ kind: "stop", lat: point.lat, lng: point.lng, label: point.label || "" });
    } else if (!routeDraft) {
      setRouteDraft(point);
    } else {
      onAddItem({
        kind: "route",
        lat: routeDraft.lat, lng: routeDraft.lng, label: routeDraft.label || "",
        toLat: point.lat, toLng: point.lng, toLabel: point.label || "",
        transport: "car",
      });
      setRouteDraft(null);
    }
  };

  const switchMode = (next) => {
    setMode(next);
    setRouteDraft(null);
  };

  const moveItem = (pointId, direction) => {
    const idx = points.findIndex((p) => p.id === pointId);
    const swapIdx = direction === "up" ? idx - 1 : idx + 1;
    if (idx < 0 || swapIdx < 0 || swapIdx >= points.length) return;
    const next = [...points];
    [next[idx], next[swapIdx]] = [next[swapIdx], next[idx]];
    onReorderItems(next);
  };

  // Každá fotka se zpracuje a nahraje samostatně, na pozadí, bez blokování
  // ostatních akcí — u nahrávané fotky se mezitím zobrazí zástupné kolečko.
  const handleFiles = (e) => {
    const files = Array.from(e.target.files || []);
    if (files.length === 0) return;
    const pointId = uploadTargetRef.current;
    const entries = files.map((file) => ({ tempId: uid(), pointId, file }));
    setPendingUploads((prev) => [...prev, ...entries.map(({ tempId, pointId }) => ({ tempId, pointId }))]);
    e.target.value = "";

    entries.forEach(async ({ tempId, pointId, file }) => {
      try {
        const src = await compressImage(file);
        await onAddPhoto(src, pointId);
      } catch {
        // přeskoč soubor, který se nepodařilo zpracovat nebo nahrát
      } finally {
        setPendingUploads((prev) => prev.filter((p) => p.tempId !== tempId));
      }
    });
  };

  const points = day.points || [];
  const unassigned = photos.filter((p) => !p.pointId);
  const unassignedPending = pendingUploads.filter((p) => !p.pointId).length;

  return (
    <div style={{ padding: "16px 18px 90px" }}>
      <TopBar onBack={onBack} title="Den cesty" />

      {pendingUploads.length > 0 && (
        <div style={{
          display: "flex", alignItems: "center", gap: 8, background: PALETTE.cream,
          border: `1px solid ${PALETTE.paperDeep}`, borderRadius: 10, padding: "8px 12px",
          marginTop: 14, fontSize: 12.5, color: PALETTE.teal,
        }}>
          <Loader2 size={14} className="cd-spin" />
          Nahrávám {pendingUploads.length} {pendingUploads.length === 1 ? "fotku" : pendingUploads.length < 5 ? "fotky" : "fotek"}…
        </div>
      )}

      <div style={{ margin: "16px 0 10px" }}>
        <input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Název dne, např. Lisabon → Sintra" style={{ ...inputStyle, width: "100%" }} />
      </div>
      <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 20 }}>
        <Calendar size={16} color={PALETTE.teal} />
        <input type="date" value={date} onChange={(e) => setDate(e.target.value)} style={{ ...inputStyle, flex: 1 }} />
      </div>

      <SectionLabel>Mapa dne</SectionLabel>

      <div style={{ display: "flex", gap: 8, marginBottom: 8 }}>
        <button
          onClick={() => switchMode("stop")}
          style={{
            flex: 1, padding: "9px 0", borderRadius: 10, fontSize: 13, fontWeight: 600, cursor: "pointer",
            border: `1.5px solid ${mode === "stop" ? PALETTE.teal : PALETTE.paperDeep}`,
            background: mode === "stop" ? PALETTE.teal : "transparent",
            color: mode === "stop" ? "#fff" : PALETTE.ink,
          }}
        >
          <MapPin size={14} style={{ verticalAlign: -2, marginRight: 5 }} /> Zastávka
        </button>
        <button
          onClick={() => switchMode("route")}
          style={{
            flex: 1, padding: "9px 0", borderRadius: 10, fontSize: 13, fontWeight: 600, cursor: "pointer",
            border: `1.5px solid ${mode === "route" ? PALETTE.teal : PALETTE.paperDeep}`,
            background: mode === "route" ? PALETTE.teal : "transparent",
            color: mode === "route" ? "#fff" : PALETTE.ink,
          }}
        >
          <RouteIcon size={14} style={{ verticalAlign: -2, marginRight: 5 }} /> Cesta
        </button>
      </div>

      {mode === "route" && (
        <div style={{ fontSize: 12, color: PALETTE.teal, marginBottom: 8, display: "flex", alignItems: "center", justifyContent: "space-between" }}>
          <span>
            {routeDraft
              ? `Odkud: ${routeDraft.label || "vybráno"} — teď vyber kam cesta vede`
              : "Vyber, odkud cesta začíná (klepni na mapu nebo vyhledej)"}
          </span>
          {routeDraft && (
            <button onClick={() => setRouteDraft(null)} style={{ background: "none", border: "none", color: PALETTE.coral, fontSize: 12, cursor: "pointer", fontWeight: 600 }}>
              Zrušit
            </button>
          )}
        </div>
      )}

      <RouteMap points={points} onAddPoint={handleRawPoint} editable height={200} />

      <SectionLabel style={{ marginTop: 20 }}>Zastávky a cesty {points.length > 0 ? `(${points.length})` : ""}</SectionLabel>

      {points.length === 0 ? (
        <EmptyHint text="Zatím žádná zastávka ani cesta — klepni na mapu nebo místo vyhledej." />
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
          {points.map((point, i) => (
            <ItemRow
              key={point.id}
              item={point}
              index={i}
              total={points.length}
              photos={photos.filter((p) => p.pointId === point.id)}
              pendingCount={pendingUploads.filter((p) => p.pointId === point.id).length}
              onRenameFrom={(id, label) => onRenameItem(id, { label })}
              onRenameTo={(id, toLabel) => onRenameItem(id, { toLabel })}
              onRenameNote={(id, note) => onRenameItem(id, { note })}
              onSetTransport={(id, transport) => onRenameItem(id, { transport })}
              onRemove={onRemoveItem}
              onMoveUp={(id) => moveItem(id, "up")}
              onMoveDown={(id) => moveItem(id, "down")}
              onOpenPhoto={setViewerPhoto}
              onAddPhoto={openFilePicker}
            />
          ))}
        </div>
      )}

      <SectionLabel style={{ marginTop: 20 }}>Ostatní fotky dne</SectionLabel>
      <PhotoStrip photos={unassigned} pendingCount={unassignedPending} onOpen={setViewerPhoto} onAdd={() => openFilePicker(null)} />

      <input ref={fileInputRef} type="file" accept="image/*" multiple onChange={handleFiles} style={{ display: "none" }} />

      {viewerPhoto && (
        <div
          onClick={() => setViewerPhoto(null)}
          style={{ position: "fixed", inset: 0, background: "rgba(15,20,30,0.92)", zIndex: 50, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", padding: 20 }}
        >
          <img src={viewerPhoto.src} alt="" style={{ maxWidth: "100%", maxHeight: "78vh", borderRadius: 10, objectFit: "contain" }} onClick={(e) => e.stopPropagation()} />
          <div style={{ display: "flex", gap: 16, marginTop: 18 }}>
            <button onClick={(e) => { e.stopPropagation(); onRemovePhoto(viewerPhoto.id); setViewerPhoto(null); }} style={btnDanger}>
              <Trash2 size={14} style={{ marginRight: 6, verticalAlign: -2 }} /> Smazat fotku
            </button>
            <button onClick={() => setViewerPhoto(null)} style={{ ...btnGhost, color: "#fff", borderColor: "rgba(255,255,255,0.3)" }}>Zavřít</button>
          </div>
        </div>
      )}
    </div>
  );
}

// -------------------- Restaurants / Highlights (trip-level entries) ------

function RestaurantRow({ item, photos, pendingCount, onUpdate, onRemove, onOpenPhoto, onAddPhoto }) {
  const [name, setName] = useState(item.name || "");
  const [address, setAddress] = useState(item.address || "");
  const [note, setNote] = useState(item.note || "");

  useEffect(() => { const t = setTimeout(() => { if (name !== (item.name || "")) onUpdate(item.id, { name }); }, 500); return () => clearTimeout(t); }, [name]); // eslint-disable-line
  useEffect(() => { const t = setTimeout(() => { if (address !== (item.address || "")) onUpdate(item.id, { address }); }, 500); return () => clearTimeout(t); }, [address]); // eslint-disable-line
  useEffect(() => { const t = setTimeout(() => { if (note !== (item.note || "")) onUpdate(item.id, { note }); }, 500); return () => clearTimeout(t); }, [note]); // eslint-disable-line

  return (
    <div style={{ background: PALETTE.cream, border: `1px solid ${PALETTE.paperDeep}`, borderRadius: 12, padding: 10 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <Utensils size={16} color={PALETTE.coral} style={{ flexShrink: 0 }} />
        <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Název restaurace" style={{ ...inputStyle, flex: 1, background: "#fff", fontWeight: 600 }} />
        <button onClick={() => onRemove(item.id)} style={{ background: "none", border: "none", color: PALETTE.ink, opacity: 0.4, cursor: "pointer", padding: 4 }}><X size={16} /></button>
      </div>
      <input value={address} onChange={(e) => setAddress(e.target.value)} placeholder="Adresa" style={{ ...inputStyle, width: "100%", marginTop: 8, background: "#fff" }} />
      <textarea value={note} onChange={(e) => setNote(e.target.value)} placeholder="Poznámka (co jsme si dali, doporučení…)" rows={2} style={{ ...inputStyle, width: "100%", marginTop: 8, background: "#fff", resize: "vertical", fontFamily: "inherit" }} />
      <div style={{ marginTop: 8 }}>
        <PhotoStrip photos={photos} pendingCount={pendingCount} onOpen={onOpenPhoto} onAdd={() => onAddPhoto(item.id)} />
      </div>
    </div>
  );
}

function HighlightRow({ item, photos, pendingCount, onUpdate, onRemove, onOpenPhoto, onAddPhoto }) {
  const [title, setTitle] = useState(item.title || "");
  const [note, setNote] = useState(item.note || "");

  useEffect(() => { const t = setTimeout(() => { if (title !== (item.title || "")) onUpdate(item.id, { title }); }, 500); return () => clearTimeout(t); }, [title]); // eslint-disable-line
  useEffect(() => { const t = setTimeout(() => { if (note !== (item.note || "")) onUpdate(item.id, { note }); }, 500); return () => clearTimeout(t); }, [note]); // eslint-disable-line

  return (
    <div style={{ background: PALETTE.cream, border: `1px solid ${PALETTE.paperDeep}`, borderRadius: 12, padding: 10 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <Sparkles size={16} color={PALETTE.gold} style={{ flexShrink: 0 }} />
        <input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Název zajímavosti" style={{ ...inputStyle, flex: 1, background: "#fff", fontWeight: 600 }} />
        <button onClick={() => onRemove(item.id)} style={{ background: "none", border: "none", color: PALETTE.ink, opacity: 0.4, cursor: "pointer", padding: 4 }}><X size={16} /></button>
      </div>
      <textarea value={note} onChange={(e) => setNote(e.target.value)} placeholder="Popis…" rows={3} style={{ ...inputStyle, width: "100%", marginTop: 8, background: "#fff", resize: "vertical", fontFamily: "inherit" }} />
      <div style={{ marginTop: 8 }}>
        <PhotoStrip photos={photos} pendingCount={pendingCount} onOpen={onOpenPhoto} onAdd={() => onAddPhoto(item.id)} />
      </div>
    </div>
  );
}

// Sdílená obrazovka pro Jídlo i Zajímavosti — liší se jen tím, jak se
// vykresluje jeden řádek (renderRow).
function EntriesScreen({ title, emptyText, addLabel, entries, photosMap, renderRow, onBack, onAddEntry, onAddPhoto, onRemovePhoto }) {
  const fileInputRef = useRef(null);
  const uploadTargetRef = useRef(null);
  const [pendingUploads, setPendingUploads] = useState([]); // [{ tempId, entryId }]
  const [viewerPhoto, setViewerPhoto] = useState(null);

  const openFilePicker = (entryId) => {
    uploadTargetRef.current = entryId;
    fileInputRef.current?.click();
  };

  const handleFiles = (e) => {
    const files = Array.from(e.target.files || []);
    if (files.length === 0) return;
    const entryId = uploadTargetRef.current;
    const batch = files.map((file) => ({ tempId: uid(), entryId, file }));
    setPendingUploads((prev) => [...prev, ...batch.map(({ tempId, entryId }) => ({ tempId, entryId }))]);
    e.target.value = "";

    batch.forEach(async ({ tempId, entryId, file }) => {
      try {
        const src = await compressImage(file);
        await onAddPhoto(entryId, src);
      } catch {
        // přeskoč soubor, který se nepodařilo zpracovat nebo nahrát
      } finally {
        setPendingUploads((prev) => prev.filter((p) => p.tempId !== tempId));
      }
    });
  };

  return (
    <div style={{ padding: "16px 18px 90px" }}>
      <TopBar onBack={onBack} title={title} />

      {pendingUploads.length > 0 && (
        <div style={{ display: "flex", alignItems: "center", gap: 8, background: PALETTE.cream, border: `1px solid ${PALETTE.paperDeep}`, borderRadius: 10, padding: "8px 12px", marginTop: 14, fontSize: 12.5, color: PALETTE.teal }}>
          <Loader2 size={14} className="cd-spin" />
          Nahrávám {pendingUploads.length} {pendingUploads.length === 1 ? "fotku" : pendingUploads.length < 5 ? "fotky" : "fotek"}…
        </div>
      )}

      {entries.length === 0 ? (
        <EmptyHint text={emptyText} />
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: 10, marginTop: 16 }}>
          {entries.map((item) =>
            renderRow(
              item,
              photosMap[item.id] || [],
              pendingUploads.filter((p) => p.entryId === item.id).length,
              openFilePicker,
              (photo) => setViewerPhoto({ ...photo, entryId: item.id })
            )
          )}
        </div>
      )}

      <button onClick={onAddEntry} style={{ marginTop: 16, width: "100%", display: "flex", alignItems: "center", justifyContent: "center", gap: 8, padding: "13px 0", borderRadius: 14, border: "none", background: PALETTE.ink, color: PALETTE.cream, fontSize: 15, fontWeight: 600, cursor: "pointer" }}>
        <Plus size={18} /> {addLabel}
      </button>

      <input ref={fileInputRef} type="file" accept="image/*" multiple onChange={handleFiles} style={{ display: "none" }} />

      {viewerPhoto && (
        <div
          onClick={() => setViewerPhoto(null)}
          style={{ position: "fixed", inset: 0, background: "rgba(15,20,30,0.92)", zIndex: 50, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", padding: 20 }}
        >
          <img src={viewerPhoto.src} alt="" style={{ maxWidth: "100%", maxHeight: "78vh", borderRadius: 10, objectFit: "contain" }} onClick={(e) => e.stopPropagation()} />
          <div style={{ display: "flex", gap: 16, marginTop: 18 }}>
            <button onClick={(e) => { e.stopPropagation(); onRemovePhoto(viewerPhoto.entryId, viewerPhoto.id); setViewerPhoto(null); }} style={btnDanger}>
              <Trash2 size={14} style={{ marginRight: 6, verticalAlign: -2 }} /> Smazat fotku
            </button>
            <button onClick={() => setViewerPhoto(null)} style={{ ...btnGhost, color: "#fff", borderColor: "rgba(255,255,255,0.3)" }}>Zavřít</button>
          </div>
        </div>
      )}
    </div>
  );
}

// -------------------- Favorites (best places, picked from days) ---------

function FavoriteRow({ favorite, point, day, onUpdateNote, onRemove }) {
  const [note, setNote] = useState(favorite.note || "");
  useEffect(() => { const t = setTimeout(() => { if (note !== (favorite.note || "")) onUpdateNote(favorite.id, note); }, 500); return () => clearTimeout(t); }, [note]); // eslint-disable-line

  return (
    <div style={{ background: PALETTE.cream, border: `1px solid ${PALETTE.paperDeep}`, borderRadius: 12, padding: 10 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        {point.kind === "route" ? React.createElement(TRANSPORT_ICONS[point.transport] || RouteIcon, { size: 18, color: PALETTE.coral }) : <MapPin size={18} color={PALETTE.coral} />}
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontWeight: 600, fontSize: 14.5, color: PALETTE.ink, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
            {point.kind === "route" ? `${point.label || "Odkud"} → ${point.toLabel || "Kam"}` : (point.label || "Zastávka")}
          </div>
          <div style={{ fontSize: 11.5, color: PALETTE.teal }}>{day.title || formatDateCz(day.date)}</div>
        </div>
        <button onClick={() => onRemove(favorite.id)} style={{ background: "none", border: "none", color: PALETTE.ink, opacity: 0.4, cursor: "pointer", padding: 4 }}><X size={16} /></button>
      </div>
      <textarea
        value={note}
        onChange={(e) => setNote(e.target.value)}
        placeholder="Proč se ti tohle místo líbilo…"
        rows={2}
        style={{ ...inputStyle, width: "100%", marginTop: 8, background: "#fff", resize: "vertical", fontFamily: "inherit" }}
      />
    </div>
  );
}

function FavoritesScreen({ trip, favorites, onBack, onAddFavorite, onUpdateNote, onRemoveFavorite }) {
  const [picking, setPicking] = useState(false);
  const favoritedIds = useMemo(() => new Set(favorites.map((f) => f.pointId)), [favorites]);

  const resolvePoint = (pointId) => {
    for (const day of trip.days) {
      const p = day.points.find((pt) => pt.id === pointId);
      if (p) return { point: p, day };
    }
    return null;
  };

  return (
    <div style={{ padding: "16px 18px 90px" }}>
      <TopBar onBack={onBack} title="Nejlepší místa" />

      {favorites.length === 0 ? (
        <EmptyHint text="Zatím žádná vybraná místa — přidej ze zastávek a cest jednotlivých dní." />
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: 10, marginTop: 16 }}>
          {favorites.map((fav) => {
            const resolved = resolvePoint(fav.pointId);
            if (!resolved) return null;
            return <FavoriteRow key={fav.id} favorite={fav} point={resolved.point} day={resolved.day} onUpdateNote={onUpdateNote} onRemove={onRemoveFavorite} />;
          })}
        </div>
      )}

      <button onClick={() => setPicking(true)} style={{ marginTop: 16, width: "100%", display: "flex", alignItems: "center", justifyContent: "center", gap: 8, padding: "13px 0", borderRadius: 14, border: "none", background: PALETTE.ink, color: PALETTE.cream, fontSize: 15, fontWeight: 600, cursor: "pointer" }}>
        <Plus size={18} /> Přidat místo
      </button>

      {picking && (
        <div style={{ position: "fixed", inset: 0, background: "rgba(15,20,30,0.94)", zIndex: 50, display: "flex", flexDirection: "column", padding: 20 }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 14 }}>
            <div style={{ color: PALETTE.cream, fontFamily: "'Fraunces', serif", fontSize: 18 }}>Vyber místo</div>
            <button onClick={() => setPicking(false)} style={iconBtnDark}><X size={20} /></button>
          </div>
          <div style={{ flex: 1, overflowY: "auto" }}>
            {trip.days.length === 0 && <div style={{ color: PALETTE.cream, opacity: 0.5, fontSize: 13 }}>Zatím nemáš žádné dny s body.</div>}
            {trip.days.map((day) => {
              const available = day.points.filter((p) => !favoritedIds.has(p.id));
              return (
                <div key={day.id} style={{ marginBottom: 18 }}>
                  <div style={{ color: PALETTE.cream, opacity: 0.55, fontSize: 11, fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.06em", marginBottom: 6 }}>
                    {day.title || formatDateCz(day.date)}
                  </div>
                  {available.length === 0 ? (
                    <div style={{ color: PALETTE.cream, opacity: 0.35, fontSize: 12.5, paddingLeft: 2 }}>Vše už je vybráno</div>
                  ) : (
                    available.map((p) => (
                      <button
                        key={p.id}
                        onClick={() => { onAddFavorite(p.id); setPicking(false); }}
                        style={{ display: "flex", alignItems: "center", gap: 10, width: "100%", textAlign: "left", background: "rgba(244,239,227,0.08)", border: "none", borderRadius: 10, padding: "10px 12px", marginBottom: 6, cursor: "pointer", color: PALETTE.cream }}
                      >
                        {p.kind === "route" ? React.createElement(TRANSPORT_ICONS[p.transport] || RouteIcon, { size: 16 }) : <MapPin size={16} />}
                        <span style={{ fontSize: 13.5 }}>{p.kind === "route" ? `${p.label || "Odkud"} → ${p.toLabel || "Kam"}` : (p.label || "Zastávka")}</span>
                      </button>
                    ))
                  )}
                </div>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}

// -------------------- Guest (read-only viewing) screens ------------------
// Dostupné přes odkaz appka.vercel.app/?guest=1 — jen prohlížení prezentací,
// jídla, zajímavostí a míst. Bez možnosti cokoliv přidat nebo upravit.
// Pozor: appka nemá přihlašování, takže tohle je jen zjednodušené rozhraní
// pro lidi, kterým odkaz sám dáš — ne skutečné zabezpečení dat.

function ViewPhotoGrid({ photos, onOpen }) {
  if (!photos.length) return null;
  return (
    <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 6, marginTop: 8 }}>
      {photos.map((photo) => (
        <div
          key={photo.id}
          onClick={() => onOpen(photo)}
          style={{ aspectRatio: "1", borderRadius: 8, overflow: "hidden", cursor: "pointer", border: `1px solid ${PALETTE.paperDeep}` }}
        >
          <img src={photo.src} alt="" style={{ width: "100%", height: "100%", objectFit: "cover", display: "block" }} />
        </div>
      ))}
    </div>
  );
}

function ViewLightbox({ photo, onClose }) {
  if (!photo) return null;
  return (
    <div onClick={onClose} style={{ position: "fixed", inset: 0, background: "rgba(15,20,30,0.92)", zIndex: 50, display: "flex", alignItems: "center", justifyContent: "center", padding: 20 }}>
      <img src={photo.src} alt="" style={{ maxWidth: "100%", maxHeight: "85vh", borderRadius: 10, objectFit: "contain" }} onClick={(e) => e.stopPropagation()} />
    </div>
  );
}

function GuestTripListScreen({ trips, onOpenTrip }) {
  return (
    <div style={{ padding: "20px 18px 90px" }}>
      <h1 style={{ fontFamily: "'Fraunces', serif", fontWeight: 700, fontSize: 26, color: PALETTE.ink, margin: 0 }}>Cestovatelský deník</h1>
      <p style={{ color: PALETTE.ink, opacity: 0.5, fontSize: 12.5, margin: "4px 0 12px" }}>Prohlížení — bez možnosti úprav</p>
      <div style={{ background: PALETTE.cream, border: `1px solid ${PALETTE.paperDeep}`, borderRadius: 10, padding: "9px 12px", marginBottom: 20, fontSize: 11.5, color: PALETTE.teal, lineHeight: 1.4 }}>
        Tento odkaz je jen pro tebe — prosím nepřeposílej ho dál nikomu jinému.
      </div>
      {trips.length === 0 ? (
        <EmptyHint text="Zatím tu nejsou žádné výlety." />
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
          {trips.map((trip) => (
            <button
              key={trip.id}
              onClick={() => onOpenTrip(trip.id)}
              style={{ display: "flex", alignItems: "center", gap: 14, background: PALETTE.cream, border: `1px solid ${PALETTE.paperDeep}`, borderRadius: 16, padding: "14px 16px", textAlign: "left", cursor: "pointer" }}
            >
              <StampBadge label={trip.days.length > 0 ? `${trip.days.length}D` : "0D"} size={48} />
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontFamily: "'Fraunces', serif", fontWeight: 600, fontSize: 16, color: PALETTE.ink }}>{trip.name}</div>
                <div style={{ fontSize: 12, color: PALETTE.ink, opacity: 0.5, marginTop: 2 }}>
                  {formatRangeCz(trip.days[0]?.date, trip.days[trip.days.length - 1]?.date)}
                </div>
              </div>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

function GuestTripScreen({ trip, photoCounts, onBack, onPlayAll, onPlayDay, onOpenFood, onOpenHighlights, onOpenPlaces }) {
  return (
    <div style={{ padding: "16px 18px 90px" }}>
      <TopBar onBack={onBack} title={trip.name} />

      <div style={{ background: PALETTE.cream, border: `1px solid ${PALETTE.paperDeep}`, borderRadius: 10, padding: "9px 12px", margin: "14px 0", fontSize: 11.5, color: PALETTE.teal, lineHeight: 1.4 }}>
        Tento odkaz je jen pro tebe — prosím nepřeposílej ho dál nikomu jinému.
      </div>

      {trip.days.length > 0 && (
        <button onClick={onPlayAll} style={{ ...btnAccent, width: "100%", marginBottom: 10 }}>
          <Play size={15} style={{ marginRight: 6, verticalAlign: -2 }} fill={PALETTE.cream} /> Celková prezentace
        </button>
      )}

      <div style={{ display: "flex", gap: 8, marginBottom: 20 }}>
        <button onClick={onOpenFood} style={{ ...btnGhost, flex: 1, fontSize: 12.5, padding: "9px 0" }}>
          <Utensils size={14} style={{ marginRight: 5, verticalAlign: -2 }} /> Jídlo
        </button>
        <button onClick={onOpenHighlights} style={{ ...btnGhost, flex: 1, fontSize: 12.5, padding: "9px 0" }}>
          <Sparkles size={14} style={{ marginRight: 5, verticalAlign: -2 }} /> Zajímavosti
        </button>
        <button onClick={onOpenPlaces} style={{ ...btnGhost, flex: 1, fontSize: 12.5, padding: "9px 0" }}>
          <Star size={14} style={{ marginRight: 5, verticalAlign: -2 }} /> Místa
        </button>
      </div>

      {trip.days.length === 0 ? (
        <EmptyHint text="Tenhle výlet zatím nemá žádné dny." />
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
          {trip.days.map((day, i) => (
            <div
              key={day.id}
              style={{ background: PALETTE.cream, border: `1px solid ${PALETTE.paperDeep}`, borderRadius: 14, padding: "12px 14px", display: "flex", alignItems: "center", justifyContent: "space-between" }}
            >
              <div>
                <div style={{ fontFamily: "'Fraunces', serif", fontWeight: 600, fontSize: 15.5, color: PALETTE.ink }}>{day.title || `Den ${i + 1}`}</div>
                <div style={{ fontSize: 12, color: PALETTE.ink, opacity: 0.5 }}>
                  {formatDateCz(day.date)} · {photoCounts[day.id] || 0} {(photoCounts[day.id] || 0) === 1 ? "fotka" : "fotek"}
                </div>
              </div>
              <button
                onClick={() => onPlayDay(day.id)}
                aria-label="Přehrát prezentaci dne"
                style={{ width: 32, height: 32, borderRadius: "50%", background: PALETTE.coral, border: "none", display: "flex", alignItems: "center", justifyContent: "center", cursor: "pointer", flexShrink: 0 }}
              >
                <Play size={14} color="#fff" fill="#fff" style={{ marginLeft: 2 }} />
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function GuestEntriesScreen({ title, emptyText, entries, photosMap, onBack, renderReadRow }) {
  const [viewerPhoto, setViewerPhoto] = useState(null);
  return (
    <div style={{ padding: "16px 18px 90px" }}>
      <TopBar onBack={onBack} title={title} />
      {entries.length === 0 ? (
        <EmptyHint text={emptyText} />
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: 10, marginTop: 16 }}>
          {entries.map((item) => renderReadRow(item, photosMap[item.id] || [], setViewerPhoto))}
        </div>
      )}
      <ViewLightbox photo={viewerPhoto} onClose={() => setViewerPhoto(null)} />
    </div>
  );
}

function GuestFavoritesScreen({ trip, favorites, onBack }) {
  const resolvePoint = (pointId) => {
    for (const day of trip.days) {
      const p = day.points.find((pt) => pt.id === pointId);
      if (p) return { point: p, day };
    }
    return null;
  };
  return (
    <div style={{ padding: "16px 18px 90px" }}>
      <TopBar onBack={onBack} title="Nejlepší místa" />
      {favorites.length === 0 ? (
        <EmptyHint text="Zatím žádná vybraná místa." />
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: 10, marginTop: 16 }}>
          {favorites.map((fav) => {
            const resolved = resolvePoint(fav.pointId);
            if (!resolved) return null;
            const { point, day } = resolved;
            return (
              <div key={fav.id} style={{ background: PALETTE.cream, border: `1px solid ${PALETTE.paperDeep}`, borderRadius: 12, padding: 12 }}>
                <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                  {point.kind === "route" ? React.createElement(TRANSPORT_ICONS[point.transport] || RouteIcon, { size: 16, color: PALETTE.coral }) : <MapPin size={16} color={PALETTE.coral} />}
                  <div style={{ fontWeight: 600, fontSize: 14.5, color: PALETTE.ink }}>
                    {point.kind === "route" ? `${point.label || "Odkud"} → ${point.toLabel || "Kam"}` : (point.label || "Zastávka")}
                  </div>
                </div>
                <div style={{ fontSize: 11.5, color: PALETTE.teal, marginTop: 2 }}>{day.title || formatDateCz(day.date)}</div>
                {fav.note && <div style={{ fontSize: 13, color: PALETTE.ink, opacity: 0.8, marginTop: 6, lineHeight: 1.5 }}>{fav.note}</div>}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

// -------------------- Presentation mode -----------------------------------

function buildSlides(trip, allPhotos) {
  const slides = [];
  trip.days.forEach((day) => {
    const points = day.points || [];
    const photos = allPhotos[day.id] || [];
    slides.push({ kind: "day", dayId: day.id });
    points.forEach((pt) => {
      slides.push({ kind: "point", dayId: day.id, pointId: pt.id });
      photos.filter((ph) => ph.pointId === pt.id).forEach((ph) => {
        slides.push({ kind: "photo", dayId: day.id, pointId: pt.id, photoId: ph.id });
      });
    });
    const unassigned = photos.filter((ph) => !ph.pointId);
    if (unassigned.length > 0) {
      slides.push({ kind: "section", dayId: day.id, label: "Ostatní fotky dne" });
      unassigned.forEach((ph) => {
        slides.push({ kind: "photo", dayId: day.id, pointId: null, photoId: ph.id });
      });
    }
  });
  return slides;
}

function PresentationScreen({ trip, allPhotos, onExit, spotifyUrl, onSetSpotifyUrl, readOnly = false }) {
  const slides = useMemo(() => buildSlides(trip, allPhotos), [trip, allPhotos]);
  const [idx, setIdx] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [musicName, setMusicName] = useState(null);
  const audioRef = useRef(null);
  const musicInputRef = useRef(null);

  const slide = slides[idx];
  const day = slide ? trip.days.find((d) => d.id === slide.dayId) : null;
  const dayIndex = day ? trip.days.indexOf(day) : 0;
  const point = slide?.kind !== "day" && day ? day.points.find((p) => p.id === slide.pointId) : null;
  const photo = slide?.kind === "photo" ? (allPhotos[slide.dayId] || []).find((p) => p.id === slide.photoId) : null;

  useEffect(() => {
    if (!playing || !slide) return;
    const dur = slide.kind === "day" ? 4200 : slide.kind === "point" ? 3000 : slide.kind === "section" ? 2000 : 3400;
    const t = setTimeout(() => {
      setIdx((i) => {
        if (i + 1 < slides.length) return i + 1;
        setPlaying(false);
        return i;
      });
    }, dur);
    return () => clearTimeout(t);
  }, [playing, idx, slides.length, slide]);

  const pickMusic = (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const url = URL.createObjectURL(file);
    if (audioRef.current) {
      audioRef.current.src = url;
      audioRef.current.load();
    }
    setMusicName(file.name);
  };

  const togglePlay = () => {
    const next = !playing;
    setPlaying(next);
    if (audioRef.current?.src) {
      if (next) audioRef.current.play().catch(() => {});
      else audioRef.current.pause();
    }
  };

  const openSpotify = () => {
    if (spotifyUrl) {
      window.open(spotifyUrl, "_blank");
    } else if (!readOnly) {
      const url = window.prompt("Vlož odkaz na svůj Spotify playlist:");
      if (url && url.trim()) {
        onSetSpotifyUrl(url.trim());
        window.open(url.trim(), "_blank");
      }
    }
  };

  const editSpotify = () => {
    const url = window.prompt("Upravit odkaz na Spotify playlist (prázdné = smazat):", spotifyUrl || "");
    if (url !== null) onSetSpotifyUrl(url.trim());
  };

  const step = (delta) => setIdx((i) => Math.min(slides.length - 1, Math.max(0, i + delta)));

  if (!slide || !day) {
    return (
      <div style={{ position: "fixed", inset: 0, background: PALETTE.ink, color: PALETTE.cream, display: "flex", alignItems: "center", justifyContent: "center", flexDirection: "column", gap: 14, padding: 24, textAlign: "center", zIndex: 60 }}>
        <p style={{ opacity: 0.7, fontSize: 14 }}>Tenhle výlet ještě nemá žádné zastávky ani fotky k promítnutí.</p>
        <button onClick={onExit} style={{ ...btnGhost, color: "#fff", borderColor: "rgba(255,255,255,0.3)" }}>Zpět</button>
      </div>
    );
  }

  const progress = slides.length > 1 ? idx / (slides.length - 1) : 1;

  return (
    <div style={{ position: "fixed", inset: 0, background: PALETTE.ink, color: PALETTE.cream, display: "flex", flexDirection: "column", zIndex: 60 }}>
      <audio ref={audioRef} loop />
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "14px 16px 8px" }}>
        <button onClick={onExit} style={iconBtnDark}><X size={20} /></button>
        <div style={{ textAlign: "center" }}>
          <div style={{ fontFamily: "'Fraunces', serif", fontSize: 14, opacity: 0.85 }}>{trip.name}</div>
          <div style={{ fontSize: 11, opacity: 0.55 }}>Den {dayIndex + 1} z {trip.days.length}</div>
        </div>
        <div style={{ display: "flex", gap: 8 }}>
          <button onClick={openSpotify} style={{ ...iconBtnDark, background: "rgba(29,185,84,0.18)" }} title="Otevřít Spotify playlist">
            <ExternalLink size={16} color="#1DB954" />
          </button>
          <button onClick={() => musicInputRef.current?.click()} style={iconBtnDark}><Music size={18} /></button>
        </div>
      </div>
      <input ref={musicInputRef} type="file" accept="audio/*" onChange={pickMusic} style={{ display: "none" }} />

      <div style={{ height: 2, background: "rgba(244,239,227,0.15)", margin: "0 16px" }}>
        <div style={{ height: "100%", width: `${progress * 100}%`, background: PALETTE.coral, transition: "width 0.3s" }} />
      </div>

      <div key={idx} className="cd-fadein" style={{ flex: 1, minHeight: 0, display: "flex", flexDirection: "column", padding: "16px 20px", overflowY: "auto" }}>
        {slide.kind === "day" && (
          <>
            <div style={{ fontFamily: "'Fraunces', serif", fontSize: 22, fontWeight: 600, marginBottom: 2 }}>{day.title || `Den ${dayIndex + 1}`}</div>
            <div style={{ fontSize: 12.5, opacity: 0.6, marginBottom: 14 }}>{formatDateCz(day.date)}</div>
            <RouteMap points={day.points} editable={false} height="48vh" showLabelsAlways />
          </>
        )}
        {slide.kind === "point" && point && (
          <>
            <div style={{ fontSize: 11.5, opacity: 0.55, marginBottom: 2 }}>{day.title || `Den ${dayIndex + 1}`} · {formatDateCz(day.date)}</div>
            <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 14 }}>
              {point.kind === "route" ? React.createElement(TRANSPORT_ICONS[point.transport] || RouteIcon, { size: 20, color: PALETTE.coral }) : <MapPin size={20} color={PALETTE.coral} />}
              <div style={{ fontFamily: "'Fraunces', serif", fontSize: 22, fontWeight: 600 }}>
                {point.kind === "route"
                  ? `${point.label || "Odkud"} → ${point.toLabel || "Kam"}`
                  : (point.label || `Zastávka ${day.points.indexOf(point) + 1}`)}
              </div>
            </div>
            {point.note && (
              <div style={{ fontSize: 13.5, opacity: 0.8, lineHeight: 1.5, marginBottom: 14, whiteSpace: "pre-wrap" }}>
                {point.note}
              </div>
            )}
            <RouteMap points={day.points} editable={false} height="42vh" focusItemId={point.id} />
          </>
        )}
        {slide.kind === "section" && (
          <div style={{ flex: 1, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 12 }}>
            <Camera size={30} color={PALETTE.gold} />
            <div style={{ fontFamily: "'Fraunces', serif", fontSize: 22, fontWeight: 600, textAlign: "center" }}>{slide.label}</div>
          </div>
        )}
        {slide.kind === "photo" && photo && (
          <>
            <div style={{ fontSize: 13, opacity: 0.75, marginBottom: 10, display: "flex", alignItems: "center", gap: 6 }}>
              {point
                ? <>{point.kind === "route" ? <RouteIcon size={13} color={PALETTE.coral} /> : <MapPin size={13} color={PALETTE.coral} />} {point.kind === "route" ? `${point.label || "Odkud"} → ${point.toLabel || "Kam"}` : (point.label || "Zastávka")}</>
                : (day.title || `Den ${dayIndex + 1}`)}
            </div>
            <div style={{ flex: 1, borderRadius: 14, overflow: "hidden", background: "#000" }}>
              <img src={photo.src} alt="" style={{ width: "100%", height: "100%", objectFit: "contain" }} />
            </div>
          </>
        )}
      </div>

      <div style={{ padding: "10px 20px 26px" }}>
        {musicName && <div style={{ fontSize: 11, opacity: 0.5, textAlign: "center", marginBottom: 6 }}>♪ {musicName}</div>}
        {spotifyUrl && (
          <div style={{ display: "flex", alignItems: "center", justifyContent: "center", gap: 6, marginBottom: 10, fontSize: 11, opacity: 0.6 }}>
            <span>🎧 Spotify playlist nastaven</span>
            {!readOnly && (
              <button onClick={editSpotify} style={{ background: "none", border: "none", color: PALETTE.cream, opacity: 0.7, cursor: "pointer", padding: 2 }}>
                <Pencil size={11} />
              </button>
            )}
          </div>
        )}
        <div style={{ display: "flex", alignItems: "center", justifyContent: "center", gap: 22 }}>
          <button onClick={() => step(-1)} disabled={idx === 0} style={iconBtnDark}><SkipBack size={20} /></button>
          <button onClick={togglePlay} style={{ width: 58, height: 58, borderRadius: "50%", background: PALETTE.coral, border: "none", display: "flex", alignItems: "center", justifyContent: "center", cursor: "pointer" }}>
            {playing ? <Pause size={22} color="#fff" fill="#fff" /> : <Play size={22} color="#fff" fill="#fff" style={{ marginLeft: 3 }} />}
          </button>
          <button onClick={() => step(1)} disabled={idx === slides.length - 1} style={iconBtnDark}><SkipForward size={20} /></button>
        </div>
      </div>
    </div>
  );
}

// -------------------- Shared bits -----------------------------------------

function TopBar({ onBack, title }) {
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
      <button onClick={onBack} style={iconBtnLight}><ChevronLeft size={22} /></button>
      <h2 style={{ fontFamily: "'Fraunces', serif", fontWeight: 600, fontSize: 18, color: PALETTE.ink, margin: 0, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{title}</h2>
    </div>
  );
}

function SectionLabel({ children, style }) {
  return <div style={{ fontSize: 11, fontWeight: 700, letterSpacing: "0.08em", textTransform: "uppercase", color: PALETTE.teal, marginBottom: 8, ...style }}>{children}</div>;
}

function EmptyHint({ text }) {
  return <div style={{ border: `1.5px dashed ${PALETTE.paperDeep}`, borderRadius: 14, padding: "26px 18px", textAlign: "center", color: PALETTE.ink, opacity: 0.6, fontSize: 13.5 }}>{text}</div>;
}

const inputStyle = { border: `1px solid ${PALETTE.paperDeep}`, borderRadius: 10, padding: "10px 12px", fontSize: 14.5, boxSizing: "border-box", fontFamily: "inherit", background: "#fff", color: PALETTE.ink };
const btnPrimary = { border: "none", background: PALETTE.ink, color: PALETTE.cream, borderRadius: 12, padding: "11px 0", fontSize: 14, fontWeight: 600, cursor: "pointer" };
const btnAccent = { border: "none", background: PALETTE.coral, color: PALETTE.cream, borderRadius: 12, padding: "11px 0", fontSize: 14, fontWeight: 600, cursor: "pointer" };
const btnGhost = { border: `1px solid ${PALETTE.paperDeep}`, background: "transparent", color: PALETTE.ink, borderRadius: 12, padding: "10px 16px", fontSize: 13.5, fontWeight: 600, cursor: "pointer" };
const btnDanger = { border: "none", background: "#B4432E", color: "#fff", borderRadius: 12, padding: "9px 16px", fontSize: 13, fontWeight: 600, cursor: "pointer" };
const iconBtnLight = { border: "none", background: PALETTE.cream, color: PALETTE.ink, width: 36, height: 36, borderRadius: "50%", display: "flex", alignItems: "center", justifyContent: "center", cursor: "pointer", flexShrink: 0 };
const iconBtnDark = { border: "none", background: "rgba(244,239,227,0.12)", color: PALETTE.cream, width: 40, height: 40, borderRadius: "50%", display: "flex", alignItems: "center", justifyContent: "center", cursor: "pointer" };

// -------------------- Root app ---------------------------------------------

export default function CestovatelskyDenik() {
  const isGuest = useMemo(() => {
    try {
      return new URLSearchParams(window.location.search).get("guest") === "1";
    } catch {
      return false;
    }
  }, []);
  const [trips, setTrips] = useState([]);
  const [dayPhotos, setDayPhotos] = useState({});
  const [restaurantPhotos, setRestaurantPhotos] = useState({});
  const [highlightPhotos, setHighlightPhotos] = useState({});
  const [loaded, setLoaded] = useState(false);
  const [view, setView] = useState(() => {
    if (!isGuest) return { screen: "list" };
    try {
      const sharedTripId = new URLSearchParams(window.location.search).get("trip");
      if (sharedTripId) return { screen: "guest-trip", tripId: sharedTripId };
    } catch {
      // ignoruj
    }
    return { screen: "guest-list" };
  });
  const [dbStatus, setDbStatus] = useState("loading"); // loading | ok | error
  const [dbError, setDbError] = useState(null);
  const [lastSavedAt, setLastSavedAt] = useState(null);

  // Načtení všech dat z databáze (spojíme 4 tabulky do stromu v paměti).
  // Použije se při startu i pro ruční obnovení (více lidí může upravovat souběžně).
  const loadAllData = useCallback(async () => {
    try {
      const [tripsRows, daysRows, pointsRows, photosRows, restaurantsRows, restaurantPhotosRows, highlightsRows, highlightPhotosRows, favoritesRows] = await Promise.all([
        sb("trips?select=*&order=created_at.asc"),
        sb("days?select=*&order=created_at.asc"),
        sb("points?select=*&order=position.asc"),
        sb("photos?select=*&order=created_at.asc"),
        sb("restaurants?select=*&order=position.asc"),
        sb("restaurant_photos?select=*&order=created_at.asc"),
        sb("highlights?select=*&order=position.asc"),
        sb("highlight_photos?select=*&order=created_at.asc"),
        sb("favorites?select=*&order=position.asc"),
      ]);
      const assembled = tripsRows.map((t) => ({
        id: t.id,
        name: t.name,
        spotifyUrl: t.spotify_url || "",
        days: daysRows
          .filter((d) => d.trip_id === t.id)
          .map((d) => ({
            id: d.id,
            title: d.title || "",
            date: d.date || "",
            points: pointsRows
              .filter((p) => p.day_id === d.id)
              .map((p) => ({
                id: p.id, lat: p.lat, lng: p.lng, label: p.label || "",
                kind: p.kind || "stop", note: p.note || "", transport: p.transport || null,
                toLat: p.to_lat ?? null, toLng: p.to_lng ?? null, toLabel: p.to_label || "",
                position: p.position ?? 0,
              })),
          }))
          .sort((a, b) => (a.date || "").localeCompare(b.date || "")),
        restaurants: restaurantsRows.filter((r) => r.trip_id === t.id).map((r) => ({ id: r.id, name: r.name || "", address: r.address || "", note: r.note || "" })),
        highlights: highlightsRows.filter((h) => h.trip_id === t.id).map((h) => ({ id: h.id, title: h.title || "", note: h.note || "" })),
        favorites: favoritesRows.filter((f) => f.trip_id === t.id).map((f) => ({ id: f.id, pointId: f.point_id, note: f.note || "" })),
      }));
      const photosMap = {};
      for (const ph of photosRows) {
        (photosMap[ph.day_id] ||= []).push({ id: ph.id, src: ph.src, pointId: ph.point_id });
      }
      const restaurantPhotosMap = {};
      for (const ph of restaurantPhotosRows) {
        (restaurantPhotosMap[ph.restaurant_id] ||= []).push({ id: ph.id, src: ph.src });
      }
      const highlightPhotosMap = {};
      for (const ph of highlightPhotosRows) {
        (highlightPhotosMap[ph.highlight_id] ||= []).push({ id: ph.id, src: ph.src });
      }
      setTrips(assembled);
      setDayPhotos(photosMap);
      setRestaurantPhotos(restaurantPhotosMap);
      setHighlightPhotos(highlightPhotosMap);
      setDbStatus("ok");
      setDbError(null);
    } catch (err) {
      console.error("Načtení z databáze selhalo:", err);
      setDbStatus("error");
      setDbError(String(err.message || err));
    }
    setLoaded(true);
  }, []);

  useEffect(() => {
    loadAllData();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Realtime: appka poslouchá databázi na "živo", ale NIC si znovu nestahuje —
  // data ke změně přijdou rovnou v realtime zprávě a appka si jen upraví
  // svůj lokální strom. Šetří to Disk IO limit Supabase (žádné opakované
  // dotazy po každé jednotlivé úpravě).
  useEffect(() => {
    const mapPoint = (row) => ({
      id: row.id, lat: row.lat, lng: row.lng, label: row.label || "",
      kind: row.kind || "stop", note: row.note || "", transport: row.transport || null,
      toLat: row.to_lat ?? null, toLng: row.to_lng ?? null, toLabel: row.to_label || "",
      position: row.position ?? 0,
    });
    const sortPoints = (pts) => [...pts].sort((a, b) => (a.position ?? 0) - (b.position ?? 0));
    const sortDays = (days) => [...days].sort((a, b) => (a.date || "").localeCompare(b.date || ""));

    const onTrips = ({ eventType, new: n, old: o }) => {
      setTrips((prev) => {
        if (eventType === "DELETE") return removeById(prev, o.id);
        const idx = prev.findIndex((t) => t.id === n.id);
        if (idx === -1) return [...prev, { id: n.id, name: n.name, spotifyUrl: n.spotify_url || "", days: [], restaurants: [], highlights: [], favorites: [] }];
        const next = [...prev];
        next[idx] = { ...next[idx], name: n.name, spotifyUrl: n.spotify_url || "" };
        return next;
      });
    };

    const onDays = ({ eventType, new: n, old: o }) => {
      setTrips((prev) => prev.map((t) => {
        if (eventType === "DELETE") {
          if (!t.days.some((d) => d.id === o.id)) return t;
          return { ...t, days: t.days.filter((d) => d.id !== o.id) };
        }
        if (t.id !== n.trip_id) return t;
        const existing = t.days.find((d) => d.id === n.id);
        const mapped = { id: n.id, title: n.title || "", date: n.date || "", points: existing?.points || [] };
        return { ...t, days: sortDays(upsertById(t.days, mapped)) };
      }));
    };

    const onPoints = ({ eventType, new: n, old: o }) => {
      const dayId = eventType === "DELETE" ? o.day_id : n.day_id;
      const pointId = eventType === "DELETE" ? o.id : n.id;
      setTrips((prev) => prev.map((t) => {
        const dIdx = t.days.findIndex((d) => d.id === dayId);
        if (dIdx === -1) return t;
        const day = t.days[dIdx];
        const points = eventType === "DELETE" ? removeById(day.points, pointId) : sortPoints(upsertById(day.points, mapPoint(n)));
        const days = [...t.days];
        days[dIdx] = { ...day, points };
        return { ...t, days };
      }));
      if (eventType === "DELETE") {
        setDayPhotos((prev) => ({ ...prev, [dayId]: (prev[dayId] || []).map((ph) => (ph.pointId === pointId ? { ...ph, pointId: null } : ph)) }));
      }
    };

    const onPhotos = ({ eventType, new: n, old: o }) => {
      const dayId = eventType === "DELETE" ? o.day_id : n.day_id;
      setDayPhotos((prev) => {
        const list = prev[dayId] || [];
        const next = eventType === "DELETE" ? removeById(list, o.id) : upsertById(list, { id: n.id, src: n.src, pointId: n.point_id });
        return { ...prev, [dayId]: next };
      });
    };

    const onRestaurants = ({ eventType, new: n, old: o }) => {
      setTrips((prev) => prev.map((t) => {
        if (eventType === "DELETE") {
          if (!t.restaurants.some((r) => r.id === o.id)) return t;
          return { ...t, restaurants: removeById(t.restaurants, o.id) };
        }
        if (t.id !== n.trip_id) return t;
        return { ...t, restaurants: upsertById(t.restaurants, { id: n.id, name: n.name || "", address: n.address || "", note: n.note || "" }) };
      }));
      if (eventType === "DELETE") setRestaurantPhotos((prev) => { const next = { ...prev }; delete next[o.id]; return next; });
    };

    const onRestaurantPhotos = ({ eventType, new: n, old: o }) => {
      const rid = eventType === "DELETE" ? o.restaurant_id : n.restaurant_id;
      setRestaurantPhotos((prev) => {
        const list = prev[rid] || [];
        const next = eventType === "DELETE" ? removeById(list, o.id) : upsertById(list, { id: n.id, src: n.src });
        return { ...prev, [rid]: next };
      });
    };

    const onHighlights = ({ eventType, new: n, old: o }) => {
      setTrips((prev) => prev.map((t) => {
        if (eventType === "DELETE") {
          if (!t.highlights.some((h) => h.id === o.id)) return t;
          return { ...t, highlights: removeById(t.highlights, o.id) };
        }
        if (t.id !== n.trip_id) return t;
        return { ...t, highlights: upsertById(t.highlights, { id: n.id, title: n.title || "", note: n.note || "" }) };
      }));
      if (eventType === "DELETE") setHighlightPhotos((prev) => { const next = { ...prev }; delete next[o.id]; return next; });
    };

    const onHighlightPhotos = ({ eventType, new: n, old: o }) => {
      const hid = eventType === "DELETE" ? o.highlight_id : n.highlight_id;
      setHighlightPhotos((prev) => {
        const list = prev[hid] || [];
        const next = eventType === "DELETE" ? removeById(list, o.id) : upsertById(list, { id: n.id, src: n.src });
        return { ...prev, [hid]: next };
      });
    };

    const onFavorites = ({ eventType, new: n, old: o }) => {
      setTrips((prev) => prev.map((t) => {
        if (eventType === "DELETE") {
          if (!t.favorites.some((f) => f.id === o.id)) return t;
          return { ...t, favorites: removeById(t.favorites, o.id) };
        }
        if (t.id !== n.trip_id) return t;
        return { ...t, favorites: upsertById(t.favorites, { id: n.id, pointId: n.point_id, note: n.note || "" }) };
      }));
    };

    const channel = supabaseClient
      .channel("cd-realtime")
      .on("postgres_changes", { event: "*", schema: "public", table: "trips" }, onTrips)
      .on("postgres_changes", { event: "*", schema: "public", table: "days" }, onDays)
      .on("postgres_changes", { event: "*", schema: "public", table: "points" }, onPoints)
      .on("postgres_changes", { event: "*", schema: "public", table: "photos" }, onPhotos)
      .on("postgres_changes", { event: "*", schema: "public", table: "restaurants" }, onRestaurants)
      .on("postgres_changes", { event: "*", schema: "public", table: "restaurant_photos" }, onRestaurantPhotos)
      .on("postgres_changes", { event: "*", schema: "public", table: "highlights" }, onHighlights)
      .on("postgres_changes", { event: "*", schema: "public", table: "highlight_photos" }, onHighlightPhotos)
      .on("postgres_changes", { event: "*", schema: "public", table: "favorites" }, onFavorites)
      .subscribe();

    return () => {
      supabaseClient.removeChannel(channel);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const withSave = useCallback(async (fn) => {
    try {
      await fn();
      setDbStatus("ok");
      setDbError(null);
      setLastSavedAt(Date.now());
    } catch (err) {
      console.error("Uložení selhalo:", err);
      setDbStatus("error");
      setDbError(String(err.message || err));
    }
  }, []);

  const photoCounts = useMemo(() => {
    const map = {};
    for (const dayId of Object.keys(dayPhotos)) map[dayId] = dayPhotos[dayId].length;
    return map;
  }, [dayPhotos]);

  const currentTrip = view.tripId ? trips.find((t) => t.id === view.tripId) : null;
  const currentDay = currentTrip && view.dayId ? currentTrip.days.find((d) => d.id === view.dayId) : null;

  const createTrip = (name) => {
    const id = uid();
    setTrips((prev) => [{ id, name, spotifyUrl: "", days: [], restaurants: [], highlights: [], favorites: [] }, ...prev]);
    withSave(() => sb("trips", { method: "POST", body: JSON.stringify({ id, name }) }));
  };

  const updateTripSpotify = (tripId, spotifyUrl) => {
    setTrips((prev) => prev.map((t) => t.id !== tripId ? t : { ...t, spotifyUrl }));
    withSave(() => sb(`trips?id=eq.${tripId}`, { method: "PATCH", body: JSON.stringify({ spotify_url: spotifyUrl || null }) }));
  };

  const deleteTrip = (tripId) => {
    setTrips((prev) => prev.filter((t) => t.id !== tripId));
    setView({ screen: "list" });
    withSave(() => sb(`trips?id=eq.${tripId}`, { method: "DELETE", prefer: "return=minimal" }));
  };

  const addDay = (tripId) => {
    const id = uid();
    const day = { id, title: "", date: todayISO(), points: [] };
    setTrips((prev) => prev.map((t) => {
      if (t.id !== tripId) return t;
      const sorted = [...t.days, day].sort((a, b) => (a.date || "").localeCompare(b.date || ""));
      return { ...t, days: sorted };
    }));
    setView({ screen: "day", tripId, dayId: id });
    withSave(() => sb("days", { method: "POST", body: JSON.stringify({ id, trip_id: tripId, title: "", date: day.date }) }));
  };

  const updateDay = (tripId, dayId, patch) => {
    setTrips((prev) => prev.map((t) => {
      if (t.id !== tripId) return t;
      let days = t.days.map((d) => d.id === dayId ? { ...d, ...patch } : d);
      if ("date" in patch) days = [...days].sort((a, b) => (a.date || "").localeCompare(b.date || ""));
      return { ...t, days };
    }));
    withSave(() => sb(`days?id=eq.${dayId}`, { method: "PATCH", body: JSON.stringify(patch) }));
  };

  const addItem = (tripId, dayId, { kind, lat, lng, label, toLat, toLng, toLabel, transport }) => {
    const id = uid();
    let position = 0;
    setTrips((prev) => prev.map((t) => {
      if (t.id !== tripId) return t;
      return { ...t, days: t.days.map((d) => {
        if (d.id !== dayId) return d;
        position = d.points.length;
        const item = { id, kind: kind || "stop", lat, lng, label: label || "", toLat: toLat ?? null, toLng: toLng ?? null, toLabel: toLabel || "", transport: transport || (kind === "route" ? "car" : null), position };
        return { ...d, points: [...d.points, item] };
      }) };
    }));
    withSave(() => sb("points", {
      method: "POST",
      body: JSON.stringify({
        id, day_id: dayId, lat, lng, label: label || "", kind: kind || "stop", position,
        to_lat: toLat ?? null, to_lng: toLng ?? null, to_label: toLabel || null,
        transport: transport || (kind === "route" ? "car" : null),
      }),
    }));
  };

  const renameItem = (tripId, dayId, pointId, patch) => {
    setTrips((prev) => prev.map((t) => t.id !== tripId ? t : {
      ...t, days: t.days.map((d) => d.id !== dayId ? d : { ...d, points: d.points.map((p) => p.id === pointId ? { ...p, ...patch } : p) }),
    }));
    const dbPatch = {};
    if ("label" in patch) dbPatch.label = patch.label;
    if ("toLabel" in patch) dbPatch.to_label = patch.toLabel;
    if ("note" in patch) dbPatch.note = patch.note;
    if ("transport" in patch) dbPatch.transport = patch.transport;
    withSave(() => sb(`points?id=eq.${pointId}`, { method: "PATCH", body: JSON.stringify(dbPatch) }));
  };

  const removeItem = (tripId, dayId, pointId) => {
    let remaining = null;
    setTrips((prev) => prev.map((t) => t.id !== tripId ? t : {
      ...t, days: t.days.map((d) => {
        if (d.id !== dayId) return d;
        remaining = d.points.filter((p) => p.id !== pointId);
        return { ...d, points: remaining };
      }),
    }));
    setDayPhotos((prev) => ({
      ...prev,
      [dayId]: (prev[dayId] || []).map((ph) => (ph.pointId === pointId ? { ...ph, pointId: null } : ph)),
    }));
    withSave(() => sb(`points?id=eq.${pointId}`, { method: "DELETE", prefer: "return=minimal" }));
    // Přečíslujeme zbylé položky na 0..n-1, ať se pořadí po smazání nerozhodí.
    if (remaining) {
      remaining.forEach((p, idx) => {
        withSave(() => sb(`points?id=eq.${p.id}`, { method: "PATCH", body: JSON.stringify({ position: idx }) }));
      });
    }
  };

  const reorderItems = (tripId, dayId, orderedPoints) => {
    const withPositions = orderedPoints.map((p, idx) => ({ ...p, position: idx }));
    setTrips((prev) => prev.map((t) => t.id !== tripId ? t : {
      ...t, days: t.days.map((d) => d.id !== dayId ? d : { ...d, points: withPositions }),
    }));
    withPositions.forEach((p) => {
      withSave(() => sb(`points?id=eq.${p.id}`, { method: "PATCH", body: JSON.stringify({ position: p.position }) }));
    });
  };

  // ---- Jídlo (restaurace) ----
  const addRestaurant = (tripId) => {
    const id = uid();
    let position = 0;
    setTrips((prev) => prev.map((t) => {
      if (t.id !== tripId) return t;
      position = t.restaurants.length;
      return { ...t, restaurants: [...t.restaurants, { id, name: "", address: "", note: "" }] };
    }));
    withSave(() => sb("restaurants", { method: "POST", body: JSON.stringify({ id, trip_id: tripId, name: "", address: "", note: "", position }) }));
  };

  const updateRestaurant = (tripId, id, patch) => {
    setTrips((prev) => prev.map((t) => t.id !== tripId ? t : { ...t, restaurants: t.restaurants.map((r) => r.id === id ? { ...r, ...patch } : r) }));
    withSave(() => sb(`restaurants?id=eq.${id}`, { method: "PATCH", body: JSON.stringify(patch) }));
  };

  const removeRestaurant = (tripId, id) => {
    setTrips((prev) => prev.map((t) => t.id !== tripId ? t : { ...t, restaurants: t.restaurants.filter((r) => r.id !== id) }));
    setRestaurantPhotos((prev) => { const next = { ...prev }; delete next[id]; return next; });
    withSave(() => sb(`restaurants?id=eq.${id}`, { method: "DELETE", prefer: "return=minimal" }));
  };

  const addRestaurantPhoto = async (restaurantId, blob) => {
    const id = uid();
    const src = await uploadPhotoBlob(blob, `restaurants/${restaurantId}/${id}.jpg`);
    const photo = { id, src };
    setRestaurantPhotos((prev) => ({ ...prev, [restaurantId]: [...(prev[restaurantId] || []), photo] }));
    await withSave(() => sb("restaurant_photos", { method: "POST", body: JSON.stringify([{ id, restaurant_id: restaurantId, src }]) }));
  };

  const removeRestaurantPhoto = (restaurantId, photoId) => {
    const photo = (restaurantPhotos[restaurantId] || []).find((p) => p.id === photoId);
    if (photo) deletePhotoFromStorage(photo.src);
    setRestaurantPhotos((prev) => ({ ...prev, [restaurantId]: (prev[restaurantId] || []).filter((p) => p.id !== photoId) }));
    withSave(() => sb(`restaurant_photos?id=eq.${photoId}`, { method: "DELETE", prefer: "return=minimal" }));
  };

  // ---- Zajímavosti ----
  const addHighlight = (tripId) => {
    const id = uid();
    let position = 0;
    setTrips((prev) => prev.map((t) => {
      if (t.id !== tripId) return t;
      position = t.highlights.length;
      return { ...t, highlights: [...t.highlights, { id, title: "", note: "" }] };
    }));
    withSave(() => sb("highlights", { method: "POST", body: JSON.stringify({ id, trip_id: tripId, title: "", note: "", position }) }));
  };

  const updateHighlight = (tripId, id, patch) => {
    setTrips((prev) => prev.map((t) => t.id !== tripId ? t : { ...t, highlights: t.highlights.map((h) => h.id === id ? { ...h, ...patch } : h) }));
    withSave(() => sb(`highlights?id=eq.${id}`, { method: "PATCH", body: JSON.stringify(patch) }));
  };

  const removeHighlight = (tripId, id) => {
    setTrips((prev) => prev.map((t) => t.id !== tripId ? t : { ...t, highlights: t.highlights.filter((h) => h.id !== id) }));
    setHighlightPhotos((prev) => { const next = { ...prev }; delete next[id]; return next; });
    withSave(() => sb(`highlights?id=eq.${id}`, { method: "DELETE", prefer: "return=minimal" }));
  };

  const addHighlightPhoto = async (highlightId, blob) => {
    const id = uid();
    const src = await uploadPhotoBlob(blob, `highlights/${highlightId}/${id}.jpg`);
    const photo = { id, src };
    setHighlightPhotos((prev) => ({ ...prev, [highlightId]: [...(prev[highlightId] || []), photo] }));
    await withSave(() => sb("highlight_photos", { method: "POST", body: JSON.stringify([{ id, highlight_id: highlightId, src }]) }));
  };

  const removeHighlightPhoto = (highlightId, photoId) => {
    const photo = (highlightPhotos[highlightId] || []).find((p) => p.id === photoId);
    if (photo) deletePhotoFromStorage(photo.src);
    setHighlightPhotos((prev) => ({ ...prev, [highlightId]: (prev[highlightId] || []).filter((p) => p.id !== photoId) }));
    withSave(() => sb(`highlight_photos?id=eq.${photoId}`, { method: "DELETE", prefer: "return=minimal" }));
  };

  // ---- Nejlepší místa (výběr z bodů dní) ----
  const addFavorite = (tripId, pointId) => {
    const id = uid();
    let position = 0;
    let already = false;
    setTrips((prev) => prev.map((t) => {
      if (t.id !== tripId) return t;
      if (t.favorites.some((f) => f.pointId === pointId)) { already = true; return t; }
      position = t.favorites.length;
      return { ...t, favorites: [...t.favorites, { id, pointId, note: "" }] };
    }));
    if (already) return;
    withSave(() => sb("favorites", { method: "POST", body: JSON.stringify({ id, trip_id: tripId, point_id: pointId, note: "", position }) }));
  };

  const updateFavoriteNote = (tripId, id, note) => {
    setTrips((prev) => prev.map((t) => t.id !== tripId ? t : { ...t, favorites: t.favorites.map((f) => f.id === id ? { ...f, note } : f) }));
    withSave(() => sb(`favorites?id=eq.${id}`, { method: "PATCH", body: JSON.stringify({ note }) }));
  };

  const removeFavorite = (tripId, id) => {
    setTrips((prev) => prev.map((t) => t.id !== tripId ? t : { ...t, favorites: t.favorites.filter((f) => f.id !== id) }));
    withSave(() => sb(`favorites?id=eq.${id}`, { method: "DELETE", prefer: "return=minimal" }));
  };

  const addPhotoToDay = async (tripId, dayId, blob, pointId) => {
    const id = uid();
    const src = await uploadPhotoBlob(blob, `days/${dayId}/${id}.jpg`);
    const photo = { id, src, pointId: pointId || null };
    setDayPhotos((prev) => ({ ...prev, [dayId]: [...(prev[dayId] || []), photo] }));
    await withSave(() => sb("photos", {
      method: "POST",
      body: JSON.stringify([{ id, day_id: dayId, point_id: photo.pointId, src }]),
    }));
  };

  const removePhotoFromDay = (tripId, dayId, photoId) => {
    const photo = (dayPhotos[dayId] || []).find((p) => p.id === photoId);
    if (photo) deletePhotoFromStorage(photo.src);
    setDayPhotos((prev) => ({ ...prev, [dayId]: (prev[dayId] || []).filter((p) => p.id !== photoId) }));
    withSave(() => sb(`photos?id=eq.${photoId}`, { method: "DELETE", prefer: "return=minimal" }));
  };

  return (
    <div style={{ fontFamily: "'Inter', -apple-system, BlinkMacSystemFont, sans-serif", background: PALETTE.paper, minHeight: "100vh", maxWidth: 480, margin: "0 auto", position: "relative" }}>
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=Fraunces:opsz,wght@9..144,500;9..144,600;9..144,700&family=Inter:wght@400;500;600;700&display=swap');
        * { box-sizing: border-box; }
        input:focus, button:focus { outline: 2px solid ${PALETTE.teal}; outline-offset: 1px; }
        button { font-family: inherit; }
        .cd-spin { animation: cd-spin 0.8s linear infinite; }
        @keyframes cd-spin { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }
        .cd-fadein { animation: cd-fade 0.5s ease; }
        @keyframes cd-fade { from { opacity: 0; } to { opacity: 1; } }
        .leaflet-control-attribution { font-size: 9px !important; }
        .cd-map-label .leaflet-tooltip { background: ${PALETTE.ink}; color: ${PALETTE.cream}; border: none; font-family: 'Inter', sans-serif; font-size: 11px; padding: 3px 8px; border-radius: 6px; }
      `}</style>

      {!loaded ? (
        <div style={{ padding: 40, textAlign: "center", color: PALETTE.ink, opacity: 0.5 }}>Načítám deník…</div>
      ) : isGuest ? (
        view.screen === "guest-list" ? (
          <GuestTripListScreen trips={trips} onOpenTrip={(id) => setView({ screen: "guest-trip", tripId: id })} />
        ) : view.screen === "guest-trip" && currentTrip ? (
          <GuestTripScreen
            trip={currentTrip}
            photoCounts={photoCounts}
            onBack={() => setView({ screen: "guest-list" })}
            onPlayAll={() => setView({ screen: "presentation", tripId: currentTrip.id })}
            onPlayDay={(dayId) => setView({ screen: "presentation", tripId: currentTrip.id, dayId })}
            onOpenFood={() => setView({ screen: "guest-food", tripId: currentTrip.id })}
            onOpenHighlights={() => setView({ screen: "guest-highlights", tripId: currentTrip.id })}
            onOpenPlaces={() => setView({ screen: "guest-places", tripId: currentTrip.id })}
          />
        ) : view.screen === "guest-food" && currentTrip ? (
          <GuestEntriesScreen
            title="Jídlo"
            emptyText="Zatím žádná restaurace."
            entries={currentTrip.restaurants}
            photosMap={restaurantPhotos}
            onBack={() => setView({ screen: "guest-trip", tripId: currentTrip.id })}
            renderReadRow={(item, photos, openViewer) => (
              <div key={item.id} style={{ background: PALETTE.cream, border: `1px solid ${PALETTE.paperDeep}`, borderRadius: 12, padding: 12 }}>
                <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                  <Utensils size={16} color={PALETTE.coral} />
                  <div style={{ fontWeight: 600, fontSize: 15, color: PALETTE.ink }}>{item.name || "Bez názvu"}</div>
                </div>
                {item.address && <div style={{ fontSize: 12.5, color: PALETTE.teal, marginTop: 4 }}>{item.address}</div>}
                {item.note && <div style={{ fontSize: 13, color: PALETTE.ink, opacity: 0.8, marginTop: 6, lineHeight: 1.5 }}>{item.note}</div>}
                <ViewPhotoGrid photos={photos} onOpen={openViewer} />
              </div>
            )}
          />
        ) : view.screen === "guest-highlights" && currentTrip ? (
          <GuestEntriesScreen
            title="Zajímavosti"
            emptyText="Zatím žádná zajímavost."
            entries={currentTrip.highlights}
            photosMap={highlightPhotos}
            onBack={() => setView({ screen: "guest-trip", tripId: currentTrip.id })}
            renderReadRow={(item, photos, openViewer) => (
              <div key={item.id} style={{ background: PALETTE.cream, border: `1px solid ${PALETTE.paperDeep}`, borderRadius: 12, padding: 12 }}>
                <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                  <Sparkles size={16} color={PALETTE.gold} />
                  <div style={{ fontWeight: 600, fontSize: 15, color: PALETTE.ink }}>{item.title || "Bez názvu"}</div>
                </div>
                {item.note && <div style={{ fontSize: 13, color: PALETTE.ink, opacity: 0.8, marginTop: 6, lineHeight: 1.5 }}>{item.note}</div>}
                <ViewPhotoGrid photos={photos} onOpen={openViewer} />
              </div>
            )}
          />
        ) : view.screen === "guest-places" && currentTrip ? (
          <GuestFavoritesScreen trip={currentTrip} favorites={currentTrip.favorites} onBack={() => setView({ screen: "guest-trip", tripId: currentTrip.id })} />
        ) : view.screen === "presentation" && currentTrip ? (
          <PresentationScreen
            trip={view.dayId ? { ...currentTrip, days: currentTrip.days.filter((d) => d.id === view.dayId) } : currentTrip}
            allPhotos={dayPhotos}
            onExit={() => setView({ screen: "guest-trip", tripId: currentTrip.id })}
            spotifyUrl={currentTrip.spotifyUrl}
            onSetSpotifyUrl={() => {}}
            readOnly
          />
        ) : (
          <div style={{ padding: 40, textAlign: "center" }}>
            <button onClick={() => setView({ screen: "guest-list" })} style={btnPrimary}>Zpět na seznam</button>
          </div>
        )
      ) : view.screen === "list" ? (
        <TripListScreen
          trips={trips}
          onOpenTrip={(id) => setView({ screen: "trip", tripId: id })}
          onCreateTrip={createTrip}
          dbStatus={dbStatus}
          dbError={dbError}
          lastSavedAt={lastSavedAt}
          onRefresh={loadAllData}
        />
      ) : view.screen === "trip" && currentTrip ? (
        <TripDetailScreen
          trip={currentTrip}
          photoCounts={photoCounts}
          onBack={() => setView({ screen: "list" })}
          onAddDay={() => addDay(currentTrip.id)}
          onOpenDay={(dayId) => setView({ screen: "day", tripId: currentTrip.id, dayId })}
          onStartPresentation={() => setView({ screen: "presentation", tripId: currentTrip.id })}
          onPlayDay={(dayId) => setView({ screen: "presentation", tripId: currentTrip.id, dayId })}
          onOpenRestaurants={() => setView({ screen: "restaurants", tripId: currentTrip.id })}
          onOpenHighlights={() => setView({ screen: "highlights", tripId: currentTrip.id })}
          onOpenFavorites={() => setView({ screen: "favorites", tripId: currentTrip.id })}
          onDeleteTrip={() => deleteTrip(currentTrip.id)}
        />
      ) : view.screen === "restaurants" && currentTrip ? (
        <EntriesScreen
          title="Jídlo"
          emptyText="Zatím žádná restaurace — přidej první."
          addLabel="Přidat restauraci"
          entries={currentTrip.restaurants}
          photosMap={restaurantPhotos}
          onBack={() => setView({ screen: "trip", tripId: currentTrip.id })}
          onAddEntry={() => addRestaurant(currentTrip.id)}
          onAddPhoto={(entryId, src) => addRestaurantPhoto(entryId, src)}
          onRemovePhoto={(entryId, photoId) => removeRestaurantPhoto(entryId, photoId)}
          renderRow={(item, photos, pendingCount, openFilePicker, onOpenPhoto) => (
            <RestaurantRow
              key={item.id}
              item={item}
              photos={photos}
              pendingCount={pendingCount}
              onUpdate={(id, patch) => updateRestaurant(currentTrip.id, id, patch)}
              onRemove={(id) => removeRestaurant(currentTrip.id, id)}
              onOpenPhoto={onOpenPhoto}
              onAddPhoto={openFilePicker}
            />
          )}
        />
      ) : view.screen === "highlights" && currentTrip ? (
        <EntriesScreen
          title="Zajímavosti"
          emptyText="Zatím žádná zajímavost — přidej první."
          addLabel="Přidat zajímavost"
          entries={currentTrip.highlights}
          photosMap={highlightPhotos}
          onBack={() => setView({ screen: "trip", tripId: currentTrip.id })}
          onAddEntry={() => addHighlight(currentTrip.id)}
          onAddPhoto={(entryId, src) => addHighlightPhoto(entryId, src)}
          onRemovePhoto={(entryId, photoId) => removeHighlightPhoto(entryId, photoId)}
          renderRow={(item, photos, pendingCount, openFilePicker, onOpenPhoto) => (
            <HighlightRow
              key={item.id}
              item={item}
              photos={photos}
              pendingCount={pendingCount}
              onUpdate={(id, patch) => updateHighlight(currentTrip.id, id, patch)}
              onRemove={(id) => removeHighlight(currentTrip.id, id)}
              onOpenPhoto={onOpenPhoto}
              onAddPhoto={openFilePicker}
            />
          )}
        />
      ) : view.screen === "favorites" && currentTrip ? (
        <FavoritesScreen
          trip={currentTrip}
          favorites={currentTrip.favorites}
          onBack={() => setView({ screen: "trip", tripId: currentTrip.id })}
          onAddFavorite={(pointId) => addFavorite(currentTrip.id, pointId)}
          onUpdateNote={(id, note) => updateFavoriteNote(currentTrip.id, id, note)}
          onRemoveFavorite={(id) => removeFavorite(currentTrip.id, id)}
        />
      ) : view.screen === "day" && currentTrip && currentDay ? (
        <DayDetailScreen
          key={currentDay.id}
          day={currentDay}
          photos={dayPhotos[currentDay.id] || []}
          onBack={() => setView({ screen: "trip", tripId: currentTrip.id })}
          onUpdateDay={(patch) => updateDay(currentTrip.id, currentDay.id, patch)}
          onAddItem={(item) => addItem(currentTrip.id, currentDay.id, item)}
          onRenameItem={(pointId, patch) => renameItem(currentTrip.id, currentDay.id, pointId, patch)}
          onRemoveItem={(pointId) => removeItem(currentTrip.id, currentDay.id, pointId)}
          onReorderItems={(orderedPoints) => reorderItems(currentTrip.id, currentDay.id, orderedPoints)}
          onAddPhoto={(src, pointId) => addPhotoToDay(currentTrip.id, currentDay.id, src, pointId)}
          onRemovePhoto={(photoId) => removePhotoFromDay(currentTrip.id, currentDay.id, photoId)}
        />
      ) : view.screen === "presentation" && currentTrip ? (
        <PresentationScreen
          trip={view.dayId ? { ...currentTrip, days: currentTrip.days.filter((d) => d.id === view.dayId) } : currentTrip}
          allPhotos={dayPhotos}
          onExit={() => setView({ screen: "trip", tripId: currentTrip.id })}
          spotifyUrl={currentTrip.spotifyUrl}
          onSetSpotifyUrl={(url) => updateTripSpotify(currentTrip.id, url)}
        />
      ) : (
        <div style={{ padding: 40, textAlign: "center" }}>
          <button onClick={() => setView({ screen: "list" })} style={btnPrimary}>Zpět na seznam</button>
        </div>
      )}
    </div>
  );
}
