import { timingSafeEqual } from "node:crypto";
import type { NextRequest } from "next/server";
import { appStore } from "./store";

export const CONTROL_COOKIE = "emazna_loop_control";

function isLoopbackHost(value: string): boolean {
  const host = value.toLowerCase().replace(/^\[/, "").replace(/\]$/, "");
  return host === "127.0.0.1" || host === "localhost" || host === "::1";
}

function safeEqual(left: string, right: string): boolean {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}

export function assertLoopback(request: NextRequest): void {
  const hostHeader = request.headers.get("host") ?? "";
  const hostname = hostHeader.startsWith("[")
    ? hostHeader.slice(1, hostHeader.indexOf("]"))
    : hostHeader.split(":")[0] ?? "";
  if (!isLoopbackHost(hostname)) throw new Error("Loopy only accepts loopback requests.");

  const origin = request.headers.get("origin");
  if (origin) {
    let originHost = "";
    try {
      originHost = new URL(origin).hostname;
    } catch {
      throw new Error("Invalid Origin header.");
    }
    if (!isLoopbackHost(originHost)) throw new Error("Cross-origin control request rejected.");
  }
}

export function assertControlRequest(request: NextRequest): void {
  assertLoopback(request);
  const origin = request.headers.get("origin");
  if (origin) {
    let submittedHost = "";
    try {
      submittedHost = new URL(origin).host;
    } catch {
      throw new Error("Invalid Origin header.");
    }
    const requestHost = request.headers.get("host") ?? "";
    if (submittedHost.toLowerCase() !== requestHost.toLowerCase()) {
      throw new Error("Cross-origin control request rejected.");
    }
  }
  const expected = appStore().getOrCreateControlToken();
  const actual = request.cookies.get(CONTROL_COOKIE)?.value ?? "";
  if (!actual || !safeEqual(actual, expected)) throw new Error("Missing local control token.");
}
