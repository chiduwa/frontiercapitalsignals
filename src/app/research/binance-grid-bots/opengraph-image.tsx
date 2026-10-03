// Social card for the grid-bot study: the headline and its three numbers on the
// site's navy-and-gold card, so a shared link carries the finding itself.

import { ImageResponse } from "next/og";

export const size = { width: 1200, height: 630 };
export const contentType = "image/png";
export const alt = "Binance grid bots tested: 72,280 bots replayed on 2021–2026 prices";

const NAVY = "#0a0f1e";
const GOLD = "#c9962a";
const GOLD_BORDER = "rgba(201,150,42,0.45)";
const WHITE = "#ffffff";
const WHITE_70 = "rgba(255,255,255,0.70)";

const stats = [
  ["72,280", "grid bots replayed"],
  ["±44%", "BTC range, 49 grids"],
  ["≈4%/yr", "Arbitrage Bot on BTC"],
];

export default function Image() {
  return new ImageResponse(
    (
      <div
        style={{
          width: "100%",
          height: "100%",
          background: NAVY,
          display: "flex",
          flexDirection: "column",
          justifyContent: "space-between",
          padding: "64px 72px",
          fontFamily: "system-ui, -apple-system, sans-serif",
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 16 }}>
          <div style={{ width: 14, height: 14, borderRadius: 7, background: GOLD, display: "flex" }} />
          <div style={{ display: "flex", color: GOLD, fontSize: 24, fontWeight: 700, letterSpacing: 3, textTransform: "uppercase" }}>
            Frontier Capital Signals Research
          </div>
        </div>

        <div style={{ display: "flex", color: WHITE, fontSize: 60, fontWeight: 800, lineHeight: 1.15, letterSpacing: -1 }}>
          Binance Grid Bots Tested: Best Spot and Futures Settings
        </div>

        <div style={{ display: "flex", gap: 20 }}>
          {stats.map(([value, label]) => (
            <div
              key={label}
              style={{
                display: "flex",
                flexDirection: "column",
                border: `1px solid ${GOLD_BORDER}`,
                borderRadius: 18,
                padding: "16px 26px",
              }}
            >
              <div style={{ display: "flex", color: GOLD, fontSize: 40, fontWeight: 800 }}>{value}</div>
              <div style={{ display: "flex", color: WHITE_70, fontSize: 22, fontWeight: 600 }}>{label}</div>
            </div>
          ))}
        </div>
      </div>
    ),
    size,
  );
}
