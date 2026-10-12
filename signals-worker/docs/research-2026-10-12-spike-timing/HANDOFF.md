# Spike timing: right direction, liquidated first (NEAR 10-11, RED 10-12)

Handoff from the Copilot agent to Claude (Fable) and ChatGPT (Astra). **Nothing is deployed and no code changed.** Combine findings before any release.

## Limits of this pass
The sandbox cannot reach Binance (`fapi` HTTP 451/blocked, `data-api` no response) and has no D1 credentials. I could not pull NEAR or RED 1m/5m bars, OI or liquidation prints for 10-11/10-12. Everything below comes from the repo's own prior evidence plus mechanism reasoning. **The first job for whoever has data access is to replay the two episodes (section 4).**

## What the existing evidence already says
1. **The exhaustion print is a 24h signal, not an entry-timing signal.** `exhaustion-gauge.mjs` `EXHAUSTION_EVIDENCE.byCase`: after a print, price *pokes higher* before the fade in 63-80% of cases, with a median poke of +5.4% to +8.3% (mid-cap, both rules: 67%, median +8.3%). Shorting at the print therefore sits through a +8% median adverse move. A +15% spike in 15 min (RED) is the tail of that distribution, and with leverage over ~6x, liquidation is inside the typical poke. The fade (-4 to -7% excess over 24h) is real but arrives after the poke.
2. **Later prints in a run are riskier.** `byRunPosition`: 5th+ print has median -11.4% but rip share 12.2% vs 4.9% on the first. If RED had printed repeatedly, the later short was the dangerous one.
3. **Rips are only weakly predictable from volume/size** (validation AUC 0.62; turnover widens both tails). Volume alone will not tell you the spike is coming.
4. **OI as currently measured cannot answer the question.** `docs/OI_MEASUREMENT_EVIDENCE.md` and the header of `flush-entry.mjs`: the `sum_open_interest_value` column is contracts x price (r = 0.91 with the bar's price move). The flush 2x2 (OI fell/rose x dip/spike) that would classify "squeeze vs. real top" is **unproven on contracts** (separation +6.1 / -4.9 points, t about 1.3). Any OI-based timing rule must use contract-denominated OI.
5. **Liquidation data is not usable for timing today.** `market-explanations.mjs` only has CMC rolling-hour aggregates (no timestamps inside the hour, no price level). Clustering "around resistance" cannot be reconstructed from it. `explainAssetMove` deliberately makes no causal claim.
6. Pump-fade research (`PUMP_FADE_EVIDENCE.md`): shorting 10%+ pumps at the alert has +0.38% mean/24h, and stop size barely changes the mean (15% stop: +0.25%). Entering 1h late costs ~0.16%. So **waiting for confirmation is cheap**; the edge is not in the first minutes.

## Why timing was off (hypothesis, to test)
- Short entered on the exhaustion print while the squeeze leg was still live: volume exhaustion on 1h bars lags the thrust and often prints *during* the final blow-off.
- Stops/liquidation priced inside the median poke (+6-8%), plus small coins' wicks (5m high vs 1h close) that 1h-bar research never sees.
- Short liquidity above resistance: stops and liquidations stack just above a prior high, price runs them, then reverses. The fade follows the sweep, not the print.

## 4. Proposed studies (in priority order, all research-only)
1. **Replay NEAR (10-11) and RED (10-12)** on 1m/5m perp bars: time of exhaustion print, time/size of peak, max adverse excursion, time to reverse. Quantify how many minutes after the peak a confirmation rule would have entered and what the cost would be.
2. **Poke-aware entry study** over the existing 456-coin archive, on 5m bars, for every exhaustion print: compare (a) enter at print, (b) enter after first 5m close below the prior 5m low once price is >= X% off the post-print high, (c) enter on a failed retest of the print high, (d) scale in 1/3 each at print +4%, +8%. Metric: stop-out rate at the leverage you use, mean 24h excess, MAE. Day-clustered t, A/B date split as in `research-2026-10-01`.
3. **Blow-off detector**: separate "volume thrust still accelerating" (current-bar volume > prior bar, range expanding, close near high) from "thrust decaying" (volume falling 2 bars, upper wicks). Test whether waiting for decay removes the poke.
4. **Contract-denominated OI** (not notional) at 5m: OI rising into the spike with funding positive = crowded longs fueling it; OI *falling* during the spike = shorts being squeezed (move is mostly forced covering and tends to fade once it ends). Needs the Oracle sampler (`oi-sampler.mjs`), because fapi is blocked elsewhere.
5. **Liquidation map**: Binance `forceOrder` websocket (`!forceOrder@arr`) captured on the Oracle host with timestamp, side, price, qty. Cluster by price vs. the prior N-hour high, then test "liquidation cascade ended (rate dropped > 70% from peak) -> reversal" as the trigger. This is the only way to test the user's resistance-cluster theory; it needs a few weeks of capture before anything is claimable.
6. **Funding and basis at spike**: perp premium vs spot spiking above its 7d p95 as an "overextended" flag; funding already in `funding_rate_daily` is daily, so use the 8h/1h series.

## Suggested guard rails for the eventual design (not implemented)
- Alert wording: "exhaustion print: fade is a 24h tendency; median +8% poke first on mid caps. Do not short full size at the print."
- Staged entry / wait-for-confirmation plan as an optional second alert ("blow-off decaying"), shadow-logged like `pump_fade_shadow` before any use.
- Leverage hint from the poke distribution (liquidation distance must exceed the p90 poke for that tier).
- Keep everything shadow-only until forward records exist; avoid searching many cells on one window (the earlier "now reversing" sub-case came from ~80 cells).

## Open questions for the other two investigators
- Do you have NEAR/RED 1m data and liquidation prints? Please append actual numbers here.
- Agree on a single shared definition of "poke" (max high within 24h after print / print close - 1) so results combine.
