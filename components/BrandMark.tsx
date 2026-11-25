/**
 * Brand components.
 *
 * These render the supplied Knowrevo artwork exactly as delivered — the mark,
 * the horizontal lockups and the app icons are the original PNG files in
 * public/brand (resized only, never redrawn or traced).
 *
 * Tone picks the artwork for the surface behind it:
 *   brand → follows the theme (navy mark on light, white mark on dark)
 *   dark  → always the white + teal mark, for the navy sidebar
 */

const MARK_LIGHT = "/brand/knowrevo-mark.png";
const MARK_DARK = "/brand/knowrevo-mark-dark.png";
const LOCKUP_LIGHT = "/brand/knowrevo-logo.png";
const LOCKUP_DARK = "/brand/knowrevo-logo-dark.png";

export type BrandTone = "brand" | "dark";

/** Both variants are rendered; CSS shows the one that matches the theme. */
function Swap({
  light,
  dark,
  height,
  alt,
  className,
}: {
  light: string;
  dark: string;
  height: number;
  alt: string;
  className: string;
}) {
  return (
    <span className="brand-swap">
      <img
        src={light}
        alt={alt}
        className={`${className} brand-swap-light`}
        style={{ height }}
        decoding="async"
      />
      <img
        src={dark}
        alt={alt}
        aria-hidden="true"
        className={`${className} brand-swap-dark`}
        style={{ height }}
        decoding="async"
      />
    </span>
  );
}

export function BrandMark({
  size = 26,
  tone = "brand",
  className,
}: {
  size?: number;
  tone?: BrandTone;
  className?: string;
}) {
  if (tone === "dark") {
    return (
      <img
        src={MARK_DARK}
        alt=""
        aria-hidden="true"
        className={`brand-glyph${className ? ` ${className}` : ""}`}
        style={{ height: size, width: "auto" }}
        decoding="async"
      />
    );
  }
  return (
    <Swap
      light={MARK_LIGHT}
      dark={MARK_DARK}
      height={size}
      alt=""
      className={`brand-glyph${className ? ` ${className}` : ""}`}
    />
  );
}

export function BrandLockup({
  size = 22,
  tone = "brand",
  subtitle,
  className,
}: {
  size?: number;
  tone?: BrandTone;
  subtitle?: string;
  className?: string;
}) {
  return (
    <span className={`brand-lockup${tone === "dark" ? " brand-lockup-dark" : ""}${className ? ` ${className}` : ""}`}>
      {tone === "dark" ? (
        <img
          src={LOCKUP_DARK}
          alt="Knowrevo"
          className="brand-lockup-img"
          style={{ height: size }}
          decoding="async"
        />
      ) : (
        <Swap light={LOCKUP_LIGHT} dark={LOCKUP_DARK} height={size} alt="Knowrevo" className="brand-lockup-img" />
      )}
      {subtitle ? <span className="brand-lockup-sub">{subtitle}</span> : null}
    </span>
  );
}
