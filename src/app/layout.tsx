import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import "./globals.css";
import AppShell from "@/components/AppShell";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "룩기 LOOKIE",
  description: "사진첩 속 거울셀카를 자동으로 정리하는 개인 룩 아카이브",
  // iOS는 이 메타 태그가 있어야 홈 화면에서 실행했을 때 Safari 브라우저 UI
  // (X 버튼 + 주소창 + 메뉴) 없이 standalone 앱처럼 실행된다.
  appleWebApp: {
    capable: true,
    statusBarStyle: "default",
    title: "룩기",
  },
  other: {
    // Next.js가 자동으로 넣어주는 "mobile-web-app-capable"은 최신
    // iOS/Safari만 인식한다. 구버전 iOS 호환을 위해 apple 전용 태그도 명시.
    "apple-mobile-web-app-capable": "yes",
  },
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html
      lang="ko"
      className={`${geistSans.variable} ${geistMono.variable} h-full antialiased`}
    >
      <body className="min-h-full flex flex-col bg-white">
        <AppShell>{children}</AppShell>
      </body>
    </html>
  );
}
