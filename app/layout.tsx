import type { Metadata, Viewport } from "next";
import { Manrope } from "next/font/google";
import "./globals.css";
import "./theme.css";
import "./loaders.css";
import "./marketing.css";
import "./brand.css";
import { AuthProvider } from "@/components/AuthProvider";
import { MotionProvider } from "@/components/motion/MotionProvider";

const manrope = Manrope({
  subsets: ["latin"],
  display: "swap",
  weight: ["400", "500", "600", "700", "800"],
  variable: "--font-manrope",
});

export const metadata: Metadata = {
  title: {
    default: "Knowrevo — Your knowledge. Your next customer.",
    template: "%s · Knowrevo",
  },
  description:
    "Knowrevo researches prospects, writes from your business knowledge, sends from your Gmail and tracks every open and reply — in one workspace.",
  applicationName: "Knowrevo",
  icons: {
    icon: [{ url: "/brand/knowrevo-icon-512.png", type: "image/png", sizes: "512x512" }],
    apple: [{ url: "/brand/knowrevo-icon-512.png", sizes: "512x512" }],
  },
  openGraph: {
    title: "Knowrevo — Your knowledge. Your next customer.",
    description:
      "Research prospects, write better emails and know when they respond. Outreach that understands your business.",
    siteName: "Knowrevo",
    type: "website",
  },
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  themeColor: "#081625",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={manrope.variable}>
      <body>
        <MotionProvider>
          <AuthProvider>{children}</AuthProvider>
        </MotionProvider>
      </body>
    </html>
  );
}
