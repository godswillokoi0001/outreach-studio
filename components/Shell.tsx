"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useState, type ReactNode } from "react";
import {
  BarChart3,
  BookOpen,
  CheckCircle2,
  CheckSquare,
  Clock,
  FileSpreadsheet,
  Flag,
  LayoutGrid,
  LogOut,
  Menu,
  MessageSquare,
  PanelLeftClose,
  PanelLeftOpen,
  Plug,
  RefreshCw,
  Search,
  Send,
  Settings,
  Sparkles,
  Users,
  type LucideIcon,
} from "lucide-react";
import { AnimatePresence, motion } from "framer-motion";
import { errorMessage } from "@/lib/client";
import { subscribeBadgeCounts } from "@/lib/firestore-store";
import { runSyncBatch } from "@/lib/pipeline-client";
import { useAuth } from "./AuthProvider";
import { DashboardChat } from "./DashboardChat";
import { TaskDockProvider, useTaskDock } from "./Loading";
import { PageMotion } from "./motion/PageMotion";

const NAV_STATE_KEY = "os:nav:collapsed";

const NAV = [
  { group: "Overview", items: [{ href: "/", label: "Dashboard", icon: LayoutGrid }] },
  {
    group: "Prospect engine",
    items: [
      { href: "/leads", label: "Leads", icon: Users },
      { href: "/sheets", label: "Google Sheets", icon: FileSpreadsheet },
      { href: "/research", label: "Prospect research", icon: Search },
      { href: "/campaigns", label: "Campaigns", icon: Flag },
    ],
  },
  {
    group: "Outreach",
    items: [
      { href: "/review", label: "Email review", icon: CheckSquare },
      { href: "/sent", label: "Sent emails", icon: Send },
      { href: "/conversations", label: "Conversations", icon: MessageSquare },
      { href: "/followups", label: "Follow-ups", icon: Clock },
    ],
  },
  {
    group: "Intelligence",
    items: [
      { href: "/analytics", label: "Analytics", icon: BarChart3 },
      { href: "/knowledge", label: "Knowledge base", icon: BookOpen },
    ],
  },
  {
    group: "Configuration",
    items: [
      { href: "/integrations", label: "Integrations", icon: Plug },
      { href: "/settings", label: "Settings", icon: Settings },
    ],
  },
];

export function Shell({ children }: { children: ReactNode }) {
  return (
    <TaskDockProvider>
      <ShellInner>{children}</ShellInner>
    </TaskDockProvider>
  );
}

function ShellInner({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  const dock = useTaskDock();
  const { user, workspaceToken, workspaceEmail, workspacePersistent, reconnectWorkspace, signOut } = useAuth();
  const [open, setOpen] = useState(false);
  const [chatOpen, setChatOpen] = useState(false);
  const [collapsed, setCollapsed] = useState(false);
  const [refreshKey, setRefreshKey] = useState(0);
  const [counts, setCounts] = useState({ review: 0, replies: 0, followups: 0 });
  const [syncing, setSyncing] = useState(false);
  const [syncNote, setSyncNote] = useState<string | null>(null);

  useEffect(() => {
    const frame = requestAnimationFrame(() => {
      setCollapsed(window.localStorage.getItem(NAV_STATE_KEY) === "collapsed");
    });
    return () => cancelAnimationFrame(frame);
  }, []);

  const toggleNav = () => {
    setCollapsed((current) => {
      const next = !current;
      window.localStorage.setItem(NAV_STATE_KEY, next ? "collapsed" : "expanded");
      return next;
    });
  };

  useEffect(() => {
    if (!user?.uid) return;
    const unsub = subscribeBadgeCounts(user.uid, setCounts);
    return () => unsub();
  }, [user?.uid]);

  const runSync = async () => {
    if (!workspaceToken) {
      const ok = await reconnectWorkspace();
      if (!ok) return;
    }
    setSyncing(true);
    setSyncNote(null);
    const task = dock.start({
      title: "Syncing replies",
      detail: "Reading your inbox and classifying new replies…",
      estimatedMs: 14_000,
    });
    try {
      const result = await runSyncBatch(user.uid, 15);
      const message = result.info || `Synced (${result.processed} new).`;
      setSyncNote(result.errors.length ? result.errors[0] : message);
      task.finish(result.errors.length && !result.processed ? "error" : "done", message);
      if (result.processed > 0) setRefreshKey((k) => k + 1);
    } catch (err) {
      const message = errorMessage(err);
      setSyncNote(message);
      task.finish("error", message);
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

  const displayName = user.displayName || user.email || "Signed in";

  return (
    <div className="app" data-collapsed={collapsed ? "true" : "false"}>
      <aside className={`sidebar${open ? " open" : ""}`}>
        <div className="brand">
          <div className="brand-mark">OS</div>
          <div className="brand-copy">
            <div className="brand-name">Outreach Studio</div>
            <div className="brand-sub">Sales intelligence</div>
          </div>
          <button
            className="sidebar-toggle"
            onClick={toggleNav}
            type="button"
            aria-label={collapsed ? "Expand navigation" : "Collapse navigation"}
            aria-expanded={!collapsed}
            title={collapsed ? "Expand menu" : "Collapse menu"}
          >
            <AnimatePresence mode="wait" initial={false}>
              <motion.span
                key={collapsed ? "open" : "close"}
                initial={{ rotate: -90, opacity: 0, scale: 0.75 }}
                animate={{ rotate: 0, opacity: 1, scale: 1 }}
                exit={{ rotate: 90, opacity: 0, scale: 0.75 }}
                transition={{ duration: 0.18, ease: "easeOut" }}
                style={{ display: "grid", placeItems: "center" }}
              >
                {collapsed ? <PanelLeftOpen size={14} /> : <PanelLeftClose size={14} />}
              </motion.span>
            </AnimatePresence>
          </button>
        </div>
        <nav className="nav">
          {NAV.map((group) => (
            <div key={group.group}>
              <div className="nav-group-label">{group.group}</div>
              {group.items.map((item) => {
                const active =
                  pathname === item.href || (item.href !== "/" && pathname.startsWith(item.href));
                const count = badgeFor(item.href);
                const ItemIcon = item.icon;
                return (
                  <Link
                    key={item.href}
                    href={item.href}
                    className={`nav-link${active ? " active" : ""}`}
                    onClick={() => setOpen(false)}
                    title={collapsed ? item.label : undefined}
                  >
                    {active && (
                      <span className="nav-pill" />
                    )}
                    <ItemIcon className="nav-icon" size={16} strokeWidth={1.7} aria-hidden="true" />
                    <span className="nav-text">{item.label}</span>
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
          <button
            className="btn btn-sm menu-btn"
            onClick={() => setOpen((v) => !v)}
            type="button"
            aria-label="Toggle navigation"
          >
            <Menu size={15} />
            <span>Menu</span>
          </button>
          <div className="topbar-title">Outreach Studio</div>
          <div className="topbar-spacer" />
          {syncNote && <span className="tiny" style={{ maxWidth: 280 }}>{syncNote}</span>}
          {workspaceToken ? (
            <span
              className="badge"
              data-tone="ok"
              title={
                workspacePersistent
                  ? `Connected${workspaceEmail ? ` as ${workspaceEmail}` : ""} - stays connected across reloads`
                  : `Connected${workspaceEmail ? ` as ${workspaceEmail}` : ""} for this session`
              }
            >
              <CheckCircle2 size={12} />
              <span className="nowrap">
                {workspaceEmail ? workspaceEmail.split("@")[0] : "Google"} connected
              </span>
            </span>
          ) : (
            <button
              className="btn btn-sm btn-primary"
              onClick={() => void reconnectWorkspace()}
              type="button"
              title="Grant Google Sheets and Gmail access"
            >
              <Plug size={13} />
              <span>Connect Google</span>
            </button>
          )}
          <button
            className={`btn btn-sm${chatOpen ? " btn-primary" : ""}`}
            onClick={() => setChatOpen((v) => !v)}
            type="button"
            aria-pressed={chatOpen}
          >
            <Sparkles size={13} />
            <span>AI Operator</span>
          </button>
          <button className="btn btn-sm" onClick={() => void runSync()} disabled={syncing} type="button">
            <RefreshCw size={13} className={syncing ? "spin-icon" : undefined} />
            <span>{syncing ? "Syncing…" : "Sync replies"}</span>
          </button>
          <div className="user-chip" title={user.email ?? undefined}>
            <span className="user-dot">{displayName.slice(0, 1).toUpperCase()}</span>
            <span className="nowrap">{displayName}</span>
          </div>
          <button className="btn btn-sm btn-ghost" onClick={() => void signOut()} type="button">
            <LogOut size={13} />
            <span>Sign out</span>
          </button>
        </header>

        <PageMotion>{children}</PageMotion>
      </div>
    </div>
  );
}