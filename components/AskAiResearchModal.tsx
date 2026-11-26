"use client";

import { useEffect, useRef, useState } from "react";
import { Bot, ExternalLink, Send, Sparkles } from "lucide-react";
import { Modal } from "./ui";
import { FormattedChatMessage } from "./FormattedChatMessage";
import { authedPost, errorMessage } from "@/lib/client";

interface ChatMessage {
  id: string;
  role: "user" | "assistant";
  content: string;
  sources?: string[];
  inResearch?: boolean;
}

interface AskAiResearchModalProps {
  open: boolean;
  onClose: () => void;
  prospectName: string;
  prospectData: Record<string, unknown>;
}

export function AskAiResearchModal({
  open,
  onClose,
  prospectName,
  prospectData,
}: AskAiResearchModalProps) {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const endRef = useRef<HTMLDivElement>(null);
  const idCounterRef = useRef(0);

  const starterQuestions = [
    `Why was ${prospectName} qualified or rejected?`,
    "Where did you find the contact details?",
    "What specific website issues or evidence were found?",
    "What risks or missing information exist for this business?",
  ];

  useEffect(() => {
    if (open) {
      endRef.current?.scrollIntoView({ behavior: "smooth" });
    }
  }, [open, messages, busy]);

  const sendQuestion = async (q: string) => {
    const questionText = q.trim();
    if (!questionText || busy) return;

    const userMsg: ChatMessage = {
      id: `u-${++idCounterRef.current}`,
      role: "user",
      content: questionText,
    };

    setMessages((prev) => [...prev, userMsg]);
    setInput("");
    setBusy(true);
    setError(null);

    try {
      const historyPayload = messages.map((m) => ({
        role: m.role,
        content: m.content,
      }));

      const res = await authedPost<{
        answer: string;
        sources: string[];
        inResearch: boolean;
      }>("/api/ai/research-chat", {
        prospect: prospectData,
        question: questionText,
        history: historyPayload,
      });

      const assistantMsg: ChatMessage = {
        id: `a-${++idCounterRef.current}`,
        role: "assistant",
        content: res.answer,
        sources: res.sources,
        inResearch: res.inResearch,
      };

      setMessages((prev) => [...prev, assistantMsg]);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal open={open} onClose={onClose} title={`Research Q&A: ${prospectName}`} large>
      <div className="stack" style={{ gap: 12, height: "70vh", maxHeight: 580, display: "flex", flexDirection: "column" }}>
        <div
          style={{
            padding: "8px 12px",
            background: "var(--surface-sunken, rgba(0,0,0,0.03))",
            borderRadius: 6,
            border: "1px solid var(--line)",
            fontSize: 11.8,
            color: "var(--ink-2)",
          }}
        >
          <strong>Grounded Research Mode:</strong> Answers are strictly confined to the collected research, observed issues, and cited sources. Unverified claims or absent details are candidly noted as not found.
        </div>

        {/* Message feed */}
        <div
          style={{
            flex: 1,
            overflowY: "auto",
            padding: "8px 4px",
            display: "flex",
            flexDirection: "column",
            gap: 12,
          }}
        >
          {messages.length === 0 ? (
            <div style={{ textAlign: "center", padding: "24px 12px" }}>
              <Bot size={28} style={{ color: "var(--teal-deep)", margin: "0 auto 8px" }} />
              <div className="strong" style={{ fontSize: 14 }}>Ask anything about {prospectName}</div>
              <p className="tiny muted" style={{ maxWidth: 360, margin: "4px auto 16px" }}>
                Ask about qualification decisions, source URLs, decision-maker verifications, or digital issues.
              </p>
              <div className="stack" style={{ gap: 6, maxWidth: 440, margin: "0 auto" }}>
                {starterQuestions.map((q, idx) => (
                  <button
                    key={idx}
                    type="button"
                    className="btn btn-sm btn-ghost"
                    style={{ textAlign: "left", justifyContent: "flex-start", height: "auto", padding: "8px 12px", fontSize: 12 }}
                    onClick={() => void sendQuestion(q)}
                  >
                    <Sparkles size={12} style={{ color: "var(--teal-deep)", flexShrink: 0, marginRight: 6 }} />
                    {q}
                  </button>
                ))}
              </div>
            </div>
          ) : (
            messages.map((msg) => (
              <div
                key={msg.id}
                style={{
                  display: "flex",
                  flexDirection: "column",
                  alignSelf: msg.role === "user" ? "flex-end" : "flex-start",
                  maxWidth: "85%",
                }}
              >
                <div
                  style={{
                    padding: "10px 14px",
                    borderRadius: 10,
                    background: msg.role === "user" ? "var(--color-navy, #1e293b)" : "var(--surface, #ffffff)",
                    color: msg.role === "user" ? "#ffffff" : "var(--ink)",
                    border: msg.role === "user" ? "none" : "1px solid var(--line)",
                    fontSize: 13,
                    lineHeight: 1.5,
                  }}
                >
                  {msg.role === "assistant" ? (
                    <FormattedChatMessage text={msg.content} />
                  ) : (
                    msg.content
                  )}
                </div>

                {msg.sources && msg.sources.length > 0 && (
                  <div style={{ marginTop: 4, display: "flex", flexWrap: "wrap", gap: 6, paddingLeft: 4 }}>
                    <span className="tiny muted">Sources:</span>
                    {msg.sources.map((src, sIdx) => (
                      <a
                        key={sIdx}
                        href={src}
                        target="_blank"
                        rel="noreferrer"
                        className="tiny"
                        style={{ display: "inline-flex", alignItems: "center", gap: 3, color: "var(--teal-deep)" }}
                      >
                        {src.replace(/^https?:\/\//, "").slice(0, 32)}…
                        <ExternalLink size={9} aria-hidden="true" />
                      </a>
                    ))}
                  </div>
                )}
              </div>
            ))
          )}

          {busy && (
            <div style={{ display: "flex", gap: 8, alignItems: "center", color: "var(--muted)", fontSize: 12, padding: 8 }}>
              <span className="busy-dot" /> Checking research and sources…
            </div>
          )}

          {error && (
            <div style={{ color: "var(--danger, #dc2626)", fontSize: 12, padding: 6 }}>
              {error}
            </div>
          )}

          <div ref={endRef} />
        </div>

        {/* Input area */}
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void sendQuestion(input);
          }}
          className="row"
          style={{ gap: 8, marginTop: "auto", paddingTop: 8, borderTop: "1px solid var(--line)" }}
        >
          <input
            className="input"
            style={{ flex: 1 }}
            placeholder={`Ask a question about ${prospectName}…`}
            value={input}
            onChange={(e) => setInput(e.target.value)}
            disabled={busy}
          />
          <button type="submit" className="btn btn-primary" disabled={busy || !input.trim()}>
            <Send size={13} aria-hidden="true" />
            Ask
          </button>
        </form>
      </div>
    </Modal>
  );
}
