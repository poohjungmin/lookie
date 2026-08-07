import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  /* config options here */

  // 개발 서버를 같은 Wi-Fi의 iPhone 등 다른 기기에서 접속할 때
  // (예: http://172.30.1.68:3000) Next.js가 cross-origin 요청을 차단하는 것을 허용.
  // 개발 환경에서만 의미 있는 설정이며 프로덕션 빌드에는 영향 없음.
  allowedDevOrigins: ["172.30.1.68"],
};

export default nextConfig;
