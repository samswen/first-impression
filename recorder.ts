import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium, type Page } from "playwright";
import {
	PAUSE_AFTER_RESPONSE,
	resetZoom,
	sendMessage,
	TYPING_DELAY,
	waitForResponseDone,
	zoomToElement,
} from "./helpers";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export interface RecordingConfig {
	url: string;
	queries: string[];
	headed: boolean;
	recordingDir?: string;
	widgetUrl?: string;
}

export interface TimelineEntry {
	action: string;
	label: string;
	startTime: number;
	endTime: number;
}

export interface ProgressEvent {
	type: "progress" | "action-start" | "action-end" | "done" | "error";
	message: string;
	timestamp: number;
	action?: string;
}

export interface RecordingResult {
	dir: string;
	videoPath: string;
	timeline: TimelineEntry[];
}

/** Media resource types that indicate video/audio content. */
const MEDIA_RESOURCE_TYPES = new Set(["media", "fetch", "xhr"]);
const MEDIA_EXTENSIONS =
	/\.(mp4|webm|ogg|m3u8|ts|m4s|mpd|mp3|wav|aac|m4a)(\?|$)/i;

/**
 * Detect media failures via both network events AND DOM MediaError.
 * Returns a list of failure descriptions.
 */
async function detectMediaFailures(
	page: Page,
	failedRequests: string[],
): Promise<string[]> {
	const failures = [...failedRequests];

	// Also check DOM-level MediaError (catches cases where the request
	// succeeded but the browser couldn't decode the media)
	const domErrors = await page.evaluate(() => {
		const errs: string[] = [];
		for (const el of document.querySelectorAll("video, audio")) {
			const media = el as HTMLMediaElement;
			if (media.error) {
				const src = media.currentSrc || media.getAttribute("src") || "unknown";
				errs.push(`${media.tagName} error=${media.error.code} src=${src}`);
			}
		}
		return errs;
	});
	failures.push(...domErrors);

	return failures;
}

/**
 * Load a page and retry (reload) if media resources fail to load.
 * Monitors both network-level failures (requestfailed, HTTP errors on media
 * URLs) and DOM-level MediaError on <video>/<audio> elements.
 */
async function loadPageWithMediaRetry(
	page: Page,
	url: string,
	maxRetries: number,
	emit: (type: ProgressEvent["type"], message: string) => void,
): Promise<void> {
	for (let attempt = 1; attempt <= maxRetries; attempt++) {
		const failedRequests: string[] = [];

		// Listen for network-level failures on media resources
		const onRequestFailed = (request: {
			url: () => string;
			resourceType: () => string;
			failure: () => { errorText: string } | null;
		}) => {
			const rUrl = request.url();
			const rType = request.resourceType();
			if (MEDIA_RESOURCE_TYPES.has(rType) || MEDIA_EXTENSIONS.test(rUrl)) {
				const err = request.failure()?.errorText || "unknown";
				failedRequests.push(`requestfailed: ${err} url=${rUrl}`);
			}
		};
		const onResponse = (response: {
			url: () => string;
			status: () => number;
			request: () => { resourceType: () => string };
		}) => {
			const rUrl = response.url();
			const rType = response.request().resourceType();
			const status = response.status();
			if (
				status >= 400 &&
				(MEDIA_RESOURCE_TYPES.has(rType) || MEDIA_EXTENSIONS.test(rUrl))
			) {
				failedRequests.push(`HTTP ${status} url=${rUrl}`);
			}
		};

		page.on("requestfailed", onRequestFailed);
		page.on("response", onResponse);

		try {
			await page.goto(url, { waitUntil: "load", timeout: 60_000 });
			// Wait for media elements to start loading / fail
			await page.waitForTimeout(3000);
		} finally {
			page.removeListener("requestfailed", onRequestFailed);
			page.removeListener("response", onResponse);
		}

		const failures = await detectMediaFailures(page, failedRequests);
		if (failures.length === 0) return;

		const summary = failures.join("; ");
		if (attempt < maxRetries) {
			emit(
				"progress",
				`Detected media failure (${summary}), reloading page (attempt ${attempt + 1}/${maxRetries})...`,
			);
			await page.waitForTimeout(2000);
		} else {
			emit(
				"progress",
				`Still media failures after ${maxRetries} attempts (${summary}), continuing anyway...`,
			);
		}
	}
}

export class Recorder {
	private config: RecordingConfig;
	private recordingStart = 0;
	private timeline: TimelineEntry[] = [];

	constructor(config: RecordingConfig) {
		this.config = config;
	}

	private now(): number {
		return (Date.now() - this.recordingStart) / 1000;
	}

	async run(
		onProgress?: (event: ProgressEvent) => void,
		signal?: AbortSignal,
	): Promise<RecordingResult> {
		const emit = (
			type: ProgressEvent["type"],
			message: string,
			action?: string,
		) => {
			onProgress?.({ type, message, timestamp: Date.now(), action });
		};

		const dir =
			this.config.recordingDir ??
			path.join(
				__dirname,
				"recordings",
				new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19),
			);
		fs.mkdirSync(dir, { recursive: true });

		// --- Prepare page content before recording starts ---
		let navigateUrl: string;

		if (this.config.widgetUrl) {
			emit("progress", `Taking snapshot of ${this.config.url}...`);

			// Use a separate browser for the snapshot (no recording)
			const snapBrowser = await chromium.launch({ headless: true });
			let snapshotOk = false;

			try {
				const snapContext = await snapBrowser.newContext({
					viewport: { width: 1920, height: 1080 },
					ignoreHTTPSErrors: true,
				});
				const snapPage = await snapContext.newPage();
				await loadPageWithMediaRetry(snapPage, this.config.url, 3, emit);

				const snapshotPath = path.join(dir, "snapshot.png");
				await snapPage.screenshot({
					path: snapshotPath,
					fullPage: false,
				});
				await snapContext.close();

				// Capture mobile snapshot at iPhone 14/15 size
				const mobileContext = await snapBrowser.newContext({
					viewport: { width: 390, height: 844 },
					ignoreHTTPSErrors: true,
				});
				const mobilePage = await mobileContext.newPage();
				await loadPageWithMediaRetry(mobilePage, this.config.url, 3, emit);

				const snapshotMobilePath = path.join(dir, "snapshot-mobile.png");
				await mobilePage.screenshot({
					path: snapshotMobilePath,
					fullPage: false,
				});
				await mobileContext.close();
				snapshotOk = true;
			} catch (snapErr) {
				const msg =
					snapErr instanceof Error ? snapErr.message : String(snapErr);
				emit(
					"progress",
					`Could not reach ${this.config.url} (${msg}), using blank background...`,
				);
			}

			await snapBrowser.close();

			if (snapshotOk) {
				emit("progress", "Snapshot taken, building local page...");
			}

			// Build background style: screenshot if available, plain gradient if not
			let bgStyle: string;
			const snapshotPath = path.join(dir, "snapshot.png");
			if (snapshotOk && fs.existsSync(snapshotPath)) {
				const imgBuffer = fs.readFileSync(snapshotPath);
				const imgBase64 = imgBuffer.toString("base64");
				const dataUri = `data:image/png;base64,${imgBase64}`;
				bgStyle = `background: url("${dataUri}") no-repeat top left; background-size: 1920px 1080px;`;
			} else {
				bgStyle =
					"background: linear-gradient(135deg, #1e293b 0%, #0f172a 100%);";
			}

			// Build a local HTML page with background + widget script
			const localHtml = `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=1920">
<style>
* { margin: 0; padding: 0; }
html, body { width: 1920px; height: 1080px; overflow: hidden; }
body { ${bgStyle} }
</style>
</head>
<body>
<script src="${this.config.widgetUrl}" async></script>
</body>
</html>`;

			const localPagePath = path.join(dir, "snapshot-page.html");
			fs.writeFileSync(localPagePath, localHtml);
			navigateUrl = `file://${localPagePath}`;
		} else {
			navigateUrl = this.config.url;
		}

		// --- Now launch the recording browser and navigate to the ready page ---
		if (signal?.aborted) throw new Error("Cancelled");
		emit("progress", "Launching recording browser...");
		const browser = await chromium.launch({
			headless: !this.config.headed,
		});
		const context = await browser.newContext({
			viewport: { width: 1920, height: 1080 },
			recordVideo: {
				dir,
				size: { width: 1920, height: 1080 },
			},
			ignoreHTTPSErrors: true,
		});

		const page = await context.newPage();

		try {
			// --- Page load ---
			emit("action-start", `Loading ${this.config.url}`, "page-load");
			await page.goto(navigateUrl, {
				waitUntil: "domcontentloaded",
				timeout: 60_000,
			});

			const widget = page.locator("#xinfer-chat-widget");
			await widget.waitFor({ state: "attached", timeout: 30_000 });
			const toggle = widget.locator("button.xinfer-toggle");
			await toggle.waitFor({ state: "visible", timeout: 10_000 });

			// Start the timeline clock only after the page is visible with widget
			this.recordingStart = Date.now();
			await page.waitForTimeout(2000);

			this.timeline.push({
				action: "page-load",
				label: this.config.url,
				startTime: 0,
				endTime: this.now(),
			});
			emit("action-end", "Page loaded", "page-load");

			// --- Open widget ---
			const openStart = this.now();
			emit("action-start", "Opening widget...", "open-widget");
			await toggle.click();

			const panel = widget.locator(".xinfer-panel");
			await panel.waitFor({ state: "visible", timeout: 5000 });
			const input = widget.locator("#xinfer-input");
			await input.waitFor({ state: "visible", timeout: 5000 });
			await page.waitForTimeout(3000);

			this.timeline.push({
				action: "open-widget",
				label: "Open chat widget",
				startTime: openStart,
				endTime: this.now(),
			});
			emit("action-end", "Widget opened", "open-widget");

			// --- Zoom in ---
			const zoomStart = this.now();
			emit("action-start", "Zooming into widget...", "zoom-in");
			await zoomToElement(page, panel);

			this.timeline.push({
				action: "zoom-in",
				label: "Zoom into widget",
				startTime: zoomStart,
				endTime: this.now(),
			});
			emit("action-end", "Zoomed in", "zoom-in");

			// --- Queries ---
			for (let i = 0; i < this.config.queries.length; i++) {
				if (signal?.aborted) throw new Error("Cancelled");
				const query = this.config.queries[i];
				const actionName = `query-${i + 1}`;
				const queryStart = this.now();
				emit("action-start", `Sending: "${query}"`, actionName);

				await sendMessage(page, widget, query);

				// Extra pause after first query for reading
				if (i === 0) {
					await page.waitForTimeout(PAUSE_AFTER_RESPONSE + 3000);
				} else {
					await page.waitForTimeout(PAUSE_AFTER_RESPONSE);
				}

				// Handle contact form when query mentions checkout, follow-up, or contact request
				const triggersForm =
					/check\s*out/i.test(query) ||
					/follow\s*up/i.test(query) ||
					/talk to someone/i.test(query) ||
					/reach out/i.test(query) ||
					/contact/i.test(query) ||
					/call me/i.test(query) ||
					/get in touch/i.test(query) ||
					/schedule|book|appointment/i.test(query) ||
					/speak (to|with)/i.test(query);
				if (triggersForm) {
					const form = panel.locator(".xinfer-followup-form");
					const hasForm = await form
						.waitFor({ state: "visible", timeout: 15_000 })
						.then(() => true)
						.catch(() => false);

					if (hasForm) {
						emit("progress", "Filling contact form...");
						await page.waitForTimeout(1500);

						const nameInput = form.locator(
							'input.xinfer-followup-input[name="name"]',
						);
						const emailInput = form.locator(
							'input.xinfer-followup-input[name="email"]',
						);

						await nameInput.pressSequentially("Demo XInfer", {
							delay: TYPING_DELAY,
						});
						await page.waitForTimeout(500);
						await emailInput.pressSequentially("demo@xinfer.ai", {
							delay: TYPING_DELAY,
						});
						await page.waitForTimeout(800);

						const submitBtn = form.locator(".xinfer-followup-submit");
						await submitBtn.click();
						emit("progress", "Form submitted, waiting for response...");

						// Wait for Suggest button to reappear (30s — form confirmation is quick)
						await waitForResponseDone(page, widget, 30_000);
						emit("progress", "Response complete");

						await page.waitForTimeout(PAUSE_AFTER_RESPONSE);
					}
				}

				this.timeline.push({
					action: actionName,
					label: query,
					startTime: queryStart,
					endTime: this.now(),
				});
				emit("action-end", `Query ${i + 1} complete`, actionName);
			}

			// --- Zoom out ---
			const zoomOutStart = this.now();
			emit("action-start", "Zooming out...", "zoom-out");
			await resetZoom(page, panel);
			await page.waitForTimeout(3000);

			this.timeline.push({
				action: "zoom-out",
				label: "Zoom out to full view",
				startTime: zoomOutStart,
				endTime: this.now(),
			});
			emit("action-end", "Zoomed out", "zoom-out");

			// --- Finalize ---
			emit("progress", "Closing browser to finalize video...");
			await context.close();
			await browser.close();

			// Find the video file playwright created
			const files = fs.readdirSync(dir).filter((f) => f.endsWith(".webm"));
			const videoFile = files[0];
			if (!videoFile) {
				throw new Error("No video file found in recording directory");
			}

			// Rename to raw.webm
			const rawPath = path.join(dir, "raw.webm");
			fs.renameSync(path.join(dir, videoFile), rawPath);

			// Save timeline
			const timelinePath = path.join(dir, "timeline.json");
			fs.writeFileSync(timelinePath, JSON.stringify(this.timeline, null, 2));

			emit("done", `Recording saved to ${dir}`);

			return {
				dir,
				videoPath: rawPath,
				timeline: this.timeline,
			};
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			emit("error", `Recording failed: ${message}`);
			try {
				await context.close();
				await browser.close();
			} catch {
				// ignore cleanup errors
			}
			throw err;
		}
	}
}
