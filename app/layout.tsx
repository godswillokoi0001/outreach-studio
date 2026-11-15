import type { Metadata, Viewport } from "next";
import "./globals.css";
import { currentUser, authMode } from "@/lib/auth";
import { getEnv } from "@/lib/env";
import { Shell } from "@/components/Shell";
import { LoginGate } from "@/components/LoginGate";

export const metadata: Metadata = {
  title: "Outreach Studio",
  description: "AI-powered sales intelligence, prospect research and outreach platform.",
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
};

export const dynamic = "force-dynamic";

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  const env = await getEnv();
  const mode = authMode(env);
  const user = await currentUser();

  return (
    <html lang="en">
      <body>
        {user ? (
          <Shell user={{ name: user.name ?? "", email: user.email ?? "", via: user.via }}>{children}</Shell>
        ) : (
          <LoginGate mode={mode} />
        )}
      </body>
    </html>
  );
}
