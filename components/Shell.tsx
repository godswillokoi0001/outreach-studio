"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import {
  useCallback,
  useEffect,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from "react";
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
  TrendingUp,
  Users,
  X,
} from "lucide-react";
import { AnimatePresence, motion } from "framer-motion";
import { initAiConfig } from "@/lib/ai-client";
import { errorMessage, authedGet } from "@/lib/client";
import type { OnboardingState } from "@/lib/onboarding";
import { getOnboardingState, subscribeBadgeCounts, subscribeOpenEvents } from "@/lib/store";
import {
  emptySignalMarks,
  getSignalMarks,
  isSignalNew,
  markSignal,
  readSignalMarks,
  subscribeSignalMarks,
  writeSignalMarks,
  type SignalKind,
} from "@/lib/signals";
import { runSendBatch, runSyncBatch } from "@/lib/pipeline-client";
import { useAuth } from "./AuthProvider";
import type { ClientAnnouncement } from "@/lib/auth";
import { BrandLoader } from "./BrandLoader";
import { BrandLockup, BrandMark } from "./BrandMark";
import { Menu, MenuItem, MenuSeparator } from "./Menu";
import { ThemeToggle } from "./ThemeToggle";
import { DashboardChat } from "./DashboardChat";
import { BackgroundJobsBar } from "./BackgroundJobsBar";
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
      { href: "/growth-advisor", label: "Growth Advisor", icon: TrendingUp },
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
  const router = useRouter();
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
  const [latest, setLatest] = useState<{ open: string; reply: string }>({ open: "", reply: "" });
  const [onboardingChecked, setOnboardingChecked] = useState(() => Boolean(user.onboardingStatus));
  const [onboardingDone, setOnboardingDone] = useState(() => user.onboardingStatus === "completed");
  const [dismissedAnnouncementIds, setDismissedAnnouncementIds] = useState<string[]>([]);
  const uid = user?.uid ?? "";

  const storedAnnouncementsRaw = useSyncExternalStore(
    () => () => {},
    () => {
      try {
        return window.sessionStorage.getItem("os:announcements") ?? "[]";
      } catch {
        return "[]";
      }
    },
    () => "[]",
  );
  const announcements: ClientAnnouncement[] = (() => {
    try {
      const parsed = JSON.parse(storedAnnouncementsRaw) as ClientAnnouncement[];
      return Array.isArray(parsed)
        ? parsed.filter((a) => !dismissedAnnouncementIds.includes(a.id))
        : [];
    } catch {
      return [];
    }
  })();

  const isOnboardingRoute = pathname === "/onboarding" || pathname.startsWith("/onboarding/");

  useEffect(() => {
    if (!uid) return;
    let active = true;
    authedGet<{ state: OnboardingState }>("/api/onboarding/state")
      .then((res) => res.state)
      .catch(() => getOnboardingState(uid, user))
      .then((state) => {
        if (!active) return;
        const done = state.status === "completed";
        setOnboardingDone(done);
        setOnboardingChecked(true);
        if (!done && !isOnboardingRoute) {
          router.replace("/onboarding");
        }
      })
      .catch(() => {
        if (!active) return;
        setOnboardingChecked(true);
      });
    return () => {
      active = false;
    };
  }, [uid, user, isOnboardingRoute, router]);

  useEffect(() => {
    const onDone = () => {
      setOnboardingDone(true);
      setOnboardingChecked(true);
    };
    window.addEventListener("knowrevo:onboarding-completed", onDone);
    return () => window.removeEventListener("knowrevo:onboarding-completed", onDone);
  }, []);
  // What this browser has already announced and already looked at, so a
  // notification appears once and stays marked seen until something new lands.
  const marks = useSyncExternalStore(
    useCallback((onChange: () => void) => subscribeSignalMarks(uid, onChange), [uid]),
    useCallback(() => getSignalMarks(uid), [uid]),
    () => null,
  );

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

  const pushSignal = useCallback((signal: Omit<SignalToast, "id">) => {
    const id = `${signal.kind}_${Date.now()}`;
    setSignals((current) => [...current.slice(-2), { ...signal, id }]);
    window.setTimeout(() => {
      setSignals((current) => current.filter((item) => item.id !== id));
    }, 9000);
  }, []);

  // Each signal is announced once. `at` is the newest event we know about; if a
  // toast was already shown for that moment or later, this call stays quiet.
  const announce = useCallback(
    (kind: SignalKind, at: string, title: string, detail: string) => {
      if (!uid || !at) return;
      setLatest((current) => (at > current[kind] ? { ...current, [kind]: at } : current));
      const current = getSignalMarks(uid);
      if (!current) return;
      const field = kind === "open" ? "open_notified" : "reply_notified";
      if (at <= current[field]) return;
      pushSignal({ kind, title, detail });
      markSignal(uid, kind, "notified", at);
    },
    [uid, pushSignal],
  );

  // First run on this browser adopts whatever already exists as seen, so a
  // page reload never re-announces old activity.
  useEffect(() => {
    if (!uid || readSignalMarks(uid)) return;
    writeSignalMarks(uid, emptySignalMarks());
  }, [uid]);

  useEffect(() => {
    if (!user?.uid) return;
    const unsub = subscribeBadgeCounts(user.uid, (next) => {
      setCounts({ review: next.review, replies: next.replies, followups: next.followups });
      announce(
        "reply",
        next.latestReplyAt,
        "A prospect replied",
        "Open Conversations to read it and send the suggested answer.",
      );
    });
    return () => unsub();
  }, [user?.uid, announce]);

  // Open tracking: tell the operator once, the first time an email is read.
  useEffect(() => {
    if (!user?.uid) return;
    const unsub = subscribeOpenEvents(user.uid, (_events, latestOpen) => {
      if (!latestOpen) return;
      announce(
        "open",
        latestOpen.opened_at,
        "An email was just opened",
        `${new Date(latestOpen.opened_at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })} · see which send in Sent emails.`,
      );
    });
    return () => unsub();
  }, [user?.uid, announce]);

  // Opening the screen that lists an activity marks it seen. A later event
  // moves the "new" mark again, so it is flagged once more.
  useEffect(() => {
    if (!uid) return;
    const kind: SignalKind | null = pathname.startsWith("/sent")
      ? "open"
      : pathname.startsWith("/conversations")
        ? "reply"
        : null;
    if (!kind) return;
    const at = (kind === "open" ? latest.open : latest.reply) || new Date().toISOString();
    markSignal(uid, kind, "seen", at);
  }, [pathname, uid, latest.open, latest.reply]);

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

  // "new" while activity is unread, otherwise "seen" — with the work count
  // kept for replies, because those still need an answer.
  const signalHint = (kind: SignalKind, count = 0): string => {
    const fresh = isSignalNew(marks, kind, kind === "open" ? latest.open : latest.reply);
    if (fresh) return "new";
    if (count > 0) return `${count} · seen`;
    return "seen";
  };

  const displayName = user.displayName || user.email || "Signed in";
  const currentSection = NAV.flatMap((group) => group.items).find((item) =>
    item.href === "/" ? pathname === "/" : pathname.startsWith(item.href),
  );

  // Distraction-free onboarding wrapper (no header bar, no sidebar, no chatbot icon — zero flash on enter or exit).
  if (isOnboardingRoute) {
    return (
      <div
        style={{
          minHeight: "100dvh",
          background: "var(--canvas, var(--bg))",
          display: "flex",
          flexDirection: "column",
        }}
      >
        <div
          style={{
            display: "flex",
            justifyContent: "center",
            alignItems: "center",
            padding: "20px 16px 4px",
          }}
        >
          <BrandLockup tone="brand" size={24} />
        </div>
        <div style={{ flex: 1, paddingBottom: 40 }}>{children}</div>
      </div>
    );
  }

  // Never flash dashboard chrome or chatbot before onboarding status is verified for new sign-ups.
  if (!onboardingChecked || !onboardingDone) {
    return <BrandLoader fullScreen />;
  }

  return (
    <div className="app" data-collapsed={collapsed ? "true" : "false"}>
      <aside className={`sidebar${open ? " open" : ""}`}>
        <div className="brand">
          {collapsed ? (
            <BrandMark tone="dark" size={22} className="brand-collapsed-mark" />
          ) : (
            <BrandLockup tone="dark" size={24} subtitle="Knowledge-powered outreach" />
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
                <RefreshCw size={13} aria-hidden="true" />
                <span className="topbar-collapse">{syncing ? "Syncing…" : "Sync"}</span>
              </button>
            </div>

            <span className="topbar-sep" aria-hidden="true" />

            <div className="topbar-group" aria-label="Preferences">
              <BackgroundJobsBar uid={uid} />
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
                    <MenuItem
                      href="/conversations"
                      onClick={close}
                      hint={signalHint("reply", counts.replies)}
                    >
                      <MessageSquare size={14} aria-hidden="true" /> Replies
                    </MenuItem>
                    <MenuItem href="/followups" onClick={close} hint={counts.followups ? String(counts.followups) : "—"}>
                      <Clock size={14} aria-hidden="true" /> Follow-ups due
                    </MenuItem>
                    <MenuSeparator />
                    <div className="menu-heading">Activity</div>
                    <MenuItem href="/sent" onClick={close} hint={signalHint("open")}>
                      <MousePointerClick size={14} aria-hidden="true" /> Email opens
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

        {announcements.length > 0 && (
          <div style={{ padding: "12px 28px 0" }} className="stack">
            {announcements.map((ann) => (
              <div key={ann.id} className="banner" data-tone={ann.tone}>
                <div className="row" style={{ justifyContent: "space-between", alignItems: "flex-start", gap: 10 }}>
                  <div>
                    <strong style={{ display: "block", fontSize: 13 }}>{ann.title}</strong>
                    <span className="tiny">{ann.message}</span>
                  </div>
                  <button
                    type="button"
                    className="btn btn-sm btn-ghost"
                    onClick={() => setDismissedAnnouncementIds((prev) => [...prev, ann.id])}
                    aria-label="Dismiss announcement"
                  >
                    <X size={13} />
                  </button>
                </div>
              </div>
            ))}
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
