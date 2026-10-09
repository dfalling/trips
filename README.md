# Trips

Compare places to stay with your group. Each trip is a shared board with a sortable table, photo cards, a map, votes and
comments, and an MCP server so Claude can add listings, define what to compare and answer questions like "which ones have
a pool and cost under €100 per person?".

- **No accounts.** A trip is opened by its secret link (`/t/<id>`). Anyone with the link can view and edit it.
- **Fields are per trip.** A summer villa trip compares pools and BBQs, a ski trip compares saunas and lift distance. Field
  types: boolean, number (with unit), currency (optionally shown per person), text, select.
- **Best values highlighted.** Mark a field "lower is better" or "higher is better", and the table shows the winner.
- **Listing pages read automatically where possible.** Airbnb links fill in the title, photos, approximate map location,
  bedrooms, rating, etc. Prices are never on the page. Booking.com blocks automated reads, so Claude fills those in from
  pasted text or screenshots.
- **One small container:** Bun, SQLite, React, MapLibre with [OpenFreeMap](https://openfreemap.org) tiles, and geocoding
  through [Nominatim](https://nominatim.org).

## Use it with Claude

Add a custom connector in Claude (Settings → Connectors → Add custom connector) with the URL `https://<host>/mcp`. It
needs no authentication: every tool takes a trip link, and the link is the credential. Then, for example:

> Create a trip for our Algarve week, June 12–19, 6 people. Fields: pool, hot tub, BBQ, bedrooms, price.

> Import this sheet into https://trips.example.com/t/abc… (paste the rows)

> Add https://www.airbnb.com/rooms/123… — it's €2,150 for the week.

> Which places have a pool and cost under €400 each? Shortlist them.

In Claude Code: `claude mcp add --transport http trips https://<host>/mcp`.

### Tools

| Tool | What it does |
|---|---|
| `create_trip` | New trip with its secret link, optionally with fields |
| `get_trip` | Settings, field definitions and a listing summary; Claude calls it first |
| `update_trip` | Name, group size, currency, destination, dates, notes |
| `define_fields` / `update_field` / `delete_field` | Manage the trip's comparison columns; type changes convert existing values |
| `add_listings` | Batch add (atomic); reads listing pages and geocodes addresses |
| `update_listings` | Batch partial updates of properties, values and status |
| `delete_listings` | Remove listings |
| `query_listings` | Filter (`eq`, `lt`, `in`, `contains`, `is_set`, …, optionally per person), sort, plus min/max/best stats |
| `get_listing` | Everything about one listing, including photos and comments |
| `refresh_listing` | Re-read a listing's page |
| `add_comment` | Comment on a listing |

Values are parsed leniently ("✓", "yes", "€1.200", "3 bedrooms"), and errors name every problem in a batch, so Claude
can fix the input and retry in one step.

## Development

```bash
mise install && bun install
bun run dev          # http://localhost:3000, with hot reload
bun test             # unit tests and MCP tests through the real HTTP handler
bun run check        # biome
bun run typecheck
```

## Configuration

| Variable | Default | |
|---|---|---|
| `PUBLIC_URL` | `http://localhost:3000` | Base URL used in trip links |
| `PORT` | `3000` | |
| `DATA_DIR` | `./data` (`/data` in Docker) | Holds `trips.db` |
| `CREATE_LIMIT_PER_HOUR` | `20` | Trips one IP may create per hour |
| `GEOCODER` | on | `off` disables geocoding |
| `GEOCODER_CONTACT` | | Contact for the Nominatim User-Agent, per its usage policy |
| `NOMINATIM_URL` | public instance | Point at your own Nominatim or a compatible service |

## Deploying

The image is built by GitHub Actions and pushed to `ghcr.io/<owner>/trips`. Run it behind a TLS reverse proxy with a
volume on `/data`:

```yaml
trips:
  image: ghcr.io/dfalling/trips:latest
  restart: unless-stopped
  environment:
    - PUBLIC_URL=https://trips.example.com
  volumes:
    - /mnt/data/trips:/data
```

- **Back up** `/data/trips.db` with an SQLite-aware dump (e.g. borgmatic's `sqlite_databases`), not by copying the live
  file.
- **Keep trip IDs out of access logs:** the path `/t/<id>` and `/api/trips/<id>/…` contain the trip's only credential.
  The pages send no Referer, so the link doesn't leak to listing sites, tile servers or photo hosts.

## License

MIT
