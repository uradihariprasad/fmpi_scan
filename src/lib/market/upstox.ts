/**
 * Genuine Upstox market-data integration (server-only).
 *
 * Historical candle endpoints (v2/v3) and the daily instrument-master file
 * are served without authentication; authenticated endpoints (option chain,
 * quotes) are only touched when UPSTOX_ACCESS_TOKEN is configured.
 * Nothing in this module fabricates market values: empty responses stay
 * empty and surface as "unavailable/warming up" upstream.
 */
import { gunzipSync } from "node:zlib";
import type { Candle, InstrumentMeta } from "@/lib/fmpi/types";

const V2 = "https://api.upstox.com/v2";
const V3 = "https://api.upstox.com/v3";
const MASTER = "https://assets.upstox.com/market-quote/instruments/exchange";

export class UpstoxError extends Error {
  constructor(message: string, public readonly status?: number) {
    super(message);
    this.name = "UpstoxError";
  }
}

const UA = {
  "User-Agent": "fmpi-engine/1.0 (+market-data-client)",
  Accept: "application/json",
};

async function fetchJson(url: string, attempts = 3): Promise<unknown> {
  let lastErr: unknown = null;
  for (let a = 0; a < attempts; a++) {
    try {
      const res = await fetch(url, { headers: UA, cache: "no-store", signal: AbortSignal.timeout(15000) });
      if (res.status === 429 || res.status >= 500) {
        await new Promise((r) => setTimeout(r, 400 * (a + 1)));
        continue;
      }
      if (!res.ok) throw new UpstoxError(`HTTP ${res.status} for ${url}`, res.status);
      return (await res.json()) as unknown;
    } catch (e) {
      lastErr = e;
      if (a < attempts - 1) await new Promise((r) => setTimeout(r, 400 * (a + 1)));
    }
  }
  throw lastErr instanceof UpstoxError ? lastErr : new UpstoxError(`network failure for ${url}`);
}

/** coarse global rate limiter ~12 req/s to stay well under public limits */
let tokens = 12;
let lastRefill = Date.now();
export async function rateGate(): Promise<void> {
  const now = Date.now();
  tokens = Math.min(12, tokens + ((now - lastRefill) / 1000) * 12);
  lastRefill = now;
  if (tokens < 1) await new Promise((r) => setTimeout(r, 120));
  tokens -= 1;
}

// simple in-process micro-cache (per warm lambda/server)
const memCache = new Map<string, { at: number; data: unknown }>();

interface CandleResponse {
  status: string;
  data?: { candles?: [string, number, number, number, number, number, number][] };
  errors?: { message: string }[];
}

function parseCandles(json: CandleResponse): Candle[] {
  const rows = json?.data?.candles ?? [];
  const out: Candle[] = rows.map((r) => ({
    ts: new Date(r[0]).getTime(),
    open: r[1], high: r[2], low: r[3], close: r[4],
    volume: r[5] ?? 0, oi: r[6] ?? null,
  }));
  out.sort((a, b) => a.ts - b.ts); // Upstox returns newest-first
  return out;
}

/**
 * Native v3 candles at the requested unit/interval (minutes 1..375).
 * `from`/`to` are IST calendar dates (YYYY-MM-DD), inclusive.
 */
export async function fetchV3Candles(
  instrumentKey: string, unit: "minutes" | "days", interval: number,
  toDate: string, fromDate: string,
): Promise<Candle[]> {
  const key = `v3:${instrumentKey}:${unit}:${interval}:${fromDate}:${toDate}`;
  const cached = memCache.get(key);
  if (cached && Date.now() - cached.at < 60_000) return cached.data as Candle[];
  await rateGate();
  const url = `${V3}/historical-candle/${encodeURIComponent(instrumentKey)}/${unit}/${interval}/${toDate}/${fromDate}`;
  const json = (await fetchJson(url)) as CandleResponse;
  if (json.status !== "success") {
    throw new UpstoxError(json.errors?.[0]?.message ?? "upstox error");
  }
  const candles = parseCandles(json);
  memCache.set(key, { at: Date.now(), data: candles });
  return candles;
}

/** Current-day intraday 1-minute candles (v2 endpoint, empty off-session). */
export async function fetchIntraday1m(instrumentKey: string): Promise<Candle[]> {
  const key = `intra:${instrumentKey}`;
  const cached = memCache.get(key);
  if (cached && Date.now() - cached.at < 10_000) return cached.data as Candle[];
  await rateGate();
  const url = `${V2}/historical-candle/intraday/${encodeURIComponent(instrumentKey)}/1minute`;
  const json = (await fetchJson(url)) as CandleResponse;
  if (json.status !== "success") return [];
  const candles = parseCandles(json);
  memCache.set(key, { at: Date.now(), data: candles });
  return candles;
}

/* ------------------------------------------------------------------ */
/* Instrument master → dynamic NSE/BSE F&O universe                    */
/* ------------------------------------------------------------------ */

interface MasterRow {
  segment: string; name?: string; exchange: string; instrument_type?: string;
  instrument_key: string; underlying_key?: string; underlying_symbol?: string;
  trading_symbol?: string; lot_size?: number; expiry?: number; asset_type?: string;
}

export interface Universe {
  syncedAt: string;
  instruments: InstrumentMeta[];
}

async function downloadMaster(exchange: "NSE" | "BSE"): Promise<MasterRow[]> {
  const key = `master:${exchange}`;
  const cached = memCache.get(key);
  if (cached && Date.now() - cached.at < 6 * 3_600_000) return cached.data as MasterRow[];
  const res = await fetch(`${MASTER}/${exchange}.json.gz`, { headers: UA, signal: AbortSignal.timeout(60000) });
  if (!res.ok) throw new UpstoxError(`master ${exchange} HTTP ${res.status}`, res.status);
  const buf = Buffer.from(await res.arrayBuffer());
  const json = JSON.parse(gunzipSync(buf).toString("utf8")) as MasterRow[];
  memCache.set(key, { at: Date.now(), data: json });
  return json;
}

/**
 * Builds the current F&O equity universe + pinned indices purely from the
 * live Upstox instrument master. F&O membership = underlyings that have a
 * tradable FUT contract right now — membership follows the master file, so
 * entries/exits propagate automatically on each sync.
 */
export async function buildUniverse(nowMs = Date.now()): Promise<Universe> {
  const [nse, bse] = await Promise.all([downloadMaster("NSE"), downloadMaster("BSE")]);
  const futs = new Map<string, MasterRow[]>(); // underlying_key → FUT rows
  for (const row of nse) {
    if (row.segment !== "NSE_FO" || row.instrument_type !== "FUT" || !row.underlying_key) continue;
    if (!row.expiry || row.expiry < nowMs - 86_400_000) continue;
    const arr = futs.get(row.underlying_key) ?? [];
    arr.push(row);
    futs.set(row.underlying_key, arr);
  }
  const instruments: InstrumentMeta[] = [];
  const seen = new Set<string>();
  for (const [uKey, rows] of futs) {
    rows.sort((a, b) => (a.expiry ?? 0) - (b.expiry ?? 0));
    const nearest = rows[0];
    const symbol = nearest.underlying_symbol ?? nearest.underlying_key?.split("|")[1] ?? uKey;
    if (seen.has(symbol)) continue;
    seen.add(symbol);
    instruments.push({
      instrumentKey: uKey,
      symbol,
      name: nearest.underlying_symbol ?? symbol,
      exchange: uKey.startsWith("BSE") ? "BSE" : "NSE",
      segment: uKey.startsWith("NSE_INDEX") ? "index" : "fno",
      futuresKey: nearest.instrument_key,
      futuresExpiryTs: nearest.expiry ?? null,
      lotSize: nearest.lot_size ?? null,
    });
  }
  // pinned indices (from the actual master rows where possible)
  const pinIndex = (rows: MasterRow[], key: string, symbol: string, exch: "NSE" | "BSE") => {
    if (seen.has(symbol)) return;
    seen.add(symbol);
    const row = rows.find((r) => r.instrument_key === key);
    instruments.unshift({
      instrumentKey: row?.instrument_key ?? key,
      symbol,
      name: row?.name ?? symbol,
      exchange: exch, segment: "index",
      futuresKey: null, futuresExpiryTs: null, lotSize: row?.lot_size ?? null,
    });
  };
  pinIndex(nse, "NSE_INDEX|Nifty 50", "NIFTY", "NSE");
  pinIndex(nse, "NSE_INDEX|Nifty Bank", "BANKNIFTY", "NSE");
  pinIndex(bse, "BSE_INDEX|SENSEX", "SENSEX", "BSE");
  instruments.sort((a, b) =>
    a.segment !== b.segment ? (a.segment === "index" ? -1 : 1) : a.symbol.localeCompare(b.symbol),
  );
  return { syncedAt: new Date(nowMs).toISOString(), instruments };
}

/* ------------------------------------------------------------------ */
/* Authenticated option chain (component E — only with a real token)    */
/* ------------------------------------------------------------------ */

export interface OptionChainRow {
  strike_price: number;
  underlying_spot_price?: number;
  call_options?: { market_data?: OptionLeg };
  put_options?: { market_data?: OptionLeg };
}
export interface OptionLeg {
  ltp?: number; volume?: number; oi?: number; prev_oi?: number; close_price?: number;
}

/** Nearest expiry date (YYYY-MM-DD) for an underlying, from the contract list. */
export async function fetchNearestExpiry(instrumentKey: string, token: string): Promise<string | null> {
  const url = `${V2}/option/contract?instrument_key=${encodeURIComponent(instrumentKey)}`;
  const res = await fetch(url, {
    headers: { ...UA, Authorization: `Bearer ${token}` },
    cache: "no-store",
    signal: AbortSignal.timeout(15000),
  });
  if (!res.ok) return null;
  const json = (await res.json()) as { status?: string; data?: { expiry?: string }[] };
  if (json.status !== "success" || !Array.isArray(json.data)) return null;
  const today = new Date().toISOString().slice(0, 10);
  const expiries = [...new Set(json.data.map((d) => d.expiry).filter(Boolean) as string[])]
    .filter((d) => d >= today)
    .sort();
  return expiries[0] ?? null;
}

/**
 * Live option chain for an underlying. Requires an authenticated session;
 * returns null (never a fabricated chain) when unavailable.
 */
export async function fetchOptionChain(
  instrumentKey: string, expiry: string, token: string,
): Promise<OptionChainRow[] | null> {
  const url = `${V2}/option/chain?instrument_key=${encodeURIComponent(instrumentKey)}&expiry_date=${expiry}`;
  const res = await fetch(url, {
    headers: { ...UA, Authorization: `Bearer ${token}` },
    cache: "no-store",
    signal: AbortSignal.timeout(15000),
  });
  if (!res.ok) return null;
  const json = (await res.json()) as { status?: string; data?: OptionChainRow[] };
  if (json.status !== "success" || !Array.isArray(json.data)) return null;
  return json.data;
}
