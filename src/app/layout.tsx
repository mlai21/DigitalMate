import type { Metadata, Viewport } from "next";
import { RegisterServiceWorker } from "@/components/pwa/register-service-worker";
import "./globals.css";

export const metadata: Metadata = {
  applicationName: "DigitalMate",
  title: "DigitalMate",
  description: "一个有稳定人设、能自我进化的私人数字伙伴",
  manifest: "/manifest.webmanifest",
  appleWebApp: {
    capable: true,
    title: "DigitalMate",
    statusBarStyle: "default",
  },
  icons: {
    icon: "/digitalmate-icon.svg",
    apple: "/digitalmate-icon.svg",
  },
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#faf7f2" },
    { media: "(prefers-color-scheme: dark)", color: "#201d19" },
  ],
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="zh-CN">
      <body>
        {children}
        <RegisterServiceWorker />
      </body>
    </html>
  );
}
