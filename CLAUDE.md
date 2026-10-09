# Trips

A shared board for comparing lodging, with an MCP server as the main way to edit it. See README.md for features.

## Layout

- `src/service.ts`: all domain logic (trips, fields, listings, votes, comments). Both the MCP tools and the web API call
  it; input problems throw `UserError`, whose message is shown to the user or Claude verbatim.
- `src/mcp.ts`: MCP tools, server instructions and result shaping, using a stateless streamable HTTP transport (a new server
  per request).
- `src/query.ts`: filtering, sorting and stats for `query_listings`.
- `src/coerce.ts`: lenient parsing of field values. `src/enrich.ts`: OpenGraph/JSON-LD reading of listing pages.
  `src/geocode.ts`: Nominatim with a cache and 1 req/s limit.
- `src/db.ts`: SQLite schema; append new migrations to `MIGRATIONS`, never edit applied ones.
- `web/`: React page served with Bun HTML imports (`trip.html` → `trip.tsx`). MapLibre's worker is served from
  `/vendor/` because it can't be bundled.

## Conventions

- The MCP is the primary interface. When changing behaviour, update tool descriptions and `INSTRUCTIONS` in `src/mcp.ts`
  so Claude knows about it, and keep error messages actionable (say what to do next).
- Batch tools validate everything before writing, so a failed call changes nothing.
- The trip ID is the only credential: never log it or put it anywhere that leaves the browser (pages use
  `no-referrer`).
- Bun everywhere: `bun test`, `bun:sqlite`, `Bun.serve` routes; no Express, Vite or dotenv.
- Run `bun run check`, `bun run typecheck` and `bun test` before committing.
