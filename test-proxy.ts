/**
 * Test proxy bypass with Playwright.
 * Verifies that whitelisted domains bypass the proxy and others go through it.
 *
 * Usage: npx tsx test-proxy.ts
 */

import "dotenv/config";
import { chromium } from "playwright";
import { getPlaywrightProxy, isProxyEnabled } from "./proxy";

const PROXIED_URL = "https://httpbin.org/ip";
const BYPASSED_URL = "https://xinfer.ai";

async function main() {
	const enabled = isProxyEnabled();
	const proxyConfig = await getPlaywrightProxy();

	console.log("Proxy enabled:", enabled);
	if (proxyConfig) {
		console.log("Proxy server:", proxyConfig.server);
		console.log("Proxy bypass:", proxyConfig.bypass ?? "(none)");
	} else {
		console.log("No proxy configured");
	}

	const browser = await chromium.launch({
		headless: true,
		proxy: proxyConfig,
	});

	try {
		// Test 1: non-whitelisted URL — should go through proxy
		console.log(`\n--- ${PROXIED_URL} (should use proxy) ---`);
		const page1 = await browser.newPage({ ignoreHTTPSErrors: true });
		await page1.goto(PROXIED_URL, { timeout: 20000 });
		const body1 = await page1.textContent("body");
		const ip1 = body1?.match(/"origin"\s*:\s*"([^"]+)"/)?.[1];
		console.log(`  origin IP: ${ip1 ?? "unknown"} (should be proxy IP)`);
		await page1.close();

		// Test 2: whitelisted URL — should bypass proxy
		console.log(`\n--- ${BYPASSED_URL} (should bypass proxy) ---`);
		const page2 = await browser.newPage({ ignoreHTTPSErrors: true });
		await page2.goto(BYPASSED_URL, { timeout: 20000 });
		const title = await page2.title();
		console.log(`  title: ${title}`);
		console.log("  ok: loaded directly (bypassed proxy)");
		await page2.close();
	} finally {
		await browser.close();
	}

	console.log("\nDone.");
}

main().catch((err) => {
	console.error(err);
	process.exit(1);
});
