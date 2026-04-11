/**
 * Pipeline — shared business logic for both interactive (web studio) and CLI modes.
 *
 * All recording operations live here so fixes apply to both modes.
 * Low-level modules (recorder, narrate, voiceover, trim, etc.) remain unchanged.
 */

import { execFile, spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import { chromium } from "playwright";
import { generateDemoPage } from "./demo-page";
import { detectFreezes } from "./freeze-detect";
import type { SceneResult } from "./narrate";
import { generateIntro, generateOutro } from "./narrate";
import { getPlaywrightProxy } from "./proxy";
import { type ProgressEvent, Recorder, type TimelineEntry } from "./recorder";
import type { TenantInfo } from "./tenant";
import { fetchTenantInfo } from "./tenant";
import { trimVideo } from "./trim";
import { publishDemo } from "./upload";
import { addVoiceover } from "./voiceover";

const execP = promisify(execFile);

/** Apply user-edited business fields to tenant info before demo page generation. */
function applyBusinessOverrides(
	info: TenantInfo,
	overrides: {
		tagline?: string;
		inventoryDescription?: string;
		subtitle?: string;
	},
): void {
	if (overrides.tagline !== undefined) info.setup.tagline = overrides.tagline;
	if (overrides.inventoryDescription !== undefined)
		info.setup.inventoryDescription = overrides.inventoryDescription;
}

// ─── Utility functions ───────────────────────────────────────────────

/** List all .webm files in a recording directory, sorted (raw first). */
export function listVideos(dir: string): string[] {
	if (!fs.existsSync(dir)) return [];
	return fs
		.readdirSync(dir)
		.filter((f) => f.endsWith(".webm"))
		.sort((a, b) => {
			if (a === "raw.webm") return -1;
			if (b === "raw.webm") return 1;
			return a.localeCompare(b, undefined, { numeric: true });
		});
}

/** Freeze detection JSON path for a given video. */
export function freezesPathFor(dir: string, video: string): string {
	const base = video.replace(".webm", "");
	return path.join(dir, `freezes-${base}.json`);
}

/** Frames directory path for a given video. */
export function framesDirFor(dir: string, video: string): string {
	const base = video.replace(".webm", "");
	return path.join(dir, `frames-${base}`);
}

/** Timeline file path for a given video. raw.webm → timeline.json, others → timeline-{base}.json */
export function timelinePathFor(dir: string, video: string): string {
	if (video === "raw.webm") return path.join(dir, "timeline.json");
	const base = video.replace(".webm", "");
	return path.join(dir, `timeline-${base}.json`);
}

/** Parse speed factor from filename. "raw-speed-2x.webm" → 2, "raw-speed-1.5th.webm" → 1/1.5 */
export function parseSpeedFromName(video: string): number | null {
	const m = video.match(/speed-([\d.]+)x\.webm$/);
	if (m) return Number.parseFloat(m[1]);
	const mth = video.match(/speed-([\d.]+)th\.webm$/);
	if (mth) return 1 / Number.parseFloat(mth[1]);
	return null;
}

/** Strip speed suffix to get source video. "raw-speed-2x.webm" → "raw.webm" */
export function sourceVideoName(video: string): string {
	return video.replace(/-speed-[\w.]+\.webm$/, ".webm");
}

/** Generate next trimmed-N.webm filename. */
export function nextTrimmedName(dir: string): string {
	const existing = fs
		.readdirSync(dir)
		.filter((f) => f.match(/^trimmed-\d+\.webm$/));
	const nums = existing.map((f) => {
		const m = f.match(/^trimmed-(\d+)\.webm$/);
		return m ? Number.parseInt(m[1], 10) : 0;
	});
	const next = nums.length > 0 ? Math.max(...nums) + 1 : 1;
	return `trimmed-${next}.webm`;
}

/** Pick the best video in priority order: final > voiced > speed > trimmed > raw */
export function pickBestVideo(dir: string): string {
	const videos = listVideos(dir);
	if (videos.includes("final.webm")) return "final.webm";
	const voiced = videos.filter((v) => v.includes("-voiced"));
	if (voiced.length > 0) return voiced[voiced.length - 1];
	const speed = videos.filter((v) => v.includes("-speed-"));
	if (speed.length > 0) return speed[speed.length - 1];
	const trimmed = videos.filter((v) => v.startsWith("trimmed-"));
	if (trimmed.length > 0) return trimmed[trimmed.length - 1];
	return "raw.webm";
}

/** Read timeline for a video, with fallback chain: saved → computed from speed source → raw. */
export function readTimeline(dir: string, video: string): TimelineEntry[] {
	const tp = timelinePathFor(dir, video);
	if (fs.existsSync(tp)) {
		return JSON.parse(fs.readFileSync(tp, "utf-8"));
	}

	// For speed videos without a saved timeline, compute from source
	const speed = parseSpeedFromName(video);
	if (speed) {
		const source = sourceVideoName(video);
		const sourceTimeline = readTimeline(dir, source);
		if (sourceTimeline.length > 0) {
			const computed = computeSpeedTimeline(sourceTimeline, speed);
			fs.writeFileSync(tp, JSON.stringify(computed, null, 2));
			return computed;
		}
	}

	// Fall back to raw timeline
	const rawTp = path.join(dir, "timeline.json");
	return fs.existsSync(rawTp)
		? JSON.parse(fs.readFileSync(rawTp, "utf-8"))
		: [];
}

/** Adjust timeline entries after removing exclude ranges. */
export function computeTrimmedTimeline(
	timeline: TimelineEntry[],
	excludeRanges: { start: number; end: number }[],
): TimelineEntry[] {
	const sorted = [...excludeRanges].sort((a, b) => a.start - b.start);

	function excludedBefore(t: number): number {
		let total = 0;
		for (const ex of sorted) {
			if (ex.end <= t) {
				total += ex.end - ex.start;
			} else if (ex.start < t) {
				total += t - ex.start;
			}
		}
		return total;
	}

	const result: TimelineEntry[] = [];
	for (const entry of timeline) {
		const newStart = entry.startTime - excludedBefore(entry.startTime);
		const newEnd = entry.endTime - excludedBefore(entry.endTime);
		if (newEnd > newStart) {
			result.push({
				action: entry.action,
				label: entry.label,
				startTime: Math.max(0, newStart),
				endTime: newEnd,
				response: entry.response,
			});
		}
	}
	return result;
}

/** Scale timeline entries by a speed factor. */
export function computeSpeedTimeline(
	timeline: TimelineEntry[],
	speed: number,
): TimelineEntry[] {
	return timeline.map((entry) => ({
		action: entry.action,
		label: entry.label,
		startTime: entry.startTime / speed,
		endTime: entry.endTime / speed,
		response: entry.response,
	}));
}

/** Generate a URL-safe slug from a business name. */
export function tenantSlugFromInfo(
	tenantInfo: TenantInfo,
	tenantId: number,
): string {
	return (
		tenantInfo.setup.businessName
			?.toLowerCase()
			.replace(/[^a-z0-9]+/g, "-")
			.replace(/^-|-$/g, "") || `tenant-${tenantId}`
	);
}

/** Default subtitle when AI generation doesn't provide one. */
export function defaultSubtitleText(info: TenantInfo): string {
	const assistantName =
		info.setup?.assistantName || info.app?.title || "the AI assistant";
	const businessName =
		info.setup?.businessName || info.app?.title || "your business";
	const hasProducts = (info.catalog?.totalProducts ?? 0) > 0;
	return hasProducts
		? `A personalized demo of ${assistantName} — an AI-powered shopping assistant built for ${businessName}, helping customers discover products, get recommendations, and make purchases.`
		: `A personalized demo of ${assistantName} — an AI-powered assistant built for ${businessName}, helping visitors learn about services, get answers, and take action.`;
}

/** Format speed factor as a filename label. 2 → "2x", 0.5 → "2th" */
export function speedLabel(speed: number): string {
	return speed < 1
		? `${(1 / speed).toFixed(1).replace(/\.0$/, "")}th`
		: `${speed.toString().replace(/\.0$/, "")}x`;
}

// ─── Voice clip inspection ───────────────────────────────────────────

export interface VoiceClip {
	file: string;
	text: string;
	type: "intro" | "main" | "outro";
	duration: number;
}

/** Get audio duration in seconds via ffprobe. */
async function getAudioDuration(filePath: string): Promise<number> {
	const { stdout } = await execP("ffprobe", [
		"-v",
		"error",
		"-show_entries",
		"format=duration",
		"-of",
		"csv=p=0",
		filePath,
	]);
	return Number.parseFloat(stdout.trim());
}

/**
 * List all voice clips in a recording directory with their narration text and duration.
 * Reads from local manifests only — no external API calls needed.
 */
export async function getVoiceClips(dir: string): Promise<VoiceClip[]> {
	const clips: VoiceClip[] = [];
	const voDir = path.join(dir, "voiceover");

	// Intro audio
	const introPath = path.join(dir, "intro-audio.mp3");
	if (fs.existsSync(introPath)) {
		const textPath = path.join(dir, "intro-audio.txt");
		const text = fs.existsSync(textPath)
			? fs.readFileSync(textPath, "utf-8")
			: "Intro";
		const duration = await getAudioDuration(introPath);
		clips.push({ file: "intro-audio.mp3", text, type: "intro", duration });
	}

	// Main voiceover clips — read from saved manifest
	const manifestPath = path.join(voDir, "clips.json");
	if (fs.existsSync(manifestPath)) {
		const manifest: { file: string; text: string }[] = JSON.parse(
			fs.readFileSync(manifestPath, "utf-8"),
		);
		for (const entry of manifest) {
			const clipPath = path.join(voDir, entry.file);
			if (!fs.existsSync(clipPath)) continue;
			const duration = await getAudioDuration(clipPath);
			clips.push({
				file: entry.file,
				text: entry.text,
				type: "main",
				duration,
			});
		}
	}

	// Outro audio
	const outroPath = path.join(dir, "outro-audio.mp3");
	if (fs.existsSync(outroPath)) {
		const textPath = path.join(dir, "outro-audio.txt");
		const text = fs.existsSync(textPath)
			? fs.readFileSync(textPath, "utf-8")
			: "Outro";
		const duration = await getAudioDuration(outroPath);
		clips.push({ file: "outro-audio.mp3", text, type: "outro", duration });
	}

	return clips;
}

// ─── Recording info types ────────────────────────────────────────────

export interface RecordingInfo {
	id: string;
	hasRaw: boolean;
	trimCount: number;
	queryCount: number;
	url: string;
	status: string;
	tenantId?: number;
}

export interface RecordingConfig {
	url: string;
	queries: string[];
	widgetUrl: string | null;
	tenantId?: number;
}

export interface RecordingDetails {
	id: string;
	timeline: TimelineEntry[];
	videos: {
		file: string;
		freezes: unknown[] | null;
		timeline: TimelineEntry[];
	}[];
	config: RecordingConfig | null;
}

export interface TrimResult {
	outputFile: string;
}

export interface SpeedResult {
	outputFile: string;
}

export interface IntroOutroResult {
	intro: SceneResult;
	outro: SceneResult;
}

export interface ComposeResult {
	outputFile: string;
	sizeMB: number;
}

export interface PublishResult {
	url: string;
	video: string;
	tenantSlug: string;
	businessName: string;
	assistantName: string;
	website: string | null;
	tagline: string | null;
	inventoryDescription: string | null;
	publishedId?: number;
	version?: number;
}

// ─── Orchestration functions ─────────────────────────────────────────

/** List all recordings in the recordings directory. */
export function listRecordings(recordingsDir: string): RecordingInfo[] {
	if (!fs.existsSync(recordingsDir)) return [];

	return fs
		.readdirSync(recordingsDir, { withFileTypes: true })
		.filter((d) => d.isDirectory())
		.map((d) => {
			const id = d.name;
			const dirPath = path.join(recordingsDir, id);
			const timelinePath = path.join(dirPath, "timeline.json");
			const hasRaw = fs.existsSync(path.join(dirPath, "raw.webm"));
			const videos = listVideos(dirPath);
			const trimCount = videos.filter((v) => v.startsWith("trimmed-")).length;

			let timeline: TimelineEntry[] = [];
			if (fs.existsSync(timelinePath)) {
				timeline = JSON.parse(fs.readFileSync(timelinePath, "utf-8"));
			}

			const configPath = path.join(dirPath, "config.json");
			const config = fs.existsSync(configPath)
				? JSON.parse(fs.readFileSync(configPath, "utf-8"))
				: null;

			return {
				id,
				hasRaw,
				trimCount,
				queryCount: timeline.filter((t) => t.action.startsWith("query-"))
					.length,
				url: timeline.find((t) => t.action === "page-load")?.label ?? "",
				status: trimCount > 0 ? "trimmed" : hasRaw ? "recorded" : "in-progress",
				tenantId: config?.tenantId,
			};
		})
		.sort((a, b) => b.id.localeCompare(a.id));
}

/** Get full recording details. */
export function getRecordingDetails(dir: string): RecordingDetails {
	const id = path.basename(dir);
	const timelinePath = path.join(dir, "timeline.json");
	const timeline = fs.existsSync(timelinePath)
		? JSON.parse(fs.readFileSync(timelinePath, "utf-8"))
		: [];

	const videos = listVideos(dir).map((file) => {
		const fp = freezesPathFor(dir, file);
		const freezes = fs.existsSync(fp)
			? JSON.parse(fs.readFileSync(fp, "utf-8"))
			: null;
		const videoTimeline = readTimeline(dir, file);
		return { file, freezes, timeline: videoTimeline };
	});

	const configPath = path.join(dir, "config.json");
	const config = fs.existsSync(configPath)
		? JSON.parse(fs.readFileSync(configPath, "utf-8"))
		: null;

	return { id, timeline, videos, config };
}

/** Start a new recording. Returns recording ID and result promise. */
export function startRecording(
	recordingsDir: string,
	opts: {
		url: string;
		queries: string[];
		headed?: boolean;
		widgetUrl?: string;
		tenantId?: number;
	},
	onProgress?: (event: ProgressEvent) => void,
	signal?: AbortSignal,
): { id: string; dir: string; promise: Promise<void> } {
	const id = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
	const dir = path.join(recordingsDir, id);

	// Save recording config
	const config: RecordingConfig = {
		url: opts.url,
		queries: opts.queries,
		widgetUrl: opts.widgetUrl || null,
		tenantId: opts.tenantId,
	};
	fs.mkdirSync(dir, { recursive: true });
	fs.writeFileSync(
		path.join(dir, "config.json"),
		JSON.stringify(config, null, 2),
	);

	const recorder = new Recorder({
		url: opts.url,
		queries: opts.queries,
		headed: opts.headed === true,
		recordingDir: dir,
		widgetUrl: opts.widgetUrl,
	});

	const promise = recorder.run(onProgress, signal).then(() => {});

	return { id, dir, promise };
}

/** Delete a recording directory. */
export function deleteRecording(dir: string): void {
	fs.rmSync(dir, { recursive: true, force: true });
}

/** Delete a video and its associated files (freezes, frames, timeline). */
export function deleteVideo(dir: string, file: string): void {
	if (file === "raw.webm") {
		throw new Error("Cannot delete raw video");
	}

	const videoPath = path.join(dir, file);
	if (!fs.existsSync(videoPath)) {
		throw new Error("Video not found");
	}

	fs.unlinkSync(videoPath);

	const base = file.replace(".webm", "");
	const freezesFile = path.join(dir, `freezes-${base}.json`);
	const framesDir = path.join(dir, `frames-${base}`);
	const timelineFile = path.join(dir, `timeline-${base}.json`);

	if (fs.existsSync(freezesFile)) fs.unlinkSync(freezesFile);
	if (fs.existsSync(framesDir)) fs.rmSync(framesDir, { recursive: true });
	if (fs.existsSync(timelineFile)) fs.unlinkSync(timelineFile);
}

/** Run freeze detection on a video. */
export async function runFreezeDetection(
	dir: string,
	videoFile: string,
): Promise<unknown[]> {
	const videoPath = path.join(dir, videoFile);
	if (!fs.existsSync(videoPath)) {
		throw new Error(`${videoFile} not found`);
	}

	const timeline = readTimeline(dir, videoFile);
	const freezes = await detectFreezes(
		videoPath,
		timeline,
		framesDirFor(dir, videoFile),
	);

	fs.writeFileSync(
		freezesPathFor(dir, videoFile),
		JSON.stringify(freezes, null, 2),
	);
	return freezes;
}

/** Trim a video by removing exclude ranges. */
export async function trimRecording(
	dir: string,
	videoFile: string,
	excludeRanges: { start: number; end: number }[],
	onProgress?: (message: string) => void,
): Promise<TrimResult> {
	const videoPath = path.join(dir, videoFile);
	if (!fs.existsSync(videoPath)) {
		throw new Error(`${videoFile} not found`);
	}

	if (excludeRanges.length === 0) {
		throw new Error("No ranges to exclude");
	}

	const outputFile = nextTrimmedName(dir);
	const outputPath = path.join(dir, outputFile);

	onProgress?.(`Trimming ${videoFile} → ${outputFile}...`);
	await trimVideo(videoPath, excludeRanges, outputPath, onProgress);

	// Compute and save adjusted timeline
	const sourceTimeline = readTimeline(dir, videoFile);
	const trimmedTimeline = computeTrimmedTimeline(sourceTimeline, excludeRanges);
	fs.writeFileSync(
		timelinePathFor(dir, outputFile),
		JSON.stringify(trimmedTimeline, null, 2),
	);

	return { outputFile };
}

/** Render a speed-adjusted video. */
export async function renderSpeedVideo(
	dir: string,
	videoFile: string,
	speed: number,
	onProgress?: (message: string) => void,
	signal?: AbortSignal,
): Promise<SpeedResult> {
	const videoPath = path.join(dir, videoFile);
	if (!fs.existsSync(videoPath)) {
		throw new Error(`${videoFile} not found`);
	}

	// Build output filename
	const label = speedLabel(speed);
	const base = videoFile.replace(".webm", "");
	const outputFile = `${base}-speed-${label}.webm`;
	const outputPath = path.join(dir, outputFile);

	onProgress?.(`Rendering at ${label} speed...`);

	// Check if video has audio
	const { stdout: probeStreams } = await execP("ffprobe", [
		"-v",
		"error",
		"-select_streams",
		"a",
		"-show_entries",
		"stream=index",
		"-of",
		"csv=p=0",
		videoPath,
	]).catch(() => ({ stdout: "" }));
	const hasAudio = probeStreams.trim().length > 0;

	// Get source duration for progress
	const { stdout: probeOut } = await execP("ffprobe", [
		"-v",
		"error",
		"-show_entries",
		"format=duration",
		"-of",
		"csv=p=0",
		videoPath,
	]);
	const srcDuration = Number.parseFloat(probeOut.trim());
	const expectedDuration = srcDuration / speed;

	// Build ffmpeg args
	const args = ["-progress", "pipe:1", "-i", videoPath];

	if (hasAudio) {
		// Build atempo chain (atempo supports 0.5-100.0 per instance)
		const atempoFilters: string[] = [];
		let remaining = speed;
		while (remaining > 2.0) {
			atempoFilters.push("atempo=2.0");
			remaining /= 2.0;
		}
		while (remaining < 0.5) {
			atempoFilters.push("atempo=0.5");
			remaining /= 0.5;
		}
		atempoFilters.push(`atempo=${remaining}`);

		args.push(
			"-filter_complex",
			`[0:v]setpts=PTS/${speed}[v];[0:a]${atempoFilters.join(",")}[a]`,
			"-map",
			"[v]",
			"-map",
			"[a]",
		);
	} else {
		args.push("-vf", `setpts=PTS/${speed}`, "-an");
	}

	args.push("-y", outputPath);

	// Run ffmpeg with progress tracking
	const proc = spawn("ffmpeg", args);
	if (signal) {
		if (signal.aborted) {
			proc.kill("SIGTERM");
			throw new Error("Cancelled");
		}
		signal.addEventListener("abort", () => proc.kill("SIGTERM"), {
			once: true,
		});
	}
	let lastPercent = 0;

	proc.stdout.on("data", (data: Buffer) => {
		const lines = data.toString().split("\n");
		for (const line of lines) {
			const match = line.match(/out_time_ms=(\d+)/);
			if (match) {
				const currentSec = Number.parseInt(match[1], 10) / 1_000_000;
				const percent = Math.min(
					99,
					Math.round((currentSec / expectedDuration) * 100),
				);
				if (percent > lastPercent) {
					lastPercent = percent;
					onProgress?.(`Encoding... ${percent}%`);
				}
			}
		}
	});

	let stderrOutput = "";
	proc.stderr.on("data", (data: Buffer) => {
		stderrOutput += data.toString();
	});

	await new Promise<void>((resolve, reject) => {
		proc.on("close", (code) => {
			if (code === 0) {
				resolve();
			} else {
				const lastLines = stderrOutput
					.split("\n")
					.filter(Boolean)
					.slice(-5)
					.join(" | ");
				reject(new Error(`ffmpeg exited with code ${code}: ${lastLines}`));
			}
		});
		proc.on("error", reject);
	});

	// Compute and save adjusted timeline
	const sourceTimeline = readTimeline(dir, videoFile);
	const speedTimeline = computeSpeedTimeline(sourceTimeline, speed);
	fs.writeFileSync(
		timelinePathFor(dir, outputFile),
		JSON.stringify(speedTimeline, null, 2),
	);

	return { outputFile };
}

/** Add voiceover narration to a video. */
export async function addVoiceoverToVideo(
	dir: string,
	videoFile: string,
	tenantId: number,
	onProgress?: (message: string) => void,
	signal?: AbortSignal,
): Promise<{ clipCount: number; outputFile: string }> {
	const videoPath = path.join(dir, videoFile);
	if (!fs.existsSync(videoPath)) {
		throw new Error(`${videoFile} not found`);
	}

	const timeline = readTimeline(dir, videoFile);
	if (timeline.length === 0) {
		throw new Error("No timeline data for this video");
	}

	if (signal?.aborted) throw new Error("Cancelled");
	const tenantInfo = await fetchTenantInfo(tenantId);
	onProgress?.(`Adding voiceover to ${videoFile}...`);

	if (signal?.aborted) throw new Error("Cancelled");
	const result = await addVoiceover(
		{ recordingDir: dir, videoFile, timeline, tenantInfo, tenantId },
		onProgress,
		signal,
	);

	// Save timeline for the voiced video (same as source)
	const voicedFile = videoFile.replace(".webm", "-voiced.webm");
	fs.writeFileSync(
		timelinePathFor(dir, voicedFile),
		JSON.stringify(timeline, null, 2),
	);

	return { clipCount: result.clipCount, outputFile: voicedFile };
}

/** Generate intro and outro scenes. */
export async function generateIntroOutro(
	dir: string,
	tenantId: number,
	opts?: { introText?: string; outroText?: string },
	onProgress?: (message: string) => void,
	signal?: AbortSignal,
): Promise<IntroOutroResult> {
	if (signal?.aborted) throw new Error("Cancelled");
	const tenantInfo = await fetchTenantInfo(tenantId);
	onProgress?.("Starting intro generation...");

	if (signal?.aborted) throw new Error("Cancelled");
	const intro = await generateIntro(
		{ recordingDir: dir, tenantInfo, narrativeText: opts?.introText },
		onProgress,
	);
	onProgress?.(`Intro ready: ${intro.duration.toFixed(1)}s`);

	if (signal?.aborted) throw new Error("Cancelled");
	const outro = await generateOutro(
		{ recordingDir: dir, tenantInfo, narrativeText: opts?.outroText },
		onProgress,
	);

	return { intro, outro };
}

/** Compose final video: intro + main + outro via ffmpeg concat. */
export async function composeVideo(
	dir: string,
	mainVideo?: string,
	onProgress?: (message: string) => void,
	signal?: AbortSignal,
): Promise<ComposeResult> {
	const introPath = path.join(dir, "intro.webm");
	const outroPath = path.join(dir, "outro.webm");
	const outputPath = path.join(dir, "final.webm");

	// Find the best main video (excluding final/intro/outro)
	if (!mainVideo) {
		const videos = listVideos(dir).filter(
			(v) => !["final.webm", "intro.webm", "outro.webm"].includes(v),
		);
		const voiced = videos.filter((v) => v.includes("-voiced"));
		const speed = videos.filter(
			(v) => v.includes("-speed-") && !v.includes("-voiced"),
		);
		const trimmed = videos.filter(
			(v) => v.startsWith("trimmed-") && !v.includes("-voiced"),
		);
		mainVideo = voiced.at(-1) ?? speed.at(-1) ?? trimmed.at(-1) ?? "raw.webm";
	}
	const mainPath = path.join(dir, mainVideo);

	if (!fs.existsSync(mainPath)) {
		throw new Error(`Main video ${mainVideo} not found`);
	}

	// Build concat list
	const parts: string[] = [];
	if (fs.existsSync(introPath)) {
		parts.push(`file '${introPath}'`);
		onProgress?.("Including intro...");
	} else {
		onProgress?.("No intro found, skipping...");
	}

	parts.push(`file '${mainPath}'`);
	onProgress?.(`Main video: ${mainVideo}`);

	if (fs.existsSync(outroPath)) {
		parts.push(`file '${outroPath}'`);
		onProgress?.("Including outro...");
	} else {
		onProgress?.("No outro found, skipping...");
	}

	const concatListPath = path.join(dir, "final-concat.txt");
	fs.writeFileSync(concatListPath, `${parts.join("\n")}\n`);

	if (signal?.aborted) throw new Error("Cancelled");
	onProgress?.("Concatenating videos...");

	// Try stream copy first (fast), fall back to re-encode if it fails
	let composed = false;
	try {
		onProgress?.("Concatenating (stream copy)...");
		await execP(
			"ffmpeg",
			[
				"-f",
				"concat",
				"-safe",
				"0",
				"-i",
				concatListPath,
				"-c",
				"copy",
				"-y",
				outputPath,
			],
			{ maxBuffer: 10 * 1024 * 1024 },
		);
		if (fs.existsSync(outputPath) && fs.statSync(outputPath).size > 0) {
			composed = true;
		}
	} catch {
		// Stream copy failed (VP9 superframe / Opus header mismatch) — re-encode
		if (fs.existsSync(outputPath)) fs.unlinkSync(outputPath);
	}

	if (!composed) {
		// Use filter_complex concat (handles mixed codecs like VP8+VP9)
		onProgress?.("Re-encoding (stream copy failed)...");
		const inputPaths: string[] = [];
		if (fs.existsSync(introPath)) inputPaths.push(introPath);
		inputPaths.push(mainPath);
		if (fs.existsSync(outroPath)) inputPaths.push(outroPath);

		const reencodeArgs: string[] = [];
		for (const p of inputPaths) {
			reencodeArgs.push("-i", p);
		}

		const n = inputPaths.length;
		const filterStreams = inputPaths.map((_, i) => `[${i}:v][${i}:a]`).join("");
		reencodeArgs.push(
			"-filter_complex",
			`${filterStreams}concat=n=${n}:v=1:a=1[outv][outa]`,
			"-map",
			"[outv]",
			"-map",
			"[outa]",
			"-c:v",
			"libvpx-vp9",
			"-b:v",
			"2M",
			"-pix_fmt",
			"yuv420p",
			"-c:a",
			"libopus",
			"-y",
			outputPath,
		);

		await execP("ffmpeg", reencodeArgs, {
			maxBuffer: 10 * 1024 * 1024,
			timeout: 5 * 60 * 1000,
		});
	}

	if (!fs.existsSync(outputPath)) {
		throw new Error("Compose failed: output file not created");
	}

	const stat = fs.statSync(outputPath);
	const sizeMB = stat.size / 1024 / 1024;
	return { outputFile: "final.webm", sizeMB };
}

/** Generate a demo page preview HTML string. */
export async function generatePreview(
	_dir: string,
	tenantId: number,
	videoUrl: string,
	overrides?: {
		tagline?: string;
		inventoryDescription?: string;
		subtitle?: string;
	},
): Promise<string> {
	const tenantInfo = await fetchTenantInfo(tenantId);
	if (overrides) applyBusinessOverrides(tenantInfo, overrides);
	const tenantSlug = tenantSlugFromInfo(tenantInfo, tenantId);
	const assetsBaseUrl = "https://assets.xinfer.ai";

	return generateDemoPage({
		tenantInfo,
		videoFilename: videoUrl,
		assetsBaseUrl,
		tenantSlug,
		subtitle: overrides?.subtitle,
	});
}

/** Capture a mobile snapshot for an existing recording that only has a desktop snapshot. */
export async function captureMobileSnapshot(
	dir: string,
	onProgress?: (message: string) => void,
): Promise<string> {
	const configPath = path.join(dir, "config.json");
	if (!fs.existsSync(configPath)) {
		throw new Error("No config.json found in recording directory");
	}

	const config = JSON.parse(fs.readFileSync(configPath, "utf-8"));
	const url = config.url as string;
	if (!url) {
		throw new Error("No URL found in config.json");
	}

	onProgress?.(`Capturing mobile snapshot of ${url}...`);

	const browser = await chromium.launch({
		headless: true,
		proxy: await getPlaywrightProxy(),
	});
	const context = await browser.newContext({
		viewport: { width: 390, height: 844 },
		ignoreHTTPSErrors: true,
	});
	const page = await context.newPage();
	await page.goto(url, { waitUntil: "load", timeout: 60_000 });
	await page.waitForTimeout(3000);

	const outputPath = path.join(dir, "snapshot-mobile.png");
	await page.screenshot({ path: outputPath, fullPage: false });
	await context.close();
	await browser.close();

	onProgress?.("Mobile snapshot saved");
	return outputPath;
}

/** Publish a recording to S3. */
export async function publishRecording(
	dir: string,
	tenantId: number,
	opts?: {
		force?: boolean;
		userId?: number;
		email?: string;
		autoCreateUser?: boolean;
		tagline?: string;
		inventoryDescription?: string;
		subtitle?: string;
		generatedContent?: Record<string, unknown>;
	},
): Promise<PublishResult> {
	const bestVideo = pickBestVideo(dir);
	const videoPath = path.join(dir, bestVideo);

	if (!fs.existsSync(videoPath)) {
		throw new Error(`Video ${bestVideo} not found`);
	}

	const snapshotPath = path.join(dir, "snapshot.png");
	const snapshotMobilePath = path.join(dir, "snapshot-mobile.png");
	const tenantInfo = await fetchTenantInfo(tenantId);
	if (opts) applyBusinessOverrides(tenantInfo, opts);
	const tenantSlug = tenantSlugFromInfo(tenantInfo, tenantId);

	// Read recording config for reproduction tracking
	const configPath = path.join(dir, "config.json");
	const config = fs.existsSync(configPath)
		? JSON.parse(fs.readFileSync(configPath, "utf-8"))
		: undefined;

	const diagLogPath = path.join(dir, "snapshot-diag.log");
	const result = await publishDemo({
		tenantInfo,
		tenantSlug,
		videoPath,
		videoFile: bestVideo,
		snapshotPath: fs.existsSync(snapshotPath) ? snapshotPath : undefined,
		snapshotMobilePath: fs.existsSync(snapshotMobilePath)
			? snapshotMobilePath
			: undefined,
		diagLogPath: fs.existsSync(diagLogPath) ? diagLogPath : undefined,
		config,
		targetUrl: config?.url as string | undefined,
		widgetUrl: config?.widgetUrl as string | undefined,
		force: opts?.force,
		userId: opts?.userId,
		email: opts?.email,
		autoCreateUser: opts?.autoCreateUser,
		subtitle: opts?.subtitle,
		generatedContent: opts?.generatedContent,
	});

	const publishResult: PublishResult = {
		url: result.url,
		video: bestVideo,
		tenantSlug,
		businessName:
			tenantInfo.setup.businessName || tenantInfo.app.title || "your business",
		assistantName:
			tenantInfo.setup.assistantName || tenantInfo.app.title || "AI Assistant",
		website: tenantInfo.setup.website || tenantInfo.app.homePageUrl || null,
		tagline: tenantInfo.setup.tagline || null,
		inventoryDescription: tenantInfo.setup.inventoryDescription || null,
		publishedId: result.publishedId,
		version: result.version,
	};

	// Send outreach templates to user's email (fire-and-forget)
	const outreachEmail = opts?.email;
	const baseUrl = process.env.RAG_CHATBOT_BASE_URL;
	const apiKey = process.env.FIRST_IMPRESSION_API_KEY;
	if (outreachEmail && baseUrl && apiKey) {
		fetch(`${baseUrl}/api/first-impression/outreach-email`, {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				Authorization: `Bearer ${apiKey}`,
			},
			body: JSON.stringify({
				to: outreachEmail,
				businessName: publishResult.businessName,
				assistantName: publishResult.assistantName,
				demoUrl: publishResult.url,
				tagline: publishResult.tagline,
				inventoryDescription: publishResult.inventoryDescription,
				userEmail: outreachEmail,
				tenantId,
				adminUrl: tenantInfo.subdomain
					? `https://${tenantInfo.subdomain}.xinfer.ai/admin`
					: undefined,
			}),
		})
			.then((r) => {
				if (r.ok)
					console.log(`[Publish] Outreach email sent to ${outreachEmail}`);
				else
					r.text().then((t) =>
						console.error(`[Publish] Outreach email failed (${r.status}):`, t),
					);
			})
			.catch((err) => console.error("[Publish] Outreach email error:", err));
	}

	return publishResult;
}
