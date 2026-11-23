"use client";

import { animate, useReducedMotion } from "framer-motion";
import { useEffect, useState } from "react";

/**
 * Numbers that count up instead of snapping into place.
 *
 * The first render is always `0` on both server and client so hydration stays
 * deterministic. The tween (or the instant jump, when the visitor prefers
 * reduced motion) starts in an effect.
 */
export function CountUp({
  value,
  prefix = "",
  suffix = "",
  decimals = 0,
  className,
}: {
  value: number;
  prefix?: string;
  suffix?: string;
  decimals?: number;
  className?: string;
}) {
  const reduce = useReducedMotion();
  const [progress, setProgress] = useState(0);

  useEffect(() => {
    const controls = animate(0, 1, {
      duration: reduce ? 0.001 : 0.9,
      ease: [0.22, 0.61, 0.36, 1],
      onUpdate: (latest) => setProgress(latest),
      onComplete: () => setProgress(1),
    });
    return () => controls.stop();
  }, [reduce, value]);

  return (
    <span className={className}>
      {prefix}
      {(value * progress).toFixed(decimals)}
      {suffix}
    </span>
  );
}
