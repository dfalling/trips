import type { Database } from "bun:sqlite";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { z } from "zod";
import { FIELD_TYPES, type Field } from "./coerce";
import { fieldStats, OPS, perPerson, queryListings } from "./query";
import {
  addComment,
  addListings,
  createTrip,
  defineFields,
  deleteField,
  deleteListings,
  enrichListing,
  getListing,
  getTrip,
  type Listing,
  listFields,
  listListings,
  STATUSES,
  type Trip,
  tripUrl,
  UserError,
  updateField,
  updateListings,
  updateTrip,
} from "./service";

const INSTRUCTIONS = `Trips is a shared board where a group of friends compares places to stay for a trip (Airbnb, Booking.com, hotels, …), with a table, a map, photos, votes and comments on a web page.

Access model: there are no accounts. Every trip has a secret link like https://…/t/<id>. Anyone with the link can view and edit the trip, and that link (or the id in it) is the "trip" argument of every tool. Trips can't be listed or searched, so if the user hasn't shared a link in this conversation, ask for it or offer to create a trip. After create_trip, show the user the link and tell them to keep it and share it with their group; it can't be recovered.

Working with a trip:
- Call get_trip first. It returns the trip's custom fields (key, type, unit, options) and a list of listings. Field keys are what you use in "values", "where" and "sort".
- Fields are defined per trip, because every trip cares about different things (a pool for a summer villa, a sauna for a ski chalet). Before setting an attribute the trip doesn't track yet, add it with define_fields. Keep fields few and decision-relevant; propose a set and confirm it with the user when starting a trip or importing a sheet.
- Price: store the total cost of the stay in a currency field with per_person: true and better: "lower". Per-person amounts are computed from the trip's group_size; never store per-person prices yourself. Prices usually depend on dates, so mention the trip dates when asking the user for prices.
- Mark better: "lower" or "higher" on number/currency/boolean fields where one direction is clearly preferable; the web page highlights the best value in each such column and query_listings reports it.
- Built-in listing properties are not fields: title, url, status, notes, address, lat/lng, photos. Set them at the top level of a listing, not inside values.

Adding listings:
- add_listings takes a whole batch in one call, and nothing is written if any item is invalid, so fix the reported problems and resend the full batch.
- With a url, the server reads the listing page and fills in title, photos, map location and facts such as bedrooms, bathrooms, guests and rating (into matching number fields that are still empty). Airbnb pages work (map location is approximate, and the price is never available). Booking.com and many other sites block automated reads.
- When a page can't be read, or to get the price, ask the user to paste the listing text or a screenshot and extract the values from that. If you can browse the web yourself, you may also read the page and pass the values.
- Values are parsed leniently: "yes", "✓", "€1.200", "1,250.50", "3 bedrooms" all work. In update_listings, null clears a value.
- An address without coordinates is geocoded so the listing appears on the map.

Importing a spreadsheet: map columns to built-in properties where they fit (Link → url, Name → title, Notes → notes, Address → address) and define fields for the rest, choosing types from the data (checkmarks → boolean, amounts → currency, counts → number, a few repeated words → select). Then add all rows with one add_listings call.

Answering questions: use query_listings ("which have a pool and cost under €100 per person?" → where pool eq true and price lte 100 with per_person: true). Its stats give the min, max and best listing for each numeric field. Mention listings by #id and title, and give the trip link when pointing people to the board.

Group decisions: people vote on the web page; you can set status (candidate → shortlisted → chosen, or rejected) and add comments when the user asks. Only mark a listing "chosen" when the user says the group decided.`;

const fieldTypeDoc =
  "boolean (yes/no, e.g. pool), number (counts or measures, e.g. bedrooms, distance; use unit), currency (money in the trip currency, e.g. price), text (free text), select (one of a fixed list of options)";

const fieldInput = z.object({
  label: z.string().describe("Column name shown to people, e.g. 'Hot tub' or 'Walk to beach'"),
  key: z
    .string()
    .optional()
    .describe(
      "snake_case identifier used in values/where/sort. Derived from the label if omitted ('Hot tub' → hot_tub)",
    ),
  type: z.enum(FIELD_TYPES).describe(fieldTypeDoc),
  better: z
    .enum(["higher", "lower"])
    .optional()
    .describe(
      "Which direction is preferable, for highlighting the best value (price: lower; bedrooms: higher; boolean: higher means true is good)",
    ),
  per_person: z
    .boolean()
    .optional()
    .describe(
      "currency only: the value is a total for the group and should also be shown divided by the trip's group_size",
    ),
  unit: z.string().optional().describe("number only: unit shown after values, e.g. 'km', 'min walk', 'm²'"),
  options: z.array(z.string()).optional().describe("select only: the allowed options"),
  description: z.string().optional().describe("What the field means or how to fill it in; shown as a tooltip"),
});

const valuesSchema = z
  .record(z.string(), z.union([z.boolean(), z.number(), z.string(), z.null()]))
  .describe('Custom field values keyed by field key, e.g. {"pool": true, "price": 1840, "bedrooms": 4}');

const listingInput = z.object({
  title: z.string().optional().describe("Listing name. Optional when url is given and the page can be read"),
  url: z.string().optional().describe("Link to the listing (Airbnb, Booking.com, …)"),
  status: z.enum(STATUSES).optional().describe("Defaults to candidate"),
  notes: z.string().optional(),
  address: z
    .string()
    .optional()
    .describe("Street address or place name; geocoded for the map when there are no coordinates"),
  lat: z.number().optional(),
  lng: z.number().optional(),
  location_approx: z.boolean().optional().describe("true when lat/lng is only roughly where the place is"),
  photos: z.array(z.string()).optional().describe("Photo URLs; filled from the listing page when omitted"),
  values: valuesSchema.optional(),
});

const listingUpdate = z.object({
  id: z.number().int().describe("Listing id (the # number)"),
  title: z.string().optional(),
  url: z.string().nullable().optional(),
  status: z.enum(STATUSES).optional(),
  notes: z.string().nullable().optional().describe("Replaces the notes; null clears them"),
  address: z.string().nullable().optional(),
  lat: z.number().nullable().optional(),
  lng: z.number().nullable().optional(),
  location_approx: z.boolean().optional(),
  photos: z.array(z.string()).optional().describe("Replaces the photo list"),
  values: valuesSchema.optional().describe("Only the given keys change; others are kept. null clears a value"),
});

const tripArg = z.string().describe("The trip link (https://…/t/<id>) or just its id");

// ---------------------------------------------------------------------------------------
// Result shaping: compact JSON, since Claude reads every token.

function fieldOut(f: Field) {
  const out: Record<string, unknown> = { key: f.key, label: f.label, type: f.type };
  if (f.better) out.better = f.better;
  if (f.per_person) out.per_person = true;
  if (f.unit) out.unit = f.unit;
  if (f.options) out.options = f.options;
  if (f.description) out.description = f.description;
  return out;
}

function tripOut(t: Trip) {
  const out: Record<string, unknown> = {
    link: tripUrl(t.id),
    name: t.name,
    group_size: t.group_size,
    currency: t.currency,
  };
  if (t.destination) out.destination = t.destination;
  if (t.start_date) out.start_date = t.start_date;
  if (t.end_date) out.end_date = t.end_date;
  if (t.notes) out.notes = t.notes;
  return out;
}

function listingOut(trip: Trip, fields: Field[], l: Listing, full = false) {
  const out: Record<string, unknown> = { id: l.id, title: l.title, status: l.status };
  if (l.url) out.url = l.url;
  out.values = l.values;
  const pp: Record<string, number> = {};
  for (const f of fields) {
    const v = l.values[f.key];
    if (f.per_person && typeof v === "number") pp[f.key] = perPerson(v, trip.group_size);
  }
  if (Object.keys(pp).length) out.per_person = pp;
  if (l.votes) out.votes = l.votes;
  if (l.comment_count) out.comments = l.comment_count;
  if (l.notes) out.notes = l.notes;
  if (Object.keys(l.facts).length) out.page_facts = l.facts;
  out.map = l.lat === null ? "not on map" : l.location_approx ? "approximate" : "exact";
  if (full) {
    if (l.address) out.address = l.address;
    if (l.lat !== null) out.coordinates = [l.lat, l.lng];
    out.photos = l.photos;
  } else if (l.photos.length) {
    out.photos = l.photos.length;
  }
  return out;
}

const json = (data: unknown) => ({ content: [{ type: "text" as const, text: JSON.stringify(data) }] });

function guard<A>(fn: (args: A) => unknown | Promise<unknown>) {
  return async (args: A) => {
    try {
      return json(await fn(args));
    } catch (e) {
      if (e instanceof UserError) {
        return { content: [{ type: "text" as const, text: e.message }], isError: true };
      }
      console.error("[trips] tool error", e);
      return {
        content: [
          { type: "text" as const, text: "Internal error; the change may not have been saved. Check with get_trip." },
        ],
        isError: true,
      };
    }
  };
}

// ---------------------------------------------------------------------------------------

export type McpContext = { db: Database; allowCreate: () => boolean };

export function buildMcpServer({ db, allowCreate }: McpContext): McpServer {
  const server = new McpServer(
    { name: "trips", title: "Trips: compare places to stay", version: "1.0.0" },
    { instructions: INSTRUCTIONS },
  );

  const tripSummary = (trip: Trip) => {
    const fields = listFields(db, trip.id);
    const listings = listListings(db, trip.id);
    const counts: Record<string, number> = {};
    for (const l of listings) counts[l.status] = (counts[l.status] ?? 0) + 1;
    return {
      trip: tripOut(trip),
      fields: fields.map(fieldOut),
      listing_counts: counts,
      listings: listings.map((l) => ({ id: l.id, title: l.title, status: l.status })),
    };
  };

  server.registerTool(
    "create_trip",
    {
      title: "Create trip",
      description:
        "Create a new trip board and get its secret link. Optionally define the comparison fields in the same call. Always show the returned link to the user: it is the only way to open the trip.",
      inputSchema: {
        name: z.string().describe("e.g. 'Algarve, June 2027'"),
        group_size: z
          .number()
          .int()
          .min(1)
          .max(100)
          .describe("How many people split the cost; used for per-person prices"),
        currency: z.string().optional().describe("ISO 4217 code for prices, default EUR"),
        destination: z.string().optional().describe("Area or town; also helps geocode addresses"),
        start_date: z.string().optional().describe("YYYY-MM-DD"),
        end_date: z.string().optional().describe("YYYY-MM-DD"),
        notes: z.string().optional(),
        fields: z.array(fieldInput).optional().describe("Comparison fields to create right away"),
      },
    },
    guard(async ({ fields, ...input }) => {
      if (!allowCreate()) {
        throw new UserError("Too many trips created from this address recently. Try again in an hour.");
      }
      const trip = createTrip(db, input);
      if (fields?.length) {
        try {
          defineFields(db, trip.id, fields);
        } catch (e) {
          if (!(e instanceof UserError)) throw e;
          return {
            ...tripSummary(trip),
            warning: `The trip was created, but its fields were not: ${e.message}. Call define_fields with corrected fields.`,
          };
        }
      }
      return tripSummary(trip);
    }),
  );

  server.registerTool(
    "get_trip",
    {
      title: "Get trip",
      description:
        "Get a trip's settings, its custom fields (keys, types, units, options), listing counts by status and a short list of all listings. Call this first when working with a trip.",
      inputSchema: { trip: tripArg },
      annotations: { readOnlyHint: true },
    },
    guard(({ trip }) => tripSummary(getTrip(db, trip))),
  );

  server.registerTool(
    "update_trip",
    {
      title: "Update trip",
      description:
        "Change a trip's name, group size, currency, destination, dates or notes. Changing group_size changes every per-person price; changing currency only relabels amounts (no conversion).",
      inputSchema: {
        trip: tripArg,
        name: z.string().optional(),
        group_size: z.number().int().min(1).max(100).optional(),
        currency: z.string().optional(),
        destination: z.string().nullable().optional(),
        start_date: z.string().nullable().optional(),
        end_date: z.string().nullable().optional(),
        notes: z.string().nullable().optional(),
      },
      annotations: { idempotentHint: true },
    },
    guard(({ trip, ...patch }) => ({ trip: tripOut(updateTrip(db, trip, patch)) })),
  );

  server.registerTool(
    "define_fields",
    {
      title: "Define fields",
      description:
        "Add custom comparison fields (columns) to a trip, e.g. Pool (boolean), Price (currency, per_person, better lower), Bedrooms (number, better higher), Beach distance (number, unit 'min walk', better lower). Fails without changes if any key already exists; use update_field to change an existing field.",
      inputSchema: { trip: tripArg, fields: z.array(fieldInput).min(1) },
    },
    guard(({ trip, fields }) => ({ fields: defineFields(db, trip, fields).map(fieldOut) })),
  );

  server.registerTool(
    "update_field",
    {
      title: "Update field",
      description:
        "Change a field's label, key, type, unit, options, better, per_person, description or column position. Existing values are converted to a new type; if some can't be, nothing changes and they're listed (pass force: true to clear those values instead).",
      inputSchema: {
        trip: tripArg,
        key: z.string().describe("Current key of the field"),
        new_key: z.string().optional().describe("Rename the key; existing values move with it"),
        label: z.string().optional(),
        type: z.enum(FIELD_TYPES).optional(),
        better: z.enum(["higher", "lower"]).nullable().optional(),
        per_person: z.boolean().optional(),
        unit: z.string().nullable().optional(),
        options: z.array(z.string()).optional().describe("select only: the full new list of options"),
        description: z.string().nullable().optional(),
        position: z.number().int().optional().describe("Column order; lower comes first"),
        force: z.boolean().optional(),
      },
    },
    guard(({ trip, key, ...patch }) => {
      const { field, dropped } = updateField(db, trip, key, patch);
      return { field: fieldOut(field), cleared_values: dropped };
    }),
  );

  server.registerTool(
    "delete_field",
    {
      title: "Delete field",
      description: "Remove a custom field and its value on every listing. Confirm with the user first.",
      inputSchema: { trip: tripArg, key: z.string() },
      annotations: { destructiveHint: true },
    },
    guard(({ trip, key }) => deleteField(db, trip, key)),
  );

  server.registerTool(
    "add_listings",
    {
      title: "Add listings",
      description:
        "Add one or more places to stay (up to 100 per call). Each needs a url or a title. With a url, the listing page is read to fill title, photos, map location and facts like bedrooms/rating where possible; the result says what was filled and warns when a page couldn't be read. Atomic: if any listing is invalid (unknown field, bad value, duplicate url) nothing is added and every problem is listed.",
      inputSchema: {
        trip: tripArg,
        listings: z.array(listingInput).min(1).max(100),
        read_pages: z
          .boolean()
          .optional()
          .describe("Read listing pages for missing details (default true). Set false for faster bulk imports"),
      },
    },
    guard(async ({ trip, listings, read_pages }) => {
      const added = await addListings(db, trip, listings, { enrich: read_pages });
      return { added, link: tripUrl(getTrip(db, trip).id) };
    }),
  );

  server.registerTool(
    "update_listings",
    {
      title: "Update listings",
      description:
        "Change one or more listings in one call: built-in properties (title, url, status, notes, address, lat/lng, photos) and custom field values. Only what you pass changes; in values, null clears a field. Atomic: nothing changes if any update is invalid. Use status to shortlist, reject or mark the group's choice.",
      inputSchema: { trip: tripArg, updates: z.array(listingUpdate).min(1).max(200) },
      annotations: { idempotentHint: true },
    },
    guard(async ({ trip, updates }) => {
      const t = getTrip(db, trip);
      const fields = listFields(db, t.id);
      const updated = await updateListings(db, t.id, updates);
      return { updated: updated.map((l) => listingOut(t, fields, l)) };
    }),
  );

  server.registerTool(
    "delete_listings",
    {
      title: "Delete listings",
      description:
        "Permanently delete listings with their votes and comments. Prefer status 'rejected' to keep a record; only delete when the user asks to remove entries (e.g. duplicates or mistakes).",
      inputSchema: { trip: tripArg, ids: z.array(z.number().int()).min(1) },
      annotations: { destructiveHint: true },
    },
    guard(({ trip, ids }) => deleteListings(db, trip, ids)),
  );

  server.registerTool(
    "query_listings",
    {
      title: "Query listings",
      description: `Filter and sort a trip's listings with their values, per-person prices, votes and comment counts, plus stats (min, max, best ids) for each numeric field over the matches. Conditions are ANDed. "field" is a custom field key or a built-in: id, title, url, status, notes, address, votes, comments, location. Ops: ${OPS.join(", ")} ("in" takes an array). Set per_person: true on a currency condition to compare the per-person amount. Example: where [{field:"pool",op:"eq",value:true},{field:"price",op:"lte",value:100,per_person:true}], sort [{field:"price"}].`,
      inputSchema: {
        trip: tripArg,
        where: z
          .array(
            z.object({
              field: z.string(),
              op: z.enum(OPS),
              value: z.unknown().optional(),
              per_person: z.boolean().optional(),
            }),
          )
          .optional(),
        status: z.array(z.enum(STATUSES)).optional().describe("Only these statuses. Omit for all, including rejected"),
        search: z.string().optional().describe("Case-insensitive text match on title, notes, address and text fields"),
        sort: z
          .array(z.object({ field: z.string(), dir: z.enum(["asc", "desc"]).optional() }))
          .optional()
          .describe("Empty values always sort last"),
        limit: z.number().int().min(1).optional(),
      },
      annotations: { readOnlyHint: true },
    },
    guard(({ trip, ...q }) => {
      const t = getTrip(db, trip);
      const fields = listFields(db, t.id);
      const all = listListings(db, t.id);
      const rows = queryListings(t, fields, all, q);
      return {
        currency: t.currency,
        group_size: t.group_size,
        matched: rows.length,
        total: all.length,
        listings: rows.map((l) => listingOut(t, fields, l)),
        stats: fieldStats(fields, rows),
      };
    }),
  );

  server.registerTool(
    "get_listing",
    {
      title: "Get listing",
      description:
        "Everything about one listing: all values, photos, coordinates, facts read from its page and comments.",
      inputSchema: { trip: tripArg, id: z.number().int() },
      annotations: { readOnlyHint: true },
    },
    guard(({ trip, id }) => {
      const t = getTrip(db, trip);
      const l = getListing(db, t.id, id);
      return {
        ...listingOut(t, listFields(db, t.id), l, true),
        comments: l.comments.map((c) => ({ id: c.id, author: c.author, body: c.body, at: c.created_at })),
      };
    }),
  );

  server.registerTool(
    "refresh_listing",
    {
      title: "Refresh listing from its page",
      description:
        "Re-read a listing's url to fill missing photos, map location, address and page facts (bedrooms, rating, …). With overwrite: true, also replaces existing title, photos, location and matching values.",
      inputSchema: { trip: tripArg, id: z.number().int(), overwrite: z.boolean().optional() },
    },
    guard(async ({ trip, id, overwrite }) => {
      const t = getTrip(db, trip);
      const { listing, filled } = await enrichListing(db, t.id, id, overwrite ?? false);
      return { filled, listing: listingOut(t, listFields(db, t.id), listing) };
    }),
  );

  server.registerTool(
    "add_comment",
    {
      title: "Add comment",
      description:
        "Add a comment to a listing, shown on the web page. Use when the user asks to note something for the group; put the user's name as author if known.",
      inputSchema: {
        trip: tripArg,
        listing_id: z.number().int(),
        body: z.string(),
        author: z.string().optional(),
      },
    },
    guard(({ trip, listing_id, body, author }) => addComment(db, trip, listing_id, body, author)),
  );

  return server;
}

/** Stateless streamable HTTP: a fresh server and transport per request, no sessions to track. */
export async function handleMcp(req: Request, ctx: McpContext): Promise<Response> {
  const server = buildMcpServer(ctx);
  const transport = new WebStandardStreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: true,
  });
  await server.connect(transport);
  try {
    return await transport.handleRequest(req);
  } finally {
    // The JSON response is fully built by now.
    void server.close();
  }
}
