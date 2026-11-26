"use client";

import { useCallback, useEffect, useState } from "react";
import { Activity, BarChart3, Brain, CheckSquare, Cpu, Lock, Shield, Users } from "lucide-react";
import { useAuth } from "@/components/AuthProvider";
import { BrandLoader } from "@/components/BrandLoader";
import { Badge, Banner, Card } from "@/components/ui";
import { adminFetch } from "@/components/admin/admin-client";
import { Admin2faGate, AdminReauthModal, type TwoFaStatusPayload } from "@/components/admin/Admin2faGate";
import { AdminOverviewTab } from "@/components/admin/AdminOverviewTab";
import { AdminUsersTab } from "@/components/admin/AdminUsersTab";
import { AdminProvidersTab } from "@/components/admin/AdminProvidersTab";
import { AdminGlobalKnowledgeTab } from "@/components/admin/AdminGlobalKnowledgeTab";
import { AdminAuditAndNoticesTab } from "@/components/admin/AdminAuditAndNoticesTab";
import { AdminSystemCheckTab } from "@/components/admin/AdminSystemCheckTab";

type AdminTab = "overview" | "users" | "providers" | "global_knowledge" | "audit" | "system_check";

export default function AdminPage() {
  const { user } = useAuth();

  const [checking, setChecking] = useState(true);
  const [forbidden, setForbidden] = useState<string | null>(null);
  const [twoFaStatus, setTwoFaStatus] = useState<TwoFaStatusPayload | null>(null);
  const [sessionToken, setSessionToken] = useState<string | null>(null);
  const [reauthToken, setReauthToken] = useState<string | null>(null);

  const [activeTab, setActiveTab] = useState<AdminTab>("overview");
  const [reauthModal, setReauthModal] = useState<{
    open: boolean;
    label: string;
    pendingFn: ((token: string) => Promise<void>) | null;
  }>({ open: false, label: "", pendingFn: null });

  const loadGate = useCallback(async (tok?: string | null) => {
    setChecking(true);
    setForbidden(null);
    try {
      const res = await adminFetch<TwoFaStatusPayload>("/api/admin/2fa", {
        sessionToken: tok ?? sessionToken,
      });
      setTwoFaStatus(res);
    } catch (err) {
      setForbidden(err instanceof Error ? err.message : "Admin access denied.");
    } finally {
      setChecking(false);
    }
  }, [sessionToken]);

  useEffect(() => {
    const t = window.setTimeout(() => void loadGate(null), 0);
    return () => window.clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user.uid]);

  const handleNeedReauth = (label: string, retryFn: (freshToken: string) => Promise<void>) => {
    setReauthModal({ open: true, label, pendingFn: retryFn });
  };

  if (checking && !twoFaStatus && !forbidden) {
    return (
      <main className="page">
        <BrandLoader fullScreen />
      </main>
    );
  }

  if (forbidden || !twoFaStatus) {
    return (
      <main className="page" style={{ maxWidth: 620, margin: "32px auto" }}>
        <Card title="Administrator Access Required" sub="Server-enforced access control">
          <Banner tone="bad">{forbidden || "You do not have permission to view the Admin Dashboard."}</Banner>
        </Card>
      </main>
    );
  }

  if (!twoFaStatus.totpEnabled || !twoFaStatus.sessionValid || !sessionToken) {
    return (
      <Admin2faGate
        status={twoFaStatus}
        onUnlocked={(sTok, rTok) => {
          setSessionToken(sTok);
          if (rTok) setReauthToken(rTok);
          setTwoFaStatus((prev) => (prev ? { ...prev, totpEnabled: true, sessionValid: true } : prev));
        }}
      />
    );
  }

  const role = twoFaStatus.role;
  const canManageProviders = role === "super_admin" || role === "admin";

  return (
    <main className="page">
      <div className="page-head">
        <div>
          <div className="page-eyebrow">Platform Administration</div>
          <h1 className="page-title">Admin Dashboard</h1>
          <p className="page-sub">
            Manage platform users, live telemetry, encrypted AI provider keys, model policies, and immutable audit logs.
          </p>
        </div>

        <div className="row-end" style={{ gap: 8, flexWrap: "wrap" }}>
          <Badge tone="ok">
            <Shield size={11} style={{ marginRight: 4 }} />
            Role: {role.replace("_", " ").toUpperCase()}
          </Badge>
          <Badge tone="info">
            <Lock size={11} style={{ marginRight: 4 }} />
            2FA Verified
          </Badge>
        </div>
      </div>

      {/* Tab Navigation */}
      <div className="row" style={{ gap: 8, flexWrap: "wrap", marginBottom: 18 }}>
        <button
          type="button"
          className={`btn btn-sm ${activeTab === "overview" ? "btn-primary" : ""}`}
          onClick={() => setActiveTab("overview")}
        >
          <BarChart3 size={13} /> Overview &amp; Health
        </button>
        <button
          type="button"
          className={`btn btn-sm ${activeTab === "users" ? "btn-primary" : ""}`}
          onClick={() => setActiveTab("users")}
        >
          <Users size={13} /> Users
        </button>
        {canManageProviders && (
          <button
            type="button"
            className={`btn btn-sm ${activeTab === "providers" ? "btn-primary" : ""}`}
            onClick={() => setActiveTab("providers")}
          >
            <Cpu size={13} /> Providers &amp; Models
          </button>
        )}
        <button
          type="button"
          className={`btn btn-sm ${activeTab === "global_knowledge" ? "btn-primary" : ""}`}
          onClick={() => setActiveTab("global_knowledge")}
        >
          <Brain size={13} /> Global Brain
        </button>
        <button
          type="button"
          className={`btn btn-sm ${activeTab === "audit" ? "btn-primary" : ""}`}
          onClick={() => setActiveTab("audit")}
        >
          <Activity size={13} /> Audit Log &amp; Notices
        </button>
        <button
          type="button"
          className={`btn btn-sm ${activeTab === "system_check" ? "btn-primary" : ""}`}
          onClick={() => setActiveTab("system_check")}
        >
          <CheckSquare size={13} /> System Check
        </button>
      </div>

      {activeTab === "overview" && (
        <AdminOverviewTab role={role} sessionToken={sessionToken} />
      )}
      {activeTab === "users" && (
        <AdminUsersTab
          role={role}
          sessionToken={sessionToken}
          reauthToken={reauthToken}
          onNeedReauth={handleNeedReauth}
        />
      )}
      {activeTab === "providers" && canManageProviders && (
        <AdminProvidersTab
          role={role}
          sessionToken={sessionToken}
          reauthToken={reauthToken}
          onNeedReauth={handleNeedReauth}
        />
      )}
      {activeTab === "global_knowledge" && (
        <AdminGlobalKnowledgeTab
          role={role}
          sessionToken={sessionToken}
          reauthToken={reauthToken}
          onNeedReauth={handleNeedReauth}
        />
      )}
      {activeTab === "audit" && (
        <AdminAuditAndNoticesTab role={role} sessionToken={sessionToken} />
      )}
      {activeTab === "system_check" && (
        <AdminSystemCheckTab role={role} sessionToken={sessionToken} />
      )}

      <AdminReauthModal
        open={reauthModal.open}
        actionLabel={reauthModal.label}
        sessionToken={sessionToken}
        onClose={() => setReauthModal({ open: false, label: "", pendingFn: null })}
        onVerified={async (freshToken) => {
          setReauthToken(freshToken);
          const fn = reauthModal.pendingFn;
          setReauthModal({ open: false, label: "", pendingFn: null });
          if (fn) await fn(freshToken);
        }}
      />
    </main>
  );
}
