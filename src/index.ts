import type { Server } from "bun";
import home from "../web/home.html";
import tripPage from "../web/trip.html";
import { openDb } from "./db";
import { handleMcp } from "./mcp";
import {
  addComment,
  addListings,
  deleteComment,
  deleteListings,
  getTrip,
  listComments,
  listFields,
  listListings,
  PUBLIC_URL,
  tripUrl,
  UserError,
  updateListings,
  updateTrip,
  vote,
} from "./service";

const DATA_DIR = process.env.DATA_DIR ?? "./data";
await Bun.$`mkdir -p ${DATA_DIR}`.quiet();
const db = openDb(`${DATA_DIR}/trips.db`);

// Trip creation is the only thing a stranger can do without a link, so it's rate limited.
const CREATE_LIMIT = Number(process.env.CREATE_LIMIT_PER_HOUR ?? 20);
const creations = new Map<string, number[]>();

function clientIp(req: Request, server: Server<undefined>): string {
  // Caddy sets X-Forwarded-For, replacing anything the client sent.
  return req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? server.requestIP(req)?.address ?? "unknown";
}

function allowCreate(ip: string): boolean {
  const now = Date.now();
  const recent = (creations.get(ip) ?? []).filter((t) => now - t < 3_600_000);
  if (recent.length >= CREATE_LIMIT) return false;
  recent.push(now);
  creations.set(ip, recent);
  return true;
}

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Accept, Authorization, Mcp-Session-Id, MCP-Protocol-Version",
  "Access-Control-Expose-Headers": "Mcp-Session-Id",
};

function json(body: unknown, status = 200): Response {
  return Response.json(body, { status, headers: { "Cache-Control": "no-store" } });
}

/** Runs a web API handler, turning input problems into 400s. */
async function api(fn: () => unknown | Promise<unknown>): Promise<Response> {
  try {
    return json((await fn()) ?? { ok: true });
  } catch (e) {
    if (e instanceof UserError) return json({ error: e.message }, 400);
    console.error("[trips] api error", e);
    return json({ error: "Internal error" }, 500);
  }
}

async function body<T>(req: Request): Promise<T> {
  try {
    return (await req.json()) as T;
  } catch {
    throw new UserError("Request body must be JSON");
  }
}

function tripState(id: string) {
  const trip = getTrip(db, id);
  return {
    trip,
    link: tripUrl(trip.id),
    mcp_url: `${PUBLIC_URL}/mcp`,
    fields: listFields(db, trip.id),
    listings: listListings(db, trip.id),
    comments: listComments(db, trip.id),
  };
}

const listingId = (raw: string) => {
  const n = Number(raw);
  if (!Number.isInteger(n)) throw new UserError("Bad listing id");
  return n;
};

// MapLibre's worker can't be bundled with the page; serve the prebuilt module as-is.
const maplibreWorker = Bun.file(Bun.resolveSync("maplibre-gl/dist/maplibre-gl-worker.mjs", import.meta.dir));

const port = Number(process.env.PORT ?? 3000);

const server = Bun.serve({
  port,
  development: process.env.NODE_ENV !== "production",
  routes: {
    "/": home,
    "/t/:id": tripPage,
    "/health": () => json({ name: "trips", status: "ok" }),
    "/vendor/maplibre-gl-worker.mjs": () =>
      new Response(maplibreWorker, {
        headers: { "Content-Type": "text/javascript", "Cache-Control": "public, max-age=86400" },
      }),

    "/mcp": async (req, srv) => {
      if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
      const res = await handleMcp(req, { db, allowCreate: () => allowCreate(clientIp(req, srv)) });
      for (const [k, v] of Object.entries(CORS)) res.headers.set(k, v);
      return res;
    },

    "/api/trips/:id": {
      GET: (req) => api(() => tripState(req.params.id)),
      PATCH: (req) => api(async () => updateTrip(db, req.params.id, await body(req))),
    },
    "/api/trips/:id/version": {
      GET: (req) => api(() => ({ version: getTrip(db, req.params.id).version })),
    },
    "/api/trips/:id/listings": {
      POST: (req) =>
        api(async () => {
          const input = await body<Parameters<typeof addListings>[2][number]>(req);
          return { added: await addListings(db, req.params.id, [input]) };
        }),
    },
    "/api/trips/:id/listings/:lid": {
      PATCH: (req) =>
        api(async () => {
          const patch = await body<Record<string, unknown>>(req);
          const [listing] = await updateListings(db, req.params.id, [{ ...patch, id: listingId(req.params.lid) }]);
          return listing;
        }),
      DELETE: (req) => api(() => deleteListings(db, req.params.id, [listingId(req.params.lid)])),
    },
    "/api/trips/:id/listings/:lid/vote": {
      POST: (req) =>
        api(async () => {
          const { delta } = await body<{ delta: number }>(req);
          if (delta !== 1 && delta !== -1) throw new UserError("delta must be 1 or -1");
          return { votes: vote(db, req.params.id, listingId(req.params.lid), delta) };
        }),
    },
    "/api/trips/:id/listings/:lid/comments": {
      POST: (req) =>
        api(async () => {
          const { body: text, author } = await body<{ body: string; author?: string }>(req);
          return addComment(db, req.params.id, listingId(req.params.lid), String(text ?? ""), author);
        }),
    },
    "/api/trips/:id/comments/:cid": {
      DELETE: (req) => api(() => deleteComment(db, req.params.id, listingId(req.params.cid))),
    },
  },
  fetch() {
    return new Response("Not found", { status: 404 });
  },
});

console.log(`[trips] listening on ${server.url} (public URL ${PUBLIC_URL})`);

// Docker sends SIGTERM on redeploys; close cleanly so SQLite checkpoints its WAL.
for (const signal of ["SIGTERM", "SIGINT"] as const) {
  process.on(signal, () => {
    server.stop();
    db.close();
    process.exit(0);
  });
}
