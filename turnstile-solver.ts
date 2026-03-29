/**
 * Cloudflare Challenge Solver (Playwright)
 *
 * Solves Cloudflare managed challenge pages by finding the verification
 * checkbox and clicking it with human-like mouse movement (Bézier curves).
 *
 * Key insight: The managed challenge renders the checkbox inside a Shadow DOM.
 * Standard `document.querySelectorAll` can't pierce shadow boundaries, but
 * Playwright's `locator()` API does by default.
 */

import type { Page } from "playwright";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface Vector {
	x: number;
	y: number;
}

interface ClickTarget {
	x: number;
	y: number;
	width: number;
	height: number;
}

// ---------------------------------------------------------------------------
// Bézier curve math (adapted from ghost-cursor)
// ---------------------------------------------------------------------------

function clamp(value: number, min: number, max: number): number {
	return Math.min(Math.max(value, min), max);
}

function add(a: Vector, b: Vector): Vector {
	return { x: a.x + b.x, y: a.y + b.y };
}

function sub(a: Vector, b: Vector): Vector {
	return { x: a.x - b.x, y: a.y - b.y };
}

function mult(v: Vector, scalar: number): Vector {
	return { x: v.x * scalar, y: v.y * scalar };
}

function magnitude(v: Vector): number {
	return Math.sqrt(v.x * v.x + v.y * v.y);
}

function unit(v: Vector): Vector {
	const mag = magnitude(v);
	return mag === 0 ? { x: 0, y: 0 } : { x: v.x / mag, y: v.y / mag };
}

function perpendicular(v: Vector): Vector {
	return { x: v.y, y: -v.x };
}

function rand(min: number, max: number): number {
	return min + Math.random() * (max - min);
}

function randomAnchor(a: Vector, b: Vector, spread: number): Vector {
	const t = rand(0.2, 0.8);
	const mid = add(a, mult(sub(b, a), t));
	const dir = unit(sub(b, a));
	const perp = perpendicular(dir);
	const offset = rand(-spread, spread);
	return add(mid, mult(perp, offset));
}

function cubicBezier(
	p0: Vector,
	p1: Vector,
	p2: Vector,
	p3: Vector,
	t: number,
): Vector {
	const u = 1 - t;
	const tt = t * t;
	const uu = u * u;
	return {
		x: uu * u * p0.x + 3 * uu * t * p1.x + 3 * u * tt * p2.x + tt * t * p3.x,
		y: uu * u * p0.y + 3 * uu * t * p1.y + 3 * u * tt * p2.y + tt * t * p3.y,
	};
}

function generatePath(from: Vector, to: Vector, steps = 25): Vector[] {
	const dist = magnitude(sub(to, from));
	const spread = clamp(dist * 0.4, 2, 150);
	const side = Math.random() > 0.5 ? 1 : -1;
	const cp1 = randomAnchor(from, to, spread * side);
	const cp2 = randomAnchor(from, to, spread * side);
	const sorted =
		magnitude(sub(cp1, from)) <= magnitude(sub(cp2, from))
			? [cp1, cp2]
			: [cp2, cp1];

	const path: Vector[] = [];
	for (let i = 0; i <= steps; i++) {
		const t = i / steps;
		const p = cubicBezier(from, sorted[0], sorted[1], to, t);
		path.push({
			x: Math.max(0, Math.round(p.x)),
			y: Math.max(0, Math.round(p.y)),
		});
	}
	return path;
}

// ---------------------------------------------------------------------------
// Mouse movement
// ---------------------------------------------------------------------------

async function humanMouseMove(
	page: Page,
	from: Vector,
	to: Vector,
): Promise<void> {
	const path = generatePath(from, to, 20 + Math.floor(Math.random() * 15));
	for (let i = 0; i < path.length; i++) {
		const point = path[i];
		const progress = i / path.length;
		const speedFactor = 1 - 4 * (progress - 0.5) * (progress - 0.5);
		const baseDelay = 5 + Math.random() * 8;
		const delay = baseDelay * (1 + (1 - speedFactor) * 2);
		await page.mouse.move(point.x, point.y);
		await new Promise((r) => setTimeout(r, delay));
	}
}

// ---------------------------------------------------------------------------
// Challenge detection & checkbox finding (using Playwright locators
// which pierce Shadow DOM)
// ---------------------------------------------------------------------------

/**
 * Find the challenge checkbox target.
 *
 * The widget container (parent of `cf-turnstile-response` hidden input) exists
 * from page load but has 0 dimensions until the orchestrate script renders
 * the checkbox inside it. We wait for it to become visible, then return a
 * click target at the checkbox position (left side of the widget).
 */
async function findCheckboxTarget(page: Page): Promise<ClickTarget | null> {
	// Method 1: Find the widget container via the hidden input that's always present
	const container = await page.evaluate(() => {
		const input = document.querySelector('[name="cf-turnstile-response"]');
		if (!input) return null;

		// Walk up to find the container with visible dimensions
		// The structure is: container > div > div > input
		let el: HTMLElement | null = input.parentElement;
		for (let depth = 0; depth < 5 && el; depth++) {
			const rect = el.getBoundingClientRect();
			// Widget is typically ~300x65 when rendered
			if (rect.width > 100 && rect.height > 30) {
				return {
					x: rect.x,
					y: rect.y,
					width: rect.width,
					height: rect.height,
				};
			}
			el = el.parentElement;
		}

		// Also check for any iframe siblings/children that may have been injected
		const parent = input.closest("div[style]") || input.parentElement;
		if (parent) {
			const iframe = parent.querySelector("iframe");
			if (iframe) {
				const rect = iframe.getBoundingClientRect();
				if (rect.width > 50 && rect.height > 30) {
					return {
						x: rect.x,
						y: rect.y,
						width: rect.width,
						height: rect.height,
					};
				}
			}
		}

		return null;
	});

	if (container) {
		console.log(
			`[TurnstileSolver] Widget container at (${Math.round(container.x)}, ${Math.round(container.y)}) ${Math.round(container.width)}x${Math.round(container.height)}`,
		);
		return container;
	}

	return null;
}

async function isChallengePage(page: Page): Promise<boolean> {
	// Use locator for shadow-DOM-piercing check first
	const turnstileInput = page.locator('[name="cf-turnstile-response"]');
	if ((await turnstileInput.count()) > 0) return true;

	const cbLabel = page.locator(".cb-lb");
	if ((await cbLabel.count()) > 0) return true;

	// Fall back to text content check (doesn't need shadow piercing)
	return page.evaluate(() => {
		const bodyText = document.body?.innerText || "";
		if (bodyText.includes("Verify you are human")) return true;
		if (bodyText.includes("Performing security verification")) return true;
		return false;
	});
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export interface TurnstileSolveResult {
	solved: boolean;
	attempts: number;
	error?: string;
}

export async function solveTurnstile(
	page: Page,
	options: { maxAttempts?: number; timeout?: number } = {},
): Promise<TurnstileSolveResult> {
	const { maxAttempts = 3, timeout = 15000 } = options;

	const isChallenge = await isChallengePage(page);
	if (!isChallenge) {
		return { solved: true, attempts: 0 };
	}

	console.log("[TurnstileSolver] Challenge detected, looking for checkbox...");

	// Poll for checkbox — widget may take time to render
	let target: ClickTarget | null = null;
	for (let i = 0; i < 20; i++) {
		target = await findCheckboxTarget(page);
		if (target) break;
		await new Promise((r) => setTimeout(r, 500));
	}

	if (!target) {
		console.log("[TurnstileSolver] No checkbox found after 10s");
		return { solved: false, attempts: 0, error: "No checkbox found" };
	}

	// Phase 2: Try clicking the checkbox
	for (let attempt = 1; attempt <= maxAttempts; attempt++) {
		try {
			const stillChallenge = await isChallengePage(page);
			if (!stillChallenge) {
				console.log("[TurnstileSolver] Challenge resolved");
				return { solved: true, attempts: attempt };
			}

			// Re-find target on retries (position may shift)
			if (attempt > 1) {
				target = await findCheckboxTarget(page);
			}
			if (!target) {
				console.log("[TurnstileSolver] Checkbox not found, waiting...");
				await new Promise((r) => setTimeout(r, 2000));
				continue;
			}

			console.log(
				`[TurnstileSolver] Click attempt ${attempt}/${maxAttempts} at (${Math.round(target.x)}, ${Math.round(target.y)}) ${Math.round(target.width)}x${Math.round(target.height)}`,
			);

			// Click position: center for small elements, left-side for wide widgets
			const isSmallCheckbox = target.width < 100;
			const clickX = isSmallCheckbox
				? target.x + target.width / 2 + (Math.random() - 0.5) * 4
				: target.x + 28 + Math.random() * 8;
			const clickY = target.y + target.height / 2 + (Math.random() - 0.5) * 4;

			// Human-like mouse movement
			const viewport = page.viewportSize() || { width: 1920, height: 1080 };
			const startX = rand(100, viewport.width * 0.7);
			const startY = rand(100, viewport.height * 0.7);
			await page.mouse.move(startX, startY);
			await new Promise((r) => setTimeout(r, 200 + Math.random() * 300));

			if (Math.random() > 0.3) {
				const midX = rand(50, viewport.width * 0.8);
				const midY = rand(50, viewport.height * 0.6);
				await humanMouseMove(
					page,
					{ x: startX, y: startY },
					{ x: midX, y: midY },
				);
				await new Promise((r) => setTimeout(r, 100 + Math.random() * 200));
				await humanMouseMove(
					page,
					{ x: midX, y: midY },
					{ x: clickX, y: clickY },
				);
			} else {
				await humanMouseMove(
					page,
					{ x: startX, y: startY },
					{ x: clickX, y: clickY },
				);
			}

			await new Promise((r) => setTimeout(r, 50 + Math.random() * 150));
			await page.mouse.down();
			await new Promise((r) => setTimeout(r, 30 + Math.random() * 80));
			await page.mouse.up();

			console.log(
				`[TurnstileSolver] Clicked (${Math.round(clickX)}, ${Math.round(clickY)})`,
			);

			// Wait for resolution
			try {
				await page.waitForURL("**/*", {
					timeout,
					waitUntil: "networkidle",
				});
				console.log("[TurnstileSolver] Navigation detected");
			} catch {
				await new Promise((r) => setTimeout(r, 3000));
			}

			const afterClick = await isChallengePage(page);
			if (!afterClick) {
				console.log(`[TurnstileSolver] Solved on attempt ${attempt}`);
				return { solved: true, attempts: attempt };
			}

			console.log("[TurnstileSolver] Challenge still present, retrying...");
		} catch (err) {
			console.error(
				`[TurnstileSolver] Attempt ${attempt} error:`,
				err instanceof Error ? err.message : err,
			);
		}
	}

	return {
		solved: false,
		attempts: maxAttempts,
		error: `Failed to solve after ${maxAttempts} attempts`,
	};
}
