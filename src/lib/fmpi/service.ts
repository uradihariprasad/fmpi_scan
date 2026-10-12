/**
 * FMPI orchestration service — the single entry used by all API routes.
 * Given an instrument + timeframe it guarantees:
 *  1. genuine candles from cache/Upstox (5m & 10m series stay independent)
 *  2. an aligned futures frame when a nearest-expiry contract exists
 *  3. a causal engine run (provisional live candle flagged)
 *  4. write-once snapshot persistence (historical values never repaint)
 *  5. a peer-timeframe read so 5m/10m conflicts surface honestly.
 */
import { db } from "@/db";
import { canTryDatabase, describeDbError, markDbFailure } from "@/db/status";
import { fmpiSnapshots } from "@/db/schema";
import { withConfig } from "./config";
import { combineStates, computeSeries } from "./engine";
import type {
  Candle, FmpiPoint, FmpiSeriesPayload, InstrumentMeta, Timeframe,
} from "./types";
import { ENGINE_VERSION } from "./types";
import { ensureSessions, futuresFrameFor, mergeLive } from "@/lib/market/candles";
import { marketPhase } from "@/lib/market/session";
import { getInstrument } from "@/lib/market/universe";
import { getActiveToken } from "@/lib/market/auth";
import { fetchNearestExpiry, fetchOptionChain } from "@/lib/market/upstox";
import { buildOptionsReading } from "./options";
import type { ComponentReading } from "./types";

const cfg = withConfig();
const SCAN_SESSIONS = 4;
const FULL_SESSIONS = 14;

interface CacheEntry { at: number; payload: FmpiSeriesPayload }
const responseCache = new Map<string, CacheEntry>();
const RESP_CACHE_MAX = 24; // bounded LRU-ish retention
const RESP_TTL_OPEN = 8_000;
const RESP_TTL_CLOSED = 10 * 60_000;

function cachePut(key: string, payload: FmpiSeriesPayload): void {
  if (responseCache.size >= RESP_CACHE_MAX) {
    const oldest = responseCache.keys().next().value;
    if (oldest !== undefined) responseCache.delete(oldest);
  }
  responseCache.set(key, { at: Date.now(), payload });
}

async function persistPoints(meta: InstrumentMeta, tf: Timeframe, points: FmpiPoint[]): Promise<void> {
  if (!canTryDatabase()) return;
  const rows = points
    .filter((p) => !p.provisional && p.quality !== "warming_up")
    .map((p) => ({
      instrumentKey: meta.instrumentKey, timeframe: tf, ts: new Date(p.ts),
      engineVersion: ENGINE_VERSION,
      payload: p as unknown as Record<string, unknown>,
    }));
  if (rows.length === 0) return;
  try {
    await db.insert(fmpiSnapshots).values(rows).onConflictDoNothing();
  } catch (e) {
    console.error(`[fmpi] snapshot persist failed ${meta.symbol} ${tf}:`, (e as Error).message);
  }
}

export interface FmpiError extends Error { code: string }

export async function getFmpiSeries(
  symbol: string, tf: Timeframe, sessions = FULL_SESSIONS, includePeer = true,
  persist = true, lean = false,
): Promise<FmpiSeriesPayload> {
  const meta = await getInstrument(symbol);
  if (!meta) {
    const err = new Error(`instrument '${symbol}' is not in the current Upstox F&O universe`) as FmpiError;
    err.code = "UNKNOWN_INSTRUMENT";
    throw err;
  }
  const phase = marketPhase(Date.now());
  const cacheKey = `${meta.instrumentKey}|${tf}|${sessions}`;
  const hit = responseCache.get(cacheKey);
  const ttl = phase === "open" ? RESP_TTL_OPEN : RESP_TTL_CLOSED;
  if (!lean && hit && Date.now() - hit.at < ttl) return hit.payload;

  const nowMs = Date.now();
  const { candles: hist } = await ensureSessions(meta.instrumentKey, tf, sessions, nowMs);
  const { merged, provisionalCount } = await mergeLive(meta.instrumentKey, tf, hist, nowMs);

  const frame = await futuresFrameFor(meta, tf, Math.min(sessions, 6), nowMs);

  /* Options positioning — live chain snapshot, applied only to the most
     recent candle. Historical bars keep the component MISSING because the
     chain endpoint cannot be replayed point-in-time. */
  let optionsReading: ((i: number) => ComponentReading | null) | null = null;
  let optionsNote = "no Upstox session — options component excluded & labelled missing";
  let optionsUsed = false;
  if (!lean && merged.length > 0) {
    const token = await getActiveToken();
    if (!token) {
      optionsNote = "not signed in — sign in with an Upstox access token to activate options positioning";
    } else {
      try {
        const expiry = await fetchNearestExpiry(meta.instrumentKey, token);
        if (!expiry) {
          optionsNote = "no option contracts listed for this underlying";
        } else {
          const spot = merged[merged.length - 1].close;
          const chain = await fetchOptionChain(meta.instrumentKey, expiry, token);
          const reading = buildOptionsReading(chain, spot, expiry);
          if (reading.available) {
            const lastIdx = merged.length - 1;
            optionsReading = (i: number) => (i === lastIdx ? reading : null);
            optionsUsed = true;
            optionsNote = `live chain snapshot for expiry ${expiry} — applied to the latest candle only`;
          } else {
            optionsNote = reading.evidence[0];
          }
        }
      } catch (e) {
        optionsNote = `option chain fetch failed (${(e as Error).message}) — component excluded, never fabricated`;
      }
    }
  }

  const result = computeSeries(merged as Candle[], tf, cfg, frame, optionsReading, provisionalCount);

  // futures basis overlay: genuine futures closes aligned to spot candles
  let futuresSeries: { ts: number; close: number }[] | undefined;
  let futLast: { close: number; basisPct: number } | undefined;
  if (frame && !lean) {
    const rows: { ts: number; close: number }[] = [];
    for (const c of merged) {
      const fc = frame.byTs.get(c.ts);
      if (fc) rows.push({ ts: c.ts, close: fc.close });
    }
    futuresSeries = rows;
    for (let i = merged.length - 1; i >= 0; i--) {
      const fc = frame.byTs.get(merged[i].ts);
      if (fc && merged[i].close > 0) {
        futLast = { close: fc.close, basisPct: ((fc.close - merged[i].close) / merged[i].close) * 100 };
        break;
      }
    }
  }

  const points = result.points;
  let latest: FmpiPoint | null = points.length ? points[points.length - 1] : null;

  // stale-feed detection only applies while the exchange should be ticking
  if (latest && phase === "open") {
    const age = nowMs - latest.ts;
    const tfMs = (tf === "5m" ? 5 : 10) * 60_000;
    if (age > tfMs * 3) latest = { ...latest, quality: "stale" };
  }

  let peer: FmpiSeriesPayload["peer"] = null;
  let combinedState: FmpiSeriesPayload["combinedState"] = null;
  if (includePeer && !lean) {
    const peerTf: Timeframe = tf === "5m" ? "10m" : "5m";
    try {
      const peerPayload = await getFmpiSeries(symbol, peerTf, SCAN_SESSIONS, false, true, true);
      const pl = peerPayload.latest;
      if (pl && latest) {
        peer = { timeframe: peerTf, value: pl.value, zone: pl.zone, state: pl.state };
        const combo = combineStates(
          { value: latest.value, zone: latest.zone, state: latest.state },
          { value: pl.value, zone: pl.zone, state: pl.state },
        );
        combinedState = combo.combined;
        if (combo.combined === "conflicting_signals" || combo.combined === "transition") {
          latest = { ...latest, state: combo.combined };
        }
      }
    } catch {
      peer = null; // peer failure must never corrupt the current timeframe
    }
  }

  const payload: FmpiSeriesPayload = {
    engineVersion: ENGINE_VERSION,
    instrument: meta, timeframe: tf, timezone: "Asia/Kolkata",
    candles: merged, points,
    turningPoints: result.turningPoints,
    zones: latest?.zoneBoundaries ?? null,
    latest, peer, combinedState,
    marketState: phase,
    futures: frame && meta.futuresKey
      ? {
          used: true, instrumentKey: meta.futuresKey,
          expiryTs: meta.futuresExpiryTs ?? undefined,
          lastClose: futLast?.close, basisPct: futLast?.basisPct,
        }
      : { used: false, note: meta.segment === "index" ? "no futures frame wired for this index (spot index candles only)" : "no tradable futures contract resolved" },
    futuresSeries,
    options: { used: optionsUsed, note: optionsNote },
    dataSource: "Upstox public historical-candle API (v3) + instrument master",
    generatedAt: new Date(nowMs).toISOString(),
  };
  if (!lean) cachePut(cacheKey, payload);
  // Write-once audit trail for selected instruments only — scanner reads
  // stay transient to keep storage bounded (retention policy: snapshots
  // accrue one row per completed candle per explicitly viewed instrument).
  if (persist && !lean) void persistPoints(meta, tf, points);
  return payload;
}

/** Bounded-concurrency universe scan for the momentum scanner. */
/**
 * Single-instrument scan row used by the background universe scanner.
 * Runs lean: transient payload, no response-cache retention, no snapshot
 * persistence — the scanner must never evict interactive chart reads.
 * An instrument that cannot be computed returns an explicit
 * `insufficient_data / unavailable` row instead of a fabricated value.
 */
export async function scanInstrument(
  meta: InstrumentMeta, tf: Timeframe,
): Promise<import("./types").ScanRow> {
  try {
    const payload = await getFmpiSeries(meta.symbol, tf, SCAN_SESSIONS, false, false, true);
    const l = payload.latest;
    return {
      instrument: meta,
      value: l?.value ?? null, change: l?.change ?? null, slope: l?.slope ?? null,
      zone: l?.zone ?? null,
      state: l?.state ?? "insufficient_data",
      quality: l?.quality ?? "unavailable",
      ts: l?.ts ?? null,
    };
  } catch {
    return {
      instrument: meta, value: null, change: null, slope: null, zone: null,
      state: "insufficient_data", quality: "unavailable", ts: null,
    };
  }
}
