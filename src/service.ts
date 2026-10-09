import type { Database } from "bun:sqlite";
import {
  coerceValue,
  FIELD_TYPES,
  type Field,
  type FieldType,
  type FieldValue,
  RESERVED_KEYS,
  slugify,
} from "./coerce";
import { type Enrichment, fetchListingMetadata } from "./enrich";
import { geocode } from "./geocode";

/** A problem with the caller's input. Its message is shown to the user or to Claude as-is. */
export class UserError extends Error {}

export const STATUSES = ["candidate", "shortlisted", "chosen", "rejected"] as const;
export type Status = (typeof STATUSES)[number];

export type Trip = {
  id: string;
  name: string;
  destination: string | null;
  start_date: string | null;
  end_date: string | null;
  group_size: number;
  currency: string;
  notes: string | null;
  version: number;
  created_at: string;
  updated_at: string;
};

export type Listing = {
  id: number;
  title: string;
  url: string | null;
  status: Status;
  notes: string | null;
  address: string | null;
  lat: number | null;
  lng: number | null;
  location_approx: boolean;
  photos: string[];
  facts: Record<string, number>;
  values: Record<string, FieldValue>;
  votes: number;
  comment_count: number;
  created_at: string;
  updated_at: string;
};

export type Comment = {
  id: number;
  listing_id: number;
  author: string | null;
  body: string;
  created_at: string;
};

export type FieldInput = {
  label: string;
  key?: string;
  type: FieldType;
  better?: "higher" | "lower" | null;
  per_person?: boolean;
  unit?: string | null;
  options?: string[] | null;
  description?: string | null;
};

export type FieldPatch = Partial<Omit<FieldInput, "key">> & {
  new_key?: string;
  position?: number;
};

export type ListingInput = {
  title?: string;
  url?: string | null;
  status?: Status;
  notes?: string | null;
  address?: string | null;
  lat?: number | null;
  lng?: number | null;
  location_approx?: boolean;
  photos?: string[];
  values?: Record<string, unknown>;
};

export type TripInput = {
  name: string;
  destination?: string | null;
  start_date?: string | null;
  end_date?: string | null;
  group_size?: number;
  currency?: string;
  notes?: string | null;
};

export const PUBLIC_URL = (process.env.PUBLIC_URL ?? "http://localhost:3000").replace(/\/+$/, "");

export function tripUrl(id: string): string {
  return `${PUBLIC_URL}/t/${id}`;
}

const ID_ALPHABET = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";

/** 16 base62 characters (~95 bits): the link is the only credential, so it must be unguessable. */
export function newTripId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  // 256 % 62 introduces a tiny bias, irrelevant at this length.
  return Array.from(bytes, (b) => ID_ALPHABET[b % 62]).join("");
}

/** Accepts a bare trip ID or any URL containing /t/<id>. */
export function parseTripRef(ref: string): string {
  const trimmed = ref.trim();
  const fromUrl = trimmed.match(/\/t\/([A-Za-z0-9]+)/);
  return fromUrl?.[1] ?? trimmed;
}

// ---------------------------------------------------------------------------------------
// Row mapping

// biome-ignore lint/suspicious/noExplicitAny: SQLite rows are untyped at runtime
type Row = Record<string, any>;

function toField(r: Row): Field {
  return {
    key: r.key,
    label: r.label,
    type: r.type,
    better: r.better ?? null,
    per_person: !!r.per_person,
    unit: r.unit ?? null,
    options: r.options ? JSON.parse(r.options) : null,
    description: r.description ?? null,
    position: r.position,
  };
}

function toListing(r: Row): Listing {
  return {
    id: r.id,
    title: r.title,
    url: r.url ?? null,
    status: r.status,
    notes: r.notes ?? null,
    address: r.address ?? null,
    lat: r.lat ?? null,
    lng: r.lng ?? null,
    location_approx: !!r.location_approx,
    photos: JSON.parse(r.photos),
    facts: JSON.parse(r.facts),
    values: JSON.parse(r.values),
    votes: r.votes,
    comment_count: r.comment_count ?? 0,
    created_at: r.created_at,
    updated_at: r.updated_at,
  };
}

/** Bumps the trip's version so open web pages notice the change. */
function touch(db: Database, tripId: string): void {
  db.query("UPDATE trips SET version = version + 1, updated_at = datetime('now') WHERE id = ?").run(tripId);
}

function cleanText(v: string | null | undefined, max: number, what: string): string | null {
  if (v === null || v === undefined) return null;
  const s = v.trim();
  if (s.length > max) throw new UserError(`${what} is longer than ${max} characters`);
  return s || null;
}

// ---------------------------------------------------------------------------------------
// Trips

const CURRENCY_RE = /^[A-Z]{3}$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function validateTripPatch(p: Partial<TripInput>): void {
  if (p.group_size !== undefined && (!Number.isInteger(p.group_size) || p.group_size < 1 || p.group_size > 100)) {
    throw new UserError("group_size must be a whole number between 1 and 100");
  }
  if (p.currency !== undefined && !CURRENCY_RE.test(p.currency)) {
    throw new UserError("currency must be an ISO 4217 code such as EUR, USD or GBP");
  }
  for (const k of ["start_date", "end_date"] as const) {
    const v = p[k];
    if (v && !DATE_RE.test(v)) throw new UserError(`${k} must be YYYY-MM-DD`);
  }
}

export function createTrip(db: Database, input: TripInput): Trip {
  const name = cleanText(input.name, 120, "name");
  if (!name) throw new UserError("name is required");
  const currency = input.currency?.toUpperCase() ?? "EUR";
  validateTripPatch({ ...input, currency });
  const id = newTripId();
  db.query(
    `INSERT INTO trips (id, name, destination, start_date, end_date, group_size, currency, notes)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    name,
    cleanText(input.destination, 200, "destination"),
    input.start_date ?? null,
    input.end_date ?? null,
    input.group_size ?? 1,
    currency,
    cleanText(input.notes, 5000, "notes"),
  );
  return getTrip(db, id);
}

export function getTrip(db: Database, ref: string): Trip {
  const id = parseTripRef(ref);
  const row = db.query("SELECT * FROM trips WHERE id = ?").get(id) as Trip | null;
  if (!row) {
    throw new UserError(
      "Trip not found. Check the trip link (it looks like https://…/t/<id>); trips can only be opened with their exact link.",
    );
  }
  return row;
}

export function updateTrip(db: Database, ref: string, patch: Partial<TripInput>): Trip {
  const trip = getTrip(db, ref);
  const currency = patch.currency?.toUpperCase();
  validateTripPatch({ ...patch, currency });
  const sets: string[] = [];
  const params: (string | number | null)[] = [];
  const set = (col: string, v: string | number | null) => {
    sets.push(`${col} = ?`);
    params.push(v);
  };
  if (patch.name !== undefined) {
    const name = cleanText(patch.name, 120, "name");
    if (!name) throw new UserError("name can't be empty");
    set("name", name);
  }
  if (patch.destination !== undefined) set("destination", cleanText(patch.destination, 200, "destination"));
  if (patch.start_date !== undefined) set("start_date", patch.start_date || null);
  if (patch.end_date !== undefined) set("end_date", patch.end_date || null);
  if (patch.group_size !== undefined) set("group_size", patch.group_size);
  if (currency !== undefined) set("currency", currency);
  if (patch.notes !== undefined) set("notes", cleanText(patch.notes, 5000, "notes"));
  if (sets.length) {
    db.query(`UPDATE trips SET ${sets.join(", ")} WHERE id = ?`).run(...params, trip.id);
    touch(db, trip.id);
  }
  return getTrip(db, trip.id);
}

// ---------------------------------------------------------------------------------------
// Fields

export function listFields(db: Database, tripId: string): Field[] {
  return (db.query("SELECT * FROM fields WHERE trip_id = ? ORDER BY position, id").all(tripId) as Row[]).map(toField);
}

function fieldOrThrow(fields: Field[], key: string): Field {
  const f = fields.find((x) => x.key === key);
  if (!f) {
    throw new UserError(
      `Unknown field "${key}". This trip's fields: ${fields.map((x) => x.key).join(", ") || "(none yet)"}.`,
    );
  }
  return f;
}

/** Checks a field definition's internal consistency, returning normalized options. */
function validateFieldShape(f: {
  key: string;
  type: FieldType;
  better?: string | null;
  per_person?: boolean;
  unit?: string | null;
  options?: string[] | null;
}): string[] | null {
  if (!FIELD_TYPES.includes(f.type)) {
    throw new UserError(`${f.key}: type must be one of ${FIELD_TYPES.join(", ")}`);
  }
  if (!/^[a-z][a-z0-9_]{0,39}$/.test(f.key)) {
    throw new UserError(`${f.key}: key must be snake_case, starting with a letter, up to 40 characters`);
  }
  if (RESERVED_KEYS.has(f.key)) {
    throw new UserError(
      `${f.key}: "${f.key}" is a built-in listing property (${[...RESERVED_KEYS].join(", ")}); use it directly instead of defining a field`,
    );
  }
  if (f.per_person && f.type !== "currency") {
    throw new UserError(`${f.key}: per_person only applies to currency fields`);
  }
  if (f.better && f.type !== "number" && f.type !== "currency" && f.type !== "boolean") {
    throw new UserError(`${f.key}: better only applies to number, currency and boolean fields`);
  }
  if (f.type === "select") {
    const opts = [...new Set((f.options ?? []).map((o) => o.trim()).filter(Boolean))];
    if (opts.length === 0) throw new UserError(`${f.key}: select fields need at least one option`);
    return opts;
  }
  if (f.options?.length) throw new UserError(`${f.key}: options only apply to select fields`);
  return null;
}

export function defineFields(db: Database, ref: string, inputs: FieldInput[]): Field[] {
  const trip = getTrip(db, ref);
  const existing = listFields(db, trip.id);
  const keys = new Set(existing.map((f) => f.key));
  let position = existing.reduce((m, f) => Math.max(m, f.position), -1) + 1;

  const rows = inputs.map((input) => {
    const label = cleanText(input.label, 60, "label");
    if (!label) throw new UserError("every field needs a label");
    const key = input.key ?? slugify(label);
    if (keys.has(key)) {
      throw new UserError(
        `${key}: a field with this key already exists; use update_field to change it, or pick another key`,
      );
    }
    keys.add(key);
    const options = validateFieldShape({ ...input, key });
    return {
      key,
      label,
      type: input.type,
      better: input.better ?? null,
      per_person: input.per_person ? 1 : 0,
      unit: cleanText(input.unit, 20, "unit"),
      options: options ? JSON.stringify(options) : null,
      description: cleanText(input.description, 300, "description"),
      position: position++,
    };
  });

  db.transaction(() => {
    const insert = db.query(
      `INSERT INTO fields (trip_id, key, label, type, better, per_person, unit, options, description, position)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    for (const r of rows) {
      insert.run(trip.id, r.key, r.label, r.type, r.better, r.per_person, r.unit, r.options, r.description, r.position);
    }
    touch(db, trip.id);
  })();
  return listFields(db, trip.id);
}

function allListingRows(db: Database, tripId: string): Row[] {
  return db
    .query(
      `SELECT l.*, (SELECT COUNT(*) FROM comments c WHERE c.listing_id = l.id) AS comment_count
       FROM listings l WHERE l.trip_id = ? ORDER BY l.id`,
    )
    .all(tripId) as Row[];
}

/** A value as text, for converting between field types. */
function valueAsText(v: FieldValue): string {
  if (typeof v === "boolean") return v ? "yes" : "no";
  return String(v);
}

export function updateField(
  db: Database,
  ref: string,
  key: string,
  patch: FieldPatch & { force?: boolean },
): { field: Field; dropped: Array<{ listing_id: number; value: FieldValue }> } {
  const trip = getTrip(db, ref);
  const fields = listFields(db, trip.id);
  const current = fieldOrThrow(fields, key);
  const newKey = patch.new_key ?? current.key;
  if (newKey !== current.key && fields.some((f) => f.key === newKey)) {
    throw new UserError(`${newKey}: another field already uses this key`);
  }
  const next: Field = {
    ...current,
    key: newKey,
    label: patch.label !== undefined ? (cleanText(patch.label, 60, "label") ?? current.label) : current.label,
    type: patch.type ?? current.type,
    better: patch.better !== undefined ? patch.better : current.better,
    per_person: patch.per_person ?? current.per_person,
    unit: patch.unit !== undefined ? cleanText(patch.unit, 20, "unit") : current.unit,
    options: patch.options !== undefined ? patch.options : current.options,
    description:
      patch.description !== undefined ? cleanText(patch.description, 300, "description") : current.description,
    position: patch.position ?? current.position,
  };
  // Settings that stop making sense after a type change are dropped rather than rejected.
  if (next.type !== "currency") next.per_person = false;
  if (next.type === "text" || next.type === "select") next.better = null;
  if (next.type !== "number") next.unit = null;
  if (next.type !== "select") next.options = null;
  next.options = validateFieldShape(next);

  // Convert existing values to the new type, or to the new option list.
  const listings = allListingRows(db, trip.id).map(toListing);
  const converted: Array<{ id: number; values: Record<string, FieldValue> }> = [];
  const dropped: Array<{ listing_id: number; value: FieldValue }> = [];
  for (const l of listings) {
    if (!(current.key in l.values) && newKey === current.key) continue;
    const old = l.values[current.key] ?? null;
    const values = { ...l.values };
    delete values[current.key];
    if (old !== null) {
      const input = next.type === current.type ? old : valueAsText(old);
      const res = coerceValue(next, input);
      if (res.ok) values[newKey] = res.value;
      else dropped.push({ listing_id: l.id, value: old });
    }
    converted.push({ id: l.id, values });
  }
  if (dropped.length && !patch.force) {
    throw new UserError(
      `${dropped.length} existing value(s) can't be converted: ${dropped
        .map((d) => `#${d.listing_id}=${JSON.stringify(d.value)}`)
        .join(", ")}. Fix those listings first, or pass force: true to clear them.`,
    );
  }

  db.transaction(() => {
    db.query(
      `UPDATE fields SET key = ?, label = ?, type = ?, better = ?, per_person = ?, unit = ?, options = ?,
         description = ?, position = ? WHERE trip_id = ? AND key = ?`,
    ).run(
      next.key,
      next.label,
      next.type,
      next.better,
      next.per_person ? 1 : 0,
      next.unit,
      next.options ? JSON.stringify(next.options) : null,
      next.description,
      next.position,
      trip.id,
      current.key,
    );
    const save = db.query(`UPDATE listings SET "values" = ? WHERE id = ?`);
    for (const c of converted) save.run(JSON.stringify(c.values), c.id);
    touch(db, trip.id);
  })();
  return { field: fieldOrThrow(listFields(db, trip.id), next.key), dropped };
}

export function deleteField(db: Database, ref: string, key: string): { cleared_values: number } {
  const trip = getTrip(db, ref);
  fieldOrThrow(listFields(db, trip.id), key);
  let cleared = 0;
  db.transaction(() => {
    db.query("DELETE FROM fields WHERE trip_id = ? AND key = ?").run(trip.id, key);
    const save = db.query(`UPDATE listings SET "values" = ? WHERE id = ?`);
    for (const l of allListingRows(db, trip.id).map(toListing)) {
      if (key in l.values) {
        delete l.values[key];
        save.run(JSON.stringify(l.values), l.id);
        cleared++;
      }
    }
    touch(db, trip.id);
  })();
  return { cleared_values: cleared };
}

// ---------------------------------------------------------------------------------------
// Listings

export function listListings(db: Database, tripId: string): Listing[] {
  return allListingRows(db, tripId).map(toListing);
}

export function getListing(db: Database, ref: string, id: number): Listing & { comments: Comment[] } {
  const trip = getTrip(db, ref);
  const row = db
    .query(
      `SELECT l.*, (SELECT COUNT(*) FROM comments c WHERE c.listing_id = l.id) AS comment_count
       FROM listings l WHERE l.trip_id = ? AND l.id = ?`,
    )
    .get(trip.id, id) as Row | null;
  if (!row) throw new UserError(`Listing #${id} isn't in this trip`);
  const comments = db.query("SELECT * FROM comments WHERE listing_id = ? ORDER BY id").all(id) as Comment[];
  return { ...toListing(row), comments };
}

/** Same listing page, ignoring tracking and date parameters. */
export function normalizeUrl(url: string): string {
  try {
    const u = new URL(url);
    const host = u.hostname.replace(/^www\./, "").replace(/^([a-z]{2}\.)?airbnb\.[a-z.]+$/, "airbnb");
    return `${host}${u.pathname.replace(/\/+$/, "")}`.toLowerCase();
  } catch {
    return url.trim().toLowerCase();
  }
}

function validateUrl(url: string | null | undefined, what: string): string | null {
  if (url === null || url === undefined || url.trim() === "") return null;
  try {
    const u = new URL(url.trim());
    if (!/^https?:$/.test(u.protocol)) throw new Error();
    return u.toString();
  } catch {
    throw new UserError(`${what}: not a valid http(s) URL: ${url}`);
  }
}

function validateCoords(lat: number | null | undefined, lng: number | null | undefined, what: string): void {
  if ((lat === undefined) !== (lng === undefined) || (lat === null) !== (lng === null)) {
    throw new UserError(`${what}: lat and lng must be given together`);
  }
  if (typeof lat === "number" && (lat < -90 || lat > 90)) throw new UserError(`${what}: lat out of range`);
  if (typeof lng === "number" && (lng < -180 || lng > 180)) throw new UserError(`${what}: lng out of range`);
}

function coerceValues(
  fields: Field[],
  input: Record<string, unknown> | undefined,
  what: string,
  errors: string[],
): Record<string, FieldValue> {
  const out: Record<string, FieldValue> = {};
  if (!input) return out;
  const byKey = new Map(fields.map((f) => [f.key, f]));
  for (const [key, raw] of Object.entries(input)) {
    const field = byKey.get(key);
    if (!field) {
      const hint = RESERVED_KEYS.has(key)
        ? `"${key}" is a built-in property; set it at the top level, not inside values`
        : `unknown field; this trip's fields are ${fields.map((f) => f.key).join(", ") || "(none yet)"}. Define it with define_fields first`;
      errors.push(`${what}: ${key}: ${hint}`);
      continue;
    }
    const res = coerceValue(field, raw);
    if (res.ok) out[key] = res.value;
    else errors.push(`${what}: ${res.error}`);
  }
  return out;
}

function validatePhotos(photos: string[] | undefined, what: string): string[] | undefined {
  if (photos === undefined) return undefined;
  if (photos.length > 30) throw new UserError(`${what}: at most 30 photos`);
  return photos.map((p) => validateUrl(p, `${what} photo`) as string).filter(Boolean);
}

// Page facts that fill a matching number field when the listing doesn't have a value yet.
const FACT_FIELDS: Record<string, RegExp> = {
  bedrooms: /bedroom/,
  bathrooms: /bath/,
  beds: /^(num_|n_|number_of_)?beds$/,
  guests: /guest|sleeps|capacity|occupancy/,
  rating: /rating|stars/,
  reviews: /review/,
};

function factFieldKeys(fields: Field[], facts: Record<string, number>): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [fact, value] of Object.entries(facts)) {
    const re = FACT_FIELDS[fact];
    const field = re && fields.find((f) => f.type === "number" && re.test(f.key));
    if (field && !(field.key in out)) out[field.key] = value;
  }
  return out;
}

/** Geocodes an address, first scoped to the trip's destination, then on its own. */
async function locate(db: Database, address: string, destination: string | null) {
  if (destination && !address.toLowerCase().includes(destination.toLowerCase())) {
    const scoped = await geocode(db, `${address}, ${destination}`);
    if (scoped) return scoped;
  }
  return geocode(db, address);
}

export type AddedListing = {
  id: number;
  title: string;
  location: "exact" | "approximate" | "geocoded" | "none";
  filled_from_page: string[];
  warnings: string[];
};

type Prepared = {
  input: ListingInput;
  url: string | null;
  values: Record<string, FieldValue>;
  photos: string[] | undefined;
};

async function mapLimit<T, R>(items: T[], limit: number, fn: (t: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i] as T);
    }
  });
  await Promise.all(workers);
  return out;
}

export async function addListings(
  db: Database,
  ref: string,
  inputs: ListingInput[],
  opts: { enrich?: boolean } = {},
): Promise<AddedListing[]> {
  const trip = getTrip(db, ref);
  if (inputs.length === 0) throw new UserError("listings is empty");
  if (inputs.length > 100) throw new UserError("at most 100 listings per call");
  const fields = listFields(db, trip.id);
  const known = new Map(
    listListings(db, trip.id)
      .filter((l) => l.url)
      .map((l) => [normalizeUrl(l.url as string), l]),
  );

  // Validate everything before writing anything, so a failed call can simply be retried.
  const errors: string[] = [];
  const prepared: Prepared[] = inputs.map((input, i) => {
    const what = `listings[${i}]${input.title ? ` (${input.title})` : ""}`;
    try {
      const url = validateUrl(input.url, what);
      if (url) {
        const dup = known.get(normalizeUrl(url));
        if (dup) errors.push(`${what}: already in this trip as #${dup.id} "${dup.title}"; use update_listings instead`);
        else known.set(normalizeUrl(url), { id: -1, title: input.title ?? url } as Listing);
      }
      if (!url && !input.title?.trim()) errors.push(`${what}: needs a title or a url`);
      if (input.status && !STATUSES.includes(input.status))
        errors.push(`${what}: status must be one of ${STATUSES.join(", ")}`);
      validateCoords(input.lat, input.lng, what);
      cleanText(input.notes, 5000, `${what} notes`);
      const values = coerceValues(fields, input.values, what, errors);
      return { input, url, values, photos: validatePhotos(input.photos, what) };
    } catch (e) {
      if (!(e instanceof UserError)) throw e;
      errors.push(e.message);
      return { input, url: null, values: {}, photos: undefined };
    }
  });
  if (errors.length) {
    throw new UserError(`Nothing was added. Fix these and retry:\n- ${errors.join("\n- ")}`);
  }

  const results = await mapLimit(prepared, 4, async (p) => {
    const warnings: string[] = [];
    const filled: string[] = [];
    let page: Enrichment | null = null;
    if (p.url && opts.enrich !== false) {
      const res = await fetchListingMetadata(p.url);
      if (res.ok) page = res.data;
      else warnings.push(`couldn't read the listing page: ${res.reason}`);
    }

    const title = p.input.title?.trim() || page?.title || new URL(p.url as string).hostname;
    if (!p.input.title?.trim() && page?.title) filled.push("title");
    let photos = p.photos;
    if (!photos?.length && page?.photos.length) {
      photos = page.photos;
      filled.push("photos");
    }
    let lat = p.input.lat ?? null;
    let lng = p.input.lng ?? null;
    let approx = p.input.location_approx ?? false;
    let location: AddedListing["location"] = lat !== null ? (approx ? "approximate" : "exact") : "none";
    if (lat === null && page?.lat !== undefined && page.lng !== undefined) {
      lat = page.lat;
      lng = page.lng;
      approx = page.location_approx ?? false;
      location = approx ? "approximate" : "exact";
      filled.push("location");
    }
    const address = p.input.address?.trim() || page?.address || null;
    if (!p.input.address && page?.address) filled.push("address");
    if (lat === null && address) {
      const point = await locate(db, address, trip.destination);
      if (point) {
        ({ lat, lng } = point);
        approx = true;
        location = "geocoded";
      } else {
        warnings.push(`couldn't find "${address}" on the map; set lat/lng to place it`);
      }
    }
    const values = { ...p.values };
    for (const [key, v] of Object.entries(factFieldKeys(fields, page?.facts ?? {}))) {
      if (!(key in values)) {
        values[key] = v;
        filled.push(key);
      }
    }
    return {
      row: {
        title: title.slice(0, 200),
        url: p.url,
        status: p.input.status ?? "candidate",
        notes: cleanText(p.input.notes, 5000, "notes"),
        address,
        lat,
        lng,
        approx: approx ? 1 : 0,
        photos: JSON.stringify(photos ?? []),
        facts: JSON.stringify(page?.facts ?? {}),
        values: JSON.stringify(values),
      },
      location,
      filled,
      warnings,
    };
  });

  const added: AddedListing[] = [];
  db.transaction(() => {
    const insert = db.query(
      `INSERT INTO listings (trip_id, title, url, status, notes, address, lat, lng, location_approx, photos, facts, "values")
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING id`,
    );
    for (const r of results) {
      const { id } = insert.get(
        trip.id,
        r.row.title,
        r.row.url,
        r.row.status,
        r.row.notes,
        r.row.address,
        r.row.lat,
        r.row.lng,
        r.row.approx,
        r.row.photos,
        r.row.facts,
        r.row.values,
      ) as { id: number };
      added.push({ id, title: r.row.title, location: r.location, filled_from_page: r.filled, warnings: r.warnings });
    }
    touch(db, trip.id);
  })();
  return added;
}

export type ListingUpdate = ListingInput & { id: number };

export async function updateListings(db: Database, ref: string, updates: ListingUpdate[]): Promise<Listing[]> {
  const trip = getTrip(db, ref);
  if (updates.length === 0) throw new UserError("updates is empty");
  if (updates.length > 200) throw new UserError("at most 200 updates per call");
  const fields = listFields(db, trip.id);
  const current = new Map(listListings(db, trip.id).map((l) => [l.id, l]));

  const errors: string[] = [];
  const next: Listing[] = [];
  for (const u of updates) {
    const l = current.get(u.id);
    const what = `#${u.id}`;
    if (!l) {
      errors.push(`${what}: not a listing in this trip`);
      continue;
    }
    try {
      const n: Listing = { ...l, values: { ...l.values } };
      if (u.title !== undefined) {
        const t = cleanText(u.title, 200, `${what} title`);
        if (!t) throw new UserError(`${what}: title can't be empty`);
        n.title = t;
      }
      if (u.url !== undefined) n.url = validateUrl(u.url, what);
      if (u.status !== undefined) {
        if (!STATUSES.includes(u.status)) throw new UserError(`${what}: status must be one of ${STATUSES.join(", ")}`);
        n.status = u.status;
      }
      if (u.notes !== undefined) n.notes = cleanText(u.notes, 5000, `${what} notes`);
      if (u.address !== undefined) n.address = cleanText(u.address, 300, `${what} address`);
      if (u.lat !== undefined || u.lng !== undefined) {
        validateCoords(u.lat, u.lng, what);
        n.lat = u.lat ?? null;
        n.lng = u.lng ?? null;
        n.location_approx = u.location_approx ?? false;
      } else if (u.location_approx !== undefined) {
        n.location_approx = u.location_approx;
      }
      if (u.photos !== undefined) n.photos = validatePhotos(u.photos, what) ?? [];
      const values = coerceValues(fields, u.values, what, errors);
      for (const [k, v] of Object.entries(values)) {
        if (v === null) delete n.values[k];
        else n.values[k] = v;
      }
      next.push(n);
    } catch (e) {
      if (!(e instanceof UserError)) throw e;
      errors.push(e.message);
    }
  }
  if (errors.length) {
    throw new UserError(`Nothing was changed. Fix these and retry:\n- ${errors.join("\n- ")}`);
  }

  // A new address on a listing with no map position gets geocoded.
  for (const n of next) {
    const u = updates.find((x) => x.id === n.id);
    if (u?.address && n.lat === null) {
      const point = await locate(db, n.address as string, trip.destination);
      if (point) {
        n.lat = point.lat;
        n.lng = point.lng;
        n.location_approx = true;
      }
    }
  }

  db.transaction(() => {
    const save = db.query(
      `UPDATE listings SET title = ?, url = ?, status = ?, notes = ?, address = ?, lat = ?, lng = ?,
         location_approx = ?, photos = ?, "values" = ?, updated_at = datetime('now') WHERE id = ?`,
    );
    for (const n of next) {
      save.run(
        n.title,
        n.url,
        n.status,
        n.notes,
        n.address,
        n.lat,
        n.lng,
        n.location_approx ? 1 : 0,
        JSON.stringify(n.photos),
        JSON.stringify(n.values),
        n.id,
      );
    }
    touch(db, trip.id);
  })();
  const fresh = new Map(listListings(db, trip.id).map((l) => [l.id, l]));
  return next.map((n) => fresh.get(n.id) as Listing);
}

export function deleteListings(db: Database, ref: string, ids: number[]): { deleted: number[] } {
  const trip = getTrip(db, ref);
  const existing = new Set(listListings(db, trip.id).map((l) => l.id));
  const missing = ids.filter((id) => !existing.has(id));
  if (missing.length) throw new UserError(`Not listings in this trip: ${missing.map((m) => `#${m}`).join(", ")}`);
  db.transaction(() => {
    const del = db.query("DELETE FROM listings WHERE trip_id = ? AND id = ?");
    for (const id of ids) del.run(trip.id, id);
    touch(db, trip.id);
  })();
  return { deleted: ids };
}

export async function enrichListing(
  db: Database,
  ref: string,
  id: number,
  overwrite: boolean,
): Promise<{ listing: Listing; filled: string[] }> {
  const trip = getTrip(db, ref);
  const listing = getListing(db, trip.id, id);
  if (!listing.url) throw new UserError(`#${id} has no url to read`);
  const res = await fetchListingMetadata(listing.url);
  if (!res.ok) throw new UserError(`Couldn't read the listing page: ${res.reason}`);
  const page = res.data;
  const fields = listFields(db, trip.id);
  const filled: string[] = [];
  const n = { ...listing, values: { ...listing.values } };
  if (page.title && overwrite) {
    n.title = page.title;
    filled.push("title");
  }
  if (page.photos.length && (overwrite || !n.photos.length)) {
    n.photos = page.photos;
    filled.push("photos");
  }
  if (page.lat !== undefined && page.lng !== undefined && (overwrite || n.lat === null)) {
    n.lat = page.lat;
    n.lng = page.lng;
    n.location_approx = page.location_approx ?? false;
    filled.push("location");
  }
  if (page.address && (overwrite || !n.address)) {
    n.address = page.address;
    filled.push("address");
  }
  for (const [key, v] of Object.entries(factFieldKeys(fields, page.facts))) {
    if (overwrite || !(key in n.values)) {
      n.values[key] = v;
      filled.push(key);
    }
  }
  db.query(
    `UPDATE listings SET title = ?, photos = ?, lat = ?, lng = ?, location_approx = ?, address = ?, facts = ?,
       "values" = ?, updated_at = datetime('now') WHERE id = ?`,
  ).run(
    n.title,
    JSON.stringify(n.photos),
    n.lat,
    n.lng,
    n.location_approx ? 1 : 0,
    n.address,
    JSON.stringify({ ...listing.facts, ...page.facts }),
    JSON.stringify(n.values),
    id,
  );
  touch(db, trip.id);
  return { listing: getListing(db, trip.id, id), filled };
}

// ---------------------------------------------------------------------------------------
// Group decisions

export function vote(db: Database, ref: string, id: number, delta: 1 | -1): number {
  const trip = getTrip(db, ref);
  getListing(db, trip.id, id);
  const { votes } = db
    .query("UPDATE listings SET votes = MAX(0, votes + ?) WHERE id = ? RETURNING votes")
    .get(delta, id) as { votes: number };
  touch(db, trip.id);
  return votes;
}

export function addComment(
  db: Database,
  ref: string,
  listingId: number,
  body: string,
  author?: string | null,
): Comment {
  const trip = getTrip(db, ref);
  getListing(db, trip.id, listingId);
  const text = cleanText(body, 2000, "comment");
  if (!text) throw new UserError("comment can't be empty");
  const comment = db
    .query("INSERT INTO comments (listing_id, author, body) VALUES (?, ?, ?) RETURNING *")
    .get(listingId, cleanText(author, 40, "author"), text) as Comment;
  touch(db, trip.id);
  return comment;
}

export function deleteComment(db: Database, ref: string, commentId: number): void {
  const trip = getTrip(db, ref);
  const res = db
    .query("DELETE FROM comments WHERE id = ? AND listing_id IN (SELECT id FROM listings WHERE trip_id = ?)")
    .run(commentId, trip.id);
  if (res.changes === 0) throw new UserError(`Comment ${commentId} isn't in this trip`);
  touch(db, trip.id);
}

export function listComments(db: Database, tripId: string): Comment[] {
  return db
    .query(`SELECT c.* FROM comments c JOIN listings l ON l.id = c.listing_id WHERE l.trip_id = ? ORDER BY c.id`)
    .all(tripId) as Comment[];
}
