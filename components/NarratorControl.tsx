"use client";

import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { Pause, Play, Square, Volume2, VolumeX } from "lucide-react";

interface NarratorControlProps {
  /** The full text to read aloud */
  text: string;
  /** Optional callback providing the currently reading sentence index or string for highlighting */
  onSentenceChange?: (sentenceIndex: number, currentSentence: string) => void;
  className?: string;
}

export function NarratorControl({ text, onSentenceChange, className }: NarratorControlProps) {
  const supported = useSyncExternalStore(
    () => () => {},
    () => typeof window !== "undefined" && "speechSynthesis" in window,
    () => false,
  );
  const [status, setStatus] = useState<"idle" | "playing" | "paused">("idle");
  const [speed, setSpeed] = useState<number>(1);
  const [activeSentence, setActiveSentence] = useState<string>("");

  const sentencesRef = useRef<string[]>([]);
  const currentIndexRef = useRef<number>(-1);
  const speedRef = useRef<number>(1);
  const statusRef = useRef<"idle" | "playing" | "paused">("idle");

  useEffect(() => {
    speedRef.current = speed;
  }, [speed]);

  useEffect(() => {
    statusRef.current = status;
  }, [status]);

  // Split text into readable sentences
  useEffect(() => {
    if (!text) {
      sentencesRef.current = [];
      return;
    }
    const clean = text.replace(/[*#_`]/g, " ").replace(/\s+/g, " ").trim();
    const split = clean.match(/[^.!?]+[.!?]+(\s+|$)|[^.!?]+$/g);
    sentencesRef.current = (split || [clean]).map((s) => s.trim()).filter((s) => s.length > 0);
  }, [text]);

  const speakSentence = (index: number) => {
    if (typeof window === "undefined" || !("speechSynthesis" in window)) return;
    const synth = window.speechSynthesis;

    if (index >= sentencesRef.current.length) {
      synth.cancel();
      setStatus("idle");
      setActiveSentence("");
      onSentenceChange?.(-1, "");
      return;
    }

    currentIndexRef.current = index;
    const sentence = sentencesRef.current[index];
    setActiveSentence(sentence);
    onSentenceChange?.(index, sentence);

    synth.cancel();

    const utterance = new SpeechSynthesisUtterance(sentence);
    utterance.rate = speedRef.current;

    utterance.onend = () => {
      if (statusRef.current === "playing") {
        speakSentence(index + 1);
      }
    };

    utterance.onerror = (e) => {
      if (e.error !== "canceled" && e.error !== "interrupted") {
        setStatus("idle");
        setActiveSentence("");
        onSentenceChange?.(-1, "");
      }
    };

    synth.speak(utterance);
  };

  const handlePlay = () => {
    if (!supported || sentencesRef.current.length === 0) return;
    setStatus("playing");
    speakSentence(currentIndexRef.current >= 0 ? currentIndexRef.current : 0);
  };

  const handlePause = () => {
    if (typeof window === "undefined" || !("speechSynthesis" in window)) return;
    window.speechSynthesis.cancel();
    setStatus("paused");
  };

  const handleResume = () => {
    if (!supported) return;
    setStatus("playing");
    speakSentence(currentIndexRef.current >= 0 ? currentIndexRef.current : 0);
  };

  const handleStop = () => {
    if (typeof window === "undefined" || !("speechSynthesis" in window)) return;
    window.speechSynthesis.cancel();
    setStatus("idle");
    setActiveSentence("");
    currentIndexRef.current = -1;
    onSentenceChange?.(-1, "");
  };

  const handleSpeedChange = (newSpeed: number) => {
    setSpeed(newSpeed);
    speedRef.current = newSpeed;
    if (status === "playing") {
      // Re-speak current sentence with new speed
      speakSentence(currentIndexRef.current >= 0 ? currentIndexRef.current : 0);
    }
  };

  if (!supported) {
    return (
      <span className="tiny muted" title="Speech synthesis is not supported on this browser">
        <VolumeX size={13} style={{ verticalAlign: "middle", marginRight: 4 }} />
        Listen unsupported
      </span>
    );
  }

  return (
    <div
      className={`narrator-controls ${className ?? ""}`}
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 6,
        padding: "3px 8px",
        borderRadius: 20,
        background: "var(--surface-sunken, rgba(0,0,0,0.04))",
        border: "1px solid var(--line)",
      }}
    >
      {status === "idle" && (
        <button
          type="button"
          className="btn btn-sm btn-ghost"
          style={{ height: 26, padding: "0 8px", fontSize: 11.5, gap: 4 }}
          onClick={handlePlay}
          title="Listen to this report"
        >
          <Volume2 size={13} aria-hidden="true" />
          Listen
        </button>
      )}

      {status === "playing" && (
        <>
          <button
            type="button"
            className="btn btn-sm btn-ghost"
            style={{ height: 26, padding: "0 6px", fontSize: 11.5, gap: 4, color: "var(--teal-deep)" }}
            onClick={handlePause}
            title="Pause narration"
          >
            <Pause size={12} aria-hidden="true" />
            Pause
          </button>
          <button
            type="button"
            className="btn btn-sm btn-ghost"
            style={{ height: 26, padding: "0 6px", fontSize: 11.5 }}
            onClick={handleStop}
            title="Stop narration"
          >
            <Square size={11} aria-hidden="true" />
          </button>
        </>
      )}

      {status === "paused" && (
        <>
          <button
            type="button"
            className="btn btn-sm btn-ghost"
            style={{ height: 26, padding: "0 6px", fontSize: 11.5, gap: 4 }}
            onClick={handleResume}
            title="Resume narration"
          >
            <Play size={12} aria-hidden="true" />
            Resume
          </button>
          <button
            type="button"
            className="btn btn-sm btn-ghost"
            style={{ height: 26, padding: "0 6px", fontSize: 11.5 }}
            onClick={handleStop}
            title="Stop narration"
          >
            <Square size={11} aria-hidden="true" />
          </button>
        </>
      )}

      {status !== "idle" && (
        <div style={{ display: "inline-flex", gap: 2, alignItems: "center", borderLeft: "1px solid var(--line)", paddingLeft: 4 }}>
          {[0.75, 1, 1.25, 1.5].map((s) => (
            <button
              key={s}
              type="button"
              className={`btn btn-sm ${speed === s ? "btn-primary" : "btn-ghost"}`}
              style={{
                height: 20,
                padding: "0 4px",
                fontSize: 10,
                fontWeight: speed === s ? 700 : 400,
                borderRadius: 4,
              }}
              onClick={() => handleSpeedChange(s)}
            >
              {s}x
            </button>
          ))}
        </div>
      )}
      {status !== "idle" && activeSentence && (
        <span
          className="tiny"
          style={{
            maxWidth: 260,
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
            padding: "1px 6px",
            borderRadius: 4,
            background: "rgba(15, 118, 110, 0.12)",
            color: "var(--teal-deep)",
          }}
          title={activeSentence}
        >
          {activeSentence}
        </span>
      )}
    </div>
  );
}
