import { describe, expect, test } from "bun:test";
import { coerceValue, type Field, parseLooseNumber, slugify } from "./coerce";

const field = (type: Field["type"], extra: Partial<Field> = {}): Field => ({
  key: "f",
  label: "F",
  type,
  better: null,
  per_person: false,
  unit: null,
  options: null,
  description: null,
  position: 0,
  ...extra,
});

describe("slugify", () => {
  test.each([
    ["Swimming Pool", "swimming_pool"],
    ["# bedrooms", "bedrooms"],
    ["Hot tub", "hot_tub"],
    ["BBQ", "bbq"],
    ["Distância à praia", "distancia_a_praia"],
    ["2nd floor", "f_2nd_floor"],
    ["!!!", "field"],
  ])("%s → %s", (label, key) => expect(slugify(label)).toBe(key));
});

describe("parseLooseNumber", () => {
  test.each([
    ["1,234.50", true, 1234.5],
    ["1.234,50", true, 1234.5],
    ["€1.200", true, 1200],
    ["€1.200", false, 1.2],
    ["4.91", false, 4.91],
    ["€ 450", true, 450],
    ["450 €", true, 450],
    ["3 bedrooms", false, 3],
    ["1,5", false, 1.5],
    ["1,250", true, 1250],
    ["1.2k", true, 1200],
    ["2 400", true, 2400],
    ["$1,999.99/night", true, 1999.99],
    ["none", true, null],
  ] as const)("%s (currency=%s) → %s", (input, dot, out) => expect(parseLooseNumber(input, dot)).toBe(out));
});

describe("coerceValue", () => {
  test("booleans accept spreadsheet conventions", () => {
    for (const t of [true, "yes", "Y", "✓", "x", 1, "TRUE"]) {
      expect(coerceValue(field("boolean"), t)).toEqual({ ok: true, value: true });
    }
    for (const f of [false, "no", "✗", 0, "-"]) {
      expect(coerceValue(field("boolean"), f)).toEqual({ ok: true, value: false });
    }
    expect(coerceValue(field("boolean"), "maybe").ok).toBe(false);
  });

  test("empty input clears", () => {
    expect(coerceValue(field("number"), "")).toEqual({ ok: true, value: null });
    expect(coerceValue(field("number"), null)).toEqual({ ok: true, value: null });
  });

  test("currency rounds to cents", () => {
    expect(coerceValue(field("currency"), "€1.234,567")).toEqual({ ok: true, value: 1234.57 });
  });

  test("select matches options case-insensitively and reports them", () => {
    const f = field("select", { options: ["Beachfront", "Town"] });
    expect(coerceValue(f, "beachfront")).toEqual({ ok: true, value: "Beachfront" });
    const res = coerceValue(f, "Mountain");
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toContain("Beachfront, Town");
  });
});
