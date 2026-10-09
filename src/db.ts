import { Database } from "bun:sqlite";

// Each entry runs once, in order; PRAGMA user_version records how many have run.
const MIGRATIONS = [
  `
  CREATE TABLE trips (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    destination TEXT,
    start_date TEXT,
    end_date TEXT,
    group_size INTEGER NOT NULL DEFAULT 1,
    currency TEXT NOT NULL DEFAULT 'EUR',
    notes TEXT,
    version INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE fields (
    id INTEGER PRIMARY KEY,
    trip_id TEXT NOT NULL REFERENCES trips(id) ON DELETE CASCADE,
    key TEXT NOT NULL,
    label TEXT NOT NULL,
    type TEXT NOT NULL,
    better TEXT,
    per_person INTEGER NOT NULL DEFAULT 0,
    unit TEXT,
    options TEXT,
    description TEXT,
    position INTEGER NOT NULL,
    UNIQUE (trip_id, key)
  );

  CREATE TABLE listings (
    id INTEGER PRIMARY KEY,
    trip_id TEXT NOT NULL REFERENCES trips(id) ON DELETE CASCADE,
    title TEXT NOT NULL,
    url TEXT,
    status TEXT NOT NULL DEFAULT 'candidate',
    notes TEXT,
    address TEXT,
    lat REAL,
    lng REAL,
    location_approx INTEGER NOT NULL DEFAULT 0,
    photos TEXT NOT NULL DEFAULT '[]',
    facts TEXT NOT NULL DEFAULT '{}',
    "values" TEXT NOT NULL DEFAULT '{}',
    votes INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE INDEX listings_trip ON listings(trip_id);

  CREATE TABLE comments (
    id INTEGER PRIMARY KEY,
    listing_id INTEGER NOT NULL REFERENCES listings(id) ON DELETE CASCADE,
    author TEXT,
    body TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE INDEX comments_listing ON comments(listing_id);

  CREATE TABLE geocode_cache (
    query TEXT PRIMARY KEY,
    lat REAL,
    lng REAL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  `,
];

export function openDb(path: string): Database {
  const db = new Database(path, { create: true, strict: true });
  db.run("PRAGMA journal_mode = WAL");
  db.run("PRAGMA foreign_keys = ON");
  db.run("PRAGMA busy_timeout = 5000");

  const { user_version } = db.query("PRAGMA user_version").get() as {
    user_version: number;
  };
  for (let i = user_version; i < MIGRATIONS.length; i++) {
    db.transaction(() => {
      db.run(MIGRATIONS[i] as string);
      db.run(`PRAGMA user_version = ${i + 1}`);
    })();
    console.log(`[trips] applied migration ${i + 1}`);
  }
  return db;
}
