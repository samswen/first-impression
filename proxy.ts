/**
 * Proxy configuration for Playwright browser launches.
 *
 * Reads PROXY_URLS and PROXY_ENABLED from environment.
 * Returns Playwright-compatible proxy options for chromium.launch().
 *
 * Fetches proxy bypass domains from rag-chatbot on first use.
 */

import { getStickyPort } from "./capsolver";

interface PlaywrightProxy {
	server: string;
	username: string;
	password: string;
	bypass?: string;
}

let cached: PlaywrightProxy | null | undefined;
let bypassDomains: string[] | null = null;

function parseProxy(): PlaywrightProxy | null {
	const raw = process.env.PROXY_URLS?.trim();
	if (!raw) return null;

	const uri = raw.split(",")[0].trim();
	if (!uri) return null;

	const parsed = new URL(uri);
	// When CapSolver is configured, use sticky port so browser and solver share exit IP
	const port = process.env.CAPSOLVER_API_KEY ? getStickyPort() : parsed.port;
	return {
		server: `${parsed.protocol}//${parsed.hostname}:${port}`,
		username: decodeURIComponent(parsed.username),
		password: decodeURIComponent(parsed.password),
	};
}

export function isProxyEnabled(): boolean {
	if (process.env.PROXY_ENABLED === "true") return parseProxy() !== null;
	if (process.env.PROXY_ENABLED === "false") return false;
	return false;
}

/**
 * Fetch the bypass domain list from rag-chatbot (once, cached).
 */
async function fetchBypassDomains(): Promise<string[]> {
	if (bypassDomains !== null) return bypassDomains;

	const baseUrl = process.env.RAG_CHATBOT_BASE_URL;
	const apiKey = process.env.FIRST_IMPRESSION_API_KEY;
	if (!baseUrl || !apiKey) {
		bypassDomains = [];
		return bypassDomains;
	}

	try {
		const fetchOptions: RequestInit & { dispatcher?: unknown } = {
			headers: { Authorization: `Bearer ${apiKey}` },
			signal: AbortSignal.timeout(5000),
		};
		// Allow self-signed certs for local dev (https://localhost)
		if (baseUrl.includes("localhost")) {
			process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";
		}
		const res = await fetch(
			`${baseUrl}/api/first-impression/proxy-bypass`,
			fetchOptions,
		);
		if (res.ok) {
			const data = await res.json();
			bypassDomains = (data.domains as string[]) ?? [];
			console.log(`[Proxy] Loaded bypass domains: ${bypassDomains.join(", ")}`);
		} else {
			console.warn(`[Proxy] Failed to fetch bypass domains: ${res.status}`);
			bypassDomains = [];
		}
	} catch (err) {
		console.warn(
			`[Proxy] Could not fetch bypass domains: ${err instanceof Error ? err.message : err}`,
		);
		bypassDomains = [];
	}

	return bypassDomains!;
}

/**
 * Returns Playwright proxy option for chromium.launch(), or undefined if proxy is disabled.
 * Call this with `await` — fetches bypass list on first invocation.
 */
export async function getPlaywrightProxy(): Promise<
	PlaywrightProxy | undefined
> {
	if (cached !== undefined) return cached ?? undefined;

	if (!isProxyEnabled()) {
		cached = null;
		return undefined;
	}

	const proxy = parseProxy();
	if (!proxy) {
		cached = null;
		return undefined;
	}

	// CDN domains never need proxy (no IP blocking, and proxies often
	// can't handle video streaming / large binary downloads)
	const cdnBypass = [
		"*.cdn-website.com", // Duda video/image CDN
		"*.cloudfront.net", // AWS CloudFront
		"*.googleapis.com", // Google APIs
		"*.gstatic.com", // Google static
		"*.cdn.shopify.com", // Shopify CDN
	];
	const domains = await fetchBypassDomains();
	const allBypass = [...cdnBypass, ...domains.map((d) => `*.${d}`)];
	proxy.bypass = allBypass.join(",");

	cached = proxy;
	return cached;
}
