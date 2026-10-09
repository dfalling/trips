// Turning loosely-typed input (spreadsheet cells, Claude's tool arguments, form inputs)
// into the stored value for a field. Lenient on purpose: "✓", "yes", "€1.200", "3 bedrooms"
// all parse, so imports and AI edits rarely need a second attempt.

export const FIELD_TYPES = ["boolean", "number", "currency", "text", "select"] as const;
export type FieldType = (typeof FIELD_TYPES)[number];

export type FieldValue = boolean | number | string | null;

export type Field = {
  key: string;
  label: string;
  type: FieldType;
  better: "higher" | "lower" | null;
  per_person: boolean;
  unit: string | null;
  options: string[] | null;
  description: string | null;
  position: number;
};

// Keys that name a listing's built-in properties, so a custom field can't shadow them.
export const RESERVED_KEYS = new Set([
  "id",
  "title",
  "name",
  "url",
  "link",
  "status",
  "notes",
  "votes",
  "comments",
  "address",
  "location",
  "photos",
  "lat",
  "lng",
]);

export function slugify(label: string): string {
  const slug = label
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/#/g, " ")
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
  if (!slug) return "field";
  return /^[0-9]/.test(slug) ? `f_${slug}` : slug;
}

const TRUE_WORDS = new Set(["true", "yes", "y", "1", "x", "✓", "✔", "✅", "si", "sí", "ja", "oui", "on"]);
const FALSE_WORDS = new Set(["false", "no", "n", "0", "✗", "✘", "❌", "-", "nope", "nein", "non", "off"]);

/**
 * Parses numbers written the way people write them: "1,234.50", "1.234,50", "€ 450",
 * "3 bedrooms", "1.2k". With `dotGroupsThousands`, a lone dot followed by exactly three
 * digits ("€1.200") is a thousands separator, which suits prices but not ratings.
 */
export function parseLooseNumber(input: string, dotGroupsThousands: boolean): number | null {
  const m = input.match(/-?\d[\d.,'   ]*/);
  if (!m) return null;
  let raw = m[0].replace(/['   ]/g, "").replace(/[.,]+$/, "");
  const rest = input.slice((m.index ?? 0) + m[0].length).trim();
  const thousandsSuffix = /^k\b/i.test(rest);

  const hasComma = raw.includes(",");
  const hasDot = raw.includes(".");
  if (hasComma && hasDot) {
    const decimal = raw.lastIndexOf(",") > raw.lastIndexOf(".") ? "," : ".";
    const group = decimal === "," ? "." : ",";
    raw = raw.split(group).join("").replace(decimal, ".");
  } else if (hasComma) {
    const parts = raw.split(",");
    const lastLen = parts[parts.length - 1]?.length ?? 0;
    raw = parts.length > 2 || lastLen === 3 ? parts.join("") : raw.replace(",", ".");
  } else if (hasDot) {
    const parts = raw.split(".");
    const lastLen = parts[parts.length - 1]?.length ?? 0;
    if (parts.length > 2 || (dotGroupsThousands && lastLen === 3)) {
      raw = parts.join("");
    }
  }
  const n = Number(raw);
  if (!Number.isFinite(n)) return null;
  return thousandsSuffix ? n * 1000 : n;
}

export type CoerceResult = { ok: true; value: FieldValue } | { ok: false; error: string };

export function coerceValue(field: Field, input: unknown): CoerceResult {
  if (input === null || input === undefined) return { ok: true, value: null };
  if (typeof input === "string" && input.trim() === "") return { ok: true, value: null };

  const fail = (why: string): CoerceResult => ({
    ok: false,
    error: `${field.key}: ${why} (got ${JSON.stringify(input)})`,
  });

  switch (field.type) {
    case "boolean": {
      if (typeof input === "boolean") return { ok: true, value: input };
      if (typeof input === "number") {
        if (input === 1 || input === 0) return { ok: true, value: input === 1 };
        return fail("expected true/false");
      }
      const s = String(input).trim().toLowerCase();
      if (TRUE_WORDS.has(s)) return { ok: true, value: true };
      if (FALSE_WORDS.has(s)) return { ok: true, value: false };
      return fail("expected true/false (or yes/no)");
    }
    case "number":
    case "currency": {
      if (typeof input === "number") {
        return Number.isFinite(input) ? { ok: true, value: input } : fail("not a number");
      }
      if (typeof input === "boolean") return fail("expected a number");
      const n = parseLooseNumber(String(input), field.type === "currency");
      if (n === null) return fail("expected a number");
      return { ok: true, value: field.type === "currency" ? Math.round(n * 100) / 100 : n };
    }
    case "text": {
      const s = String(input).trim();
      if (s.length > 2000) return fail("text longer than 2000 characters");
      return { ok: true, value: s };
    }
    case "select": {
      const s = String(input).trim();
      const match = field.options?.find((o) => o.toLowerCase() === s.toLowerCase());
      if (match) return { ok: true, value: match };
      return fail(`not one of the options [${(field.options ?? []).join(", ")}]; add it with update_field first`);
    }
  }
}
