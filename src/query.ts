import { coerceValue, type Field, type FieldValue } from "./coerce";
import { type Listing, STATUSES, type Trip, UserError } from "./service";

export const OPS = ["eq", "neq", "lt", "lte", "gt", "gte", "contains", "in", "is_set", "is_not_set"] as const;
export type Op = (typeof OPS)[number];

export type Condition = { field: string; op: Op; value?: unknown; per_person?: boolean };
export type SortKey = { field: string; dir?: "asc" | "desc" };

export type QueryInput = {
  where?: Condition[];
  status?: string[];
  search?: string;
  sort?: SortKey[];
  limit?: number;
};

// Built-in listing properties that can be filtered and sorted like fields.
const CORE: Record<string, (l: Listing) => FieldValue> = {
  id: (l) => l.id,
  title: (l) => l.title,
  url: (l) => l.url,
  status: (l) => l.status,
  notes: (l) => l.notes,
  address: (l) => l.address,
  votes: (l) => l.votes,
  comments: (l) => l.comment_count,
  location: (l) => (l.lat === null ? null : l.location_approx ? "approximate" : "exact"),
};

export function perPerson(amount: number, groupSize: number): number {
  return Math.round((amount / Math.max(1, groupSize)) * 100) / 100;
}

type Getter = { get: (l: Listing) => FieldValue; field?: Field };

function resolve(trip: Trip, fields: Field[], name: string, perPersonFlag?: boolean): Getter {
  const field = fields.find((f) => f.key === name);
  if (field) {
    if (perPersonFlag && field.type !== "currency") {
      throw new UserError(`${name}: per_person only applies to currency fields`);
    }
    return {
      field,
      get: (l) => {
        const v = l.values[name] ?? null;
        return perPersonFlag && typeof v === "number" ? perPerson(v, trip.group_size) : v;
      },
    };
  }
  const core = CORE[name];
  if (core) return { get: core };
  throw new UserError(
    `Unknown field "${name}". Custom fields: ${fields.map((f) => f.key).join(", ") || "(none)"}; built-in: ${Object.keys(CORE).join(", ")}.`,
  );
}

function compare(a: FieldValue, b: FieldValue): number {
  if (typeof a === "number" && typeof b === "number") return a - b;
  if (typeof a === "boolean" && typeof b === "boolean") return Number(a) - Number(b);
  return String(a).localeCompare(String(b), undefined, { sensitivity: "base", numeric: true });
}

function conditionValue(g: Getter, c: Condition, raw: unknown): FieldValue {
  if (!g.field) {
    if (typeof raw === "number" || typeof raw === "string" || typeof raw === "boolean") return raw;
    throw new UserError(`${c.field}: value must be a string, number or boolean`);
  }
  // Text conditions match substrings and option names loosely, so don't force select options here.
  const field = g.field.type === "select" ? { ...g.field, type: "text" as const } : g.field;
  const res = coerceValue(field, raw);
  if (!res.ok) throw new UserError(`where ${c.field}: ${res.error}`);
  return res.value;
}

function matcher(trip: Trip, fields: Field[], c: Condition): (l: Listing) => boolean {
  if (!OPS.includes(c.op)) throw new UserError(`op must be one of ${OPS.join(", ")}`);
  const g = resolve(trip, fields, c.field, c.per_person);
  if (c.op === "is_set") return (l) => g.get(l) !== null;
  if (c.op === "is_not_set") return (l) => g.get(l) === null;
  if (c.value === undefined) throw new UserError(`where ${c.field} ${c.op}: value is required`);

  if (c.op === "in") {
    if (!Array.isArray(c.value)) throw new UserError(`where ${c.field} in: value must be an array`);
    const wanted = c.value.map((v) => conditionValue(g, c, v));
    return (l) => {
      const v = g.get(l);
      return v !== null && wanted.some((w) => w !== null && compare(v, w) === 0);
    };
  }

  const target = conditionValue(g, c, c.value);
  if (target === null)
    throw new UserError(`where ${c.field} ${c.op}: use is_set / is_not_set to test for empty values`);
  return (l) => {
    const v = g.get(l);
    if (c.op === "neq") return v === null || compare(v, target) !== 0;
    if (v === null) return false;
    switch (c.op) {
      case "eq":
        return compare(v, target) === 0;
      case "lt":
        return compare(v, target) < 0;
      case "lte":
        return compare(v, target) <= 0;
      case "gt":
        return compare(v, target) > 0;
      case "gte":
        return compare(v, target) >= 0;
      case "contains":
        return String(v).toLowerCase().includes(String(target).toLowerCase());
      default:
        return false;
    }
  };
}

export function queryListings(trip: Trip, fields: Field[], listings: Listing[], q: QueryInput): Listing[] {
  let rows = listings;
  if (q.status?.length) {
    const bad = q.status.filter((s) => !STATUSES.includes(s as never));
    if (bad.length) throw new UserError(`status must be among ${STATUSES.join(", ")}`);
    rows = rows.filter((l) => q.status?.includes(l.status));
  }
  if (q.search?.trim()) {
    const needle = q.search.trim().toLowerCase();
    rows = rows.filter((l) =>
      [l.title, l.notes, l.address, ...Object.values(l.values).filter((v) => typeof v === "string")]
        .filter(Boolean)
        .some((s) => String(s).toLowerCase().includes(needle)),
    );
  }
  for (const c of q.where ?? []) {
    const m = matcher(trip, fields, c);
    rows = rows.filter(m);
  }
  if (q.sort?.length) {
    const keys = q.sort.map((s) => ({ g: resolve(trip, fields, s.field), dir: s.dir === "desc" ? -1 : 1 }));
    rows = [...rows].sort((a, b) => {
      for (const { g, dir } of keys) {
        const va = g.get(a);
        const vb = g.get(b);
        // Empty values sort last in both directions.
        if (va === null && vb === null) continue;
        if (va === null) return 1;
        if (vb === null) return -1;
        const c = compare(va, vb);
        if (c !== 0) return c * dir;
      }
      return a.id - b.id;
    });
  }
  if (q.limit !== undefined) rows = rows.slice(0, Math.max(0, q.limit));
  return rows;
}

/** Range and best listing(s) per number/currency field across the given listings. */
export function fieldStats(fields: Field[], listings: Listing[]) {
  const stats: Record<string, { min: number; max: number; best_ids?: number[] }> = {};
  for (const f of fields) {
    if (f.type !== "number" && f.type !== "currency") continue;
    const vals = listings
      .map((l) => ({ id: l.id, v: l.values[f.key] }))
      .filter((x): x is { id: number; v: number } => typeof x.v === "number");
    if (vals.length === 0) continue;
    const min = Math.min(...vals.map((x) => x.v));
    const max = Math.max(...vals.map((x) => x.v));
    const s: { min: number; max: number; best_ids?: number[] } = { min, max };
    if (f.better && min !== max) {
      const best = f.better === "lower" ? min : max;
      s.best_ids = vals.filter((x) => x.v === best).map((x) => x.id);
    }
    stats[f.key] = s;
  }
  return stats;
}
