/**
 * Proxy configuration for Playwright browser launches.
 *
 * Reads PROXY_URLS and PROXY_ENABLED from environment.
 * Returns Playwright-compatible proxy options for chromium.launch().
 */

interface PlaywrightProxy {
	server: string;
	username: string;
	password: string;
}

let cached: PlaywrightProxy | null | undefined;

function parseProxy(): PlaywrightProxy | null {
	const raw = process.env.PROXY_URLS?.trim();
	if (!raw) return null;

	const uri = raw.split(",")[0].trim();
	if (!uri) return null;

	const parsed = new URL(uri);
	return {
		server: `${parsed.protocol}//${parsed.hostname}:${parsed.port}`,
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
 * Returns Playwright proxy option for chromium.launch(), or undefined if proxy is disabled.
 */
export function getPlaywrightProxy(): PlaywrightProxy | undefined {
	if (cached !== undefined) return cached ?? undefined;
	cached = isProxyEnabled() ? parseProxy() : null;
	return cached ?? undefined;
}
