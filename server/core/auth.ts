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

// TODO: complete implementation step 16
