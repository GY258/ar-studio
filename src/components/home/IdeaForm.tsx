"use client";

import { useState } from "react";
import { COPY } from "@/lib/copy";
import { primaryButton } from "./bits";

/** 主页上的一行留言框，走和 /feedback 同一个接口。 */
export function IdeaForm() {
  const [idea, setIdea] = useState("");
  const [status, setStatus] = useState<"idle" | "sending" | "sent" | "error">("idle");

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!idea.trim()) return;
    setStatus("sending");
    try {
      const res = await fetch("/api/feedback", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message: idea, category: "general" }),
      });
      if (!res.ok) throw new Error();
      setIdea("");
      setStatus("sent");
    } catch {
      setStatus("error");
    }
  }

  return (
    <div>
      <form onSubmit={submit} className="relative flex flex-col gap-3 sm:block">
        <label htmlFor="idea-input" className="sr-only">
          {COPY.home.ideaLabel}
        </label>
        <input
          id="idea-input"
          name="idea"
          required
          maxLength={1000}
          value={idea}
          onChange={(e) => {
            setIdea(e.target.value);
            if (status !== "sending") setStatus("idle");
          }}
          placeholder={COPY.home.ideaPlaceholder}
          className="h-14 w-full rounded-full border border-home-line bg-white px-6 font-dm text-base text-home-fg placeholder:text-home-hint focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-home-dot sm:pr-44"
        />
        <button
          type="submit"
          disabled={status === "sending"}
          className={`${primaryButton} h-11 px-6 text-sm sm:absolute sm:right-1.5 sm:top-1.5`}
        >
          {status === "sending" ? COPY.home.ideaSending : COPY.home.ideaCta}
        </button>
      </form>
      <p aria-live="polite" className={`mt-3 min-h-5 px-2 font-dm text-sm ${status === "error" ? "text-rec" : "text-home-accent"}`}>
        {status === "sent" ? COPY.home.ideaThanks : status === "error" ? COPY.home.ideaFailed : ""}
      </p>
    </div>
  );
}
