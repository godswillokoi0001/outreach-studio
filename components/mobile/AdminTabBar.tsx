"use client";

import { BarChart3, Brain, Cpu, LayoutGrid, Users } from "lucide-react";

export type AdminTabSection = "overview" | "providers" | "users" | "brain";

/** Admin console bottom navigation; the fifth slot opens the admin menu sheet. */
export function AdminTabBar({
  active,
  onSelect,
  onMenu,
  menuOpen,
  providersAllowed,
}: {
  active: string;
  onSelect: (section: AdminTabSection) => void;
  onMenu: () => void;
  menuOpen: boolean;
  providersAllowed: boolean;
}) {
  const tabs: { id: AdminTabSection; label: string; icon: typeof BarChart3; hidden?: boolean }[] = [
    { id: "overview", label: "Overview", icon: BarChart3 },
    { id: "providers", label: "Providers", icon: Cpu, hidden: !providersAllowed },
    { id: "users", label: "Users", icon: Users },
    { id: "brain", label: "Brain", icon: Brain },
  ];

  return (
    <nav className="m-tabbar" aria-label="Admin">
      {tabs
        .filter((tab) => !tab.hidden)
        .map((tab) => {
          const Icon = tab.icon;
          const isActive = active === tab.id;
          return (
            <button
              key={tab.id}
              type="button"
              className="m-tab"
              data-active={isActive ? "true" : "false"}
              aria-current={isActive ? "page" : undefined}
              onClick={() => onSelect(tab.id)}
            >
              <span className="m-tab-icon">
                <Icon size={22} strokeWidth={isActive ? 2.3 : 1.8} aria-hidden="true" />
              </span>
              <span>{tab.label}</span>
            </button>
          );
        })}
      <button
        type="button"
        className="m-tab"
        data-active={menuOpen ? "true" : "false"}
        onClick={onMenu}
        aria-expanded={menuOpen}
        aria-label="Open admin menu"
      >
        <span className="m-tab-icon">
          <LayoutGrid size={22} strokeWidth={1.8} aria-hidden="true" />
        </span>
        <span>Menu</span>
      </button>
    </nav>
  );
}
