/**
 * Theme choice: light, dark or follow the OS.
 *
 * The choice is applied to <html data-theme> so every token layer can respond
 * without React re-rendering, and it is written to localStorage under one key.
 * THEME_SCRIPT runs inline in <head> before the body paints, which is what
 * keeps a dark-mode reload from flashing white.
 */

export type ThemeChoice = "light" | "dark" | "system";
export type ResolvedTheme = "light" | "dark";

export const THEME_KEY = "knowrevo:theme";

export function isThemeChoice(value: unknown): value is ThemeChoice {
  return value === "light" || value === "dark" || value === "system";
}

export function systemTheme(): ResolvedTheme {
  if (typeof window === "undefined") return "light";
  return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

export function resolveTheme(choice: ThemeChoice): ResolvedTheme {
  return choice === "system" ? systemTheme() : choice;
}

export function readThemeChoice(): ThemeChoice {
  if (typeof document === "undefined") return "system";
  const fromDom = document.documentElement.dataset.themeChoice;
  return isThemeChoice(fromDom) ? fromDom : "system";
}

export function applyTheme(choice: ThemeChoice): ResolvedTheme {
  if (typeof document === "undefined") return "light";
  const resolved = resolveTheme(choice);
  const root = document.documentElement;
  root.dataset.theme = resolved;
  root.dataset.themeChoice = choice;
  root.style.colorScheme = resolved;
  try {
    window.localStorage.setItem(THEME_KEY, choice);
  } catch {
    /* storage blocked — the choice still applies for this page */
  }
  return resolved;
}

/** Inline, render-blocking: sets the theme before first paint. */
export const THEME_SCRIPT = `(function(){try{var k="${THEME_KEY}";var c=localStorage.getItem(k);if(c!=="light"&&c!=="dark")c="system";var d=window.matchMedia("(prefers-color-scheme: dark)").matches;var t=c==="system"?(d?"dark":"light"):c;var r=document.documentElement;r.dataset.theme=t;r.dataset.themeChoice=c;r.style.colorScheme=t;}catch(e){document.documentElement.dataset.theme="light";}})();`;
