"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { CheckSquare, Home, LayoutGrid, TrendingUp, Users } from "lucide-react";

const TABS = [
  { href: "/", label: "Home", icon: Home, exact: true },
  { href: "/leads", label: "Leads", icon: Users, exact: false },
  { href: "/review", label: "Review", icon: CheckSquare, exact: false },
  { href: "/growth-advisor", label: "Advisor", icon: TrendingUp, exact: false },
] as const;

/** Fixed five-slot bottom navigation, Facebook/Instagram style. */
export function MobileTabBar({
  reviewCount,
  onMenu,
  menuOpen,
}: {
  reviewCount: number;
  onMenu: () => void;
  menuOpen: boolean;
}) {
  const pathname = usePathname();

  const isActive = (href: string, exact: boolean) =>
    exact ? pathname === href : pathname === href || pathname.startsWith(`${href}/`);

  return (
    <nav className="m-tabbar" aria-label="Primary">
      {TABS.map((tab) => {
        const Icon = tab.icon;
        const active = isActive(tab.href, tab.exact);
        return (
          <Link
            key={tab.href}
            href={tab.href}
            className="m-tab"
            data-active={active ? "true" : "false"}
            aria-current={active ? "page" : undefined}
          >
            <span className="m-tab-icon">
              <Icon size={22} strokeWidth={active ? 2.3 : 1.8} aria-hidden="true" />
              {tab.href === "/review" && reviewCount > 0 ? (
                <span className="m-tab-badge">{reviewCount > 99 ? "99+" : reviewCount}</span>
              ) : null}
            </span>
            <span>{tab.label}</span>
          </Link>
        );
      })}
      <button
        type="button"
        className="m-tab"
        data-active={menuOpen ? "true" : "false"}
        onClick={onMenu}
        aria-expanded={menuOpen}
        aria-label="Open menu"
      >
        <span className="m-tab-icon">
          <LayoutGrid size={22} strokeWidth={1.8} aria-hidden="true" />
        </span>
        <span>Menu</span>
      </button>
    </nav>
  );
}
