"use client";

import { useCallback, useEffect, useState } from "react";
import { KeyRound, Plus, Shield, UserCheck, UserX } from "lucide-react";
import { BrandLoader } from "@/components/BrandLoader";
import { Badge, Banner, Card, Field, Modal } from "@/components/ui";
import { useConfirm, useToast } from "@/components/Feedback";
import type { AdminRole } from "@/lib/platform/types";
import { AdminClientError, adminFetch } from "./admin-client";
import { AdminGlobalKnowledgeTab } from "./AdminGlobalKnowledgeTab";
import { AdminSystemCheckTab } from "./AdminSystemCheckTab";

interface AdminAccountPublic {
  id: string;
  email: string;
  name: string;
  role: AdminRole;
  status: "active" | "suspended";
  totpEnabled: boolean;
  lastLoginAt: string | null;
  lastLoginIp: string | null;
  createdBy: string | null;
  createdAt: string;
}

export function AdminAdvancedTab({
  role,
  currentAdminId,
  sessionToken,
  reauthToken,
  onNeedReauth,
}: {
  role: AdminRole;
  currentAdminId: string;
  sessionToken: string;
  reauthToken: string | null;
  onNeedReauth: (label: string, retryFn: (freshToken: string) => Promise<void>) => void;
}) {
  const isSuperAdmin = role === "super_admin";
  const toast = useToast();
  const confirmDialog = useConfirm();

  const [section, setSection] = useState<"accounts" | "brain" | "checks">(
    isSuperAdmin ? "accounts" : "brain",
  );
  const [accounts, setAccounts] = useState<AdminAccountPublic[]>([]);
  const [loadingAccounts, setLoadingAccounts] = useState(false);

  const [createOpen, setCreateOpen] = useState(false);
  const [newEmail, setNewEmail] = useState("");
  const [newName, setNewName] = useState("");
  const [newRole, setNewRole] = useState<AdminRole>("admin");
  const [newPassword, setNewPassword] = useState("");
  const [saving, setSaving] = useState(false);

  const loadAccounts = useCallback(async () => {
    if (!isSuperAdmin) return;
    setLoadingAccounts(true);
    try {
      const res = await adminFetch<{ accounts: AdminAccountPublic[] }>("/api/admin/auth/accounts");
      setAccounts(res.accounts ?? []);
    } catch (err) {
      toast.error("Could not load admin accounts", err instanceof Error ? err.message : "Error");
    } finally {
      setLoadingAccounts(false);
    }
  }, [isSuperAdmin, toast]);

  useEffect(() => {
    if (isSuperAdmin && section === "accounts") {
      const t = window.setTimeout(() => void loadAccounts(), 0);
      return () => window.clearTimeout(t);
    }
  }, [isSuperAdmin, section, loadAccounts]);

  const runAccountAction = async (
    label: string,
    payload: Record<string, unknown>,
    freshToken?: string,
  ) => {
    try {
      await adminFetch("/api/admin/auth/accounts", {
        method: "POST",
        reauthToken: freshToken ?? reauthToken,
        body: payload,
      });
      toast.success("Admin account updated");
      setCreateOpen(false);
      setNewEmail("");
      setNewName("");
      setNewPassword("");
      await loadAccounts();
    } catch (err) {
      if (err instanceof AdminClientError && err.code === "ADMIN_REAUTH_REQUIRED") {
        onNeedReauth(label, (t) => runAccountAction(label, payload, t));
        return;
      }
      toast.error("Action failed", err instanceof Error ? err.message : "Error");
    }
  };

  return (
    <div className="stack" style={{ gap: 16 }}>
      <div className="row" style={{ gap: 8, flexWrap: "wrap" }}>
        {isSuperAdmin && (
          <button
            type="button"
            className={`btn btn-sm ${section === "accounts" ? "btn-primary" : ""}`}
            onClick={() => setSection("accounts")}
          >
            <Shield size={13} /> Admin Accounts
          </button>
        )}
        <button
          type="button"
          className={`btn btn-sm ${section === "brain" ? "btn-primary" : ""}`}
          onClick={() => setSection("brain")}
        >
          Global Brain Modules
        </button>
        <button
          type="button"
          className={`btn btn-sm ${section === "checks" ? "btn-primary" : ""}`}
          onClick={() => setSection("checks")}
        >
          System Diagnostics
        </button>
      </div>

      {section === "accounts" && isSuperAdmin && (
        <Card
          title="Administrator Accounts"
          sub="Only Super Admins can create, suspend, or reset other administrator accounts."
          actions={
            <button type="button" className="btn btn-primary btn-sm" onClick={() => setCreateOpen(true)}>
              <Plus size={13} /> Create Admin Account
            </button>
          }
        >
          {loadingAccounts && accounts.length === 0 ? (
            <BrandLoader />
          ) : (
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>Admin</th>
                    <th>Role</th>
                    <th>Status</th>
                    <th>2FA</th>
                    <th>Last Sign In</th>
                    <th style={{ textAlign: "right" }}>Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {accounts.map((acc) => {
                    const isSelf = acc.id === currentAdminId;
                    return (
                      <tr key={acc.id}>
                        <td>
                          <div className="strong tiny">{acc.name}</div>
                          <div className="tiny muted">{acc.email}</div>
                        </td>
                        <td>
                          <Badge tone={acc.role === "super_admin" ? "info" : undefined}>
                            {acc.role.replace("_", " ")}
                          </Badge>
                        </td>
                        <td>
                          <Badge tone={acc.status === "active" ? "ok" : "bad"}>{acc.status}</Badge>
                        </td>
                        <td>
                          <Badge tone={acc.totpEnabled ? "ok" : "warn"}>
                            {acc.totpEnabled ? "Enabled" : "Pending setup"}
                          </Badge>
                        </td>
                        <td className="tiny muted">
                          {acc.lastLoginAt ? new Date(acc.lastLoginAt).toLocaleString() : "Never"}
                        </td>
                        <td style={{ textAlign: "right" }}>
                          <div className="row" style={{ justifyContent: "flex-end", gap: 6 }}>
                            <button
                              type="button"
                              className="btn btn-ghost btn-sm"
                              title="Reset 2FA secret (requires new authenticator setup)"
                              onClick={async () => {
                                const ok = await confirmDialog({
                                  title: `Reset 2FA for ${acc.email}?`,
                                  message: "They will be required to set up a new 2FA authenticator key on their next sign-in.",
                                  confirmLabel: "Reset 2FA",
                                  tone: "bad",
                                });
                                if (ok) {
                                  await runAccountAction(`Reset 2FA for ${acc.email}`, {
                                    action: "reset_2fa",
                                    targetId: acc.id,
                                  });
                                }
                              }}
                            >
                              <KeyRound size={12} /> Reset 2FA
                            </button>
                            {!isSelf && (
                              <button
                                type="button"
                                className={`btn btn-sm ${acc.status === "active" ? "btn-danger" : ""}`}
                                onClick={async () => {
                                  const nextAction = acc.status === "active" ? "suspend" : "reactivate";
                                  const ok = await confirmDialog({
                                    title: `${nextAction === "suspend" ? "Suspend" : "Reactivate"} ${acc.email}?`,
                                    message:
                                      nextAction === "suspend"
                                        ? "Suspended admins immediately lose console access."
                                        : "Restore active console access for this administrator.",
                                    confirmLabel: nextAction === "suspend" ? "Suspend" : "Reactivate",
                                    tone: nextAction === "suspend" ? "bad" : "info",
                                  });
                                  if (ok) {
                                    await runAccountAction(`${nextAction} admin ${acc.email}`, {
                                      action: nextAction,
                                      targetId: acc.id,
                                    });
                                  }
                                }}
                              >
                                {acc.status === "active" ? <UserX size={12} /> : <UserCheck size={12} />}
                                {acc.status === "active" ? "Suspend" : "Reactivate"}
                              </button>
                            )}
                          </div>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </Card>
      )}

      {section === "brain" && (
        <AdminGlobalKnowledgeTab
          role={role}
          sessionToken={sessionToken}
          reauthToken={reauthToken}
          onNeedReauth={onNeedReauth}
        />
      )}

      {section === "checks" && <AdminSystemCheckTab role={role} sessionToken={sessionToken} />}

      <Modal open={createOpen} onClose={() => setCreateOpen(false)} title="Create Administrator Account">
        <form
          className="stack"
          style={{ gap: 12 }}
          onSubmit={async (e) => {
            e.preventDefault();
            setSaving(true);
            try {
              await runAccountAction(`Create admin ${newEmail}`, {
                action: "create",
                email: newEmail,
                name: newName,
                role: newRole,
                password: newPassword,
              });
            } finally {
              setSaving(false);
            }
          }}
        >
          <Banner tone="info">
            The new administrator will set up mandatory TOTP 2FA on their first sign-in.
          </Banner>
          <Field label="Name">
            <input
              className="input"
              required
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
              placeholder="e.g. Ada Operations"
            />
          </Field>
          <Field label="Email">
            <input
              className="input"
              type="email"
              required
              value={newEmail}
              onChange={(e) => setNewEmail(e.target.value)}
              placeholder="ops@company.com"
            />
          </Field>
          <Field label="Role">
            <select
              className="input"
              value={newRole}
              onChange={(e) => setNewRole(e.target.value as AdminRole)}
            >
              <option value="admin">Admin (manage users &amp; providers)</option>
              <option value="support">Support (read-only monitoring)</option>
              <option value="super_admin">Super Admin (full control)</option>
            </select>
          </Field>
          <Field label="Initial Password" hint="Minimum 10 characters; store safely before sharing.">
            <input
              className="input"
              type="password"
              required
              minLength={10}
              value={newPassword}
              onChange={(e) => setNewPassword(e.target.value)}
              placeholder="At least 10 characters"
            />
          </Field>
          <div className="row" style={{ justifyContent: "flex-end", gap: 8 }}>
            <button type="button" className="btn btn-ghost" onClick={() => setCreateOpen(false)}>
              Cancel
            </button>
            <button type="submit" className="btn btn-primary" disabled={saving || newPassword.length < 10}>
              {saving ? "Creating…" : "Create Admin"}
            </button>
          </div>
        </form>
      </Modal>
    </div>
  );
}
