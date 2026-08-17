import type { MetadataRoute } from "next";

// PWA manifest. display: "standalone" + scope: "/" 가 있어야 홈 화면 아이콘으로
// 실행했을 때 모든 내부 경로(/, /history, /looks, /add 등)가 Safari 브라우저
// UI 없이 하나의 standalone 앱 컨텍스트 안에서 열린다.
export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "룩기 LOOKIE",
    short_name: "룩기",
    description: "사진첩 속 거울셀카를 자동으로 정리하는 개인 룩 아카이브",
    start_url: "/",
    scope: "/",
    display: "standalone",
    background_color: "#ffffff",
    theme_color: "#ffffff",
    icons: [
      { src: "/icon-192.png", sizes: "192x192", type: "image/png" },
      { src: "/icon.png", sizes: "512x512", type: "image/png" },
      { src: "/apple-icon.png", sizes: "180x180", type: "image/png" },
    ],
  };
}
