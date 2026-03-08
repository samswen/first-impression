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
import type { TimelineEntry } from "./recorder";
import type { TenantInfo } from "./tenant";
import { textToSpeech } from "./voice";

const execP = promisify(execFile);

export interface VoiceoverOptions {
	recordingDir: string;
	videoFile: string; // e.g. "raw-speed-2x.webm"
	timeline: TimelineEntry[];
	tenantInfo: TenantInfo;
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
 */
function narrationForEvent(
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
): Promise<VoiceoverResult> {
	const { recordingDir, videoFile, timeline, tenantInfo } = opts;
	const videoPath = path.join(recordingDir, videoFile);
	const voDir = path.join(recordingDir, "voiceover");

	if (!fs.existsSync(videoPath)) {
		throw new Error(`Video not found: ${videoFile}`);
	}

	// Create voiceover working directory
	if (!fs.existsSync(voDir)) {
		fs.mkdirSync(voDir, { recursive: true });
	}

	// 1. Generate narration clips
	const clips: NarrationClip[] = [];
	const narrations = timeline
		.map((event) => ({ event, text: narrationForEvent(event, tenantInfo) }))
		.filter(
			(n): n is { event: TimelineEntry; text: string } => n.text !== null,
		);

	onProgress?.(`Generating ${narrations.length} narration clips...`);

	for (let i = 0; i < narrations.length; i++) {
		const { event, text } = narrations[i];
		const clipPath = path.join(voDir, `clip-${i}.mp3`);

		onProgress?.(`TTS ${i + 1}/${narrations.length}: "${text}"`);
		const audioBuffer = await textToSpeech({ text });
		fs.writeFileSync(clipPath, audioBuffer);

		const duration = await getAudioDuration(clipPath);
		clips.push({
			event,
			text,
			audioPath: clipPath,
			startTime: event.startTime,
			duration,
		});
	}

	if (clips.length === 0) {
		throw new Error("No narration clips generated");
	}

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
		filterParts.push(`[${inputIdx}:a]adelay=${delayMs}|${delayMs}[a${i}]`);
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
