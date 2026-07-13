"use server";

import { timingSafeEqual } from "crypto";
import { cookies, headers } from "next/headers";
import { redirect } from "next/navigation";
import {
  createSessionToken,
  SESSION_COOKIE,
  SESSION_MAX_AGE_SECONDS,
} from "@/lib/auth";

const RATE_LIMIT_WINDOW_MS = 60 * 1000;
const RATE_LIMIT_MAX_ATTEMPTS = 5;

// In-memory sliding window per IP; resets on server restart (fine at baseline, single instance).
const attemptsByIp = new Map<string, number[]>();

function isRateLimited(ip: string): boolean {
  const now = Date.now();
  const recent = (attemptsByIp.get(ip) ?? []).filter(
    (t) => now - t < RATE_LIMIT_WINDOW_MS,
  );
  if (recent.length >= RATE_LIMIT_MAX_ATTEMPTS) {
    attemptsByIp.set(ip, recent);
    return true;
  }
  recent.push(now);
  attemptsByIp.set(ip, recent);
  return false;
}

function passwordMatches(submitted: string, expected: string): boolean {
  // Pad to equal length so timingSafeEqual never throws and stays constant-time.
  const length = Math.max(submitted.length, expected.length, 1);
  const a = Buffer.alloc(length);
  const b = Buffer.alloc(length);
  a.write(submitted);
  b.write(expected);
  return timingSafeEqual(a, b) && submitted.length === expected.length;
}

function sanitizeFrom(from: unknown): string {
  if (typeof from === "string" && from.startsWith("/") && !from.startsWith("//")) {
    return from;
  }
  return "/";
}

export async function login(formData: FormData): Promise<void> {
  const from = sanitizeFrom(formData.get("from"));
  const backTo = (error: string) =>
    `/login?error=${error}${from !== "/" ? `&from=${encodeURIComponent(from)}` : ""}`;

  const ip =
    headers().get("x-forwarded-for")?.split(",")[0]?.trim() || "local";
  if (isRateLimited(ip)) {
    redirect(backTo("rate_limited"));
  }

  const expected = process.env.ACCESS_PASSWORD;
  if (!expected) {
    throw new Error("ACCESS_PASSWORD env var is not set");
  }

  const submitted = formData.get("password");
  if (typeof submitted !== "string" || !passwordMatches(submitted, expected)) {
    redirect(backTo("invalid"));
  }

  cookies().set(SESSION_COOKIE, await createSessionToken(), {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    maxAge: SESSION_MAX_AGE_SECONDS,
    path: "/",
  });
  redirect(from);
}
