const SIZE_MAP = {
  sm: 28,
  md: 48,
  lg: 72,
} as const;

export type BrandLoaderSize = keyof typeof SIZE_MAP | number;

export function BrandLoader({
  size = "md",
  fullScreen = false,
  className,
}: {
  /** Preset (sm 28px, md 48px, lg 72px) or a custom pixel size. */
  size?: BrandLoaderSize;
  /** Center the loader on a full-height themed screen. */
  fullScreen?: boolean;
  /** Optional wrapper classes. */
  className?: string;
}) {
  const px = typeof size === "number" ? size : SIZE_MAP[size];

  const mark = (
    <div
      className="brand-loader"
      role="status"
      aria-label="Loading"
      style={{ width: px, height: px }}
    >
      <svg
        viewBox="0 0 200 200"
        fill="none"
        xmlns="http://www.w3.org/2000/svg"
        className="brand-loader-svg"
        aria-hidden="true"
      >
        {/* 1. Top-Left Anchor */}
        <path
          className="k-part k-anchor fill-[#001247] dark:fill-white"
          d="M 36 66 A 32 32 0 0 1 68 34 L 84 34 L 84 66 C 84 78, 79 85, 71 93 L 36 128 Z"
        />
        {/* 2. Top-Right Cyan Wing */}
        <path
          className="k-part k-wing"
          d="M 166 34 L 130 34 C 121 34, 115 38, 108 45 L 79 74 L 112 74 C 121 74, 127 70, 134 63 L 166 34 Z"
        />
        {/* 3. Bottom Arch Leg */}
        <path
          className="k-part k-arch fill-[#001247] dark:fill-white"
          d="M 36 140 L 76 100 C 83 93, 89 86, 100 86 L 106 86 C 116 86, 123 91, 131 99 L 166 156 L 132 156 C 123 156, 117 152, 110 145 L 98 133 C 93 128, 87 128, 82 133 L 70 145 C 63 152, 57 156, 48 156 L 36 156 Z"
        />
      </svg>
    </div>
  );

  if (!fullScreen) {
    return className ? <div className={className}>{mark}</div> : mark;
  }

  return (
    <div
      className={`brand-loader-screen min-h-screen bg-slate-50 dark:bg-[#070D1F]${
        className ? ` ${className}` : ""
      }`}
    >
      {mark}
    </div>
  );
}

export default BrandLoader;
