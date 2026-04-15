/**
 * Quality evaluation for recorded demos.
 *
 * After recording completes, quality signals captured during the session
 * are evaluated against a set of rules. If any rule fails, the pipeline
 * exits early and uploads a failure report instead of proceeding to
 * voiceover/compose/publish.
 */

export interface QualitySignal {
	action: string; // "query-1", "query-2", etc.
	query: string; // The query text
	duration: number; // Actual duration in seconds
	minDuration: number; // MIN_QUERY_DURATION or MIN_QUERY_WITH_FORM_DURATION (in seconds)
	cartVisible: boolean; // Was .chat-cart visible?
	cartItems: string[]; // Text content of each .chat-cart-item-title
	formVisible: boolean; // Was .chat-followup-form visible?
	formSubmitted: boolean; // Was the form filled+submitted this query?
	orderVisible: boolean; // Was .chat-followup-submitted visible?
	responseText: string; // AI response text
}

export interface QualityResult {
	passed: boolean;
	failures: { query: string; reason: string }[];
}

// --- Intent detection ---

function isAddToCart(query: string): boolean {
	return /\b(add|put)\b.*\b(cart|bag|basket)\b/i.test(query);
}

function isCheckout(query: string): boolean {
	return /\b(check\s*out|place\s*(an?\s+)?order|complete\s*(the\s+)?order|buy|purchase)\b/i.test(
		query,
	);
}

// --- Fuzzy cart item matching ---

const STOP_WORDS = new Set([
	"add",
	"put",
	"to",
	"my",
	"the",
	"a",
	"an",
	"in",
	"cart",
	"bag",
	"basket",
	"please",
	"can",
	"you",
	"i",
	"want",
	"would",
	"like",
	"some",
	"of",
	"and",
	"or",
]);

function tokenize(text: string): string[] {
	return text
		.toLowerCase()
		.replace(/[^a-z0-9\s]/g, "")
		.split(/\s+/)
		.filter((w) => w.length > 0 && !STOP_WORDS.has(w));
}

function fuzzyMatchCartItem(query: string, cartItems: string[]): boolean {
	const queryTokens = tokenize(query);
	if (queryTokens.length === 0) return true; // Can't determine intent

	for (const item of cartItems) {
		const itemTokens = tokenize(item);
		if (itemTokens.length === 0) continue;
		const matches = itemTokens.filter((t) => queryTokens.includes(t)).length;
		if (matches / itemTokens.length >= 0.5) return true;
	}
	return false;
}

// --- Evaluation ---

export function evaluateQuality(signals: QualitySignal[]): QualityResult {
	const failures: { query: string; reason: string }[] = [];

	for (const signal of signals) {
		const label = `${signal.action} "${signal.query}"`;

		// Rule 1: Duration check (3x minimum)
		const maxDuration = 3 * signal.minDuration;
		if (signal.duration > maxDuration) {
			failures.push({
				query: label,
				reason: `took ${signal.duration.toFixed(1)}s, limit ${maxDuration.toFixed(0)}s`,
			});
		}

		// Rule 2: Add-to-cart but no cart visible
		if (isAddToCart(signal.query) && !signal.cartVisible) {
			failures.push({
				query: label,
				reason: "add-to-cart but no shopping cart visible",
			});
		}

		// Rule 3: Cart visible but item not found
		if (
			isAddToCart(signal.query) &&
			signal.cartVisible &&
			!fuzzyMatchCartItem(signal.query, signal.cartItems)
		) {
			const itemList = signal.cartItems.join('", "');
			failures.push({
				query: label,
				reason: `item not found in cart (cart items: "${itemList}")`,
			});
		}

		// Rule 4: Checkout but no form visible (and form wasn't submitted)
		if (
			isCheckout(signal.query) &&
			!signal.formVisible &&
			!signal.formSubmitted
		) {
			failures.push({
				query: label,
				reason: "checkout but no contact form visible",
			});
		}

		// Rule 5: Form submitted for checkout but no order confirmation
		if (signal.formSubmitted && isCheckout(signal.query) && !signal.orderVisible) {
			failures.push({
				query: label,
				reason: "form submitted for checkout but no order confirmation",
			});
		}
	}

	return { passed: failures.length === 0, failures };
}

/** Format quality failures into a human-readable string for DB storage. */
export function formatFailureReason(result: QualityResult): string {
	return result.failures
		.map((f) => `${f.query}: ${f.reason}`)
		.join("\n");
}
