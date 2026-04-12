/**
 * CapSolver API client for solving Cloudflare challenges.
 *
 * Environment: CAPSOLVER_API_KEY
 * API docs: https://docs.capsolver.com/
 *
 * Two task types:
 * - AntiCloudflareTask: Full JS interstitial (needs proxy) → returns cf_clearance cookie
 * - AntiTurnstileTaskProxyLess: Turnstile checkbox widget → returns token
 */

import { resolve4 } from "node:dns/promises";

const CAPSOLVER_API = "https://api.capsolver.com";

export interface ProxyInfo {
	host: string;
	port: string;
	username: string;
	password: string;
}

interface CreateTaskResponse {
	errorId: number;
	errorCode?: string;
	errorDescription?: string;
	taskId?: string;
}

interface GetTaskResultResponse {
	errorId: number;
	errorCode?: string;
	errorDescription?: string;
	status: "idle" | "processing" | "ready" | "failed";
	solution?: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Sticky port — DataImpulse ports 10000-19999 give same exit IP for ~30 min
// ---------------------------------------------------------------------------

let _stickyPort: number | null = null;

export function getStickyPort(): number {
	if (_stickyPort === null) {
		_stickyPort = 10000 + Math.floor(Math.random() * 10000);
		console.log(`[CapSolver] Sticky port assigned: ${_stickyPort}`);
	}
	return _stickyPort;
}

// ---------------------------------------------------------------------------
// Proxy helper — parse from PROXY_URLS env var
// ---------------------------------------------------------------------------

export async function getCapSolverProxy(): Promise<ProxyInfo | null> {
	const raw = process.env.PROXY_URLS?.trim();
	if (!raw) return null;
	try {
		const parsed = new URL(raw.split(",")[0].trim());
		// CapSolver rejects dynamic DNS hostnames — resolve to IP
		let host = parsed.hostname;
		if (!/^\d+\.\d+\.\d+\.\d+$/.test(host)) {
			const ips = await resolve4(host);
			console.log(`[CapSolver] DNS resolved ${parsed.hostname} → ${ips[0]}`);
			host = ips[0];
		}
		const port = String(getStickyPort());
		console.log(`[CapSolver] Proxy for solver: ${host}:${port}`);
		return {
			host,
			port,
			username: decodeURIComponent(parsed.username),
			password: decodeURIComponent(parsed.password),
		};
	} catch (err) {
		console.error(
			`[CapSolver] Failed to parse proxy: ${err instanceof Error ? err.message : err}`,
		);
		return null;
	}
}

// ---------------------------------------------------------------------------
// Internal: createTask + poll getTaskResult
// ---------------------------------------------------------------------------

async function createTask(
	task: Record<string, unknown>,
): Promise<string | { error: string }> {
	const apiKey = process.env.CAPSOLVER_API_KEY;
	if (!apiKey) return { error: "CAPSOLVER_API_KEY not set" };

	const res = await fetch(`${CAPSOLVER_API}/createTask`, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ clientKey: apiKey, task }),
	});

	let data: CreateTaskResponse;
	try {
		data = (await res.json()) as CreateTaskResponse;
	} catch {
		return {
			error: `createTask: non-JSON response (HTTP ${res.status})`,
		};
	}
	if (data.errorId !== 0 || !data.taskId) {
		return {
			error: `createTask failed: ${data.errorCode} — ${data.errorDescription}`,
		};
	}

	console.log(`[CapSolver] Task created: ${data.taskId}`);
	return data.taskId;
}

async function pollResult(
	taskId: string,
	timeoutMs = 90_000,
	intervalMs = 3_000,
): Promise<Record<string, unknown> | { error: string }> {
	const apiKey = process.env.CAPSOLVER_API_KEY;
	if (!apiKey) return { error: "CAPSOLVER_API_KEY not set" };

	const deadline = Date.now() + timeoutMs;
	let pollCount = 0;

	while (Date.now() < deadline) {
		await new Promise((r) => setTimeout(r, intervalMs));
		pollCount++;

		const res = await fetch(`${CAPSOLVER_API}/getTaskResult`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ clientKey: apiKey, taskId }),
		});

		let data: GetTaskResultResponse;
		try {
			data = (await res.json()) as GetTaskResultResponse;
		} catch {
			console.warn(
				`[CapSolver] Poll #${pollCount}: non-JSON response (HTTP ${res.status})`,
			);
			continue;
		}

		console.log(`[CapSolver] Poll #${pollCount}: status=${data.status}`);

		if (data.errorId !== 0) {
			return {
				error: `getTaskResult failed: ${data.errorCode} — ${data.errorDescription}`,
			};
		}

		if (data.status === "ready" && data.solution) {
			return data.solution;
		}

		if (data.status === "failed") {
			return {
				error: `Task failed: ${data.errorCode} — ${data.errorDescription}`,
			};
		}
	}

	return { error: `CapSolver timeout after ${timeoutMs / 1000}s` };
}

// ---------------------------------------------------------------------------
// Public: solve full JS interstitial (AntiCloudflareTask)
// ---------------------------------------------------------------------------

export async function solveCloudflareChallenge(params: {
	websiteURL: string;
	proxy: ProxyInfo;
	html?: string;
	userAgent?: string;
}): Promise<
	{ cookies: Record<string, string>; userAgent: string } | { error: string }
> {
	const start = Date.now();
	console.log(`[CapSolver] AntiCloudflareTask for ${params.websiteURL}`);
	console.log(
		`[CapSolver] Proxy: ${params.proxy.host}:${params.proxy.port}, ` +
			`html: ${params.html ? `${params.html.length} chars` : "none"}, ` +
			`userAgent: ${params.userAgent ? "yes" : "none"}`,
	);

	const task: Record<string, unknown> = {
		type: "AntiCloudflareTask",
		websiteURL: params.websiteURL,
		proxy: `http:${params.proxy.host}:${params.proxy.port}:${params.proxy.username}:${params.proxy.password}`,
	};
	if (params.html) {
		task.html = params.html;
	}
	if (params.userAgent) {
		task.userAgent = params.userAgent;
	}

	const taskId = await createTask(task);
	if (typeof taskId !== "string") return taskId;

	const result = await pollResult(taskId);
	if ("error" in result) return result as { error: string };

	const elapsed = ((Date.now() - start) / 1000).toFixed(1);
	console.log(
		`[CapSolver] Raw solution keys: ${Object.keys(result).join(", ")}`,
	);

	// CapSolver returns cookies as array of { name, value } or as object
	const cookies: Record<string, string> = {};
	if (Array.isArray(result.cookies)) {
		for (const c of result.cookies as { name: string; value: string }[]) {
			cookies[c.name] = c.value;
		}
	} else if (result.cookies && typeof result.cookies === "object") {
		Object.assign(cookies, result.cookies);
	}
	// Some responses put cf_clearance directly in solution
	if (result.cf_clearance && typeof result.cf_clearance === "string") {
		cookies.cf_clearance = result.cf_clearance;
	}
	// Also check token field — some API versions return it differently
	if (
		result.token &&
		typeof result.token === "string" &&
		!cookies.cf_clearance
	) {
		cookies.cf_clearance = result.token;
	}

	if (Object.keys(cookies).length === 0) {
		console.warn("[CapSolver] WARNING: No cookies extracted from solution");
	}

	const ua = (result.userAgent as string) || params.userAgent || "";

	console.log(
		`[CapSolver] cf_clearance received in ${elapsed}s (cookies: ${Object.keys(cookies).join(", ")})`,
	);

	return { cookies, userAgent: ua };
}

// ---------------------------------------------------------------------------
// Public: solve Turnstile widget (AntiTurnstileTaskProxyLess)
// ---------------------------------------------------------------------------

export async function solveTurnstileToken(params: {
	websiteURL: string;
	websiteKey: string;
}): Promise<{ token: string } | { error: string }> {
	const start = Date.now();
	console.log(
		`[CapSolver] AntiTurnstileTaskProxyLess for ${params.websiteURL} (key: ${params.websiteKey})`,
	);

	const taskId = await createTask({
		type: "AntiTurnstileTaskProxyLess",
		websiteURL: params.websiteURL,
		websiteKey: params.websiteKey,
	});
	if (typeof taskId !== "string") return taskId;

	const result = await pollResult(taskId);
	if ("error" in result) return result as { error: string };

	const token = result.token as string;
	if (!token) return { error: "No token in CapSolver response" };

	const elapsed = ((Date.now() - start) / 1000).toFixed(1);
	console.log(`[CapSolver] Turnstile token received in ${elapsed}s`);

	return { token };
}
