"use client";

import Link from "next/link";
import {
  Activity,
  ArrowLeft,
  Bell,
  Brain,
  Database,
  HeartPulse,
  Lock,
  LogOut,
  Megaphone,
  ShieldCheck,
  Users,
  X,
} from "lucide-react";

export type AdminMenuSection =
  | "notifications"
  | "users"
  | "health"
  | "cleanup"
  | "announcements"
  | "audit"
  | "brain"
  | "security";

/** Compact admin menu: every section the bottom bar does not carry. */
export function AdminMenuSheet({
  open,
  onClose,
  onSelect,
  role,
  email,
  unreadCount,
  canManageOps,
  onSignOut,
}: {
  open: boolean;
  onClose: () => void;
  onSelect: (section: AdminMenuSection) => void;
  role: string;
  email?: string;
  unreadCount: number;
  canManageOps: boolean;
  onSignOut: () => void;
}) {
  if (!open) return null;

  const items: {
    id: AdminMenuSection;
    label: string;
    icon: React.ComponentType<{ size?: number }>;
    meta?: string;
    hidden?: boolean;
  }[] = [
    { id: "notifications", label: "Notifications", icon: Bell, meta: unreadCount ? String(unreadCount) : undefined },
    { id: "users", label: "Users", icon: Users },
    { id: "health", label: "Diagnostics", icon: HeartPulse },
    { id: "cleanup", label: "Cleanup tool", icon: Database, hidden: !canManageOps },
    { id: "announcements", label: "Announcements", icon: Megaphone },
    { id: "audit", label: "Audit log", icon: Activity },
    { id: "brain", label: "Global brain", icon: Brain, hidden: !canManageOps },
    { id: "security", label: "Security", icon: Lock },
  ];

  return (
    <>
      <div className="m-sheet-backdrop" onClick={onClose} role="presentation" />
      <div className="m-sheet" role="dialog" aria-modal="true" aria-label="Admin menu">
        <div className="m-sheet-head">
          <span className="m-sheet-title">Admin</span>
          <button
            type="button"
            className="m-icon-btn"
            style={{ marginLeft: "auto" }}
            onClick={onClose}
            aria-label="Close menu"
          >
            <X size={20} />
          </button>
        </div>

        <div className="m-sheet-body">
          <div className="m-profile">
            <span className="m-menu-icon" style={{ width: 40, height: 40, flexBasis: 40 }}>
              <ShieldCheck size={20} />
            </span>
            <span className="m-profile-copy">
              <span className="m-profile-name">{role.replace("_", " ")}</span>
              <span className="m-profile-meta">{email ?? "Signed in"}</span>
            </span>
          </div>

          <div className="m-menu-group">
            <div className="m-menu-group-label">Console</div>
            <div className="m-menu-list">
              {items
                .filter((item) => !item.hidden)
                .map((item) => {
                  const Icon = item.icon;
                  return (
                    <button
                      key={item.id}
                      type="button"
                      className="m-menu-item"
                      onClick={() => {
                        onSelect(item.id);
                        onClose();
                      }}
                    >
                      <span className="m-menu-icon">
                        <Icon size={17} />
                      </span>
                      <span className="m-menu-text">{item.label}</span>
                      {item.meta ? <span className="m-menu-meta">{item.meta}</span> : null}
                    </button>
                  );
                })}
            </div>
          </div>

          <div className="m-menu-group">
            <div className="m-menu-list">
              <Link href="/" className="m-menu-item" onClick={onClose}>
                <span className="m-menu-icon">
                  <ArrowLeft size={17} />
                </span>
                <span className="m-menu-text">Back to app</span>
              </Link>
              <button
                type="button"
                className="m-menu-item"
                data-tone="danger"
                onClick={() => {
                  onClose();
                  onSignOut();
                }}
              >
                <span className="m-menu-icon">
                  <LogOut size={17} />
                </span>
                <span className="m-menu-text">Sign out</span>
              </button>
            </div>
          </div>
        </div>
      </div>
    </>
  );
}
