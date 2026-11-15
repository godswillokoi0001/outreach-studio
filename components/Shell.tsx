"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useState } from "react";
import type { ReactNode } from "react";
import { api } from "@/lib/client";

const NAV: { group: string; items: { href: string; label: string; icon: string }[] }[] = [
  { group: "Overview", items: [{ href: "/", label: "Dashboard", icon: "grid" }] },
  {
    group: "Prospect engine",
    items: [
      { href: "/leads", label: "Leads", icon: "users" },
      { href: "/sheets", label: "Google Sheets", icon: "sheet" },
      { href: "/research", label: "Prospect research", icon: "search" },
      { href: "/campaigns", label: "Campaigns", icon: "flag" },
    ],
  },
  {
    group: "Outreach",
    items: [
      { href: "/review", label: "Email review", icon: "check" },
      { href: "/sent", label: "Sent emails", icon: "send" },
      { href: "/conversations", label: "Conversations", icon: "chat" },
      { href: "/followups", label: "Follow-ups", icon: "clock" },
    ],
  },
  {
    group: "Intelligence",
    items: [
      { href: "/analytics", label: "Analytics", icon: "chart" },
      { href: "/knowledge", label: "Knowledge base", icon: "book" },
    ],
  },
  {
    group: "Configuration",
    items: [
      { href: "/integrations", label: "Integrations", icon: "plug" },
      { href: "/settings", label: "Settings", icon: "gear" },
    ],
  },
];

const ICONS: Record<string, string> = {
  grid: "M3 3h7v7H3zM14 3h7v7h-7zM3 14h7v7H3zM14 14h7v7h-7z",
  users: "M16 19v-1a4 4 0 0 0-4-4H7a4 4 0 0 0-4 4v1M9.5 10a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7zM21 19v-1a4 4 0 0 0-3-3.87M16.5 3.2a3.5 3.5 0 0 1 0 6.8",
  sheet: "M3 4h18v16H3zM3 9h18M3 15h18M9 4v16M15 4v16",
  search: "M11 18a7 7 0 1 0 0-14 7 7 0 0 0 0 14zM20 20l-4-4",
  flag: "M5 21V4M5 5h9l-1.5 3L14 11H5",
  check: "M4 4h16v16H4zM8 12l3 3 5-6",
  send: "M21 3 10.5 13.5M21 3l-6.5 18-3.9-7.6L3 9.5z",
  chat: "M4 5h16v11H9l-5 4z",
  clock: "M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18zM12 7v5l3 2",
  chart: "M4 20V10M10 20V4M16 20v-7M22 20H2",
  book: "M4 5a2 2 0 0 1 2-2h13v18H6a2 2 0 0 1-2-2zM8 3v18",
  plug: "M9 3v6M15 3v6M6 9h12v3a6 6 0 0 1-12 0zM12 18v3",
  gear: "M12 15.5a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7zM19 12l2-1-2-4-2 .8M5 12l-2-1 2-4 2 .8M12 4V2M12 22v-2",
};

function Icon({ name }: { name: string }) {
  return (
    <svg className="nav-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d={ICONS[name] ?? ICONS.grid} />
    </svg>
  );
}

export function Shell({ children, user }: { children: ReactNode; user: { name: string; email: string; via: string } }) {
  const pathname = usePathname();
  const [open, setOpen] = useState(false);
  const [counts, setCounts] = useState({ review: 0, replies: 0, followups: 0 });
  const [syncing, setSyncing] = useState(false);
  const [syncNote, setSyncNote] = useState<string | null>(null);

  useEffect(() => setOpen(false), [pathname]);

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      try {
        const data = await api.get<{ emails: { pending: number }; replies: { total: number }; followupsDue: number }>("/api/dashboard");
        if (!cancelled) setCounts({ review: data.emails.pending, replies: data.replies.total, followups: data.followupsDue });
      } catch {
        // badge is informational only
      }
    };
    void load();
    const timer = setInterval(load, 60_000);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [pathname]);

  const signOut = async () => {
    try {
      if (user.via === "freebuff") {
        await fetch("/auth/freebuff/signout", { method: "POST", credentials: "same-origin" });
      } else {
        await api.del("/api/session");
      }
    } finally {
      window.location.href = "/";
    }
  };

  const runSync = async () => {
    setSyncing(true);
    setSyncNote(null);
    try {
      const result = await api.post<{ info?: string; processed: number; errors: string[] }>("/api/process", { type: "sync", limit: 5 });
      setSyncNote(result.info || `Synced (${result.processed} new).`);
      if (result.errors.length) setSyncNote(result.errors[0]);
    } catch (err) {
      setSyncNote(err instanceof Error ? err.message : "Sync failed.");
    } finally {
      setSyncing(false);
    }
  };

  const badgeFor = (href: string): number | null => {
    if (href === "/review") return counts.review || null;
    if (href === "/conversations") return counts.replies || null;
    if (href === "/followups") return counts.followups || null;
    return null;
  };

  return (
    <div className="app">
      <aside className={`sidebar${open ? " open" : ""}`}>
        <div className="brand">
          <div className="brand-mark">OS</div>
          <div>
            <div className="brand-name">Outreach Studio</div>
            <div className="brand-sub">Sales intelligence</div>
          </div>
        </div>
        <nav className="nav">
          {NAV.map((group) => (
            <div key={group.group}>
              <div className="nav-group-label">{group.group}</div>
              {group.items.map((item) => {
                const active = pathname === item.href || (item.href !== "/" && pathname.startsWith(item.href));
                const count = badgeFor(item.href);
                return (
                  <Link key={item.href} href={item.href} className={`nav-link${active ? " active" : ""}`}>
                    <Icon name={item.icon} />
                    <span>{item.label}</span>
                    {count ? <span className="nav-count">{count}</span> : null}
                  </Link>
                );
              })}
            </div>
          ))}
        </nav>
      </aside>

      <div className="main">
        <header className="topbar">
          <button className="btn btn-sm menu-btn" onClick={() => setOpen((v) => !v)} type="button" aria-label="Toggle navigation">
            Menu
          </button>
          <div className="topbar-title">Outreach Studio</div>
          <div className="topbar-spacer" />
          {syncNote && <span className="tiny" style={{ maxWidth: 300 }}>{syncNote}</span>}
          <button className="btn btn-sm" onClick={runSync} disabled={syncing} type="button">
            {syncing ? "Syncing…" : "Sync replies"}
          </button>
          <div className="user-chip">
            <span className="user-dot">{(user.name || user.email || "U").slice(0, 1).toUpperCase()}</span>
            <span className="nowrap">{user.name || user.email || "Signed in"}</span>
          </div>
          <button className="btn btn-sm btn-ghost" onClick={signOut} type="button">
            Sign out
          </button>
        </header>
        {children}
      </div>
    </div>
  );
}
