/**
 * The workspace's real screens, in one place.
 *
 * The auth provider uses this to tell a real workspace route from a mistyped
 * address: unknown paths must reach the 404 page instead of being replaced by
 * the marketing landing, which used to happen because the landing stands in for
 * every signed-out route.
 */

export const WORKSPACE_ROUTES = [
  "/",
  "/admin",
  "/analytics",
  "/campaigns",
  "/conversations",
  "/followups",
  "/growth-advisor",
  "/integrations",
  "/knowledge",
  "/leads",
  "/onboarding",
  "/privacy-policy",
  "/research",
  "/review",
  "/sent",
  "/settings",
  "/sheets",
  "/terms",
] as const;

export function isWorkspaceRoute(pathname: string): boolean {
  const path = pathname.length > 1 ? pathname.replace(/\/+$/, "") : pathname;
  return WORKSPACE_ROUTES.some((route) => route === path || (route !== "/" && path.startsWith(`${route}/`)));
}
