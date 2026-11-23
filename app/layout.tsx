import type { Metadata, Viewport } from "next";
import "./globals.css";
import { AuthProvider } from "@/components/AuthProvider";

export const metadata: Metadata = {
  title: "Outreach Studio",
  description:
    "AI-powered B2B sales intelligence, prospect research, Google Sheets lead sync, and Gmail outreach workspace.",
  openGraph: {
    title: "Outreach Studio",
    description:
      "AI-powered B2B sales intelligence, prospect research, Google Sheets lead sync, and Gmail outreach workspace.",
  },
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>
        <AuthProvider>{children}</AuthProvider>
      </body>
    </html>
  );
}
