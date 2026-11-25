import type { Metadata, Viewport } from "next";
import { Manrope } from "next/font/google";
import "./globals.css";
import "./theme.css";
import "./loaders.css";
import "./marketing.css";
import "./brand.css";
import "./ui-kit.css";
import "./features.css";
import "./dark.css";
import { THEME_SCRIPT } from "@/lib/theme";
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
  manifest: "/manifest.webmanifest",
  icons: {
    icon: [
      { url: "/brand/knowrevo-icon-32.png", sizes: "32x32", type: "image/png" },
      { url: "/brand/knowrevo-icon-192.png", sizes: "192x192", type: "image/png" },
      { url: "/brand/knowrevo-icon-512.png", sizes: "512x512", type: "image/png" },
    ],
    apple: [{ url: "/brand/knowrevo-icon-180.png", sizes: "180x180", type: "image/png" }],
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
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#f5f7fa" },
    { media: "(prefers-color-scheme: dark)", color: "#06121e" },
  ],
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={manrope.variable} suppressHydrationWarning>
      <head>
        {/* Sets data-theme before first paint so a dark reload never flashes white. */}
        <script dangerouslySetInnerHTML={{ __html: THEME_SCRIPT }} />
      </head>
      <body>
        <MotionProvider>
          <AuthProvider>{children}</AuthProvider>
        </MotionProvider>
      </body>
    </html>
  );
}
