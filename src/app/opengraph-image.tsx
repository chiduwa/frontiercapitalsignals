import { ImageResponse } from "next/og";

export const size = { width: 1200, height: 630 };
export const contentType = "image/png";

const NAVY = "#0a0f1e";
const GOLD = "#c9962a";
const GOLD_DIM = "rgba(201,150,42,0.18)";
const GOLD_BORDER = "rgba(201,150,42,0.45)";
const WHITE = "#ffffff";
const WHITE_70 = "rgba(255,255,255,0.70)";
const WHITE_15 = "rgba(255,255,255,0.15)";
const WHITE_08 = "rgba(255,255,255,0.08)";
const WHITE_04 = "rgba(255,255,255,0.35)";

const countries = [
  { name: "Ghana",   color: "#f59e0b" },
  { name: "Nigeria", color: "#22c55e" },
  { name: "Kenya",   color: "#ef4444" },
  { name: "Malawi",  color: "#8b5cf6" },
  { name: "Uganda",  color: "#06b6d4" },
];

const metrics = [
  { label: "GDP Combined",  value: "$1.2T"  },
  { label: "FDI Growth",    value: "+18%"  },
  { label: "Mobile Money",  value: "300M+" },
];

export default function OGImage() {
  return new ImageResponse(
    (
      <div
        style={{
          width: "100%",
          height: "100%",
          background: NAVY,
          display: "flex",
          flexDirection: "column",
          position: "relative",
          overflow: "hidden",
          fontFamily: "system-ui, -apple-system, sans-serif",
        }}
      >
        {/* Background grid */}
        <div
          style={{
            position: "absolute",
            inset: 0,
            backgroundImage:
              `linear-gradient(rgba(255,255,255,0.03) 1px, transparent 1px),
               linear-gradient(90deg, rgba(255,255,255,0.03) 1px, transparent 1px)`,
            backgroundSize: "60px 60px",
          }}
        />

        {/* Gold glow top-right */}
        <div
          style={{
            position: "absolute",
            top: -120,
            right: -80,
            width: 480,
            height: 480,
            borderRadius: "50%",
            background: "radial-gradient(circle, rgba(201,150,42,0.12) 0%, transparent 70%)",
          }}
        />

        {/* Gold glow bottom-left */}
        <div
          style={{
            position: "absolute",
            bottom: -100,
            left: 300,
            width: 360,
            height: 360,
            borderRadius: "50%",
            background: "radial-gradient(circle, rgba(201,150,42,0.07) 0%, transparent 70%)",
          }}
        />

        {/* Left content column */}
        <div
          style={{
            position: "absolute",
            left: 72,
            top: 0,
            bottom: 0,
            width: 660,
            display: "flex",
            flexDirection: "column",
            justifyContent: "center",
          }}
        >
          {/* Live badge */}
          <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: 10,
              marginBottom: 32,
              width: "fit-content",
              background: WHITE_08,
              border: `1px solid ${WHITE_15}`,
              borderRadius: 100,
              padding: "7px 18px",
            }}
          >
            <div
              style={{
                width: 8,
                height: 8,
                borderRadius: "50%",
                background: GOLD,
              }}
            />
            <span
              style={{
                color: WHITE_70,
                fontSize: 13,
                fontWeight: 700,
                letterSpacing: 3,
                textTransform: "uppercase",
              }}
            >
              Live Market Intelligence · AI-Powered
            </span>
          </div>

          {/* Headline */}
          <div style={{ display: "flex", flexDirection: "column", marginBottom: 20 }}>
            <span
              style={{
                color: WHITE,
                fontSize: 74,
                fontWeight: 900,
                lineHeight: 1.0,
                letterSpacing: -2,
              }}
            >
              Frontier Capital
            </span>
            <span
              style={{
                color: GOLD,
                fontSize: 74,
                fontWeight: 900,
                lineHeight: 1.0,
                letterSpacing: -2,
              }}
            >
              Signals
            </span>
          </div>

          {/* Tagline */}
          <p
            style={{
              color: WHITE_70,
              fontSize: 22,
              lineHeight: 1.5,
              marginBottom: 40,
              maxWidth: 540,
            }}
          >
            Africa&apos;s most invisible deals, made visible. Daily AI-curated investment intelligence for emerging market investors.
          </p>

          {/* Country chips */}
          <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
            {countries.map(({ name, color }) => (
              <div
                key={name}
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 7,
                  padding: "7px 14px",
                  background: GOLD_DIM,
                  border: `1px solid ${GOLD_BORDER}`,
                  borderRadius: 8,
                }}
              >
                <div style={{ width: 8, height: 8, borderRadius: "50%", background: color }} />
                <span style={{ color: GOLD, fontSize: 14, fontWeight: 700 }}>{name}</span>
              </div>
            ))}
          </div>
        </div>

        {/* Right metrics panel */}
        <div
          style={{
            position: "absolute",
            right: 64,
            top: "50%",
            transform: "translateY(-50%)",
            width: 280,
            display: "flex",
            flexDirection: "column",
            gap: 16,
          }}
        >
          {metrics.map(({ label, value }) => (
            <div
              key={label}
              style={{
                background: WHITE_08,
                border: `1px solid ${WHITE_15}`,
                borderRadius: 14,
                padding: "22px 24px",
                display: "flex",
                flexDirection: "column",
              }}
            >
              <span style={{ color: GOLD, fontSize: 36, fontWeight: 900, letterSpacing: -1 }}>
                {value}
              </span>
              <span style={{ color: WHITE_70, fontSize: 13, fontWeight: 600, marginTop: 4 }}>
                {label}
              </span>
            </div>
          ))}

          {/* URL tag */}
          <div
            style={{
              marginTop: 8,
              padding: "10px 16px",
              background: GOLD_DIM,
              border: `1px solid ${GOLD_BORDER}`,
              borderRadius: 10,
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
            }}
          >
            <span style={{ color: WHITE_04, fontSize: 14, fontWeight: 600, letterSpacing: 0.5 }}>
              frontiercapitalsignals.com
            </span>
          </div>
        </div>
      </div>
    ),
    { ...size }
  );
}
