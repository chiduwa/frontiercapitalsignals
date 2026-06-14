import { ImageResponse } from "next/og";

export const size = { width: 32, height: 32 };
export const contentType = "image/png";

export default function Icon() {
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
          borderRadius: "5px",
          paddingBottom: "4px",
          gap: "2px",
        }}
      >
        <div style={{ width: "4px", height: "8px", background: "#b8860b", borderRadius: "1px" }} />
        <div style={{ width: "4px", height: "13px", background: "#b8860b", borderRadius: "1px" }} />
        <div style={{ width: "4px", height: "18px", background: "#b8860b", borderRadius: "1px" }} />
        <div style={{ width: "4px", height: "22px", background: "#d4a017", borderRadius: "1px" }} />
      </div>
    ),
    { ...size }
  );
}
