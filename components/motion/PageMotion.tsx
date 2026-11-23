"use client";

import { usePathname } from "next/navigation";
import { useRef, type ReactNode } from "react";
import { gsap } from "gsap";
import { useGSAP } from "@gsap/react";

gsap.registerPlugin(useGSAP);

/** Blocks revealed on every page, in reading order. */
const BLOCKS = [
  ".page-head > div",
  ".hero",
  ".hero-chip",
  ".quick-card",
  ".setup-step",
  ".stat",
  ".card",
  ".banner",
  ".empty",
  "table tbody tr",
];

/**
 * Route-level GSAP choreography.
 *
 * Everything that renders inside a page gets a staggered entrance, data that
 * arrives later is picked up by a MutationObserver, and progress bars draw
 * themselves instead of appearing at full width. Runs entirely client-side and
 * does nothing when the visitor asks for reduced motion.
 */
export function PageMotion({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  const scope = useRef<HTMLDivElement>(null);

  useGSAP(
    () => {
      const root = scope.current;
      if (!root) return;
      if (typeof window === "undefined") return;
      if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;

      const seen = new WeakSet<Element>();
      const pick = (selector: string) =>
        Array.from(root.querySelectorAll<HTMLElement>(selector)).filter((el) => !seen.has(el));

      const intro = () => {
        for (const selector of BLOCKS) {
          const elements = pick(selector);
          if (!elements.length) continue;
          elements.forEach((el) => seen.add(el));
          gsap.from(elements, {
            y: 18,
            duration: 0.52,
            ease: "power3.out",
            stagger: selector === "table tbody tr" ? 0.03 : 0.055,
            overwrite: "auto",
            clearProps: "transform",
          });
        }

        const widthBars = pick(".funnel-fill, .camp-row-bar > span, .load-track > span, .pipe-bar");
        if (widthBars.length) {
          widthBars.forEach((el) => seen.add(el));
          gsap.from(widthBars, {
            scaleX: 0,
            transformOrigin: "left center",
            duration: 0.75,
            ease: "power2.out",
            stagger: 0.035,
            overwrite: "auto",
            clearProps: "transform",
          });
        }

        const heightBars = pick(".spark-bar");
        if (heightBars.length) {
          heightBars.forEach((el) => seen.add(el));
          gsap.from(heightBars, {
            scaleY: 0,
            transformOrigin: "bottom center",
            duration: 0.65,
            ease: "power2.out",
            stagger: 0.025,
            overwrite: "auto",
            clearProps: "transform",
          });
        }

        const badges = pick(".rail-step, .pipe-step, .mini-rows li");
        if (badges.length) {
          badges.forEach((el) => seen.add(el));
          gsap.from(badges, {
            y: 10,
            duration: 0.4,
            ease: "power2.out",
            stagger: 0.03,
            overwrite: "auto",
            clearProps: "transform",
          });
        }
      };

      intro();

      let timer: ReturnType<typeof setTimeout> | undefined;
      const observer = new MutationObserver(() => {
        if (timer) clearTimeout(timer);
        timer = setTimeout(intro, 130);
      });
      observer.observe(root, { childList: true, subtree: true });

      return () => {
        observer.disconnect();
        if (timer) clearTimeout(timer);
      };
    },
    { scope, dependencies: [pathname], revertOnUpdate: true },
  );

  return (
    <div ref={scope} className="page-motion">
      {children}
    </div>
  );
}
