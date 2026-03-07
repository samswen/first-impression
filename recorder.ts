import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import {
	PAUSE_AFTER_RESPONSE,
	resetZoom,
	sendMessage,
	TYPING_DELAY,
	zoomToElement,
} from "./helpers";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export interface RecordingConfig {
	url: string;
	queries: string[];
	headed: boolean;
	recordingDir?: string;
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

		emit("progress", "Launching browser...");
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
		this.recordingStart = Date.now();

		try {
			// --- Page load ---
			const loadStart = this.now();
			emit("action-start", `Navigating to ${this.config.url}`, "page-load");
			await page.goto(this.config.url, {
				waitUntil: "domcontentloaded",
				timeout: 60_000,
			});

			const widget = page.locator("#xinfer-chat-widget");
			await widget.waitFor({ state: "attached", timeout: 30_000 });
			const toggle = widget.locator("button.xinfer-toggle");
			await toggle.waitFor({ state: "visible", timeout: 10_000 });
			await page.waitForTimeout(2000);

			this.timeline.push({
				action: "page-load",
				label: this.config.url,
				startTime: loadStart,
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

				// Handle checkout form on the last query if it triggers one
				if (i === this.config.queries.length - 1) {
					const form = panel.locator(".xinfer-followup-form");
					const hasForm = await form
						.waitFor({ state: "visible", timeout: 5000 })
						.then(() => true)
						.catch(() => false);

					if (hasForm) {
						emit("progress", "Filling checkout form...");
						await page.waitForTimeout(1500);

						const nameInput = form.locator('input[name="name"]');
						const emailInput = form.locator('input[name="email"]');

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
						emit("progress", "Form submitted, waiting for confirmation...");

						try {
							await page
								.locator("text=/Order (#|Number)/i")
								.first()
								.waitFor({ state: "visible", timeout: 60_000 });
							emit("progress", "Order confirmation visible");
						} catch {
							emit("progress", "Order confirmation not matched, continuing...");
						}

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
