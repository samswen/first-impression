/**
 * Shared helpers for screencast recording scripts.
 *
 * Loads Shopify cookies from recordings/screencast/cookies.json
 * and injects them into a fresh Playwright browser for recording.
 */

import fs from "node:fs";
import path from "node:path";
import { type BrowserContext, chromium, type Page } from "playwright";

export interface TimelineEvent {
	action: string;
	label: string;
	time: number;
}

export interface ScreencastContext {
	context: BrowserContext;
	page: Page;
	dir: string;
	timeline: TimelineEvent[];
	startTime: number;
}

const SCREENCAST_DIR = path.join(
	path.dirname(new URL(import.meta.url).pathname),
	"recordings",
	"screencast",
);

const COOKIES_PATH = path.join(SCREENCAST_DIR, "cookies.json");

/**
 * Launch a headed browser with video recording.
 * Injects Shopify cookies from cookies.json so you're already logged in.
 */
export async function startRecording(
	name: string,
	url: string,
): Promise<ScreencastContext> {
	const dir = path.join(SCREENCAST_DIR, name);
	fs.mkdirSync(dir, { recursive: true });

	const browser = await chromium.launch({
		headless: false,
		args: ["--start-foreground"],
	});
	const context = await browser.newContext({
		viewport: { width: 1600, height: 900 },
		recordVideo: { dir, size: { width: 1600, height: 900 } },
		ignoreHTTPSErrors: true,
	});

	// Inject cookies before navigating
	if (fs.existsSync(COOKIES_PATH)) {
		const cookies = JSON.parse(fs.readFileSync(COOKIES_PATH, "utf-8"));
		await context.addCookies(cookies);
		console.log(`Injected ${cookies.length} cookies`);
	} else {
		console.log(
			"Warning: no cookies.json found — you may need to log in manually",
		);
	}

	const page = await context.newPage();
	await page.goto(url, { waitUntil: "domcontentloaded", timeout: 60_000 });

	// Inject a visible cursor so clicks show in the video recording
	await injectCursor(page);

	return {
		context,
		page,
		dir,
		timeline: [],
		startTime: Date.now(),
	};
}

/**
 * Inject a visible cursor dot into the page.
 * Positioned programmatically by cursorClick() via page.evaluate().
 * No mousemove listener — only moves when our script commands it.
 */
async function injectCursor(page: Page) {
	const cursorScript = `
		if (!document.getElementById('__screencast-cursor')) {
			const dot = document.createElement('div');
			dot.id = '__screencast-cursor';
			Object.assign(dot.style, {
				position: 'fixed', zIndex: '2147483647', pointerEvents: 'none',
				width: '20px', height: '20px', borderRadius: '50%',
				background: 'rgba(34, 197, 94, 0.8)', border: '2px solid rgba(255,255,255,0.9)',
				transform: 'translate(-50%, -50%)',
				left: '-100px', top: '-100px', boxShadow: '0 0 4px rgba(0,0,0,0.3)',
			});
			document.body.appendChild(dot);
		}
	`;

	await page.evaluate(cursorScript).catch(() => {});

	// Re-inject after each navigation
	page.on("load", () => {
		page.evaluate(cursorScript).catch(() => {});
	});
}

/** Seconds since recording started */
export function now(ctx: ScreencastContext): number {
	return (Date.now() - ctx.startTime) / 1000;
}

/** Log a timeline event */
export function log(ctx: ScreencastContext, action: string, label: string) {
	const t = now(ctx);
	ctx.timeline.push({ action, label, time: t });
	console.log(`  [${t.toFixed(1)}s] ${action}: ${label}`);
}

/** Pause and let viewer see the current state */
export async function pause(ctx: ScreencastContext, ms = 2000) {
	await ctx.page.waitForTimeout(ms);
}

const SIGNAL_FILE = path.join(SCREENCAST_DIR, ".signal");

/**
 * Wait for a signal to continue.
 * Polls for the signal file — created externally (e.g. `touch .signal`).
 */
export async function waitForEnter(prompt: string) {
	// Clean up any stale signal
	if (fs.existsSync(SIGNAL_FILE)) fs.unlinkSync(SIGNAL_FILE);

	console.log(`\n⏸  WAITING: ${prompt}`);
	console.log(`   (touch ${SIGNAL_FILE} to continue)`);

	await new Promise<void>((resolve) => {
		const check = () => {
			if (fs.existsSync(SIGNAL_FILE)) {
				fs.unlinkSync(SIGNAL_FILE);
				resolve();
			} else {
				setTimeout(check, 300);
			}
		};
		check();
	});
	console.log("   ✓ Continuing...");
}

/** Finish recording: close browser, rename video, save timeline */
export async function finishRecording(
	ctx: ScreencastContext,
	outputName: string,
): Promise<string> {
	console.log("\nClosing browser...");
	const videoPath = await ctx.page.video()?.path();
	await ctx.context.close();

	// Rename video
	const finalPath = path.join(SCREENCAST_DIR, `${outputName}.webm`);
	if (videoPath && fs.existsSync(videoPath)) {
		fs.renameSync(videoPath, finalPath);
	}

	// Clean up temp dir (may have other playwright files)
	try {
		const remaining = fs.readdirSync(ctx.dir);
		if (remaining.length === 0) fs.rmdirSync(ctx.dir);
	} catch {
		/* ignore */
	}

	// Save timeline
	const timelinePath = path.join(SCREENCAST_DIR, `${outputName}-timeline.json`);
	fs.writeFileSync(timelinePath, JSON.stringify(ctx.timeline, null, 2));

	console.log(`Video: ${finalPath}`);
	console.log(`Timeline: ${timelinePath} (${ctx.timeline.length} events)`);

	return finalPath;
}
