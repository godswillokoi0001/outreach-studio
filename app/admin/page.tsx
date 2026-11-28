"use client";

import { useCallback, useEffect, useState } from "react";
import {
  Activity,
  BarChart3,
  Bell,
  Bot,
  Brain,
  Cpu,
  Database,
  HeartPulse,
  Lock,
  LogOut,
  Megaphone,
  Menu,
  PanelLeftClose,
  PanelLeftOpen,
  Shield,
  ShieldCheck,
  Users,
  X,
} from "lucide-react";
import { BrandLoader } from "@/components/BrandLoader";
import { BrandLockup, BrandMark } from "@/components/BrandMark";
import { ThemeToggle } from "@/components/ThemeToggle";
import { Badge } from "@/components/ui";
import type { AdminNotificationRecord } from "@/lib/platform/notifications";
import { AdminReauthModal } from "@/components/admin/Admin2faGate";
import { AdminAssistantDrawer } from "@/components/admin/AdminAssistantDrawer";
import { AdminAuditAndNoticesTab } from "@/components/admin/AdminAuditAndNoticesTab";
import { AdminCleanupTab } from "@/components/admin/AdminCleanupTab";
import { AdminGlobalKnowledgeTab } from "@/components/admin/AdminGlobalKnowledgeTab";
import { AdminHealthTab } from "@/components/admin/AdminHealthTab";
import {
  AdminLoginScreen,
  type AuthenticatedAdminSummary,
} from "@/components/admin/AdminLoginScreen";
import { AdminNotificationsTab } from "@/components/admin/AdminNotificationsTab";
import { AdminOverviewTab } from "@/components/admin/AdminOverviewTab";
import { AdminProvidersTab } from "@/components/admin/AdminProvidersTab";
import { AdminSecurityTab } from "@/components/admin/AdminSecurityTab";
import { AdminSystemCheckTab } from "@/components/admin/AdminSystemCheckTab";
import { AdminUsersTab } from "@/components/admin/AdminUsersTab";
import { adminFetch } from "@/components/admin/admin-client";
import { MobileHeader } from "@/components/mobile/MobileHeader";
import { AdminTabBar } from "@/components/mobile/AdminTabBar";
import { AdminMenuSheet } from "@/components/mobile/AdminMenuSheet";

type AdminSection =
  | "overview"
  | "notifications"
  | "users"
  | "providers"
  | "health"
  | "cleanup"
  | "announcements"
  | "audit"
  | "brain"
  | "security";

const ADMIN_COLLAPSE_KEY = "os:admin:nav:collapsed";

export default function AdminPage() {
  const [checking, setChecking] = useState(true);
  const [admin, setAdmin] = useState<AuthenticatedAdminSummary | null>(null);
  const [challenge, setChallenge] = useState<{
    pending: boolean;
    totpEnabled?: boolean;
    role?: "super_admin" | "admin" | "support";
    email?: string;
    setup?: { secret: string; otpauthUri: string; qrDataUrl?: string };
  }>({ pending: false });
  const [reauthActive, setReauthActive] = useState(false);

  const [section, setSection] = useState<AdminSection>("overview");
  const [mobileNavOpen, setMobileNavOpen] = useState(false);
  const [collapsed, setCollapsed] = useState(false);
  const [unreadCount, setUnreadCount] = useState(0);
  const [recentUnread, setRecentUnread] = useState<AdminNotificationRecord[]>([]);
  const [bellOpen, setBellOpen] = useState(false);
  const [assistantOpen, setAssistantOpen] = useState(false);
  const [assistantPrompt, setAssistantPrompt] = useState<string | null>(null);
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);

  const [reauthModal, setReauthModal] = useState<{
    open: boolean;
    label: string;
    pendingFn: ((token: string) => Promise<void>) | null;
  }>({ open: false, label: "", pendingFn: null });

  useEffect(() => {
    const t = window.setTimeout(() => {
      try {
        setCollapsed(window.localStorage.getItem(ADMIN_COLLAPSE_KEY) === "1");
      } catch {
        /* ignore */
      }
    }, 0);
    return () => window.clearTimeout(t);
  }, []);

  const toggleCollapsed = () => {
    setCollapsed((prev) => {
      const next = !prev;
      try {
        window.localStorage.setItem(ADMIN_COLLAPSE_KEY, next ? "1" : "0");
      } catch {
        /* ignore */
      }
      return next;
    });
  };

  const checkSession = useCallback(async () => {
    setChecking(true);
    try {
      const res = await fetch("/api/admin/auth/session", {
        credentials: "same-origin",
        cache: "no-store",
      });
      const data = (await res.json().catch(() => ({}))) as {
        authenticated?: boolean;
        admin?: AuthenticatedAdminSummary;
        challengePending?: boolean;
        totpEnabled?: boolean;
        role?: "super_admin" | "admin" | "support";
        email?: string;
        setup?: { secret: string; otpauthUri: string; qrDataUrl?: string };
      };
      if (data.authenticated && data.admin) {
        setAdmin(data.admin);
        setReauthActive(Boolean(data.admin.reauthActive));
        setChallenge({ pending: false });
      } else {
        setAdmin(null);
        setChallenge({
          pending: Boolean(data.challengePending),
          totpEnabled: data.totpEnabled,
          role: data.role,
          email: data.email,
          setup: data.setup,
        });
      }
    } finally {
      setChecking(false);
    }
  }, []);

  const loadNotificationsSummary = useCallback(async () => {
    if (!admin) return;
    try {
      const res = await adminFetch<{
        unreadCount: number;
        recentUnread: AdminNotificationRecord[];
      }>("/api/admin/notifications?page=1&pageSize=10&read=unread");
      setUnreadCount(res.unreadCount ?? 0);
      setRecentUnread(res.recentUnread ?? []);
    } catch {
      /* non-blocking */
    }
  }, [admin]);

  useEffect(() => {
    const t = window.setTimeout(() => {
      void checkSession();
    }, 0);
    return () => window.clearTimeout(t);
  }, [checkSession]);

  useEffect(() => {
    if (!admin) return;
    const t = window.setTimeout(() => {
      void loadNotificationsSummary();
    }, 0);
    const timer = window.setInterval(() => {
      void loadNotificationsSummary();
    }, 60_000);
    return () => {
      window.clearTimeout(t);
      window.clearInterval(timer);
    };
  }, [admin, loadNotificationsSummary]);

  const handleLogout = async () => {
    await fetch("/api/admin/auth/logout", {
      method: "POST",
      credentials: "same-origin",
    }).catch(() => {});
    setAdmin(null);
    setReauthActive(false);
    setChallenge({ pending: false });
    setAssistantOpen(false);
  };

  const handleNeedReauth = (label: string, retryFn: (freshToken: string) => Promise<void>) => {
    setReauthModal({ open: true, label, pendingFn: retryFn });
  };

  if (checking) {
    return <BrandLoader fullScreen />;
  }

  if (!admin) {
    return (
      <AdminLoginScreen
        initialChallenge={challenge}
        onSignedIn={(signedIn) => {
          setAdmin(signedIn);
          setReauthActive(true);
          setChallenge({ pending: false });
        }}
      />
    );
  }

  const canManageOps = admin.role === "super_admin" || admin.role === "admin";
  const operationsItems: {
    id: AdminSection;
    label: string;
    icon: React.ComponentType<{ size?: number; className?: string }>;
    count?: number;
  }[] = [
    { id: "overview", label: "Overview", icon: BarChart3 },
    { id: "notifications", label: "Notifications", icon: Bell, count: unreadCount || undefined },
    { id: "users", label: "Users", icon: Users },
    ...(canManageOps ? [{ id: "providers" as const, label: "Providers & Models", icon: Cpu }] : []),
    { id: "health", label: "Check & Diagnostics", icon: HeartPulse },
    ...(canManageOps ? [{ id: "cleanup" as const, label: "Cleanup Tool", icon: Database }] : []),
    { id: "announcements", label: "Announcements", icon: Megaphone },
    { id: "audit", label: "Audit Log", icon: Activity },
    ...(canManageOps ? [{ id: "brain" as const, label: "Global Brain", icon: Brain }] : []),
  ];

  const securityItems: {
    id: AdminSection;
    label: string;
    icon: React.ComponentType<{ size?: number; className?: string }>;
  }[] = [{ id: "security", label: "Security", icon: ShieldCheck }];

  const allItems = [...operationsItems, ...securityItems];
  const activeLabel = allItems.find((item) => item.id === section)?.label ?? "Overview";

  return (
    <div className="app" data-collapsed={collapsed ? "true" : "false"}>
      <aside className={`sidebar ${mobileNavOpen ? "open" : ""}`}>
        <div className="brand" style={{ justifyContent: "space-between" }}>
          {collapsed ? <BrandMark size={24} tone="dark" /> : <BrandLockup tone="dark" subtitle="Admin Console" />}
          <button
            type="button"
            className="sidebar-toggle"
            onClick={toggleCollapsed}
            title={collapsed ? "Expand sidebar" : "Collapse sidebar"}
            aria-label={collapsed ? "Expand sidebar" : "Collapse sidebar"}
            aria-expanded={!collapsed}
          >
            {collapsed ? <PanelLeftOpen size={14} /> : <PanelLeftClose size={14} />}
          </button>
          <button
            type="button"
            className="sidebar-close"
            onClick={() => setMobileNavOpen(false)}
            aria-label="Close navigation"
            title="Close menu"
          >
            <X size={15} />
          </button>
        </div>

        <nav className="nav" aria-label="Admin navigation">
          <div className="nav-group-label">Operations</div>
          {operationsItems.map((item) => {
            const Icon = item.icon;
            const isActive = section === item.id;
            return (
              <button
                key={item.id}
                type="button"
                className={`nav-link ${isActive ? "active" : ""}`}
                aria-current={isActive ? "page" : undefined}
                title={collapsed ? item.label : undefined}
                onClick={() => {
                  setSection(item.id);
                  setMobileNavOpen(false);
                }}
              >
                <Icon className="nav-icon" size={16} aria-hidden="true" />
                <span className="nav-text">{item.label}</span>
                {typeof item.count === "number" && item.count > 0 && (
                  <span className="nav-count">{item.count}</span>
                )}
              </button>
            );
          })}

          <div className="nav-group-label">Security</div>
          {securityItems.map((item) => {
            const Icon = item.icon;
            const isActive = section === item.id;
            return (
              <button
                key={item.id}
                type="button"
                className={`nav-link ${isActive ? "active" : ""}`}
                aria-current={isActive ? "page" : undefined}
                title={collapsed ? item.label : undefined}
                onClick={() => {
                  setSection(item.id);
                  setMobileNavOpen(false);
                }}
              >
                <Icon className="nav-icon" size={16} aria-hidden="true" />
                <span className="nav-text">{item.label}</span>
              </button>
            );
          })}
        </nav>

        <div className="sidebar-foot stack">
          <div className="tiny sidebar-foot-meta">{admin.email}</div>
          <div className="row" style={{ gap: 6, justifyContent: "space-between" }}>
            <Badge tone="info">{admin.role.replace("_", " ").toUpperCase()}</Badge>
            <button
              type="button"
              className="btn btn-ghost btn-sm sidebar-signout"
              title="Sign out"
              onClick={() => void handleLogout()}
            >
              <LogOut size={13} />
              <span>Sign out</span>
            </button>
          </div>
        </div>
      </aside>

      <button
        type="button"
        className="sidebar-scrim"
        aria-label="Close navigation"
        tabIndex={mobileNavOpen ? 0 : -1}
        onClick={() => setMobileNavOpen(false)}
      />

      <div className="main">
        <MobileHeader
          title={activeLabel}
          backHref="/"
          end={
            <>
              <button
                type="button"
                className="m-icon-btn m-icon-btn-round"
                onClick={() => setSection("notifications")}
                aria-label="Admin notifications"
                style={{ position: "relative" }}
              >
                <Bell size={17} aria-hidden="true" />
                {unreadCount > 0 ? (
                  <span className="m-tab-badge" style={{ top: 2, right: 2 }}>
                    {unreadCount > 9 ? "9+" : unreadCount}
                  </span>
                ) : null}
              </button>
              <button
                type="button"
                className="m-icon-btn m-icon-btn-round"
                onClick={() => setMobileMenuOpen(true)}
                aria-label="Open admin menu"
                aria-expanded={mobileMenuOpen}
              >
                <Menu size={17} aria-hidden="true" />
              </button>
            </>
          }
        />

        <header className="topbar desktop-only">
          <button
            type="button"
            className="btn btn-ghost btn-sm menu-btn"
            onClick={() => setMobileNavOpen(true)}
            aria-label="Open menu"
          >
            <Menu size={18} />
          </button>
          <span className="topbar-title">{activeLabel}</span>
          <div className="topbar-spacer" />

          {/* Notifications Bell + Dropdown */}
          <div style={{ position: "relative" }}>
            <button
              type="button"
              className="btn btn-sm btn-ghost"
              aria-label="Admin notifications"
              title="Admin notifications"
              onClick={() => {
                setBellOpen((o) => !o);
                if (!bellOpen) void loadNotificationsSummary();
              }}
            >
              <Bell size={15} />
              {unreadCount > 0 && <Badge tone="bad">{unreadCount}</Badge>}
            </button>
            {bellOpen && (
              <div
                style={{
                  position: "absolute",
                  top: "calc(100% + 6px)",
                  right: 0,
                  width: 320,
                  maxWidth: "90vw",
                  padding: 12,
                  borderRadius: 12,
                  border: "1px solid var(--line)",
                  background: "var(--surface)",
                  boxShadow: "var(--shadow-card, 0 12px 30px rgba(0,0,0,0.16))",
                  zIndex: 55,
                }}
                className="stack"
              >
                <div className="row" style={{ justifyContent: "space-between" }}>
                  <strong className="tiny">Notifications ({unreadCount} unread)</strong>
                  <button
                    type="button"
                    className="btn btn-sm btn-ghost"
                    onClick={() => {
                      setBellOpen(false);
                      setSection("notifications");
                    }}
                  >
                    Open all
                  </button>
                </div>
                {recentUnread.length === 0 ? (
                  <div className="tiny muted">No unread platform alerts.</div>
                ) : (
                  recentUnread.slice(0, 5).map((n) => (
                    <button
                      key={n.id}
                      type="button"
                      onClick={() => {
                        setBellOpen(false);
                        setSection((n.targetTab as AdminSection) || "notifications");
                      }}
                      style={{
                        textAlign: "left",
                        padding: 8,
                        borderRadius: 8,
                        border: "1px solid var(--line-soft)",
                        background: "var(--surface-2)",
                        cursor: "pointer",
                      }}
                    >
                      <div className="tiny strong">{n.title}</div>
                      <div className="tiny muted">{n.message.slice(0, 90)}</div>
                    </button>
                  ))
                )}
              </div>
            )}
          </div>

          {/* Admin AI Debug Assistant Button */}
          {canManageOps && (
            <button
              type="button"
              className={`btn btn-sm ${assistantOpen ? "btn-primary" : ""}`}
              onClick={() => setAssistantOpen((o) => !o)}
              title="Open Platform Admin AI Assistant"
            >
              <Bot size={14} />
              <span>AI Assistant</span>
            </button>
          )}

          <Badge tone="ok">
            <Shield size={11} style={{ marginRight: 4 }} />
            {admin.role.replace("_", " ").toUpperCase()}
          </Badge>
          <Badge tone="info">
            <Lock size={11} style={{ marginRight: 4 }} />
            2FA Session
          </Badge>

          <ThemeToggle compact />
        </header>

        <main className="page">
          <div className="page-head">
            <div>
              <div className="page-eyebrow">Knowrevo Platform Administration</div>
              <h1 className="page-title">{activeLabel}</h1>
            </div>
          </div>

          {section === "overview" && (
            <AdminOverviewTab
              role={admin.role}
              sessionToken="cookie"
              reauthToken={reauthActive ? "cookie" : null}
              onNeedReauth={handleNeedReauth}
            />
          )}
          {section === "notifications" && (
            <AdminNotificationsTab
              role={admin.role}
              sessionToken="cookie"
              onUnreadCountChange={setUnreadCount}
              onNavigateTab={(tab) => setSection(tab as AdminSection)}
            />
          )}
          {section === "users" && (
            <AdminUsersTab
              role={admin.role}
              sessionToken="cookie"
              reauthToken={reauthActive ? "cookie" : null}
              onNeedReauth={handleNeedReauth}
            />
          )}
          {section === "providers" && canManageOps && (
            <AdminProvidersTab
              role={admin.role}
              sessionToken="cookie"
              reauthToken={reauthActive ? "cookie" : null}
              onNeedReauth={handleNeedReauth}
            />
          )}
          {section === "health" && (
            <div className="stack" style={{ gap: 20 }}>
              <AdminSystemCheckTab
                role={admin.role}
                sessionToken="cookie"
                reauthToken={reauthActive ? "cookie" : null}
                onNeedReauth={handleNeedReauth}
                onAskAiDiagnose={(prompt) => {
                  setAssistantPrompt(prompt);
                  setAssistantOpen(true);
                }}
              />
              <AdminHealthTab role={admin.role} />
            </div>
          )}
          {section === "cleanup" && canManageOps && (
            <AdminCleanupTab
              role={admin.role}
              sessionToken="cookie"
              reauthToken={reauthActive ? "cookie" : null}
              onNeedReauth={handleNeedReauth}
            />
          )}
          {section === "announcements" && (
            <AdminAuditAndNoticesTab role={admin.role} sessionToken="cookie" mode="announcements" />
          )}
          {section === "audit" && (
            <AdminAuditAndNoticesTab
              role={admin.role}
              sessionToken="cookie"
              reauthToken={reauthActive ? "cookie" : null}
              onNeedReauth={handleNeedReauth}
              mode="audit"
            />
          )}
          {section === "brain" && canManageOps && (
            <AdminGlobalKnowledgeTab
              role={admin.role}
              sessionToken="cookie"
              reauthToken={reauthActive ? "cookie" : null}
              onNeedReauth={handleNeedReauth}
            />
          )}
          {section === "security" && (
            <AdminSecurityTab
              admin={admin}
              reauthActive={reauthActive}
              sessionToken="cookie"
              onNeedReauth={handleNeedReauth}
              onLogout={handleLogout}
            />
          )}
        </main>
      </div>

      <AdminTabBar
        active={section}
        providersAllowed={canManageOps}
        menuOpen={mobileMenuOpen}
        onSelect={(next) => {
          setSection(next);
          setMobileMenuOpen(false);
        }}
        onMenu={() => setMobileMenuOpen((value) => !value)}
      />

      <AdminMenuSheet
        open={mobileMenuOpen}
        onClose={() => setMobileMenuOpen(false)}
        onSelect={(next) => setSection(next as AdminSection)}
        role={admin.role}
        email={admin.email}
        unreadCount={unreadCount}
        canManageOps={canManageOps}
        onSignOut={() => void handleLogout()}
      />

      {canManageOps && (
        <AdminAssistantDrawer
          open={assistantOpen}
          initialPrompt={assistantPrompt}
          onClearInitialPrompt={() => setAssistantPrompt(null)}
          onClose={() => setAssistantOpen(false)}
        />
      )}

      <AdminReauthModal
        open={reauthModal.open}
        actionLabel={reauthModal.label}
        sessionToken="cookie"
        onClose={() => setReauthModal({ open: false, label: "", pendingFn: null })}
        onVerified={async (freshToken) => {
          setReauthActive(true);
          const fn = reauthModal.pendingFn;
          setReauthModal({ open: false, label: "", pendingFn: null });
          if (fn) await fn(freshToken);
        }}
      />
    </div>
  );
}
