import { type ReactNode, useCallback, useEffect, useMemo, useState } from "react";
import { createRoot } from "react-dom/client";
import {
  api,
  bestValues,
  type Comment,
  type Field,
  type FieldValue,
  formatValue,
  hostOf,
  type Listing,
  money,
  perPerson,
  priceField,
  STATUS_LABEL,
  STATUS_ORDER,
  type Status,
  store,
  type TripState,
  tripId,
} from "./lib";
import { MapView } from "./MapView";

type View = "table" | "cards";
type Sort = { key: string; dir: 1 | -1 } | null;
type BoolFilter = Record<string, boolean>;
type RangeFilter = Record<string, number>;

const POLL_MS = 10_000;

// ---------------------------------------------------------------------------------------
// Data

function useTripState() {
  const [state, setState] = useState<TripState | null>(null);
  const [error, setError] = useState<string | null>(null);

  const reload = useCallback(async () => {
    try {
      setState(await api<TripState>(""));
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    }
  }, []);

  useEffect(() => {
    void reload();
  }, [reload]);

  // Pick up changes made by Claude or friends without reloading the page.
  useEffect(() => {
    const timer = setInterval(async () => {
      if (document.hidden || !state) return;
      try {
        const { version } = await api<{ version: number }>("/version");
        if (version !== state.trip.version) await reload();
      } catch {
        // Offline for a moment; try again next tick.
      }
    }, POLL_MS);
    return () => clearInterval(timer);
  }, [state, reload]);

  return { state, error, reload };
}

// ---------------------------------------------------------------------------------------
// Small pieces

function StatusPill({ status }: { status: Status }) {
  return <span className={`status status-${status}`}>{STATUS_LABEL[status]}</span>;
}

function VoteButton({ listing, voted, onVote }: { listing: Listing; voted: boolean; onVote: () => void }) {
  return (
    <button
      type="button"
      className={`vote ${voted ? "voted" : ""}`}
      onClick={(e) => {
        e.stopPropagation();
        onVote();
      }}
      title={voted ? "Remove your vote" : "Vote for this place"}
      aria-pressed={voted}
    >
      <span aria-hidden>♥</span> {listing.votes}
    </button>
  );
}

function ValueCell({ f, v, currency, best }: { f: Field; v: FieldValue | undefined; currency: string; best: boolean }) {
  if (v === null || v === undefined) return <span className="empty">–</span>;
  if (f.type === "boolean") {
    return <span className={`bool ${v ? "yes" : "no"} ${best ? "best" : ""}`}>{v ? "✓" : "✗"}</span>;
  }
  if (f.type === "select") return <span className="tag">{String(v)}</span>;
  return <span className={best ? "best" : ""}>{formatValue(f, v, currency)}</span>;
}

function Dialog({ title, onClose, children }: { title: string; onClose: () => void; children: ReactNode }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);
  return (
    <div className="overlay">
      <button type="button" className="backdrop" onClick={onClose} aria-label="Close" tabIndex={-1} />
      <div className="dialog" role="dialog" aria-modal="true" aria-label={title}>
        <div className="dialog-head">
          <h2>{title}</h2>
          <button type="button" className="icon-btn" onClick={onClose} aria-label="Close">
            ✕
          </button>
        </div>
        {children}
      </div>
    </div>
  );
}

function CopyButton({ text, label }: { text: string; label: string }) {
  const [done, setDone] = useState(false);
  return (
    <button
      type="button"
      className="btn"
      onClick={() =>
        navigator.clipboard.writeText(text).then(() => {
          setDone(true);
          setTimeout(() => setDone(false), 1500);
        })
      }
    >
      {done ? "Copied" : label}
    </button>
  );
}

// ---------------------------------------------------------------------------------------
// Header and toolbar

function Header({ state, onReload }: { state: TripState; onReload: () => void }) {
  const { trip } = state;
  const [showConnect, setShowConnect] = useState(false);
  const [editingSize, setEditingSize] = useState(false);
  const dates = [trip.start_date, trip.end_date].filter(Boolean).join(" → ");

  const saveSize = async (raw: string) => {
    setEditingSize(false);
    const n = Number(raw);
    if (Number.isInteger(n) && n >= 1 && n !== trip.group_size) {
      await api("", { method: "PATCH", body: { group_size: n } }).catch((e) => alert(e.message));
      onReload();
    }
  };

  return (
    <header className="header">
      <div>
        <h1>{trip.name}</h1>
        <div className="meta">
          {trip.destination && <span>{trip.destination}</span>}
          {dates && <span>{dates}</span>}
          {editingSize ? (
            <input
              className="size-input"
              type="number"
              min={1}
              defaultValue={trip.group_size}
              // biome-ignore lint/a11y/noAutofocus: opened by an explicit click
              autoFocus
              onBlur={(e) => saveSize(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && (e.target as HTMLInputElement).blur()}
            />
          ) : (
            <button type="button" className="link-btn" onClick={() => setEditingSize(true)} title="Change group size">
              {trip.group_size} {trip.group_size === 1 ? "person" : "people"} ✎
            </button>
          )}
        </div>
      </div>
      <div className="header-actions">
        <CopyButton text={state.link} label="Copy trip link" />
        <button type="button" className="btn" onClick={() => setShowConnect(true)}>
          Use with Claude
        </button>
      </div>
      {showConnect && (
        <Dialog title="Use this trip with Claude" onClose={() => setShowConnect(false)}>
          <ol className="steps">
            <li>
              In Claude, open <b>Settings → Connectors → Add custom connector</b> and enter:
              <div className="copy-row">
                <code>{state.mcp_url}</code>
                <CopyButton text={state.mcp_url} label="Copy" />
              </div>
            </li>
            <li>
              In a chat, paste this trip's link and say what you want, e.g.{" "}
              <em>"Add these Airbnb links to {state.link}"</em> or{" "}
              <em>"Which places on {state.link} have a pool and cost under €100 each?"</em>
              <div className="copy-row">
                <code>{state.link}</code>
                <CopyButton text={state.link} label="Copy" />
              </div>
            </li>
          </ol>
          <p className="muted">Anyone with the trip link can view and edit it. There are no accounts.</p>
        </Dialog>
      )}
    </header>
  );
}

type Filters = {
  search: string;
  statuses: Status[];
  bools: BoolFilter;
  ranges: RangeFilter;
};

function Toolbar({
  fields,
  filters,
  setFilters,
  view,
  setView,
  counts,
  onAdd,
}: {
  fields: Field[];
  filters: Filters;
  setFilters: (f: Filters) => void;
  view: View;
  setView: (v: View) => void;
  counts: Record<Status, number>;
  onAdd: () => void;
}) {
  const toggleStatus = (s: Status) =>
    setFilters({
      ...filters,
      statuses: filters.statuses.includes(s) ? filters.statuses.filter((x) => x !== s) : [...filters.statuses, s],
    });
  // Booleans cycle: any → yes → no → any.
  const cycleBool = (key: string) => {
    const bools = { ...filters.bools };
    if (!(key in bools)) bools[key] = true;
    else if (bools[key]) bools[key] = false;
    else delete bools[key];
    setFilters({ ...filters, bools });
  };
  const setRange = (key: string, raw: string) => {
    const ranges = { ...filters.ranges };
    const n = Number(raw);
    if (raw === "" || !Number.isFinite(n)) delete ranges[key];
    else ranges[key] = n;
    setFilters({ ...filters, ranges });
  };
  const rangeFields = fields.filter((f) => (f.type === "number" || f.type === "currency") && f.better);
  const active = Object.keys(filters.bools).length + Object.keys(filters.ranges).length;
  const [open, setOpen] = useState(false);

  return (
    <div className={`toolbar ${open ? "filters-open" : ""}`}>
      <input
        className="search"
        type="search"
        placeholder="Search"
        value={filters.search}
        onChange={(e) => setFilters({ ...filters, search: e.target.value })}
      />
      <button type="button" className="btn filters-toggle" onClick={() => setOpen(!open)} aria-expanded={open}>
        Filters{active > 0 && ` (${active})`} {open ? "▴" : "▾"}
      </button>
      <fieldset className="chips collapsible" aria-label="Status">
        {STATUS_ORDER.map((s) => (
          <button
            key={s}
            type="button"
            className={`chip ${filters.statuses.includes(s) ? "on" : ""}`}
            onClick={() => toggleStatus(s)}
            aria-pressed={filters.statuses.includes(s)}
          >
            {STATUS_LABEL[s]} <span className="count">{counts[s] ?? 0}</span>
          </button>
        ))}
      </fieldset>
      <fieldset className="chips collapsible" aria-label="Field filters">
        {fields
          .filter((f) => f.type === "boolean")
          .map((f) => {
            const v = filters.bools[f.key];
            return (
              <button
                key={f.key}
                type="button"
                className={`chip ${v === true ? "on" : v === false ? "off" : ""}`}
                onClick={() => cycleBool(f.key)}
                title="Click to require yes, then no, then either"
              >
                {v === false ? "No " : v === true ? "✓ " : ""}
                {f.label}
              </button>
            );
          })}
        {rangeFields.map((f) => (
          <label key={f.key} className="range">
            {f.label} {f.better === "lower" ? "≤" : "≥"}
            <input
              type="number"
              inputMode="decimal"
              placeholder={f.per_person ? "per person" : "any"}
              value={filters.ranges[f.key] ?? ""}
              onChange={(e) => setRange(f.key, e.target.value)}
            />
          </label>
        ))}
      </fieldset>
      <div className="toolbar-end">
        <fieldset className="segmented" aria-label="View">
          {(["table", "cards"] as View[]).map((v) => (
            <button key={v} type="button" className={view === v ? "on" : ""} onClick={() => setView(v)}>
              {v === "table" ? "Table" : "Cards"}
            </button>
          ))}
        </fieldset>
        <button type="button" className="btn primary" onClick={onAdd}>
          + Add
        </button>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------------------
// Table and cards

function ListingsTable({
  state,
  rows,
  best,
  sort,
  setSort,
  selectedId,
  onSelect,
  voted,
  onVote,
}: {
  state: TripState;
  rows: Listing[];
  best: Map<string, FieldValue>;
  sort: Sort;
  setSort: (s: Sort) => void;
  selectedId: number | null;
  onSelect: (id: number) => void;
  voted: Set<number>;
  onVote: (l: Listing) => void;
}) {
  const { trip, fields } = state;
  const header = (key: string, label: ReactNode, className = "") => (
    <th className={className}>
      <button
        type="button"
        className="sort-btn"
        onClick={() => setSort(sort?.key === key ? (sort.dir === 1 ? { key, dir: -1 } : null) : { key, dir: 1 })}
      >
        {label}
        <span className="sort-ind">{sort?.key === key ? (sort.dir === 1 ? "▲" : "▼") : ""}</span>
      </button>
    </th>
  );

  return (
    <div className="table-wrap">
      <table className="table">
        <thead>
          <tr>
            <th className="col-photo" />
            {header("title", "Place", "col-title")}
            {header("status", "Status")}
            {header("votes", "♥")}
            {fields.map((f) => (
              <FieldHeaders key={f.key} f={f} header={header} />
            ))}
            {header("comments", "💬")}
          </tr>
        </thead>
        <tbody>
          {rows.map((l) => (
            <tr
              key={l.id}
              id={`row-${l.id}`}
              className={`row-${l.status} ${l.id === selectedId ? "selected" : ""}`}
              onClick={() => onSelect(l.id)}
            >
              <td className="col-photo">
                {l.photos[0] ? <img src={l.photos[0]} alt="" loading="lazy" /> : <div className="no-photo" />}
              </td>
              <td className="col-title">
                <div className="title">{l.title}</div>
                <div className="sub">
                  #{l.id}
                  {l.url && (
                    <>
                      {" · "}
                      <a href={l.url} target="_blank" rel="noreferrer noopener" onClick={(e) => e.stopPropagation()}>
                        {hostOf(l.url)} ↗
                      </a>
                    </>
                  )}
                </div>
              </td>
              <td>
                <StatusPill status={l.status} />
              </td>
              <td>
                <VoteButton listing={l} voted={voted.has(l.id)} onVote={() => onVote(l)} />
              </td>
              {fields.map((f) => {
                const v = l.values[f.key];
                const isBest = best.has(f.key) && v !== undefined && best.get(f.key) === v;
                if (f.per_person && typeof v === "number") {
                  return (
                    <td key={f.key} className="col-currency">
                      <span className={isBest ? "best" : ""}>
                        {money(perPerson(v, trip.group_size), trip.currency)}
                      </span>
                      <div className="sub">{money(v, trip.currency)} total</div>
                    </td>
                  );
                }
                return (
                  <td key={f.key} className={`col-${f.type}`}>
                    <ValueCell f={f} v={v} currency={trip.currency} best={isBest} />
                  </td>
                );
              })}
              <td className="col-number">{l.comment_count || ""}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {rows.length === 0 && <div className="empty-state">No places match. Change the filters or add one.</div>}
    </div>
  );
}

function FieldHeaders({
  f,
  header,
}: {
  f: Field;
  header: (key: string, label: ReactNode, className?: string) => ReactNode;
}) {
  const label = (
    <span title={f.description ?? undefined}>
      {f.label}
      {f.per_person && " / person"}
      {f.better && <span className="better">{f.better === "lower" ? " ↓" : " ↑"}</span>}
    </span>
  );
  return <>{header(f.key, label, `col-${f.type}`)}</>;
}

function ListingCards({
  state,
  rows,
  best,
  selectedId,
  onSelect,
  voted,
  onVote,
}: {
  state: TripState;
  rows: Listing[];
  best: Map<string, FieldValue>;
  selectedId: number | null;
  onSelect: (id: number) => void;
  voted: Set<number>;
  onVote: (l: Listing) => void;
}) {
  const { trip, fields } = state;
  const price = priceField(fields);
  return (
    <div className="cards">
      {rows.map((l) => {
        const p = price ? l.values[price.key] : undefined;
        return (
          // biome-ignore lint/a11y/useKeyWithClickEvents: the title button is the keyboard target; the card is a larger mouse target
          <article
            key={l.id}
            id={`card-${l.id}`}
            className={`card row-${l.status} ${l.id === selectedId ? "selected" : ""}`}
            onClick={() => onSelect(l.id)}
          >
            <PhotoStrip photos={l.photos} />
            <div className="card-body">
              <div className="card-top">
                <StatusPill status={l.status} />
                <VoteButton listing={l} voted={voted.has(l.id)} onVote={() => onVote(l)} />
              </div>
              <h3>
                <button type="button" className="card-title" onClick={() => onSelect(l.id)}>
                  {l.title}
                </button>
              </h3>
              {price && typeof p === "number" && (
                <div className="price">
                  <b className={best.get(price.key) === p ? "best" : ""}>
                    {money(price.per_person ? perPerson(p, trip.group_size) : p, trip.currency)}
                  </b>
                  {price.per_person && <span className="muted"> per person · {money(p, trip.currency)} total</span>}
                </div>
              )}
              <div className="facts">
                {fields
                  .filter((f) => f !== price)
                  .map((f) => {
                    const v = l.values[f.key];
                    if (v === undefined || v === null) return null;
                    const isBest = best.has(f.key) && best.get(f.key) === v;
                    if (f.type === "boolean") {
                      return v ? (
                        <span key={f.key} className={`tag ${isBest ? "best" : ""}`}>
                          ✓ {f.label}
                        </span>
                      ) : null;
                    }
                    return (
                      <span key={f.key} className={`tag ${isBest ? "best" : ""}`}>
                        {f.label}: {formatValue(f, v, trip.currency)}
                      </span>
                    );
                  })}
              </div>
              <div className="sub">
                #{l.id}
                {l.url && (
                  <>
                    {" · "}
                    <a href={l.url} target="_blank" rel="noreferrer noopener" onClick={(e) => e.stopPropagation()}>
                      {hostOf(l.url)} ↗
                    </a>
                  </>
                )}
                {l.comment_count > 0 && ` · 💬 ${l.comment_count}`}
              </div>
            </div>
          </article>
        );
      })}
      {rows.length === 0 && <div className="empty-state">No places match. Change the filters or add one.</div>}
    </div>
  );
}

function PhotoStrip({ photos }: { photos: string[] }) {
  const [i, setI] = useState(0);
  if (photos.length === 0) return <div className="photo no-photo" />;
  const step = (d: number) => (e: React.MouseEvent) => {
    e.stopPropagation();
    setI((x) => (x + d + photos.length) % photos.length);
  };
  return (
    <div className="photo">
      <img src={photos[i]} alt="" loading="lazy" />
      {photos.length > 1 && (
        <>
          <button type="button" className="photo-nav prev" onClick={step(-1)} aria-label="Previous photo">
            ‹
          </button>
          <button type="button" className="photo-nav next" onClick={step(1)} aria-label="Next photo">
            ›
          </button>
          <span className="photo-count">
            {i + 1}/{photos.length}
          </span>
        </>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------------------
// Detail drawer

function FieldEditor({
  f,
  value,
  onSave,
}: {
  f: Field;
  value: FieldValue | undefined;
  onSave: (v: FieldValue) => void;
}) {
  const current = value ?? null;
  if (f.type === "boolean") {
    return (
      <select
        value={current === null ? "" : current ? "yes" : "no"}
        onChange={(e) => onSave(e.target.value === "" ? null : e.target.value === "yes")}
      >
        <option value="">–</option>
        <option value="yes">Yes</option>
        <option value="no">No</option>
      </select>
    );
  }
  if (f.type === "select") {
    return (
      <select value={current === null ? "" : String(current)} onChange={(e) => onSave(e.target.value || null)}>
        <option value="">–</option>
        {(f.options ?? []).map((o) => (
          <option key={o}>{o}</option>
        ))}
      </select>
    );
  }
  return (
    <input
      key={String(current)}
      type={f.type === "text" ? "text" : "number"}
      inputMode={f.type === "text" ? undefined : "decimal"}
      step="any"
      defaultValue={current === null ? "" : String(current)}
      onBlur={(e) => {
        const raw = e.target.value.trim();
        if (raw !== (current === null ? "" : String(current))) onSave(raw === "" ? null : raw);
      }}
      onKeyDown={(e) => e.key === "Enter" && (e.target as HTMLInputElement).blur()}
    />
  );
}

function Drawer({
  state,
  listing,
  onClose,
  onReload,
  voted,
  onVote,
}: {
  state: TripState;
  listing: Listing;
  onClose: () => void;
  onReload: () => Promise<void>;
  voted: boolean;
  onVote: () => void;
}) {
  const { trip, fields } = state;
  const comments = state.comments.filter((c) => c.listing_id === listing.id);
  const [author, setAuthor] = useState(() => store.get("trips:author", ""));
  const [draft, setDraft] = useState("");
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const patch = async (body: Record<string, unknown>) => {
    try {
      await api(`/listings/${listing.id}`, { method: "PATCH", body });
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    }
    await onReload();
  };

  const comment = async () => {
    if (!draft.trim()) return;
    store.set("trips:author", author);
    try {
      await api(`/listings/${listing.id}/comments`, { method: "POST", body: { body: draft, author: author || null } });
      setDraft("");
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    }
    await onReload();
  };

  const remove = async () => {
    if (!confirm(`Delete "${listing.title}" with its votes and comments? This can't be undone.`)) return;
    await api(`/listings/${listing.id}`, { method: "DELETE" }).catch((e) => setError(e.message));
    onClose();
    await onReload();
  };

  const facts = listing.facts;
  return (
    <aside className="drawer" aria-label={listing.title}>
      <div className="drawer-head">
        <div>
          <div className="sub">#{listing.id}</div>
          <h2>{listing.title}</h2>
        </div>
        <button type="button" className="icon-btn" onClick={onClose} aria-label="Close">
          ✕
        </button>
      </div>
      {listing.photos.length > 0 && (
        <div className="gallery">
          {listing.photos.map((p) => (
            <a key={p} href={p} target="_blank" rel="noreferrer noopener">
              <img src={p} alt="" loading="lazy" />
            </a>
          ))}
        </div>
      )}
      <div className="drawer-row">
        {listing.url && (
          <a className="btn" href={listing.url} target="_blank" rel="noreferrer noopener">
            Open on {hostOf(listing.url)} ↗
          </a>
        )}
        <VoteButton listing={listing} voted={voted} onVote={onVote} />
        {facts.rating !== undefined && (
          <span className="muted">
            ★ {facts.rating}
            {facts.reviews !== undefined && ` · ${facts.reviews} reviews`}
          </span>
        )}
      </div>
      <fieldset className="segmented status-picker" aria-label="Status">
        {STATUS_ORDER.map((s) => (
          <button
            key={s}
            type="button"
            className={listing.status === s ? `on status-${s}` : ""}
            onClick={() => listing.status !== s && patch({ status: s })}
          >
            {STATUS_LABEL[s]}
          </button>
        ))}
      </fieldset>
      {error && <div className="error">{error}</div>}
      <dl className="fields">
        {fields.map((f) => {
          const v = listing.values[f.key];
          return (
            <div key={f.key} className="field-row">
              <dt title={f.description ?? undefined}>
                {f.label}
                {f.unit && <span className="muted"> ({f.unit})</span>}
              </dt>
              <dd>
                <FieldEditor f={f} value={v} onSave={(nv) => patch({ values: { [f.key]: nv } })} />
                {f.per_person && typeof v === "number" && (
                  <span className="muted"> {money(perPerson(v, trip.group_size), trip.currency)} per person</span>
                )}
              </dd>
            </div>
          );
        })}
        <div className="field-row">
          <dt>Notes</dt>
          <dd>
            <textarea
              key={listing.notes ?? ""}
              defaultValue={listing.notes ?? ""}
              rows={3}
              onBlur={(e) => e.target.value !== (listing.notes ?? "") && patch({ notes: e.target.value })}
            />
          </dd>
        </div>
        <div className="field-row">
          <dt>Location</dt>
          <dd className="muted">
            {listing.address ?? ""}
            {listing.lat === null ? " Not on the map yet" : listing.location_approx ? " (approximate)" : ""}
          </dd>
        </div>
      </dl>
      <section className="comments">
        <h3>Comments</h3>
        {comments.length === 0 && <p className="muted">No comments yet.</p>}
        {comments.map((c: Comment) => (
          <div key={c.id} className="comment">
            <div className="comment-head">
              <b>{c.author ?? "Someone"}</b>{" "}
              <span className="muted">{new Date(`${c.created_at}Z`).toLocaleString()}</span>
              <button
                type="button"
                className="link-btn danger"
                onClick={async () => {
                  await api(`/comments/${c.id}`, { method: "DELETE" }).catch((e) => setError(e.message));
                  await onReload();
                }}
              >
                Delete
              </button>
            </div>
            <p>{c.body}</p>
          </div>
        ))}
        <div className="comment-form">
          <input placeholder="Your name (optional)" value={author} onChange={(e) => setAuthor(e.target.value)} />
          <textarea placeholder="Add a comment" rows={2} value={draft} onChange={(e) => setDraft(e.target.value)} />
          <button type="button" className="btn primary" onClick={comment} disabled={!draft.trim()}>
            Comment
          </button>
        </div>
      </section>
      <button type="button" className="link-btn danger delete-listing" onClick={remove}>
        Delete this place
      </button>
    </aside>
  );
}

// ---------------------------------------------------------------------------------------
// Add dialog

function AddDialog({ onClose, onAdded }: { onClose: () => void; onAdded: (id: number) => Promise<void> }) {
  const [url, setUrl] = useState("");
  const [title, setTitle] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    try {
      const { added } = await api<{ added: Array<{ id: number; warnings: string[] }> }>("/listings", {
        method: "POST",
        body: { url: url || undefined, title: title || undefined },
      });
      const first = added[0];
      if (first?.warnings.length) alert(first.warnings.join("\n"));
      if (first) await onAdded(first.id);
      onClose();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog title="Add a place" onClose={onClose}>
      <form className="add-form" onSubmit={submit}>
        <label>
          Link
          <input
            type="url"
            placeholder="https://www.airbnb.com/rooms/…"
            value={url}
            onChange={(e) => setUrl(e.target.value)}
          />
        </label>
        <label>
          Name <span className="muted">(optional if the link can be read)</span>
          <input value={title} onChange={(e) => setTitle(e.target.value)} />
        </label>
        <p className="muted">
          Photos and location are read from Airbnb links automatically. For other sites, or for prices, fill in the
          details afterwards, or paste the listing into Claude.
        </p>
        {error && <div className="error">{error}</div>}
        <button className="btn primary" type="submit" disabled={busy || (!url && !title)}>
          {busy ? "Adding…" : "Add"}
        </button>
      </form>
    </Dialog>
  );
}

// ---------------------------------------------------------------------------------------
// App

function sortValue(l: Listing, key: string): FieldValue {
  if (key === "title") return l.title.toLowerCase();
  if (key === "status") return STATUS_ORDER.indexOf(l.status);
  if (key === "votes") return l.votes;
  if (key === "comments") return l.comment_count;
  const v = l.values[key];
  return v === undefined ? null : typeof v === "boolean" ? Number(v) : v;
}

function defaultOrder(a: Listing, b: Listing): number {
  return STATUS_ORDER.indexOf(a.status) - STATUS_ORDER.indexOf(b.status) || b.votes - a.votes || a.id - b.id;
}

function App() {
  const { state, error, reload } = useTripState();
  const [view, setViewState] = useState<View>(() =>
    store.get("trips:view", window.matchMedia("(max-width: 900px)").matches ? "cards" : "table"),
  );
  const [mobileTab, setMobileTab] = useState<"list" | "map">("list");
  const [sort, setSort] = useState<Sort>(null);
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [adding, setAdding] = useState(false);
  const [filters, setFilters] = useState<Filters>({
    search: "",
    statuses: ["chosen", "shortlisted", "candidate"],
    bools: {},
    ranges: {},
  });
  const [voted, setVoted] = useState<Set<number>>(() => new Set(store.get<number[]>(`trips:${tripId}:votes`, [])));

  const setView = (v: View) => {
    setViewState(v);
    store.set("trips:view", v);
  };

  useEffect(() => {
    if (state) document.title = `${state.trip.name} · Trips`;
  }, [state]);

  const rows = useMemo(() => {
    if (!state) return [];
    const { trip, fields } = state;
    const needle = filters.search.trim().toLowerCase();
    const out = state.listings.filter((l) => {
      if (!filters.statuses.includes(l.status)) return false;
      if (needle && ![l.title, l.notes, l.address].some((s) => s?.toLowerCase().includes(needle))) return false;
      for (const [k, want] of Object.entries(filters.bools)) if (l.values[k] !== want) return false;
      for (const [k, limit] of Object.entries(filters.ranges)) {
        const f = fields.find((x) => x.key === k);
        const raw = l.values[k];
        if (!f || typeof raw !== "number") return false;
        const v = f.per_person ? perPerson(raw, trip.group_size) : raw;
        if (f.better === "lower" ? v > limit : v < limit) return false;
      }
      return true;
    });
    return out.sort((a, b) => {
      if (!sort) return defaultOrder(a, b);
      const va = sortValue(a, sort.key);
      const vb = sortValue(b, sort.key);
      if (va === null && vb === null) return defaultOrder(a, b);
      if (va === null) return 1;
      if (vb === null) return -1;
      const c = typeof va === "number" && typeof vb === "number" ? va - vb : String(va).localeCompare(String(vb));
      return c * sort.dir || defaultOrder(a, b);
    });
  }, [state, filters, sort]);

  // Best values are judged among the places still in the running.
  const best = useMemo(
    () =>
      state
        ? bestValues(
            state.fields,
            rows.filter((l) => l.status !== "rejected"),
          )
        : new Map(),
    [state, rows],
  );

  const counts = useMemo(() => {
    const c = { candidate: 0, shortlisted: 0, chosen: 0, rejected: 0 } as Record<Status, number>;
    for (const l of state?.listings ?? []) c[l.status]++;
    return c;
  }, [state]);

  const price = state ? priceField(state.fields) : undefined;
  const pinLabel = useCallback(
    (l: Listing) => {
      const v = price ? l.values[price.key] : undefined;
      if (!state || !price || typeof v !== "number") return `#${l.id}`;
      return money(price.per_person ? perPerson(v, state.trip.group_size) : v, state.trip.currency);
    },
    [state, price],
  );

  const select = useCallback((id: number) => {
    setSelectedId(id);
    setDrawerOpen(true);
    document.getElementById(`row-${id}`)?.scrollIntoView({ block: "nearest", behavior: "smooth" });
    document.getElementById(`card-${id}`)?.scrollIntoView({ block: "nearest", behavior: "smooth" });
  }, []);

  const onVote = async (l: Listing) => {
    const has = voted.has(l.id);
    const next = new Set(voted);
    if (has) next.delete(l.id);
    else next.add(l.id);
    setVoted(next);
    store.set(`trips:${tripId}:votes`, [...next]);
    await api(`/listings/${l.id}/vote`, { method: "POST", body: { delta: has ? -1 : 1 } }).catch(() => {});
    await reload();
  };

  if (error && !state) {
    return (
      <main className="home">
        <h1>Trip not found</h1>
        <p>{error}</p>
      </main>
    );
  }
  if (!state) return <div className="loading">Loading…</div>;

  const selected = state.listings.find((l) => l.id === selectedId) ?? null;
  const listProps = { state, rows, best, selectedId, onSelect: select, voted, onVote };

  return (
    <div className="app">
      <Header state={state} onReload={reload} />
      <Toolbar
        fields={state.fields}
        filters={filters}
        setFilters={setFilters}
        view={view}
        setView={setView}
        counts={counts}
        onAdd={() => setAdding(true)}
      />
      <div className="mobile-tabs segmented">
        <button type="button" className={mobileTab === "list" ? "on" : ""} onClick={() => setMobileTab("list")}>
          List ({rows.length})
        </button>
        <button type="button" className={mobileTab === "map" ? "on" : ""} onClick={() => setMobileTab("map")}>
          Map
        </button>
      </div>
      <div className={`main tab-${mobileTab}`}>
        <section className="list-pane">
          {state.listings.length === 0 ? (
            <div className="empty-state big">
              <p>No places yet.</p>
              <p className="muted">
                Add one with <b>+ Add</b>, or ask Claude to add listings or import your spreadsheet (see{" "}
                <b>Use with Claude</b>).
              </p>
            </div>
          ) : view === "table" ? (
            <ListingsTable {...listProps} sort={sort} setSort={setSort} />
          ) : (
            <ListingCards {...listProps} />
          )}
        </section>
        <section className="map-pane">
          <MapView listings={rows} selectedId={selectedId} label={pinLabel} onSelect={select} />
        </section>
      </div>
      {drawerOpen && selected && (
        <Drawer
          state={state}
          listing={selected}
          onClose={() => setDrawerOpen(false)}
          onReload={reload}
          voted={voted.has(selected.id)}
          onVote={() => onVote(selected)}
        />
      )}
      {adding && (
        <AddDialog
          onClose={() => setAdding(false)}
          onAdded={async (id) => {
            await reload();
            select(id);
          }}
        />
      )}
    </div>
  );
}

const root = document.getElementById("root");
if (root) createRoot(root).render(<App />);
