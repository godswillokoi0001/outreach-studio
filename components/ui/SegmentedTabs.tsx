"use client";

/**
 * Single-row, horizontally scrollable chip tabs (Instagram / YouTube pattern).
 * Used anywhere the desktop layout would wrap filters onto three lines.
 */
export function SegmentedTabs<T extends string>({
  options,
  value,
  onChange,
  ariaLabel,
}: {
  options: { value: T; label: string; count?: number }[];
  value: T;
  onChange: (value: T) => void;
  ariaLabel?: string;
}) {
  return (
    <div className="tabs" role="tablist" aria-label={ariaLabel}>
      {options.map((option) => (
        <button
          key={option.value}
          type="button"
          role="tab"
          aria-selected={option.value === value}
          className={`tab${option.value === value ? " active" : ""}`}
          onClick={() => onChange(option.value)}
        >
          {option.label}
          {typeof option.count === "number" && option.count > 0 ? ` (${option.count})` : ""}
        </button>
      ))}
    </div>
  );
}
