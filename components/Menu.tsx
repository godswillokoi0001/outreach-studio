"use client";

import Link from "next/link";
import { useEffect, useId, useRef, useState, type ReactNode } from "react";

/**
 * Small accessible popover used by the header (notifications, overflow and
 * profile). One button, one panel, closes on outside click, Escape or select.
 */
export function Menu({
  trigger,
  label,
  align = "end",
  className,
  panelClassName,
  children,
}: {
  trigger: ReactNode;
  label: string;
  align?: "start" | "end";
  className?: string;
  panelClassName?: string;
  children: (close: () => void) => ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const panelRef = useRef<HTMLDivElement | null>(null);
  const panelId = useId();

  useEffect(() => {
    if (!open) return undefined;
    const items = () =>
      Array.from(panelRef.current?.querySelectorAll<HTMLElement>('[role="menuitem"]') ?? []);
    // Keyboard opening lands on the first action; arrows walk the list. Without
    // this the panel is reachable but not usable without a pointer.
    items()[0]?.focus();

    const onDown = (event: MouseEvent) => {
      if (!wrapRef.current?.contains(event.target as Node)) setOpen(false);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        setOpen(false);
        triggerRef.current?.focus();
        return;
      }
      if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
      const list = items();
      if (list.length === 0) return;
      event.preventDefault();
      const index = list.indexOf(document.activeElement as HTMLElement);
      const next =
        event.key === "Home"
          ? 0
          : event.key === "End"
            ? list.length - 1
            : event.key === "ArrowDown"
              ? (index + 1) % list.length
              : (index - 1 + list.length) % list.length;
      list[next].focus();
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  return (
    <div className={`menu-wrap${className ? ` ${className}` : ""}`} ref={wrapRef}>
      <button
        ref={triggerRef}
        type="button"
        className="menu-trigger"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? panelId : undefined}
        aria-label={label}
        title={label}
        onClick={() => setOpen((value) => !value)}
      >
        {trigger}
      </button>
      {open ? (
        <div
          ref={panelRef}
          id={panelId}
          className={`menu-panel menu-panel-${align}${panelClassName ? ` ${panelClassName}` : ""}`}
          role="menu"
        >
          {children(() => setOpen(false))}
        </div>
      ) : null}
    </div>
  );
}

export function MenuItem({
  children,
  onClick,
  href,
  tone,
  hint,
}: {
  children: ReactNode;
  onClick?: () => void;
  href?: string;
  tone?: "danger";
  hint?: string;
}) {
  if (href) {
    return (
      <Link className="menu-item" href={href} role="menuitem" onClick={onClick}>
        {children}
        {hint ? <em>{hint}</em> : null}
      </Link>
    );
  }
  return (
    <button type="button" className="menu-item" role="menuitem" data-tone={tone} onClick={onClick}>
      {children}
      {hint ? <em>{hint}</em> : null}
    </button>
  );
}

export function MenuSeparator() {
  return <div className="menu-sep" role="separator" />;
}
