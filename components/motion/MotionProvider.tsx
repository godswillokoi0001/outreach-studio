"use client";

import { MotionConfig } from "framer-motion";

/**
 * Global motion defaults. `reducedMotion="user"` makes every Framer Motion
 * animation respect the operating system's reduce-motion setting.
 */
export function MotionProvider({ children }: { children: React.ReactNode }) {
  return (
    <MotionConfig
      reducedMotion="user"
      transition={{ type: "spring", stiffness: 320, damping: 30, mass: 0.8 }}
    >
      {children}
    </MotionConfig>
  );
}
