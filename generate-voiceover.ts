/**
 * Generate voiceover audio clips from the voiceover JSON
 * and mix them into the trimmed screencast video.
 *
 * Usage: npx tsx generate-voiceover.ts
 */

import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import { textToSpeech } from "./voice";

const execP = promisify(execFile);

const NAME = process.argv[2] ?? "1-install";
const SCREENCAST_DIR = path.join(__dirname, "recordings/screencast");
const VOICEOVER_JSON = path.join(SCREENCAST_DIR, `${NAME}-voiceover.json`);
const VIDEO_INPUT = fs.existsSync(path.join(SCREENCAST_DIR, `${NAME}-trimmed.webm`))
	? path.join(SCREENCAST_DIR, `${NAME}-trimmed.webm`)
	: path.join(SCREENCAST_DIR, `${NAME}.webm`);
const VIDEO_OUTPUT = path.join(SCREENCAST_DIR, `${NAME}-voiced.webm`);
const CLIPS_DIR = path.join(SCREENCAST_DIR, `voiceover-clips-${NAME}`);

interface VoiceoverSegment {
	start: number;
	end: number;
	text: string;
}

async function getAudioDuration(filePath: string): Promise<number> {
	const { stdout } = await execP("ffprobe", [
		"-v", "error",
		"-show_entries", "format=duration",
		"-of", "csv=p=0",
		filePath,
	]);
	return Number.parseFloat(stdout.trim());
}

async function main() {
	const segments: VoiceoverSegment[] = JSON.parse(
		fs.readFileSync(VOICEOVER_JSON, "utf-8"),
	);

	if (!fs.existsSync(VIDEO_INPUT)) {
		throw new Error(`Video not found: ${VIDEO_INPUT}`);
	}

	// Create clips directory
	if (!fs.existsSync(CLIPS_DIR)) {
		fs.mkdirSync(CLIPS_DIR, { recursive: true });
	}

	// 1. Generate TTS for each segment
	console.log(`Generating ${segments.length} voiceover clips...`);

	const clips: { path: string; start: number; duration: number; text: string }[] = [];

	for (let i = 0; i < segments.length; i++) {
		const seg = segments[i];
		const clipPath = path.join(CLIPS_DIR, `clip-${String(i).padStart(2, "0")}.mp3`);

		// Skip if already generated (cache)
		if (fs.existsSync(clipPath) && fs.statSync(clipPath).size > 0) {
			const duration = await getAudioDuration(clipPath);
			console.log(`  [${i + 1}/${segments.length}] cached (${duration.toFixed(1)}s): "${seg.text.slice(0, 60)}..."`);
			clips.push({ path: clipPath, start: seg.start, duration, text: seg.text });
			continue;
		}

		console.log(`  [${i + 1}/${segments.length}] TTS: "${seg.text.slice(0, 60)}..."`);
		const audioBuffer = await textToSpeech({ text: seg.text });
		fs.writeFileSync(clipPath, audioBuffer);

		const duration = await getAudioDuration(clipPath);
		const available = seg.end - seg.start;
		if (duration > available + 1) {
			console.warn(`    WARNING: clip is ${duration.toFixed(1)}s but window is ${available.toFixed(1)}s`);
		}
		clips.push({ path: clipPath, start: seg.start, duration, text: seg.text });
	}

	// Save manifest
	fs.writeFileSync(
		path.join(CLIPS_DIR, "manifest.json"),
		JSON.stringify(clips.map((c, i) => ({
			file: `clip-${String(i).padStart(2, "0")}.mp3`,
			start: c.start,
			duration: c.duration,
			text: c.text,
		})), null, 2),
	);

	console.log(`\n${clips.length} clips ready. Composing audio mix...`);

	// 2. Get video duration
	const { stdout: videoDurOut } = await execP("ffprobe", [
		"-v", "error",
		"-show_entries", "format=duration",
		"-of", "csv=p=0",
		VIDEO_INPUT,
	]);
	const videoDuration = Number.parseFloat(videoDurOut.trim());
	console.log(`Video duration: ${videoDuration.toFixed(1)}s`);

	// 3. Build ffmpeg command to mix all clips onto the video
	const args: string[] = ["-i", VIDEO_INPUT];
	for (const clip of clips) {
		args.push("-i", clip.path);
	}

	const filterParts: string[] = [];
	const mixInputs: string[] = [];

	for (let i = 0; i < clips.length; i++) {
		const delayMs = Math.round(clips[i].start * 1000);
		const inputIdx = i + 1;
		filterParts.push(
			`[${inputIdx}:a]adelay=${delayMs}|${delayMs}[a${i}]`,
		);
		mixInputs.push(`[a${i}]`);
	}

	filterParts.push(
		`${mixInputs.join("")}amix=inputs=${clips.length}:duration=longest:normalize=0[aout]`,
	);

	args.push(
		"-filter_complex", filterParts.join(";"),
		"-map", "0:v",
		"-map", "[aout]",
		"-c:v", "copy",
		"-c:a", "libopus",
		"-t", String(videoDuration),
		"-y", VIDEO_OUTPUT,
	);

	console.log("Running ffmpeg...");
	const { stderr } = await execP("ffmpeg", args, {
		maxBuffer: 10 * 1024 * 1024,
	});

	if (!fs.existsSync(VIDEO_OUTPUT)) {
		throw new Error(`ffmpeg failed: ${stderr.split("\n").slice(-3).join(" ")}`);
	}

	const stat = fs.statSync(VIDEO_OUTPUT);
	console.log(`\nDone! ${VIDEO_OUTPUT}`);
	console.log(`Size: ${(stat.size / 1024 / 1024).toFixed(1)}MB`);
}

main().catch((err) => {
	console.error("Error:", err.message);
	process.exit(1);
});
