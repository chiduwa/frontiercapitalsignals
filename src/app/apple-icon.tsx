import { ImageResponse } from "next/og";

export const size = { width: 180, height: 180 };
export const contentType = "image/png";

export default function AppleIcon() {
  return new ImageResponse(
    (
      <div
        style={{
          background: "#0c1a35",
          width: "100%",
          height: "100%",
          display: "flex",
          alignItems: "flex-end",
          justifyContent: "center",
          borderRadius: "28px",
          paddingBottom: "28px",
          gap: "10px",
        }}
      >
        <div style={{ width: "22px", height: "44px", background: "#b8860b", borderRadius: "4px" }} />
        <div style={{ width: "22px", height: "70px", background: "#b8860b", borderRadius: "4px" }} />
        <div style={{ width: "22px", height: "100px", background: "#b8860b", borderRadius: "4px" }} />
        <div style={{ width: "22px", height: "124px", background: "#d4a017", borderRadius: "4px" }} />
      </div>
    ),
    { ...size }
  );
}
