import type { Metadata, Viewport } from "next";
import "./globals.css";
import "./theme.css";
import "./loaders.css";
import "./marketing.css";
import "./brand.css";
import { AuthProvider } from "@/components/AuthProvider";
import { MotionProvider } from "@/components/motion/MotionProvider";

export const metadata: Metadata = {
  title: "Knowrevo — Your knowledge. Your next customer.",
  description:
    "Knowrevo is an AI-powered outreach platform that researches prospects, learns from your business knowledge, creates personalized emails and tracks engagement and replies.",
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
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <head>
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="anonymous" />
        <link
          rel="stylesheet"
          href="https://fonts.googleapis.com/css2?family=Manrope:wght@400;500;600;700;800&display=swap"
        />
      </head>
      <body>
        <MotionProvider>
          <AuthProvider>{children}</AuthProvider>
        </MotionProvider>
      </body>
    </html>
  );
}
