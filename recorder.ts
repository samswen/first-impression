import { type ChildProcess, execFile, spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { type BrowserContext, chromium, type Page } from "playwright";
import { getPlaywrightProxy } from "./proxy";

const execP = promisify(execFile);

import {
	MIN_OPEN_WIDGET_DURATION,
	MIN_QUERY_DURATION,
	MIN_QUERY_WITH_FORM_DURATION,
	PAUSE_AFTER_RESPONSE,
	PAUSE_AFTER_TYPE,
	ZOOM_SETTLE_DURATION,
	flashMarker,
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
	sendTime?: number;
	responseEndTime?: number;
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
	diagDir?: string,
	diagFile = "snapshot-diag.log",
): Promise<{ totalImages: number; loadedImages: number }> {
	// Collect diagnostic lines — written to file at end for spot instances
	const diag: string[] = [];
	const log = (msg: string) => {
		diag.push(`[${new Date().toISOString()}] ${msg}`);
		emit("progress", msg);
	};

	// Log failed requests for diagnostics (images + critical resources)
	page.on("requestfailed", (req) => {
		const type = req.resourceType();
		if (type === "image" || type === "stylesheet" || type === "script") {
			log(
				`[request-fail] ${type} ${req.url().slice(0, 120)} -> ${req.failure()?.errorText}`,
			);
		}
	});

	// Bypass proxy for third-party video/media requests.
	// The proxy is needed for the page domain (CF challenge cookies are IP-bound),
	// but CDN-hosted videos on different domains don't need it — and residential
	// proxies often can't handle video streaming.
	const pageDomain = new URL(url).hostname;
	await page.route("**/*", async (route) => {
		const req = route.request();
		if (req.resourceType() !== "media") return route.fallback();
		let reqDomain: string;
		try {
			reqDomain = new URL(req.url()).hostname;
		} catch {
			return route.fallback();
		}
		if (reqDomain === pageDomain) return route.fallback();
		// Third-party media — fetch directly (bypassing proxy)
		try {
			const res = await fetch(req.url(), {
				headers: { Range: req.headers().range || "" },
			});
			const body = Buffer.from(await res.arrayBuffer());
			const headers: Record<string, string> = {};
			for (const [k, v] of res.headers) headers[k] = v;
			await route.fulfill({
				status: res.status,
				headers,
				body,
			});
		} catch {
			return route.fallback();
		}
	});

	const loadStart = Date.now();
	const navResponse = await page.goto(url, {
		waitUntil: "load",
		timeout: 60_000,
	});
	const loadDuration = ((Date.now() - loadStart) / 1000).toFixed(1);

	// Check for Cloudflare challenge via response header
	const cfMitigated = navResponse?.headers()["cf-mitigated"];
	log(
		`[nav] status=${navResponse?.status() ?? "?"} cf-mitigated=${cfMitigated || "none"} load=${loadDuration}s url=${page.url().slice(0, 120)}`,
	);
	// Wait for JS frameworks to hydrate, carousels to init, animations to fire
	if (cfMitigated !== "challenge") {
		try {
			await page.waitForLoadState("networkidle", { timeout: 10_000 });
		} catch {
			// Some sites never reach networkidle
		}
	}

	if (cfMitigated === "challenge") {
		log("Cloudflare challenge detected, attempting to solve...");
		const solveStart = Date.now();
		const result = await solveTurnstile(page);
		const solveDuration = ((Date.now() - solveStart) / 1000).toFixed(1);
		if (result.solved) {
			log(
				`[cf-solve] OK in ${solveDuration}s (${result.attempts} attempt${result.attempts !== 1 ? "s" : ""})`,
			);

			// Check cf_clearance cookie was set
			const cookies = await page.context().cookies();
			const clearance = cookies.find((c) => c.name === "cf_clearance");
			log(
				`[cf-cookie] cf_clearance=${clearance ? `set (domain=${clearance.domain})` : "MISSING"}`,
			);

			// After challenge solve the browser has the cf_clearance cookie, but
			// images requested during the challenge page may have cached failures.
			// A full reload ensures all resources are fetched cleanly.
			log("[cf-reload] Reloading page for fresh resources...");
			let reloadResponse: Awaited<ReturnType<typeof page.reload>> = null;
			try {
				reloadResponse = await page.reload({
					waitUntil: "load",
					timeout: 30_000,
				});
			} catch {
				log("[cf-reload] Timed out waiting for load");
			}
			const reloadCf = reloadResponse?.headers()["cf-mitigated"];
			log(
				`[cf-reload] status=${reloadResponse?.status() ?? "?"} cf-mitigated=${reloadCf || "none"} url=${page.url().slice(0, 120)}`,
			);

			try {
				await page.waitForLoadState("networkidle", { timeout: 10_000 });
			} catch {
				// Some sites never reach networkidle
			}
		} else {
			log(
				`[cf-solve] FAILED in ${solveDuration}s (${result.attempts} attempt${result.attempts !== 1 ? "s" : ""}): ${result.error}`,
			);
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
		log(
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
				el.getAttribute("data-bg") || el.getAttribute("data-background-image");
			if (bg && !el.style.backgroundImage) {
				el.style.backgroundImage = `url("${bg}")`;
			}
		}
	});

	// Scroll through the page to trigger IntersectionObserver loaders
	log("Scrolling page to trigger lazy-loaded content...");
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

	// Multi-round retry for failed images
	for (let round = 1; round <= 3; round++) {
		const failed = await page.evaluate(() => {
			return Array.from(document.querySelectorAll("img"))
				.filter((img) => img.complete && img.naturalWidth === 0 && img.src)
				.map((img) => img.src.slice(0, 120));
		});
		if (failed.length === 0) break;

		log(
			`[img-retry] round ${round}/3: ${failed.length} failed image(s), strategy=${round === 1 ? "strip-srcset" : round === 2 ? "replace-element" : "cache-buster"}`,
		);
		for (const src of failed.slice(0, 5)) {
			log(`[img-retry]   ${src}`);
		}

		if (round === 1) {
			// Strip srcset and reload src
			await page.evaluate(() => {
				for (const img of document.querySelectorAll("img")) {
					if (img.complete && img.naturalWidth === 0 && img.src) {
						const src = img.src;
						img.removeAttribute("srcset");
						img.src = "";
						img.src = src;
					}
				}
			});
		} else if (round === 2) {
			// Replace <img> element entirely (fresh element, no cached error state)
			await page.evaluate(() => {
				for (const img of document.querySelectorAll("img")) {
					if (img.complete && img.naturalWidth === 0 && img.src) {
						const fresh = document.createElement("img");
						for (const attr of img.attributes) {
							if (attr.name !== "srcset") {
								fresh.setAttribute(attr.name, attr.value);
							}
						}
						fresh.style.cssText = img.style.cssText;
						img.replaceWith(fresh);
					}
				}
			});
		} else {
			// Add cache-buster query param to src URL
			await page.evaluate(() => {
				for (const img of document.querySelectorAll("img")) {
					if (img.complete && img.naturalWidth === 0 && img.src) {
						const url = new URL(img.src);
						url.searchParams.set("_cb", Date.now().toString());
						img.removeAttribute("srcset");
						img.src = url.toString();
					}
				}
			});
		}

		// Wait for retried images to settle
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

		// Log how many recovered after this round
		const stillFailed = await page.evaluate(() => {
			return Array.from(document.querySelectorAll("img")).filter(
				(img) => img.complete && img.naturalWidth === 0 && img.src,
			).length;
		});
		log(
			`[img-retry] round ${round} done: ${failed.length - stillFailed} recovered, ${stillFailed} still failed`,
		);
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
				src: img.currentSrc?.slice(0, 100) || img.src?.slice(0, 100),
			}));
	});
	for (const s of finalStatus) {
		log(
			`[img-final] ${s.ok ? "OK" : "FAIL"} ${s.size} natural=${s.natural} top=${s.top} ${s.src}`,
		);
	}

	// Handle videos: pause loaded ones, replace errored/unloaded with poster or frame capture
	const videoCount = await page.evaluate(
		() => document.querySelectorAll("video").length,
	);
	if (videoCount > 0) {
		log(`Found ${videoCount} video(s), attempting to render...`);

		// Log details for each video
		const videoDetails = await page.evaluate(() =>
			Array.from(document.querySelectorAll("video")).map((v, i) => ({
				index: i,
				src: v.currentSrc?.slice(0, 120) || v.src?.slice(0, 120) || "(none)",
				poster: v.poster?.slice(0, 120) || "(none)",
				readyState: v.readyState,
				error: v.error?.message || null,
				size: `${v.offsetWidth}x${v.offsetHeight}`,
				autoplay: v.autoplay,
				muted: v.muted,
				preload: v.preload,
			})),
		);
		for (const v of videoDetails) {
			log(
				`[video] #${v.index} ready=${v.readyState} err=${v.error ?? "none"} ${v.size} preload=${v.preload} poster=${v.poster} src=${v.src}`,
			);
		}

		// Force preload=auto and muted before playing — some sites lazy-load videos
		// or use preload=none/metadata which prevents buffering
		await page.evaluate(() => {
			for (const video of document.querySelectorAll("video")) {
				if (video.readyState < 2 && !video.error) {
					video.preload = "auto";
					video.muted = true;
					video.play().catch(() => {});
				}
			}
		});
		await page.waitForTimeout(5000);

		// Retry videos still buffering: reload + play again
		const needsRetry = await page.evaluate(
			() =>
				Array.from(document.querySelectorAll("video")).filter(
					(v) => !v.error && v.readyState < 2,
				).length,
		);
		if (needsRetry > 0) {
			log(`[video-retry] ${needsRetry} video(s) still buffering, retrying...`);
			await page.evaluate(() => {
				for (const video of document.querySelectorAll("video")) {
					if (!video.error && video.readyState < 2) {
						video.load();
						video.muted = true;
						video.play().catch(() => {});
					}
				}
			});
			await page.waitForTimeout(5000);
		}

		// Log post-wait state
		const postWaitDetails = await page.evaluate(() =>
			Array.from(document.querySelectorAll("video")).map((v, i) => ({
				index: i,
				readyState: v.readyState,
				error: v.error?.message || null,
				currentTime: v.currentTime,
				buffered: v.buffered.length > 0 ? v.buffered.end(0) : 0,
			})),
		);
		for (const v of postWaitDetails) {
			log(
				`[video-post] #${v.index} ready=${v.readyState} err=${v.error ?? "none"} time=${v.currentTime.toFixed(1)}s buffered=${v.buffered.toFixed(1)}s`,
			);
		}

		// Detect black/blank poster images by checking file size from Node.js
		// (CORS blocks canvas pixel reads for cross-origin poster images in the browser).
		// A 1920w JPEG under 25KB is almost certainly a solid black or blank frame.
		const blackPosterUrls = new Set<string>();
		for (const v of postWaitDetails) {
			if (v.readyState >= 2) continue;
			const detail = videoDetails[v.index];
			if (!detail?.poster || detail.poster === "(none)") continue;
			try {
				const headRes = await fetch(detail.poster, { method: "HEAD" });
				const size = Number(headRes.headers.get("content-length") || 0);
				if (headRes.ok && size > 0 && size < 25000) {
					blackPosterUrls.add(detail.poster);
					log(`[video] poster #${v.index} is likely black (${size} bytes)`);
				}
			} catch {
				// ignore fetch errors
			}
		}
		const blackPosterList = [...blackPosterUrls];

		// NOTE: No named function expressions inside page.evaluate —
		// esbuild adds __name() decorators that don't exist in the browser context.
		const fixResults = await page.evaluate((blackPosters: string[]) => {
			const results: string[] = [];
			const blackSet = new Set(blackPosters);

			for (const video of document.querySelectorAll("video")) {
				if (video.error || video.readyState < 2) {
					const w = video.offsetWidth;
					const h = video.offsetHeight;
					const posterIsBlack = video.poster
						? blackSet.has(video.poster)
						: false;

					if (video.poster && !posterIsBlack) {
						// Replace with poster image (only if poster is not black)
						const img = document.createElement("img");
						img.src = video.poster;
						img.style.width = w ? `${w}px` : "100%";
						img.style.height = h ? `${h}px` : "auto";
						img.style.objectFit = "cover";
						img.style.display = "block";
						const cs = window.getComputedStyle(video);
						if (cs.position === "absolute" || cs.position === "fixed") {
							img.style.position = cs.position;
							img.style.top = cs.top;
							img.style.left = cs.left;
							img.style.right = cs.right;
							img.style.bottom = cs.bottom;
							img.style.zIndex = cs.zIndex;
						}
						video.replaceWith(img);
						results.push(`poster-replace ${w}x${h}`);
					} else if (w && h && video.readyState >= 1) {
						// Has metadata — try canvas capture of current frame
						let captured = false;
						try {
							const canvas = document.createElement("canvas");
							canvas.width = video.videoWidth || w;
							canvas.height = video.videoHeight || h;
							const ctx = canvas.getContext("2d");
							if (ctx) {
								ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
								const px = ctx.getImageData(
									0,
									0,
									canvas.width,
									canvas.height,
								).data;
								let brightness = 0;
								for (let i = 0; i < px.length; i += 400) {
									brightness += px[i] + px[i + 1] + px[i + 2];
								}
								if (brightness / (Math.ceil(px.length / 400) * 3) > 10) {
									const dataUrl = canvas.toDataURL("image/jpeg", 0.85);
									const img = document.createElement("img");
									img.src = dataUrl;
									img.style.width = `${w}px`;
									img.style.height = `${h}px`;
									img.style.objectFit = "cover";
									img.style.display = "block";
									const cs = window.getComputedStyle(video);
									if (cs.position === "absolute" || cs.position === "fixed") {
										img.style.position = cs.position;
										img.style.top = cs.top;
										img.style.left = cs.left;
										img.style.right = cs.right;
										img.style.bottom = cs.bottom;
										img.style.zIndex = cs.zIndex;
									}
									video.replaceWith(img);
									results.push(`canvas-capture ${w}x${h}`);
									captured = true;
								}
							}
						} catch {
							// Canvas capture failed (e.g. tainted by CORS)
						}
						if (!captured) {
							video.style.visibility = "hidden";
							results.push(`hidden (black-frame) ${w}x${h}`);
						}
					} else if (!w || !h) {
						video.remove();
						results.push("removed (no-dimensions)");
					} else {
						video.style.visibility = "hidden";
						results.push(
							`hidden (${video.poster ? "black-poster" : "no-poster"}) ${w}x${h}`,
						);
					}
				} else {
					video.pause();
					video.controls = false;
					results.push(`paused ${video.offsetWidth}x${video.offsetHeight}`);
				}
			}
			return results;
		}, blackPosterList);

		for (const r of fixResults) {
			log(`[video-fix] ${r}`);
		}
	}

	// Force visibility of CSS-hidden loaded images (e.g. carousel reveal animations)
	// Many sites use JS-driven carousels/reveal patterns that set images to opacity:0
	// and animate them in. In headless browsers the animation may never trigger.
	const cssFixed = await page.evaluate(() => {
		const fixes: string[] = [];
		for (const img of document.querySelectorAll<HTMLImageElement>("img")) {
			if (!img.complete || img.naturalWidth === 0) continue;
			const rect = img.getBoundingClientRect();
			if (rect.width < 200 && rect.height < 200) continue;
			if (rect.top > 1200) continue;

			let node: HTMLElement | null = img;
			for (let depth = 0; depth < 6 && node; depth++) {
				const cs = window.getComputedStyle(node);
				if (parseFloat(cs.opacity) < 0.1) {
					node.style.setProperty("opacity", "1", "important");
					const tag = node.tagName.toLowerCase();
					const cls = node.className?.toString().slice(0, 60) || "";
					fixes.push(`opacity→1 <${tag}> ${cls}`);
				}
				if (cs.visibility === "hidden") {
					node.style.setProperty("visibility", "visible", "important");
					fixes.push(`visibility→visible <${node.tagName.toLowerCase()}>`);
				}
				node = node.parentElement;
			}
		}
		return fixes;
	});
	if (cssFixed.length > 0) {
		for (const fix of cssFixed) {
			log(`[css-fix] ${fix}`);
		}
	}

	// Compute image load stats (only significant images, >200px in any dimension)
	const imageStats = await page.evaluate(() => {
		const imgs = Array.from(document.querySelectorAll("img")).filter(
			(img) => img.offsetWidth > 200 || img.offsetHeight > 200,
		);
		return {
			totalImages: imgs.length,
			loadedImages: imgs.filter((img) => img.complete && img.naturalWidth > 0)
				.length,
		};
	});
	const totalDuration = ((Date.now() - loadStart) / 1000).toFixed(1);
	log(
		`[img-stats] ${imageStats.loadedImages}/${imageStats.totalImages} significant images loaded (total=${totalDuration}s)`,
	);

	// Write diagnostics to file in recording directory
	if (diagDir) {
		try {
			fs.writeFileSync(path.join(diagDir, diagFile), diag.join("\n") + "\n");
		} catch {
			// non-fatal
		}
	}

	return imageStats;
}

interface MarkerResult {
	markers: number[];
	diag: string;
}

/**
 * Scan the bottom-left corner of a video for bright-green marker flashes.
 * Returns an array of video timestamps (seconds) where markers were detected,
 * plus a diagnostic string for logging.
 *
 * How it works: extract the bottom-left 8×8 pixel crop as raw RGB, then
 * scan each frame for high average green. Consecutive green frames are
 * grouped; the midpoint of each group is reported as the marker time.
 */
async function detectMarkers(
	videoPath: string,
	fps = 30,
): Promise<MarkerResult> {
	const CROP_W = 8;
	const CROP_H = 8;
	const FRAME_BYTES = CROP_W * CROP_H * 3; // 192 bytes per frame
	const GREEN_THRESHOLD = 120;

	// Get frame rate from video
	const { stdout } = await execP(
		"ffprobe",
		["-v", "error", "-select_streams", "v:0",
			"-show_entries", "stream=r_frame_rate",
			"-of", "csv=p=0", videoPath],
	);
	const [num, den] = stdout.trim().split("/").map(Number);
	const detectedFps = den ? num / den : fps;

	// Also get video dimensions for diagnostics
	const { stdout: dimStr } = await execP(
		"ffprobe",
		["-v", "error", "-select_streams", "v:0",
			"-show_entries", "stream=width,height",
			"-of", "csv=p=0", videoPath],
	);
	const [vidW, vidH] = dimStr.trim().split(",").map(Number);
	// Marker is at bottom-left — crop the bottom 8 rows
	const cropY = vidH - CROP_H;

	return new Promise((resolve, reject) => {
		const stderrChunks: Buffer[] = [];
		const ffmpeg = spawn("ffmpeg", [
			"-i", videoPath,
			"-vf", `crop=${CROP_W}:${CROP_H}:0:${cropY}`,
			"-pix_fmt", "rgb24",
			"-f", "rawvideo",
			"pipe:1",
		], { stdio: ["ignore", "pipe", "pipe"] });

		const chunks: Buffer[] = [];
		ffmpeg.stdout.on("data", (chunk: Buffer) => chunks.push(chunk));
		ffmpeg.stderr.on("data", (chunk: Buffer) => stderrChunks.push(chunk));
		ffmpeg.on("error", reject);
		ffmpeg.on("close", (code) => {
			const stderr = Buffer.concat(stderrChunks).toString().slice(-500);
			if (code !== 0) {
				reject(new Error(`ffmpeg marker detection exit ${code}: ${stderr}`));
				return;
			}

			const raw = Buffer.concat(chunks);
			const totalFrames = Math.floor(raw.length / FRAME_BYTES);

			// Build diagnostics
			const diagLines: string[] = [
				`video=${vidW}x${vidH} fps=${detectedFps.toFixed(1)} cropY=${cropY}`,
				`rawBytes=${raw.length} frames=${totalFrames}`,
			];

			// Log peak green values across all frames for debugging
			let peakGreen = 0;
			let peakFrame = 0;

			// Scan for green spikes
			const markers: number[] = [];
			let inMarker = false;
			let groupStart = 0;

			for (let f = 0; f < totalFrames; f++) {
				const offset = f * FRAME_BYTES;
				let greenSum = 0;
				let redSum = 0;
				let blueSum = 0;
				const pixels = CROP_W * CROP_H;

				for (let p = 0; p < pixels; p++) {
					redSum += raw[offset + p * 3];
					greenSum += raw[offset + p * 3 + 1];
					blueSum += raw[offset + p * 3 + 2];
				}

				const avgGreen = greenSum / pixels;
				const avgRed = redSum / pixels;
				const avgBlue = blueSum / pixels;

				if (avgGreen > peakGreen) {
					peakGreen = avgGreen;
					peakFrame = f;
				}

				// Detect bright green: high green channel, low red and blue
				const isGreen =
					avgGreen > GREEN_THRESHOLD &&
					avgGreen > avgRed * 1.5 &&
					avgGreen > avgBlue * 1.5;

				if (isGreen && !inMarker) {
					inMarker = true;
					groupStart = f;
				} else if (!isGreen && inMarker) {
					inMarker = false;
					const midFrame = (groupStart + f - 1) / 2;
					markers.push(midFrame / detectedFps);
				}
			}

			// Handle marker at the very end of video
			if (inMarker) {
				const midFrame = (groupStart + totalFrames - 1) / 2;
				markers.push(midFrame / detectedFps);
			}

			// Sample the peak frame for diagnostics
			if (totalFrames > 0) {
				const off = peakFrame * FRAME_BYTES;
				const pixels = CROP_W * CROP_H;
				let r = 0;
				let g = 0;
				let b = 0;
				for (let p = 0; p < pixels; p++) {
					r += raw[off + p * 3];
					g += raw[off + p * 3 + 1];
					b += raw[off + p * 3 + 2];
				}
				diagLines.push(
					`peakFrame=${peakFrame} (${(peakFrame / detectedFps).toFixed(1)}s) avgRGB=${(r / pixels).toFixed(0)},${(g / pixels).toFixed(0)},${(b / pixels).toFixed(0)}`,
				);
			}

			resolve({ markers, diag: diagLines.join(" | ") });
		});
	});
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
			const snapshotPath = path.join(dir, "snapshot.png");
			const snapshotMobilePath = path.join(dir, "snapshot-mobile.png");

			// Reuse existing snapshots if both desktop and mobile are already present
			let snapshotOk =
				fs.existsSync(snapshotPath) && fs.existsSync(snapshotMobilePath);
			if (snapshotOk) {
				emit("progress", "Reusing existing snapshots");
			}

			if (!snapshotOk) {
				emit("progress", `Taking snapshot of ${this.config.url}...`);
			}

			// Retry up to 3 times on failure or degraded image quality
			const maxSnapshotAttempts = 3;
			for (
				let attempt = 1;
				attempt <= maxSnapshotAttempts && !snapshotOk;
				attempt++
			) {
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
					const desktopStats = await loadPageForSnapshot(
						snapPage,
						this.config.url,
						emit,
						dir,
						"snapshot-diag.log",
					);

					// Desktop screenshot
					await snapPage.screenshot({
						path: path.join(dir, "snapshot.png"),
						fullPage: false,
					});

					// Mobile screenshot — resize the same page instead of a second load
					await snapPage.setViewportSize({ width: 390, height: 844 });
					await snapPage.waitForTimeout(1500);
					await snapPage.screenshot({
						path: path.join(dir, "snapshot-mobile.png"),
						fullPage: false,
					});
					await snapContext.close();

					// Check image load quality — retry if less than half loaded
					const { totalImages, loadedImages } = desktopStats;
					const ratio = totalImages === 0 ? 1 : loadedImages / totalImages;
					if (ratio < 0.5 && attempt < maxSnapshotAttempts) {
						emit(
							"progress",
							`Only ${loadedImages}/${totalImages} images loaded (${Math.round(ratio * 100)}%), retrying...`,
						);
					} else {
						if (ratio < 0.5) {
							emit(
								"progress",
								`Accepting snapshot with ${loadedImages}/${totalImages} images after ${attempt} attempts`,
							);
						}
						snapshotOk = true;
					}
				} catch (snapErr) {
					const msg =
						snapErr instanceof Error ? snapErr.message : String(snapErr);
					emit(
						"progress",
						`Could not reach ${this.config.url} (${msg})${attempt < maxSnapshotAttempts ? ", retrying..." : ""}`,
					);
				}

				await snapBrowser.close();
			}

			// If snapshot still failed, try to reuse one from a previous recording
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

		// Both platforms use ffmpeg screen capture at 30fps CFR:
		// - Linux: Xvfb virtual display + x11grab
		// - macOS: avfoundation screen capture
		// This replaces Playwright's VFR recorder which compresses idle frames,
		// causing video duration to diverge from wall-clock time.
		const isLinux = process.platform === "linux";
		const DISPLAY = ":99";
		let xvfbProc: ChildProcess | null = null;
		let ffmpegProc: ChildProcess | null = null;
		const rawPath = path.join(dir, "raw.webm");

		if (isLinux) {
			// Start Xvfb if not already running
			try {
				await execP("xdpyinfo", ["-display", DISPLAY]);
				emit("progress", `Xvfb already running on ${DISPLAY}`);
			} catch {
				xvfbProc = spawn(
					"Xvfb",
					// Use taller display to accommodate browser chrome (title + address bar)
					// We'll crop to 1920x1080 in post-processing
					[DISPLAY, "-screen", "0", "1920x1200x24", "-ac"],
					{ stdio: "ignore", detached: true },
				);
				xvfbProc.unref();
				// Wait for Xvfb to be ready
				for (let i = 0; i < 20; i++) {
					try {
						await execP("xdpyinfo", ["-display", DISPLAY]);
						break;
					} catch {
						await new Promise((r) => setTimeout(r, 250));
					}
				}
				emit("progress", `Xvfb started on ${DISPLAY}`);
			}
			process.env.DISPLAY = DISPLAY;
		}

		const browser = await chromium.launch({
			headless: false, // Always headed — ffmpeg captures the visible window
			proxy: await getPlaywrightProxy(),
			args: [
				"--disable-infobars",
				"--window-position=0,0",
				"--window-size=1920,1200",
			],
		});
		const context = await browser.newContext({
			viewport: { width: 1920, height: 1080 },
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

			// Start ffmpeg AFTER the page is rendered and widget is visible,
			// so the recording doesn't begin with a blank screen.
			{
				const ffmpegLog = path.join(dir, "ffmpeg-capture.log");
				const ffmpegLogFd = fs.openSync(ffmpegLog, "w");

				if (isLinux) {
					// Dynamically measure chrome height (tab bar + address bar)
					// so the crop exactly aligns the CSS viewport to the video frame.
					const chromeHeight = await page.evaluate(
						() => window.outerHeight - window.innerHeight,
					);
					emit("progress", `x11grab: chromeHeight=${chromeHeight}`);
					ffmpegProc = spawn("ffmpeg", [
						"-f", "x11grab",
						"-framerate", "30",
						"-draw_mouse", "0",
						"-probesize", "128M",
						"-thread_queue_size", "1024",
						"-video_size", `1920x${1080 + chromeHeight}`,
						"-i", DISPLAY,
						"-vf", `crop=1920:1080:0:${chromeHeight}`,
						"-c:v", "libvpx-vp9",
						"-b:v", "2M",
						"-cpu-used", "4",
						"-threads", "4",
						"-pix_fmt", "yuv420p",
						"-y",
						rawPath,
					], { stdio: ["pipe", "ignore", ffmpegLogFd] });
				} else {
					// macOS: avfoundation screen capture
					// Dynamically find "Capture screen 0" device index
					// (varies when iPhones/external cameras are connected)
					let screenDeviceIndex = "3";
					try {
						const devResult = await execP("ffmpeg", [
							"-f", "avfoundation",
							"-list_devices", "true",
							"-i", "",
						]).catch((e: any) => ({ stdout: "", stderr: e.stderr || "" }));
						const match = devResult.stderr.match(/\[(\d+)\] Capture screen 0/);
						if (match) {
							screenDeviceIndex = match[1];
						}
						emit("progress", `avfoundation: screen device index=${screenDeviceIndex}`);
					} catch {
						emit("progress", `avfoundation: device detection failed, using index ${screenDeviceIndex}`);
					}

					// Measure browser chrome height and Retina pixel ratio
					const dpr = await page.evaluate(() => window.devicePixelRatio) || 1;
					const chromeH = await page.evaluate(
						() => window.outerHeight - window.innerHeight,
					);
					const screenY = await page.evaluate(() => window.screenY);
					const screenH = await page.evaluate(
						() => window.screen.height,
					);
					const contentTop = Math.round((screenY + chromeH) * dpr);
					const screenPixH = Math.round(screenH * dpr);
					// Clip crop height to available screen space
					const cropH = Math.min(
						Math.round(1080 * dpr),
						screenPixH - contentTop,
					);
					const cropW = Math.min(
						Math.round(1920 * dpr),
						Math.round(screenH * dpr * (16 / 9)), // approximate screen width
					);
					emit(
						"progress",
						`avfoundation: dpr=${dpr} screenY=${screenY} chromeH=${chromeH} screenH=${screenH} crop=${cropW}x${cropH}+0+${contentTop}`,
					);
					ffmpegProc = spawn("ffmpeg", [
						"-f", "avfoundation",
						"-framerate", "30",
						"-capture_cursor", "0",
						"-probesize", "128M",
						"-thread_queue_size", "1024",
						"-i", `${screenDeviceIndex}:none`,
						"-vf", `crop=${cropW}:${cropH}:0:${contentTop},scale=1920:1080`,
						"-c:v", "libvpx-vp9",
						"-b:v", "2M",
						"-cpu-used", "4",
						"-threads", "4",
						"-pix_fmt", "yuv420p",
						"-y",
						rawPath,
					], { stdio: ["pipe", "ignore", ffmpegLogFd] });
				}
				// Give ffmpeg a moment to initialize and detect early exit
				await new Promise((r) => setTimeout(r, 500));
				if (ffmpegProc && ffmpegProc.exitCode !== null) {
					const logContent = fs.existsSync(path.join(dir, "ffmpeg-capture.log"))
						? fs.readFileSync(path.join(dir, "ffmpeg-capture.log"), "utf-8").slice(-500)
						: "no log";
					throw new Error(
						`ffmpeg exited immediately (code ${ffmpegProc.exitCode}). Log: ${logContent}`,
					);
				}
			}

			// Start the timeline clock only after the page is visible with widget
			this.recordingStart = Date.now();

			await page.waitForTimeout(2000);

			this.timeline.push({
				action: "page-load",
				label: this.config.url,
				startTime: 0,
				endTime: this.now(),
				sendTime: 0,
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

			const openElapsed = (this.now() - openStart) * 1000;
			if (openElapsed < MIN_OPEN_WIDGET_DURATION) {
				await page.waitForTimeout(MIN_OPEN_WIDGET_DURATION - openElapsed);
			}

			this.timeline.push({
				action: "open-widget",
				label: "Open chat widget",
				startTime: openStart,
				endTime: this.now(),
				sendTime: openStart,
			});
			emit("action-end", "Widget opened", "open-widget");

			// --- Zoom in ---
			const zoomStart = this.now();
			emit("action-start", "Zooming into widget...", "zoom-in");
			await zoomToElement(page, panel);

			// Hold on the zoomed widget so the viewer can see the
			// greeting / empty chat state before typing starts.
			await page.waitForTimeout(ZOOM_SETTLE_DURATION);

			this.timeline.push({
				action: "zoom-in",
				label: "Zoom into widget",
				startTime: zoomStart,
				endTime: this.now(),
				sendTime: zoomStart,
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

				// Calculate sendTime: typing + pause + click delay are deterministic
				const sendTime =
					queryStart +
					(query.length * TYPING_DELAY + PAUSE_AFTER_TYPE + 500) / 1000;

				await flashMarker(page); // marker 1+i: query start
				await sendMessage(page, widget, query, {
					skipWaitBefore: i === 0,
				});
				const responseEndTime = this.now();

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
				let filledFormThisQuery = false;
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
						filledFormThisQuery = true;
					}
				}

				const minDuration = filledFormThisQuery
					? MIN_QUERY_WITH_FORM_DURATION
					: MIN_QUERY_DURATION;
				const queryElapsed = (this.now() - queryStart) * 1000;
				if (queryElapsed < minDuration) {
					await page.waitForTimeout(minDuration - queryElapsed);
				}

				// Append form context to response if a contact form was filled during this query
				const fullResponse = filledFormThisQuery
					? `${responseText?.trim() || ""} [User then fills out a contact form with name and email, and submits it to complete the order.]`
					: responseText?.trim() || undefined;

				this.timeline.push({
					action: actionName,
					label: query,
					startTime: queryStart,
					endTime: this.now(),
					response: fullResponse,
					sendTime,
					responseEndTime,
				});
				emit("action-end", `Query ${i + 1} complete`, actionName);
			}

			// --- Zoom out ---
			const zoomOutStart = this.now();
			emit("action-start", "Zooming out...", "zoom-out");
			await flashMarker(page); // marker N: zoom-out
			await resetZoom(page, panel);
			await page.waitForTimeout(3000);

			this.timeline.push({
				action: "zoom-out",
				label: "Zoom out to full view",
				startTime: zoomOutStart,
				endTime: this.now(),
				sendTime: zoomOutStart,
			});
			emit("action-end", "Zoomed out", "zoom-out");

			// --- Finalize ---
			emit("progress", "Closing browser to finalize video...");
			await context.close();
			await browser.close();

			// Stop ffmpeg recording (send 'q' to stdin for graceful stop)
			if (ffmpegProc) {
				await new Promise<void>((resolve) => {
					ffmpegProc!.on("close", () => resolve());
					ffmpegProc!.stdin?.write("q");
					ffmpegProc!.stdin?.end();
					// Force kill after 10s if graceful stop fails
					setTimeout(() => {
						ffmpegProc!.kill("SIGKILL");
						resolve();
					}, 10_000);
				});
				emit("progress", "Recording stopped");
			}

			// Stop Xvfb if we started it (Linux only)
			if (xvfbProc) {
				xvfbProc.kill();
			}

			if (!fs.existsSync(rawPath)) {
				throw new Error("No video file found — ffmpeg recording failed");
			}

			// --- Marker-based timeline sync ---
			// Detect green marker flashes in the video to get ground-truth
			// per-event timestamps, replacing the old uniform rebase.
			{
				const { stdout: durStr } = await execP("ffprobe", [
					"-v", "error", "-show_entries", "format=duration",
					"-of", "csv=p=0", rawPath,
				]);
				const videoDuration = Number.parseFloat(durStr.trim());
				const tlEnd =
					this.timeline[this.timeline.length - 1]?.endTime || 0;

				emit("progress", "Detecting visual markers in video...");
				let markers: number[] = [];
				try {
					const result = await detectMarkers(rawPath);
					markers = result.markers;
					emit("progress", `Marker diag: ${result.diag}`);
				} catch (err) {
					emit(
						"progress",
						`Marker detection failed: ${err instanceof Error ? err.message : err}`,
					);
				}

				// Expected markers: N queries + zoom-out (no open-widget marker —
				// it fires too early when ffmpeg may still be warming up)
				const markerEvents = this.timeline.filter(
					(e) =>
						e.action.startsWith("query-") ||
						e.action === "zoom-out",
				);
				const expectedCount = markerEvents.length;

				emit(
					"progress",
					`Detected ${markers.length} markers (expected ${expectedCount}) at [${markers.map((t) => t.toFixed(2)).join(", ")}]`,
				);

				if (markers.length === expectedCount && expectedCount > 0) {
					// Rebuild timeline using marker timestamps
					emit("progress", "Rebuilding timeline from markers...");
					for (let i = 0; i < markerEvents.length; i++) {
						const evt = markerEvents[i];
						const markerTime = markers[i];
						const nextMarkerTime =
							i + 1 < markers.length
								? markers[i + 1]
								: videoDuration;

						// Save originals before mutation
						const origStart = evt.startTime;
						const origEnd = evt.endTime;
						const origResponseEnd = evt.responseEndTime;
						const newDur = nextMarkerTime - markerTime;

						evt.startTime = markerTime;
						evt.endTime = nextMarkerTime;

						if (evt.action.startsWith("query-") && evt.sendTime != null) {
							// Recompute sendTime from marker: marker fires before
							// sendMessage, so typing duration is deterministic
							const typingDuration =
								(evt.label.length * TYPING_DELAY +
									PAUSE_AFTER_TYPE +
									500) /
								1000;
							evt.sendTime = markerTime + typingDuration;
						} else if (evt.sendTime != null) {
							evt.sendTime = markerTime;
						}

						if (origResponseEnd != null) {
							// Scale responseEndTime proportionally within the event
							const origDur = origEnd - origStart;
							const ratio =
								origDur > 0
									? (origResponseEnd - origStart) / origDur
									: 0.8;
							evt.responseEndTime = markerTime + newDur * ratio;
						}
					}

					// open-widget: 0 → first marker (query-1 start)
					// This spans page-load + widget open + zoom-in
					const openWidget = this.timeline.find(
						(e) => e.action === "open-widget",
					);
					if (openWidget) {
						openWidget.startTime = 0;
						openWidget.endTime = markers[0];
						openWidget.sendTime = 0;
					}

					// page-load: first few seconds (use original ratio)
					const pageLoad = this.timeline.find(
						(e) => e.action === "page-load",
					);
					if (pageLoad && openWidget) {
						const scale = tlEnd > 0 ? videoDuration / tlEnd : 1;
						pageLoad.startTime = 0;
						pageLoad.endTime = Math.min(
							pageLoad.endTime * scale,
							markers[0],
						);
						pageLoad.sendTime = 0;
						// open-widget starts after page-load
						openWidget.startTime = pageLoad.endTime;
					}

					// zoom-in: spans from partway through open-widget to query-1
					// Use original proportions to split open-widget vs zoom-in
					const zoomInEvt = this.timeline.find(
						(e) => e.action === "zoom-in",
					);
					if (zoomInEvt && openWidget) {
						// zoom-in gets the tail end of the pre-query period
						const scale = tlEnd > 0 ? videoDuration / tlEnd : 1;
						const zoomStart = zoomInEvt.startTime * scale;
						zoomInEvt.startTime = Math.min(zoomStart, markers[0]);
						zoomInEvt.endTime = markers[0];
						zoomInEvt.sendTime = zoomInEvt.startTime;
						// open-widget ends where zoom-in starts
						openWidget.endTime = zoomInEvt.startTime;
					}

					const scale = tlEnd > 0 ? videoDuration / tlEnd : 1;
					emit(
						"progress",
						`Marker sync complete. Video ${videoDuration.toFixed(1)}s, wall-clock ${tlEnd.toFixed(1)}s, effective scale: ${scale.toFixed(3)}`,
					);
				} else {
					// Fallback: uniform rebase (original behavior)
					emit(
						"progress",
						"Marker count mismatch — falling back to uniform rebase",
					);
					const scale = tlEnd > 0 ? videoDuration / tlEnd : 1;
					emit(
						"progress",
						`Video ${videoDuration.toFixed(1)}s, wall-clock ${tlEnd.toFixed(1)}s, scale: ${scale.toFixed(3)}`,
					);

					if (Math.abs(scale - 1) > 0.005) {
						emit("progress", "Rebasing timeline to video time...");
						for (const e of this.timeline) {
							e.startTime *= scale;
							e.endTime *= scale;
							if (e.sendTime != null) e.sendTime *= scale;
							if (e.responseEndTime != null)
								e.responseEndTime *= scale;
						}
					}
				}
			}

			// Save timeline (already in video-relative time)
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
				if (ffmpegProc) {
					ffmpegProc.kill("SIGKILL");
				}
				if (xvfbProc) {
					xvfbProc.kill();
				}
				await context.close();
				await browser.close();
			} catch {
				// ignore cleanup errors
			}
			throw err;
		}
	}
}
