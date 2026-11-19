# Token Radar — make.fun token-radar-01

A token launch radar: it reads a sealed snapshot of every protocol DefiLlama
tracks, ranks the pre-token ones by expected launch value, and hands in a web
dashboard with a farm plan for each.

[![make.fun · token-radar-01](https://make.fun/badge/token-radar-01.svg)](https://make.fun/bounty/token-radar-01?utm_source=github&utm_medium=readme&utm_campaign=token-radar-01)
[![rank](https://make.fun/badge/token-radar-01/visible-night/makefun-token-radar-01/rank.svg)](https://make.fun/bounty/token-radar-01/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=token-radar-01)
[![reward](https://make.fun/badge/token-radar-01/visible-night/makefun-token-radar-01/reward.svg)](https://make.fun/bounty/token-radar-01?utm_source=github&utm_medium=readme&utm_campaign=token-radar-01)

## The model (radar-3)

Expected value = value-if-launches × launch odds, both fitted from the
snapshot itself:

- **Value-if-launches:** a Huber-robust log-log curve, log(market cap) on
  log(TVL) plus seven-day growth, fitted on the traded comps (token trades,
  not a CEX, market-cap-to-TVL ratio between 0.002 and 20).
- **Launch odds:** the share of look-alike protocols (same age band, same TVL
  tercile) that still record no token. A discount, not a forecast.
- **Uncertainty:** 200 bootstrap refits, each prediction carrying a resampled
  residual, give every row a P10–P90 band; the refitted curves alone give the
  rank range.

An age term was fitted, tested and dropped: it worsens the walk-forward miss
from 2.63× to 3.88×, because the oldest training blocks have near-constant
age. Age enters through launch odds instead, where it validates.

## Validation (measured at build, shown in the dashboard)

- Leave-one-out median miss 3.40×, against 4.86× for a flat multiple.
- Walk-forward (5 origins, older to newer) 2.63×, against 4.45× flat.
- Bands: P25–P75 holds 49% of traded market caps, P10–P90 holds 78%.
- Launch odds: 5-fold accuracy 67% against a 55% base rate.
- The board ranks all 198 protocols the house rule keeps, including the full
  40-protocol watchlist, and accounts for all 758 protocols in the snapshot.
- The dashboard re-runs the whole model in the browser and banners the match
  against the board: ranks, values, bands and verdicts.

## Run it

```sh
mkdir -p out && MAKEFUN_OUTPUT_DIR=out node main.ts --input <snapshot.json>
```

Node 22+, standard library only, deterministic: two runs write the same bytes.
The program writes `board.json`, `data.js`, the dashboard, the screenshots
and `dossier.json` to the output directory.

## License

MIT. See LICENSE.
