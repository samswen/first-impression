import type { Locator, Page } from "playwright";

// --- Timing constants ---

/** Delay between keystrokes (ms) — ~14 chars/sec for natural typing */
export const TYPING_DELAY = 70;

/** Pause after typing before hitting send — let viewer read the query */
export const PAUSE_AFTER_TYPE = 800;

/** Pause after AI response finishes — let viewer read the answer */
export const PAUSE_AFTER_RESPONSE = 1000;

/** Max time to wait for AI streaming to finish */
const STREAMING_TIMEOUT = 90_000;

// --- Helpers ---

/**
 * Wait until streaming is fully done: action bar visible AND no skeleton loaders.
 * The widget's `.chat-action-bar` has `.chat-action-bar-hidden` (display: none)
 * while `isLoading` is true. When streaming finishes, the hidden class is removed.
 */
export async function waitForResponseDone(
	page: Page,
	widget: Locator,
	timeout = STREAMING_TIMEOUT,
) {
	const actionBar = widget.locator(".chat-action-bar");
	const deadline = Date.now() + timeout;

	while (Date.now() < deadline) {
		const ready = await actionBar
			.evaluate((el) => {
				const root = el.getRootNode() as ShadowRoot | Document;
				const hasSkeletons =
					root.querySelectorAll(
						".chat-skeleton-bar, .chat-skeleton-image-block",
					).length > 0;
				const visible = !el.classList.contains("chat-action-bar-hidden");
				return visible && !hasSkeletons;
			})
			.catch(() => false);

		if (ready) {
			// Confirm stable (not a brief flash during product card loading)
			await page.waitForTimeout(250);
			const stillReady = await actionBar
				.evaluate((el) => {
					const root = el.getRootNode() as ShadowRoot | Document;
					const hasSkeletons =
						root.querySelectorAll(
							".chat-skeleton-bar, .chat-skeleton-image-block",
						).length > 0;
					return (
						!el.classList.contains("chat-action-bar-hidden") && !hasSkeletons
					);
				})
				.catch(() => false);

			if (stillReady) return;
		}

		await page.waitForTimeout(250);
	}

	throw new Error(`Response did not finish within ${timeout}ms`);
}

/**
 * Type a message into the widget input, send it, and wait for the AI response.
 *
 * @param skipWaitBefore - skip the initial waitForResponseDone (use for the
 *   first message when the action bar hasn't appeared yet — it's hidden when
 *   messages.length === 0 in the greeting view).
 */
export async function sendMessage(
	page: Page,
	widget: Locator,
	text: string,
	{ skipWaitBefore = false } = {},
) {
	const input = widget.locator("#xinfer-input");
	const send = widget.locator(".xinfer-send");

	// Wait for previous response to finish (skip for first message)
	if (!skipWaitBefore) {
		await waitForResponseDone(page, widget);
	}

	// Type with natural delay
	await input.pressSequentially(text, { delay: TYPING_DELAY });

	// Pause so viewer can read the typed query
	await page.waitForTimeout(PAUSE_AFTER_TYPE);

	// Click send and verify input clears
	await send.click();
	await page.waitForTimeout(500);

	// Retry click if input didn't clear (DOM transition)
	const value = await input.inputValue();
	if (value.trim() !== "") {
		await send.click();
		await page.waitForTimeout(500);
	}

	// Wait for streaming to finish
	await waitForResponseDone(page, widget);
}

/**
 * Smoothly float a target element to the viewport center and scale it up.
 * Transforms only the element itself — the rest of the page stays static.
 *
 * Scale is computed automatically so the element fits within the viewport
 * with padding. You can cap it with maxScale.
 */
export async function zoomToElement(
	page: Page,
	locator: Locator,
	maxScale = 2.5,
	durationMs = 800,
) {
	const box = await locator.boundingBox();
	if (!box) throw new Error("Could not get bounding box for zoom target");

	const vw = 1920;
	const vh = 1080;

	console.log(`  Panel bounds: ${box.x}, ${box.y}, ${box.width}x${box.height}`);

	// Compute scale so the panel fills the full viewport height
	// Use full height (no vertical padding), with a small horizontal margin
	const scale = Math.min(maxScale, (vw * 0.9) / box.width, vh / box.height);

	console.log(`  Computed scale: ${scale.toFixed(2)}`);

	// With transform-origin: 0 0 on the element:
	//   After scale(S): element center moves from (x+w/2, y+h/2) to (x+w*S/2, y+h*S/2)
	//   After translate(tx,ty): center moves to (x+w*S/2+tx, y+h*S/2+ty)
	//   We want center at (vw/2, vh/2)
	const tx = vw / 2 - box.x - (box.width * scale) / 2;
	const ty = vh / 2 - box.y - (box.height * scale) / 2;

	await locator.evaluate(
		(el, { tx, ty, scale, ms }) => {
			const s = el as HTMLElement;
			s.style.transition = `transform ${ms}ms cubic-bezier(0.4, 0, 0.2, 1)`;
			s.style.transformOrigin = "0 0";
			s.style.transform = `translate(${tx}px, ${ty}px) scale(${scale})`;
			s.style.zIndex = "999999";
		},
		{ tx, ty, scale, ms: durationMs },
	);

	// Wait for the animation to finish + a beat for the viewer
	await page.waitForTimeout(durationMs + 300);
}

/**
 * Smoothly reset an element's zoom back to its original position.
 */
export async function resetZoom(
	page: Page,
	locator: Locator,
	durationMs = 800,
) {
	await locator.evaluate((el, ms) => {
		const s = el as HTMLElement;
		s.style.transition = `transform ${ms}ms cubic-bezier(0.4, 0, 0.2, 1)`;
		s.style.transform = "none";
	}, durationMs);
	await page.waitForTimeout(durationMs + 300);
}

/**
 * After a response finishes streaming, scroll back to the top of that
 * assistant message, then page through it view-by-view so the viewer
 * can read everything.
 *
 * @param messageIndex - 0-based index of the assistant message
 * @param pauseMs - how long to hold each view (default 3s)
 */
export async function scrollThroughResponse(
	page: Page,
	messagesContainer: Locator,
	messageIndex: number,
	pauseMs = 3000,
) {
	// Scroll to top of message (triggers lazy-loaded images), wait for them
	await messagesContainer.evaluate(
		(container, { idx }) => {
			const msgs = container.querySelectorAll(".chat-bubble-assistant");
			const msg = msgs[idx] as HTMLElement | undefined;
			if (!msg) return;
			container.scrollTop = msg.offsetTop - 8;
		},
		{ idx: messageIndex },
	);
	await page.waitForTimeout(3000);

	// Calculate all scroll stops upfront (immune to widget auto-scroll)
	const stops = await messagesContainer.evaluate(
		(container, { idx }) => {
			const msgs = container.querySelectorAll(".chat-bubble-assistant");
			const msg = msgs[idx] as HTMLElement | undefined;
			if (!msg) return [];

			const viewH = container.clientHeight;
			const maxScroll = container.scrollHeight - viewH;
			const msgTop = Math.max(0, msg.offsetTop - 8);
			const msgBottom = msg.offsetTop + msg.offsetHeight;

			const positions: number[] = [];
			let pos = msgTop;
			while (pos < msgBottom - viewH && pos < maxScroll) {
				positions.push(pos);
				pos += viewH * 0.85;
			}
			// Final stop: show the bottom of the message
			positions.push(Math.min(maxScroll, Math.max(0, msgBottom - viewH)));

			console.log(
				`scroll-through: msg=${msg.offsetHeight}px top=${msgTop} bottom=${msgBottom}, ` +
					`view=${viewH}px, maxScroll=${maxScroll}, stops=${positions.length}`,
			);
			return positions;
		},
		{ idx: messageIndex },
	);

	console.log(`    scroll-through[${messageIndex}]: ${stops.length} views`);

	// Step through each position
	for (let i = 0; i < stops.length; i++) {
		const target = stops[i];
		if (i === 0) {
			// First stop: instant (already scrolled here)
			await messagesContainer.evaluate((container, t) => {
				container.scrollTop = t;
			}, target);
		} else {
			// Subsequent stops: smooth scroll
			await messagesContainer.evaluate((container, t) => {
				container.scrollTo({ top: t, behavior: "smooth" });
			}, target);
			await page.waitForTimeout(600); // scroll animation
		}
		await page.waitForTimeout(pauseMs);
	}

	// Scroll to bottom so widget auto-scroll works for next message
	await messagesContainer.evaluate((container) => {
		container.scrollTop = container.scrollHeight;
	});
}
