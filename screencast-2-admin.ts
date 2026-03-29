/**
 * Screencast 2: Admin Dashboard Walkthrough
 *
 * Records a walkthrough of all admin pages using an already-installed store
 * with existing content and usage data across all 4 channels.
 *
 * Skips pages already covered in Screencast 1 (setup wizard, widget setup,
 * phone setup, billing).
 *
 * Usage: npx tsx screencast-2-admin.ts [--from=PAGE]
 *
 * --from=dashboard   Start at dashboard (default)
 * --from=followups   Start at follow-ups
 * --from=carts       Start at shopping carts
 * --from=orders      Start at draft orders
 * --from=faqs        Start at AI FAQs
 * --from=documents   Start at AI Documents
 * --from=crawl       Start at site crawl
 * --from=products    Start at sync products
 */

import type { FrameLocator, Page } from "playwright";
import {
	finishRecording,
	log,
	pause,
	type ScreencastContext,
	startRecording,
} from "./screencast-helpers";

const SHOP = "xinferdotai-demo";
const APP_HANDLE = "xinfer-ai-ai-sales-assistant";
const APP_URL = `https://admin.shopify.com/store/${SHOP}/apps/${APP_HANDLE}/shopify-admin`;

/** Pages to visit (in order), skipping setup pages covered in Screencast 1 */
const PAGES = [
	{
		id: "dashboard",
		path: "/shopify-admin",
		label: "Dashboard",
		navText: null,
	},
	{
		id: "followups",
		path: "/shopify-admin/follow-ups",
		label: "Follow Ups",
		navText: "Follow Ups",
	},
	{
		id: "carts",
		path: "/shopify-admin/shopping-carts",
		label: "Shopping Carts",
		navText: "Shopping Carts",
	},
	{
		id: "orders",
		path: "/shopify-admin/draft-orders",
		label: "Draft Orders",
		navText: "Draft Orders",
	},
	{
		id: "faqs",
		path: "/shopify-admin/ai-faqs",
		label: "AI FAQs",
		navText: "AI FAQs",
	},
	{
		id: "documents",
		path: "/shopify-admin/ai-documents",
		label: "AI Documents",
		navText: "AI Documents",
	},
	{
		id: "crawl",
		path: "/shopify-admin/site-crawl",
		label: "Site Crawl",
		navText: "Site Crawl",
	},
	{
		id: "products",
		path: "/shopify-admin/products",
		label: "Sync Products",
		navText: "Sync Products",
	},
] as const;

// ── Helpers ─────────────────────────────────────────────────────────

function appFrame(page: Page): FrameLocator {
	return page.frameLocator("iframe").first();
}

async function waitForPolaris(page: Page) {
	const frame = appFrame(page);
	try {
		await frame
			.locator("s-section")
			.first()
			.waitFor({ state: "visible", timeout: 15_000 });
	} catch {
		console.log("  Polaris not loaded — refreshing page...");
		await page.reload({ waitUntil: "domcontentloaded" });
		await frame
			.locator("s-section")
			.first()
			.waitFor({ state: "visible", timeout: 15_000 });
	}
	console.log("  Polaris loaded.");
}

/** Click a sidebar nav link in the Shopify admin shell (main page, not iframe).
 *  Polaris <a> elements need force: true because Playwright's visibility check
 *  doesn't work reliably with them. */
async function clickNavLink(
	ctx: ScreencastContext,
	navText: string,
	pagePath: string,
) {
	const { page } = ctx;

	// Find the nav link in the main Shopify admin frame by text content
	const mainFrame = page.mainFrame();
	const link = mainFrame.locator(`a:has-text("${navText}")`).first();

	try {
		await link.click({ force: true, timeout: 5_000 });
		await page.waitForTimeout(1500);
		return;
	} catch {
		console.log(`  sidebar click failed for "${navText}", using URL fallback`);
	}

	// Fallback — full page navigation
	const fullUrl = `https://admin.shopify.com/store/${SHOP}/apps/${APP_HANDLE}${pagePath}`;
	await page.goto(fullUrl, { waitUntil: "domcontentloaded", timeout: 30_000 });
	await page.waitForTimeout(2000);
	await waitForPolaris(page);
}

/** Wait for a page heading or unique element to confirm we're on the right page */
async function waitForPage(page: Page, label: string) {
	const frame = appFrame(page);
	try {
		await frame
			.locator("s-page, s-section")
			.first()
			.waitFor({ state: "visible", timeout: 10_000 });
	} catch {
		console.log(`  Warning: ${label} page elements slow to load`);
	}
}

// ── Main ────────────────────────────────────────────────────────────

async function main() {
	const fromArg =
		process.argv.find((a) => a.startsWith("--from="))?.split("=")[1] ??
		"dashboard";
	const startIdx = PAGES.findIndex((p) => p.id === fromArg);
	if (startIdx < 0) {
		console.error(
			`Unknown --from value: ${fromArg}. Options: ${PAGES.map((p) => p.id).join(", ")}`,
		);
		process.exit(1);
	}

	const startUrl =
		startIdx === 0
			? APP_URL
			: APP_URL.replace("/shopify-admin", PAGES[startIdx].path);

	console.log(`── Screencast 2: Admin Experience (from=${fromArg}) ──\n`);

	const ctx = await startRecording("2-admin", startUrl);
	const { page } = ctx;

	try {
		await waitForPolaris(page);

		// Phase: Dashboard
		if (startIdx <= 0) {
			log(ctx, "dashboard", "Admin dashboard with usage metrics");
			await pause(ctx, 4000); // Voiceover: intro — store with existing usage

			// Scroll down to see all dashboard content
			const frame = appFrame(page);
			await frame
				.locator("s-section")
				.last()
				.scrollIntoViewIfNeeded()
				.catch(() => {});
			await pause(ctx, 2000);

			// Scroll back to top
			await frame
				.locator("s-section")
				.first()
				.scrollIntoViewIfNeeded()
				.catch(() => {});
			await pause(ctx, 1000);
		}

		// Walk through each page via sidebar nav
		const pagesToVisit = PAGES.slice(Math.max(startIdx, 1));

		for (const pg of pagesToVisit) {
			log(ctx, "click", `${pg.label} nav link`);
			await clickNavLink(ctx, pg.navText!, pg.path);

			await waitForPage(page, pg.label);
			log(ctx, `view-${pg.id}`, `${pg.label} page loaded`);
			await pause(ctx, 3000); // Voiceover window

			// Scroll down if page has content below fold
			const frame = appFrame(page);
			await frame
				.locator("s-section")
				.last()
				.scrollIntoViewIfNeeded()
				.catch(() => {});
			await pause(ctx, 2000);

			// Scroll back up
			await frame
				.locator("s-section")
				.first()
				.scrollIntoViewIfNeeded()
				.catch(() => {});
			await pause(ctx, 1000);
		}

		// Return to dashboard
		log(ctx, "navigate", "Back to dashboard");
		await clickNavLink(ctx, "Xinfer", "/shopify-admin");
		await waitForPage(page, "Dashboard");
		log(ctx, "dashboard", "Back to dashboard");
		await pause(ctx, 3000);

		log(ctx, "end", "Admin walkthrough complete");
	} catch (err) {
		const msg = err instanceof Error ? err.message : String(err);
		console.error(`Screencast error: ${msg}`);
		log(ctx, "error", msg);
	}

	await finishRecording(ctx, "2-admin");
}

main().catch((err) => {
	console.error(err);
	process.exit(1);
});
