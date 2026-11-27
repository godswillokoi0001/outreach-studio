import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Knowrevo Operations Console",
  robots: { index: false, follow: false },
};

/**
 * Isolated root boundary for `/admin/*`.
 * Completely separate from the customer workspace Shell, navigation, and chatbot.
 */
export default function AdminSectionLayout({ children }: { children: React.ReactNode }) {
  return <>{children}</>;
}
