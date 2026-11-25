/**
 * Knowrevo symbol — the geometric K from the brand sheet.
 *
 * Three strokes on a 100 × 81 grid: a navy stem, a teal upper arm and a navy
 * lower arch. The mark is drawn wider than tall, so the height follows the
 * width and the shape never distorts.
 */
const NAVY = "#081625";
const TEAL = "#20CCC8";

export function MarkGlyph({ structure }: { structure: string }) {
  return (
    <>
      {/* Stem: rounded shoulder, straight left edge, cut on the same diagonal as the arm. */}
      <path d="M33 0H19C8.5 0 0 8.5 0 19v25l33-25Z" fill={structure} />
      {/* Upper arm: teal parallelogram with a soft outer tip. */}
      <path
        d="M35.55 23.81Q32.8 25.8 36.2 25.8H59Q61.6 25.8 63.75 24.35L98.67 0.89Q100 0 98.4 0H70.7Q68.5 0 66.72 1.29Z"
        fill={TEAL}
      />
      {/* Lower arch: left foot, rounded apex, long leg tapering to the right point. */}
      <path
        d="M0 56.2Q0 54.7 1.45 54.31L37.14 44.64Q41 43.6 44.39 45.72L98.98 79.86Q100 80.5 98.8 80.5H60.2Q59 80.5 58.16 79.65L43.11 64.43Q41 62.3 38.66 64.17L19.14 79.75Q18.2 80.5 17 80.5H4Q0 80.5 0 76.5Z"
        fill={structure}
      />
    </>
  );
}

export function BrandMark({
  size = 30,
  tone = "brand",
  className,
}: {
  size?: number;
  /** brand = navy + teal on light surfaces; dark = white + teal on navy. */
  tone?: "brand" | "dark";
  className?: string;
}) {
  const structure = tone === "dark" ? "#FFFFFF" : NAVY;

  return (
    <svg
      width={size}
      height={Math.round(size * 81) / 100}
      viewBox="0 0 100 81"
      className={className ? `brand-symbol ${className}` : "brand-symbol"}
      role="img"
      aria-label="Knowrevo"
      focusable="false"
    >
      <MarkGlyph structure={structure} />
    </svg>
  );
}

export function BrandLockup({
  tone = "brand",
  size = 30,
  subtitle,
}: {
  tone?: "brand" | "dark";
  size?: number;
  subtitle?: string;
}) {
  return (
    <span className="brand-lockup">
      <BrandMark size={size} tone={tone} />
      <span className="brand-lockup-copy">
        <span className="brand-lockup-name">Knowrevo</span>
        {subtitle ? <span className="brand-lockup-sub">{subtitle}</span> : null}
      </span>
    </span>
  );
}
