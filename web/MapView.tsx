import * as maplibregl from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";
import { useEffect, useRef } from "react";
import type { Listing } from "./lib";

// Free vector tiles, no key needed: https://openfreemap.org
const STYLE_URL = "https://tiles.openfreemap.org/styles/liberty";

// Served by the app (see src/index.ts); the bundler can't inline MapLibre's worker.
maplibregl.setWorkerUrl("/vendor/maplibre-gl-worker.mjs");

type Props = {
  listings: Listing[];
  selectedId: number | null;
  label: (l: Listing) => string;
  onSelect: (id: number) => void;
};

export function MapView({ listings, selectedId, label, onSelect }: Props) {
  const container = useRef<HTMLDivElement>(null);
  const map = useRef<maplibregl.Map | null>(null);
  const markers = useRef(new Map<number, maplibregl.Marker>());
  const fittedKey = useRef("");
  const bounds = useRef<maplibregl.LngLatBounds | null>(null);
  // Once someone pans or zooms, stop re-framing the map under them.
  const userMoved = useRef(false);
  const onSelectRef = useRef(onSelect);
  onSelectRef.current = onSelect;

  useEffect(() => {
    if (!container.current) return;
    const m = new maplibregl.Map({
      container: container.current,
      style: STYLE_URL,
      center: [0, 30],
      zoom: 1.5,
      attributionControl: { compact: true },
    });
    m.addControl(new maplibregl.NavigationControl({ showCompass: false }), "top-right");
    const markMoved = (e: { originalEvent?: unknown }) => {
      if (e.originalEvent) userMoved.current = true;
    };
    m.on("dragstart", markMoved);
    m.on("zoomstart", markMoved);
    // The pane changes size with the layout (mobile tabs, window resizes): keep the pins framed.
    const observer = new ResizeObserver(() => {
      m.resize();
      if (bounds.current && !userMoved.current) m.fitBounds(bounds.current, { padding: 60, maxZoom: 13, duration: 0 });
    });
    observer.observe(container.current);
    map.current = m;
    return () => {
      observer.disconnect();
      m.remove();
      map.current = null;
      markers.current.clear();
      fittedKey.current = "";
    };
  }, []);

  useEffect(() => {
    const m = map.current;
    if (!m) return;
    const placed = listings.filter((l) => l.lat !== null && l.lng !== null);
    const ids = new Set(placed.map((l) => l.id));

    for (const [id, marker] of markers.current) {
      if (!ids.has(id)) {
        marker.remove();
        markers.current.delete(id);
      }
    }
    for (const l of placed) {
      let marker = markers.current.get(l.id);
      if (!marker) {
        const el = document.createElement("button");
        el.type = "button";
        el.addEventListener("click", (e) => {
          e.stopPropagation();
          onSelectRef.current(Number(el.dataset.id));
        });
        marker = new maplibregl.Marker({ element: el, anchor: "bottom" })
          .setLngLat([l.lng as number, l.lat as number])
          .addTo(m);
        markers.current.set(l.id, marker);
      }
      marker.setLngLat([l.lng as number, l.lat as number]);
      const el = marker.getElement();
      el.dataset.id = String(l.id);
      el.textContent = label(l);
      el.title = l.location_approx ? `${l.title} (approximate location)` : l.title;
      // classList, not className: MapLibre positions markers through its own classes.
      el.classList.add("pin");
      for (const s of ["candidate", "shortlisted", "chosen", "rejected"])
        el.classList.toggle(`pin-${s}`, l.status === s);
      el.classList.toggle("pin-approx", l.location_approx);
      el.classList.toggle("pin-selected", l.id === selectedId);
      el.style.zIndex = l.id === selectedId ? "10" : "";
    }

    // Re-frame only when the set of pins changes, not on every edit.
    const key = [...ids].sort((a, b) => a - b).join(",");
    if (key && key !== fittedKey.current) {
      fittedKey.current = key;
      const b = new maplibregl.LngLatBounds();
      for (const l of placed) b.extend([l.lng as number, l.lat as number]);
      bounds.current = b;
      userMoved.current = false;
      m.resize();
      m.fitBounds(b, { padding: 60, maxZoom: 13, duration: 0 });
    }
  }, [listings, selectedId, label]);

  useEffect(() => {
    const m = map.current;
    const l = listings.find((x) => x.id === selectedId);
    if (!m || !l || l.lat === null || l.lng === null) return;
    if (!m.getBounds().contains([l.lng, l.lat])) m.easeTo({ center: [l.lng, l.lat] });
  }, [selectedId, listings]);

  const unplaced = listings.filter((l) => l.lat === null).length;
  return (
    <div className="map-wrap">
      <div ref={container} className="map" />
      {unplaced > 0 && <div className="map-note">{unplaced} not on the map (no location yet)</div>}
    </div>
  );
}
