import type { Field, FieldValue } from "../src/coerce";
import type { Comment, Listing, Status, Trip } from "../src/service";

export type { Comment, Field, FieldValue, Listing, Status, Trip };

export type TripState = {
  trip: Trip;
  link: string;
  mcp_url: string;
  fields: Field[];
  listings: Listing[];
  comments: Comment[];
};

export const STATUS_ORDER: Status[] = ["chosen", "shortlisted", "candidate", "rejected"];
export const STATUS_LABEL: Record<Status, string> = {
  candidate: "Candidate",
  shortlisted: "Shortlisted",
  chosen: "Chosen",
  rejected: "Rejected",
};

export const tripId = location.pathname.split("/")[2] ?? "";

export class ApiError extends Error {}

export async function api<T>(path: string, init?: { method?: string; body?: unknown }): Promise<T> {
  const res = await fetch(`/api/trips/${tripId}${path}`, {
    method: init?.method ?? "GET",
    headers: init?.body !== undefined ? { "Content-Type": "application/json" } : undefined,
    body: init?.body !== undefined ? JSON.stringify(init.body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new ApiError(data.error ?? `Request failed (${res.status})`);
  return data as T;
}

/** localStorage that never throws (private windows, blocked storage). */
export const store = {
  get<T>(key: string, fallback: T): T {
    try {
      const raw = localStorage.getItem(key);
      return raw === null ? fallback : (JSON.parse(raw) as T);
    } catch {
      return fallback;
    }
  },
  set(key: string, value: unknown): void {
    try {
      localStorage.setItem(key, JSON.stringify(value));
    } catch {
      // Not persisted; fine.
    }
  },
};

export function money(v: number, currency: string): string {
  try {
    return new Intl.NumberFormat(undefined, {
      style: "currency",
      currency,
      maximumFractionDigits: Number.isInteger(v) || Math.abs(v) >= 100 ? 0 : 2,
    }).format(v);
  } catch {
    return `${v} ${currency}`;
  }
}

export function perPerson(v: number, groupSize: number): number {
  return Math.round((v / Math.max(1, groupSize)) * 100) / 100;
}

export function formatValue(f: Field, v: FieldValue | undefined, currency: string): string {
  if (v === null || v === undefined) return "";
  if (f.type === "boolean") return v ? "Yes" : "No";
  if (f.type === "currency" && typeof v === "number") return money(v, currency);
  if (f.type === "number" && typeof v === "number") {
    const n = new Intl.NumberFormat(undefined, { maximumFractionDigits: 2 }).format(v);
    return f.unit ? `${n} ${f.unit}` : n;
  }
  return String(v);
}

export function hostOf(url: string | null): string {
  if (!url) return "";
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return "";
  }
}

/** The best value per field among the given listings, for fields with a preferred direction. */
export function bestValues(fields: Field[], listings: Listing[]): Map<string, FieldValue> {
  const best = new Map<string, FieldValue>();
  for (const f of fields) {
    if (!f.better) continue;
    if (f.type === "boolean") {
      best.set(f.key, f.better === "higher");
      continue;
    }
    const nums = listings.map((l) => l.values[f.key]).filter((v): v is number => typeof v === "number");
    if (nums.length < 2) continue;
    const min = Math.min(...nums);
    const max = Math.max(...nums);
    if (min !== max) best.set(f.key, f.better === "lower" ? min : max);
  }
  return best;
}

/** The currency field whose per-person amount labels map pins and cards. */
export function priceField(fields: Field[]): Field | undefined {
  return fields.find((f) => f.type === "currency" && f.per_person) ?? fields.find((f) => f.type === "currency");
}
