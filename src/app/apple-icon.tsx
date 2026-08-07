import { ImageResponse } from "next/og";

// iOS 홈 화면 아이콘(apple-touch-icon)은 이 파일이 없으면 iOS가 페이지
// 스크린샷을 대신 사용한다 - 반드시 별도 아이콘이 있어야 한다.
export const size = { width: 180, height: 180 };
export const contentType = "image/png";

export default function AppleIcon() {
  return new ImageResponse(
    (
      <div
        style={{
          width: "100%",
          height: "100%",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          background: "#171717",
          color: "#ffffff",
          fontSize: 84,
          fontWeight: 700,
        }}
      >
        룩
      </div>
    ),
    { ...size }
  );
}
