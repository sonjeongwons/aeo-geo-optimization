import type { Metadata } from "next";
import "../styles/tokens.css";

export const metadata: Metadata = {
  title: "AEO/GEO 최적화 대시보드",
  description:
    "AI 엔진 최적화(AEO/GEO) 진단 및 모니터링 서비스. " +
    "현 위치 진단입니다 — 노출을 보장하지 않습니다.",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="ko">
      <body>{children}</body>
    </html>
  );
}
