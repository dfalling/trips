import { lookup } from "node:dns/promises";
import { isIP } from "node:net";

// Best-effort metadata from a listing page fetched without JavaScript: OpenGraph tags and
// schema.org JSON-LD. Airbnb serves these (title, photos, approximate coordinates, rating,
// bedrooms) but never the price. Booking.com answers plain fetches with a bot challenge.

export type Enrichment = {
  title?: string;
  description?: string;
  photos: string[];
  lat?: number;
  lng?: number;
  location_approx?: boolean;
  address?: string;
  facts: Record<string, number>;
};

export type EnrichResult = { ok: true; data: Enrichment } | { ok: false; reason: string };

const USER_AGENT = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0 Safari/537.36";
const MAX_BYTES = 4_000_000;

function decodeEntities(s: string): string {
  return s
    .replace(/&quot;/g, '"')
    .replace(/&#x27;|&#39;|&apos;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(Number.parseInt(n, 16)))
    .replace(/&amp;/g, "&");
}

function metaTags(html: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const tag of html.match(/<meta\b[^>]*>/gi) ?? []) {
    const name = tag.match(/\b(?:property|name)\s*=\s*["']([^"']+)["']/i)?.[1];
    const content = tag.match(/\bcontent\s*=\s*"([^"]*)"|\bcontent\s*=\s*'([^']*)'/i);
    const value = content?.[1] ?? content?.[2];
    if (name && value && !out.has(name.toLowerCase())) {
      out.set(name.toLowerCase(), decodeEntities(value));
    }
  }
  return out;
}

// biome-ignore lint/suspicious/noExplicitAny: JSON-LD is arbitrary JSON
type Json = any;

function jsonLdObjects(html: string): Json[] {
  const objects: Json[] = [];
  const re = /<script[^>]*type\s*=\s*["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
  for (const m of html.matchAll(re)) {
    try {
      const parsed = JSON.parse(m[1] ?? "");
      const stack = Array.isArray(parsed) ? [...parsed] : [parsed];
      while (stack.length) {
        const o = stack.shift();
        if (!o || typeof o !== "object") continue;
        objects.push(o);
        if (Array.isArray(o["@graph"])) stack.push(...o["@graph"]);
      }
    } catch {
      // Malformed blocks are common; skip them.
    }
  }
  return objects;
}

function imageUrls(image: Json): string[] {
  if (!image) return [];
  if (typeof image === "string") return [image];
  if (Array.isArray(image)) return image.flatMap(imageUrls);
  if (typeof image === "object") return imageUrls(image.url ?? image.contentUrl);
  return [];
}

function num(v: Json): number | undefined {
  const n = typeof v === "string" ? Number.parseFloat(v) : v;
  return typeof n === "number" && Number.isFinite(n) ? n : undefined;
}

function addressText(address: Json): string | undefined {
  if (!address) return undefined;
  if (typeof address === "string") return address;
  const parts = [
    address.streetAddress,
    address.addressLocality,
    address.addressRegion,
    address.postalCode,
    address.addressCountry?.name ?? address.addressCountry,
  ].filter((p) => typeof p === "string" && p.trim());
  return parts.length ? parts.join(", ") : undefined;
}

// Airbnb's og:title: "Villa in Lagos · ★4.91 · 3 bedrooms · 5 beds · 2.5 baths".
function titleFacts(title: string): Record<string, number> {
  const facts: Record<string, number> = {};
  const rating = title.match(/★\s*([\d.]+)/);
  if (rating) facts.rating = Number(rating[1]);
  const patterns: Array<[string, RegExp]> = [
    ["bedrooms", /([\d.]+)\s+bedrooms?/i],
    ["beds", /([\d.]+)\s+beds?\b/i],
    ["bathrooms", /([\d.]+)\s+(?:private |shared )?baths?(?:rooms?)?/i],
    ["guests", /([\d.]+)\s+guests?/i],
  ];
  for (const [key, re] of patterns) {
    const m = title.match(re);
    if (m) facts[key] = Number(m[1]);
  }
  if (/\bstudio\b/i.test(title) && facts.bedrooms === undefined) facts.bedrooms = 0;
  return facts;
}

const LODGING_TYPES =
  /VacationRental|LodgingBusiness|Hotel|Accommodation|House|Apartment|Resort|BedAndBreakfast|Hostel|Campground|Product|Place/i;

export function parseListingHtml(html: string, url: string): Enrichment {
  const meta = metaTags(html);
  const data: Enrichment = { photos: [], facts: {} };

  const ogTitle = meta.get("og:title");
  data.description = meta.get("og:description") ?? meta.get("description");
  if (ogTitle) Object.assign(data.facts, titleFacts(ogTitle));

  const photos: string[] = [];
  const ogImage = meta.get("og:image");
  if (ogImage) photos.push(ogImage);

  for (const o of jsonLdObjects(html)) {
    const type = [o["@type"]].flat().join(" ");
    if (!LODGING_TYPES.test(type)) continue;
    photos.push(...imageUrls(o.image));
    if (!data.title && typeof o.name === "string") data.title = o.name.trim();
    const geo = o.geo ?? o;
    const lat = num(geo.latitude);
    const lng = num(geo.longitude);
    if (lat !== undefined && lng !== undefined && data.lat === undefined) {
      data.lat = lat;
      data.lng = lng;
    }
    data.address ??= addressText(o.address);
    const rating = o.aggregateRating;
    if (rating) {
      const value = num(rating.ratingValue);
      const count = num(rating.ratingCount ?? rating.reviewCount);
      if (value !== undefined) data.facts.rating ??= value;
      if (count !== undefined) data.facts.reviews ??= count;
    }
    const bedrooms = num(o.numberOfBedrooms);
    if (bedrooms !== undefined) data.facts.bedrooms ??= bedrooms;
    const bathrooms = num(o.numberOfBathroomsTotal);
    if (bathrooms !== undefined) data.facts.bathrooms ??= bathrooms;
    const guests = num(o.occupancy?.value ?? o.occupancy?.maxValue ?? o.containsPlace?.occupancy?.value);
    if (guests !== undefined) data.facts.guests ??= guests;
  }

  // Listing name from JSON-LD first; og:title is often generic ("Rental unit in Lagos · ★4.94").
  if (!data.title) {
    const fallback = ogTitle ?? html.match(/<title[^>]*>([^<]*)<\/title>/i)?.[1];
    if (fallback) data.title = decodeEntities(fallback).split(" · ")[0]?.trim();
  }

  const seen = new Set<string>();
  data.photos = photos
    .map((p) => {
      try {
        const u = new URL(p, url);
        return /^https?:$/.test(u.protocol) ? u.toString() : null;
      } catch {
        return null;
      }
    })
    .filter((p): p is string => !!p && !seen.has(p) && !!seen.add(p))
    .slice(0, 20);

  // Airbnb hides the exact address until booking; its pin is deliberately offset.
  if (data.lat !== undefined && /airbnb\./i.test(new URL(url).hostname)) {
    data.location_approx = true;
  }
  return data;
}

function isBotWall(status: number, html: string): boolean {
  if (status === 202 || status === 403 || status === 429) return true;
  return (
    html.length < 20_000 && /captcha|challenge|awswaf|px-captcha|datadome|are you a robot|access denied/i.test(html)
  );
}

function isPrivateV4(ip: string): boolean {
  const [a = 0, b = 0] = ip.split(".").map(Number);
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    a >= 224 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 192 && b === 0) ||
    (a === 198 && (b === 18 || b === 19))
  );
}

export function isPrivateAddress(ip: string): boolean {
  if (isIP(ip) === 4) return isPrivateV4(ip);
  const v6 = ip.toLowerCase();
  const mapped = v6.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  if (mapped?.[1]) return isPrivateV4(mapped[1]);
  return v6 === "::" || v6 === "::1" || /^f[cd]/.test(v6) || /^fe[89ab]/.test(v6) || v6.startsWith("ff");
}

/**
 * Anyone can create a trip, so listing URLs are untrusted: only fetch public hosts on standard
 * ports, never the Docker network or the server itself. (A DNS answer that changes between this
 * check and the fetch could still slip through; acceptable for metadata scraping.)
 */
async function publicUrlProblem(u: URL): Promise<string | null> {
  if (!/^https?:$/.test(u.protocol)) return "only http(s) URLs can be fetched";
  if (u.port && u.port !== "80" && u.port !== "443") return "only standard ports can be fetched";
  const host = u.hostname.replace(/^\[|\]$/g, "");
  let addresses: string[];
  try {
    addresses = isIP(host) ? [host] : (await lookup(host, { all: true })).map((a) => a.address);
  } catch {
    return `couldn't resolve ${host}`;
  }
  if (addresses.length === 0 || addresses.some(isPrivateAddress)) return "the URL points to a private network address";
  return null;
}

async function readLimited(res: Response): Promise<string> {
  if (!res.body) return "";
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  while (size < MAX_BYTES) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    size += value.length;
  }
  await reader.cancel().catch(() => {});
  return new TextDecoder().decode(Buffer.concat(chunks)).slice(0, MAX_BYTES);
}

export async function fetchListingMetadata(url: string): Promise<EnrichResult> {
  let current: URL;
  try {
    current = new URL(url);
  } catch {
    return { ok: false, reason: "not a valid URL" };
  }

  // Follow redirects by hand so every hop gets the same public-address check.
  let res: Response | null = null;
  for (let hop = 0; hop < 6; hop++) {
    const problem = await publicUrlProblem(current);
    if (problem) return { ok: false, reason: problem };
    try {
      res = await fetch(current, {
        headers: {
          "User-Agent": USER_AGENT,
          Accept: "text/html,application/xhtml+xml",
          "Accept-Language": "en-US,en;q=0.9",
        },
        redirect: "manual",
        signal: AbortSignal.timeout(15_000),
      });
    } catch (e) {
      return { ok: false, reason: `fetch failed: ${(e as Error).message}` };
    }
    const location = res.headers.get("location");
    if (res.status < 300 || res.status >= 400 || !location) break;
    await res.body?.cancel().catch(() => {});
    current = new URL(location, current);
    res = null;
  }
  if (!res) return { ok: false, reason: "too many redirects" };

  const html = await readLimited(res);
  if (isBotWall(res.status, html)) {
    return {
      ok: false,
      reason: `the site blocked an automated fetch (HTTP ${res.status}, bot challenge). Ask the user to paste the listing text or a screenshot and fill the fields from that.`,
    };
  }
  if (!res.ok) return { ok: false, reason: `HTTP ${res.status}` };

  const data = parseListingHtml(html, current.toString());
  if (!data.title && data.photos.length === 0 && data.lat === undefined) {
    return { ok: false, reason: "page had no usable metadata" };
  }
  return { ok: true, data };
}
