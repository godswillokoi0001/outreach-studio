"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";

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

  return (
    <div className={`menu-wrap${className ? ` ${className}` : ""}`} ref={wrapRef}>
      <button
        type="button"
        className="menu-trigger"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={label}
        title={label}
        onClick={() => setOpen((value) => !value)}
      >
        {trigger}
      </button>
      {open ? (
        <div className={`menu-panel menu-panel-${align}${panelClassName ? ` ${panelClassName}` : ""}`} role="menu">
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
      <a className="menu-item" href={href} role="menuitem" onClick={onClick}>
        {children}
        {hint ? <em>{hint}</em> : null}
      </a>
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
