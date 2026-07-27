"use client";

import { useState } from "react";
import Link from "next/link";

export default function FeedbackPage() {
  const [email, setEmail] = useState("");
  const [message, setMessage] = useState("");
  const [status, setStatus] = useState<"idle" | "sending" | "sent" | "error">("idle");

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!message.trim()) return;
    setStatus("sending");
    try {
      const res = await fetch("/api/feedback", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: email || undefined, message }),
      });
      if (!res.ok) throw new Error();
      setStatus("sent");
      setMessage("");
    } catch {
      setStatus("error");
    }
  }

  return (
    <main className="min-h-screen">
      <header className="sticky top-0 z-20 border-b border-line/60 bg-bg/80 backdrop-blur">
        <nav className="mx-auto flex h-16 max-w-content items-center justify-between px-6">
          <Link href="/" className="font-mono text-note tracking-[0.18em] text-fg">
            GG LUT LAB
          </Link>
          <Link
            href="/studio"
            className="rounded-full bg-accent px-5 py-2 text-[14px] font-medium text-[#1A0F2E] ease-brand transition hover:-translate-y-px"
          >
            Go Studio
          </Link>
        </nav>
      </header>

      <section className="mx-auto max-w-[520px] px-6 py-20">
        <h1 className="text-section font-medium">Feedback</h1>
        <p className="mt-3 text-body text-muted">
          Tell us what you think, report a bug, or request a feature.
        </p>

        {status === "sent" ? (
          <div className="mt-10 rounded-xl border border-line bg-surface p-8 text-center">
            <p className="text-card font-medium">Thanks for your feedback!</p>
            <p className="mt-2 text-body text-muted">We'll get back to you if needed.</p>
            <button
              onClick={() => setStatus("idle")}
              className="mt-6 rounded-full border border-line px-6 py-2 text-[14px] text-fg hover:bg-surface"
            >
              Send another
            </button>
          </div>
        ) : (
          <form onSubmit={handleSubmit} className="mt-10 space-y-5">
            <div>
              <label className="block text-note text-muted mb-2">
                Email (optional)
              </label>
              <input
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="your@email.com"
                className="w-full rounded-lg border border-line bg-surface px-4 py-3 text-body text-fg placeholder:text-muted/50 outline-none focus:border-accent"
              />
            </div>
            <div>
              <label className="block text-note text-muted mb-2">
                Message <span className="text-accent">*</span>
              </label>
              <textarea
                value={message}
                onChange={(e) => setMessage(e.target.value)}
                required
                rows={5}
                maxLength={2000}
                placeholder="What's on your mind?"
                className="w-full rounded-lg border border-line bg-surface px-4 py-3 text-body text-fg placeholder:text-muted/50 outline-none focus:border-accent resize-none"
              />
            </div>
            {status === "error" && (
              <p className="text-note text-red-400">Something went wrong. Please try again.</p>
            )}
            <button
              type="submit"
              disabled={status === "sending" || !message.trim()}
              className="rounded-full bg-accent px-7 py-3 text-[15px] font-medium text-[#1A0F2E] disabled:opacity-50"
            >
              {status === "sending" ? "Sending..." : "Send Feedback"}
            </button>
          </form>
        )}
      </section>
    </main>
  );
}
