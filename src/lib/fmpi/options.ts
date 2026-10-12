/**
 * Options positioning component (15% weight) — built from the live Upstox
 * option chain, which requires an authenticated session.
 *
 * Honest scope: the chain endpoint exposes the *current* snapshot only, so
 * this reading applies to the latest completed candle and is labelled as a
 * live snapshot. Historical candles keep the component MISSING rather than
 * back-filling a value that was never observed at that time.
 *
 * Evidence used (ATM ± `BAND` strikes around spot):
 *   • CE vs PE open interest balance            (positioning skew)
 *   • CE vs PE change in OI vs previous day     (fresh positioning)
 *   • CE vs PE traded volume                    (activity skew)
 * Rising CE OI is treated as resistance-side pressure and rising PE OI as
 * support-side pressure — evidence, never an assumption that every OI
 * increase is writing.
 */
import type { ComponentReading } from "./types";
import type { OptionChainRow } from "@/lib/market/upstox";
import { clamp, tanh } from "./math";

const BAND = 5; // strikes either side of ATM

function ratioScore(bullish: number, bearish: number): number | null {
  const total = bullish + bearish;
  if (!Number.isFinite(total) || total <= 0) return null;
  return clamp((bullish - bearish) / total, -1, 1);
}

export function buildOptionsReading(
  chain: OptionChainRow[] | null,
  spot: number,
  expiry: string,
): ComponentReading {
  if (!chain || chain.length === 0) {
    return {
      score: null,
      available: false,
      evidence: ["option chain unavailable for this underlying — component excluded, not fabricated"],
    };
  }
  const sorted = [...chain].sort((a, b) => a.strike_price - b.strike_price);
  let atmIdx = 0;
  let best = Infinity;
  for (let i = 0; i < sorted.length; i++) {
    const d = Math.abs(sorted[i].strike_price - spot);
    if (d < best) { best = d; atmIdx = i; }
  }
  const band = sorted.slice(Math.max(0, atmIdx - BAND), Math.min(sorted.length, atmIdx + BAND + 1));
  if (band.length < 3) {
    return { score: null, available: false, evidence: ["option chain too thin around ATM to score"] };
  }

  let ceOi = 0, peOi = 0, ceDOi = 0, peDOi = 0, ceVol = 0, peVol = 0;
  for (const row of band) {
    const ce = row.call_options?.market_data;
    const pe = row.put_options?.market_data;
    if (ce) {
      ceOi += ce.oi ?? 0;
      ceVol += ce.volume ?? 0;
      if (ce.oi != null && ce.prev_oi != null) ceDOi += ce.oi - ce.prev_oi;
    }
    if (pe) {
      peOi += pe.oi ?? 0;
      peVol += pe.volume ?? 0;
      if (pe.oi != null && pe.prev_oi != null) peDOi += pe.oi - pe.prev_oi;
    }
  }

  // PE-side dominance = support/bullish pressure; CE-side = resistance/bearish
  const oiSkew = ratioScore(peOi, ceOi);
  const volSkew = ratioScore(peVol, ceVol);
  const dOiSkew =
    ceDOi === 0 && peDOi === 0 ? null : clamp((peDOi - ceDOi) / (Math.abs(peDOi) + Math.abs(ceDOi) || 1), -1, 1);

  const parts: { w: number; v: number }[] = [];
  if (oiSkew !== null) parts.push({ w: 0.4, v: oiSkew });
  if (dOiSkew !== null) parts.push({ w: 0.4, v: dOiSkew });
  if (volSkew !== null) parts.push({ w: 0.2, v: volSkew });
  if (parts.length === 0) {
    return { score: null, available: false, evidence: ["option chain carried no usable OI/volume fields"] };
  }
  const wSum = parts.reduce((s, p) => s + p.w, 0);
  const score = tanh((parts.reduce((s, p) => s + p.w * p.v, 0) / wSum) * 1.4);

  const pcr = ceOi > 0 ? peOi / ceOi : null;
  const evidence: string[] = [
    `live chain snapshot ${expiry} · ATM±${BAND} strikes · PCR(OI) ${pcr != null ? pcr.toFixed(2) : "n/a"} — evidence, not a directional guarantee`,
  ];
  if (dOiSkew !== null) {
    evidence.push(
      `ΔOI vs prev day: PE ${peDOi >= 0 ? "+" : ""}${Math.round(peDOi).toLocaleString("en-IN")} vs CE ${ceDOi >= 0 ? "+" : ""}${Math.round(ceDOi).toLocaleString("en-IN")} (${dOiSkew >= 0 ? "put" : "call"} side building)`,
    );
  }
  if (volSkew !== null) {
    evidence.push(`volume skew ${volSkew >= 0 ? "put" : "call"}-heavy (${(Math.abs(volSkew) * 100).toFixed(0)}%)`);
  }
  return { score, available: true, evidence };
}
