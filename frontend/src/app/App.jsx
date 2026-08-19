import React, { useState, useEffect, useRef, useCallback, useMemo } from "react";
import {
  Plus, ChevronLeft, Camera, X, Play, Pause, MapPin,
  SkipBack, SkipForward, Music, Trash2, Calendar, Search, Loader2
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

// Zmenší a zkomprimuje fotku na rozumnou velikost před uložením.
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
        resolve(canvas.toDataURL("image/jpeg", quality));
      };
      img.onerror = reject;
      img.src = reader.result;
    };
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

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

function StopBadge({ index, total, size = 24 }) {
  const color = index === 0 ? PALETTE.teal : index === total - 1 ? PALETTE.coral : PALETTE.gold;
  return (
    <div style={{
      width: size, height: size, borderRadius: "50%", background: color, color: "#fff",
      display: "flex", alignItems: "center", justifyContent: "center",
      fontSize: size * 0.46, fontWeight: 700, flexShrink: 0,
    }}>
      {index + 1}
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

/**
 * points: [{ id, lat, lng, label }]
 * onAddPoint({lat,lng,label}): voláno při klepnutí na mapu nebo výběru z vyhledávání
 * focusPointId: zúží a vycentruje mapu na daný bod, ostatní ztlumí
 * showLabelsAlways: trvalé popisky u všech pojmenovaných bodů
 */
function RouteMap({ points, onAddPoint, editable, height = 220, focusPointId = null, showLabelsAlways = false }) {
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

  useEffect(() => {
    let cancelled = false;
    loadLeaflet()
      .then((L) => {
        if (cancelled || !containerRef.current || mapRef.current) return;
        const start = points[0] ? [points[0].lat, points[0].lng] : [49.82, 15.47];
        const map = L.map(containerRef.current, {
          zoomControl: editable,
          scrollWheelZoom: editable,
          dragging: true,
          tap: true,
        }).setView(start, points.length ? 12 : 7);

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

    if (points.length > 0) {
      if (points.length > 1) {
        const latlngs = points.map((p) => [p.lat, p.lng]);
        L.polyline(latlngs, { color: PALETTE.coral, weight: 3, dashArray: "1 8", lineCap: "round" }).addTo(layerRef.current);
      }

      points.forEach((p, i) => {
        const isFocused = focusPointId === p.id;
        const isDimmed = focusPointId && !isFocused;
        const baseColor = i === 0 ? PALETTE.teal : i === points.length - 1 ? PALETTE.coral : PALETTE.gold;

        const marker = L.circleMarker([p.lat, p.lng], {
          radius: isFocused ? 10 : isDimmed ? 4 : 6,
          weight: isFocused ? 3 : 2,
          color: "#fff",
          fillColor: baseColor,
          fillOpacity: isDimmed ? 0.35 : 1,
        }).addTo(layerRef.current);

        if (p.label && (isFocused || showLabelsAlways)) {
          marker.bindTooltip(p.label, { permanent: true, direction: "top", offset: [0, -6], className: "cd-map-label" });
        }
      });

      if (focusPointId) {
        const p = points.find((pt) => pt.id === focusPointId);
        if (p) mapRef.current.setView([p.lat, p.lng], 15);
      } else if (points.length > 1) {
        mapRef.current.fitBounds(points.map((p) => [p.lat, p.lng]), { padding: [30, 30] });
      } else {
        mapRef.current.setView([points[0].lat, points[0].lng], 13);
      }
      setTimeout(() => mapRef.current && mapRef.current.invalidateSize(), 100);
    }
  }, [points, ready, focusPointId, showLabelsAlways]);

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

function TripListScreen({ trips, onOpenTrip, onCreateTrip, dbStatus, dbError, lastSavedAt }) {
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
      <p style={{ fontSize: 11.5, margin: "0 0 8px", color: dbStatus === "error" ? "#B4432E" : PALETTE.teal }}>
        {dbStatus === "loading" && "Připojuji databázi…"}
        {dbStatus === "ok" && (lastSavedAt ? `Naposledy uloženo ${new Date(lastSavedAt).toLocaleTimeString("cs-CZ", { hour: "2-digit", minute: "2-digit" })}` : "Databáze připojena")}
        {dbStatus === "error" && "Poslední akce se nepodařila uložit — zkontroluj připojení"}
      </p>
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

function TripDetailScreen({ trip, photoCounts, onBack, onAddDay, onOpenDay, onStartPresentation, onDeleteTrip }) {
  const [confirmDelete, setConfirmDelete] = useState(false);

  return (
    <div style={{ padding: "16px 18px 90px" }}>
      <TopBar onBack={onBack} title={trip.name} />

      <div style={{ display: "flex", gap: 8, margin: "14px 0 20px" }}>
        <button onClick={onAddDay} style={{ ...btnPrimary, flex: 1 }}>
          <Plus size={16} style={{ marginRight: 6, verticalAlign: -3 }} /> Přidat den
        </button>
        {trip.days.length > 0 && (
          <button onClick={onStartPresentation} style={{ ...btnAccent, flex: 1 }}>
            <Play size={15} style={{ marginRight: 6, verticalAlign: -2 }} fill={PALETTE.cream} /> Prezentace
          </button>
        )}
      </div>

      {trip.days.length === 0 ? (
        <EmptyHint text="Přidej první den cesty — zastávky, fotky a mapu doplníš uvnitř." />
      ) : (
        <div style={{ position: "relative", paddingLeft: 22 }}>
          <div style={{ position: "absolute", left: 6, top: 6, bottom: 6, width: 2, background: `repeating-linear-gradient(to bottom, ${PALETTE.gold} 0 6px, transparent 6px 11px)` }} />
          <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
            {trip.days.map((day, i) => (
              <button
                key={day.id}
                onClick={() => onOpenDay(day.id)}
                style={{ position: "relative", textAlign: "left", background: PALETTE.cream, border: `1px solid ${PALETTE.paperDeep}`, borderRadius: 14, padding: "12px 14px", cursor: "pointer" }}
              >
                <div style={{ position: "absolute", left: -22, top: 18, width: 12, height: 12, borderRadius: "50%", background: PALETTE.coral, border: "2px solid " + PALETTE.paper }} />
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                  <div style={{ fontFamily: "'Fraunces', serif", fontWeight: 600, fontSize: 15.5, color: PALETTE.ink }}>
                    {day.title || `Den ${i + 1}`}
                  </div>
                  <span style={{ fontSize: 12, color: PALETTE.ink, opacity: 0.5 }}>{formatDateCz(day.date)}</span>
                </div>
                <div style={{ fontSize: 12.5, color: PALETTE.teal, marginTop: 4 }}>
                  {photoCounts[day.id] || 0} {(photoCounts[day.id] || 0) === 1 ? "fotka" : "fotek"} · {(day.points?.length || 0)} {(day.points?.length || 0) === 1 ? "zastávka" : "zastávek"}
                </div>
              </button>
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

function PhotoStrip({ photos, onOpen, onAdd, uploading }) {
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
      <button
        onClick={onAdd}
        disabled={uploading}
        style={{ flex: "0 0 auto", width: 62, height: 62, borderRadius: 9, border: `1.5px dashed ${PALETTE.gold}`, background: "transparent", display: "flex", alignItems: "center", justifyContent: "center", cursor: "pointer", color: PALETTE.gold }}
      >
        <Camera size={17} />
      </button>
    </div>
  );
}

function PointRow({ point, index, total, photos, onRename, onRemove, onOpenPhoto, onAddPhoto, uploading }) {
  const [label, setLabel] = useState(point.label);

  useEffect(() => {
    const t = setTimeout(() => { if (label !== point.label) onRename(point.id, label); }, 500);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [label]);

  return (
    <div style={{ background: PALETTE.cream, border: `1px solid ${PALETTE.paperDeep}`, borderRadius: 12, padding: 10 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <StopBadge index={index} total={total} />
        <input
          value={label}
          onChange={(e) => setLabel(e.target.value)}
          placeholder={`Zastávka ${index + 1}`}
          style={{ ...inputStyle, flex: 1, background: "#fff" }}
        />
        <button onClick={() => onRemove(point.id)} style={{ background: "none", border: "none", color: PALETTE.ink, opacity: 0.4, cursor: "pointer", padding: 4 }}>
          <X size={16} />
        </button>
      </div>
      <div style={{ marginTop: 8 }}>
        <PhotoStrip photos={photos} onOpen={onOpenPhoto} onAdd={() => onAddPhoto(point.id)} uploading={uploading} />
      </div>
    </div>
  );
}

function DayDetailScreen({ day, photos, onBack, onUpdateDay, onAddPoint, onRenamePoint, onRemovePoint, onAddPhotos, onRemovePhoto }) {
  const fileInputRef = useRef(null);
  const uploadTargetRef = useRef(null);
  const [title, setTitle] = useState(day.title || "");
  const [date, setDate] = useState(day.date || todayISO());
  const [uploading, setUploading] = useState(false);
  const [viewerPhoto, setViewerPhoto] = useState(null);

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

  const handleFiles = async (e) => {
    const files = Array.from(e.target.files || []);
    if (files.length === 0) return;
    setUploading(true);
    const compressed = [];
    for (const f of files) {
      try {
        compressed.push(await compressImage(f));
      } catch {
        // přeskoč soubor, který se nepodařilo zpracovat
      }
    }
    await onAddPhotos(compressed, uploadTargetRef.current);
    setUploading(false);
    e.target.value = "";
  };

  const points = day.points || [];
  const unassigned = photos.filter((p) => !p.pointId);

  return (
    <div style={{ padding: "16px 18px 90px" }}>
      <TopBar onBack={onBack} title="Den cesty" />

      <div style={{ margin: "16px 0 10px" }}>
        <input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Název dne, např. Lisabon → Sintra" style={{ ...inputStyle, width: "100%" }} />
      </div>
      <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 20 }}>
        <Calendar size={16} color={PALETTE.teal} />
        <input type="date" value={date} onChange={(e) => setDate(e.target.value)} style={{ ...inputStyle, flex: 1 }} />
      </div>

      <SectionLabel>Mapa dne</SectionLabel>
      <RouteMap points={points} onAddPoint={(p) => onAddPoint(p)} editable height={200} />

      <SectionLabel style={{ marginTop: 20 }}>Zastávky {points.length > 0 ? `(${points.length})` : ""}</SectionLabel>

      {points.length === 0 ? (
        <EmptyHint text="Zatím žádná zastávka — klepni na mapu nebo místo vyhledej." />
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
          {points.map((point, i) => (
            <PointRow
              key={point.id}
              point={point}
              index={i}
              total={points.length}
              photos={photos.filter((p) => p.pointId === point.id)}
              onRename={onRenamePoint}
              onRemove={onRemovePoint}
              onOpenPhoto={setViewerPhoto}
              onAddPhoto={openFilePicker}
              uploading={uploading}
            />
          ))}
        </div>
      )}

      <SectionLabel style={{ marginTop: 20 }}>Ostatní fotky dne</SectionLabel>
      <PhotoStrip photos={unassigned} onOpen={setViewerPhoto} onAdd={() => openFilePicker(null)} uploading={uploading} />

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
    photos.filter((ph) => !ph.pointId).forEach((ph) => {
      slides.push({ kind: "photo", dayId: day.id, pointId: null, photoId: ph.id });
    });
  });
  return slides;
}

function PresentationScreen({ trip, allPhotos, onExit }) {
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
    const dur = slide.kind === "day" ? 4200 : slide.kind === "point" ? 3000 : 3400;
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
        <button onClick={() => musicInputRef.current?.click()} style={iconBtnDark}><Music size={18} /></button>
      </div>
      <input ref={musicInputRef} type="file" accept="audio/*" onChange={pickMusic} style={{ display: "none" }} />

      <div style={{ height: 2, background: "rgba(244,239,227,0.15)", margin: "0 16px" }}>
        <div style={{ height: "100%", width: `${progress * 100}%`, background: PALETTE.coral, transition: "width 0.3s" }} />
      </div>

      <div key={idx} className="cd-fadein" style={{ flex: 1, display: "flex", flexDirection: "column", padding: "16px 20px", overflow: "hidden" }}>
        {slide.kind === "day" && (
          <>
            <div style={{ fontFamily: "'Fraunces', serif", fontSize: 22, fontWeight: 600, marginBottom: 2 }}>{day.title || `Den ${dayIndex + 1}`}</div>
            <div style={{ fontSize: 12.5, opacity: 0.6, marginBottom: 14 }}>{formatDateCz(day.date)}</div>
            <div style={{ flex: 1, minHeight: 0 }}><RouteMap points={day.points} editable={false} height="100%" showLabelsAlways /></div>
          </>
        )}
        {slide.kind === "point" && point && (
          <>
            <div style={{ fontSize: 11.5, opacity: 0.55, marginBottom: 2 }}>{day.title || `Den ${dayIndex + 1}`} · {formatDateCz(day.date)}</div>
            <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 14 }}>
              <MapPin size={20} color={PALETTE.coral} />
              <div style={{ fontFamily: "'Fraunces', serif", fontSize: 24, fontWeight: 600 }}>{point.label || `Zastávka ${day.points.indexOf(point) + 1}`}</div>
            </div>
            <div style={{ flex: 1, minHeight: 0 }}><RouteMap points={day.points} editable={false} height="100%" focusPointId={point.id} /></div>
          </>
        )}
        {slide.kind === "photo" && photo && (
          <>
            <div style={{ fontSize: 13, opacity: 0.75, marginBottom: 10, display: "flex", alignItems: "center", gap: 6 }}>
              {point ? <><MapPin size={13} color={PALETTE.coral} /> {point.label || "Zastávka"}</> : (day.title || `Den ${dayIndex + 1}`)}
            </div>
            <div style={{ flex: 1, borderRadius: 14, overflow: "hidden", background: "#000" }}>
              <img src={photo.src} alt="" style={{ width: "100%", height: "100%", objectFit: "contain" }} />
            </div>
          </>
        )}
      </div>

      <div style={{ padding: "10px 20px 26px" }}>
        {musicName && <div style={{ fontSize: 11, opacity: 0.5, textAlign: "center", marginBottom: 10 }}>♪ {musicName}</div>}
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
  const [trips, setTrips] = useState([]);
  const [dayPhotos, setDayPhotos] = useState({});
  const [loaded, setLoaded] = useState(false);
  const [view, setView] = useState({ screen: "list" });
  const [dbStatus, setDbStatus] = useState("loading"); // loading | ok | error
  const [dbError, setDbError] = useState(null);
  const [lastSavedAt, setLastSavedAt] = useState(null);

  // Načtení všech dat z databáze při startu (spojíme 4 tabulky do stromu v paměti).
  useEffect(() => {
    (async () => {
      try {
        const [tripsRows, daysRows, pointsRows, photosRows] = await Promise.all([
          sb("trips?select=*&order=created_at.asc"),
          sb("days?select=*&order=created_at.asc"),
          sb("points?select=*&order=position.asc"),
          sb("photos?select=*&order=created_at.asc"),
        ]);
        const assembled = tripsRows.map((t) => ({
          id: t.id,
          name: t.name,
          days: daysRows
            .filter((d) => d.trip_id === t.id)
            .map((d) => ({
              id: d.id,
              title: d.title || "",
              date: d.date || "",
              points: pointsRows
                .filter((p) => p.day_id === d.id)
                .map((p) => ({ id: p.id, lat: p.lat, lng: p.lng, label: p.label || "" })),
            })),
        }));
        const photosMap = {};
        for (const ph of photosRows) {
          (photosMap[ph.day_id] ||= []).push({ id: ph.id, src: ph.src, pointId: ph.point_id });
        }
        setTrips(assembled);
        setDayPhotos(photosMap);
        setDbStatus("ok");
        setDbError(null);
      } catch (err) {
        console.error("Načtení z databáze selhalo:", err);
        setDbStatus("error");
        setDbError(String(err.message || err));
      }
      setLoaded(true);
    })();
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
    setTrips((prev) => [{ id, name, days: [] }, ...prev]);
    withSave(() => sb("trips", { method: "POST", body: JSON.stringify({ id, name }) }));
  };

  const deleteTrip = (tripId) => {
    setTrips((prev) => prev.filter((t) => t.id !== tripId));
    setView({ screen: "list" });
    withSave(() => sb(`trips?id=eq.${tripId}`, { method: "DELETE", prefer: "return=minimal" }));
  };

  const addDay = (tripId) => {
    const id = uid();
    const day = { id, title: "", date: todayISO(), points: [] };
    setTrips((prev) => prev.map((t) => (t.id === tripId ? { ...t, days: [...t.days, day] } : t)));
    setView({ screen: "day", tripId, dayId: id });
    withSave(() => sb("days", { method: "POST", body: JSON.stringify({ id, trip_id: tripId, title: "", date: day.date }) }));
  };

  const updateDay = (tripId, dayId, patch) => {
    setTrips((prev) => prev.map((t) => t.id !== tripId ? t : { ...t, days: t.days.map((d) => d.id === dayId ? { ...d, ...patch } : d) }));
    withSave(() => sb(`days?id=eq.${dayId}`, { method: "PATCH", body: JSON.stringify(patch) }));
  };

  const addPoint = (tripId, dayId, { lat, lng, label }) => {
    const id = uid();
    let position = 0;
    setTrips((prev) => prev.map((t) => {
      if (t.id !== tripId) return t;
      return { ...t, days: t.days.map((d) => {
        if (d.id !== dayId) return d;
        position = d.points.length;
        return { ...d, points: [...d.points, { id, lat, lng, label: label || "" }] };
      }) };
    }));
    withSave(() => sb("points", { method: "POST", body: JSON.stringify({ id, day_id: dayId, lat, lng, label: label || "", position }) }));
  };

  const renamePoint = (tripId, dayId, pointId, label) => {
    setTrips((prev) => prev.map((t) => t.id !== tripId ? t : {
      ...t, days: t.days.map((d) => d.id !== dayId ? d : { ...d, points: d.points.map((p) => p.id === pointId ? { ...p, label } : p) }),
    }));
    withSave(() => sb(`points?id=eq.${pointId}`, { method: "PATCH", body: JSON.stringify({ label }) }));
  };

  const removePoint = (tripId, dayId, pointId) => {
    setTrips((prev) => prev.map((t) => t.id !== tripId ? t : {
      ...t, days: t.days.map((d) => d.id !== dayId ? d : { ...d, points: d.points.filter((p) => p.id !== pointId) }),
    }));
    setDayPhotos((prev) => ({
      ...prev,
      [dayId]: (prev[dayId] || []).map((ph) => (ph.pointId === pointId ? { ...ph, pointId: null } : ph)),
    }));
    withSave(() => sb(`points?id=eq.${pointId}`, { method: "DELETE", prefer: "return=minimal" }));
  };

  const addPhotosToDay = async (tripId, dayId, srcs, pointId) => {
    const newPhotos = srcs.map((src) => ({ id: uid(), src, pointId: pointId || null }));
    setDayPhotos((prev) => ({ ...prev, [dayId]: [...(prev[dayId] || []), ...newPhotos] }));
    await withSave(() => sb("photos", {
      method: "POST",
      body: JSON.stringify(newPhotos.map((p) => ({ id: p.id, day_id: dayId, point_id: p.pointId, src: p.src }))),
    }));
  };

  const removePhotoFromDay = (tripId, dayId, photoId) => {
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
      ) : view.screen === "list" ? (
        <TripListScreen
          trips={trips}
          onOpenTrip={(id) => setView({ screen: "trip", tripId: id })}
          onCreateTrip={createTrip}
          dbStatus={dbStatus}
          dbError={dbError}
          lastSavedAt={lastSavedAt}
        />
      ) : view.screen === "trip" && currentTrip ? (
        <TripDetailScreen
          trip={currentTrip}
          photoCounts={photoCounts}
          onBack={() => setView({ screen: "list" })}
          onAddDay={() => addDay(currentTrip.id)}
          onOpenDay={(dayId) => setView({ screen: "day", tripId: currentTrip.id, dayId })}
          onStartPresentation={() => setView({ screen: "presentation", tripId: currentTrip.id })}
          onDeleteTrip={() => deleteTrip(currentTrip.id)}
        />
      ) : view.screen === "day" && currentTrip && currentDay ? (
        <DayDetailScreen
          key={currentDay.id}
          day={currentDay}
          photos={dayPhotos[currentDay.id] || []}
          onBack={() => setView({ screen: "trip", tripId: currentTrip.id })}
          onUpdateDay={(patch) => updateDay(currentTrip.id, currentDay.id, patch)}
          onAddPoint={(p) => addPoint(currentTrip.id, currentDay.id, p)}
          onRenamePoint={(pointId, label) => renamePoint(currentTrip.id, currentDay.id, pointId, label)}
          onRemovePoint={(pointId) => removePoint(currentTrip.id, currentDay.id, pointId)}
          onAddPhotos={(srcs, pointId) => addPhotosToDay(currentTrip.id, currentDay.id, srcs, pointId)}
          onRemovePhoto={(photoId) => removePhotoFromDay(currentTrip.id, currentDay.id, photoId)}
        />
      ) : view.screen === "presentation" && currentTrip ? (
        <PresentationScreen trip={currentTrip} allPhotos={dayPhotos} onExit={() => setView({ screen: "trip", tripId: currentTrip.id })} />
      ) : (
        <div style={{ padding: 40, textAlign: "center" }}>
          <button onClick={() => setView({ screen: "list" })} style={btnPrimary}>Zpět na seznam</button>
        </div>
      )}
    </div>
  );
}
