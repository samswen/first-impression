/**
 * Shopify App Store Screencast Builder
 *
 * Reads timeline files from the 3 recording scripts, maps events
 * to voiceover narration, generates TTS, mixes onto videos,
 * and concatenates into one final video.
 *
 * Usage:
 *   1. Run screencast-1-install.ts, screencast-2-admin.ts, screencast-3-customer.ts
 *   2. Edit the NARRATION_MAP below to match your timeline events
 *   3. tsx screencast.ts
 *
 * Output: recordings/screencast/final.webm
 */

import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import { textToSpeech } from "./voice";

const execP = promisify(execFile);

const DIR = path.join(
	path.dirname(new URL(import.meta.url).pathname),
	"recordings",
	"screencast",
);
const VOICEOVER_DIR = path.join(DIR, "voiceover");

interface TimelineEvent {
	action: string;
	label: string;
	time: number;
}

interface Clip {
	time: number;
	text: string;
}

/**
 * Map timeline action names to voiceover narration text.
 * Only events listed here get narration — others are silent.
 * Edit these after reviewing the timeline JSON files.
 */
const NARRATION_MAP: Record<string, string> = {
	// Segment 1: Install
	"start": "Let's install XInfer AI from the Shopify App Store.",
	"install-approved": "The app requests access to products, themes, and orders to power the AI agent.",
	"onboarding-visible": "After install, we land on the onboarding screen. Let's pick a plan.",
	"plan-selected": "We'll go with the Starter plan for this demo.",
	"setup-wizard-open": "Now we open the AI Agent Setup Wizard.",
	"wizard-url": "Enter your store URL so the AI can crawl your website and product catalog.",
	"wizard-business-type": "Select your business type for domain-specific intelligence.",
	"wizard-contact": "Add your business contact info and hours.",
	"wizard-personality": "Choose a voice and personality for your AI agent.",
	"wizard-complete": "The wizard is complete. The AI is now training on your content.",

	// Segment 2: Admin
	"dashboard": "Here's the embedded admin dashboard inside Shopify, showing setup progress and usage metrics.",
	"view-settings": "The Settings page lets you customize the AI agent's name, personality, and behavior.",
	"view-products": "Products sync automatically from your Shopify catalog via webhooks.",
	"view-billing": "The Billing page shows your current plan and usage details.",
	"view-ai-faqs": "Add custom FAQs to train the AI on your most common questions.",
	"view-ai-documents": "Upload documents like size guides or return policies to expand the AI's knowledge.",
	"view-follow-ups": "Follow-ups show customer requests that need human attention.",
	"view-shopping-carts": "Shopping carts track items customers add through the AI chat.",
	"view-draft-orders": "Draft orders track purchases completed through the chat widget.",
	"view-phone-setup": "Set up a phone number so customers can call or text your AI agent.",
	"view-widget-setup": "Activate the chat widget from your Shopify theme editor.",

	// Segment 3: Customer
	"page-load": "Now let's see the customer experience on the storefront.",
	"open-widget": "The chat widget appears in the corner. Let's click to open it.",
	"query-start-1": "We'll ask for product recommendations.",
	"query-done-1": "The AI searches the catalog and shows relevant products with images and prices.",
	"query-start-2": "Let's narrow it down with a budget constraint.",
	"query-done-2": "The AI respects the price limit precisely and updates its recommendations.",
	"query-start-3": "Customers can add items to their cart right from the conversation.",
	"query-start-4": "Let's check on an order status.",
	"query-done-4": "The AI looks up the order and returns real-time tracking information.",
	"voice-start": "Now let's try voice chat. Click the microphone and speak your question.",
	"voice-done": "The AI responds with voice, creating a hands-free shopping experience.",
};

const SEGMENTS = [
	{ video: "1-install.webm", timeline: "1-install-timeline.json" },
	{ video: "2-admin.webm", timeline: "2-admin-timeline.json" },
	{ video: "3-customer.webm", timeline: "3-customer-timeline.json" },
];

// ── Helpers ──────────────────────────────────────────────────────

async function getMediaDuration(filePath: string): Promise<number> {
	const { stdout } = await execP("ffprobe", [
		"-v", "error",
		"-show_entries", "format=duration",
		"-of", "csv=p=0",
		filePath,
	]);
	return Number.parseFloat(stdout.trim());
}

async function generateTTS(text: string, outputPath: string): Promise<number> {
	const buf = await textToSpeech({ text });
	fs.writeFileSync(outputPath, buf);
	return getMediaDuration(outputPath);
}

function buildClipsFromTimeline(timelineEvents: TimelineEvent[]): Clip[] {
	const clips: Clip[] = [];
	for (const event of timelineEvents) {
		const text = NARRATION_MAP[event.action];
		if (text) {
			clips.push({ time: event.time, text });
		}
	}
	return clips;
}

async function addVoiceoverToSegment(
	videoFile: string,
	clips: Clip[],
	segIndex: number,
): Promise<string> {
	const videoPath = path.join(DIR, videoFile);
	if (!fs.existsSync(videoPath)) {
		throw new Error(`Missing: ${videoFile}`);
	}

	if (clips.length === 0) {
		console.log(`  No narration clips, copying as-is`);
		return videoPath;
	}

	const segDir = path.join(VOICEOVER_DIR, `seg-${segIndex}`);
	fs.mkdirSync(segDir, { recursive: true });

	console.log(`\n── Segment ${segIndex + 1}: ${videoFile} (${clips.length} clips) ──`);

	// Generate TTS clips
	const generated: Array<{ audioPath: string; startTime: number; duration: number }> = [];

	for (let i = 0; i < clips.length; i++) {
		const clip = clips[i];
		const audioPath = path.join(segDir, `clip-${i}.mp3`);
		console.log(`  TTS ${i + 1}/${clips.length}: "${clip.text}"`);
		const duration = await generateTTS(clip.text, audioPath);
		generated.push({ audioPath, startTime: clip.time, duration });
	}

	// Get video duration, extend if needed
	const videoDuration = await getMediaDuration(videoPath);
	const audioEndTime = Math.max(...generated.map((c) => c.startTime + c.duration));
	const totalDuration = Math.max(videoDuration, audioEndTime + 0.5);
	const needsExtend = audioEndTime > videoDuration;

	let inputVideoPath = videoPath;

	if (needsExtend) {
		const extendBy = Math.ceil(audioEndTime - videoDuration + 0.5);
		console.log(`  Extending video by ${extendBy}s...`);

		const lastFrame = path.join(segDir, "last-frame.png");
		const freezeClip = path.join(segDir, "freeze.webm");
		const extended = path.join(segDir, "extended.webm");

		await execP("ffmpeg", ["-sseof", "-0.1", "-i", videoPath, "-frames:v", "1", "-y", lastFrame]);
		await execP("ffmpeg", [
			"-loop", "1", "-i", lastFrame, "-t", String(extendBy),
			"-c:v", "libvpx-vp9", "-b:v", "500K", "-pix_fmt", "yuv420p", "-r", "30", "-an", "-y", freezeClip,
		]);

		const concatList = path.join(segDir, "concat.txt");
		fs.writeFileSync(concatList, `file '${videoPath}'\nfile '${freezeClip}'\n`);
		await execP("ffmpeg", ["-f", "concat", "-safe", "0", "-i", concatList, "-c", "copy", "-y", extended]);
		inputVideoPath = extended;
	}

	// Mix audio onto video
	const outputPath = path.join(DIR, videoFile.replace(".webm", "-voiced.webm"));
	const args: string[] = ["-i", inputVideoPath];
	for (const clip of generated) {
		args.push("-i", clip.audioPath);
	}

	const filterParts: string[] = [];
	const mixInputs: string[] = [];
	for (let i = 0; i < generated.length; i++) {
		const delayMs = Math.round(generated[i].startTime * 1000);
		filterParts.push(`[${i + 1}:a]adelay=${delayMs}|${delayMs}[a${i}]`);
		mixInputs.push(`[a${i}]`);
	}
	filterParts.push(
		`${mixInputs.join("")}amix=inputs=${generated.length}:duration=longest:normalize=0,apad=whole_dur=${totalDuration}[aout]`,
	);

	args.push(
		"-filter_complex", filterParts.join(";"),
		"-map", "0:v", "-map", "[aout]",
		"-c:v", "copy", "-c:a", "libopus",
		"-t", String(totalDuration),
		"-y", outputPath,
	);

	console.log("  Mixing audio...");
	await execP("ffmpeg", args, { maxBuffer: 10 * 1024 * 1024 });
	console.log(`  Done: ${path.basename(outputPath)}`);

	return outputPath;
}

// ── Main ─────────────────────────────────────────────────────────

async function main() {
	fs.mkdirSync(VOICEOVER_DIR, { recursive: true });

	// Step 1: Read timelines and add voiceover to each segment
	const voicedPaths: string[] = [];

	for (let i = 0; i < SEGMENTS.length; i++) {
		const seg = SEGMENTS[i];
		const timelinePath = path.join(DIR, seg.timeline);

		if (!fs.existsSync(timelinePath)) {
			console.log(`Warning: ${seg.timeline} not found, skipping voiceover for ${seg.video}`);
			voicedPaths.push(path.join(DIR, seg.video));
			continue;
		}

		const timeline: TimelineEvent[] = JSON.parse(fs.readFileSync(timelinePath, "utf-8"));
		const clips = buildClipsFromTimeline(timeline);
		const outputPath = await addVoiceoverToSegment(seg.video, clips, i);
		voicedPaths.push(outputPath);
	}

	// Step 2: Concatenate all segments
	console.log("\n── Concatenating final video ──");
	const concatList = path.join(DIR, "final-concat.txt");
	fs.writeFileSync(
		concatList,
		voicedPaths.map((p) => `file '${p}'`).join("\n") + "\n",
	);

	const finalPath = path.join(DIR, "final.webm");
	await execP("ffmpeg", [
		"-f", "concat", "-safe", "0",
		"-i", concatList,
		"-c", "copy",
		"-y", finalPath,
	]);

	const duration = await getMediaDuration(finalPath);
	const size = fs.statSync(finalPath).size / 1024 / 1024;
	console.log(`\nDone! ${finalPath}`);
	console.log(`Duration: ${Math.round(duration)}s (${(duration / 60).toFixed(1)} min)`);
	console.log(`Size: ${size.toFixed(1)}MB`);
}

main().catch((err) => {
	console.error(err);
	process.exit(1);
});
