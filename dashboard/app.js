// Token Radar — the dashboard. Renders window.RADAR (data.js) and re-runs the
// whole model in the browser to prove the page agrees with the board.
//
// Row layout (window.RADAR.rows), one array per protocol:
//   0 rank, 1 slug, 2 name, 3 category, 4 chain, 5 tvl, 6 change_7d, 7 age_days,
//   8 expected value, 9 value-if-launches, 10 launch odds, 11..14 band p10/p25/p75/p90,
//   15..16 rank range, 17 verdict, 18 slice, 19 cost, 20 net expected,
//   21 break-even odds, 22 net/hour, 23 on watchlist, 24 farm steps (at $1,000).
'use strict';
const R = window.RADAR;
const CARD = window.MODEL_CARD || null;
const $ = (id) => document.getElementById(id);
const GAS = { Ethereum: 8, Solana: 0.05, Base: 0.5, Arbitrum: 0.5, Optimism: 0.5, BSC: 0.3, Polygon: 0.1, Avalanche: 0.5, Sui: 0.1, Aptos: 0.1 };
const TXNS = 8, MISC = 5, HOURS = 2.25, SHARE = 0.05, FARM_NET = 10;

const money = (n) => {
  if (n == null || !isFinite(n)) return '—';
  if (n >= 1e9) return '$' + (n / 1e9).toFixed(2) + 'B';
  if (n >= 1e6) return '$' + (n / 1e6).toFixed(1) + 'M';
  if (n >= 1e3) return '$' + (n / 1e3).toFixed(1) + 'K';
  if (n >= 100) return '$' + Math.round(n);
  if (n >= 1) return '$' + n.toFixed(0);
  return '$' + n.toFixed(2);
};
const pct = (n, d) => (n == null ? '—' : (n >= 0 ? '+' : '') + (n * 100).toFixed(d == null ? 1 : d) + '%');
const growthOf = (chg) => Math.min(100, Math.max(-50, chg == null ? 0 : chg)) / 100;
const ageText = (a) => (a == null ? 'unknown' : a < 30 ? a + 'd' : a < 365 ? Math.round(a / 30) + 'mo' : (a / 365).toFixed(1) + 'y');
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

let ticket = 1000;
let sortKey = 'rank';

/** One row's farm economics at the current ticket. The slice scales with the
 *  ticket; the costs do not. Mirrors the model's economicsFor. */
function econ(row, t) {
  const slice = (t / row[5]) * SHARE * row[9];
  const expected = slice * row[10];
  const cost = TXNS * (GAS[row[4]] ?? 2) + MISC;
  const net = expected - cost;
  const be = slice > 0 ? cost / slice : null;
  return { slice, expected, cost, net, be, hour: net / HOURS, verdict: net > FARM_NET ? 'FARM' : net > 0 ? 'THIN' : 'SKIP' };
}

function depositAction(row, t) {
  const c = (row[3] || '').toLowerCase(), n = row[2], ch = row[4] || 'its main chain';
  if (c.includes('lend') || c.includes('cdp') || c.includes('collateral')) return `Lend $${t} of USDC into ${n} on ${ch} and leave the position open.`;
  if (c.includes('dex') || c.includes('yield') || c.includes('leveraged farm')) return `Add $${t} of liquidity to ${n}'s largest pool on ${ch} and leave the position open.`;
  if (c.includes('perpetual') || c.includes('derivative') || c.includes('option')) return `Post $${t} of USDC as margin on ${n} and open one small hedged position.`;
  if (c.includes('rwa')) return `Mint $${t} of ${n}'s yield-bearing asset on ${ch} and hold it.`;
  if (c.includes('prediction')) return `Fund $${t} and take one position in a ${n} market.`;
  if (c.includes('curator') || c.includes('allocator') || c.includes('asset management')) return `Deposit $${t} into a ${n} vault on ${ch} and keep the shares.`;
  if (c.includes('stable')) return `Mint or deposit $${t} of the stable asset through ${n} on ${ch}.`;
  if (c.includes('insurance')) return `Buy $${t} of cover from ${n} on ${ch} and keep the policy.`;
  return `Deposit $${t} of USDC into ${n} on ${ch} and leave the position open.`;
}

function stepsFor(row, t) {
  const e = econ(row, t), ch = row[4] || 'its main chain', gas = GAS[row[4]] ?? 2;
  const age = row[7] == null ? 'an unreported length of time' : row[7] < 30 ? 'under a month' : Math.round(row[7] / 30) + ' months';
  const be = e.be == null || e.be > 1 ? 'over 100% (it never pays off)' : Math.round(e.be * 100) + '%';
  const reason = e.verdict === 'FARM' ? 'the expected slice clears the costs several times over'
    : e.verdict === 'THIN' ? 'the expected slice clears the costs but leaves little margin'
    : 'the expected slice does not cover the costs at this ticket size';
  return [
    `Open a fresh wallet that holds only the $${t} you plan to farm with, and keep its seed phrase offline where nobody else can read it. Cost: under $3 of gas for the first transaction. Time: 5 minutes.`,
    `${depositAction(row, t)} At ${money(row[5])} of TVL, that is about a ${money(e.slice)} share of a 5% farmer airdrop if ${row[2]} launches. Cost: about $${gas} of gas. Time: 15 minutes.`,
    `Make one qualifying action each week for 6 weeks, a deposit, a swap, a vote or a borrow, so the position is counted in more than one snapshot. Cost: about $${gas} of gas a week. Time: 10 minutes a week.`,
    `Hold the position at least 45 days. ${row[2]} has run ${age} with no token, so snapshots reward patience over a quick in-and-out. Cost: the $${t} stays in the position. Time: 45 days.`,
    `The economics at a $${t} ticket: about ${money(e.slice)} if it launches, ${money(e.expected)} expected, $${Math.round(e.cost)} of costs, break-even odds ${be}. Verdict: ${e.verdict} — ${reason}. Cost: nothing to decide. Time: 5 minutes.`,
    `Before you withdraw, open ${row[2]}'s own points or rewards page from the link it publishes and claim only there, then log the wallet, the dates and every transaction. Cost: no fee to check, and never pay to claim. Time: 10 minutes.`,
  ];
}

function filtered() {
  const q = $('q').value.trim().toLowerCase();
  const cat = $('fcat').value, ch = $('fchain').value, vd = $('fverdict').value, wl = $('fwatch').checked;
  let rows = R.rows.filter((r) => {
    if (q && !(r[2].toLowerCase().includes(q) || r[1].includes(q) || (r[3] || '').toLowerCase().includes(q))) return false;
    if (cat && r[3] !== cat) return false;
    if (ch && r[4] !== ch) return false;
    if (vd && econ(r, ticket).verdict !== vd) return false;
    if (wl && !r[23]) return false;
    return true;
  });
  const by = {
    rank: (a, b) => a[0] - b[0],
    tvl: (a, b) => b[5] - a[5],
    growth: (a, b) => (b[6] ?? -1e9) - (a[6] ?? -1e9),
    age: (a, b) => (b[7] ?? -1) - (a[7] ?? -1),
    net: (a, b) => econ(b, ticket).hour - econ(a, ticket).hour,
    name: (a, b) => a[2] < b[2] ? -1 : 1,
  }[sortKey];
  return rows.sort(by);
}

function renderBoard() {
  const rows = filtered();
  $('count').textContent = `Showing ${rows.length} of ${R.rows.length} ranked protocols · ticket $${ticket.toLocaleString()} · expected value = value-if-launches × launch odds`;
  $('rows').innerHTML = rows.map((r) => {
    const e = econ(r, ticket);
    const g = r[6];
    return `<tr data-slug="${esc(r[1])}"><td class="rank num">${r[0]}<small>${r[15]}–${r[16]}</small></td>` +
      `<td><span class="name">${esc(r[2])}<small>${esc(r[3] || 'Uncategorised')}${r[23] ? ' · <span class="wl">WATCHLIST</span>' : ''}</small></span></td>` +
      `<td class="num">${money(r[5])}</td>` +
      `<td class="num ${g == null ? '' : g >= 0 ? 'up' : 'down'}">${g == null ? '—' : pct(g / 100)}</td>` +
      `<td class="num">${ageText(r[7])}</td>` +
      `<td class="num"><b>${money(r[8])}</b></td>` +
      `<td class="num">${money(r[12])}–${money(r[13])}</td>` +
      `<td class="num">${(r[10] * 100).toFixed(0)}%</td>` +
      `<td><span class="v ${e.verdict}">${e.verdict}</span></td>` +
      `<td class="num ${e.hour >= 0 ? 'up' : 'down'}">${e.hour >= 0 ? '+' : ''}$${e.hour.toFixed(2)}</td></tr>`;
  }).join('');
}

function renderKpis() {
  const v = R.val, k = R.kpi;
  const tiles = [
    [String(k.ranked), 'protocols ranked'],
    [money(k.totalEv), 'total expected value'],
    [v.wf.toFixed(2) + '×', `walk-forward miss (flat ${v.wfFlat.toFixed(2)}×)`],
    [v.loo.toFixed(2) + '×', `leave-one-out miss (flat ${v.looFlat.toFixed(2)}×)`],
    [Math.round(v.band2575 * 100) + '% / ' + Math.round(v.band1090 * 100) + '%', 'band holds P25–P75 / P10–P90'],
    [`${k.farm} FARM · ${k.thin} THIN`, `${k.skip} SKIP at a $${ticket.toLocaleString()} ticket`],
  ];
  $('kpis').innerHTML = tiles.map(([b, s]) => `<div class="kpi"><b>${esc(b)}</b><span>${esc(s)}</span></div>`).join('');
}

function renderModel() {
  const f = R.fit, v = R.val;
  $('formula').textContent = `log(market cap) = ${f.beta[0].toFixed(3)} + ${f.beta[1].toFixed(3)} × log(TVL) + ${f.beta[2].toFixed(3)} × 7-day growth — Huber-robust, fitted on ${f.comps} traded comps. Expected value = value-if-launches × launch odds.`;
  $('valtable').innerHTML = '<tr><th>Test</th><th>This model</th><th>Flat multiple</th></tr>' +
    `<tr><td>Leave-one-out median miss</td><td><b>${v.loo.toFixed(2)}×</b></td><td>${v.looFlat.toFixed(2)}×</td></tr>` +
    `<tr><td>Walk-forward, 5 origins (${v.wfN} newer comps)</td><td><b>${v.wf.toFixed(2)}×</b></td><td>${v.wfFlat.toFixed(2)}×</td></tr>` +
    `<tr><td>Walk-forward, size only (no growth term)</td><td>${v.wfSize.toFixed(2)}×</td><td>—</td></tr>` +
    `<tr><td>Walk-forward with an age term added</td><td>${v.wfAge.toFixed(2)}× — dropped</td><td>—</td></tr>` +
    `<tr><td>Launch-odds accuracy (5-fold)</td><td><b>${(v.oddsAcc * 100).toFixed(0)}%</b></td><td>${(v.oddsBase * 100).toFixed(0)}% base rate</td></tr>`;
  $('ablation').innerHTML = '<tr><th>Variant</th><th>Median miss</th></tr>' +
    v.ablation.map(([label, m]) => `<tr><td>${esc(label)}</td><td>${m.toFixed(2)}×</td></tr>`).join('');
  $('abnote').textContent = 'The held-out tests cannot separate size-only from size+growth: the gaps are inside one standard error of the median. Growth stays because the criterion names it and its fitted sign matches the economics — fast-growing TVL reprices upward.';
  $('bandnote').textContent = `Bands come from 200 bootstrap refits, each prediction carrying a resampled residual. On the traded comps the P25–P75 band holds ${Math.round(v.band2575 * 100)}% of actual market caps and the P10–P90 band ${Math.round(v.band1090 * 100)}%. Rank ranges come from the refitted curves alone (${R.kpi.top20Stable} of the top 20 stay top 20 in at least 80% of refits).`;
  $('oddsnote').textContent = 'Launch odds are the share of look-alike protocols (same age band, same TVL tercile) that still record no token. Older protocols score lower: most of their look-alikes already launched. A discount, not a forecast — this entry never predicts whether or when a token is issued.';
  $('ledger').innerHTML = '<tr><th>Bucket</th><th>Count</th><th>Why</th></tr>' +
    R.ledger.map(([label, n, note]) => `<tr><td><b>${esc(label)}</b></td><td class="num">${n}</td><td>${esc(note)}</td></tr>`).join('');
  $('asof').textContent = `Snapshot ${R.asOf} · floor $${(R.floor / 1e6).toFixed(0)}M · model ${R.model}`;
  $('footdate').textContent = R.asOf;
}

// --- Scatter: traded comps, the fitted curve with its band, the board ---
function renderScatter() {
  const W = 560, H = 310, L = 54, Rr = 12, T = 12, B = 36;
  const beta = R.fit.beta;
  const pts = R.comps.map((c) => ({ x: Math.log(c[0]), y: Math.log(c[1]), board: false }));
  R.rows.forEach((r) => pts.push({ x: Math.log(r[5]), y: Math.log(r[8]), board: true }));
  let x0 = 1e9, x1 = -1e9, y0 = 1e9, y1 = -1e9;
  pts.forEach((p) => { x0 = Math.min(x0, p.x); x1 = Math.max(x1, p.x); y0 = Math.min(y0, p.y); y1 = Math.max(y1, p.y); });
  x0 -= 0.4; x1 += 0.4; y0 -= 0.5; y1 += 0.5;
  const X = (v) => L + ((v - x0) / (x1 - x0)) * (W - L - Rr);
  const Y = (v) => T + (1 - (v - y0) / (y1 - y0)) * (H - T - B);
  const resid = [...R.resid].sort((a, b) => a - b);
  const q = (p) => { const at = p * (resid.length - 1), lo = Math.floor(at), hi = Math.min(resid.length - 1, lo + 1); return resid[lo] * (1 - (at - lo)) + resid[hi] * (at - lo); };
  const curve = (tvl) => beta[0] + beta[1] * Math.log(tvl) + beta[2] * 0;
  let grid = '', bandTop = '', bandBot = '', line = '';
  for (let e = 5; e <= 11; e++) {
    const v = Math.log(10 ** e);
    if (v > x0 && v < x1) grid += `<line x1="${X(v)}" y1="${T}" x2="${X(v)}" y2="${H - B}" stroke="#1d2a3a"/><text x="${X(v)}" y="${H - 12}" fill="#93a3b5" font-size="10" text-anchor="middle">$${e >= 9 ? (10 ** (e - 9)) + 'B' : (10 ** (e - 6)) + 'M'}</text>`;
    if (v > y0 && v < y1) grid += `<line x1="${L}" y1="${Y(v)}" x2="${W - Rr}" y2="${Y(v)}" stroke="#1d2a3a"/><text x="${L - 6}" y="${Y(v) + 3}" fill="#93a3b5" font-size="10" text-anchor="end">$${e >= 9 ? (10 ** (e - 9)) + 'B' : (10 ** (e - 6)) + 'M'}</text>`;
  }
  const N = 40;
  for (let i = 0; i <= N; i++) {
    const tvl = Math.exp(x0 + ((x1 - x0) * i) / N);
    const y = curve(tvl);
    line += (i ? 'L' : 'M') + X(Math.log(tvl)).toFixed(1) + ' ' + Y(y).toFixed(1);
    bandTop += (i ? 'L' : 'M') + X(Math.log(tvl)).toFixed(1) + ' ' + Y(y + q(0.75)).toFixed(1);
    bandBot = 'L' + X(Math.log(tvl)).toFixed(1) + ' ' + Y(y + q(0.25)).toFixed(1) + bandBot;
  }
  const dots = pts.map((p) => `<circle cx="${X(p.x).toFixed(1)}" cy="${Y(p.y).toFixed(1)}" r="${p.board ? 2.6 : 2.2}" fill="${p.board ? '#6aa9e8' : '#7a8a9c'}" opacity="${p.board ? 0.9 : 0.6}"/>`).join('');
  $('scatter').innerHTML = `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Market cap against TVL, log scales, with the fitted curve">` +
    grid +
    `<path d="${bandTop} ${bandBot} Z" fill="#35d0a5" opacity="0.14"/>` +
    `<path d="${line}" fill="none" stroke="#35d0a5" stroke-width="2"/>` + dots +
    `<text x="12" y="${T + 8}" fill="#93a3b5" font-size="11">Value (log scale)</text>` +
    `<text x="${W - Rr}" y="${T + 8}" fill="#7a8a9c" font-size="11" text-anchor="end">grey: traded comps</text>` +
    `<text x="${W - Rr}" y="${T + 22}" fill="#6aa9e8" font-size="11" text-anchor="end">blue: board, expected value</text></svg>`;
}

// --- Detail modal ---
function openDetail(slug) {
  const row = R.rows.find((r) => r[1] === slug);
  if (!row) return;
  const e = econ(row, ticket);
  $('dname').textContent = row[2];
  $('dsub').textContent = `#${row[0]} · ${row[3] || 'Uncategorised'} · ${row[4] || '—'}${row[23] ? ' · on the watchlist' : ''}`;
  const facts = [
    ['Expected value', money(row[8])], ['Value if it launches', money(row[9])], ['Launch odds', (row[10] * 100).toFixed(0) + '%'],
    ['P25–P75 band', money(row[12]) + ' – ' + money(row[13])], ['P10–P90 band', money(row[11]) + ' – ' + money(row[14])], ['Rank range', row[15] + '–' + row[16]],
    ['TVL', money(row[5])], ['7-day growth', row[6] == null ? '—' : pct(row[6] / 100)], ['Age', ageText(row[7])],
    ['Verdict', e.verdict], ['Slice if it launches', money(e.slice)], ['Expected slice', money(e.expected)],
    ['Costs', '$' + Math.round(e.cost)], ['Break-even odds', e.be == null || e.be > 1 ? 'over 100%' : Math.round(e.be * 100) + '%'], ['Net / hour', (e.hour >= 0 ? '+' : '') + '$' + e.hour.toFixed(2)],
  ];
  $('dfacts').innerHTML = facts.map(([k, v]) => `<div><dt>${k}</dt><dd>${esc(v)}</dd></div>`).join('');
  $('dsteps').innerHTML = stepsFor(row, ticket).map((s) => `<li>${esc(s)}</li>`).join('');
  $('dnote').textContent = `Farm plan at a $${ticket.toLocaleString()} ticket. Expected value is this entry's own claim: the fitted curve's value-if-launches times the launch odds.`;
  $('modal').hidden = false;
}
function closeDetail() { $('modal').hidden = true; }

// --- Re-run: refit the curve, redo the 200 bootstrap refits, recompute every
// row's value, bands and verdict, and check them against the board. The code
// mirrors the model's fit and bootstrap draw-for-draw (same seed, same order),
// so a match means the page and the board are the same computation. ---
function median(a) { const s = [...a].sort((x, y) => x - y); return s[Math.floor(s.length / 2)]; }
function solveLin(Ain, bin) {
  const n = bin.length, m = Ain.map((row, i) => [...row, bin[i]]);
  for (let col = 0; col < n; col++) {
    let piv = col;
    for (let r = col + 1; r < n; r++) if (Math.abs(m[r][col]) > Math.abs(m[piv][col])) piv = r;
    [m[col], m[piv]] = [m[piv], m[col]];
    const d = m[col][col];
    if (Math.abs(d) < 1e-12) return null;
    for (let r = 0; r < n; r++) {
      if (r === col) continue;
      const f = m[r][col] / d;
      for (let k = col; k <= n; k++) m[r][k] -= f * m[col][k];
    }
  }
  return m.map((row, i) => row[n] / row[i]);
}
function leastSq(X, y, w) {
  const k = X[0].length, A = Array.from({ length: k }, () => new Array(k).fill(0)), b = new Array(k).fill(0);
  for (let i = 0; i < X.length; i++) {
    const wi = w == null ? 1 : w[i];
    for (let r = 0; r < k; r++) {
      b[r] += wi * X[i][r] * y[i];
      for (let c = 0; c < k; c++) A[r][c] += wi * X[i][r] * X[i][c];
    }
  }
  for (let r = 1; r < k; r++) A[r][r] += 1e-6;
  return solveLin(A, b);
}
function fitHuber(rows) {
  const X = rows.map((c) => [1, Math.log(c[0]), growthOf(c[2])]);
  const y = rows.map((c) => Math.log(c[1]));
  let beta = leastSq(X, y, null);
  for (let pass = 0; pass < 3; pass++) {
    const resid = X.map((row, i) => y[i] - row.reduce((s, v, j) => s + v * beta[j], 0));
    const scale = 1.4826 * median(resid.map(Math.abs)) || 1e-9;
    const k = 1.345 * scale;
    beta = leastSq(X, y, resid.map((r) => Math.min(1, k / Math.max(Math.abs(r), 1e-9))));
  }
  return beta;
}
function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function quantile(sorted, p) {
  const at = p * (sorted.length - 1), lo = Math.floor(at), hi = Math.min(sorted.length - 1, lo + 1);
  return sorted[lo] * (1 - (at - lo)) + sorted[hi] * (at - lo);
}
function oddsOf(row) {
  const a = row[7] == null ? 'unk' : row[7] < 365 ? '<1y' : row[7] < 730 ? '1-2y' : '2y+';
  const s = row[5] < R.odds.terciles[0] ? 'S' : row[5] < R.odds.terciles[1] ? 'M' : 'L';
  const b = R.odds.buckets[a + '/' + s];
  if (!b) return 1 - R.odds.base;
  return 1 - (b[1] + 5 * R.odds.base) / (b[0] + 5);
}
function rerun() {
  const el = $('rerun');
  try {
    const comps = R.comps, n = comps.length, rows = R.rows;
    const beta = fitHuber(comps);
    const curve = (tvl, g) => Math.exp(beta[0] + beta[1] * Math.log(tvl) + beta[2] * g);
    const odds = rows.map(oddsOf);
    const evs = rows.map((r, i) => Math.max(1, Math.round(curve(r[5], growthOf(r[6])) * odds[i])));
    const order = evs.map((_, i) => i).sort((a, b) => evs[b] - evs[a] || (rows[a][1] < rows[b][1] ? -1 : 1));
    const rankOf = new Array(rows.length);
    order.forEach((idx, pos) => { rankOf[idx] = pos + 1; });
    const rng = mulberry32(20261114), pool = R.resid, preds = rows.map(() => []), param = rows.map(() => []);
    for (let b = 0; b < 200; b++) {
      const sample = [];
      for (let i = 0; i < n; i++) sample.push(comps[Math.floor(rng() * n)]);
      const bb = fitHuber(sample);
      rows.forEach((r, i) => {
        const resid = pool[Math.floor(rng() * pool.length)];
        const base = Math.exp(bb[0] + bb[1] * Math.log(r[5]) + bb[2] * growthOf(r[6])) * odds[i];
        param[i].push(base);
        preds[i].push(base * Math.exp(resid));
      });
    }
    // Rank ranges come from the refitted curves alone (param), value bands
    // from the residual-inclusive predictions (preds) — as the model does.
    const rankLo = [], rankHi = [];
    for (let b = 0; b < 200; b++) {
      const order = rows.map((_, i) => i).sort((a, c) => param[c][b] - param[a][b] || a - c);
      order.forEach((idx, pos) => { (rankLo[idx] = rankLo[idx] || []).push(pos + 1); });
    }
    rows.forEach((r, i) => {
      const s = [...rankLo[i]].sort((a, b) => a - b);
      rankHi[i] = [Math.round(quantile(s, 0.1)), Math.round(quantile(s, 0.9))];
    });
    let rankOk = 0, valueOk = 0, bandOk = 0, verdictOk = 0;
    rows.forEach((r, i) => {
      if (rankOf[i] === r[0]) rankOk++;
      if (evs[i] === r[8]) valueOk++;
      const s = [...preds[i]].sort((a, b) => a - b);
      if (Math.max(1, Math.round(quantile(s, 0.25))) === r[12] && Math.max(1, Math.round(quantile(s, 0.75))) === r[13] && rankHi[i][0] === r[15] && rankHi[i][1] === r[16]) bandOk++;
      if (econ(r, 1000).verdict === r[17]) verdictOk++;
    });
    const total = rows.length;
    const all = rankOk === total && valueOk === total && bandOk === total && verdictOk === total;
    el.textContent = all
      ? `board.json = this page: ${total}/${total} ranks, values, bands, verdicts match (re-run here)`
      : `re-run differs: ranks ${rankOk}/${total}, values ${valueOk}/${total}, bands ${bandOk}/${total}, verdicts ${verdictOk}/${total}`;
    el.classList.toggle('bad', !all);
  } catch (err) {
    el.textContent = 'Re-run check failed: ' + err.message;
    el.classList.add('bad');
  }
}

// --- Init ---
function init() {
  const cats = [...new Set(R.rows.map((r) => r[3]).filter(Boolean))].sort();
  const chains = [...new Set(R.rows.map((r) => r[4]).filter(Boolean))].sort();
  $('fcat').innerHTML = '<option value="">All categories</option>' + cats.map((c) => `<option>${esc(c)}</option>`).join('');
  $('fchain').innerHTML = '<option value="">All chains</option>' + chains.map((c) => `<option>${esc(c)}</option>`).join('');
  renderKpis(); renderModel(); renderScatter(); renderBoard();
  $('q').addEventListener('input', renderBoard);
  $('fcat').addEventListener('change', renderBoard);
  $('fchain').addEventListener('change', renderBoard);
  $('fverdict').addEventListener('change', renderBoard);
  $('fwatch').addEventListener('change', renderBoard);
  $('fsort').addEventListener('change', () => { sortKey = $('fsort').value; renderBoard(); });
  document.querySelectorAll('.ticket').forEach((btn) => btn.addEventListener('click', () => {
    document.querySelectorAll('.ticket').forEach((b) => b.classList.remove('on'));
    btn.classList.add('on');
    ticket = Number(btn.dataset.ticket);
    renderKpis(); renderBoard();
  }));
  $('rows').addEventListener('click', (e) => {
    const tr = e.target.closest('tr[data-slug]');
    if (tr) openDetail(tr.dataset.slug);
  });
  $('mclose').addEventListener('click', closeDetail);
  $('modal').addEventListener('click', (e) => { if (e.target === $('modal')) closeDetail(); });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeDetail(); });
  const params = new URLSearchParams(location.search);
  if (params.get('verdict')) { $('fverdict').value = params.get('verdict'); renderBoard(); }
  if (params.get('detail')) openDetail(params.get('detail'));
  // Staging for the model-panel screenshot: hide the long board so the panel
  // sits at the top of the page with no scrolling (headless screenshots of a
  // scrolled page come out blank in this environment).
  if (params.get('view') === 'model') {
    document.querySelector('.tablewrap').style.display = 'none';
    $('count').style.display = 'none';
    document.querySelector('.controls').style.display = 'none';
  }
  setTimeout(rerun, 60);
}
init();
