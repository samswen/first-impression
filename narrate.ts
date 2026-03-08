/**
 * Intro Scene Generator
 *
 * Generates an opening narration video:
 * - Static snapshot of the target page with widget visible (but closed)
 * - Centered narrative text overlay
 * - AI voiceover via ElevenLabs
 * - Video duration matches audio length
 */

import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import { chromium } from "playwright";
import type { TenantInfo } from "./tenant";
import { textToSpeech } from "./voice";

const execP = promisify(execFile);

export interface SceneOptions {
	recordingDir: string;
	tenantInfo: TenantInfo;
	narrativeText?: string; // override auto-generated text
}

export interface SceneResult {
	videoPath: string;
	audioPath: string;
	duration: number;
}

// Keep backwards-compat aliases
export type IntroOptions = SceneOptions;
export type IntroResult = SceneResult;

export function buildNarrativeText(tenantInfo: TenantInfo): string {
	const assistantName =
		tenantInfo.setup.assistantName ||
		tenantInfo.app.title ||
		"our AI assistant";
	const businessName =
		tenantInfo.setup.businessName || tenantInfo.app.title || "your business";
	return `Watch ${assistantName} guide customers through products, answer questions, and drive conversions on ${businessName}'s site.`;
}

/**
 * Takes a screenshot of the page with the widget visible (but not opened).
 * Tries in order:
 * 1. snapshot-page.html (local page with widget injected)
 * 2. snapshot.png (pre-captured)
 * 3. Live site URL from timeline (site already has the widget)
 */
async function captureWidgetSnapshot(
	recordingDir: string,
	onProgress?: (message: string) => void,
): Promise<string> {
	const outputPath = path.resolve(recordingDir, "intro-snapshot.png");
	const snapshotPagePath = path.resolve(recordingDir, "snapshot-page.html");
	const fallbackPath = path.resolve(recordingDir, "snapshot.png");

	// Option 1: local snapshot page with widget injected
	if (fs.existsSync(snapshotPagePath)) {
		onProgress?.("Capturing screenshot with widget...");
		await screenshotWithWidget(`file://${snapshotPagePath}`, outputPath);
		onProgress?.("Widget snapshot captured");
		return outputPath;
	}

	// Option 2: pre-captured snapshot (no widget visible)
	if (fs.existsSync(fallbackPath)) {
		return fallbackPath;
	}

	// Option 3: live site — read URL from timeline
	const timelinePath = path.resolve(recordingDir, "timeline.json");
	if (fs.existsSync(timelinePath)) {
		const timeline = JSON.parse(fs.readFileSync(timelinePath, "utf-8"));
		const pageLoad = timeline.find(
			(e: { action: string }) => e.action === "page-load",
		);
		if (pageLoad?.label) {
			onProgress?.(`Capturing live screenshot of ${pageLoad.label}...`);
			await screenshotWithWidget(pageLoad.label, outputPath);
			onProgress?.("Live snapshot captured");
			return outputPath;
		}
	}

	throw new Error(
		"No snapshot-page.html, snapshot.png, or timeline.json in recording directory",
	);
}

async function screenshotWithWidget(
	url: string,
	outputPath: string,
): Promise<void> {
	const browser = await chromium.launch({ headless: true });
	const context = await browser.newContext({
		viewport: { width: 1920, height: 1080 },
		ignoreHTTPSErrors: true,
	});
	const page = await context.newPage();

	try {
		await page.goto(url, {
			waitUntil: "domcontentloaded",
			timeout: 30_000,
		});

		// Wait for the widget toggle button to appear
		const widget = page.locator("#xinfer-chat-widget");
		await widget.waitFor({ state: "attached", timeout: 15_000 });
		const toggle = widget.locator("button.xinfer-toggle");
		await toggle.waitFor({ state: "visible", timeout: 10_000 });

		// Small pause to let it fully render
		await page.waitForTimeout(1500);

		await page.screenshot({ path: outputPath, fullPage: false });
	} finally {
		await context.close();
		await browser.close();
	}
}

export async function generateIntro(
	opts: IntroOptions,
	onProgress?: (message: string) => void,
): Promise<IntroResult> {
	const { recordingDir, tenantInfo } = opts;
	const narrative = opts.narrativeText || buildNarrativeText(tenantInfo);

	const audioPath = path.join(recordingDir, "intro-audio.mp3");
	const videoPath = path.join(recordingDir, "intro.webm");

	// 1. Capture snapshot with widget visible (but closed)
	const snapshotPath = await captureWidgetSnapshot(recordingDir, onProgress);

	// 2. Generate voiceover
	onProgress?.("Generating voiceover...");
	const audioBuffer = await textToSpeech({ text: narrative });
	fs.writeFileSync(audioPath, audioBuffer);

	// 3. Get audio duration
	const { stdout: durationOut } = await execP("ffprobe", [
		"-v",
		"error",
		"-show_entries",
		"format=duration",
		"-of",
		"csv=p=0",
		audioPath,
	]);
	const duration = Number.parseFloat(durationOut.trim());
	onProgress?.(`Voiceover: ${duration.toFixed(1)}s`);

	// 4. Render text overlay as a transparent PNG via Playwright
	onProgress?.("Rendering text overlay...");
	const overlayPath = path.resolve(recordingDir, "intro-overlay.png");
	await renderTextOverlay(narrative, overlayPath);

	// 5. Compose video: snapshot + overlay + audio
	onProgress?.("Composing intro video...");

	const args = [
		"-loop",
		"1",
		"-i",
		snapshotPath,
		"-loop",
		"1",
		"-i",
		overlayPath,
		"-i",
		audioPath,
		"-filter_complex",
		"[0:v][1:v]overlay=(W-w)/2:(H-h)/2:format=auto[v]",
		"-map",
		"[v]",
		"-map",
		"2:a",
		"-c:v",
		"libvpx-vp9",
		"-c:a",
		"libopus",
		"-b:v",
		"2M",
		"-pix_fmt",
		"yuv420p",
		"-t",
		String(duration),
		"-shortest",
		"-y",
		videoPath,
	];

	const { stderr } = await execP("ffmpeg", args, {
		maxBuffer: 10 * 1024 * 1024,
	});

	if (!fs.existsSync(videoPath)) {
		throw new Error(
			`ffmpeg failed to create intro video: ${stderr.split("\n").slice(-3).join(" ")}`,
		);
	}

	const stat = fs.statSync(videoPath);
	onProgress?.(
		`Intro video: ${(stat.size / 1024 / 1024).toFixed(1)}MB, ${duration.toFixed(1)}s`,
	);

	return { videoPath, audioPath, duration };
}

export function buildClosingText(tenantInfo: TenantInfo): string {
	const assistantName =
		tenantInfo.setup.assistantName ||
		tenantInfo.app.title ||
		"our AI assistant";
	const businessName =
		tenantInfo.setup.businessName || tenantInfo.app.title || "your business";
	return `That's ${assistantName} in action on ${businessName}'s site — guiding customers, answering questions, and driving conversions. Ready to get started?`;
}

export async function generateOutro(
	opts: SceneOptions,
	onProgress?: (message: string) => void,
): Promise<SceneResult> {
	const { recordingDir, tenantInfo } = opts;
	const narrative = opts.narrativeText || buildClosingText(tenantInfo);

	const audioPath = path.join(recordingDir, "outro-audio.mp3");
	const videoPath = path.join(recordingDir, "outro.webm");

	// 1. Use the same snapshot as intro (widget visible but closed)
	const snapshotPath = await captureWidgetSnapshot(recordingDir, onProgress);

	// 2. Generate voiceover
	onProgress?.("Generating closing voiceover...");
	const audioBuffer = await textToSpeech({ text: narrative });
	fs.writeFileSync(audioPath, audioBuffer);

	// 3. Get audio duration
	const { stdout: durationOut } = await execP("ffprobe", [
		"-v",
		"error",
		"-show_entries",
		"format=duration",
		"-of",
		"csv=p=0",
		audioPath,
	]);
	const duration = Number.parseFloat(durationOut.trim());
	onProgress?.(`Closing voiceover: ${duration.toFixed(1)}s`);

	// 4. Render text overlay
	onProgress?.("Rendering closing overlay...");
	const overlayPath = path.resolve(recordingDir, "outro-overlay.png");
	await renderTextOverlay(narrative, overlayPath);

	// 5. Compose video: snapshot + overlay + audio
	onProgress?.("Composing outro video...");

	const args = [
		"-loop",
		"1",
		"-i",
		snapshotPath,
		"-loop",
		"1",
		"-i",
		overlayPath,
		"-i",
		audioPath,
		"-filter_complex",
		"[0:v][1:v]overlay=(W-w)/2:(H-h)/2:format=auto[v]",
		"-map",
		"[v]",
		"-map",
		"2:a",
		"-c:v",
		"libvpx-vp9",
		"-c:a",
		"libopus",
		"-b:v",
		"2M",
		"-pix_fmt",
		"yuv420p",
		"-t",
		String(duration),
		"-shortest",
		"-y",
		videoPath,
	];

	const { stderr } = await execP("ffmpeg", args, {
		maxBuffer: 10 * 1024 * 1024,
	});

	if (!fs.existsSync(videoPath)) {
		throw new Error(
			`ffmpeg failed to create outro video: ${stderr.split("\n").slice(-3).join(" ")}`,
		);
	}

	const stat = fs.statSync(videoPath);
	onProgress?.(
		`Outro video: ${(stat.size / 1024 / 1024).toFixed(1)}MB, ${duration.toFixed(1)}s`,
	);

	return { videoPath, audioPath, duration };
}

/**
 * Renders narrative text as a transparent PNG overlay with rounded card + 3D shadow.
 * Uses Playwright to render HTML and screenshot with transparency.
 */
async function renderTextOverlay(
	text: string,
	outputPath: string,
): Promise<void> {
	const wrapped = wordWrap(text, 45);
	const lines = wrapped
		.split("\n")
		.map((l) => `<span>${escapeHtml(l)}</span>`)
		.join("");

	const html = `<!DOCTYPE html>
<html>
<head>
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body {
    width: 1920px;
    height: 1080px;
    display: flex;
    align-items: center;
    justify-content: center;
    background: transparent;
  }
  .card {
    max-width: 800px;
    padding: 48px 56px;
    background: rgba(15, 23, 42, 0.55);
    border-radius: 24px;
    box-shadow:
      0 4px 6px rgba(0, 0, 0, 0.3),
      0 12px 24px rgba(0, 0, 0, 0.4),
      0 24px 48px rgba(0, 0, 0, 0.25),
      inset 0 1px 0 rgba(255, 255, 255, 0.08);
    border: 1px solid rgba(255, 255, 255, 0.1);
    text-align: center;
  }
  .card span {
    display: block;
    font-family: 'Inter', 'Segoe UI', system-ui, -apple-system, sans-serif;
    font-size: 32px;
    font-weight: 500;
    line-height: 1.6;
    color: #f1f5f9;
    letter-spacing: 0.01em;
    text-shadow: 0 2px 4px rgba(0, 0, 0, 0.5);
  }
</style>
</head>
<body>
  <div class="card">${lines}</div>
</body>
</html>`;

	const browser = await chromium.launch({ headless: true });
	const context = await browser.newContext({
		viewport: { width: 1920, height: 1080 },
	});
	const page = await context.newPage();

	try {
		await page.setContent(html, { waitUntil: "domcontentloaded" });
		await page.waitForTimeout(500);
		await page.screenshot({
			path: outputPath,
			omitBackground: true,
		});
	} finally {
		await context.close();
		await browser.close();
	}
}

function escapeHtml(s: string): string {
	return s
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;");
}

function wordWrap(text: string, maxCharsPerLine: number): string {
	const words = text.split(" ");
	const lines: string[] = [];
	let current = "";

	for (const word of words) {
		if (current && current.length + 1 + word.length > maxCharsPerLine) {
			lines.push(current);
			current = word;
		} else {
			current = current ? `${current} ${word}` : word;
		}
	}
	if (current) lines.push(current);

	return lines.join("\n");
}
