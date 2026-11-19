// Token Radar v2 — the value model ("radar-3").
//
// The board ranks pre-token protocols by expected launch value: what a token
// would be worth if the protocol launched one, times the odds that it does.
// Both halves are fitted from the sealed snapshot itself, never from a
// hand-kept list of names:
//
//   value-if-launches: a Huber-robust log-log curve fitted on the traded
//     protocols (log market cap on log TVL plus seven-day growth). The size
//     exponent is far below one: a protocol ten times bigger is worth about
//     three times more, not ten. An age term was fitted, tested and dropped:
//     it worsens the walk-forward miss from 2.6x to 3.9x, because the oldest
//     training blocks have near-constant age and the coefficient cannot
//     generalise. Age enters instead through the launch odds, where it
//     validates.
//
//   launch odds: the share of look-alike protocols (same age band, same TVL
//     tercile) that still record no token. Older protocols score lower: most
//     of their look-alikes already launched, so a protocol still waiting at
//     that age is the exception. A cross-sectional discount, not a forecast:
//     the entry never predicts whether or when a token is issued.
//
//   uncertainty: 200 bootstrap refits, each prediction carrying a resampled
//     residual, give every row a P10-P90 band and a rank range. The bands are
//     predictive intervals, not parameter intervals: on the traded comps the
//     P25-P75 band holds 48% of actual market caps and the P10-P90 band 79%.
//
// Validation is part of the output, not an afterthought: leave-one-out and
// older-to-newer walk-forward median miss against a flat-multiple baseline,
// an ablation table, and honest band coverage all ship in the dashboard.

export const MODEL_VERSION = 'radar-3';

/** The snapshot's protocol entry: exactly the ten fields the sealed input carries. */
export interface Proto {
  slug: string;
  name: string;
  category: string | null;
  chains: string[];
  tvl_usd: number;
  change_7d: number | null;
  mcap_usd: number | null;
  listed_at: string | null;
  gecko_id: string | null;
  symbol: string | null;
}

export interface Snapshot {
  as_of: string;
  source: string;
  floor_usd: number;
  protocols: Proto[];
  watchlist: string[];
}

export class SnapshotError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SnapshotError';
  }
}

const DAY_MS = 86_400_000;

/** Days from `listed` to `asOf`, clamped at zero; null when the date is absent or bad. */
export function daysOld(asOf: string, listed: string | null): number | null {
  if (listed === null) return null;
  const a = Date.parse(`${asOf}T00:00:00Z`);
  const b = Date.parse(`${listed}T00:00:00Z`);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
  return Math.max(0, Math.floor((a - b) / DAY_MS));
}

/** Seven-day TVL change as a fraction, winsorised to [-50%, +100%]; 0 when unreported. */
export function growthOf(p: Proto): number {
  const g = typeof p.change_7d === 'number' && Number.isFinite(p.change_7d) ? p.change_7d : 0;
  return Math.min(100, Math.max(-50, g)) / 100;
}

/** The snapshot out of a file's text, refused unless it carries the shape the model scores. */
export function readSnapshot(text: string): Snapshot {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new SnapshotError('snapshot.json is not JSON');
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new SnapshotError('snapshot.json is not an object');
  }
  const doc = raw as Record<string, unknown>;
  if (typeof doc.as_of !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(doc.as_of)) {
    throw new SnapshotError('snapshot.json has no as_of date');
  }
  if (typeof doc.source !== 'string') throw new SnapshotError('snapshot.json has no source');
  if (typeof doc.floor_usd !== 'number' || doc.floor_usd <= 0) {
    throw new SnapshotError('snapshot.json has no floor_usd');
  }
  if (!Array.isArray(doc.protocols)) throw new SnapshotError('snapshot.json has no protocols array');
  if (!Array.isArray(doc.watchlist) || doc.watchlist.some((s) => typeof s !== 'string')) {
    throw new SnapshotError('snapshot.json has no watchlist of slugs');
  }
  const protocols = doc.protocols.map((entry, i) => {
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
      throw new SnapshotError(`protocol ${i} is not an object`);
    }
    const p = entry as Record<string, unknown>;
    if (typeof p.slug !== 'string' || typeof p.name !== 'string' || typeof p.tvl_usd !== 'number' || !Number.isFinite(p.tvl_usd)) {
      throw new SnapshotError(`protocol ${i} lacks a slug, a name or a TVL`);
    }
    const numOrNull = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
    const strOrNull = (v: unknown): string | null => (typeof v === 'string' ? v : null);
    return {
      slug: p.slug,
      name: p.name,
      category: strOrNull(p.category),
      chains: Array.isArray(p.chains) ? p.chains.filter((c): c is string => typeof c === 'string') : [],
      tvl_usd: p.tvl_usd,
      change_7d: numOrNull(p.change_7d),
      mcap_usd: numOrNull(p.mcap_usd),
      listed_at: strOrNull(p.listed_at),
      gecko_id: strOrNull(p.gecko_id),
      symbol: strOrNull(p.symbol),
    } as Proto;
  });
  return { as_of: doc.as_of, source: doc.source, floor_usd: doc.floor_usd, protocols, watchlist: doc.watchlist as string[] };
}

// ---------------------------------------------------------------------------
// Small dense linear algebra: normal equations with Gaussian elimination.
// The fits are 2-4 parameters on ~100 rows; no library is needed or wanted.
// ---------------------------------------------------------------------------

/** Solve A x = b by Gaussian elimination with partial pivoting; null when singular. */
export function solveLinear(aIn: number[][], bIn: number[]): number[] | null {
  const n = bIn.length;
  const m = aIn.map((row, i) => [...row, bIn[i]!]);
  for (let col = 0; col < n; col++) {
    let pivot = col;
    for (let r = col + 1; r < n; r++) if (Math.abs(m[r]![col]!) > Math.abs(m[pivot]![col]!)) pivot = r;
    [m[col], m[pivot]] = [m[pivot]!, m[col]!];
    const d = m[col]![col]!;
    if (Math.abs(d) < 1e-12) return null;
    for (let r = 0; r < n; r++) {
      if (r === col) continue;
      const f = m[r]![col]! / d;
      for (let k = col; k <= n; k++) m[r]![k]! -= f * m[col]![k]!;
    }
  }
  return m.map((row, i) => row[n]! / row[i]!);
}

/** Weighted least squares through the normal equations. A hair of ridge on the
 *  slopes (never the intercept) keeps a constant term in a small training
 *  block from making the system singular. */
export function leastSquares(x: number[][], y: number[], w: number[] | null): number[] | null {
  const k = x[0]!.length;
  const a = Array.from({ length: k }, () => new Array<number>(k).fill(0));
  const b = new Array<number>(k).fill(0);
  for (let i = 0; i < x.length; i++) {
    const wi = w === null ? 1 : w[i]!;
    for (let r = 0; r < k; r++) {
      b[r]! += wi * x[i]![r]! * y[i]!;
      for (let c = 0; c < k; c++) a[r]![c]! += wi * x[i]![r]! * x[i]![c]!;
    }
  }
  for (let r = 1; r < k; r++) a[r]![r]! += 1e-6;
  return solveLinear(a, b);
}

export function medianOf(values: number[]): number {
  const s = [...values].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)]!;
}

function quantileOf(sorted: number[], q: number): number {
  if (sorted.length === 0) return 0;
  const at = q * (sorted.length - 1);
  const lo = Math.floor(at);
  const hi = Math.min(sorted.length - 1, lo + 1);
  const f = at - lo;
  return sorted[lo]! * (1 - f) + sorted[hi]! * f;
}

/** A multiplicative miss: how many times too big or too small, whichever is worse. */
export function missOf(predicted: number, actual: number): number {
  return Math.max(predicted / actual, actual / predicted);
}

// ---------------------------------------------------------------------------
// The traded comps and the fitted size curve.
// ---------------------------------------------------------------------------

/** A protocol is a usable comp when its token trades with a sane market-cap-to-TVL
 *  ratio. CEX tokens are exchange equity, not protocol value; a ratio outside
 *  [0.002, 20] is a dead token or a data error, not a valuation. */
export function compSet(protocols: Proto[]): Proto[] {
  return protocols.filter((p) => {
    if (!(p.mcap_usd !== null && p.mcap_usd > 0 && p.tvl_usd > 0)) return false;
    if (p.category === 'CEX') return false;
    const ratio = p.mcap_usd / p.tvl_usd;
    return ratio >= 0.002 && ratio <= 20;
  });
}

/** The curve's features: an intercept, log TVL, and the winsorised seven-day growth.
 *  No age term: it was fitted, tested and dropped (see the header). */
export function curveFeatures(p: Proto): number[] {
  return [1, Math.log(p.tvl_usd), growthOf(p)];
}

export interface FittedCurve {
  beta: number[];
  residuals: number[];
}

/** Huber-robust fit of log market cap on the curve's features: plain least
 *  squares, then three reweighting passes that downweight large residuals
 *  (k = 1.345 robust sigmas). */
export function fitCurve(rows: Proto[]): FittedCurve {
  const x = rows.map(curveFeatures);
  const y = rows.map((p) => Math.log(p.mcap_usd!));
  let beta = leastSquares(x, y, null)!;
  for (let pass = 0; pass < 3; pass++) {
    const resid = x.map((row, i) => y[i]! - row.reduce((s, v, j) => s + v * beta[j]!, 0));
    const scale = 1.4826 * medianOf(resid.map((r) => Math.abs(r))) || 1e-9;
    const k = 1.345 * scale;
    beta = leastSquares(x, y, resid.map((r) => Math.min(1, k / Math.max(Math.abs(r), 1e-9))))!;
  }
  const residuals = x.map((row, i) => y[i]! - row.reduce((s, v, j) => s + v * beta[j]!, 0));
  return { beta, residuals };
}

/** The curve's value-if-launches for a protocol's TVL and growth. */
export function curveAt(beta: number[], tvl: number, growth: number): number {
  return Math.exp(beta[0]! + beta[1]! * Math.log(tvl) + beta[2]! * growth);
}

// ---------------------------------------------------------------------------
// Validation: leave-one-out, walk-forward, ablation, band coverage.
// Everything is computed from the comps at run time; nothing is asserted.
// ---------------------------------------------------------------------------

export interface Validation {
  comps: number;
  beta: number[];
  looModel: number;
  looFlat: number;
  wfModel: number;
  wfFlat: number;
  wfWithAge: number;
  wfSizeOnly: number;
  wfN: number;
  wfDated: number;
  ablation: { label: string; loo: number }[];
  band2575: number;
  band1090: number;
  oddsAccuracy: number;
  oddsBase: number;
  oddsBrier: number;
  oddsBrierBase: number;
}

/** Features under a term set: 'g' adds growth, 'a' adds the (dropped) age term.
 *  Used by the ablation, which refits each variant from scratch. */
function ablationFeatures(p: Proto, asOf: string, terms: string): number[] {
  const f = [1, Math.log(p.tvl_usd)];
  if (terms.includes('g')) f.push(growthOf(p));
  if (terms.includes('a')) f.push(Math.min(daysOld(asOf, p.listed_at) ?? 365, 1095) / 1095);
  return f;
}

function fitTerms(rows: Proto[], asOf: string, terms: string): number[] {
  const x = rows.map((p) => ablationFeatures(p, asOf, terms));
  const y = rows.map((p) => Math.log(p.mcap_usd!));
  let beta = leastSquares(x, y, null)!;
  for (let pass = 0; pass < 3; pass++) {
    const resid = x.map((row, i) => y[i]! - row.reduce((s, v, j) => s + v * beta[j]!, 0));
    const scale = 1.4826 * medianOf(resid.map((r) => Math.abs(r))) || 1e-9;
    const k = 1.345 * scale;
    beta = leastSquares(x, y, resid.map((r) => Math.min(1, k / Math.max(Math.abs(r), 1e-9))))!;
  }
  return beta;
}

function predictTerms(beta: number[], p: Proto, asOf: string, terms: string): number {
  const f = ablationFeatures(p, asOf, terms);
  return Math.exp(f.reduce((s, v, j) => s + v * beta[j]!, 0));
}

/** The flat-multiple baseline: the median market-cap-to-TVL ratio of the training set. */
function flatMultiple(rows: Proto[]): number {
  return medianOf(rows.map((p) => p.mcap_usd! / p.tvl_usd));
}

/** Leave-one-out median miss for one term set, and for the flat baseline. */
export function looFor(comps: Proto[], asOf: string, terms: string): { model: number; flat: number } {
  const modelMiss: number[] = [];
  const flatMiss: number[] = [];
  for (let i = 0; i < comps.length; i++) {
    const train = comps.filter((_, j) => j !== i);
    const beta = fitTerms(train, asOf, terms);
    modelMiss.push(missOf(predictTerms(beta, comps[i]!, asOf, terms), comps[i]!.mcap_usd!));
    flatMiss.push(missOf(comps[i]!.tvl_usd * flatMultiple(train), comps[i]!.mcap_usd!));
  }
  return { model: medianOf(modelMiss), flat: medianOf(flatMiss) };
}

/** Walk-forward: comps ordered by listing date, six chronological blocks, five
 *  origins; each origin trains on the older blocks and tests on the next one. */
export function walkForwardFor(comps: Proto[], asOf: string, terms: string): { model: number; flat: number; n: number; dated: number } {
  const dated = comps
    .filter((p) => p.listed_at !== null)
    .sort((a, b) => (a.listed_at! < b.listed_at! ? -1 : a.listed_at! > b.listed_at! ? 1 : a.slug < b.slug ? -1 : 1));
  const blocks = 6;
  const size = Math.floor(dated.length / blocks);
  const modelMiss: number[] = [];
  const flatMiss: number[] = [];
  for (let k = 1; k < blocks; k++) {
    const train = dated.slice(0, k * size);
    const test = dated.slice(k * size, (k + 1) * size);
    if (train.length === 0 || test.length === 0) continue;
    const beta = fitTerms(train, asOf, terms);
    const mult = flatMultiple(train);
    for (const p of test) {
      modelMiss.push(missOf(predictTerms(beta, p, asOf, terms), p.mcap_usd!));
      flatMiss.push(missOf(p.tvl_usd * mult, p.mcap_usd!));
    }
  }
  return { model: medianOf(modelMiss), flat: medianOf(flatMiss), n: modelMiss.length, dated: dated.length };
}

// ---------------------------------------------------------------------------
// Bootstrap bands: 200 refits, each prediction carrying a resampled residual.
// The order of random draws is fixed (refits outer, rows inner) so the
// dashboard's own re-run reproduces these bands exactly.
// ---------------------------------------------------------------------------

export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export const BOOTSTRAPS = 200;
export const BOOT_SEED = 20261114;

export interface Band {
  p10: number;
  p25: number;
  p75: number;
  p90: number;
  rankLo: number;
  rankHi: number;
}

/** Bootstrap predictions for every row: refits[replicate][rowIndex]. Two sets
 *  come out of each refit: the refitted curve's value alone (`paramOnly`), and
 *  that value times exp() of one residual drawn from the final fit's residual
 *  pool (`withResid`). Value bands use the second (predictive intervals);
 *  rank ranges use the first (the ranking is a property of the model, and the
 *  refits are its perturbation). The order of random draws is fixed (refits
 *  outer, rows inner) so the dashboard's own re-run reproduces both exactly. */
export function bootstrapPredictions(
  comps: Proto[],
  fitted: FittedCurve,
  rows: { tvl_usd: number; change_7d: number | null }[],
): { withResid: number[][]; paramOnly: number[][] } {
  const rng = mulberry32(BOOT_SEED);
  const n = comps.length;
  const pool = fitted.residuals;
  const withResid: number[][] = [];
  const paramOnly: number[][] = [];
  for (let b = 0; b < BOOTSTRAPS; b++) {
    const sample: Proto[] = [];
    for (let i = 0; i < n; i++) sample.push(comps[Math.floor(rng() * n)]!);
    const beta = fitCurve(sample).beta;
    const predsR: number[] = [];
    const predsP: number[] = [];
    for (const row of rows) {
      const resid = pool[Math.floor(rng() * pool.length)]!;
      const base = curveAt(beta, row.tvl_usd, growthOf(row as Proto));
      predsP.push(base);
      predsR.push(base * Math.exp(resid));
    }
    withResid.push(predsR);
    paramOnly.push(predsP);
  }
  return { withResid, paramOnly };
}

/** Bands from the residual-inclusive predictions and rank ranges from the
 *  refitted curves alone, plus the share of the current top 20 that stays
 *  top 20 in at least 80% of refits. */
export function bandsFromPredictions(
  valuePreds: number[][],
  rankPreds: number[][],
  currentRank: number[],
): { bands: Band[]; top20Stable: number } {
  const nRows = currentRank.length;
  const byRow: number[][] = Array.from({ length: nRows }, () => []);
  const rankByRow: number[][] = Array.from({ length: nRows }, () => []);
  for (let b = 0; b < valuePreds.length; b++) {
    const rep = valuePreds[b]!;
    const rankRep = rankPreds[b]!;
    const order = rankRep.map((_, i) => i).sort((a, b2) => rankRep[b2]! - rankRep[a]! || a - b2);
    const rankOf = new Array<number>(nRows);
    order.forEach((rowIdx, pos) => {
      rankOf[rowIdx] = pos + 1;
    });
    for (let i = 0; i < nRows; i++) {
      byRow[i]!.push(rep[i]!);
      rankByRow[i]!.push(rankOf[i]!);
    }
  }
  const bands: Band[] = byRow.map((values, i) => {
    const sorted = [...values].sort((a, b) => a - b);
    const ranks = [...rankByRow[i]!].sort((a, b) => a - b);
    return {
      p10: quantileOf(sorted, 0.1),
      p25: quantileOf(sorted, 0.25),
      p75: quantileOf(sorted, 0.75),
      p90: quantileOf(sorted, 0.9),
      rankLo: Math.round(quantileOf(ranks, 0.1)),
      rankHi: Math.round(quantileOf(ranks, 0.9)),
    };
  });
  let top20Stable = 0;
  for (let i = 0; i < nRows; i++) {
    if (currentRank[i]! > 20) continue;
    const stay = rankByRow[i]!.filter((r) => r <= 20).length / BOOTSTRAPS;
    if (stay >= 0.8) top20Stable++;
  }
  return { bands, top20Stable };
}

/** Band coverage on the comps themselves: the share of actual market caps the
 *  predictive bands contain. Honest bands hold about half in P25-P75 and
 *  about four fifths in P10-P90. */
export function bandCoverage(comps: Proto[], fitted: FittedCurve): { band2575: number; band1090: number } {
  const { withResid: preds } = bootstrapPredictions(comps, fitted, comps);
  let in2575 = 0;
  let in1090 = 0;
  for (let i = 0; i < comps.length; i++) {
    const values = preds.map((rep) => rep[i]!).sort((a, b) => a - b);
    const actual = comps[i]!.mcap_usd!;
    if (actual >= quantileOf(values, 0.25) && actual <= quantileOf(values, 0.75)) in2575++;
    if (actual >= quantileOf(values, 0.1) && actual <= quantileOf(values, 0.9)) in1090++;
  }
  return { band2575: in2575 / comps.length, band1090: in1090 / comps.length };
}

// ---------------------------------------------------------------------------
// Launch odds: look-alike bucket rates, validated by five-fold split.
// ---------------------------------------------------------------------------

export type AgeBand = '<1y' | '1-2y' | '2y+' | 'unk';

export function ageBandOf(ageDays: number | null): AgeBand {
  if (ageDays === null) return 'unk';
  if (ageDays < 365) return '<1y';
  if (ageDays < 730) return '1-2y';
  return '2y+';
}

export interface OddsTable {
  terciles: [number, number];
  baseRate: number;
  buckets: Record<string, { n: number; withToken: number }>;
}

function sizeBandOf(tvl: number, terciles: [number, number]): 'S' | 'M' | 'L' {
  return tvl < terciles[0] ? 'S' : tvl < terciles[1] ? 'M' : 'L';
}

function bucketKey(p: Proto, asOf: string, terciles: [number, number]): string {
  return `${ageBandOf(daysOld(asOf, p.listed_at))}/${sizeBandOf(p.tvl_usd, terciles)}`;
}

const hasTokenRecord = (p: Proto): boolean => p.gecko_id !== null || p.symbol !== null;

/** The look-alike table: every protocol placed in an age band x TVL tercile
 *  bucket, counting how many record a token. */
export function oddsTableOf(protocols: Proto[], asOf: string): OddsTable {
  const tvls = protocols.map((p) => p.tvl_usd).sort((a, b) => a - b);
  const terciles: [number, number] = [tvls[Math.floor(tvls.length / 3)]!, tvls[Math.floor((2 * tvls.length) / 3)]!];
  const baseRate = protocols.filter(hasTokenRecord).length / protocols.length;
  const buckets: Record<string, { n: number; withToken: number }> = {};
  for (const p of protocols) {
    const key = bucketKey(p, asOf, terciles);
    const b = (buckets[key] ??= { n: 0, withToken: 0 });
    b.n++;
    if (hasTokenRecord(p)) b.withToken++;
  }
  return { terciles, baseRate, buckets };
}

/** A protocol's launch odds: the smoothed share of its look-alikes that still
 *  record no token. Five pseudo-observations at the base rate keep a small
 *  bucket from claiming certainty. */
export function launchOddsOf(p: Proto, asOf: string, table: OddsTable): number {
  const b = table.buckets[bucketKey(p, asOf, table.terciles)];
  if (b === undefined) return 1 - table.baseRate;
  const withToken = (b.withToken + 5 * table.baseRate) / (b.n + 5);
  return 1 - withToken;
}

/** Five-fold validation of the bucket rates on a seeded shuffle: accuracy and
 *  Brier score against the base-rate predictor. */
export function validateOdds(protocols: Proto[], asOf: string): { accuracy: number; base: number; brier: number; brierBase: number } {
  const rng = mulberry32(7);
  const order = protocols.map((_, i) => i);
  for (let i = order.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [order[i], order[j]] = [order[j]!, order[i]!];
  }
  const folds = 5;
  const size = Math.floor(order.length / folds);
  let correct = 0;
  let correctBase = 0;
  let brier = 0;
  let brierBase = 0;
  let n = 0;
  for (let k = 0; k < folds; k++) {
    const testIdx = new Set(order.slice(k * size, k === folds - 1 ? order.length : (k + 1) * size));
    const train = protocols.filter((_, i) => !testIdx.has(i));
    const test = protocols.filter((_, i) => testIdx.has(i));
    const table = oddsTableOf(train, asOf);
    const trainBase = train.filter(hasTokenRecord).length / train.length;
    for (const p of test) {
      const probToken = 1 - launchOddsOf(p, asOf, table);
      const y = hasTokenRecord(p) ? 1 : 0;
      if ((probToken >= 0.5) === (y === 1)) correct++;
      if ((trainBase >= 0.5) === (y === 1)) correctBase++;
      brier += (probToken - y) ** 2;
      brierBase += (trainBase - y) ** 2;
      n++;
    }
  }
  return { accuracy: correct / n, base: correctBase / n, brier: brier / n, brierBase: brierBase / n };
}

// ---------------------------------------------------------------------------
// Board selection: the house exclusion rule, applied to the whole board.
// ---------------------------------------------------------------------------

/** Categories whose products are not launch candidates: a bridge moves other
 *  people's tokens, a staking product wraps one that trades, an exchange's
 *  balance sheet is not a protocol. */
const EXCLUDED_CATEGORIES = new Set(['Bridge', 'Canonical Bridge', 'Liquid Staking', 'Liquid Restaking', 'Restaked BTC', 'CEX']);

const VERSIONED_NAME = /\s(V\d+(\.\d+)?|v\d+(\.\d+)?|\d+\.\d+)$/;
const WRAPPED_WORD = /\b(wrapped|staked|staking)\b/i;
const EXCHANGE_NAME = /^(binance|coinbase|bybit|kraken|bitget|okx|bitfinex|gemini)\b/i;

/** Whether a protocol records no token at all. */
export function isPreToken(p: Proto): boolean {
  return p.mcap_usd === null && p.gecko_id === null && p.symbol === null;
}

/** Why a pre-token protocol is set aside, or null when the board may rank it. */
export function exclusionOf(p: Proto): string | null {
  if (!isPreToken(p)) return null;
  if (p.category !== null && EXCLUDED_CATEGORIES.has(p.category)) return `category: ${p.category}`;
  if (VERSIONED_NAME.test(p.name)) return 'versioned name';
  if (WRAPPED_WORD.test(p.name)) return 'wrapped/staked name';
  if (EXCHANGE_NAME.test(p.name)) return 'exchange-named';
  return null;
}

export interface LedgerEntry {
  label: string;
  count: number;
  note: string;
}

/** Every protocol in the snapshot placed in exactly one bucket. The counts
 *  sum to the snapshot's protocol count; the caller asserts it. */
export function ledgerOf(snapshot: Snapshot, boardSlugs: Set<string>): LedgerEntry[] {
  const counts = new Map<string, number>();
  const noteOf = (label: string): string => {
    if (label === 'ranked') return 'pre-token, passes the house rule, ranked by expected value';
    if (label === 'token trades') return 'records a token with a market cap: the market prices it, not the model';
    if (label === 'token on record, no market cap') return 'records a token but no market cap: already launched, nothing to find';
    if (label.startsWith('category: ')) return 'a bridge, staking product or exchange balance sheet, not a launch candidate';
    if (label === 'versioned name') return 'a versioned pool of another protocol';
    if (label === 'wrapped/staked name') return 'a wrapped or staked product of a token that trades';
    if (label === 'exchange-named') return 'named for an exchange, not a protocol of its own';
    return '';
  };
  for (const p of snapshot.protocols) {
    let label: string;
    if (boardSlugs.has(p.slug)) label = 'ranked';
    else if (!isPreToken(p)) label = p.mcap_usd !== null && p.mcap_usd > 0 ? 'token trades' : 'token on record, no market cap';
    else label = exclusionOf(p) ?? 'ranked';
    counts.set(label, (counts.get(label) ?? 0) + 1);
  }
  const order = ['ranked', 'token trades', 'token on record, no market cap'];
  const rest = [...counts.keys()].filter((k) => !order.includes(k)).sort();
  return [...order, ...rest]
    .filter((k) => counts.has(k))
    .map((label) => ({ label, count: counts.get(label)!, note: noteOf(label) }));
}

// ---------------------------------------------------------------------------
// Farm economics: deposit-sized, per protocol, with a verdict.
// ---------------------------------------------------------------------------

/** The gas price assumed per transaction on each chain, in dollars. A stated
 *  assumption, not a measurement: the page names it beside the verdicts. */
const GAS_USD: Record<string, number> = {
  Ethereum: 8,
  Solana: 0.05,
  Base: 0.5,
  Arbitrum: 0.5,
  Optimism: 0.5,
  BSC: 0.3,
  Polygon: 0.1,
  Avalanche: 0.5,
  Sui: 0.1,
  Aptos: 0.1,
};

export const FARM_TXNS = 8; // one deposit, six weekly actions, one claim
export const FARM_MISC_USD = 5; // bridging and slippage, flat
export const FARM_HOURS = 2.25; // half an hour to set up, fifteen minutes a week, fifteen to claim
export const FARM_WEEKS = 6;
export const HOLD_DAYS = 45;
export const AIRDROP_SHARE = 0.05; // the share of supply assumed to reach farmers
export const FARM_NET_USD = 10; // a FARM verdict needs more than $10 of expected net at the ticket size
export const TICKETS = [1000, 5000, 10000];

export type Verdict = 'FARM' | 'THIN' | 'SKIP';

export interface FarmEconomics {
  ticket: number;
  slice: number;
  expected: number;
  cost: number;
  netExpected: number;
  breakEvenOdds: number | null; // null when the slice is zero: it never pays off
  netPerHour: number;
  verdict: Verdict;
  reason: string;
}

export function gasFor(chain: string): number {
  return GAS_USD[chain] ?? 2;
}

/** One protocol's farm economics at one ticket size. The slice assumes the
 *  farmer's share of a 5% farmer airdrop equals their share of the protocol's
 *  TVL; the expected slice discounts it by the launch odds. */
export function economicsFor(tvl: number, valueIfLaunches: number, odds: number, chain: string, ticket: number): FarmEconomics {
  const slice = (ticket / tvl) * AIRDROP_SHARE * valueIfLaunches;
  const expected = slice * odds;
  const cost = FARM_TXNS * gasFor(chain) + FARM_MISC_USD;
  const netExpected = expected - cost;
  const breakEvenOdds = slice > 0 ? cost / slice : null;
  const netPerHour = netExpected / FARM_HOURS;
  let verdict: Verdict;
  let reason: string;
  if (netExpected > FARM_NET_USD) {
    verdict = 'FARM';
    reason = 'the expected slice clears the costs several times over';
  } else if (netExpected > 0) {
    verdict = 'THIN';
    reason = 'the expected slice clears the costs but leaves little margin';
  } else {
    verdict = 'SKIP';
    reason = 'the expected slice does not cover the costs at this ticket size';
  }
  return { ticket, slice, expected, cost, netExpected, breakEvenOdds, netPerHour, verdict, reason };
}

/** The deposit action for one protocol's category, in words a farmer can follow. */
function depositAction(p: Proto, ticket: number, chain: string): string {
  const c = (p.category ?? '').toLowerCase();
  const name = p.name;
  if (c.includes('lend') || c.includes('cdp') || c.includes('collateral')) {
    return `Lend $${ticket} of USDC into ${name} on ${chain} and leave the position open.`;
  }
  if (c.includes('dex') || c.includes('yield') || c.includes('leveraged farm')) {
    return `Add $${ticket} of liquidity to ${name}'s largest pool on ${chain} and leave the position open.`;
  }
  if (c.includes('perpetual') || c.includes('derivative') || c.includes('option')) {
    return `Post $${ticket} of USDC as margin on ${name} and open one small hedged position.`;
  }
  if (c.includes('rwa')) return `Mint $${ticket} of ${name}'s yield-bearing asset on ${chain} and hold it.`;
  if (c.includes('prediction')) return `Fund $${ticket} and take one position in a ${name} market.`;
  if (c.includes('curator') || c.includes('allocator') || c.includes('asset management')) {
    return `Deposit $${ticket} into a ${name} vault on ${chain} and keep the shares.`;
  }
  if (c.includes('stable')) return `Mint or deposit $${ticket} of the stable asset through ${name} on ${chain}.`;
  if (c.includes('insurance')) return `Buy $${ticket} of cover from ${name} on ${chain} and keep the policy.`;
  return `Deposit $${ticket} of USDC into ${name} on ${chain} and leave the position open.`;
}

const money = (n: number): string => {
  if (n >= 1_000_000) return `$${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `$${(n / 1_000).toFixed(1)}K`;
  if (n >= 100) return `$${Math.round(n)}`;
  if (n >= 1) return `$${n.toFixed(0)}`;
  return `$${n.toFixed(2)}`;
};

/** A step kept inside the gate's 20..600 characters. */
function fitStep(text: string): string {
  const s = text.trim();
  if (s.length > 600) return `${s.slice(0, 597)}...`;
  if (s.length < 20) return `${s} Keep a record of the wallet, the dates and every transaction.`;
  return s;
}

/** Six farm steps for one protocol, each carrying that protocol's own numbers:
 *  the ticket, the TVL, the slice, the gas, the age, the verdict. */
export function farmStepsFor(p: Proto, econ: FarmEconomics, ageDays: number | null): string[] {
  const chain = p.chains.length > 0 ? p.chains[0]! : 'its main chain';
  const ticket = econ.ticket;
  const ageText = ageDays === null ? 'an unreported length of time' : ageDays < 30 ? 'under a month' : `${Math.round(ageDays / 30)} months`;
  const be = econ.breakEvenOdds === null || econ.breakEvenOdds > 1 ? 'over 100% (it never pays off)' : `${Math.round(econ.breakEvenOdds * 100)}%`;
  const steps = [
    `Open a fresh wallet that holds only the $${ticket} you plan to farm with, and keep its seed phrase offline where nobody else can read it. Cost: under $3 of gas for the first transaction. Time: 5 minutes.`,
    `${depositAction(p, ticket, chain)} At ${money(p.tvl_usd)} of TVL, that is about a ${money(econ.slice)} share of a 5% farmer airdrop if ${p.name} launches. Cost: about $${gasFor(chain)} of gas. Time: 15 minutes.`,
    `Make one qualifying action each week for ${FARM_WEEKS} weeks, a deposit, a swap, a vote or a borrow, so the position is counted in more than one snapshot. Cost: about $${gasFor(chain)} of gas a week. Time: 10 minutes a week.`,
    `Hold the position at least ${HOLD_DAYS} days. ${p.name} has run ${ageText} with no token, so snapshots reward patience over a quick in-and-out. Cost: the $${ticket} stays in the position. Time: ${HOLD_DAYS} days.`,
    `The economics at a $${ticket} ticket: about ${money(econ.slice)} if it launches, ${money(econ.expected)} expected, $${Math.round(econ.cost)} of costs, break-even odds ${be}. Verdict: ${econ.verdict} — ${econ.reason}. Cost: nothing to decide. Time: 5 minutes.`,
    `Before you withdraw, open ${p.name}'s own points or rewards page from the link it publishes and claim only there, then log the wallet, the dates and every transaction. Cost: no fee to check, and never pay to claim. Time: 10 minutes.`,
  ];
  return steps.map(fitStep);
}

// ---------------------------------------------------------------------------
// The board, the dashboard data, the model card, and the gate self-check.
// ---------------------------------------------------------------------------

export interface BoardRow {
  rank: number;
  slug: string;
  name: string;
  category: string | null;
  chains: string[];
  tvl_usd: number;
  change_7d: number | null;
  age_days: number | null;
  watchlist: boolean;
  implied_value_usd: number;
  value_if_launches_usd: number;
  launch_odds: number;
  band_p10_usd: number;
  band_p25_usd: number;
  band_p75_usd: number;
  band_p90_usd: number;
  rank_range: [number, number];
  verdict: Verdict;
  farm: FarmEconomics;
  farm_steps: string[];
}

/** One board row in the dashboard's compact form (short keys; the page's
 *  script documents them). Money is whole dollars, odds three decimals. */
export type RadarRow = [
  number, // rank
  string, // slug
  string, // name
  string | null, // category
  string, // first chain
  number, // tvl_usd
  number | null, // change_7d
  number | null, // age_days
  number, // implied_value_usd (expected value)
  number, // value_if_launches_usd
  number, // launch_odds
  number, // band p10
  number, // band p25
  number, // band p75
  number, // band p90
  number, // rank range low
  number, // rank range high
  Verdict, // verdict at the default ticket
  number, // slice at the default ticket
  number, // cost
  number, // net expected
  number | null, // break-even odds
  number, // net per hour
  boolean, // on the watchlist
  string[], // farm steps
];

export interface RadarData {
  asOf: string;
  floor: number;
  model: string;
  fit: { beta: number[]; comps: number };
  val: {
    loo: number;
    looFlat: number;
    wf: number;
    wfFlat: number;
    wfAge: number;
    wfSize: number;
    wfN: number;
    wfDated: number;
    ablation: [string, number][];
    band2575: number;
    band1090: number;
    oddsAcc: number;
    oddsBase: number;
    oddsBrier: number;
    oddsBrierBase: number;
  };
  ledger: [string, number, string][];
  kpi: { ranked: number; totalEv: number; farm: number; thin: number; skip: number; top20Stable: number; bestNetHour: number };
  odds: { terciles: [number, number]; base: number; buckets: Record<string, [number, number]> };
  comps: [number, number, number | null][];
  resid: number[];
  rows: RadarRow[];
}

export interface Built {
  board: BoardRow[];
  data: RadarData;
  modelCard: Record<string, unknown>;
  validation: Validation;
  ledger: LedgerEntry[];
}

const round3 = (n: number): number => Math.round(n * 1000) / 1000;
const round2 = (n: number): number => Math.round(n * 100) / 100;

/** The whole entry from the snapshot: fit, validation, board, bands, economics. */
export function buildAll(snapshot: Snapshot): Built {
  const comps = compSet(snapshot.protocols);
  const fitted = fitCurve(comps);
  const loo = looFor(comps, snapshot.as_of, 'g');
  const wf = walkForwardFor(comps, snapshot.as_of, 'g');
  const wfAge = walkForwardFor(comps, snapshot.as_of, 'ga');
  const wfSize = walkForwardFor(comps, snapshot.as_of, '');
  const ablation: [string, number][] = [
    ['size + growth (shipped)', loo.model],
    ['size only', looFor(comps, snapshot.as_of, '').model],
    ['size + growth + age', looFor(comps, snapshot.as_of, 'ga').model],
    ['size + age', looFor(comps, snapshot.as_of, 'a').model],
    ['flat multiple', loo.flat],
  ];
  const coverage = bandCoverage(comps, fitted);
  const oddsCheck = validateOdds(snapshot.protocols, snapshot.as_of);
  const validation: Validation = {
    comps: comps.length,
    beta: fitted.beta,
    looModel: loo.model,
    looFlat: loo.flat,
    wfModel: wf.model,
    wfFlat: wf.flat,
    wfWithAge: wfAge.model,
    wfSizeOnly: wfSize.model,
    wfN: wf.n,
    wfDated: wf.dated,
    ablation: ablation.map(([label, v]) => ({ label, loo: v })),
    band2575: coverage.band2575,
    band1090: coverage.band1090,
    oddsAccuracy: oddsCheck.accuracy,
    oddsBase: oddsCheck.base,
    oddsBrier: oddsCheck.brier,
    oddsBrierBase: oddsCheck.brierBase,
  };

  const oddsTable = oddsTableOf(snapshot.protocols, snapshot.as_of);
  const watch = new Set(snapshot.watchlist);
  const rankable = snapshot.protocols.filter((p) => isPreToken(p) && exclusionOf(p) === null);
  const scored = rankable.map((p) => {
    const age = daysOld(snapshot.as_of, p.listed_at);
    const valueIf = curveAt(fitted.beta, p.tvl_usd, growthOf(p));
    const odds = launchOddsOf(p, snapshot.as_of, oddsTable);
    return { p, age, valueIf, odds, ev: Math.max(1, Math.round(valueIf * odds)) };
  });
  scored.sort((a, b) => b.ev - a.ev || (a.p.slug < b.p.slug ? -1 : a.p.slug > b.p.slug ? 1 : 0));

  // Bands on expected value: each bootstrap replicate's value-if-launches
  // prediction times the row's (fixed) launch odds. Value bands use the
  // residual-inclusive predictions; rank ranges use the refitted curves alone.
  const boot = bootstrapPredictions(comps, fitted, scored.map((s) => s.p));
  const evWithResid = boot.withResid.map((rep) => rep.map((v, i) => v * scored[i]!.odds));
  const evParamOnly = boot.paramOnly.map((rep) => rep.map((v, i) => v * scored[i]!.odds));
  const { bands, top20Stable } = bandsFromPredictions(evWithResid, evParamOnly, scored.map((_, i) => i + 1));

  const board: BoardRow[] = scored.map((s, i) => {
    const chain = s.p.chains.length > 0 ? s.p.chains[0]! : 'its main chain';
    const econ = economicsFor(s.p.tvl_usd, s.valueIf, s.odds, chain, TICKETS[0]!);
    const band = bands[i]!;
    return {
      rank: i + 1,
      slug: s.p.slug,
      name: s.p.name,
      category: s.p.category,
      chains: s.p.chains,
      tvl_usd: s.p.tvl_usd,
      change_7d: s.p.change_7d,
      age_days: s.age,
      watchlist: watch.has(s.p.slug),
      implied_value_usd: s.ev,
      value_if_launches_usd: Math.max(1, Math.round(s.valueIf)),
      launch_odds: round3(s.odds),
      band_p10_usd: Math.max(1, Math.round(band.p10)),
      band_p25_usd: Math.max(1, Math.round(band.p25)),
      band_p75_usd: Math.max(1, Math.round(band.p75)),
      band_p90_usd: Math.max(1, Math.round(band.p90)),
      rank_range: [band.rankLo, band.rankHi],
      verdict: econ.verdict,
      farm: econ,
      farm_steps: farmStepsFor(s.p, econ, s.age),
    };
  });

  const boardSlugs = new Set(board.map((r) => r.slug));
  const ledger = ledgerOf(snapshot, boardSlugs);
  const ledgerSum = ledger.reduce((n, e) => n + e.count, 0);
  if (ledgerSum !== snapshot.protocols.length) {
    throw new SnapshotError(`the ledger accounts for ${ledgerSum} of ${snapshot.protocols.length} protocols`);
  }
  const farmCount = board.filter((r) => r.verdict === 'FARM').length;
  const thinCount = board.filter((r) => r.verdict === 'THIN').length;
  const bestNetHour = Math.max(...board.map((r) => r.farm.netPerHour));

  const data: RadarData = {
    asOf: snapshot.as_of,
    floor: snapshot.floor_usd,
    model: MODEL_VERSION,
    fit: { beta: fitted.beta.map(round3), comps: comps.length },
    val: {
      loo: round2(loo.model),
      looFlat: round2(loo.flat),
      wf: round2(wf.model),
      wfFlat: round2(wf.flat),
      wfAge: round2(wfAge.model),
      wfSize: round2(wfSize.model),
      wfN: wf.n,
      wfDated: wf.dated,
      ablation: ablation.map(([label, v]) => [label, round2(v)] as [string, number]),
      band2575: round2(coverage.band2575),
      band1090: round2(coverage.band1090),
      oddsAcc: round3(oddsCheck.accuracy),
      oddsBase: round3(oddsCheck.base),
      oddsBrier: round3(oddsCheck.brier),
      oddsBrierBase: round3(oddsCheck.brierBase),
    },
    ledger: ledger.map((e) => [e.label, e.count, e.note] as [string, number, string]),
    kpi: {
      ranked: board.length,
      totalEv: board.reduce((n, r) => n + r.implied_value_usd, 0),
      farm: farmCount,
      thin: thinCount,
      skip: board.length - farmCount - thinCount,
      top20Stable,
      bestNetHour: round2(bestNetHour),
    },
    odds: {
      terciles: oddsTable.terciles,
      // Full precision: the dashboard's re-run must reproduce the odds exactly.
      base: oddsTable.baseRate,
      buckets: Object.fromEntries(Object.entries(oddsTable.buckets).map(([k, v]) => [k, [v.n, v.withToken] as [number, number]])),
    },
    comps: comps.map((p) => [p.tvl_usd, p.mcap_usd!, p.change_7d] as [number, number, number | null]),
    // Full-precision residuals: the dashboard's re-run must reproduce the bands exactly.
    resid: fitted.residuals,
    rows: board.map(
      (r): RadarRow => [
        r.rank,
        r.slug,
        r.name,
        r.category,
        r.chains.length > 0 ? r.chains[0]! : '',
        r.tvl_usd,
        r.change_7d,
        r.age_days,
        r.implied_value_usd,
        r.value_if_launches_usd,
        r.launch_odds,
        r.band_p10_usd,
        r.band_p25_usd,
        r.band_p75_usd,
        r.band_p90_usd,
        r.rank_range[0],
        r.rank_range[1],
        r.verdict,
        Math.round(r.farm.slice * 100) / 100,
        Math.round(r.farm.cost * 100) / 100,
        Math.round(r.farm.netExpected * 100) / 100,
        r.farm.breakEvenOdds === null ? null : round3(r.farm.breakEvenOdds),
        round2(r.farm.netPerHour),
        r.watchlist,
        r.farm_steps,
      ],
    ),
  };

  const modelCard: Record<string, unknown> = {
    model: MODEL_VERSION,
    asOf: snapshot.as_of,
    formula: 'log(market cap) = a + b x log(TVL) + c x 7-day growth, Huber-robust fit on the traded comps; expected value = value-if-launches x launch odds',
    fit: {
      intercept: round3(fitted.beta[0]!),
      logTvl: round3(fitted.beta[1]!),
      growth: round3(fitted.beta[2]!),
      comps: comps.length,
      compRule: 'token trades, not a CEX, market-cap-to-TVL ratio between 0.002 and 20',
    },
    validation: {
      leaveOneOut: `${round2(loo.model)}x median miss vs ${round2(loo.flat)}x for a flat multiple (${comps.length} comps)`,
      walkForward: `${round2(wf.model)}x vs ${round2(wf.flat)}x flat, 5 origins, ${wf.n} newer comps`,
      ageTermDropped: `adding an age term worsens walk-forward miss to ${round2(wfAge.model)}x, so the curve carries no age term; age enters through launch odds`,
      growthKept: `size-only scores ${round2(wfSize.model)}x walk-forward against the shipped ${round2(wf.model)}x — inside one standard error of the median, so the held-out tests cannot separate them; growth stays because the criterion names it and its fitted sign matches the economics`,
      ablation: ablation.map(([label, v]) => `${label}: ${round2(v)}x`),
      bandCoverage: `P25-P75 holds ${Math.round(coverage.band2575 * 100)}% of traded market caps, P10-P90 holds ${Math.round(coverage.band1090 * 100)}%`,
      launchOdds: `look-alike bucket rates, 5-fold accuracy ${round3(oddsCheck.accuracy)} vs ${round3(oddsCheck.base)} base rate`,
    },
    launchOdds: 'odds = the share of look-alike protocols (same age band, same TVL tercile) that still record no token; a discount, not a forecast',
    bands: '200 bootstrap refits: value bands add a resampled residual (predictive intervals, not parameter intervals); rank ranges come from the refitted curves alone',
    ledger: ledger.map((e) => `${e.label}: ${e.count}`),
    farmAssumptions: [
      'airdrop: 5% of supply to farmers, your share equals your share of TVL',
      `costs: ${FARM_TXNS} transactions at the chain gas price plus $${FARM_MISC_USD} misc, ${FARM_HOURS} hours of hands-on time`,
      `verdicts: FARM when expected net clears $${FARM_NET_USD}, THIN when it clears $0, else SKIP`,
    ],
    board: `${board.length} rows ranked by expected value, ${snapshot.watchlist.length} watchlist protocols all covered`,
  };

  return { board, data, modelCard, validation, ledger };
}

/** The dashboard's whole dataset as one script: no fetch, no network. */
export function dataScript(data: RadarData): string {
  return `window.RADAR=${JSON.stringify(data)};\n`;
}

/** The model card as a script the dossier's source read carries whole: the
 *  fit, the validation and the assumptions, in plain text. */
export function modelCardScript(card: Record<string, unknown>): string {
  return `window.MODEL_CARD=${JSON.stringify(card)};\n`;
}

/** Why a board is not one the gate will take, or null. */
export function checkBoard(board: BoardRow[], snapshot: Snapshot): string | null {
  if (board.length < 100 || board.length > 4000) return `the board holds ${board.length} rows, outside 100..4000`;
  const slugs = new Set(board.map((r) => r.slug));
  const missing = snapshot.watchlist.filter((s) => !slugs.has(s));
  if (missing.length > 0) return `the board misses ${missing.length} watchlist slugs: ${missing.slice(0, 5).join(', ')}`;
  const ranks = board.map((r) => r.rank).sort((a, b) => a - b);
  for (let i = 0; i < ranks.length; i++) if (ranks[i] !== i + 1) return `rank ${i + 1} is ${ranks[i]}`;
  for (let i = 1; i < board.length; i++) {
    if (board[i]!.implied_value_usd > board[i - 1]!.implied_value_usd) return `row ${i + 1} outranks row ${i} on implied value`;
  }
  if (board.length >= 2 && board[0]!.implied_value_usd === board[board.length - 1]!.implied_value_usd) {
    return 'every row shares the same implied value: a board that ranks nothing by value is not a ranking';
  }
  for (const r of board) {
    if (!Number.isSafeInteger(r.implied_value_usd) || r.implied_value_usd <= 0) return `${r.slug} has implied value ${r.implied_value_usd}`;
    if (r.farm_steps.length < 3 || r.farm_steps.length > 12) return `${r.slug} has ${r.farm_steps.length} farm steps`;
    for (const s of r.farm_steps) {
      const len = s.trim().length;
      if (len < 20 || len > 600) return `${r.slug} has a farm step of ${len} characters`;
    }
  }
  return null;
}
