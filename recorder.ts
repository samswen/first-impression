import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { type BrowserContext, chromium, type Page } from "playwright";
import { getPlaywrightProxy } from "./proxy";

const execP = promisify(execFile);

import {
	PAUSE_AFTER_RESPONSE,
	resetZoom,
	sendMessage,
	TYPING_DELAY,
	waitForResponseDone,
	zoomToElement,
} from "./helpers";
import { solveTurnstile } from "./turnstile-solver";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/** Real Chrome user agent — avoids "HeadlessChrome" which triggers Cloudflare. */
const CHROME_USER_AGENT =
	"Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

/** Hide navigator.webdriver from bot detection (Playwright sets it to true). */
async function applyStealthToContext(context: BrowserContext): Promise<void> {
	await context.addInitScript(() => {
		Object.defineProperty(navigator, "webdriver", { get: () => false });
	});
}

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
	response?: string;
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

/**
 * Load a page for snapshotting. Forces all lazy-loaded images to load,
 * scrolls the page to trigger IntersectionObserver-based loading, and
 * handles videos gracefully (pause for clean frame or replace with poster).
 */
async function loadPageForSnapshot(
	page: Page,
	url: string,
	emit: (type: ProgressEvent["type"], message: string) => void,
): Promise<void> {
	// Log failed image requests for diagnostics
	page.on("requestfailed", (req) => {
		if (req.resourceType() === "image") {
			emit(
				"progress",
				`[img-request-fail] ${req.url().slice(0, 120)} -> ${req.failure()?.errorText}`,
			);
		}
	});

	const navResponse = await page.goto(url, {
		waitUntil: "load",
		timeout: 60_000,
	});

	// Check for Cloudflare challenge via response header
	const cfMitigated = navResponse?.headers()["cf-mitigated"];
	if (cfMitigated === "challenge") {
		emit("progress", "Cloudflare challenge detected, attempting to solve...");
		const result = await solveTurnstile(page);
		if (result.solved) {
			emit("progress", "Cloudflare challenge solved, waiting for real page...");
			try {
				await page.waitForLoadState("load", { timeout: 30_000 });
			} catch {
				// timeout
			}
			try {
				await page.waitForLoadState("networkidle", { timeout: 10_000 });
			} catch {
				// Some sites never reach networkidle
			}
		} else {
			emit("progress", `Cloudflare challenge not solved: ${result.error}`);
		}
	}

	// Log initial image status (before any modifications)
	const initialStatus = await page.evaluate(() => {
		return Array.from(document.querySelectorAll("img"))
			.filter((img) => img.offsetWidth > 200 || img.offsetHeight > 200)
			.map((img) => ({
				ok: img.complete && img.naturalWidth > 0,
				size: `${img.offsetWidth}x${img.offsetHeight}`,
				natural: `${img.naturalWidth}x${img.naturalHeight}`,
				top: Math.round(img.getBoundingClientRect().top),
				loading: img.loading,
				src: img.currentSrc?.slice(0, 100) || img.src?.slice(0, 100),
			}));
	});
	for (const s of initialStatus) {
		emit(
			"progress",
			`[img-initial] ${s.ok ? "OK" : "FAIL"} ${s.size} natural=${s.natural} top=${s.top} loading=${s.loading} ${s.src}`,
		);
	}

	// Force lazy-loaded images to load
	await page.evaluate(() => {
		for (const img of document.querySelectorAll("img")) {
			if (img.loading === "lazy") img.loading = "eager";
			const dataSrc =
				img.getAttribute("data-src") || img.getAttribute("data-lazy");
			if (dataSrc && !img.src) img.src = dataSrc;
		}
		for (const el of document.querySelectorAll<HTMLElement>(
			"[data-bg], [data-background-image]",
		)) {
			const bg =
				el.getAttribute("data-bg") ||
				el.getAttribute("data-background-image");
			if (bg && !el.style.backgroundImage) {
				el.style.backgroundImage = `url("${bg}")`;
			}
		}
	});

	// Scroll through the page to trigger IntersectionObserver loaders
	emit("progress", "Scrolling page to trigger lazy-loaded content...");
	const scrollHeight = await page.evaluate(() => document.body.scrollHeight);
	const viewportHeight = 1080;
	for (let y = 0; y < scrollHeight; y += viewportHeight) {
		await page.evaluate((top) => window.scrollTo(0, top), y);
		await page.waitForTimeout(300);
	}
	await page.evaluate(() => window.scrollTo(0, 0));

	// Wait for network to settle
	try {
		await page.waitForLoadState("networkidle", { timeout: 10_000 });
	} catch {
		// Some sites never reach networkidle
	}

	// Wait for all images to finish loading
	await page.evaluate(() => {
		return Promise.all(
			Array.from(document.querySelectorAll("img")).map((img) => {
				if (img.complete) return Promise.resolve();
				return new Promise<void>((resolve) => {
					img.addEventListener("load", () => resolve(), { once: true });
					img.addEventListener("error", () => resolve(), { once: true });
					setTimeout(() => resolve(), 10_000);
				});
			}),
		);
	});

	// Retry failed images: detect naturalWidth === 0 and reload
	const retried = await page.evaluate(() => {
		let count = 0;
		for (const img of document.querySelectorAll("img")) {
			if (img.complete && img.naturalWidth === 0 && img.src) {
				const src = img.src;
				img.removeAttribute("srcset");
				img.src = "";
				img.src = src;
				count++;
			}
		}
		return count;
	});
	if (retried > 0) {
		emit("progress", `Retrying ${retried} failed image(s)...`);
		await page.evaluate(() => {
			return Promise.all(
				Array.from(document.querySelectorAll("img"))
					.filter((img) => !img.complete || img.naturalWidth === 0)
					.map(
						(img) =>
							new Promise<void>((resolve) => {
								img.addEventListener("load", () => resolve(), {
									once: true,
								});
								img.addEventListener("error", () => resolve(), {
									once: true,
								});
								setTimeout(() => resolve(), 10_000);
							}),
					),
			);
		});
	}

	// Final settle time
	await page.waitForTimeout(2000);

	// Log final image status
	const finalStatus = await page.evaluate(() => {
		return Array.from(document.querySelectorAll("img"))
			.filter((img) => img.offsetWidth > 200 || img.offsetHeight > 200)
			.map((img) => ({
				ok: img.complete && img.naturalWidth > 0,
				size: `${img.offsetWidth}x${img.offsetHeight}`,
				natural: `${img.naturalWidth}x${img.naturalHeight}`,
				top: Math.round(img.getBoundingClientRect().top),
			}));
	});
	for (const s of finalStatus) {
		if (!s.ok) {
			emit(
				"progress",
				`[img-final] STILL FAILED ${s.size} natural=${s.natural} top=${s.top}`,
			);
		}
	}

	// Handle videos: pause loaded ones, replace errored/unloaded with poster
	const videoCount = await page.evaluate(
		() => document.querySelectorAll("video").length,
	);
	if (videoCount > 0) {
		await page.evaluate(() => {
			for (const video of document.querySelectorAll("video")) {
				if (video.readyState < 2 && !video.error) {
					video.muted = true;
					video.play().catch(() => {});
				}
			}
		});
		await page.waitForTimeout(3000);

		const fixed = await page.evaluate(() => {
			let count = 0;
			for (const video of document.querySelectorAll("video")) {
				if (video.error || video.readyState < 2) {
					const w = video.offsetWidth;
					const h = video.offsetHeight;
					if (video.poster) {
						const img = document.createElement("img");
						img.src = video.poster;
						img.style.width = w ? `${w}px` : "100%";
						img.style.height = h ? `${h}px` : "auto";
						img.style.objectFit = "cover";
						img.style.display = "block";
						const style = window.getComputedStyle(video);
						if (
							style.position === "absolute" ||
							style.position === "fixed"
						) {
							img.style.position = style.position;
							img.style.top = style.top;
							img.style.left = style.left;
							img.style.right = style.right;
							img.style.bottom = style.bottom;
							img.style.zIndex = style.zIndex;
						}
						video.replaceWith(img);
					} else if (!w || !h) {
						video.remove();
					}
					count++;
				} else {
					video.pause();
					video.controls = false;
				}
			}
			return count;
		});

		if (fixed > 0) {
			emit("progress", `Replaced ${fixed} errored/unloaded video(s)`);
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
			// Retry once on failure (network/proxy can be flaky)
			let snapshotOk = false;
			for (let attempt = 1; attempt <= 2 && !snapshotOk; attempt++) {
				if (attempt > 1) {
					emit("progress", `Snapshot retry (attempt ${attempt})...`);
				}
				const snapBrowser = await chromium.launch({
					headless: true,
					proxy: await getPlaywrightProxy(),
				});

				try {
					const snapContext = await snapBrowser.newContext({
						viewport: { width: 1920, height: 1080 },
						ignoreHTTPSErrors: true,
						userAgent: CHROME_USER_AGENT,
					});
					await applyStealthToContext(snapContext);
					const snapPage = await snapContext.newPage();
					await loadPageForSnapshot(snapPage, this.config.url, emit);

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
						userAgent: CHROME_USER_AGENT,
					});
					await applyStealthToContext(mobileContext);
					const mobilePage = await mobileContext.newPage();
					await loadPageForSnapshot(mobilePage, this.config.url, emit);

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
						`Could not reach ${this.config.url} (${msg})${attempt < 2 ? ", retrying..." : ""}`,
					);
				}

				await snapBrowser.close();
			}

			// If snapshot still failed, try to reuse one from a previous recording
			const snapshotPath = path.join(dir, "snapshot.png");
			if (!snapshotOk) {
				const parentDir = path.dirname(dir);
				const siblings = fs.existsSync(parentDir)
					? fs
							.readdirSync(parentDir)
							.filter((d) => d !== path.basename(dir))
							.sort()
							.reverse()
					: [];
				for (const sibling of siblings) {
					const prevSnapshot = path.join(parentDir, sibling, "snapshot.png");
					if (fs.existsSync(prevSnapshot)) {
						fs.copyFileSync(prevSnapshot, snapshotPath);
						const prevMobile = path.join(
							parentDir,
							sibling,
							"snapshot-mobile.png",
						);
						if (fs.existsSync(prevMobile)) {
							fs.copyFileSync(
								prevMobile,
								path.join(dir, "snapshot-mobile.png"),
							);
						}
						snapshotOk = true;
						emit("progress", "Using snapshot from previous recording");
						break;
					}
				}
				if (!snapshotOk) {
					emit(
						"progress",
						"No previous snapshot available, using blank background...",
					);
				}
			} else {
				emit("progress", "Snapshot taken, building local page...");
			}

			// Build background style: screenshot if available, plain gradient if not
			let bgStyle: string;
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
			proxy: await getPlaywrightProxy(),
		});
		const context = await browser.newContext({
			viewport: { width: 1920, height: 1080 },
			recordVideo: {
				dir,
				size: { width: 1920, height: 1080 },
			},
			ignoreHTTPSErrors: true,
			userAgent: CHROME_USER_AGENT,
		});
		await applyStealthToContext(context);

		const page = await context.newPage();

		try {
			// --- Page load ---
			emit("action-start", `Loading ${this.config.url}`, "page-load");
			const recNavResponse = await page.goto(navigateUrl, {
				waitUntil: "domcontentloaded",
				timeout: 60_000,
			});

			// Check for Cloudflare challenge via response header
			if (!navigateUrl.startsWith("file://")) {
				const recCfMitigated = recNavResponse?.headers()["cf-mitigated"];
				if (recCfMitigated === "challenge") {
					emit("progress", "Cloudflare challenge detected, solving...");
					const cfResult = await solveTurnstile(page);
					if (cfResult.solved) {
						emit(
							"progress",
							"Cloudflare challenge solved, waiting for real page...",
						);
						try {
							await page.waitForLoadState("networkidle", {
								timeout: 10_000,
							});
						} catch {
							// Some sites never reach networkidle
						}
					} else {
						emit(
							"progress",
							`Warning: Cloudflare challenge not solved: ${cfResult.error}`,
						);
					}
				}
			}

			const widget = page.locator("#xinfer-chat-widget");
			await widget.waitFor({ state: "attached", timeout: 30_000 });
			const toggle = widget.locator(".xinfer-toggle");
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
			let formSubmitted = false;
			for (let i = 0; i < this.config.queries.length; i++) {
				if (signal?.aborted) throw new Error("Cancelled");
				const query = this.config.queries[i];
				const actionName = `query-${i + 1}`;
				const queryStart = this.now();
				emit("action-start", `Sending: "${query}"`, actionName);

				await sendMessage(page, widget, query, {
					skipWaitBefore: i === 0,
				});

				// Extract AI response text from the last assistant bubble
				const responseText = await widget
					.locator(".chat-bubble-assistant")
					.last()
					.textContent()
					.catch(() => null);

				await page.waitForTimeout(PAUSE_AFTER_RESPONSE);

				// Handle contact form — check after every response since the agent
				// can request contact info for any query, not just predictable ones.
				// Only fill once per session; the form may linger in the DOM after submission.
				if (!formSubmitted) {
					const form = panel.locator(".chat-followup-form");
					const hasForm = await form
						.waitFor({ state: "visible", timeout: 3_000 })
						.then(() => true)
						.catch(() => false);

					if (hasForm) {
						emit("progress", "Filling contact form...");

						// Scroll the form into view so it's visible in the zoomed panel
						await form.evaluate((el) => {
							el.scrollIntoView({ behavior: "smooth", block: "center" });
						});
						await page.waitForTimeout(1500);

						const nameInput = form.locator(
							'input.chat-followup-input[name="name"]',
						);
						const emailInput = form.locator(
							'input.chat-followup-input[name="email"]',
						);

						await nameInput.pressSequentially("Demo XInfer", {
							delay: TYPING_DELAY,
						});
						await page.waitForTimeout(500);
						await emailInput.pressSequentially("demo@xinfer.ai", {
							delay: TYPING_DELAY,
						});
						await page.waitForTimeout(800);

						const submitBtn = form.locator(".chat-followup-submit");
						await submitBtn.click();
						emit("progress", "Form submitted, waiting for response...");

						// Wait for Suggest button to reappear (30s — form confirmation is quick)
						await waitForResponseDone(page, widget, 30_000);
						emit("progress", "Response complete");

						await page.waitForTimeout(PAUSE_AFTER_RESPONSE);
						formSubmitted = true;
					}
				}

				this.timeline.push({
					action: actionName,
					label: query,
					startTime: queryStart,
					endTime: this.now(),
					response: responseText?.trim() || undefined,
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

			// Rename to raw.webm and re-encode VP8→VP9 for consistent codec
			const rawPath = path.join(dir, "raw.webm");
			fs.renameSync(path.join(dir, videoFile), rawPath);

			emit("progress", "Re-encoding to VP9...");
			const vp9TmpPath = path.join(dir, "raw-vp9.webm");
			await execP(
				"ffmpeg",
				[
					"-i",
					rawPath,
					"-c:v",
					"libvpx-vp9",
					"-b:v",
					"2M",
					"-cpu-used",
					"4",
					"-pix_fmt",
					"yuv420p",
					"-c:a",
					"libopus",
					"-y",
					vp9TmpPath,
				],
				{ timeout: 5 * 60 * 1000, maxBuffer: 10 * 1024 * 1024 },
			);
			fs.renameSync(vp9TmpPath, rawPath);

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
