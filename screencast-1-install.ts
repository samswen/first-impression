/**
 * Screencast 1: Shopify App Installation Experience (Automated)
 *
 * Records: Install → Plan selection → Setup wizard → Widget activation → Done
 *
 * Every click is automated. Pauses between actions provide windows for
 * voiceover narration. Timeline events are saved for composition.
 *
 * Usage: npx tsx screencast-1-install.ts
 */

import type { FrameLocator, Page } from "playwright";
import {
	finishRecording,
	log,
	pause,
	startRecording,
	type ScreencastContext,
} from "./screencast-helpers";

const INSTALL_URL =
	"https://admin.shopify.com/store/demo-store-123456789552125479037/app/grant?access_change_uuid=602e847d-7b7f-4f82-a9c9-6bbcacbca7c9&client_id=ec89997299b3f7b4f4e67d2838b3646a";

/** Direct app URL — used when skipping install (app already installed) */
const APP_URL =
	"https://admin.shopify.com/store/demo-store-123456789552125479037/apps/xinfer-ai-ai-sales-assistant/shopify-admin";

/**
 * --from=install     Full flow (default)
 * --from=onboarding  Skip install, start at plan selection
 * --from=dashboard   Skip install + onboarding, start at dashboard
 * --from=wizard      Skip to setup wizard directly
 */
const fromArg = process.argv.find((a) => a.startsWith("--from="));
const startFrom = fromArg ? fromArg.split("=")[1] : "install";

/**
 * Get the app iframe locator.
 * Shopify embeds the app in an iframe — the id varies across versions.
 * Try common patterns, fall back to the first iframe on the page.
 */
function appFrame(page: Page): FrameLocator {
	return page.frameLocator("iframe").first();
}

/** Show cursor at element position, pause, show click ripple, then click and hide. */
async function cursorClick(
	page: Page,
	locator: { boundingBox: () => Promise<{ x: number; y: number; width: number; height: number } | null>; click: () => Promise<void> },
	hint?: string,
) {
	await showCursorAt(page, locator, hint);
	await locator.click();
	await hideCursor(page);
}

/**
 * Compute center coordinates for a locator's element.
 * Falls back to page.evaluate() with TreeWalker when boundingBox() returns null
 * (common for Polaris web components inside iframes).
 */
async function getElementCenter(
	page: Page,
	locator: { boundingBox: () => Promise<{ x: number; y: number; width: number; height: number } | null> },
	hint?: string,
): Promise<{ x: number; y: number } | null> {
	const box = await locator.boundingBox().catch(() => null);
	if (box) return { x: Math.round(box.x + box.width / 2), y: Math.round(box.y + box.height / 2) };

	// boundingBox() returns null for elements inside cross-origin iframes.
	// Use Playwright's frame API to evaluate inside the frame, then combine with iframe position.
	const iframeRect = await page.evaluate(() => {
		const iframe = document.querySelector("iframe") as HTMLIFrameElement | null;
		if (!iframe) return null;
		const r = iframe.getBoundingClientRect();
		return { x: r.x, y: r.y };
	});
	if (iframeRect && hint) {
		const frame = page.frames().find((f) => f !== page.mainFrame() && f.url() !== "about:blank");
		if (frame) {
			const elRect = await frame.evaluate((textHint) => {
				// Strategy 1: Find the visible <button> inside a shadow root whose host has matching text.
				// Polaris <s-button> has shadowRoot with a <button>, and textContent on the host has the slot text.
				for (const el of document.querySelectorAll("s-button")) {
					if (el.textContent?.trim() === textHint) {
						const btn = el.shadowRoot?.querySelector("button") ?? el;
						const r = btn.getBoundingClientRect();
						if (r.width > 0 && r.height > 0) {
							return { x: r.x, y: r.y, width: r.width, height: r.height };
						}
					}
				}
				// Strategy 2: TreeWalker fallback — find text node, walk up to smallest visible ancestor.
				const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
				let node: Node | null;
				let best: { x: number; y: number; width: number; height: number } | null = null;
				let bestArea = Number.POSITIVE_INFINITY;
				while ((node = walker.nextNode())) {
					const text = node.textContent?.trim();
					if (text === textHint || text?.includes(textHint)) {
						let el: HTMLElement | null = node.parentElement;
						while (el) {
							const r = el.getBoundingClientRect();
							if (r.width > 0 && r.height > 0) {
								const area = r.width * r.height;
								if (area < bestArea) {
									best = { x: r.x, y: r.y, width: r.width, height: r.height };
									bestArea = area;
								}
								break;
							}
							el = el.parentElement;
						}
					}
				}
				return best;
			}, hint).catch(() => null);
			if (elRect) {
				return {
					x: Math.round(iframeRect.x + elRect.x + elRect.width / 2),
					y: Math.round(iframeRect.y + elRect.y + elRect.height / 2),
				};
			}
		}
	}

	console.log("  [cursor] could not resolve position — skipping cursor");
	return null;
}

/** Show cursor dot at the center of an element (no click). */
async function showCursorAt(
	page: Page,
	locator: { boundingBox: () => Promise<{ x: number; y: number; width: number; height: number } | null> },
	hint?: string,
) {
	const center = await getElementCenter(page, locator, hint);
	if (!center) return;
	const { x: cx, y: cy } = center;

	// Show cursor instantly on the element
	await page.evaluate(
		({ x, y }) => {
			const dot = document.getElementById("__screencast-cursor");
			if (dot) {
				dot.style.transition = "none";
				dot.style.left = `${x}px`;
				dot.style.top = `${y}px`;
				dot.style.opacity = "1";
			}
		},
		{ x: cx, y: cy },
	);
	await page.waitForTimeout(1800);

	// Click ripple
	await page.evaluate(
		({ x, y }) => {
			const ripple = document.createElement("div");
			Object.assign(ripple.style, {
				position: "fixed", zIndex: "2147483646", pointerEvents: "none",
				width: "40px", height: "40px", borderRadius: "50%",
				border: "3px solid rgba(230, 81, 0, 0.8)",
				left: `${x}px`, top: `${y}px`,
				transform: "translate(-50%, -50%) scale(0.5)", opacity: "1",
				transition: "transform 0.3s ease-out, opacity 0.3s ease-out",
			});
			document.body.appendChild(ripple);
			requestAnimationFrame(() => {
				ripple.style.transform = "translate(-50%, -50%) scale(2)";
				ripple.style.opacity = "0";
			});
			setTimeout(() => ripple.remove(), 400);
		},
		{ x: cx, y: cy },
	);
}

/** Hide the cursor dot. */
async function hideCursor(page: Page) {
	await page.evaluate(() => {
		const dot = document.getElementById("__screencast-cursor");
		if (dot) dot.style.opacity = "0";
	});
	await page.waitForTimeout(200);
}

// ── Phase 1: Grant page — click Install ─────────────────────────────

async function phase1Install(ctx: ScreencastContext) {
	const { page } = ctx;

	log(ctx, "start", "Install screen visible");
	await pause(ctx, 5000); // Voiceover: explain what the install screen is

	// Click the Install button on the Shopify grant page
	const installBtn = page.getByRole("button", { name: /install/i });
	await installBtn.waitFor({ state: "visible", timeout: 30_000 });
	log(ctx, "click", "Install button");
	await cursorClick(page, installBtn);

	// Wait for the page to navigate and the app iframe to appear
	await page
		.locator("iframe")
		.first()
		.waitFor({ state: "visible", timeout: 60_000 });
	await pause(ctx, 3000); // Let iframe load
	log(ctx, "installed", "App iframe loaded");
}

// ── Phase 2: Onboarding — plan carousel ─────────────────────────────

async function phase2Onboarding(ctx: ScreencastContext) {
	const { page } = ctx;
	const frame = appFrame(page);

	// Wait for Polaris to load (elements hidden via :not(:defined) until then)
	await waitForPolaris(page);

	// Wait for onboarding to render (look for "Start Free" button)
	const startFreeBtn = frame.locator("button").filter({ hasText: "Start Free" });
	await startFreeBtn.waitFor({ state: "visible", timeout: 60_000 });
	log(ctx, "onboarding", "Plan selection visible");
	await pause(ctx, 4000); // Voiceover: explain plan options

	// Click carousel right arrow (›) to show next plan
	const rightArrow = frame.locator("button").filter({ hasText: "›" });
	await cursorClick(page, rightArrow, "›");
	log(ctx, "carousel", "Next plan");
	await pause(ctx, 2000);

	// Click carousel left arrow (‹) to go back
	const leftArrow = frame.locator("button").filter({ hasText: "‹" });
	await cursorClick(page, leftArrow, "‹");
	log(ctx, "carousel", "Previous plan");
	await pause(ctx, 2000);

	// Click "Start Free"
	log(ctx, "click", "Start Free");
	await cursorClick(page, startFreeBtn, "Start Free");

	// After clicking Start Free, the page reloads and shows the dashboard.
	await waitForDashboard(page);
	await pause(ctx, 2000);
	log(ctx, "dashboard", "Dashboard loaded after plan selection");
}

// ── Phase 3: Dashboard — setup bar overview ─────────────────────────

async function phase3Dashboard(ctx: ScreencastContext) {
	const { page } = ctx;
	const frame = appFrame(page);

	// Wait for dashboard links to be in DOM
	await waitForDashboard(page);

	log(ctx, "setup-bar", "Setup bar visible with 4 steps");
	await pause(ctx, 5000); // Voiceover: explain the 4 setup steps

	// Click the AI Agent step link
	log(ctx, "click", "AI Agent setup step");
	await clickDashboardLink(page, "/setup-wizard");

	// Wait for the setup wizard to load — could be on any step (draft restored)
	await Promise.race([
		frame.locator("#pi-website-url").waitFor({ state: "visible", timeout: 30_000 }),
		frame.locator("#pi-business-name").waitFor({ state: "visible", timeout: 30_000 }),
		frame.locator("#pi-assistant-name").waitFor({ state: "visible", timeout: 30_000 }),
		frame.getByText("Suggested Actions").first().waitFor({ state: "visible", timeout: 30_000 }),
		frame.getByText("Review Your Setup").first().waitFor({ state: "visible", timeout: 30_000 }),
	]);
	await page.waitForTimeout(2000);
	log(ctx, "wizard", "Setup wizard loaded");
}

// ── Phase 4: Setup wizard ───────────────────────────────────────────

/** Demo website URL — real site that the AI crawler can extract from */
const DEMO_WEBSITE_URL = "https://demo-store.xinfer.ai";

/** Extraction timeout — crawl + AI extraction takes 2-5 minutes */
const EXTRACTION_TIMEOUT = 360_000; // 6 minutes

async function phase4Wizard(ctx: ScreencastContext) {
	const { page } = ctx;
	const frame = appFrame(page);

	// If starting from --from=wizard, navigate to wizard from dashboard.
	// Check for ANY wizard step content — the wizard may have restored a draft
	// on a later step from a previous run.
	const wizardChecks = await Promise.all([
		frame.locator("#pi-website-url").isVisible().catch(() => false),
		frame.locator("#pi-business-name").isVisible().catch(() => false),
		frame.locator("#pi-assistant-name").isVisible().catch(() => false),
		frame.locator("#pta-tagline-specialty").isVisible().catch(() => false),
		frame.getByText("Suggested Actions").first().isVisible().catch(() => false),
		frame.getByText("Review Your Setup").first().isVisible().catch(() => false),
		frame.locator("s-button[variant='primary']").filter({ hasText: "Next" }).isVisible().catch(() => false),
		frame.locator("s-button[variant='primary']").filter({ hasText: "Generate" }).isVisible().catch(() => false),
	]);
	const alreadyOnWizard = wizardChecks.some(Boolean);
	if (!alreadyOnWizard) {
		log(ctx, "navigate", "Navigating to setup wizard");
		await clickDashboardLink(page, "/setup-wizard");
		await page.waitForTimeout(3000);
	}

	// Wait for draft to load
	await page.waitForTimeout(3000);

	// ── Step 0: Website URL (if visible) ──
	const websiteInput = frame.locator("#pi-website-url");
	if (await websiteInput.isVisible().catch(() => false)) {
		log(ctx, "wizard-step", "Step 0: Website URL");
		await pause(ctx, 3000); // Voiceover: explain entering the URL

		// Always type the demo URL for a clean recording
		await websiteInput.fill("");
		await websiteInput.type(DEMO_WEBSITE_URL, { delay: 40 });
		log(ctx, "type", `Entered ${DEMO_WEBSITE_URL}`);
		await pause(ctx, 2000);

		// Click Next — triggers crawl + AI extraction (takes 2-5 minutes)
		log(ctx, "click", "Next (starting crawl)");
		await clickNext(page, frame);

		// Wait for step 1 (Business) — the AI crawls and extracts data
		await frame
			.locator("#pi-business-name")
			.waitFor({ state: "visible", timeout: EXTRACTION_TIMEOUT });
		log(ctx, "extraction", "Business info extracted from website");
	}

	// ── Steps 1–4: Click through AI-extracted data ──
	const steps = [
		{ name: "Business", id: "#pi-business-name" },
		{ name: "Contact", id: "#pi-phone" },
		{ name: "Details", id: "#pta-tagline-specialty" },
		{ name: "Personality", id: "#pi-assistant-name" },
	];

	for (let i = 0; i < steps.length; i++) {
		const step = steps[i];
		const field = frame.locator(step.id);
		if (await field.isVisible().catch(() => false)) {
			log(ctx, "wizard-step", `Step ${i + 1}: ${step.name} (auto-filled by AI)`);
			await pause(ctx, 3000); // Voiceover window
			await clickNext(page, frame);
			log(ctx, "click", "Next");

			// Wait for next step to appear (extraction per step)
			if (i < steps.length - 1) {
				await frame
					.locator(steps[i + 1].id)
					.waitFor({ state: "visible", timeout: EXTRACTION_TIMEOUT });
			}
		}
	}

	// ── Step 5: Suggested Actions (skip if already on Review) ──
	const reviewAlreadyVisible = await frame
		.getByText("Review Your Setup")
		.first()
		.isVisible()
		.catch(() => false);

	if (!reviewAlreadyVisible) {
		// Wait for step 5 to load — look for the Next button (Review step has Generate instead)
		const nextBtn = frame
			.locator("s-button[variant='primary']")
			.filter({ hasText: "Next" });
		await nextBtn.waitFor({ state: "visible", timeout: EXTRACTION_TIMEOUT });
		log(ctx, "wizard-step", "Step 5: Suggested Actions");
		await pause(ctx, 3000); // Voiceover: explain quick-action buttons
		await clickNext(page, frame);
		log(ctx, "click", "Next");
	}

	// ── Step 6: Review ──
	const reviewHeading = frame.getByText("Review Your Setup").first();
	await reviewHeading.waitFor({ state: "visible", timeout: 30_000 });
	log(ctx, "wizard-step", "Step 6: Review");
	await pause(ctx, 4000); // Voiceover: explain the review summary

	// Click "Generate & Save"
	const saveBtn = frame
		.locator("s-button[variant='primary']")
		.filter({ hasText: "Generate" });
	log(ctx, "click", "Generate & Save");
	await cursorClick(page, saveBtn, "Generate & Save");

	// Wait for save to complete — success banner appears
	const successBanner = frame.locator('s-banner[tone="success"]');
	await successBanner.waitFor({ state: "visible", timeout: 120_000 });
	log(ctx, "saved", "AI Agent configuration saved");
	await pause(ctx, 3000); // Voiceover: setup complete, products synced

	// Navigate back to dashboard using browser back
	log(ctx, "navigate", "Back to dashboard");
	await page.goBack({ waitUntil: "domcontentloaded" });

	// Wait for dashboard setup bar to load
	await waitForDashboard(page);
	await pause(ctx, 2000);
	log(ctx, "dashboard", "Back to dashboard after wizard");
}

/**
 * Wait for Polaris web components to be defined in the app iframe.
 * The root layout has `:not(:defined){visibility:hidden}` which hides
 * all content until the Polaris CDN script loads and defines custom elements.
 */
async function waitForPolaris(page: Page) {
	const frame = appFrame(page);
	console.log("  Waiting for Polaris to load...");
	try {
		await frame.locator("s-section").first().waitFor({ state: "visible", timeout: 30_000 });
	} catch {
		// Polaris CDN may have failed — reload and retry
		console.log("  Polaris not loaded — refreshing page...");
		await page.reload({ waitUntil: "domcontentloaded", timeout: 30_000 });
		await frame.locator("s-section").first().waitFor({ state: "visible", timeout: 30_000 });
	}
	console.log("  Polaris loaded.");
}

/** Wait for the dashboard to be ready */
async function waitForDashboard(page: Page, timeout = 30_000) {
	const frame = appFrame(page);
	// The dashboard renders two layouts (compact + prominent) — one is display:none.
	// Which one is visible depends on widgetActive state. Race both, plus a broader fallback.
	await Promise.race([
		frame.locator('a[href*="/setup-wizard"]').first().waitFor({ state: "visible", timeout }),
		frame.locator('a[href*="/setup-wizard"]').last().waitFor({ state: "visible", timeout }),
		frame.locator('a[href*="/widget-setup"]').first().waitFor({ state: "visible", timeout }),
		frame.locator('a[href*="/widget-setup"]').last().waitFor({ state: "visible", timeout }),
	]);
}

/** Click a visible dashboard link (handles dual layout) */
async function clickDashboardLink(page: Page, hrefPattern: string) {
	const frame = appFrame(page);
	// Map href patterns to visible link text for cursor hint
	const hintMap: Record<string, string> = {
		"/setup-wizard": "AI Agent",
		"/widget-setup": "Chat Widget",
	};
	const hint = hintMap[hrefPattern];
	const first = frame.locator(`a[href*="${hrefPattern}"]`).first();
	if (await first.isVisible().catch(() => false)) {
		await cursorClick(page, first, hint);
	} else {
		await cursorClick(page, frame.locator(`a[href*="${hrefPattern}"]`).last(), hint);
	}
}

/** Click the Next button in the wizard */
async function clickNext(page: Page, frame: FrameLocator) {
	const nextBtn = frame.locator("s-button[variant='primary']").filter({ hasText: "Next" });
	await nextBtn.waitFor({ state: "visible", timeout: 10_000 });
	await cursorClick(page, nextBtn, "Next");
}

// ── Phase 5: Widget activation ──────────────────────────────────────

async function phase5Widget(ctx: ScreencastContext) {
	const { page } = ctx;
	const frame = appFrame(page);

	// Wait for dashboard to have setup links
	await waitForDashboard(page);

	log(ctx, "setup-bar", "AI Agent step now shows as done");
	await pause(ctx, 3000); // Voiceover: note AI Agent is complete

	// Click "Chat Widget" step
	log(ctx, "click", "Chat Widget setup step");
	await clickDashboardLink(page, "/widget-setup");

	// Wait for widget setup page to load — look for any text/element unique to the page
	await frame.getByText("Open Theme Editor").first().waitFor({ state: "visible", timeout: 15_000 });
	log(ctx, "widget-setup", "Widget setup page loaded");
	await pause(ctx, 3000); // Voiceover: explain widget activation steps

	// Navigate to theme editor in the same tab (new tabs render blank in Playwright)
	// Use a short timeout for URL extraction — fall back to known URL pattern
	const themeEditorUrl = await frame
		.locator("a[href*='/themes/']")
		.first()
		.getAttribute("href", { timeout: 3_000 })
		.catch(() => null);
	const editorUrl = themeEditorUrl
		? themeEditorUrl.startsWith("http")
			? themeEditorUrl
			: `https://admin.shopify.com${themeEditorUrl}`
		: `https://admin.shopify.com/store/demo-store-123456789552125479037/themes/current/editor?context=apps`;

	// Show cursor on button before navigating (we use goto instead of click
	// because clicking opens a new tab which renders blank in Playwright).
	const openBtn = frame.getByText("Open Theme Editor").first();
	await showCursorAt(page, openBtn, "Open Theme Editor");
	await hideCursor(page);
	log(ctx, "click", "Open Theme Editor");
	await page.goto(editorUrl, { waitUntil: "domcontentloaded", timeout: 60_000 });

	// Don't wait for networkidle — the theme editor SPA constantly fetches resources.
	log(ctx, "theme-editor", "Theme editor opened");

	// The theme editor sidebar lives inside a nested frame (online-store-web.shopifyapps.com).
	// Wait for the SPA to create its nested iframes, then find the editor sidebar.
	let toggled = false;
	try {
		// Wait for nested frames to appear (the main SPA creates several iframes).
		// If the page renders blank (only 1 frame after 15s), refresh and retry.
		let waitStart = Date.now();
		while (Date.now() - waitStart < 15_000 && page.frames().length < 3) {
			await page.waitForTimeout(1000);
		}
		if (page.frames().length < 3) {
			console.log("  Theme editor blank — refreshing...");
			await page.reload({ waitUntil: "domcontentloaded", timeout: 30_000 });
			waitStart = Date.now();
			while (Date.now() - waitStart < 30_000 && page.frames().length < 3) {
				await page.waitForTimeout(1000);
			}
		}
		console.log(`  Theme editor has ${page.frames().length} frames`);

		// Find the editor sidebar frame
		let editorFrame = page
			.frames()
			.find((f) => f.url().includes("online-store-web.shopifyapps.com/themes/")) || null;

		// If not matched by URL yet, wait a bit more for frames to navigate
		if (!editorFrame) {
			const urlDeadline = Date.now() + 15_000;
			while (Date.now() < urlDeadline) {
				editorFrame = page
					.frames()
					.find((f) => f.url().includes("online-store-web.shopifyapps.com/themes/")) || null;
				if (editorFrame) break;
				await page.waitForTimeout(1000);
			}
		}

		if (editorFrame) {
			console.log(`  Found editor frame: ${editorFrame.url().slice(0, 100)}`);

			// Wait for "Xinfer.AI Chat" to appear in the sidebar
			const xinferText = editorFrame.getByText("Xinfer.AI Chat").first();
			await xinferText.waitFor({ state: "visible", timeout: 20_000 });
			console.log("  Found 'Xinfer.AI Chat' in editor frame");

			// The Shopify theme editor toggle is a <button> with:
			//   aria-label="Enable Xinfer.AI Chat" (OFF) or "Disable Xinfer.AI Chat" (ON)
			//   aria-pressed="false" (OFF) or "true" (ON)
			//   class contains "Online-Store-UI-Switch"
			const toggle = editorFrame
				.locator('button[aria-label*="Xinfer.AI Chat"]')
				.first();
			await toggle.waitFor({ state: "visible", timeout: 10_000 });

			const isOn = (await toggle.getAttribute("aria-pressed")) === "true";
			if (!isOn) {
				await toggle.click();
				log(ctx, "toggle", "Toggled Xinfer.AI Chat ON");
				toggled = true;
				await pause(ctx, 2000);

				// Click Save — only after toggling (button is disabled when no changes)
				const saveBtn = editorFrame.getByRole("button", { name: /save/i }).first();
				if (await saveBtn.isVisible({ timeout: 5_000 }).catch(() => false)) {
					await saveBtn.click();
					log(ctx, "click", "Saved theme changes");
					await pause(ctx, 3000);
				}
			} else {
				log(ctx, "skip", "App block already enabled");
				toggled = true;
				await pause(ctx, 2000);
			}
		} else {
			console.log("  Could not find editor sidebar frame");
			console.log(
				`  Available frames: ${page.frames().map((f) => f.url().slice(0, 100)).join("\n    ")}`,
			);
			await pause(ctx, 3000);
		}
	} catch (err) {
		console.log(
			"  Note: Could not auto-toggle app block:",
			err instanceof Error ? err.message : err,
		);
		await pause(ctx, 3000);
	}

	// Navigate back to widget setup page (use direct URL since goBack may not work
	// after same-tab goto to the theme editor)
	log(ctx, "close-tab", "Theme editor closed");
	// Go directly to widget setup (not dashboard) since we need to check the confirm checkbox
	const widgetSetupUrl = APP_URL.replace(/\/shopify-admin$/, "/shopify-admin/widget-setup");
	await page.goto(widgetSetupUrl, { waitUntil: "domcontentloaded", timeout: 60_000 });
	await page.waitForTimeout(3000);
	await waitForPolaris(page);

	// Check the "I have added the chat widget" checkbox (skip if already checked)
	const widgetCheckbox = frame
		.locator("label")
		.filter({ hasText: "I have added the chat widget" })
		.locator('input[type="checkbox"]');
	await widgetCheckbox.waitFor({ state: "visible", timeout: 10_000 });
	const alreadyChecked = await widgetCheckbox.isChecked();
	if (!alreadyChecked) {
		log(ctx, "click", "Confirm widget active checkbox");
		await cursorClick(page, widgetCheckbox, "I have added the chat widget");
		await pause(ctx, 2000); // Wait for the API call to complete
	} else {
		log(ctx, "skip", "Widget checkbox already confirmed");
		await pause(ctx, 1000);
	}

	log(ctx, "widget", "Widget confirmed active");

	// Navigate back to dashboard
	log(ctx, "navigate", "Back to dashboard");
	await page.goBack({ waitUntil: "domcontentloaded" });
	await page.waitForTimeout(2000);

	// Verify we're on the dashboard; if not, navigate directly
	const onDashboard = await appFrame(page)
		.locator('a[href*="/setup-wizard"]')
		.first()
		.isVisible()
		.catch(() => false);
	if (!onDashboard) {
		await page.goto(APP_URL, { waitUntil: "domcontentloaded", timeout: 30_000 });
		await page.waitForTimeout(2000);
		await waitForPolaris(page);
	}

	await waitForDashboard(page);
	await pause(ctx, 2000);
	log(ctx, "dashboard", "Back to dashboard after widget setup");
}

// ── Phase 6: Completed dashboard ────────────────────────────────────

async function phase6Complete(ctx: ScreencastContext) {
	log(ctx, "complete", "Dashboard with completed setup steps");
	// Voiceover: AI Agent configured, free plan active,
	// phone number available for voice support, all visible in setup bar
	await pause(ctx, 6000);
	log(ctx, "end", "Installation screencast complete");
}

// ── Main ────────────────────────────────────────────────────────────

async function main() {
	console.log(`── Screencast 1: Installation Experience (from=${startFrom}) ──\n`);

	const phases = ["install", "onboarding", "dashboard", "wizard", "widget", "complete"];
	const startIdx = phases.indexOf(startFrom);
	if (startIdx === -1) {
		console.error(`Unknown --from value: ${startFrom}`);
		console.error(`Valid: ${phases.join(", ")}`);
		process.exit(1);
	}

	// Choose start URL based on entry point
	const startUrl = startFrom === "install" ? INSTALL_URL : APP_URL;
	const ctx = await startRecording("1-install", startUrl);

	// When starting from dashboard or later, wait for Polaris + app content
	if (startIdx >= 2) {
		await waitForPolaris(ctx.page);
		await pause(ctx, 2000);
	}

	const phaseFns: Record<string, (ctx: ScreencastContext) => Promise<void>> = {
		install: phase1Install,
		onboarding: phase2Onboarding,
		dashboard: phase3Dashboard,
		wizard: phase4Wizard,
		widget: phase5Widget,
		complete: phase6Complete,
	};

	try {
		for (let i = startIdx; i < phases.length; i++) {
			await phaseFns[phases[i]](ctx);
		}
	} catch (err) {
		console.error("Screencast error:", err);
		log(ctx, "error", String(err));
	}

	await finishRecording(ctx, "1-install");
}

main().catch((err) => {
	console.error(err);
	process.exit(1);
});
