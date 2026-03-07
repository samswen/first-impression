import { exec } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import express from "express";
import { detectFreezes } from "./freeze-detect";
import { type ProgressEvent, Recorder, type TimelineEntry } from "./recorder";
import { trimVideo } from "./trim";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const RECORDINGS_DIR = path.join(__dirname, "recordings");
const PORT = 3456;

const app = express();
app.use(express.json());

// Serve static files from public/
app.use(express.static(path.join(__dirname, "public")));

// Store active SSE connections per recording ID
const sseClients = new Map<string, express.Response[]>();

// Helper: list all video files in a recording directory
function listVideos(dir: string): string[] {
	if (!fs.existsSync(dir)) return [];
	return fs
		.readdirSync(dir)
		.filter((f) => f.endsWith(".webm"))
		.sort((a, b) => {
			// raw first, then trimmed-1, trimmed-2, etc.
			if (a === "raw.webm") return -1;
			if (b === "raw.webm") return 1;
			return a.localeCompare(b, undefined, { numeric: true });
		});
}

// Helper: get freeze file path for a given video
function freezesPathFor(dir: string, video: string): string {
	const base = video.replace(".webm", "");
	return path.join(dir, `freezes-${base}.json`);
}

// Helper: get frames dir for a given video
function framesDirFor(dir: string, video: string): string {
	const base = video.replace(".webm", "");
	return path.join(dir, `frames-${base}`);
}

// Helper: get timeline file path for a given video
function timelinePathFor(dir: string, video: string): string {
	if (video === "raw.webm") return path.join(dir, "timeline.json");
	const base = video.replace(".webm", "");
	return path.join(dir, `timeline-${base}.json`);
}

// Helper: parse speed factor from a video filename (e.g. "raw-speed-2x.webm" → 2)
function parseSpeedFromName(video: string): number | null {
	const m = video.match(/speed-([\d.]+)x\.webm$/);
	if (m) return Number.parseFloat(m[1]);
	const mth = video.match(/speed-([\d.]+)th\.webm$/);
	if (mth) return 1 / Number.parseFloat(mth[1]);
	return null;
}

// Helper: get the source video name (e.g. "raw-speed-2x.webm" → "raw.webm", "trimmed-1-speed-2x.webm" → "trimmed-1.webm")
function sourceVideoName(video: string): string {
	return video.replace(/-speed-[\w.]+\.webm$/, ".webm");
}

// Helper: read timeline for a video (falls back to computed or raw)
function readTimeline(dir: string, video: string): TimelineEntry[] {
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
			// Save it for next time
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

// Compute adjusted timeline after removing exclude ranges
function computeTrimmedTimeline(
	timeline: TimelineEntry[],
	excludeRanges: { start: number; end: number }[],
): TimelineEntry[] {
	const sorted = [...excludeRanges].sort((a, b) => a.start - b.start);

	// For a given time, compute how much total excluded time precedes it
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
			});
		}
	}
	return result;
}

// Compute adjusted timeline after speed change
function computeSpeedTimeline(
	timeline: TimelineEntry[],
	speed: number,
): TimelineEntry[] {
	return timeline.map((entry) => ({
		action: entry.action,
		label: entry.label,
		startTime: entry.startTime / speed,
		endTime: entry.endTime / speed,
	}));
}

// Helper: compute next trimmed filename
function nextTrimmedName(dir: string): string {
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

// --- API Routes ---

// List all recordings
app.get("/api/recordings", (_req, res) => {
	if (!fs.existsSync(RECORDINGS_DIR)) {
		return res.json([]);
	}

	const dirs = fs
		.readdirSync(RECORDINGS_DIR, { withFileTypes: true })
		.filter((d) => d.isDirectory())
		.map((d) => {
			const id = d.name;
			const dirPath = path.join(RECORDINGS_DIR, id);
			const timelinePath = path.join(dirPath, "timeline.json");
			const hasRaw = fs.existsSync(path.join(dirPath, "raw.webm"));
			const videos = listVideos(dirPath);
			const trimCount = videos.filter((v) => v.startsWith("trimmed-")).length;

			let timeline: TimelineEntry[] = [];
			if (fs.existsSync(timelinePath)) {
				timeline = JSON.parse(fs.readFileSync(timelinePath, "utf-8"));
			}

			return {
				id,
				hasRaw,
				trimCount,
				queryCount: timeline.filter((t) => t.action.startsWith("query-"))
					.length,
				url: timeline.find((t) => t.action === "page-load")?.label ?? "",
				status: trimCount > 0 ? "trimmed" : hasRaw ? "recorded" : "in-progress",
			};
		})
		.sort((a, b) => b.id.localeCompare(a.id));

	res.json(dirs);
});

// Start a new recording
app.post("/api/recordings", (req, res) => {
	const { url, queries, headed } = req.body;

	if (!url || !queries || !Array.isArray(queries) || queries.length === 0) {
		return res.status(400).json({ error: "url and queries[] required" });
	}

	const id = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
	const dir = path.join(RECORDINGS_DIR, id);

	const recorder = new Recorder({
		url,
		queries,
		headed: headed === true,
		recordingDir: dir,
	});

	// Start recording in background
	recorder
		.run((event: ProgressEvent) => {
			const clients = sseClients.get(id) ?? [];
			const data = JSON.stringify(event);
			for (const client of clients) {
				client.write(`data: ${data}\n\n`);
			}
		})
		.catch((err) => {
			const clients = sseClients.get(id) ?? [];
			const data = JSON.stringify({
				type: "error",
				message: err.message,
				timestamp: Date.now(),
			});
			for (const client of clients) {
				client.write(`data: ${data}\n\n`);
			}
		});

	res.json({ id });
});

// SSE stream for recording progress
app.get("/api/recordings/:id/events", (req, res) => {
	const { id } = req.params;

	res.setHeader("Content-Type", "text/event-stream");
	res.setHeader("Cache-Control", "no-cache");
	res.setHeader("Connection", "keep-alive");
	res.flushHeaders();

	const clients = sseClients.get(id) ?? [];
	clients.push(res);
	sseClients.set(id, clients);

	req.on("close", () => {
		const remaining = (sseClients.get(id) ?? []).filter((c) => c !== res);
		if (remaining.length === 0) {
			sseClients.delete(id);
		} else {
			sseClients.set(id, remaining);
		}
	});
});

// Get recording details
app.get("/api/recordings/:id", (req, res) => {
	const { id } = req.params;
	const dir = path.join(RECORDINGS_DIR, id);

	if (!fs.existsSync(dir)) {
		return res.status(404).json({ error: "Recording not found" });
	}

	const timelinePath = path.join(dir, "timeline.json");
	const timeline = fs.existsSync(timelinePath)
		? JSON.parse(fs.readFileSync(timelinePath, "utf-8"))
		: [];

	// Build per-video info
	const videos = listVideos(dir).map((file) => {
		const fp = freezesPathFor(dir, file);
		const freezes = fs.existsSync(fp)
			? JSON.parse(fs.readFileSync(fp, "utf-8"))
			: null;
		const videoTimeline = readTimeline(dir, file);
		return { file, freezes, timeline: videoTimeline };
	});

	res.json({ id, timeline, videos });
});

// Delete a recording
app.delete("/api/recordings/:id", (req, res) => {
	const { id } = req.params;
	const dir = path.join(RECORDINGS_DIR, id);

	if (!fs.existsSync(dir)) {
		return res.status(404).json({ error: "Recording not found" });
	}

	fs.rmSync(dir, { recursive: true, force: true });
	res.json({ success: true });
});

// Run freeze detection on a specific video
app.post("/api/recordings/:id/detect-freezes", async (req, res) => {
	const { id } = req.params;
	const { video } = req.body;
	const videoFile = video || "raw.webm";

	const dir = path.join(RECORDINGS_DIR, id);
	const videoPath = path.join(dir, videoFile);

	if (!fs.existsSync(videoPath)) {
		return res.status(404).json({ error: `${videoFile} not found` });
	}

	// Use the per-video timeline (falls back to raw)
	const timeline = readTimeline(dir, videoFile);

	try {
		const freezes = await detectFreezes(
			videoPath,
			timeline,
			framesDirFor(dir, videoFile),
		);
		// Write freezes to per-video file
		const fp = freezesPathFor(dir, videoFile);
		fs.writeFileSync(fp, JSON.stringify(freezes, null, 2));
		res.json({ freezes });
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		res.status(500).json({ error: message });
	}
});

// Serve freeze frame thumbnails for a specific video
app.get("/api/recordings/:id/frames/:video/:name", (req, res) => {
	const { id, video, name } = req.params;
	const framePath = path.join(RECORDINGS_DIR, id, `frames-${video}`, name);

	if (!fs.existsSync(framePath)) {
		return res.status(404).json({ error: "Frame not found" });
	}

	res.sendFile(framePath);
});

// Trim video (SSE progress stream)
app.post("/api/recordings/:id/trim", async (req, res) => {
	const { id } = req.params;
	const { excludeIds, cutRanges, video } = req.body;
	const videoFile = video || "raw.webm";

	const dir = path.join(RECORDINGS_DIR, id);
	const videoPath = path.join(dir, videoFile);
	const fp = freezesPathFor(dir, videoFile);
	const outputFile = nextTrimmedName(dir);
	const outputPath = path.join(dir, outputFile);

	if (!fs.existsSync(videoPath)) {
		return res.status(404).json({ error: `${videoFile} not found` });
	}

	// Build exclude ranges from either cutRanges (edit bar) or excludeIds (freeze checkboxes)
	let excludeRanges: { start: number; end: number }[] = [];

	if (cutRanges && Array.isArray(cutRanges) && cutRanges.length > 0) {
		excludeRanges = cutRanges.map((r: { start: number; end: number }) => ({
			start: r.start,
			end: r.end,
		}));
	} else if (excludeIds && Array.isArray(excludeIds) && excludeIds.length > 0) {
		if (!fs.existsSync(fp)) {
			return res.status(400).json({ error: "Run freeze detection first" });
		}
		const freezes = JSON.parse(fs.readFileSync(fp, "utf-8"));
		excludeRanges = freezes
			.filter((f: { id: number }) => excludeIds.includes(f.id))
			.map((f: { start: number; end: number }) => ({
				start: f.start,
				end: f.end,
			}));
	}

	if (excludeRanges.length === 0) {
		return res.status(400).json({ error: "No ranges to exclude" });
	}

	// Switch to SSE
	res.setHeader("Content-Type", "text/event-stream");
	res.setHeader("Cache-Control", "no-cache");
	res.setHeader("Connection", "keep-alive");
	res.flushHeaders();

	const send = (type: string, message: string) => {
		res.write(`data: ${JSON.stringify({ type, message })}\n\n`);
	};

	try {
		send("progress", `Trimming ${videoFile} → ${outputFile}...`);
		await trimVideo(videoPath, excludeRanges, outputPath, (message) => {
			send("progress", message);
		});

		// Compute and save adjusted timeline for the trimmed video
		const sourceTimeline = readTimeline(dir, videoFile);
		const trimmedTimeline = computeTrimmedTimeline(
			sourceTimeline,
			excludeRanges,
		);
		fs.writeFileSync(
			timelinePathFor(dir, outputFile),
			JSON.stringify(trimmedTimeline, null, 2),
		);

		send("done", `Created ${outputFile}`);
		res.end();
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		send("error", `Trim failed: ${message}`);
		res.end();
	}
});

// Speed-adjusted video (WYSIWYG)
app.post("/api/recordings/:id/speed", async (req, res) => {
	const { id } = req.params;
	const { video, speed } = req.body;
	const videoFile = video || "raw.webm";
	const speedNum = Number.parseFloat(speed);

	if (!speedNum || speedNum <= 0) {
		return res.status(400).json({ error: "Invalid speed" });
	}

	const dir = path.join(RECORDINGS_DIR, id);
	const videoPath = path.join(dir, videoFile);

	if (!fs.existsSync(videoPath)) {
		return res.status(404).json({ error: `${videoFile} not found` });
	}

	// Name: speed-2x.webm, speed-0.5x.webm, etc.
	const speedLabel =
		speedNum < 1
			? `${(1 / speedNum).toFixed(1).replace(/\.0$/, "")}th`
			: `${speedNum.toString().replace(/\.0$/, "")}x`;
	const base = videoFile.replace(".webm", "");
	const outputFile = `${base}-speed-${speedLabel}.webm`;
	const outputPath = path.join(dir, outputFile);

	// SSE
	res.setHeader("Content-Type", "text/event-stream");
	res.setHeader("Cache-Control", "no-cache");
	res.setHeader("Connection", "keep-alive");
	res.flushHeaders();

	const send = (type: string, message: string) => {
		res.write(`data: ${JSON.stringify({ type, message })}\n\n`);
	};

	try {
		send("progress", `Rendering at ${speedLabel} speed...`);

		const { spawn } = await import("node:child_process");
		const { execFile } = await import("node:child_process");
		const { promisify } = await import("node:util");
		const execP = promisify(execFile);

		// Check if video has an audio stream
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
		const expectedDuration = srcDuration / speedNum;

		// Build ffmpeg args
		const args = ["-progress", "pipe:1", "-i", videoPath];

		if (hasAudio) {
			// Build atempo chain (atempo supports 0.5-100.0 per instance)
			const atempoFilters: string[] = [];
			let remaining = speedNum;
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
				`[0:v]setpts=PTS/${speedNum}[v];[0:a]${atempoFilters.join(",")}[a]`,
				"-map",
				"[v]",
				"-map",
				"[a]",
			);
		} else {
			args.push("-vf", `setpts=PTS/${speedNum}`, "-an");
		}

		args.push("-y", outputPath);

		const proc = spawn("ffmpeg", args);

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
						send("progress", `Encoding... ${percent}%`);
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
					// Compute and save adjusted timeline for the speed video
					const sourceTimeline = readTimeline(dir, videoFile);
					const speedTimeline = computeSpeedTimeline(sourceTimeline, speedNum);
					fs.writeFileSync(
						timelinePathFor(dir, outputFile),
						JSON.stringify(speedTimeline, null, 2),
					);

					send("done", `Created ${outputFile}`);
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

		res.end();
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		send("error", `Speed render failed: ${message}`);
		res.end();
	}
});

// Delete a video (not raw)
app.delete("/api/recordings/:id/video/:file", (req, res) => {
	const { id, file } = req.params;

	if (file === "raw.webm") {
		return res.status(400).json({ error: "Cannot delete raw video" });
	}

	const dir = path.join(RECORDINGS_DIR, id);
	const videoPath = path.join(dir, file);

	if (!fs.existsSync(videoPath)) {
		return res.status(404).json({ error: "Video not found" });
	}

	// Delete video file
	fs.unlinkSync(videoPath);

	// Delete associated files (freezes, frames, timeline)
	const base = file.replace(".webm", "");
	const freezesFile = path.join(dir, `freezes-${base}.json`);
	const framesDir = path.join(dir, `frames-${base}`);
	const timelineFile = path.join(dir, `timeline-${base}.json`);

	if (fs.existsSync(freezesFile)) fs.unlinkSync(freezesFile);
	if (fs.existsSync(framesDir)) fs.rmSync(framesDir, { recursive: true });
	if (fs.existsSync(timelineFile)) fs.unlinkSync(timelineFile);

	res.json({ success: true });
});

// Serve video files
app.get("/api/recordings/:id/video/:file", (req, res) => {
	const { id, file } = req.params;

	if (!file.endsWith(".webm")) {
		return res.status(400).json({ error: "Invalid video file" });
	}

	const videoPath = path.join(RECORDINGS_DIR, id, file);
	if (!fs.existsSync(videoPath)) {
		return res.status(404).json({ error: "Video not found" });
	}

	res.sendFile(videoPath);
});

app.listen(PORT, () => {
	const url = `http://localhost:${PORT}`;
	console.log(`First Impression running at ${url}`);

	// Auto-open browser
	const cmd =
		process.platform === "darwin"
			? "open"
			: process.platform === "win32"
				? "start"
				: "xdg-open";
	exec(`${cmd} ${url}`);
});
