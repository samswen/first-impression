/**
 * Main Video Voiceover
 *
 * Generates narration audio clips for each timeline event and
 * mixes them into the video at the correct timestamps.
 */

import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import "dotenv/config";
import type { TimelineEntry } from "./recorder";
import type { TenantInfo } from "./tenant";
import { textToSpeech } from "./voice";

const execP = promisify(execFile);

interface NarrationSegment {
	action: string;
	query?: string;
	response?: string;
	availableDuration: number;
}

/**
 * Call the LLM narration API to generate contextual voiceover text.
 * Returns a map of action → narration text, or null on failure.
 */
async function generateNarrations(
	tenantId: number,
	segments: NarrationSegment[],
	assistantName: string,
	businessName: string,
): Promise<Map<string, string> | null> {
	const baseUrl = process.env.RAG_CHATBOT_BASE_URL;
	const apiKey = process.env.FIRST_IMPRESSION_API_KEY;

	if (!baseUrl || !apiKey) {
		console.warn(
			"[Voiceover] Missing RAG_CHATBOT_BASE_URL or FIRST_IMPRESSION_API_KEY, skipping LLM narration",
		);
		return null;
	}

	try {
		const res = await fetch(
			`${baseUrl}/api/first-impression/t/${tenantId}/narrate`,
			{
				method: "POST",
				headers: {
					"Content-Type": "application/json",
					Authorization: `Bearer ${apiKey}`,
				},
				body: JSON.stringify({
					segments,
					assistantName,
					businessName,
				}),
			},
		);

		if (!res.ok) {
			const body = await res.text().catch(() => "");
			console.warn(`[Voiceover] Narration API returned ${res.status}: ${body}`);
			return null;
		}

		const data = (await res.json()) as {
			narrations: Array<{ action: string; text: string }>;
		};

		const map = new Map<string, string>();
		for (const n of data.narrations) {
			map.set(n.action, n.text);
		}
		return map;
	} catch (error) {
		console.warn("[Voiceover] Narration API call failed:", error);
		return null;
	}
}

export interface VoiceoverOptions {
	recordingDir: string;
	videoFile: string; // e.g. "raw.webm"
	timeline: TimelineEntry[];
	tenantInfo: TenantInfo;
	tenantId: number;
}

export interface VoiceoverResult {
	videoPath: string;
	clipCount: number;
}

interface NarrationClip {
	event: TimelineEntry;
	text: string;
	audioPath: string;
	startTime: number;
	duration: number;
}

/**
 * Generate narration text for a timeline event.
 * Returns null for events that shouldn't be narrated (zoom-in/out, etc.)
 *
 * TTS pronunciation: use "X Infer dot AI" (with spaces) when referring to
 * the brand in spoken text. ElevenLabs mispronounces "XInfer" as one word.
 */
export function narrationForEvent(
	event: TimelineEntry,
	tenantInfo: TenantInfo,
): string | null {
	const assistantName =
		tenantInfo.setup.assistantName ||
		tenantInfo.app.title ||
		"the AI assistant";

	const _businessName = tenantInfo.setup.businessName || "the website";

	switch (event.action) {
		case "page-load":
			return null; // covered by intro scene
		case "open-widget":
			return `Let's open ${assistantName}.`;
		case "zoom-in":
			return null; // too short, skip
		case "zoom-out":
			return null; // covered by outro scene
		default:
			if (event.action.startsWith("query-")) {
				return `Now asking: ${event.label}`;
			}
			return null;
	}
}

/**
 * Get audio duration in seconds via ffprobe.
 */
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

export async function addVoiceover(
	opts: VoiceoverOptions,
	onProgress?: (message: string) => void,
	signal?: AbortSignal,
): Promise<VoiceoverResult> {
	const { recordingDir, videoFile, timeline, tenantInfo, tenantId } = opts;
	const videoPath = path.join(recordingDir, videoFile);
	const voDir = path.join(recordingDir, "voiceover");

	if (!fs.existsSync(videoPath)) {
		throw new Error(`Video not found: ${videoFile}`);
	}

	// Create voiceover working directory
	if (!fs.existsSync(voDir)) {
		fs.mkdirSync(voDir, { recursive: true });
	}

	const assistantName =
		tenantInfo.setup.assistantName ||
		tenantInfo.app.title ||
		"the AI assistant";
	const businessName = tenantInfo.setup.businessName || "the website";

	// Log full timeline for diagnostics
	onProgress?.("Timeline events:");
	for (const e of timeline) {
		const dur = (e.endTime - e.startTime).toFixed(1);
		onProgress?.(
			`  ${e.action}: ${e.startTime.toFixed(1)}s–${e.endTime.toFixed(1)}s (${dur}s) "${e.label}"`,
		);
	}

	// 1. Build narration-worthy events and try LLM narration
	const narratableEvents = timeline.filter(
		(e) => e.action === "open-widget" || e.action.startsWith("query-"),
	);

	// Build segments for the narration API
	// Use 75% of real duration to give TTS timing headroom
	const segments: NarrationSegment[] = narratableEvents.map((e) => ({
		action: e.action,
		query: e.action.startsWith("query-") ? e.label : undefined,
		response: e.response?.slice(0, 500),
		availableDuration: Math.min(e.endTime - e.startTime, 20) * 0.75,
	}));

	// Try LLM narration, fall back to templates on failure
	let llmNarrations: Map<string, string> | null = null;
	if (segments.length > 0) {
		onProgress?.("Generating AI narration...");
		llmNarrations = await generateNarrations(
			tenantId,
			segments,
			assistantName,
			businessName,
		);
		if (llmNarrations) {
			onProgress?.(`AI narration generated for ${llmNarrations.size} segments`);
		} else {
			onProgress?.("AI narration unavailable, using templates");
		}
	}

	// Resolve final narration text per event (LLM → template fallback)
	const narrations = narratableEvents
		.map((event) => {
			const llmText = llmNarrations?.get(event.action);
			const text = llmText || narrationForEvent(event, tenantInfo);
			return { event, text };
		})
		.filter(
			(n): n is { event: TimelineEntry; text: string } => n.text !== null,
		);

	onProgress?.(`Generating ${narrations.length} narration clips...`);

	const clips: NarrationClip[] = [];
	for (let i = 0; i < narrations.length; i++) {
		if (signal?.aborted) throw new Error("Cancelled");
		const { event, text } = narrations[i];
		const clipPath = path.join(voDir, `clip-${i}.mp3`);

		onProgress?.(`TTS ${i + 1}/${narrations.length}: "${text}"`);
		const audioBuffer = await textToSpeech({ text });
		fs.writeFileSync(clipPath, audioBuffer);

		const duration = await getAudioDuration(clipPath);

		// Center narration within the event window so the spoken description
		// aligns with visual action (query typing + answer display), rather
		// than starting at the exact query-send moment and spoiling the answer.
		const eventDuration = event.endTime - event.startTime;
		let clipStart = event.startTime;
		if (duration < eventDuration) {
			clipStart = event.startTime + (eventDuration - duration) / 2;
		}

		onProgress?.(
			`  Clip ${i + 1}: TTS=${duration.toFixed(1)}s, event=${eventDuration.toFixed(1)}s, ` +
				`placed at ${clipStart.toFixed(1)}s (event ${event.startTime.toFixed(1)}s–${event.endTime.toFixed(1)}s)`,
		);

		clips.push({
			event,
			text,
			audioPath: clipPath,
			startTime: clipStart,
			duration,
		});
	}

	if (clips.length === 0) {
		throw new Error("No narration clips generated");
	}

	// Adjust start times to prevent overlap — if a clip would start before
	// the previous one finishes, delay it so there's no audio collision.
	for (let i = 1; i < clips.length; i++) {
		const prevEnd = clips[i - 1].startTime + clips[i - 1].duration;
		if (clips[i].startTime < prevEnd) {
			const delay = prevEnd - clips[i].startTime;
			onProgress?.(
				`Clip ${i + 1} delayed by ${delay.toFixed(1)}s to avoid overlap`,
			);
			clips[i].startTime = prevEnd;
		}
	}

	// Log final clip schedule after overlap adjustments
	onProgress?.("Final clip schedule:");
	for (let i = 0; i < clips.length; i++) {
		const c = clips[i];
		const clipEnd = c.startTime + c.duration;
		const evtMid = (c.event.startTime + c.event.endTime) / 2;
		const clipMid = c.startTime + c.duration / 2;
		const drift = clipMid - evtMid;
		onProgress?.(
			`  Clip ${i + 1} [${c.event.action}]: ` +
				`audio ${c.startTime.toFixed(1)}s–${clipEnd.toFixed(1)}s (${c.duration.toFixed(1)}s), ` +
				`event ${c.event.startTime.toFixed(1)}s–${c.event.endTime.toFixed(1)}s, ` +
				`drift=${drift > 0 ? "+" : ""}${drift.toFixed(1)}s`,
		);
	}

	// Save clip manifest for later listing
	const manifest = clips.map((c, i) => ({
		file: `clip-${i}.mp3`,
		text: c.text,
	}));
	fs.writeFileSync(
		path.join(voDir, "clips.json"),
		JSON.stringify(manifest, null, 2),
	);

	onProgress?.(`${clips.length} clips ready, composing audio mix...`);

	// 2. Get video duration and check if audio extends past it
	const { stdout: videoDurOut } = await execP("ffprobe", [
		"-v",
		"error",
		"-show_entries",
		"format=duration",
		"-of",
		"csv=p=0",
		videoPath,
	]);
	const videoDuration = Number.parseFloat(videoDurOut.trim());

	// Find the latest point any audio clip reaches
	const audioEndTime = Math.max(...clips.map((c) => c.startTime + c.duration));
	const needsExtend = audioEndTime > videoDuration;
	const extendBy = needsExtend
		? Math.ceil(audioEndTime - videoDuration + 0.5)
		: 0;
	const totalDuration = Math.max(videoDuration, audioEndTime + 0.5);

	onProgress?.(
		`Video duration: ${videoDuration.toFixed(1)}s, audio ends: ${audioEndTime.toFixed(1)}s, ` +
			`total: ${totalDuration.toFixed(1)}s${needsExtend ? `, extending by ${extendBy}s` : ""}`,
	);

	// 3. If video needs extending, extract last frame and make a short freeze clip,
	//    then concat with the original — much faster than re-encoding the whole video.
	let inputVideoPath = videoPath;

	if (needsExtend) {
		onProgress?.(`Extending video by ${extendBy}s for closing narration...`);

		const lastFramePath = path.join(voDir, "last-frame.png");
		const freezeClipPath = path.join(voDir, "freeze-extend.webm");
		const concatPath = path.join(voDir, "extended.webm");

		// Extract last frame
		await execP("ffmpeg", [
			"-sseof",
			"-0.1",
			"-i",
			videoPath,
			"-frames:v",
			"1",
			"-y",
			lastFramePath,
		]);

		// Make a short freeze clip from the last frame (same codec/size as source)
		await execP("ffmpeg", [
			"-loop",
			"1",
			"-i",
			lastFramePath,
			"-t",
			String(extendBy),
			"-c:v",
			"libvpx-vp9",
			"-b:v",
			"500K",
			"-pix_fmt",
			"yuv420p",
			"-r",
			"30",
			"-an",
			"-y",
			freezeClipPath,
		]);

		// Concat original + freeze clip (fast, stream copy)
		const concatList = path.join(voDir, "concat.txt");
		fs.writeFileSync(
			concatList,
			`file '${videoPath}'\nfile '${freezeClipPath}'\n`,
		);
		await execP("ffmpeg", [
			"-f",
			"concat",
			"-safe",
			"0",
			"-i",
			concatList,
			"-c",
			"copy",
			"-y",
			concatPath,
		]);

		inputVideoPath = concatPath;
	}

	// 4. Build ffmpeg command to mix audio clips onto the (possibly extended) video
	const base = videoFile.replace(".webm", "");
	const outputFile = `${base}-voiced.webm`;
	const outputPath = path.join(recordingDir, outputFile);

	const args: string[] = ["-i", inputVideoPath];
	for (const clip of clips) {
		args.push("-i", clip.audioPath);
	}

	const filterParts: string[] = [];
	const mixInputs: string[] = [];

	for (let i = 0; i < clips.length; i++) {
		const delayMs = Math.round(clips[i].startTime * 1000);
		const inputIdx = i + 1;
		filterParts.push(
			`[${inputIdx}:a]highpass=f=120,lowpass=f=8000,adelay=${delayMs}|${delayMs}[a${i}]`,
		);
		mixInputs.push(`[a${i}]`);
	}

	filterParts.push(
		`${mixInputs.join("")}amix=inputs=${clips.length}:duration=longest:normalize=0,apad=whole_dur=${totalDuration}[aout]`,
	);

	args.push(
		"-filter_complex",
		filterParts.join(";"),
		"-map",
		"0:v",
		"-map",
		"[aout]",
		"-c:v",
		"copy",
		"-c:a",
		"libopus",
		"-t",
		String(totalDuration),
		"-y",
		outputPath,
	);

	if (signal?.aborted) throw new Error("Cancelled");
	onProgress?.("Running ffmpeg...");

	const { stderr } = await execP("ffmpeg", args, {
		maxBuffer: 10 * 1024 * 1024,
	});

	if (!fs.existsSync(outputPath)) {
		throw new Error(`ffmpeg failed: ${stderr.split("\n").slice(-3).join(" ")}`);
	}

	const stat = fs.statSync(outputPath);
	onProgress?.(
		`Voiceover done: ${outputFile} (${(stat.size / 1024 / 1024).toFixed(1)}MB)`,
	);

	return { videoPath: outputPath, clipCount: clips.length };
}
