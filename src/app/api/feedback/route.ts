import { NextRequest, NextResponse } from "next/server";
import { currentUser } from "@/lib/auth";
import { Pool } from "pg";

const url = process.env.DATABASE_URL;

export async function POST(req: NextRequest) {
  if (!url) return NextResponse.json({ error: "no db" }, { status: 503 });

  let body: { email?: string; message?: string; links?: string; category?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid json" }, { status: 400 });
  }

  const message = (body.message ?? "").trim();
  if (!message || message.length > 2000) {
    return NextResponse.json({ error: "message required (max 2000 chars)" }, { status: 400 });
  }

  const user = await currentUser();
  const email = body.email?.trim() || user?.email || null;
  const links = (body.links ?? "").trim().slice(0, 2000) || null;
  const category = body.category ?? "general";

  const pool = new Pool({ connectionString: url, max: 2 });
  try {
    await pool.query(
      "INSERT INTO feedback (user_id, email, message, category, links) VALUES ($1, $2, $3, $4, $5)",
      [user?.id ?? null, email, message, category, links],
    );
  } finally {
    await pool.end();
  }

  return NextResponse.json({ ok: true });
}
