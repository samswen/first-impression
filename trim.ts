import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";

const exec = promisify(execFile);

interface Range {
	start: number;
	end: number;
}

export async function trimVideo(
	videoPath: string,
	excludeRanges: Range[],
	outputPath: string,
	onProgress?: (message: string) => void,
): Promise<void> {
	if (excludeRanges.length === 0) {
		throw new Error("No ranges to exclude — nothing to trim");
	}

	onProgress?.("Probing video duration...");

	// Get video duration
	const { stdout: probeOut } = await exec("ffprobe", [
		"-v",
		"error",
		"-show_entries",
		"format=duration",
		"-of",
		"csv=p=0",
		videoPath,
	]);
	const totalDuration = Number.parseFloat(probeOut.trim());

	// Check if video has audio
	const { stdout: probeStreams } = await exec("ffprobe", [
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

	// Sort exclude ranges by start time
	const sorted = [...excludeRanges].sort((a, b) => a.start - b.start);

	// Compute keep segments (inverse of exclude ranges)
	const keeps: Range[] = [];
	let cursor = 0;

	for (const ex of sorted) {
		if (ex.start > cursor) {
			keeps.push({ start: cursor, end: ex.start });
		}
		cursor = Math.max(cursor, ex.end);
	}

	if (cursor < totalDuration) {
		keeps.push({ start: cursor, end: totalDuration });
	}

	if (keeps.length === 0) {
		throw new Error("All content would be excluded — nothing left to keep");
	}

	const totalExcluded = excludeRanges.reduce(
		(sum, r) => sum + (r.end - r.start),
		0,
	);
	onProgress?.(
		`Trimming ${excludeRanges.length} region(s) (${totalExcluded.toFixed(1)}s) from ${totalDuration.toFixed(1)}s video...`,
	);

	// Build ffmpeg filter_complex
	const filters: string[] = [];
	const concatInputs: string[] = [];

	for (let i = 0; i < keeps.length; i++) {
		const { start, end } = keeps[i];
		filters.push(
			`[0:v]trim=start=${start}:end=${end},setpts=PTS-STARTPTS[v${i}]`,
		);
		if (hasAudio) {
			filters.push(
				`[0:a]atrim=start=${start}:end=${end},asetpts=PTS-STARTPTS[a${i}]`,
			);
			concatInputs.push(`[v${i}][a${i}]`);
		} else {
			concatInputs.push(`[v${i}]`);
		}
	}

	if (hasAudio) {
		filters.push(
			`${concatInputs.join("")}concat=n=${keeps.length}:v=1:a=1[outv][outa]`,
		);
	} else {
		filters.push(
			`${concatInputs.join("")}concat=n=${keeps.length}:v=1:a=0[outv]`,
		);
	}

	const args = [
		"-progress",
		"pipe:1",
		"-i",
		videoPath,
		"-filter_complex",
		filters.join(";"),
		"-map",
		"[outv]",
	];

	if (hasAudio) {
		args.push("-map", "[outa]");
	} else {
		args.push("-an");
	}

	args.push("-y", outputPath);

	// Use spawn to stream progress from ffmpeg stderr
	return new Promise((resolve, reject) => {
		const proc = spawn("ffmpeg", args);

		const expectedDuration = totalDuration - totalExcluded;
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

		proc.stderr.on("data", () => {
			// consume stderr to prevent buffer overflow
		});

		proc.on("close", (code) => {
			if (code === 0) {
				onProgress?.("Trimming complete!");
				resolve();
			} else {
				reject(new Error(`ffmpeg exited with code ${code}`));
			}
		});

		proc.on("error", reject);
	});
}
