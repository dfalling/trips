import type { Database } from "bun:sqlite";

// Nominatim's public instance allows at most one request per second, with an identifying
// User-Agent and cached results: https://operations.osmfoundation.org/policies/nominatim/
const NOMINATIM_URL = process.env.NOMINATIM_URL ?? "https://nominatim.openstreetmap.org";
const CONTACT = process.env.GEOCODER_CONTACT;
const ENABLED = process.env.GEOCODER !== "off";
const MIN_INTERVAL_MS = 1100;

let queue: Promise<unknown> = Promise.resolve();
let lastRequest = 0;

export type Point = { lat: number; lng: number };

export async function geocode(db: Database, query: string): Promise<Point | null> {
  const q = query.trim().toLowerCase();
  if (!q || !ENABLED) return null;

  const cached = db.query("SELECT lat, lng FROM geocode_cache WHERE query = ?").get(q) as {
    lat: number | null;
    lng: number | null;
  } | null;
  if (cached) {
    return cached.lat === null || cached.lng === null ? null : { lat: cached.lat, lng: cached.lng };
  }

  // Serialize requests so concurrent imports stay under the rate limit.
  const result = queue.then(async () => {
    const wait = lastRequest + MIN_INTERVAL_MS - Date.now();
    if (wait > 0) await Bun.sleep(wait);
    lastRequest = Date.now();
    const url = `${NOMINATIM_URL}/search?format=jsonv2&limit=1&q=${encodeURIComponent(query)}`;
    const res = await fetch(url, {
      headers: { "User-Agent": `trips-self-hosted${CONTACT ? ` (${CONTACT})` : ""}` },
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) throw new Error(`geocoder HTTP ${res.status}`);
    const hits = (await res.json()) as Array<{ lat: string; lon: string }>;
    const hit = hits[0];
    return hit ? { lat: Number(hit.lat), lng: Number(hit.lon) } : null;
  });
  queue = result.catch(() => undefined);

  try {
    const point = await result;
    // Misses are cached too, so a bad address isn't retried on every call.
    db.query("INSERT OR REPLACE INTO geocode_cache (query, lat, lng) VALUES (?, ?, ?)").run(
      q,
      point?.lat ?? null,
      point?.lng ?? null,
    );
    return point;
  } catch (e) {
    console.warn(`[trips] geocode failed for "${query}": ${(e as Error).message}`);
    return null;
  }
}
