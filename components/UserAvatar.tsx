"use client";

import { useEffect, useState } from "react";

export function UserAvatar({
  photoURL,
  name,
  email,
  size = 32,
  className = "",
}: {
  photoURL?: string | null;
  name?: string | null;
  email?: string | null;
  size?: number;
  className?: string;
}) {
  const [loadedUrl, setLoadedUrl] = useState<string | null>(null);
  const [failedUrl, setFailedUrl] = useState<string | null>(null);

  const src = photoURL?.trim() || null;
  const loaded = Boolean(src && loadedUrl === src);
  const failed = !src || failedUrl === src;

  useEffect(() => {
    if (!src) return;
    let cancelled = false;
    const probe = new Image();
    probe.referrerPolicy = "no-referrer";
    probe.onload = () => {
      if (!cancelled) setLoadedUrl(src);
    };
    probe.onerror = () => {
      if (!cancelled) setFailedUrl(src);
    };
    probe.src = src;
    return () => {
      cancelled = true;
    };
  }, [src]);

  const rawLabel = (name || email || "U").trim();
  const words = rawLabel.split(/\s+/).filter(Boolean);
  const initials =
    words.length >= 2
      ? `${words[0][0]}${words[1][0]}`.toUpperCase()
      : rawLabel.slice(0, 2).toUpperCase();

  const fontSize = Math.max(10, Math.round(size * 0.38));

  return (
    <span
      className={className}
      style={{
        position: "relative",
        display: "inline-grid",
        placeItems: "center",
        width: size,
        height: size,
        minWidth: size,
        minHeight: size,
        borderRadius: "50%",
        overflow: "hidden",
        background: "linear-gradient(150deg, #2f7a63, #17453a)",
        color: "#eaf3ee",
        fontWeight: 700,
        fontSize,
        letterSpacing: "-0.02em",
        userSelect: "none",
        flexShrink: 0,
      }}
      aria-label={rawLabel}
    >
      {!failed && src && !loaded && (
        <span
          aria-hidden="true"
          style={{
            position: "absolute",
            inset: 0,
            background: "linear-gradient(90deg, rgba(255,255,255,0.12), rgba(255,255,255,0.28), rgba(255,255,255,0.12))",
            opacity: 0.75,
          }}
        />
      )}
      {!failed && src && loaded ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={src}
          alt={rawLabel}
          referrerPolicy="no-referrer"
          onError={() => setFailedUrl(src)}
          style={{
            width: "100%",
            height: "100%",
            objectFit: "cover",
            display: "block",
          }}
        />
      ) : (
        <span>{initials}</span>
      )}
    </span>
  );
}
