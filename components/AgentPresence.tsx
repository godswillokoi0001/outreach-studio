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

interface AgentPresenceValue {
  /** Move the on-screen cursor onto an element and optionally "click" it. */
  moveTo: (selector: string, options?: { label?: string; click?: boolean; dwellMs?: number }) => Promise<void>;
  moveToPoint: (x: number, y: number, label?: string, click?: boolean) => void;
  /** Show a short narration bubble next to the cursor. */
  narrate: (text: string) => void;
  /** Highlight a region of the screen (for "reading" a section). */
  spotlight: (selector: string | null) => void;
  visible: boolean;
  setVisible: (visible: boolean) => void;
}

const AgentPresenceContext = createContext<AgentPresenceValue | null>(null);

export function useAgentPresence(): AgentPresenceValue {
  const ctx = useContext(AgentPresenceContext);
  if (!ctx) throw new Error("useAgentPresence must be used inside AgentPresenceProvider.");
  return ctx;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

interface Rect {
  left: number;
  top: number;
  width: number;
  height: number;
}

export function AgentPresenceProvider({ children }: { children: ReactNode }) {
  const [pos, setPos] = useState({ x: 0, y: 0 });
  const [label, setLabel] = useState<string>("");
  const [visible, setVisible] = useState(false);
  const [clickKey, setClickKey] = useState(0);
  const [spot, setSpot] = useState<Rect | null>(null);
  const [ready, setReady] = useState(false);
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const moveToPoint = useCallback((x: number, y: number, nextLabel?: string, click = false) => {
    setVisible(true);
    setReady(true);
    setPos({ x, y });
    if (nextLabel !== undefined) setLabel(nextLabel);
    if (click) {
      setTimeout(() => {
        if (!mounted.current) return;
        setClickKey((key) => key + 1);
      }, 520);
    }
  }, []);

  const narrate = useCallback((text: string) => {
    setLabel(text);
    setVisible(true);
  }, []);

  const spotlight = useCallback((selector: string | null) => {
    if (!selector) {
      setSpot(null);
      return;
    }
    const el = document.querySelector<HTMLElement>(selector);
    if (!el) return;
    const rect = el.getBoundingClientRect();
    setSpot({ left: rect.left, top: rect.top, width: rect.width, height: rect.height });
  }, []);

  const moveTo = useCallback(
    async (selector: string, options?: { label?: string; click?: boolean; dwellMs?: number }) => {
      const el = document.querySelector<HTMLElement>(selector);
      if (!el) {
        if (options?.label) narrate(options.label);
        return;
      }
      el.scrollIntoView({ block: "center", inline: "nearest", behavior: "smooth" });
      await sleep(options?.dwellMs ?? 420);
      if (!mounted.current) return;
      const rect = el.getBoundingClientRect();
      const x = Math.min(window.innerWidth - 24, Math.max(24, rect.left + rect.width / 2));
      const y = Math.min(window.innerHeight - 24, Math.max(24, rect.top + rect.height / 2));
      moveToPoint(x, y, options?.label, options?.click);
      await sleep(620);
    },
    [moveToPoint, narrate],
  );

  const value = useMemo<AgentPresenceValue>(
    () => ({ moveTo, moveToPoint, narrate, spotlight, visible, setVisible }),
    [moveTo, moveToPoint, narrate, spotlight, visible],
  );

  return (
    <AgentPresenceContext.Provider value={value}>
      {children}
      <div className="agent-layer" aria-hidden="true" data-ready={ready ? "true" : "false"}>
        {spot && (
          <div
            className="agent-spot"
            style={{ left: spot.left - 6, top: spot.top - 6, width: spot.width + 12, height: spot.height + 12 }}
          />
        )}
        <div
          className="agent-cursor"
          data-visible={visible ? "true" : "false"}
          style={{ transform: `translate3d(${pos.x}px, ${pos.y}px, 0)` }}
        >
          <span className="agent-click-ripple" key={clickKey} />
          <svg width="22" height="26" viewBox="0 0 22 26" fill="none">
            <path
              d="M2 1.6 19.2 13.2a.9.9 0 0 1-.43 1.63l-7.1.83-3.42 6.62a.9.9 0 0 1-1.65-.2L2.02 2.76A.9.9 0 0 1 2 1.6Z"
              fill="#f7fbf8"
              stroke="#143c2e"
              strokeWidth="1.6"
              strokeLinejoin="round"
            />
          </svg>
          {label && <span className="agent-cursor-label">{label}</span>}
        </div>
      </div>
    </AgentPresenceContext.Provider>
  );
}
