/**
 * One-time Shopify login — saves auth cookies for screencast scripts.
 *
 * Opens a browser at Shopify admin. Log in manually, then press Enter
 * in the terminal. Cookies are saved to recordings/screencast/shopify-auth.json.
 *
 * Usage: tsx screencast-login.ts
 */

import fs from "node:fs";
import path from "node:path";
import { chromium } from "playwright";
import { AUTH_STATE_PATH, waitForEnter } from "./screencast-helpers";

const LOGIN_URL =
	"https://admin.shopify.com/store/demo-store-123456789552125479037";

async function main() {
	console.log("── Shopify Auth Setup ──\n");

	fs.mkdirSync(path.dirname(AUTH_STATE_PATH), { recursive: true });

	const browser = await chromium.launch({ headless: false });
	const context = await browser.newContext({
		viewport: { width: 1600, height: 900 },
		ignoreHTTPSErrors: true,
	});

	const page = await context.newPage();
	await page.goto(LOGIN_URL, {
		waitUntil: "domcontentloaded",
		timeout: 60_000,
	});

	await waitForEnter(
		"Log into Shopify, wait for admin dashboard to fully load",
	);

	// Save cookies + localStorage
	await context.storageState({ path: AUTH_STATE_PATH });
	console.log(`\nAuth state saved to ${AUTH_STATE_PATH}`);

	await context.close();
	await browser.close();
}

main().catch((err) => {
	console.error(err);
	process.exit(1);
});
