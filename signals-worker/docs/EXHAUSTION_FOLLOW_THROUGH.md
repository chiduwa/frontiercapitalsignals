# Exhaustion alerts: which coins keep rising, how far, how long (2026-10-14)

Asked: for the volume-exhaustion alerts, find "if" statements. For example: if volume keeps
rising or stays high after the alert, does the coin keep going up instead of dropping? Use
the other variables too, including the share of accounts long and short and where positions
cluster, to see why some coins keep rising, by how much and for how long. Every alert
seems to drop in the end; some just take days.

**Deployed 2026-10-14: a +1h follow-up push (below). Everything else is research.** Scripts and outputs: `docs/research-2026-10-14-exhaustion-followthrough/`.
Raw data (gitignored, ~1.2 GB): `reports/scenarios/2026-10-14-followthrough/raw/`.

## Short answer

- **The hypothesis is false, and both periods agree on it.** Coins whose volume stays high
  or keeps rising after the alert, with price holding at or above the alert close, fall
  *more* over the next 3-7 days, not less. They also squeeze harder first. High volume after
  the alert means a fast, violent resolution. It does not mean continuation.
- **No variable here forecasts direction**: volume, price action, re-alerts, funding, premium,
  open interest, the long/short account ratio, or the estimated position and liquidation map.
  A model with all 52 of them scores out-of-sample AUC 0.51-0.56, and its "most likely to keep
  rising" tenth does not have better 3-day returns. Several variables do forecast the **size**
  of the next swing, and how **soon** it comes.
- **"They all drop eventually" is true of any hour on these coins.** 98-99% of ordinary hours
  also see a lower close within 30 days. What the alert changes is size: the next two weeks
  are far more volatile in both directions, and lower on balance.
- **Squeeze price levels from the position map do not work.** Price is not drawn to the
  estimated short-liquidation bands, and squeezes do not stop at them. The one small,
  consistent effect: once price reaches a dense 10x band, it is a few points more likely to
  push 3% through it.
- **The practical result:** one hour after the alert, if volume is still at least 20x its
  pre-alert baseline and price is at or above the alert close (about 1 alert in 4), the 24-hour
  high reaches +8.7% above that price 45-49% of the time (a 10x short's liquidation distance).
  Yet the 3-day median is -7% to -9%. The strongest fade and the largest squeeze risk come
  together.

## Data and method

- **Alerts.** Every Binance USDT spot pair, **delisted pairs included** (693 pairs, 197 since
  delisted). An alert list built from coins still trading today is conditioned on survival:
  about half the 2023 alerts were on coins Binance has since delisted. Detection is the
  production replica from the 2026-10-12 squeeze study (`exhaustion20` or
  `exhaustion_calibrated` with volZ ≥ 4). It matches the live pushes for RED, CTK and GTC on
  2026-10-12 exactly. The calibrated rule's $500M market-cap ceiling is not replicated.
  Result: 17,870 pushed up-alerts on 589 coins, 2023-01 to 2026-10.
- **Unit.** Episode-first alerts (no pushed alert on the coin in the prior 72h). A run that
  alerts five times counts once; later prints are a state variable.
- **Periods.** Discovery 2025-01 to 2026-10 (4,971 first alerts); validation 2023-01 to
  2024-12 (5,169), untouched by every choice made here. Quintile cut-offs are set on discovery
  and applied unchanged to validation. A rule is reported only when both periods agree in sign
  with |t| ≥ 2, clustered by alert day.
- **Checkpoints.** 1, 2, 4, 8, 12, 24, 48 and 72 hours after the alert close. State uses
  only bars up to the checkpoint; outcomes run forward from the checkpoint price. Horizons
  are by timestamp on an hourly grid, never by row. A coin delisted inside a window exits at
  its last close.
- **Market.** The same-window market is the median coin's log return over exactly the alert's
  window. Summing hourly medians was tried first and dropped: hourly returns are right-skewed,
  so that index drifts down over days and flatters the coins.
- **Control.** 35,740 ordinary hours on the same coins, nowhere near a print (72h before to
  14 days after).
- **Futures.** 10,998 alerts had a USDT-M perp. From Binance's public archive: funding,
  1h premium index, 1h perp volume, and 5-minute metrics (OI, OI value, all-account and
  top-trader long/short ratios, taker buy/sell ratio).

## A. What happens after an alert (episode-first; 2025-26 / 2023-24)

| from the alert close | 1d | 3d | 7d | 14d | 30d |
|---|---|---|---|---|---|
| median return | -5.2% / -4.4% | -6.6% / -5.2% | -8.4% / -5.0% | -10.8% / -5.9% | -15.8% / -7.0% |
| share below the alert close | 74% / 74% | 74% / 72% | 74% / 66% | 73% / 63% | 74% / 61% |
| vs same-window market (mean log, t) | -0.037 (-15.5) / -0.030 (-17.4) | -0.048 / -0.037 | -0.061 / -0.033 | -0.075 (-15.3) / -0.039 (-9.6) | |

The underperformance keeps growing for two weeks. It is not only a one-day fade.

| within 14 days | alerts | ordinary hours, same coins |
|---|---|---|
| peak ≥ +20% above the start | 36% / 38% | 26% / 31% |
| peak ≥ +50% | 13% / 14% | 6% / 6% |
| peak ≥ +100% | 5% / 5% | 2% / 1% |
| the 14-day high came within the first hour | 26% / 20% | 4% / 3% |
| low ≤ -20% | 46% / 35% | 30% / 23% |
| close below the start within 30 days | 98% / 98% | 99% / 98% |

The alert hour is often close to a short-term top, but the tails are fat on both sides.

**Runners** (first alerts that went ≥ +50% above the alert close within 30 days): 18% / 24%.
For ordinary hours on the same coins the figure is 15% / 18%, so most of "some keep rising
for days" is these coins' normal volatility. The alert adds a few points.

| 30-day outcome | share | median peak | days to peak (median, p25-p75) | after the peak |
|---|---|---|---|---|
| runner ≥ +50% | 18% / 24% | +83% / +83% | 10.5 (2.4-21) / 17.3 (7.5-25) | gives back ~half from the high; 60% / 44% close below the alert close within 30 days of the peak |
| +20% to +50% | 26% / 27% | +31% / +32% | 6.9 / 12.9 | 92% / 84% back below the alert close, median 2-3 days after the peak |
| fade (< +20%) | 56% / 48% | +8% / +8% | 0.3 / 0.7 | |

A second exhaustion print is not a top signal. On runners, 57-64% of later prints came more
than 6 hours *before* the eventual peak, and only 21-24% within 6 hours of it.

## B. The "if" tests at checkpoints

Hypothesis rules at +4h. HOT = last 3 hours' volume ≥ 10x the pre-alert 48h baseline;
RISING = second-half volume ≥ first-half; HOLD = price at or above the alert close.

| at +4h (2025-26 / 2023-24) | share | next 3d median | below that price 7d later | further peak ≥ +50% | hours to the further peak |
|---|---|---|---|---|---|
| all first alerts | 100% | -4.1% / -3.1% | 69% / 60% | 12% / 14% | 46 / 84 |
| HOT + HOLD (the hypothesis) | 23% / 23% | **-7.8% / -7.0%** | 74% / 70% | 18% / 16% | 17 / 23 |
| HOT + RISING + HOLD | 7% / 8% | -8.6% / -8.8% | 74% / 67% | 17% / 18% | 15 / 24 |
| QUIET (volume < 3x baseline) | 7% / 7% | -1.7% / 0.0% | 64% / 46% | 10% / 13% | 86 / 158 |

The same pattern holds at every checkpoint from +2h to +48h. Against the rest of the
alerts at the same checkpoint, HOT+HOLD is -3.1% to -5.5% vs the market over 3 days (t -3 to
-8), in both periods. Its chance of another +20% before -20% is higher in 2025-26 (+5 to +9
points) but not in 2023-24 (except at +48h), so it is not a reliable squeeze-up signal
either.

Single variables, top fifth minus bottom fifth, both periods significant unless noted:

- **Volume still elevated** (checkpoints 1-24h; weaker at 48-72h): 3-day return vs market
  -4.5 to -6.5% (t -6 to -10). Any further high comes much sooner (at +4h: 14-18h vs 69-123h). The size of
  that high is about the same.
- **Volume rising** within the window (checkpoints 2-24h): -2.5 to -4.5% (t -4 to -7).
- **Re-alerts since the first**: 2+ re-alerts by +4h means -12% / -11% median over 3 days.
- **Run-up above the alert close so far**: -4 to -6.5% over 3 days (checkpoints 1-24h), with
  *larger* further peaks (t +4 to +7). These coins are more volatile, not more bullish.
- **Alert bar size**: bars ≥ +14% fall a median 13.7% / 11.2% over 3 days (bars of +5-7%:
  3.8% / 3.2%), and any further high comes within 4-12 hours.
- **Market rising in the 24h before the alert**: the fade is 2-5 points smaller vs market
  (t 2.4 / 6.9). This is the one context that consistently softens it.

## C. Futures positioning

- **Share of accounts long** (Binance all-account ratio): when fewer accounts are long
  (more short), the further peak is bigger and a +20% leg before -20% is more likely. At
  +24h: long share < 51% gives 39% / 46%, against 32% / 37% when it is > 67%. Peak size
  t -3 to -4 in both periods. The 3-day median is **not** better (slightly worse). Short
  crowding is squeeze fuel, not a direction call. (The 2026-10-12 study found the same ratio
  not significant at 2 hours; over days it matters for size.)
- **Funding / premium**: negative funding (shorts paying) goes with *worse* 3-day returns,
  -5.4% / -4.2% median at +24h for the most negative fifth, vs the market t 2.8-5.7 at +12h and +24h. Shorts
  paying to hold are mostly right over days, even though the 10-12 study found a negative
  premium flags 2-hour squeeze risk.
- **OI growth after the alert**: worse 3-day returns (t -2 to -5) and bigger further swings.
- At the alert itself no futures variable survived both periods.

## D. Where positions cluster, and squeeze price levels

Binance publishes no entry prices or liquidation history for USDT-M (the archive's
`liquidationSnapshot` folder is empty). The host collector (since 2026-10-13) is too new to
test against. The map is therefore estimated the way liquidation "heatmaps" are built
(`clusters.py`):

- Every 5-minute rise in OI over the 48h before the checkpoint is new positions at that
  price (OI value / OI). Falls close positions pro rata.
- Each contract's short side is weighted by the share of accounts short at that moment,
  and the long side likewise.
- Liquidation sits at entry × (1 ± (1/L − 1.3%)). For 10x that is ~8.7%, the distance the
  owner's NEAR and RED liquidations showed. Positions whose level was already crossed are
  removed.

Tests over the next 24 hours (`cluster_tests.py`), with distance fixed effects and controls
for the coin's volatility and total fuel:

| test | result |
|---|---|
| magnet: is a fuel-heavy band reached more often than an equally distant light one? | no at +1h/+4h; +1 point at +12h (t 2.3 / 1.7) |
| cascade: once reached, does price go another 3%? | 10x map at +12h: +2.9 / +4.3 points (t 2.9 / 2.8); raw 74% vs 69%, 71% vs 65%. Not at +1h/+4h |
| top: does the squeeze stop inside the band? | no; slightly *less* often at +12h (t -2.7 / -2.5) |
| does the 24h high land near the densest short band? (shuffle within volatility fifths) | no, in any version (p 0.4-1.0) |
| does the 24h low land near the densest long band? | slightly: median gap 3.3% vs 3.7% shuffled (p < 0.01 both periods, 20x map at +12h). This may simply be the price returning to where the pump started |

Per alert, **more surviving short-liquidation fuel within 15% above the price at +1h means a
lower chance of a new +20% leg** (-9 to -11 points, t -3.5 / -2.0) and smaller peaks. Shorts
still alive near the price are the ones who sold near the top, and they have mostly been
right.

**What does give a calibrated level** is the distribution of how far price actually ran
(`squeeze_levels.py`). From the price one hour after the alert close:

| at +1h: hour-1 volume, price vs alert close | share | 24h high above that price: median / p75 / p90 | reaches +8.7% in 24h | next 3d median |
|---|---|---|---|---|
| ≥ 20x, at or above the alert close | 25% / 22% | 8.4 / 19.0 / 36.8% · 7.3 / 16.9 / 31.1% | **49% / 45%** | **-9.1% / -7.0%** |
| ≥ 20x, below the alert close | 37% / 38% | 4.8 / 11.6 / 24.5% · 5.4 / 11.7 / 23.4% | 33% / 34% | -4.8% / -3.8% |
| 5-20x, below the alert close | 25% / 28% | 4.9 / 10.5 / 20.5% · 4.8 / 9.9 / 21.3% | 32% / 28% | -3.1% / -2.5% |
| all first alerts, from the alert close | | 6.3 / 14.4 / 30.9% · 5.6 / 13.0 / 26.4% | 40% / 37% | -6.6% / -5.2% |

By alert bar size (from the alert close): bars of +5-7% reach +8.7% within 24h 34% / 30% of
the time; bars ≥ +14% do so 52% / 48%. Market direction and the long share at the alert
made no consistent difference to the reach.

## What this means

- **Sustained or rising volume after an alert is a warning of a violent squeeze, then a
  bigger fade.** It is not a sign the coin will keep rising. Read it as "the move resolves
  fast": any further high usually comes within a day.
- **The coins that "take days" are mostly the quiet ones.** Volume dies, price drifts, and
  their late highs are the ordinary extremes of a volatile coin over two weeks.
- **There is no reliable "it keeps going" if-statement in this data.** What exists are
  size-and-timing statements. Hot volume, a big alert bar, re-alerts and short crowding all
  mean bigger swings both ways.
- This is consistent with the 2026-10-12 joint verdict (no trigger or leverage
  prescription). The squeeze table quantifies how often a 10x distance is reached in each
  state; it is not advice on leverage.

## Deployed: the +1h follow-up push (2026-10-14)

`scripts/exhaustion-followup.mjs`, called from `live-scan.mjs` every hourly run; migration
`0063_exhaustion_followup.sql`; tests `test-exhaustion-followup.mjs`.

- **When.** One hour after each pushed exhaustion alert, once the hour after the alert has
  closed (the scan fires a few minutes after the clock hour). It is sent once per coin and
  bar, and only after ntfy accepts it. If the scan reaches it more than 90 minutes after that
  hour closed, it is recorded as `late` and not sent. Alerts pushed in the same run wait for
  the next run.
- **State,** from the bars the scan already holds. Volume in the hour after the alert, divided
  by the alert's own 48h median, gives **hotHeld** (≥ 20x, closed at or above the alert
  close), **hotFaded** (≥ 20x, below) or **cooled** (< 20x).
- **What it quotes** (`followup_evidence.py`, every pushed alert, repeats included), from the
  price at that point:

  | state | share | 24h high reaches +8.7% | 1 in 10 went | 3-day median | below at 3 days |
  |---|---|---|---|---|---|
  | hotHeld | 28% / 25% | 52% / 48% | +45% / +37% | -11.0% / -8.9% | 78% / 76% |
  | hotFaded | 40% / 40% | 42% / 41% | +37% / +30% | -7.0% / -5.6% | 74% / 73% |
  | cooled | 32% / 35% | 37% / 37% | +27% / +28% | -4.6% / -3.1% | 68% / 64% |

- One batched push per run. Priority is high for hotHeld, default for hotFaded and low for
  cooled. Each row stores `followup_state`, `followup_vol1` and `followup_move1_pct`, so the
  live record of each state can be checked against these numbers.
- A test pins `FOLLOWUP_EVIDENCE` to `followup_evidence.json`.

## Caveats

- Highs and lows are Binance **spot** hourly bars, not the perp mark price that liquidations
  use. Mark is smoother, so the "reaches +8.7%" figures lean slightly high for liquidation
  purposes. The 2026-10-12 study's mark-based figure for all alerts was 44% within 24h from
  a futures entry.
- The position map is a model. Its assumptions are pro-rata closing, a uniform 1.3%
  maintenance margin, short side weighted by account share, and 5-minute snapshots that miss
  wicks. A real liquidation tape could change part D; the collector on the host will build one.
- Market caps are not point-in-time, so the calibrated rule's $500M ceiling is not applied.

## Reproduce

In `docs/research-2026-10-14-exhaustion-followthrough/`: `get_spot_1h.py` → `detect.py` →
`paths.py` → `perp.py` → `get_metrics.py` → `clusters.py`, then the analyses `baseline.py`,
`rules.py` (args: sample, checkpoints, variables), `hypothesis.py`, `anatomy.py`,
`model.py`, `cluster_tests.py`, `squeeze_levels.py`. Outputs are saved next to each script
(`*.txt`, `rules_summary_*.csv`).
