"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { AnimatePresence, motion } from "framer-motion";
import { AlertTriangle, CheckCircle2, Info, X } from "lucide-react";

export type FeedbackTone = "ok" | "bad" | "info";

export interface ToastInput {
  tone?: FeedbackTone;
  title: string;
  message?: string;
}

interface Toast extends ToastInput {
  id: number;
  tone: FeedbackTone;
}

export interface ConfirmInput {
  title: string;
  message?: string;
  confirmLabel?: string;
  cancelLabel?: string;
  tone?: FeedbackTone;
}

interface ConfirmRequest extends ConfirmInput {
  id: number;
  resolve: (value: boolean) => void;
}

const ToastContext = createContext<{ push: (toast: ToastInput) => void }>({ push: () => {} });
const ConfirmContext = createContext<{ confirm: (input: ConfirmInput) => Promise<boolean> }>({
  confirm: async () => false,
});

const TOAST_EVENT = "os:toast";
const TOAST_TTL = 6500;

/**
 * Imperative confirm, usable from event handlers and plain modules without a
 * hook. The mounted provider registers the real implementation.
 */
let confirmHandler: ((input: ConfirmInput) => Promise<boolean>) | null = null;

export function confirmDialog(input: ConfirmInput): Promise<boolean> {
  if (confirmHandler) return confirmHandler(input);
  if (typeof window === "undefined") return Promise.resolve(false);
  return Promise.resolve(window.confirm(input.message ?? input.title));
}

/**
 * Fire a toast from anywhere, including plain modules outside React.
 * The provider listens for this event, so `lib/client.ts` can surface every
 * failed request without importing UI code.
 */
export function toast(input: ToastInput): void {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new CustomEvent<ToastInput>(TOAST_EVENT, { detail: input }));
}

export function useToast() {
  const { push } = useContext(ToastContext);
  return useMemo(
    () => ({
      toast: push,
      success: (title: string, message?: string) => push({ tone: "ok", title, message }),
      error: (title: string, message?: string) => push({ tone: "bad", title, message }),
      info: (title: string, message?: string) => push({ tone: "info", title, message }),
    }),
    [push],
  );
}

export function useConfirm() {
  return useContext(ConfirmContext).confirm;
}

export function FeedbackProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const [request, setRequest] = useState<ConfirmRequest | null>(null);
  const seq = useRef(0);

  const dismiss = useCallback((id: number) => {
    setToasts((current) => current.filter((item) => item.id !== id));
  }, []);

  const push = useCallback(
    (input: ToastInput) => {
      seq.current += 1;
      const id = seq.current;
      const next: Toast = { ...input, id, tone: input.tone ?? "info" };
      setToasts((current) => [...current.slice(-3), next]);
      window.setTimeout(() => dismiss(id), TOAST_TTL);
    },
    [dismiss],
  );

  useEffect(() => {
    const onToast = (event: Event) => {
      const detail = (event as CustomEvent<ToastInput>).detail;
      if (detail && typeof detail.title === "string") push(detail);
    };
    window.addEventListener(TOAST_EVENT, onToast);
    return () => window.removeEventListener(TOAST_EVENT, onToast);
  }, [push]);

  const confirm = useCallback(
    (input: ConfirmInput) =>
      new Promise<boolean>((resolve) => {
        seq.current += 1;
        setRequest({ ...input, id: seq.current, resolve });
      }),
    [],
  );

  const settle = useCallback(
    (value: boolean) => {
      setRequest((current) => {
        current?.resolve(value);
        return null;
      });
    },
    [],
  );

  useEffect(() => {
    confirmHandler = confirm;
    return () => {
      if (confirmHandler === confirm) confirmHandler = null;
    };
  }, [confirm]);

  useEffect(() => {
    if (!request) return undefined;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") settle(false);
      if (event.key === "Enter") settle(true);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [request, settle]);

  return (
    <ToastContext.Provider value={{ push }}>
      <ConfirmContext.Provider value={{ confirm }}>
        {children}

        <div className="toast-stack" role="status" aria-live="polite">
          <AnimatePresence initial={false}>
            {toasts.map((item) => {
              const Icon =
                item.tone === "ok" ? CheckCircle2 : item.tone === "bad" ? AlertTriangle : Info;
              return (
                <motion.div
                  key={item.id}
                  className="toast"
                  data-tone={item.tone}
                  initial={{ opacity: 0, y: 14, scale: 0.97 }}
                  animate={{ opacity: 1, y: 0, scale: 1 }}
                  exit={{ opacity: 0, y: 8, scale: 0.98 }}
                  transition={{ type: "spring", stiffness: 380, damping: 30 }}
                >
                  <span className="toast-icon" aria-hidden="true">
                    <Icon size={16} />
                  </span>
                  <div className="toast-body">
                    <strong>{item.title}</strong>
                    {item.message ? <span>{item.message}</span> : null}
                  </div>
                  <button type="button" aria-label="Dismiss" onClick={() => dismiss(item.id)}>
                    <X size={13} />
                  </button>
                </motion.div>
              );
            })}
          </AnimatePresence>
        </div>

        <AnimatePresence>
          {request && (
            <motion.div
              className="modal-backdrop confirm-backdrop"
              role="presentation"
              onClick={() => settle(false)}
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              transition={{ duration: 0.15 }}
            >
              <motion.div
                className="modal confirm-modal"
                role="alertdialog"
                aria-modal="true"
                aria-label={request.title}
                onClick={(event) => event.stopPropagation()}
                initial={{ opacity: 0, y: 16, scale: 0.97 }}
                animate={{ opacity: 1, y: 0, scale: 1 }}
                exit={{ opacity: 0, y: 10, scale: 0.98 }}
                transition={{ type: "spring", stiffness: 360, damping: 30 }}
              >
                <div className="confirm-head">
                  <span className="confirm-icon" data-tone={request.tone ?? "info"} aria-hidden="true">
                    {request.tone === "ok" ? (
                      <CheckCircle2 size={18} />
                    ) : request.tone === "info" ? (
                      <Info size={18} />
                    ) : (
                      <AlertTriangle size={18} />
                    )}
                  </span>
                  <h2>{request.title}</h2>
                </div>
                {request.message ? <p className="confirm-message">{request.message}</p> : null}
                <div className="confirm-actions">
                  <button type="button" className="btn" onClick={() => settle(false)}>
                    {request.cancelLabel ?? "Cancel"}
                  </button>
                  <button
                    type="button"
                    className={`btn ${request.tone === "bad" ? "btn-danger" : "btn-primary"}`}
                    onClick={() => settle(true)}
                    autoFocus
                  >
                    {request.confirmLabel ?? "Confirm"}
                  </button>
                </div>
              </motion.div>
            </motion.div>
          )}
        </AnimatePresence>
      </ConfirmContext.Provider>
    </ToastContext.Provider>
  );
}
