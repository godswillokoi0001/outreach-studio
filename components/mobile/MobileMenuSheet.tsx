"use client";

import Link from "next/link";
import {
  BarChart3,
  BookOpen,
  ChevronRight,
  Clock,
  FileSpreadsheet,
  Flag,
  LogOut,
  MessageSquare,
  Plug,
  RefreshCw,
  Search,
  Send,
  Settings,
  ShieldCheck,
  TrendingUp,
  User,
  Users,
  X,
} from "lucide-react";
import { UserAvatar } from "@/components/UserAvatar";

const GROUPS: {
  label: string;
  items: { href: string; label: string; icon: React.ComponentType<{ size?: number }>; meta?: string }[];
}[] = [
  {
    label: "Outreach",
    items: [
      { href: "/sent", label: "Sent emails", icon: Send },
      { href: "/conversations", label: "Conversations", icon: MessageSquare },
      { href: "/followups", label: "Follow-ups", icon: Clock },
    ],
  },
  {
    label: "Prospecting",
    items: [
      { href: "/campaigns", label: "Campaigns", icon: Flag },
      { href: "/research", label: "Prospect research", icon: Search },
      { href: "/sheets", label: "Google Sheets", icon: FileSpreadsheet },
      { href: "/leads", label: "All leads", icon: Users },
    ],
  },
  {
    label: "Intelligence",
    items: [
      { href: "/growth-advisor", label: "Growth Advisor", icon: TrendingUp },
      { href: "/analytics", label: "Analytics", icon: BarChart3 },
      { href: "/knowledge", label: "Knowledge base", icon: BookOpen },
    ],
  },
  {
    label: "Account",
    items: [
      { href: "/integrations", label: "Integrations", icon: Plug },
      { href: "/settings", label: "Settings", icon: Settings },
      { href: "/admin", label: "Admin Console", icon: ShieldCheck },
    ],
  },
];

/** Facebook-style full-screen "Menu" sheet with every remaining destination. */
export function MobileMenuSheet({
  open,
  onClose,
  displayName,
  email,
  photoURL,
  workspaceConnected,
  workspaceEmail,
  syncing,
  onSync,
  onSignOut,
  counts,
}: {
  open: boolean;
  onClose: () => void;
  displayName: string;
  email?: string;
  photoURL?: string | null;
  workspaceConnected: boolean;
  workspaceEmail?: string | null;
  syncing: boolean;
  onSync: () => void;
  onSignOut: () => void;
  counts: { review: number; replies: number; followups: number };
}) {
  if (!open) return null;

  return (
    <>
      <div className="m-sheet-backdrop" onClick={onClose} role="presentation" />
      <div className="m-sheet" role="dialog" aria-modal="true" aria-label="Menu">
        <div className="m-sheet-head">
          <span className="m-sheet-title">Menu</span>
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
          <Link href="/settings" className="m-profile" onClick={onClose}>
            <UserAvatar photoURL={photoURL ?? undefined} name={displayName} email={email} size={44} />
            <span className="m-profile-copy">
              <span className="m-profile-name">{displayName}</span>
              <span className="m-profile-meta">{email ?? "Signed in"}</span>
            </span>
            <ChevronRight size={18} aria-hidden="true" style={{ marginLeft: "auto" }} />
          </Link>

          <div className="m-menu-list" style={{ marginBottom: 18 }}>
            <button type="button" className="m-menu-item" onClick={onSync} disabled={syncing}>
              <span className="m-menu-icon">
                <RefreshCw size={17} />
              </span>
              <span className="m-menu-text">{syncing ? "Syncing replies…" : "Sync replies from Gmail"}</span>
            </button>
            <div className="m-menu-item" style={{ cursor: "default" }}>
              <span className="m-menu-icon">
                <Plug size={17} />
              </span>
              <span className="m-menu-text">
                <span className="m-status">
                  <span className="m-dot" data-tone={workspaceConnected ? "ok" : "warn"} />
                  {workspaceConnected
                    ? `${workspaceEmail ? workspaceEmail.split("@")[0] : "Google"} connected`
                    : "Google not connected"}
                </span>
              </span>
              <Link
                href="/integrations"
                className="m-menu-meta"
                onClick={onClose}
                style={{ textDecoration: "none" }}
              >
                {workspaceConnected ? "Manage" : "Connect"}
              </Link>
            </div>
            {(counts.review > 0 || counts.replies > 0 || counts.followups > 0) && (
              <div className="m-menu-item" style={{ cursor: "default" }}>
                <span className="m-menu-icon">
                  <User size={17} />
                </span>
                <span className="m-menu-text">Needs attention</span>
                <span className="m-menu-meta">
                  {counts.review} to review · {counts.replies} replies
                </span>
              </div>
            )}
          </div>

          {GROUPS.map((group) => (
            <div className="m-menu-group" key={group.label}>
              <div className="m-menu-group-label">{group.label}</div>
              <div className="m-menu-list">
                {group.items.map((item) => {
                  const Icon = item.icon;
                  return (
                    <Link key={item.href} href={item.href} className="m-menu-item" onClick={onClose}>
                      <span className="m-menu-icon">
                        <Icon size={17} />
                      </span>
                      <span className="m-menu-text">{item.label}</span>
                      <ChevronRight size={16} aria-hidden="true" style={{ opacity: 0.45 }} />
                    </Link>
                  );
                })}
              </div>
            </div>
          ))}

          <div className="m-menu-list">
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
    </>
  );
}
