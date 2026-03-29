/**
 * Screencast 3: Customer Experience — Chat Widget
 *
 * Records: Widget open → product search → add to cart → upsell →
 *          checkout → contact info
 *
 * Usage: npx tsx screencast-3-customer.ts
 */

import {
	finishRecording,
	log,
	pause,
	startRecording,
} from "./screencast-helpers";
import {
	PAUSE_AFTER_RESPONSE,
	sendMessage,
	scrollThroughResponse,
} from "./helpers";

const STORE_URL = "https://demo-store.xinfer.ai";

async function main() {
	console.log("── Screencast 3: Customer Experience ──\n");

	const ctx = await startRecording("3-customer", STORE_URL);
	const { page } = ctx;

	await pause(ctx, 3000);

	// Reset timer when page is loaded
	ctx.startTime = Date.now();
	log(ctx, "page-load", "Storefront loaded");

	// Wait for widget to appear
	const widget = page.locator("#xinfer-chat-widget");
	await widget.waitFor({ state: "attached", timeout: 15_000 });
	const toggle = widget.locator("button.xinfer-toggle");
	await toggle.waitFor({ state: "visible", timeout: 10_000 });
	await pause(ctx, 2000);

	// Open widget
	log(ctx, "open-widget", "Opening chat widget");
	await toggle.click();

	const panel = widget.locator(".xinfer-panel");
	await panel.waitFor({ state: "visible", timeout: 5000 });
	await pause(ctx, 2000);
	log(ctx, "widget-open", "Widget opened");

	const messages = widget.locator("#xinfer-messages");

	// Assistant message indices — msg 0 is the greeting
	let assistantIdx = 1;

	// 1. Search for snowboards
	log(ctx, "query-1", "Show me snowboards under 700");
	await sendMessage(page, widget, "Show me snowboards under 700");
	log(ctx, "response-1", "Snowboard results received");
	await scrollThroughResponse(page, messages, assistantIdx++);
	await pause(ctx, PAUSE_AFTER_RESPONSE);

	// 2. Add to cart
	log(ctx, "query-2", "Add the hydrogen to my cart");
	await sendMessage(page, widget, "Add the hydrogen to my cart");
	log(ctx, "response-2", "Added to cart");
	await scrollThroughResponse(page, messages, assistantIdx++);
	await pause(ctx, PAUSE_AFTER_RESPONSE);

	// 3. Check if AI sent an upsell mentioning "wax"
	const hasUpsell = await messages.evaluate((el) => {
		const assistantMsgs = el.querySelectorAll(".xinfer-message-assistant");
		const lastMsg = assistantMsgs[assistantMsgs.length - 1];
		return lastMsg?.textContent?.toLowerCase().includes("wax") ?? false;
	});

	if (hasUpsell) {
		log(ctx, "upsell", "AI upsell detected — ski wax");
		await scrollThroughResponse(page, messages, assistantIdx++);
		await pause(ctx, PAUSE_AFTER_RESPONSE);

		// Accept upsell
		log(ctx, "query-3", "Yes");
		await sendMessage(page, widget, "Yes");
		log(ctx, "response-3", "Upsell accepted");
		await scrollThroughResponse(page, messages, assistantIdx++);
		await pause(ctx, PAUSE_AFTER_RESPONSE);

		// Pick the sample
		log(ctx, "query-4", "Let's take the sample");
		await sendMessage(page, widget, "Let's take the sample");
		log(ctx, "response-4", "Sample selected");
		await scrollThroughResponse(page, messages, assistantIdx++);
		await pause(ctx, PAUSE_AFTER_RESPONSE);
	} else {
		log(ctx, "upsell-skip", "No upsell detected — skipping");
	}

	// Checkout
	log(ctx, "query-5", "Let's check out");
	await sendMessage(page, widget, "Let's check out");
	log(ctx, "response-5", "Checkout initiated");
	await scrollThroughResponse(page, messages, assistantIdx++);
	await pause(ctx, PAUSE_AFTER_RESPONSE);

	// 7. Provide email
	log(ctx, "query-6", "email is demo@xinfer.ai");
	await sendMessage(page, widget, "email is demo@xinfer.ai");
	log(ctx, "response-6", "Email provided");
	await scrollThroughResponse(page, messages, assistantIdx++);
	await pause(ctx, PAUSE_AFTER_RESPONSE);

	// 8. Provide name
	log(ctx, "query-7", "name is Demo XInfer");
	await sendMessage(page, widget, "name is Demo XInfer");
	log(ctx, "response-7", "Name provided — checkout complete");
	await scrollThroughResponse(page, messages, assistantIdx++);
	await pause(ctx, PAUSE_AFTER_RESPONSE);

	// Hold final frame
	await pause(ctx, 5000);
	log(ctx, "end", "Customer segment complete");

	await finishRecording(ctx, "3-customer");
}

main().catch((err) => {
	console.error(err);
	process.exit(1);
});
