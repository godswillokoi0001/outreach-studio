"use client";

import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { Check, Monitor, Moon, Sun } from "lucide-react";
import { applyTheme, readThemeChoice, type ResolvedTheme, type ThemeChoice } from "@/lib/theme";

const OPTIONS = [
  { value: "light", label: "Light", icon: Sun },
  { value: "dark", label: "Dark", icon: Moon },
  { value: "system", label: "System", icon: Monitor },
] as const;

const ICONS = { light: Sun, dark: Moon, system: Monitor } as const;

/**
 * The stored choice lives on <html data-theme-choice> (set before paint by the
 * inline script). A tiny external store reads it without an effect, so the
 * component hydrates straight into the right icon.
 */
const listeners = new Set<() => void>();
const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
};
const notify = () => listeners.forEach((listener) => listener());
const getSnapshot = (): ThemeChoice => readThemeChoice();
const getServerSnapshot = (): ThemeChoice => "system";

export function ThemeToggle({ compact = false }: { compact?: boolean }) {
  const choice = useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement | null>(null);

  // Derived, not stored: the media-query listener below notifies the store,
  // which re-renders this component with the new value.
  const resolved: ResolvedTheme =
    choice === "system"
      ? typeof window !== "undefined" && window.matchMedia("(prefers-color-scheme: dark)").matches
        ? "dark"
        : "light"
      : choice;

  useEffect(() => {
    const media = window.matchMedia("(prefers-color-scheme: dark)");
    const onChange = () => {
      if (readThemeChoice() !== "system") return;
      applyTheme("system");
      notify();
    };
    media.addEventListener("change", onChange);
    return () => media.removeEventListener("change", onChange);
  }, []);

  useEffect(() => {
    if (!open) return undefined;
    const onDown = (event: MouseEvent) => {
      if (!wrapRef.current?.contains(event.target as Node)) setOpen(false);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const pick = (next: ThemeChoice) => {
    applyTheme(next);
    notify();
    setOpen(false);
  };

  const Icon = ICONS[choice];

  return (
    <div className="theme-toggle" ref={wrapRef}>
      <button
        type="button"
        className="theme-toggle-btn"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={`Theme: ${choice}`}
        title="Theme"
        onClick={() => setOpen((value) => !value)}
      >
        <Icon size={15} strokeWidth={1.8} aria-hidden="true" />
        {!compact && <span>Theme</span>}
      </button>
      {open && (
        <div className="theme-menu" role="menu" aria-label="Colour theme">
          {OPTIONS.map((option) => {
            const OptionIcon = option.icon;
            const active = choice === option.value;
            return (
              <button
                key={option.value}
                type="button"
                role="menuitemradio"
                aria-checked={active}
                className={`theme-menu-item${active ? " is-active" : ""}`}
                onClick={() => pick(option.value)}
              >
                <OptionIcon size={14} strokeWidth={1.8} aria-hidden="true" />
                <span>{option.label}</span>
                {option.value === "system" && active ? <em>{resolved}</em> : null}
                {active ? <Check size={13} strokeWidth={2} aria-hidden="true" className="theme-check" /> : null}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
