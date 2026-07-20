import { ImageResponse } from "next/og";

export const contentType = "image/png";

export async function GET() {
  return new ImageResponse(
    (
      <div
        style={{
          width: "100%",
          height: "100%",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          background: "#0a0a0a",
          color: "#fb923c",
          fontSize: 256,
          fontWeight: 700,
        }}
      >
        CS
      </div>
    ),
    { width: 512, height: 512 }
  );
}
