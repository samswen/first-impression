/**
 * Session authentication for First Impression
 *
 * Uses signed JWT cookies (HMAC-SHA256) with no external dependencies.
 * Sessions last 14 days. All auth operations go through rag-chatbot API.
 */

import crypto from "node:crypto";
import type { NextFunction, Request, Response } from "express";

const SESSION_SECRET = process.env.FIRST_IMPRESSION_SECRET || "";
const COOKIE_NAME = "fi_session";
const SESSION_MAX_AGE = 14 * 24 * 60 * 60; // 14 days in seconds

export interface SessionUser {
	userId: number;
	email: string;
	name: string;
}

// Extend Express Request to include user
declare global {
	namespace Express {
		interface Request {
			user?: SessionUser;
		}
	}
}

// --- JWT helpers (HMAC-SHA256, no external deps) ---

function base64url(buf: Buffer): string {
	return buf.toString("base64url");
}

function base64urlEncode(str: string): string {
	return Buffer.from(str).toString("base64url");
}

function base64urlDecode(str: string): string {
	return Buffer.from(str, "base64url").toString();
}

export function createSessionToken(user: SessionUser): string {
	if (!SESSION_SECRET) throw new Error("FIRST_IMPRESSION_SECRET not set");

	const header = base64urlEncode(JSON.stringify({ alg: "HS256", typ: "JWT" }));
	const payload = base64urlEncode(
		JSON.stringify({
			sub: user.userId,
			email: user.email,
			name: user.name,
			iat: Math.floor(Date.now() / 1000),
			exp: Math.floor(Date.now() / 1000) + SESSION_MAX_AGE,
		}),
	);

	const signature = base64url(
		crypto
			.createHmac("sha256", SESSION_SECRET)
			.update(`${header}.${payload}`)
			.digest(),
	);

	return `${header}.${payload}.${signature}`;
}

export function verifySessionToken(token: string): SessionUser | null {
	if (!SESSION_SECRET) return null;

	const parts = token.split(".");
	if (parts.length !== 3) return null;

	const [header, payload, signature] = parts;

	// Verify signature
	const expected = base64url(
		crypto
			.createHmac("sha256", SESSION_SECRET)
			.update(`${header}.${payload}`)
			.digest(),
	);

	if (
		!crypto.timingSafeEqual(
			Buffer.from(signature, "base64url"),
			Buffer.from(expected, "base64url"),
		)
	) {
		return null;
	}

	// Parse and validate payload
	try {
		const data = JSON.parse(base64urlDecode(payload));
		if (data.exp && data.exp < Math.floor(Date.now() / 1000)) {
			return null; // expired
		}
		return {
			userId: data.sub,
			email: data.email,
			name: data.name,
		};
	} catch {
		return null;
	}
}

export function setSessionCookie(res: Response, token: string): void {
	res.cookie(COOKIE_NAME, token, {
		httpOnly: true,
		secure: process.env.NODE_ENV === "production",
		sameSite: "lax",
		maxAge: SESSION_MAX_AGE * 1000,
		path: "/",
	});
}

export function clearSessionCookie(res: Response): void {
	res.clearCookie(COOKIE_NAME, { path: "/" });
}

// --- Middleware ---

export function requireAuth(req: Request, res: Response, next: NextFunction) {
	const token = req.cookies?.[COOKIE_NAME];
	if (!token) {
		return res.status(401).json({ error: "Authentication required" });
	}

	const user = verifySessionToken(token);
	if (!user) {
		return res.status(401).json({ error: "Invalid or expired session" });
	}

	req.user = user;
	next();
}

export function optionalAuth(req: Request, _res: Response, next: NextFunction) {
	const token = req.cookies?.[COOKIE_NAME];
	if (token) {
		const user = verifySessionToken(token);
		if (user) req.user = user;
	}
	next();
}
