"use client";

import type { ReactNode } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { CountUp } from "./motion/CountUp";
import { LoadingPanel } from "./Loading";

export function Card({
  title,
  sub,
  actions,
  children,
  tight,
  className,
}: {
  title?: string;
  sub?: string;
  actions?: ReactNode;
  children?: ReactNode;
  tight?: boolean;
  className?: string;
}) {
  return (
    <section className={`card${tight ? " tight" : ""}${className ? ` ${className}` : ""}`}>
      {(title || actions) && (
        <header className="card-head" style={tight ? { padding: "16px 18px 0", marginBottom: 12 } : undefined}>
          <div>
            {title && <div className="card-title">{title}</div>}
            {sub && <div className="card-sub">{sub}</div>}
          </div>
          {actions && <div className="row-end row">{actions}</div>}
        </header>
      )}
      {children}
    </section>
  );
}

export function Stat({ label, value, note, accent }: { label: string; value: ReactNode; note?: string; accent?: boolean }) {
  return (
    <motion.div
      className={`stat${accent ? " accent" : ""}`}
      whileHover={{ y: -3 }}
      whileTap={{ scale: 0.995 }}
      transition={{ type: "spring", stiffness: 340, damping: 24 }}
    >
      <div className="stat-label">{label}</div>
      <div className="stat-value">{typeof value === "number" ? <CountUp value={value} /> : value}</div>
      {note && <div className="stat-note">{note}</div>}
    </motion.div>
  );
}

export function Badge({ tone, children }: { tone?: string; children: ReactNode }) {
  return (
    <span className="badge" data-tone={tone}>
      {children}
    </span>
  );
}

export function Field({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  return (
    <label className="field">
      <span className="label">{label}</span>
      {children}
      {hint && <span className="hint">{hint}</span>}
    </label>
  );
}

export function Empty({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <div className="empty">
      <strong>{title}</strong>
      {children}
    </div>
  );
}

export function Banner({ tone, children }: { tone?: string; children: ReactNode }) {
  return (
    <div className="banner" data-tone={tone}>
      <div>{children}</div>
    </div>
  );
}

export function Progress({
  label,
  hint,
  estimateMs = 2000,
}: {
  label: string;
  hint?: string;
  estimateMs?: number;
}) {
  return (
    <LoadingPanel
      label={label.replace(/[\u2026.]+$/, "")}
      hint={hint}
      estimateMs={estimateMs}
    />
  );
}

export function Modal({
  open,
  onClose,
  title,
  children,
  large,
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  children: ReactNode;
  large?: boolean;
}) {
  return (
    <AnimatePresence>
      {open && (
        <motion.div
          className="modal-backdrop"
          onClick={onClose}
          role="presentation"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.18, ease: "easeOut" }}
        >
          <motion.div
            className={`modal${large ? " modal-lg" : ""}`}
            onClick={(event) => event.stopPropagation()}
            role="dialog"
            aria-modal="true"
            aria-label={title}
            initial={{ opacity: 0, y: 18, scale: 0.97 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: 12, scale: 0.98 }}
            transition={{ type: "spring", stiffness: 340, damping: 30 }}
          >
            <div className="row">
              <h2 style={{ fontSize: 17 }}>{title}</h2>
              <div className="row-end">
                <button className="btn btn-ghost btn-sm" onClick={onClose} type="button" aria-label="Close dialog">
                  ✕
                </button>
              </div>
            </div>
            <div className="modal-body">
              {children}
            </div>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}

export function Pager({
  page,
  pageSize,
  total,
  onPage,
}: {
  page: number;
  pageSize: number;
  total: number;
  onPage: (page: number) => void;
}) {
  const pages = Math.max(1, Math.ceil(total / pageSize));
  return (
    <div className="pager">
      <span>
        {total === 0 ? "0" : `${(page - 1) * pageSize + 1}–${Math.min(page * pageSize, total)}`} of {total}
      </span>
      <button className="btn btn-sm" disabled={page <= 1} onClick={() => onPage(page - 1)} type="button">
        Previous
      </button>
      <span className="num">
        {page} / {pages}
      </span>
      <button className="btn btn-sm" disabled={page >= pages} onClick={() => onPage(page + 1)} type="button">
        Next
      </button>
    </div>
  );
}

export function Toggle({
  checked,
  onChange,
  label,
  hint,
}: {
  checked: boolean;
  onChange: (value: boolean) => void;
  label: string;
  hint?: string;
}) {
  return (
    <label className="check">
      <input type="checkbox" checked={checked} onChange={(event) => onChange(event.target.checked)} />
      <span>
        <span className="label" style={{ display: "block" }}>{label}</span>
        {hint && <span className="hint">{hint}</span>}
      </span>
    </label>
  );
}
