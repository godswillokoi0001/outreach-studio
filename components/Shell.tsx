"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useRef, useState, type ReactNode } from "react";
import {
  BarChart3,
  Bell,
  Bot,
  BookOpen,
  CheckCircle2,
  CheckSquare,
  Clock,
  FileSpreadsheet,
  Flag,
  LayoutGrid,
  LogOut,
  Menu as MenuIcon,
  MessageSquare,
  MoreHorizontal,
  MousePointerClick,
  PanelLeftClose,
  PanelLeftOpen,
  Plug,
  RefreshCw,
  Search,
  Send,
  Settings,
  Users,
  X,
} from "lucide-react";
import { AnimatePresence, motion } from "framer-motion";
import { initAiConfig } from "@/lib/ai-client";
import { errorMessage } from "@/lib/client";
import { subscribeBadgeCounts, subscribeOpenEvents } from "@/lib/store";
import { runSendBatch, runSyncBatch } from "@/lib/pipeline-client";
import { useAuth } from "./AuthProvider";
import { BrandLockup, BrandMark } from "./BrandMark";
import { BrandLoader } from "./BrandLoader";
import { Menu, MenuItem, MenuSeparator } from "./Menu";
import { ThemeToggle } from "./ThemeToggle";
import { DashboardChat } from "./DashboardChat";
import { AgentPresenceProvider } from "./AgentPresence";
import { TaskDockProvider, useTaskDock } from "./Loading";
import { WorkspaceIssueNotice } from "./WorkspaceIssueNotice";
import { PageMotion } from "./motion/PageMotion";
import { useToast } from "./Feedback";

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

interface SignalToast {
  id: string;
  kind: "open" | "reply";
  title: string;
  detail: string;
}

export function Shell({ children }: { children: ReactNode }) {
  return (
    <TaskDockProvider>
      <AgentPresenceProvider>
        <ShellInner>{children}</ShellInner>
      </AgentPresenceProvider>
    </TaskDockProvider>
  );
}

function ShellInner({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  const dock = useTaskDock();
  const toast = useToast();
  const {
    user,
    workspaceReady,
    workspaceToken,
    workspaceEmail,
    workspacePersistent,
    workspaceIssue,
    reconnectWorkspace,
    disconnectWorkspace,
    signOut,
  } = useAuth();

  useEffect(() => {
    void initAiConfig(user.uid);
  }, [user.uid]);

  const [open, setOpen] = useState(false);
  const [chatOpen, setChatOpen] = useState(false);
  const [collapsed, setCollapsed] = useState(false);
  const [refreshKey, setRefreshKey] = useState(0);
  const [counts, setCounts] = useState({ review: 0, replies: 0, followups: 0 });
  const [syncing, setSyncing] = useState(false);
  const [syncNote, setSyncNote] = useState<string | null>(null);
  const [signals, setSignals] = useState<SignalToast[]>([]);
  const previousReplies = useRef<number | null>(null);

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

  const pushSignal = (signal: Omit<SignalToast, "id">) => {
    const id = `${signal.kind}_${Date.now()}`;
    setSignals((current) => [...current.slice(-2), { ...signal, id }]);
    window.setTimeout(() => {
      setSignals((current) => current.filter((item) => item.id !== id));
    }, 9000);
  };

  useEffect(() => {
    if (!user?.uid) return;
    const unsub = subscribeBadgeCounts(user.uid, (next) => {
      setCounts(next);
      const previous = previousReplies.current;
      previousReplies.current = next.replies;
      if (previous !== null && next.replies > previous) {
        pushSignal({
          kind: "reply",
          title: "A prospect replied",
          detail: "Open Conversations to read it and send the suggested answer.",
        });
      }
    });
    return () => unsub();
  }, [user?.uid]);

  // Open tracking: tell the operator the moment a sent email is read.
  // The subscriber only emits events newer than its last snapshot, so we do
  // not need a manual baseline skip here.
  useEffect(() => {
    if (!user?.uid) return;
    const unsub = subscribeOpenEvents(user.uid, (events) => {
      if (events.length === 0) return;
      pushSignal({
        kind: "open",
        title: "An email was just opened",
        detail: `${new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })} · see which send in Sent emails.`,
      });
      void events;
    });
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
      if (result.errors.length && !result.processed) {
        toast.error("Sync failed", result.errors[0]);
      } else {
        toast.success("Inbox synced", message);
      }
      task.finish(result.errors.length && !result.processed ? "error" : "done", message);
      if (result.processed > 0) {
        setRefreshKey((k) => k + 1);
        window.dispatchEvent(new Event("os:data-refreshed"));
      }
    } catch (err) {
      const message = errorMessage(err);
      setSyncNote(message);
      toast.error("Sync failed", message);
      task.finish("error", message);
    } finally {
      setSyncing(false);
    }
  };

  // Background pipeline: once per ten minutes per tab, pull new replies and send
  // anything already approved. Both respect the user's limits, window and
  // suppression list, so this only automates the clicks, never the policy.
  useEffect(() => {
    if (!user?.uid || !workspaceToken) return;
    const KEY = "os:auto-pipeline";
    let last = 0;
    try {
      last = Number(window.sessionStorage.getItem(KEY) ?? 0);
    } catch {
      last = 0;
    }
    if (Date.now() - last < 10 * 60 * 1000) return;
    try {
      window.sessionStorage.setItem(KEY, String(Date.now()));
    } catch {
      /* storage unavailable */
    }

    let cancelled = false;
    void (async () => {
      try {
        const sync = await runSyncBatch(user.uid, 10);
        if (cancelled) return;
        if (sync.processed > 0) {
          setRefreshKey((k) => k + 1);
          window.dispatchEvent(new Event("os:data-refreshed"));
        }
        const send = await runSendBatch(user.uid, undefined, 2);
        if (cancelled) return;
        if (send.processed > 0) {
          setSyncNote(send.info ?? `Auto-sent ${send.processed} approved email(s).`);
          setRefreshKey((k) => k + 1);
          window.dispatchEvent(new Event("os:data-refreshed"));
        }
      } catch {
        // Background automation is best-effort; the manual buttons stay available.
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [user?.uid, workspaceToken]);

  const badgeFor = (href: string): number | null => {
    if (href === "/review") return counts.review || null;
    if (href === "/conversations") return counts.replies || null;
    if (href === "/followups") return counts.followups || null;
    return null;
  };

  const displayName = user.displayName || user.email || "Signed in";
  const currentSection = NAV.flatMap((group) => group.items).find((item) =>
    item.href === "/" ? pathname === "/" : pathname.startsWith(item.href),
  );

  return (
    <div className="app" data-collapsed={collapsed ? "true" : "false"}>
      <aside className={`sidebar${open ? " open" : ""}`}>
        <div className="brand">
          {collapsed ? (
            <BrandMark tone="dark" size={28} className="brand-collapsed-mark" />
          ) : (
            <BrandLockup tone="dark" size={30} subtitle="Knowledge-powered outreach" />
          )}
          <button
            className="sidebar-close"
            onClick={() => setOpen(false)}
            type="button"
            aria-label="Close navigation"
            title="Close menu"
          >
            <X size={15} />
          </button>
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
                    data-agent-nav={item.href}
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

      <button
        className="sidebar-scrim"
        type="button"
        aria-label="Close navigation"
        tabIndex={open ? 0 : -1}
        onClick={() => setOpen(false)}
      />

      <div className="main" data-refresh={refreshKey} data-agent-page>
        <header className="topbar">
          <button
            className="topbar-burger"
            onClick={() => setOpen((v) => !v)}
            type="button"
            aria-label={open ? "Close navigation" : "Open navigation"}
            aria-expanded={open}
            title="Navigation"
          >
            <MenuIcon size={17} />
          </button>
          <div className="topbar-crumb">
            <span className="topbar-crumb-muted">Knowrevo</span>
            <span className="topbar-crumb-sep">/</span>
            <span className="topbar-title">{currentSection?.label ?? "Dashboard"}</span>
          </div>
          <div className="topbar-spacer" />
          <div className="topbar-actions">
            {syncNote ? (
              <span className="topbar-note" title={syncNote}>
                {syncNote}
              </span>
            ) : null}

            <div className="topbar-group" aria-label="Workspace actions">
            {!workspaceReady ? null : workspaceToken ? (
              <span
                className="badge"
                data-tone="ok"
                title={
                  workspacePersistent
                    ? `Connected${workspaceEmail ? ` as ${workspaceEmail}` : ""} - stays connected across reloads`
                    : `Connected${workspaceEmail ? ` as ${workspaceEmail}` : ""} for this session`
                }
              >
                <CheckCircle2 size={12} aria-hidden="true" />
                <span className="nowrap topbar-collapse">
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
                <Plug size={13} aria-hidden="true" />
                <span className="topbar-collapse">Connect Google</span>
              </button>
            )}
              <button
                className="btn btn-sm"
                onClick={() => void runSync()}
                disabled={syncing}
                type="button"
                aria-label={syncing ? "Syncing replies" : "Sync replies"}
                title="Sync replies from Gmail"
              >
                {syncing ? <BrandLoader size={13} /> : <RefreshCw size={13} aria-hidden="true" />}
                <span className="topbar-collapse">{syncing ? "Syncing…" : "Sync"}</span>
              </button>
            </div>

            <span className="topbar-sep" aria-hidden="true" />

            <div className="topbar-group" aria-label="Preferences">
              <ThemeToggle compact />

              <Menu
                label={`Notifications${counts.review + counts.replies + counts.followups > 0 ? ` (${counts.review + counts.replies + counts.followups})` : ""}`}
                trigger={
                  <>
                    <Bell size={16} aria-hidden="true" />
                    {counts.review + counts.replies + counts.followups > 0 ? (
                      <span className="menu-count">{counts.review + counts.replies + counts.followups}</span>
                    ) : null}
                  </>
                }
              >
                {(close) => (
                  <>
                    <div className="menu-heading">Needs attention</div>
                    <MenuItem href="/review" onClick={close} hint={counts.review ? String(counts.review) : "—"}>
                      <CheckSquare size={14} aria-hidden="true" /> Emails to review
                    </MenuItem>
                    <MenuItem href="/conversations" onClick={close} hint={counts.replies ? String(counts.replies) : "—"}>
                      <MessageSquare size={14} aria-hidden="true" /> Replies
                    </MenuItem>
                    <MenuItem href="/followups" onClick={close} hint={counts.followups ? String(counts.followups) : "—"}>
                      <Clock size={14} aria-hidden="true" /> Follow-ups due
                    </MenuItem>
                  </>
                )}
              </Menu>

              <Menu label="More actions" trigger={<MoreHorizontal size={17} aria-hidden="true" />}>
                {(close) => (
                  <>
                    <MenuItem href="/integrations" onClick={close}>
                      <Plug size={14} aria-hidden="true" /> Integrations
                    </MenuItem>
                    <MenuItem href="/settings" onClick={close}>
                      <Settings size={14} aria-hidden="true" /> Settings
                    </MenuItem>
                    <MenuSeparator />
                    <MenuItem
                      onClick={() => {
                        close();
                        void runSync();
                      }}
                    >
                      <RefreshCw size={14} aria-hidden="true" /> Sync replies
                    </MenuItem>
                    <MenuItem
                      onClick={() => {
                        close();
                        void reconnectWorkspace().then((ok) => {
                          if (ok) toast.success("Google reconnected", "Gmail and Sheets are ready again.");
                        });
                      }}
                    >
                      <Plug size={14} aria-hidden="true" />
                      {workspaceToken ? "Reconnect Google" : "Connect Google"}
                    </MenuItem>
                    {workspaceToken ? (
                      <MenuItem
                        tone="danger"
                        onClick={() => {
                          close();
                          void disconnectWorkspace().then(() => {
                            toast.info("Google disconnected", "Gmail and Sheets access was removed.");
                          });
                        }}
                      >
                        <LogOut size={14} aria-hidden="true" /> Disconnect Google
                      </MenuItem>
                    ) : null}
                  </>
                )}
              </Menu>

              <Menu
                label="Account"
                trigger={<span className="user-dot">{displayName.slice(0, 1).toUpperCase()}</span>}
                panelClassName="menu-panel-account"
              >
                {(close) => (
                  <>
                    <div className="menu-account">
                      <strong>{displayName}</strong>
                      <span>{user.email}</span>
                    </div>
                    <MenuSeparator />
                    <MenuItem href="/settings" onClick={close}>
                      <Settings size={14} aria-hidden="true" /> Settings
                    </MenuItem>
                    <MenuItem
                      tone="danger"
                      onClick={() => {
                        close();
                        void signOut();
                      }}
                    >
                      <LogOut size={14} aria-hidden="true" /> Sign out
                    </MenuItem>
                  </>
                )}
              </Menu>
            </div>
          </div>
        </header>

        {workspaceIssue && (
          <div style={{ padding: "12px 28px 0" }}>
            <WorkspaceIssueNotice />
          </div>
        )}

        <PageMotion>{children}</PageMotion>
      </div>

      <button
        type="button"
        className="operator-fab"
        data-open={chatOpen ? "true" : "false"}
        onClick={() => setChatOpen((value) => !value)}
        aria-label={chatOpen ? "Close the operator" : "Open the operator"}
        aria-expanded={chatOpen}
        title={chatOpen ? "Close the operator" : "Operator"}
      >
        {chatOpen ? <X size={20} aria-hidden="true" /> : <Bot size={22} aria-hidden="true" />}
        {!chatOpen && <span className="operator-fab-dot" aria-hidden="true" />}
      </button>

      <DashboardChat
        open={chatOpen}
        onClose={() => setChatOpen(false)}
        onDataMutated={() => setRefreshKey((k) => k + 1)}
      />

      {signals.length > 0 && (
        <div className="signal-stack" role="status" aria-live="polite">
          {signals.map((signal) => (
            <div key={signal.id} className="signal-toast" data-kind={signal.kind}>
              <span className="signal-toast-icon">
                {signal.kind === "open" ? <MousePointerClick size={14} /> : <MessageSquare size={14} />}
              </span>
              <div>
                <strong>{signal.title}</strong>
                <span>{signal.detail}</span>
              </div>
              <button
                type="button"
                aria-label="Dismiss notification"
                onClick={() => setSignals((current) => current.filter((item) => item.id !== signal.id))}
              >
                ×
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
