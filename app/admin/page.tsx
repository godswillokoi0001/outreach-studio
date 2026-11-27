"use client";

import { useCallback, useEffect, useState } from "react";
import {
  Activity,
  BarChart3,
  Cpu,
  HeartPulse,
  Lock,
  LogOut,
  Megaphone,
  Menu,
  Shield,
  Sliders,
  Users,
  X,
} from "lucide-react";
import { BrandLoader } from "@/components/BrandLoader";
import { BrandLockup } from "@/components/BrandMark";
import { ThemeToggle } from "@/components/ThemeToggle";
import { Badge } from "@/components/ui";
import { AdminReauthModal } from "@/components/admin/Admin2faGate";
import { AdminAdvancedTab } from "@/components/admin/AdminAdvancedTab";
import { AdminAuditAndNoticesTab } from "@/components/admin/AdminAuditAndNoticesTab";
import { AdminHealthTab } from "@/components/admin/AdminHealthTab";
import {
  AdminLoginScreen,
  type AuthenticatedAdminSummary,
} from "@/components/admin/AdminLoginScreen";
import { AdminOverviewTab } from "@/components/admin/AdminOverviewTab";
import { AdminProvidersTab } from "@/components/admin/AdminProvidersTab";
import { AdminUsersTab } from "@/components/admin/AdminUsersTab";

type AdminSection =
  | "overview"
  | "users"
  | "providers"
  | "health"
  | "announcements"
  | "audit"
  | "advanced";

export default function AdminPage() {
  const [checking, setChecking] = useState(true);
  const [admin, setAdmin] = useState<AuthenticatedAdminSummary | null>(null);
  const [challenge, setChallenge] = useState<{
    pending: boolean;
    totpEnabled?: boolean;
    setup?: { secret: string; otpauthUri: string };
  }>({ pending: false });
  const [reauthActive, setReauthActive] = useState(false);

  const [section, setSection] = useState<AdminSection>("overview");
  const [mobileNavOpen, setMobileNavOpen] = useState(false);
  const [reauthModal, setReauthModal] = useState<{
    open: boolean;
    label: string;
    pendingFn: ((token: string) => Promise<void>) | null;
  }>({ open: false, label: "", pendingFn: null });

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
        setup?: { secret: string; otpauthUri: string };
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
          setup: data.setup,
        });
      }
    } finally {
      setChecking(false);
    }
  }, []);

  useEffect(() => {
    const t = window.setTimeout(() => {
      void checkSession();
    }, 0);
    return () => window.clearTimeout(t);
  }, [checkSession]);

  const handleLogout = async () => {
    await fetch("/api/admin/auth/logout", {
      method: "POST",
      credentials: "same-origin",
    }).catch(() => {});
    setAdmin(null);
    setReauthActive(false);
    setChallenge({ pending: false });
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

  const canManageProviders = admin.role === "super_admin" || admin.role === "admin";
  const navItems: { id: AdminSection; label: string; icon: React.ComponentType<{ size?: number; className?: string }> }[] = [
    { id: "overview", label: "Overview", icon: BarChart3 },
    { id: "users", label: "Users", icon: Users },
    ...(canManageProviders ? [{ id: "providers" as const, label: "Providers & Models", icon: Cpu }] : []),
    { id: "health", label: "System Health", icon: HeartPulse },
    { id: "announcements", label: "Announcements", icon: Megaphone },
    { id: "audit", label: "Audit Log", icon: Activity },
    { id: "advanced", label: "Advanced", icon: Sliders },
  ];

  const activeLabel = navItems.find((item) => item.id === section)?.label ?? "Overview";

  return (
    <div className="app">
      <aside className={`sidebar ${mobileNavOpen ? "open" : ""}`}>
        <div className="brand" style={{ justifyContent: "space-between" }}>
          <BrandLockup tone="dark" subtitle="Admin Console" />
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
          {navItems.map((item) => {
            const Icon = item.icon;
            const isActive = section === item.id;
            return (
              <button
                key={item.id}
                type="button"
                className={`nav-link ${isActive ? "active" : ""}`}
                aria-current={isActive ? "page" : undefined}
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
          <div className="tiny">{admin.email}</div>
          <div className="row" style={{ gap: 6, justifyContent: "space-between" }}>
            <Badge tone="info">{admin.role.replace("_", " ").toUpperCase()}</Badge>
            <button
              type="button"
              className="btn btn-ghost btn-sm sidebar-signout"
              onClick={() => void handleLogout()}
            >
              <LogOut size={13} /> Sign out
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
        <header className="topbar">
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

          <Badge tone="ok">
            <Shield size={11} style={{ marginRight: 4 }} />
            {admin.role.replace("_", " ").toUpperCase()}
          </Badge>
          <Badge tone="info">
            <Lock size={11} style={{ marginRight: 4 }} />
            Session Active
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

          {section === "overview" && <AdminOverviewTab role={admin.role} sessionToken="cookie" />}
          {section === "users" && (
            <AdminUsersTab
              role={admin.role}
              sessionToken="cookie"
              reauthToken={reauthActive ? "cookie" : null}
              onNeedReauth={handleNeedReauth}
            />
          )}
          {section === "providers" && canManageProviders && (
            <AdminProvidersTab
              role={admin.role}
              sessionToken="cookie"
              reauthToken={reauthActive ? "cookie" : null}
              onNeedReauth={handleNeedReauth}
            />
          )}
          {section === "health" && <AdminHealthTab role={admin.role} />}
          {section === "announcements" && (
            <AdminAuditAndNoticesTab role={admin.role} sessionToken="cookie" mode="announcements" />
          )}
          {section === "audit" && (
            <AdminAuditAndNoticesTab role={admin.role} sessionToken="cookie" mode="audit" />
          )}
          {section === "advanced" && (
            <AdminAdvancedTab
              role={admin.role}
              currentAdminId={admin.id}
              sessionToken="cookie"
              reauthToken={reauthActive ? "cookie" : null}
              onNeedReauth={handleNeedReauth}
            />
          )}
        </main>
      </div>

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
