"use client";

import { useEffect, type ReactNode } from "react";
import { ArrowLeft, X } from "lucide-react";

/**
 * Full-height native sheet. On a phone it covers the screen (with a sticky
 * header); on a wide screen it stays a comfortable centred dialog.
 */
export function MobileSheet({
  open,
  onClose,
  title,
  children,
  footer,
  backLabel,
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  children: ReactNode;
  footer?: ReactNode;
  backLabel?: string;
}) {
  useEffect(() => {
    if (!open) return undefined;
    const previous = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKey);
    return () => {
      document.body.style.overflow = previous;
      document.removeEventListener("keydown", onKey);
    };
  }, [open, onClose]);

  if (!open) return null;

  return (
    <div className="m-sheet-backdrop" role="presentation" onClick={onClose}>
      <div
        className="m-sheet"
        role="dialog"
        aria-modal="true"
        aria-label={title}
        onClick={(event) => event.stopPropagation()}
      >
        <div className="m-sheet-head">
          <button type="button" className="m-back" onClick={onClose} aria-label={backLabel ?? "Back"}>
            <ArrowLeft size={20} />
          </button>
          <span className="m-sheet-title">{title}</span>
          <button
            type="button"
            className="m-icon-btn"
            style={{ marginLeft: "auto" }}
            onClick={onClose}
            aria-label="Close"
          >
            <X size={20} />
          </button>
        </div>
        <div className="m-sheet-body">{children}</div>
        {footer}
      </div>
    </div>
  );
}
