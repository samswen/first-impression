import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import type { TimelineEntry } from "./recorder";

const exec = promisify(execFile);

export interface FreezeEntry {
	id: number;
	start: number;
	end: number;
	duration: number;
	action: string;
	framePath: string;
}

function findParentAction(time: number, timeline: TimelineEntry[]): string {
	for (const entry of timeline) {
		if (time >= entry.startTime && time <= entry.endTime) {
			return entry.action;
		}
	}
	return "unknown";
}

export async function detectFreezes(
	videoPath: string,
	timeline: TimelineEntry[],
	framesDir?: string,
): Promise<FreezeEntry[]> {
	const dir = framesDir ?? path.join(path.dirname(videoPath), "frames");
	fs.mkdirSync(dir, { recursive: true });

	// Run ffmpeg freeze detection
	const { stderr } = await exec(
		"ffmpeg",
		["-i", videoPath, "-vf", "freezedetect=n=0.002:d=2.0", "-f", "null", "-"],
		{ maxBuffer: 10 * 1024 * 1024 },
	).catch((err) => {
		// ffmpeg writes to stderr even on success
		if (err.stderr) return { stdout: err.stdout || "", stderr: err.stderr };
		throw err;
	});

	// Parse freeze events from stderr
	const freezeStartRegex = /freeze_start:\s*([\d.]+)/g;
	const freezeEndRegex = /freeze_end:\s*([\d.]+)/g;
	const freezeDurationRegex = /freeze_duration:\s*([\d.]+)/g;

	const starts: number[] = [];
	const ends: number[] = [];
	const durations: number[] = [];

	let match: RegExpExecArray | null;
	match = freezeStartRegex.exec(stderr);
	while (match) {
		starts.push(Number.parseFloat(match[1]));
		match = freezeStartRegex.exec(stderr);
	}
	match = freezeEndRegex.exec(stderr);
	while (match) {
		ends.push(Number.parseFloat(match[1]));
		match = freezeEndRegex.exec(stderr);
	}
	match = freezeDurationRegex.exec(stderr);
	while (match) {
		durations.push(Number.parseFloat(match[1]));
		match = freezeDurationRegex.exec(stderr);
	}

	const freezes: FreezeEntry[] = [];

	for (let i = 0; i < starts.length; i++) {
		const start = starts[i];
		const end = ends[i] ?? start + (durations[i] ?? 0);
		const duration = durations[i] ?? end - start;
		const mid = start + duration / 2;
		const frameName = `freeze-${i}.jpg`;
		const framePath = path.join(dir, frameName);

		// Extract thumbnail at the midpoint of the freeze
		try {
			await exec("ffmpeg", [
				"-ss",
				String(mid),
				"-i",
				videoPath,
				"-frames:v",
				"1",
				"-y",
				framePath,
			]);
		} catch {
			// Frame extraction can fail for very short freezes near edges
		}

		freezes.push({
			id: i,
			start,
			end,
			duration,
			action: findParentAction(mid, timeline),
			framePath: frameName,
		});
	}

	return freezes;
}
