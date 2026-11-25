"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from "react";

export interface MoveOptions {
  label?: string;
  click?: boolean;
  dwellMs?: number;
}

interface AgentPresenceValue {
  /** Whether the on-screen cursor is shown at all. Persisted per browser. */
  enabled: boolean;
  setEnabled: (enabled: boolean) => void;
  /** Drives the "working" chip that follows the cursor while the agent runs. */
  busy: boolean;
  setBusy: (busy: boolean) => void;
  /** Glide the cursor onto an element, spotlight it, then optionally tap it. */
  moveTo: (selector: string, options?: MoveOptions) => Promise<void>;
  moveToPoint: (x: number, y: number, label?: string, click?: boolean) => Promise<void>;
  /** Show a short narration bubble next to the cursor. */
  narrate: (text: string) => void;
  spotlight: (selector: string | null) => void;
  visible: boolean;
}

const AgentPresenceContext = createContext<AgentPresenceValue | null>(null);

export function useAgentPresence(): AgentPresenceValue {
  const ctx = useContext(AgentPresenceContext);
  if (!ctx) throw new Error("useAgentPresence must be used inside AgentPresenceProvider.");
  return ctx;
}

const ENABLED_KEY = "agent-operator-cursor";
const TRAIL_POINTS = 3;

/**
 * The cursor on/off preference lives in localStorage, which does not exist on
 * the server. A tiny external store keeps the reads out of effects (and out of
 * hydration): the server snapshot is "on", then React reconciles to the stored
 * value right after hydration.
 */
const enabledListeners = new Set<() => void>();
let enabledSnapshot: string | null = null;

function readEnabled(): boolean {
  if (enabledSnapshot === null) {
    try {
      enabledSnapshot = window.localStorage.getItem(ENABLED_KEY) ?? "true";
    } catch {
      enabledSnapshot = "true";
    }
  }
  return enabledSnapshot !== "false";
}

function subscribeEnabled(listener: () => void): () => void {
  enabledListeners.add(listener);
  return () => {
    enabledListeners.delete(listener);
  };
}

function writeEnabled(next: boolean): void {
  enabledSnapshot = String(next);
  try {
    window.localStorage.setItem(ENABLED_KEY, enabledSnapshot);
  } catch {
    /* storage blocked */
  }
  enabledListeners.forEach((listener) => listener());
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
const easeInOutCubic = (t: number) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);

interface Rect {
  left: number;
  top: number;
  width: number;
  height: number;
}

interface Point {
  x: number;
  y: number;
}

export function AgentPresenceProvider({ children }: { children: ReactNode }) {
  const enabled = useSyncExternalStore(subscribeEnabled, readEnabled, () => true);
  const [busy, setBusy] = useState(false);
  const [pos, setPos] = useState<Point>({ x: 0, y: 0 });
  const [trail, setTrail] = useState<Point[]>([]);
  const [label, setLabel] = useState("");
  const [pressing, setPressing] = useState(false);
  const [clickKey, setClickKey] = useState(0);
  const [spot, setSpot] = useState<Rect | null>(null);
  const [placed, setPlaced] = useState(false);

  const mounted = useRef(true);
  const enabledRef = useRef(true);
  const posRef = useRef<Point>({ x: 0, y: 0 });
  const rafRef = useRef<number | null>(null);
  const settleRef = useRef<(() => void) | null>(null);
  const spotTimer = useRef<number | null>(null);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  useEffect(() => {
    enabledRef.current = enabled;
  }, [enabled]);

  // Prime the starting point in a ref only: the ref is never rendered, so the
  // first glide can begin from a natural spot without a hydration mismatch.
  useEffect(() => {
    posRef.current = {
      x: Math.round(window.innerWidth * 0.68),
      y: Math.round(window.innerHeight * 0.62),
    };
  }, []);

  const setEnabled = useCallback((next: boolean) => {
    enabledRef.current = next;
    writeEnabled(next);
    if (!next) {
      setTrail([]);
      setSpot(null);
      setLabel("");
      setPressing(false);
      setPlaced(false);
    }
  }, []);

  const spotlight = useCallback((selector: string | null) => {
    if (spotTimer.current) {
      window.clearTimeout(spotTimer.current);
      spotTimer.current = null;
    }
    if (!selector || !enabledRef.current) {
      setSpot(null);
      return;
    }
    const el = document.querySelector<HTMLElement>(selector);
    if (!el) return;
    const rect = el.getBoundingClientRect();
    setSpot({ left: rect.left, top: rect.top, width: rect.width, height: rect.height });
    spotTimer.current = window.setTimeout(() => {
      if (mounted.current) setSpot(null);
    }, 2_200);
  }, []);

  const travelTo = useCallback(
    (targetX: number, targetY: number) =>
      new Promise<void>((resolve) => {
        if (rafRef.current !== null) {
          window.cancelAnimationFrame(rafRef.current);
          rafRef.current = null;
        }
        if (settleRef.current) {
          const settle = settleRef.current;
          settleRef.current = null;
          settle();
        }

        const start = { ...posRef.current };
        const dx = targetX - start.x;
        const dy = targetY - start.y;
        const distance = Math.hypot(dx, dy);

        if (distance < 2) {
          posRef.current = { x: targetX, y: targetY };
          setPos(posRef.current);
          resolve();
          return;
        }

        // Curved travel reads as a hand moving, not a teleport.
        const duration = Math.min(860, Math.max(260, distance * 0.85));
        const nx = -dy / distance;
        const ny = dx / distance;
        const bow = Math.min(64, distance * 0.14) * (Math.random() > 0.5 ? 1 : -1);
        const controlX = start.x + dx / 2 + nx * bow;
        const controlY = start.y + dy / 2 + ny * bow;
        const startedAt = performance.now();
        let lastTrailAt = 0;

        settleRef.current = resolve;

        const frame = (now: number) => {
          const progress = Math.min(1, (now - startedAt) / duration);
          const eased = easeInOutCubic(progress);
          const inv = 1 - eased;
          const x = inv * inv * start.x + 2 * inv * eased * controlX + eased * eased * targetX;
          const y = inv * inv * start.y + 2 * inv * eased * controlY + eased * eased * targetY;

          posRef.current = { x, y };
          setPos({ x, y });

          if (now - lastTrailAt > 45) {
            lastTrailAt = now;
            setTrail((prev) => [...prev.slice(-(TRAIL_POINTS - 1)), { x, y }]);
          }

          if (progress < 1) {
            rafRef.current = window.requestAnimationFrame(frame);
            return;
          }

          rafRef.current = null;
          settleRef.current = null;
          setTrail([]);
          resolve();
        };

        rafRef.current = window.requestAnimationFrame(frame);
      }),
    [],
  );

  const moveToPoint = useCallback(
    async (x: number, y: number, nextLabel?: string, click = false) => {
      if (!enabledRef.current || typeof window === "undefined") return;
      const targetX = Math.min(window.innerWidth - 8, Math.max(8, x));
      const targetY = Math.min(window.innerHeight - 8, Math.max(8, y));

      // Paint at the cursor's real current point so it never flashes at 0,0.
      setPlaced(true);
      setPos({ x: posRef.current.x, y: posRef.current.y });
      if (nextLabel !== undefined) setLabel(nextLabel);
      await travelTo(targetX, targetY);
      if (!mounted.current || !enabledRef.current) return;

      if (click) {
        setPressing(true);
        await sleep(110);
        if (!mounted.current) return;
        setPressing(false);
        setClickKey((key) => key + 1);
        await sleep(90);
      }
    },
    [travelTo],
  );

  // Narration only updates the chip. The cursor appears when it actually
  // travels somewhere, so idle chatter never parks a pointer at 0,0.
  const narrate = useCallback((text: string) => {
    if (!enabledRef.current) return;
    setLabel(text);
  }, []);

  const moveTo = useCallback(
    async (selector: string, options?: MoveOptions) => {
      if (!enabledRef.current || typeof window === "undefined") return;
      // Publish the label at call time, not when the glide ends, so a slower
      // animation can never overwrite the result of the step it was showing.
      if (options?.label) narrate(options.label);
      const el = document.querySelector<HTMLElement>(selector);
      if (!el) {
        setPlaced(true);
        setPos({ x: posRef.current.x, y: posRef.current.y });
        return;
      }

      const reduceMotion = window.matchMedia?.("(prefers-reduced-motion: reduce)")?.matches ?? false;
      el.scrollIntoView({ block: "center", inline: "nearest", behavior: reduceMotion ? "auto" : "smooth" });
      await sleep(options?.dwellMs ?? 240);
      if (!mounted.current || !enabledRef.current) return;

      const rect = el.getBoundingClientRect();
      const x = rect.left + rect.width / 2;
      const y = rect.top + rect.height / 2;

      spotlight(selector);
      await moveToPoint(x, y, undefined, options?.click);
      await sleep(160);
    },
    [moveToPoint, narrate, spotlight],
  );

  const value = useMemo<AgentPresenceValue>(
    () => ({
      enabled,
      setEnabled,
      busy,
      setBusy,
      moveTo,
      moveToPoint,
      narrate,
      spotlight,
      visible: placed,
    }),
    [busy, enabled, moveTo, moveToPoint, narrate, placed, setEnabled, spotlight],
  );

  // Keep the narration chip inside the viewport when the cursor works near the
  // right or bottom edge (the operator panel docks there by default).
  const viewportWidth = typeof window === "undefined" ? 1440 : window.innerWidth;
  const viewportHeight = typeof window === "undefined" ? 900 : window.innerHeight;
  const flipX = placed && pos.x > viewportWidth - 300;
  const flipY = placed && pos.y > viewportHeight - 140;

  return (
    <AgentPresenceContext.Provider value={value}>
      {children}
      {enabled && (
        <div className="agent-layer" aria-hidden="true" data-busy={busy ? "true" : "false"}>
          {spot && (
            <div
              className="agent-spot"
              style={{
                left: spot.left - 6,
                top: spot.top - 6,
                width: spot.width + 12,
                height: spot.height + 12,
              }}
            />
          )}
          {trail.map((point, index) => (
            <span
              key={`trail-${index}`}
              className="agent-trail"
              style={{
                transform: `translate3d(${point.x}px, ${point.y}px, 0)`,
                opacity: 0.08 + index * 0.06,
              }}
            />
          ))}
          <div
            className="agent-cursor"
            data-visible={placed ? "true" : "false"}
            data-pressing={pressing ? "true" : "false"}
            data-busy={busy ? "true" : "false"}
            data-flip-x={flipX ? "true" : "false"}
            data-flip-y={flipY ? "true" : "false"}
            style={placed ? { transform: `translate3d(${pos.x}px, ${pos.y}px, 0)` } : undefined}
          >
            <span className="agent-halo" />
            {clickKey > 0 && <span className="agent-click-ripple" key={`ripple-${clickKey}`} />}
            <svg
              className="agent-pointer"
              width="24"
              height="28"
              viewBox="0 0 24 28"
              fill="none"
              xmlns="http://www.w3.org/2000/svg"
            >
              <defs>
                <linearGradient id="agent-pointer-fill" x1="1" y1="0" x2="19" y2="26" gradientUnits="userSpaceOnUse">
                  <stop offset="0" stopColor="#ffffff" />
                  <stop offset="0.55" stopColor="#dff8f7" />
                  <stop offset="1" stopColor="#9fe8e6" />
                </linearGradient>
                <linearGradient id="agent-pointer-stroke" x1="1" y1="1" x2="19" y2="27" gradientUnits="userSpaceOnUse">
                  <stop offset="0" stopColor="#20ccc8" />
                  <stop offset="1" stopColor="#081625" />
                </linearGradient>
              </defs>
              <path
                d="M2.6 1.9 21 14.3a.95.95 0 0 1-.42 1.74l-8.1.9-3.98 7.5a.95.95 0 0 1-1.75-.2L2.5 3.1a.95.95 0 0 1 1.1-1.2Z"
                fill="url(#agent-pointer-fill)"
                stroke="url(#agent-pointer-stroke)"
                strokeWidth="1.5"
                strokeLinejoin="round"
              />
              <path
                d="M4.4 4.3 9.2 17"
                stroke="#ffffff"
                strokeOpacity="0.75"
                strokeWidth="1.1"
                strokeLinecap="round"
              />
            </svg>
            {label && (
              <span className="agent-cursor-label">
                <span className="agent-label-dot" />
                <span className="agent-label-text">{label}</span>
                {busy && (
                  <span className="agent-typing">
                    <i />
                    <i />
                    <i />
                  </span>
                )}
              </span>
            )}
          </div>
        </div>
      )}
    </AgentPresenceContext.Provider>
  );
}
