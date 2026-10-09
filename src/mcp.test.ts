import { beforeEach, describe, expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { openDb } from "./db";
import { handleMcp } from "./mcp";

// Drives the real HTTP handler through the SDK client, as Claude would.
async function connect() {
  const db = openDb(":memory:");
  const client = new Client({ name: "test", version: "1" });
  const transport = new StreamableHTTPClientTransport(new URL("http://test/mcp"), {
    fetch: (url, init) => handleMcp(new Request(url, init), { db, allowCreate: () => true }),
  });
  await client.connect(transport);

  // biome-ignore lint/suspicious/noExplicitAny: tool results are free-form JSON
  const call = async (name: string, args: Record<string, unknown>): Promise<any> => {
    const res = await client.callTool({ name, arguments: args });
    const text = (res.content as Array<{ text: string }>)[0]?.text ?? "";
    if (res.isError) throw new Error(text);
    return JSON.parse(text);
  };
  return { db, client, call };
}

let ctx: Awaited<ReturnType<typeof connect>>;
let trip: string;

beforeEach(async () => {
  ctx = await connect();
  const created = await ctx.call("create_trip", {
    name: "Algarve 2027",
    group_size: 6,
    destination: "Lagos, Portugal",
    fields: [
      { label: "Swimming Pool", type: "boolean", better: "higher" },
      { label: "Hot tub", type: "boolean" },
      { label: "BBQ", type: "boolean" },
      { label: "# bedrooms", type: "number", better: "higher" },
      { label: "Price", type: "currency", per_person: true, better: "lower" },
    ],
  });
  trip = created.trip.link;
});

describe("mcp", () => {
  test("advertises instructions and tools", async () => {
    expect(ctx.client.getInstructions()).toContain("secret link");
    const { tools } = await ctx.client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual([
      "add_comment",
      "add_listings",
      "create_trip",
      "define_fields",
      "delete_field",
      "delete_listings",
      "get_listing",
      "get_trip",
      "query_listings",
      "refresh_listing",
      "update_field",
      "update_listings",
      "update_trip",
    ]);
  });

  test("create_trip returns a link and the derived field keys", async () => {
    const t = await ctx.call("get_trip", { trip });
    expect(trip).toMatch(/\/t\/[A-Za-z0-9]{16}$/);
    expect(t.fields.map((f: { key: string }) => f.key)).toEqual([
      "swimming_pool",
      "hot_tub",
      "bbq",
      "bedrooms",
      "price",
    ]);
  });

  test("imports sheet-style rows and answers per-person questions", async () => {
    const { added } = await ctx.call("add_listings", {
      trip,
      read_pages: false,
      listings: [
        {
          title: "Villa Sol",
          url: "https://www.airbnb.com/rooms/1",
          values: { swimming_pool: "✓", hot_tub: "no", bbq: "yes", bedrooms: "4", price: "€2.400" },
        },
        {
          title: "Casa Mar",
          url: "https://www.airbnb.com/rooms/2",
          values: { swimming_pool: "x", bedrooms: 3, price: "1,500" },
        },
        { title: "Town flat", values: { swimming_pool: false, bedrooms: 2, price: 900 }, notes: "Near the bars" },
      ],
    });
    expect(added.map((a: { id: number }) => a.id)).toHaveLength(3);

    const res = await ctx.call("query_listings", {
      trip,
      where: [
        { field: "swimming_pool", op: "eq", value: "yes" },
        { field: "price", op: "lte", value: "€300", per_person: true },
      ],
      sort: [{ field: "price" }],
    });
    expect(res.listings.map((l: { title: string }) => l.title)).toEqual(["Casa Mar"]);
    expect(res.listings[0].per_person).toEqual({ price: 250 });

    const all = await ctx.call("query_listings", { trip, sort: [{ field: "bedrooms", dir: "desc" }] });
    expect(all.listings.map((l: { title: string }) => l.title)).toEqual(["Villa Sol", "Casa Mar", "Town flat"]);
    expect(all.stats.price).toEqual({ min: 900, max: 2400, best_ids: [added[2].id] });
  });

  test("a batch with problems adds nothing and lists every problem", async () => {
    await ctx.call("add_listings", {
      trip,
      read_pages: false,
      listings: [{ title: "A", url: "https://airbnb.com/rooms/9" }],
    });
    const attempt = ctx.call("add_listings", {
      trip,
      read_pages: false,
      listings: [
        { title: "Dup", url: "https://www.airbnb.com/rooms/9?check_in=2027-06-01" },
        { title: "Bad", values: { pool: true, bedrooms: "lots" } },
        { title: "Notes in values", values: { notes: "x" } },
      ],
    });
    await expect(attempt).rejects.toThrow(
      /already in this trip as #\d+[\s\S]*pool: unknown field[\s\S]*bedrooms: expected a number[\s\S]*built-in property/,
    );
    const t = await ctx.call("get_trip", { trip });
    expect(t.listings).toHaveLength(1);
  });

  test("update_listings merges values, clears with null, and sets status", async () => {
    const { added } = await ctx.call("add_listings", {
      trip,
      read_pages: false,
      listings: [{ title: "Villa", values: { swimming_pool: true, price: 1000 } }],
    });
    const id = added[0].id;
    const { updated } = await ctx.call("update_listings", {
      trip,
      updates: [{ id, status: "chosen", values: { hot_tub: "yes", price: null } }],
    });
    expect(updated[0]).toMatchObject({ status: "chosen", values: { swimming_pool: true, hot_tub: true } });
    expect(updated[0].values.price).toBeUndefined();
  });

  test("field changes convert or protect existing values", async () => {
    await ctx.call("add_listings", {
      trip,
      read_pages: false,
      listings: [{ title: "A", values: { bedrooms: 3 } }],
    });
    await expect(ctx.call("update_field", { trip, key: "bedrooms", type: "boolean" })).rejects.toThrow(
      /can't be converted/,
    );
    const renamed = await ctx.call("update_field", { trip, key: "bedrooms", new_key: "rooms", label: "Rooms" });
    expect(renamed.field).toMatchObject({ key: "rooms", label: "Rooms", type: "number" });
    const q = await ctx.call("query_listings", { trip, where: [{ field: "rooms", op: "gte", value: 3 }] });
    expect(q.matched).toBe(1);

    await ctx.call("define_fields", { trip, fields: [{ label: "Area", type: "select", options: ["Beach", "Town"] }] });
    await expect(
      ctx.call("add_listings", { trip, read_pages: false, listings: [{ title: "B", values: { area: "Hills" } }] }),
    ).rejects.toThrow(/Beach, Town/);
  });

  test("reserved and duplicate field keys are refused", async () => {
    await expect(ctx.call("define_fields", { trip, fields: [{ label: "Notes", type: "text" }] })).rejects.toThrow(
      /built-in/,
    );
    await expect(ctx.call("define_fields", { trip, fields: [{ label: "Price", type: "currency" }] })).rejects.toThrow(
      /already exists/,
    );
  });

  test("unknown trips get a helpful error", async () => {
    await expect(ctx.call("get_trip", { trip: "https://trips.example/t/nope" })).rejects.toThrow(/Trip not found/);
  });

  test("comments and listing detail", async () => {
    const { added } = await ctx.call("add_listings", {
      trip,
      read_pages: false,
      listings: [{ title: "A", address: "Rua X" }],
    });
    await ctx.call("add_comment", { trip, listing_id: added[0].id, body: "Love the view", author: "Sam" });
    const l = await ctx.call("get_listing", { trip, id: added[0].id });
    expect(l.comments[0]).toMatchObject({ author: "Sam", body: "Love the view" });
    expect(l.map).toBe("not on map");
  });
});
