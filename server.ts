import "dotenv/config";
import { exec } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import express from "express";
import {
	addVoiceoverToVideo,
	composeVideo,
	deleteRecording,
	deleteVideo,
	freezesPathFor,
	generateIntroOutro,
	generatePreview,
	getRecordingDetails,
	listRecordings,
	pickBestVideo,
	publishRecording,
	renderSpeedVideo,
	runFreezeDetection,
	startRecording,
	trimRecording,
} from "./pipeline";
import type { ProgressEvent } from "./recorder";
import { fetchTenantInfo } from "./tenant";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const RECORDINGS_DIR = path.join(__dirname, "recordings");
const PORT = 3456;

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

// Store active SSE connections per recording ID
const sseClients = new Map<string, express.Response[]>();

// SSE helpers
function setupSSE(res: express.Response) {
	res.setHeader("Content-Type", "text/event-stream");
	res.setHeader("Cache-Control", "no-cache");
	res.setHeader("Connection", "keep-alive");
	res.flushHeaders();
	return (type: string, message: string) => {
		res.write(`data: ${JSON.stringify({ type, message })}\n\n`);
	};
}

function dirFor(id: string): string {
	return path.join(RECORDINGS_DIR, id);
}

function requireDir(id: string, res: express.Response): string | null {
	const dir = dirFor(id);
	if (!fs.existsSync(dir)) {
		res.status(404).json({ error: "Recording not found" });
		return null;
	}
	return dir;
}

// --- API Routes ---

// List all recordings
app.get("/api/recordings", (_req, res) => {
	res.json(listRecordings(RECORDINGS_DIR));
});

// Start a new recording
app.post("/api/recordings", (req, res) => {
	const { url, queries, headed, widgetUrl } = req.body;

	if (!url || !queries || !Array.isArray(queries) || queries.length === 0) {
		return res.status(400).json({ error: "url and queries[] required" });
	}

	const { id, promise } = startRecording(
		RECORDINGS_DIR,
		{ url, queries, headed, widgetUrl },
		(event: ProgressEvent) => {
			const clients = sseClients.get(id) ?? [];
			const data = JSON.stringify(event);
			for (const client of clients) {
				client.write(`data: ${data}\n\n`);
			}
		},
	);

	promise.catch((err) => {
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
	const dir = requireDir(req.params.id, res);
	if (!dir) return;
	res.json(getRecordingDetails(dir));
});

// Delete a recording
app.delete("/api/recordings/:id", (req, res) => {
	const dir = requireDir(req.params.id, res);
	if (!dir) return;
	deleteRecording(dir);
	res.json({ success: true });
});

// Run freeze detection
app.post("/api/recordings/:id/detect-freezes", async (req, res) => {
	const dir = requireDir(req.params.id, res);
	if (!dir) return;
	const videoFile = req.body.video || "raw.webm";

	try {
		const freezes = await runFreezeDetection(dir, videoFile);
		res.json({ freezes });
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		res.status(500).json({ error: message });
	}
});

// Serve freeze frame thumbnails
app.get("/api/recordings/:id/frames/:video/:name", (req, res) => {
	const { id, video, name } = req.params;
	const framePath = path.join(RECORDINGS_DIR, id, `frames-${video}`, name);

	if (!fs.existsSync(framePath)) {
		return res.status(404).json({ error: "Frame not found" });
	}
	res.sendFile(framePath);
});

// Trim video (SSE)
app.post("/api/recordings/:id/trim", async (req, res) => {
	const dir = requireDir(req.params.id, res);
	if (!dir) return;

	const { excludeIds, cutRanges, video } = req.body;
	const videoFile = video || "raw.webm";

	// Resolve exclude ranges from either cutRanges or excludeIds
	let excludeRanges: { start: number; end: number }[] = [];

	if (cutRanges && Array.isArray(cutRanges) && cutRanges.length > 0) {
		excludeRanges = cutRanges.map((r: { start: number; end: number }) => ({
			start: r.start,
			end: r.end,
		}));
	} else if (excludeIds && Array.isArray(excludeIds) && excludeIds.length > 0) {
		const fp = freezesPathFor(dir, videoFile);
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

	const send = setupSSE(res);

	try {
		const result = await trimRecording(dir, videoFile, excludeRanges, (msg) =>
			send("progress", msg),
		);
		send("done", `Created ${result.outputFile}`);
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		send("error", `Trim failed: ${message}`);
	}
	res.end();
});

// Speed-adjusted video (SSE)
app.post("/api/recordings/:id/speed", async (req, res) => {
	const dir = requireDir(req.params.id, res);
	if (!dir) return;

	const { video, speed } = req.body;
	const speedNum = Number.parseFloat(speed);

	if (!speedNum || speedNum <= 0) {
		return res.status(400).json({ error: "Invalid speed" });
	}

	const send = setupSSE(res);

	try {
		const result = await renderSpeedVideo(
			dir,
			video || "raw.webm",
			speedNum,
			(msg) => send("progress", msg),
		);
		send("done", `Created ${result.outputFile}`);
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		send("error", `Speed render failed: ${message}`);
	}
	res.end();
});

// Delete a video (not raw)
app.delete("/api/recordings/:id/video/:file", (req, res) => {
	const dir = requireDir(req.params.id, res);
	if (!dir) return;

	try {
		deleteVideo(dir, req.params.file);
		res.json({ success: true });
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		res.status(400).json({ error: message });
	}
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

// Fetch tenant info
app.get("/api/tenant/:tenantId", async (req, res) => {
	const tenantId = Number(req.params.tenantId);

	if (Number.isNaN(tenantId)) {
		return res.status(400).json({ error: "Invalid tenant ID" });
	}

	try {
		const info = await fetchTenantInfo(tenantId);
		res.json(info);
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		console.error(`[Tenant] Failed to fetch tenant ${tenantId}:`, message);
		res.status(502).json({ error: message });
	}
});

// Add voiceover (SSE)
app.post("/api/recordings/:id/voiceover", async (req, res) => {
	const dir = requireDir(req.params.id, res);
	if (!dir) return;

	const { tenantId, video } = req.body;
	if (!tenantId || Number.isNaN(Number(tenantId))) {
		return res.status(400).json({ error: "tenantId required (number)" });
	}

	const send = setupSSE(res);

	try {
		const result = await addVoiceoverToVideo(
			dir,
			video || "raw.webm",
			Number(tenantId),
			(msg) => send("progress", msg),
		);
		send("done", `Voiceover added: ${result.clipCount} clips`);
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		send("error", `Voiceover failed: ${message}`);
	}
	res.end();
});

// Compose final video (SSE)
app.post("/api/recordings/:id/compose", async (req, res) => {
	const dir = requireDir(req.params.id, res);
	if (!dir) return;

	const send = setupSSE(res);

	try {
		const result = await composeVideo(dir, req.body.video, (msg) =>
			send("progress", msg),
		);
		send("done", `Final video: ${result.sizeMB.toFixed(1)}MB`);
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		send("error", `Compose failed: ${message}`);
	}
	res.end();
});

// Generate intro & outro (SSE)
app.post("/api/recordings/:id/intro", async (req, res) => {
	const dir = requireDir(req.params.id, res);
	if (!dir) return;

	const { tenantId } = req.body;
	if (!tenantId || Number.isNaN(Number(tenantId))) {
		return res.status(400).json({ error: "tenantId required (number)" });
	}

	const send = setupSSE(res);

	try {
		const result = await generateIntroOutro(dir, Number(tenantId), (msg) =>
			send("progress", msg),
		);
		send(
			"done",
			`Intro (${result.intro.duration.toFixed(1)}s) + Outro (${result.outro.duration.toFixed(1)}s) ready`,
		);
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		send("error", `Failed: ${message}`);
	}
	res.end();
});

// Preview demo page
app.post("/api/recordings/:id/preview", async (req, res) => {
	const dir = requireDir(req.params.id, res);
	if (!dir) return;

	const { tenantId } = req.body;
	if (!tenantId || Number.isNaN(Number(tenantId))) {
		return res.status(400).json({ error: "tenantId required (number)" });
	}

	try {
		const bestVideo = pickBestVideo(dir);
		const videoUrl = `http://localhost:${PORT}/api/recordings/${req.params.id}/video/${bestVideo}`;
		const html = await generatePreview(dir, Number(tenantId), videoUrl);
		res.setHeader("Content-Type", "text/html; charset=utf-8");
		res.send(html);
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		console.error(`[Preview] Failed:`, message);
		res.status(500).json({ error: message });
	}
});

// Publish demo to S3
app.post("/api/recordings/:id/publish", async (req, res) => {
	const dir = requireDir(req.params.id, res);
	if (!dir) return;

	const { tenantId } = req.body;
	if (!tenantId || Number.isNaN(Number(tenantId))) {
		return res.status(400).json({ error: "tenantId required (number)" });
	}

	try {
		const result = await publishRecording(dir, Number(tenantId));
		res.json(result);
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		console.error(`[Publish] Failed:`, message);
		res.status(500).json({ error: message });
	}
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
