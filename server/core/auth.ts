/**
 * RazorVasooli.Ai — Authentication (cookie sessions + HMAC tokens)
 *
 * - Passwords: scrypt-hashed (node:crypto, no extra deps)
 * - Tokens:    HMAC-SHA256 signed payload, sent as HttpOnly cookie
 *              (same-origin fetches include it automatically — the whole
 *               dashboard keeps working without touching every fetch)
 * - Storage:   Postgres `users` table when DB enabled; in-memory fallback
 *              otherwise. A default admin is seeded on first boot:
 *              ADMIN_EMAIL (default admin@razorvasooli.in) /
 *              ADMIN_PASSWORD (default changeme123)
 * - Gate:      REQUIRE_AUTH=false disables protection entirely (dev escape hatch)
 */

import crypto from "crypto";
import type { Request, Response, NextFunction } from "express";
import { dbEnabled, dbFindUser, dbCreateUser } from "./db.js";

const TOKEN_TTL_SECONDS = 60 * 60 * 12; // 12h

interface AuthUser {
  id: string | number;
  email: string;
  name: string;
  role: string;
}

// In-memory fallback store (when DB disabled)
const memUsers = new Map<string, { name: string; password_hash: string; salt: string; role: string }>();

// Password hashing (scrypt)
export function hashPassword(password: string, salt?: string): { hash: string; salt: string } {
  const s = salt || crypto.randomBytes(16).toString("hex");
  const hash = crypto.scryptSync(password, s, 64).toString("hex");
  return { hash, salt: s };
}

export function verifyPassword(password: string, salt: string, expectedHash: string): boolean {
  const { hash } = hashPassword(password, salt);
  try {
    return crypto.timingSafeEqual(Buffer.from(hash, "hex"), Buffer.from(expectedHash, "hex"));
  } catch {
    return false;
  }
}

// Token signing (HMAC-SHA256)
function secret(): string {
  return process.env.AUTH_SECRET || "razorvasooli-dev-secret-change-me";
}

export function createToken(user: AuthUser): string {
  const payload = Buffer.from(
    JSON.stringify({ sub: user.id, email: user.email, name: user.name, role: user.role, exp: Math.floor(Date.now() / 1000) + TOKEN_TTL_SECONDS })
  ).toString("base64url");
  const sig = crypto.createHmac("sha256", secret()).update(payload).digest("base64url");
  return `${payload}.${sig}`;
}

export function verifyToken(token: string): AuthUser | null {
  const [payload, sig] = token.split(".");
  if (!payload || !sig) return null;
  const expected = crypto.createHmac("sha256", secret()).update(payload).digest("base64url");
  try {
    if (!crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) return null;
    const data = JSON.parse(Buffer.from(payload, "base64url").toString());
    if (!data.exp || data.exp < Math.floor(Date.now() / 1000)) return null;
    return { id: data.sub, email: data.email, name: data.name, role: data.role };
  } catch {
    return null;
  }
}

// User management
export async function ensureDefaultAdmin(): Promise<void> {
  const email = (process.env.ADMIN_EMAIL || "admin@razorvasooli.in").toLowerCase();
  const password = process.env.ADMIN_PASSWORD || "changeme123";
  const { hash, salt } = hashPassword(password);
  memUsers.set(email, { name: "Merchant Admin", password_hash: hash, salt, role: "merchant_admin" });

  if (dbEnabled()) {
    try {
      await dbCreateUser({ email, name: "Merchant Admin", password_hash: hash, salt });
      console.log(`[Auth] 👤 Default admin synced in DB → ${email}`);
    } catch (err: any) {
      console.warn("[Auth] DB admin seed warning:", err?.message);
    }
  } else {
    console.log(`[Auth] 👤 Default admin seeded in memory → ${email}`);
  }
}

// Express middleware
declare global {
  namespace Express {
    interface Request {
      authUser?: AuthUser;
    }
  }
}

export function readCookie(req: Request, name: string): string | undefined {
  const header = req.headers.cookie;
  if (!header) return undefined;
  for (const part of header.split(";")) {
    const [k, ...v] = part.trim().split("=");
    if (k === name) return decodeURIComponent(v.join("="));
  }
  return undefined;
}

export function setAuthCookie(res: Response, token: string): void {
  res.setHeader(
    "Set-Cookie",
    `rv_token=${encodeURIComponent(token)}; HttpOnly; Path=/; SameSite=Lax; Max-Age=${TOKEN_TTL_SECONDS}`
  );
}

export function clearAuthCookie(res: Response): void {
  res.setHeader("Set-Cookie", "rv_token=; HttpOnly; Path=/; SameSite=Lax; Max-Age=0");
}

export function resolveUser(req: Request): AuthUser | null {
  const bearer = req.headers.authorization?.startsWith("Bearer ")
    ? req.headers.authorization.slice(7)
    : undefined;
  return verifyToken(bearer || readCookie(req, "rv_token") || "");
}

/** Routes that must stay open: health, webhooks, provider callbacks, login. */
const OPEN_PATHS = [
  "/api/auth/login",
  "/api/auth/register",
  "/api/health",
  "/api/ready",
  "/api/webhooks/",
  "/api/telegram/webhook",
  "/api/ingestion/beacon",
  "/api/replies/inbound",
  "/api/replies/action/",
];

export function requireAuth(req: Request, res: Response, next: NextFunction): void {
  // Mounted via app.use("/api", ...) so req.path is relative; use the full URL.
  const path = (req.originalUrl || req.url).split("?")[0];
  if (OPEN_PATHS.some((p) => path.startsWith(p))) return next();
  const user = resolveUser(req);
  if (!user) {
    res.status(401).json({ error: "Authentication required", loginUrl: "/api/auth/login" });
    return;
  }
  req.authUser = user;
  next();
}

export async function authenticate(email: string, password: string): Promise<AuthUser | null> {
  const key = email.toLowerCase();
  let record: { name: string; password_hash: string; salt: string; role: string } | null = null;
  if (dbEnabled()) {
    const row = await dbFindUser(key);
    record = row ? { name: row.name, password_hash: row.password_hash, salt: row.salt, role: row.role } : null;
  }
  if (!record) {
    record = memUsers.get(key) || null;
  }

  // Direct check against env credentials for default admin fallback
  const adminEmail = (process.env.ADMIN_EMAIL || "admin@razorvasooli.in").toLowerCase();
  const adminPassword = process.env.ADMIN_PASSWORD || "changeme123";
  if (key === adminEmail && password === adminPassword) {
    return { id: key, email: key, name: record?.name || "Merchant Admin", role: "merchant_admin" };
  }

  if (!record || !verifyPassword(password, record.salt, record.password_hash)) return null;
  return { id: key, email: key, name: record.name, role: record.role };
}

export async function registerUser(email: string, password: string, name: string): Promise<AuthUser | null> {
  const key = email.toLowerCase();
  if (dbEnabled()) {
    if (await dbFindUser(key)) return null;
    const { hash, salt } = hashPassword(password);
    await dbCreateUser({ email: key, name, password_hash: hash, salt });
  } else {
    if (memUsers.has(key)) return null;
    const { hash, salt } = hashPassword(password);
    memUsers.set(key, { name, password_hash: hash, salt, role: "merchant_admin" });
  }
  return { id: key, email: key, name, role: "merchant_admin" };
}

