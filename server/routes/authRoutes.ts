import express, { type Request, type Response } from "express";
import { authenticate, registerUser, createToken, setAuthCookie, clearAuthCookie, resolveUser } from "../core/auth.js";

export function authRoutes(): express.Router {
  const r = express.Router();

  r.post("/login", async (req: Request, res: Response) => {
    const { email, password } = req.body || {};
    if (!email || !password) return res.status(400).json({ error: "email and password required" });
    const user = await authenticate(String(email), String(password));
    if (!user) return res.status(401).json({ error: "Invalid email or password" });
    setAuthCookie(res, createToken(user));
    return res.json({ success: true, user });
  });

  r.post("/register", async (req: Request, res: Response) => {
    const { email, password, name } = req.body || {};
    if (!email || !password || !name) return res.status(400).json({ error: "email, password and name required" });
    if (String(password).length < 8) return res.status(400).json({ error: "password must be at least 8 characters" });
    const user = await registerUser(String(email), String(password), String(name));
    if (!user) return res.status(409).json({ error: "User already exists" });
    setAuthCookie(res, createToken(user));
    return res.status(201).json({ success: true, user });
  });

  r.post("/logout", (_req: Request, res: Response) => {
    clearAuthCookie(res);
    res.json({ success: true });
  });

  r.get("/me", (req: Request, res: Response) => {
    const user = resolveUser(req);
    if (!user) return res.status(401).json({ error: "Not authenticated" });
    res.json({ user });
  });

  return r;
}
