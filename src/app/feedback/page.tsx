"use client";

import { useState } from "react";
import Link from "next/link";

export default function FeedbackPage() {
  const [email, setEmail] = useState("");
  const [message, setMessage] = useState("");
  const [links, setLinks] = useState("");
  const [category, setCategory] = useState("general");
  const [status, setStatus] = useState<"idle" | "sending" | "sent" | "error">("idle");

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!message.trim()) return;
    setStatus("sending");
    try {
      const res = await fetch("/api/feedback", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          email: email || undefined,
          message,
          links: links || undefined,
          category,
        }),
      });
      if (!res.ok) throw new Error();
      setStatus("sent");
      setMessage("");
      setLinks("");
    } catch {
      setStatus("error");
    }
  }

  return (
    <main className="min-h-[100dvh]">
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
        <h1 className="text-section font-medium">Feedback & Requests</h1>
        <p className="mt-3 text-body text-muted">
          Share your ideas, report bugs, or request a custom filter. Paste reference links and we'll build it for you.
        </p>

        {status === "sent" ? (
          <div className="mt-10 rounded-xl border border-line bg-surface p-8 text-center">
            <p className="text-card font-medium">Thanks! We got it.</p>
            <p className="mt-2 text-body text-muted">We'll check your request and get back to you if you left an email.</p>
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
              <label className="block text-note text-muted mb-2">What kind of request?</label>
              <div className="flex flex-wrap gap-2">
                {[
                  { value: "general", label: "General feedback" },
                  { value: "filter", label: "Custom filter request" },
                  { value: "bug", label: "Bug report" },
                ].map((opt) => (
                  <button
                    key={opt.value}
                    type="button"
                    onClick={() => setCategory(opt.value)}
                    className={`rounded-full px-4 py-2 text-[13px] border transition ${
                      category === opt.value
                        ? "border-accent text-accent bg-accent/10"
                        : "border-line text-muted hover:border-accent/50"
                    }`}
                  >
                    {opt.label}
                  </button>
                ))}
              </div>
            </div>

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
                rows={4}
                maxLength={2000}
                placeholder={
                  category === "filter"
                    ? "Describe the filter you want — what should it look like? What's the vibe?"
                    : "What's on your mind?"
                }
                className="w-full rounded-lg border border-line bg-surface px-4 py-3 text-body text-fg placeholder:text-muted/50 outline-none focus:border-accent resize-none"
              />
            </div>

            <div>
              <label className="block text-note text-muted mb-2">
                Reference links (optional)
              </label>
              <textarea
                value={links}
                onChange={(e) => setLinks(e.target.value)}
                rows={3}
                maxLength={2000}
                placeholder={"Paste Instagram, TikTok, Pinterest links, or image URLs — one per line"}
                className="w-full rounded-lg border border-line bg-surface px-4 py-3 text-body text-fg placeholder:text-muted/50 outline-none focus:border-accent resize-none"
              />
              <p className="mt-1 text-[11px] text-muted">We'll use these as reference to design your filter.</p>
            </div>

            {status === "error" && (
              <p className="text-note text-red-400">Something went wrong. Please try again.</p>
            )}
            <button
              type="submit"
              disabled={status === "sending" || !message.trim()}
              className="rounded-full bg-accent px-7 py-3 text-[15px] font-medium text-[#1A0F2E] disabled:opacity-50"
            >
              {status === "sending" ? "Sending..." : "Submit"}
            </button>
          </form>
        )}
      </section>
    </main>
  );
}
