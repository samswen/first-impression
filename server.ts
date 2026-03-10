import "dotenv/config";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import cookieParser from "cookie-parser";
import express from "express";
import type { Browser } from "playwright";
import { chromium } from "playwright";
import {
	clearSessionCookie,
	createSessionToken,
	requireAuth,
	setSessionCookie,
	verifySessionToken,
} from "./auth";
import {
	addVoiceoverToVideo,
	composeVideo,
	deleteRecording,
	deleteVideo,
	freezesPathFor,
	generateIntroOutro,
	generatePreview,
	getRecordingDetails,
	getVoiceClips,
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
import { deleteTTSCache } from "./voice";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const RECORDINGS_DIR = path.join(__dirname, "recordings");
const PORT = 3456;

const app = express();

// HTTP request logger
app.use((req, res, next) => {
	const start = Date.now();
	res.on("finish", () => {
		const ms = Date.now() - start;
		console.log(
			`[${req.method}] ${req.originalUrl} - ${res.statusCode} - ${ms}ms`,
		);
	});
	next();
});

app.use(express.json());
app.use(cookieParser());
app.use(
	express.static(path.join(__dirname, "public"), {
		etag: false,
		lastModified: false,
		setHeaders(res, filePath) {
			if (filePath.endsWith(".html")) {
				res.set("Cache-Control", "no-store");
			}
		},
	}),
);

const RAG_CHATBOT_BASE_URL = process.env.RAG_CHATBOT_BASE_URL || "";
const FIRST_IMPRESSION_SECRET = process.env.FIRST_IMPRESSION_SECRET || "";
const FIRST_IMPRESSION_API_KEY = process.env.FIRST_IMPRESSION_API_KEY || "";

// Store active SSE connections per recording ID
const sseClients = new Map<string, express.Response[]>();

// Store abort controllers for active recordings
const recordingAborts = new Map<string, AbortController>();

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

function userDir(req: express.Request): string {
	const userId = req.user?.userId;
	if (!userId) throw new Error("No authenticated user");
	return path.join(RECORDINGS_DIR, String(userId));
}

function dirFor(req: express.Request, id: string): string {
	return path.join(userDir(req), id);
}

function requireDir(
	req: express.Request,
	id: string,
	res: express.Response,
): string | null {
	const dir = dirFor(req, id);
	if (!fs.existsSync(dir)) {
		res.status(404).json({ error: "Recording not found" });
		return null;
	}
	return dir;
}

// --- Auth Routes (public, no requireAuth) ---

// Check auth status (no caching — must always reflect current cookie state)
app.get("/auth/status", (req, res) => {
	res.set({
		"Cache-Control": "no-store, no-cache, must-revalidate",
		Pragma: "no-cache",
		ETag: "",
	});
	const token = req.cookies?.fi_session;
	if (!token) {
		return res.json({ authenticated: false });
	}
	const user = verifySessionToken(token);
	if (!user) {
		return res.json({ authenticated: false });
	}
	res.json({ authenticated: true, user });
});

// Request magic link
app.post("/auth/magic-link", async (req, res) => {
	const { email } = req.body;
	if (!email || typeof email !== "string") {
		return res.status(400).json({ error: "email is required" });
	}

	try {
		const protocol = req.protocol;
		const host = req.get("host") || `localhost:${PORT}`;
		const callbackBaseUrl = `${protocol}://${host}`;

		const apiRes = await fetch(
			`${RAG_CHATBOT_BASE_URL}/api/first-impression/auth/magic-link`,
			{
				method: "POST",
				headers: {
					"Content-Type": "application/json",
					"X-FI-Auth-Secret": FIRST_IMPRESSION_SECRET,
				},
				body: JSON.stringify({ email, callbackBaseUrl }),
			},
		);

		const data = await apiRes.json();
		res.status(apiRes.status).json(data);
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		console.error("[Auth] Magic link error:", message);
		res.status(502).json({ error: "Auth service unavailable" });
	}
});

// Magic link callback — verify token, set session cookie, redirect
app.get("/auth/callback", async (req, res) => {
	const { token } = req.query;
	if (!token || typeof token !== "string") {
		return res.redirect("/?error=invalid_or_expired_token");
	}

	try {
		const apiRes = await fetch(
			`${RAG_CHATBOT_BASE_URL}/api/first-impression/auth/verify-token`,
			{
				method: "POST",
				headers: {
					"Content-Type": "application/json",
					"X-FI-Auth-Secret": FIRST_IMPRESSION_SECRET,
				},
				body: JSON.stringify({ token }),
			},
		);

		if (!apiRes.ok) {
			return res.redirect("/?error=invalid_or_expired_token");
		}

		const { user } = await apiRes.json();
		const sessionToken = createSessionToken({
			userId: user.id,
			email: user.email,
			name: user.name,
		});
		setSessionCookie(res, sessionToken);
		res.redirect("/");
	} catch (err) {
		console.error("[Auth] Callback error:", err);
		res.redirect("/?error=invalid_or_expired_token");
	}
});

// Logout
app.post("/auth/logout", (_req, res) => {
	clearSessionCookie(res);
	res.json({ success: true });
});

// --- Protected API Routes ---
app.use("/api", requireAuth);

// Invite a new user
app.post("/api/invite", async (req, res) => {
	const { email, name } = req.body;
	if (!email || typeof email !== "string") {
		return res.status(400).json({ error: "email is required" });
	}

	try {
		const protocol = req.protocol;
		const host = req.get("host") || `localhost:${PORT}`;
		const callbackBaseUrl = `${protocol}://${host}`;

		const apiRes = await fetch(
			`${RAG_CHATBOT_BASE_URL}/api/first-impression/auth/invite`,
			{
				method: "POST",
				headers: {
					"Content-Type": "application/json",
					Authorization: `Bearer ${FIRST_IMPRESSION_API_KEY}`,
				},
				body: JSON.stringify({
					email,
					name,
					callbackBaseUrl,
					inviterName: req.user?.name,
				}),
			},
		);

		const data = await apiRes.json();
		res.status(apiRes.status).json(data);
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		console.error("[Auth] Invite error:", message);
		res.status(502).json({ error: "Auth service unavailable" });
	}
});

// --- API Routes ---

// List demo tenants (proxied from rag-chatbot)
app.get("/api/demo-tenants", async (_req, res) => {
	try {
		const r = await fetch(
			`${RAG_CHATBOT_BASE_URL}/api/first-impression/demo-tenants`,
			{
				headers: { Authorization: `Bearer ${FIRST_IMPRESSION_API_KEY}` },
			},
		);
		const data = await r.json();
		res.status(r.status).json(data);
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		console.error("[DemoTenants] Error:", message);
		res.status(502).json({ error: "Failed to fetch demo tenants" });
	}
});

// List tenants the user has worked with (published + in-progress)
app.get("/api/tenants", async (req, res) => {
	const dir = userDir(req);

	// Gather tenant IDs from local recordings
	const localTenants = new Map<
		number,
		{ tenantId: number; recordingCount: number }
	>();
	if (fs.existsSync(dir)) {
		for (const rec of listRecordings(dir)) {
			if (rec.tenantId) {
				const existing = localTenants.get(rec.tenantId);
				if (existing) {
					existing.recordingCount++;
				} else {
					localTenants.set(rec.tenantId, {
						tenantId: rec.tenantId,
						recordingCount: 1,
					});
				}
			}
		}
	}

	// Fetch published demos from rag-chatbot (cross-user via tenantIds)
	let published: {
		tenant_id: number;
		slug: string;
		version: number;
		url: string;
		config: unknown;
		tenant_snapshot: unknown;
		created_at: string;
	}[] = [];
	try {
		const baseUrl = process.env.RAG_CHATBOT_BASE_URL;
		const apiKey = process.env.FIRST_IMPRESSION_API_KEY;
		if (baseUrl && apiKey) {
			// Collect all known tenant IDs to query across all users
			const allTenantIds = [...localTenants.keys()];
			const qs =
				allTenantIds.length > 0 ? `?tenantIds=${allTenantIds.join(",")}` : "";
			const r = await fetch(`${baseUrl}/api/first-impression/published${qs}`, {
				headers: { Authorization: `Bearer ${apiKey}` },
			});
			if (r.ok) {
				const data = await r.json();
				published = data.published || [];
			}
		}
	} catch {
		// Non-fatal — just skip published data
	}

	// Group published records by tenant_id
	const publishedByTenant = new Map<
		number,
		{ version: number; url: string; createdAt: string; slug: string }[]
	>();
	for (const p of published) {
		let versions = publishedByTenant.get(p.tenant_id);
		if (!versions) {
			versions = [];
			publishedByTenant.set(p.tenant_id, versions);
		}
		versions.push({
			version: p.version,
			url: p.url,
			createdAt: p.created_at,
			slug: p.slug,
		});
	}

	// Build unified tenant list
	const tenantMap = new Map<
		number,
		{
			tenantId: number;
			published: boolean;
			recordingCount: number;
			versions: {
				version: number;
				url: string;
				createdAt: string;
				slug: string;
			}[];
			config?: unknown;
			tenantSnapshot?: unknown;
		}
	>();

	// Add published tenants
	for (const [tid, versions] of publishedByTenant) {
		// versions are already sorted desc by created_at from the API
		const latest = published.find((p) => p.tenant_id === tid);
		tenantMap.set(tid, {
			tenantId: tid,
			published: true,
			recordingCount: localTenants.get(tid)?.recordingCount || 0,
			versions,
			config: latest?.config,
			tenantSnapshot: latest?.tenant_snapshot,
		});
	}

	// Add local-only tenants (not yet published)
	for (const [tid, local] of localTenants) {
		if (!tenantMap.has(tid)) {
			tenantMap.set(tid, {
				tenantId: tid,
				published: false,
				recordingCount: local.recordingCount,
				versions: [],
			});
		}
	}

	res.json(Array.from(tenantMap.values()));
});

// List all recordings
app.get("/api/recordings", (req, res) => {
	const dir = userDir(req);
	if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
	res.json(listRecordings(dir));
});

// Start a new recording
app.post("/api/recordings", (req, res) => {
	const { url, queries, headed, widgetUrl, tenantId } = req.body;

	if (!url || !queries || !Array.isArray(queries) || queries.length === 0) {
		return res.status(400).json({ error: "url and queries[] required" });
	}

	const uDir = userDir(req);
	if (!fs.existsSync(uDir)) fs.mkdirSync(uDir, { recursive: true });
	let recordingId = "";
	const tid = tenantId ? Number(tenantId) : undefined;
	const abortController = new AbortController();
	const { id, promise } = startRecording(
		uDir,
		{ url, queries, headed, widgetUrl, tenantId: tid },
		(event: ProgressEvent) => {
			console.log(`[Recording ${recordingId}] ${event.type}: ${event.message}`);
			const clients = sseClients.get(recordingId) ?? [];
			const data = JSON.stringify(event);
			for (const client of clients) {
				client.write(`data: ${data}\n\n`);
			}
		},
		abortController.signal,
	);
	recordingId = id;
	recordingAborts.set(id, abortController);

	promise
		.then(() => {
			console.log(`[Recording ${id}] Completed`);
		})
		.catch((err) => {
			console.error(`[Recording ${id}] Error:`, err.message);
			const clients = sseClients.get(id) ?? [];
			const data = JSON.stringify({
				type: "error",
				message: err.message,
				timestamp: Date.now(),
			});
			for (const client of clients) {
				client.write(`data: ${data}\n\n`);
			}
		})
		.finally(() => {
			recordingAborts.delete(id);
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
			// Abort the recording if all SSE clients disconnected
			const abort = recordingAborts.get(id);
			if (abort) {
				console.log(`[Recording ${id}] All clients disconnected, aborting`);
				abort.abort();
			}
		} else {
			sseClients.set(id, remaining);
		}
	});
});

// Get recording details
app.get("/api/recordings/:id", (req, res) => {
	const dir = requireDir(req, req.params.id, res);
	if (!dir) return;
	res.json(getRecordingDetails(dir));
});

// Update recording config
app.patch("/api/recordings/:id/config", (req, res) => {
	const dir = requireDir(req, req.params.id, res);
	if (!dir) return;

	const configPath = path.join(dir, "config.json");
	const existing = fs.existsSync(configPath)
		? JSON.parse(fs.readFileSync(configPath, "utf-8"))
		: {};

	const { url, queries, widgetUrl, tenantId } = req.body;
	if (url !== undefined) existing.url = url;
	if (queries !== undefined) existing.queries = queries;
	if (tenantId !== undefined) existing.tenantId = tenantId;
	if (widgetUrl !== undefined) existing.widgetUrl = widgetUrl;

	fs.writeFileSync(configPath, JSON.stringify(existing, null, 2));

	// Sync query labels into all timeline files so voiceover picks up edits
	if (queries && Array.isArray(queries)) {
		const timelineFiles = fs
			.readdirSync(dir)
			.filter((f) => f.startsWith("timeline") && f.endsWith(".json"));

		for (const tf of timelineFiles) {
			const tp = path.join(dir, tf);
			const timeline = JSON.parse(fs.readFileSync(tp, "utf-8"));
			let changed = false;

			for (const entry of timeline) {
				if (entry.action.startsWith("query-")) {
					const idx =
						Number.parseInt(entry.action.replace("query-", ""), 10) - 1;
					if (
						idx >= 0 &&
						idx < queries.length &&
						entry.label !== queries[idx]
					) {
						entry.label = queries[idx];
						changed = true;
					}
				}
			}

			if (changed) {
				fs.writeFileSync(tp, JSON.stringify(timeline, null, 2));
			}
		}

		// Also update the voiceover manifest so clip list shows new text
		const manifestPath = path.join(dir, "voiceover", "clips.json");
		const rawTp = path.join(dir, "timeline.json");
		if (fs.existsSync(manifestPath) && fs.existsSync(rawTp)) {
			const manifest: { file: string; text: string }[] = JSON.parse(
				fs.readFileSync(manifestPath, "utf-8"),
			);
			// Rebuild narrated events list (same logic as voiceover.ts)
			const rawTimeline: { action: string; label: string }[] = JSON.parse(
				fs.readFileSync(rawTp, "utf-8"),
			);
			const narrated = rawTimeline.filter(
				(e) => e.action === "open-widget" || e.action.startsWith("query-"),
			);

			let manifestChanged = false;
			for (let i = 0; i < manifest.length; i++) {
				const ev = narrated[i];
				if (!ev || !ev.action.startsWith("query-")) continue;
				const newText = `Now asking: ${ev.label}`;
				if (manifest[i].text !== newText) {
					manifest[i].text = newText;
					manifestChanged = true;
				}
			}

			if (manifestChanged) {
				fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
			}
		}
	}

	res.json({ success: true });
});

// Delete a recording
app.delete("/api/recordings/:id", (req, res) => {
	const dir = requireDir(req, req.params.id, res);
	if (!dir) return;
	deleteRecording(dir);
	res.json({ success: true });
});

// Run freeze detection
app.post("/api/recordings/:id/detect-freezes", async (req, res) => {
	const dir = requireDir(req, req.params.id, res);
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
	const framePath = path.join(userDir(req), id, `frames-${video}`, name);

	if (!fs.existsSync(framePath)) {
		return res.status(404).json({ error: "Frame not found" });
	}
	res.sendFile(framePath);
});

// Trim video (SSE)
app.post("/api/recordings/:id/trim", async (req, res) => {
	const dir = requireDir(req, req.params.id, res);
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
	const dir = requireDir(req, req.params.id, res);
	if (!dir) return;

	const { video, speed } = req.body;
	const speedNum = Number.parseFloat(speed);

	if (!speedNum || speedNum <= 0) {
		return res.status(400).json({ error: "Invalid speed" });
	}

	const send = setupSSE(res);
	const ac = new AbortController();
	res.on("close", () => {
		if (!res.writableFinished) ac.abort();
	});

	try {
		const result = await renderSpeedVideo(
			dir,
			video || "raw.webm",
			speedNum,
			(msg) => send("progress", msg),
			ac.signal,
		);
		send("done", `Created ${result.outputFile}`);
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		if (!res.writableEnded) send("error", `Speed render failed: ${message}`);
	}
	if (!res.writableEnded) res.end();
});

// Delete a video (not raw)
app.delete("/api/recordings/:id/video/:file", (req, res) => {
	const dir = requireDir(req, req.params.id, res);
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

	const videoPath = path.join(userDir(req), id, file);
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
		console.log(`[Tenant] Loaded info for ${tenantId}`);
		res.json(info);
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		console.error(`[Tenant] Failed to fetch tenant ${tenantId}:`, message);
		res.status(502).json({ error: message });
	}
});

// Generate demo content (proxy to rag-chatbot LLM endpoint)
app.post("/api/tenant/:tenantId/generate", async (req, res) => {
	const tenantId = Number(req.params.tenantId);
	if (Number.isNaN(tenantId)) {
		return res.status(400).json({ error: "Invalid tenant ID" });
	}
	try {
		const url = `${RAG_CHATBOT_BASE_URL}/api/first-impression/t/${tenantId}/generate`;
		const refresh = req.query.refresh === "true" ? "?refresh=true" : "";
		const response = await fetch(`${url}${refresh}`, {
			method: "POST",
			headers: {
				Authorization: `Bearer ${process.env.FIRST_IMPRESSION_API_KEY}`,
				"Content-Type": "application/json",
			},
		});
		const data = await response.json();
		if (!response.ok) return res.status(response.status).json(data);
		res.json(data);
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		res.status(502).json({ error: message });
	}
});

// Add voiceover (SSE)
app.post("/api/recordings/:id/voiceover", async (req, res) => {
	const dir = requireDir(req, req.params.id, res);
	if (!dir) return;

	const { tenantId, video } = req.body;
	if (!tenantId || Number.isNaN(Number(tenantId))) {
		return res.status(400).json({ error: "tenantId required (number)" });
	}

	const send = setupSSE(res);
	const ac = new AbortController();
	res.on("close", () => {
		if (!res.writableFinished) ac.abort();
	});

	try {
		const result = await addVoiceoverToVideo(
			dir,
			video || "raw.webm",
			Number(tenantId),
			(msg) => send("progress", msg),
			ac.signal,
		);
		send("done", `Voiceover added: ${result.clipCount} clips`);
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		if (!res.writableEnded) send("error", `Voiceover failed: ${message}`);
	}
	if (!res.writableEnded) res.end();
});

// List voice clips
app.get("/api/recordings/:id/voice-clips", async (req, res) => {
	const dir = requireDir(req, req.params.id, res);
	if (!dir) return;

	try {
		const clips = await getVoiceClips(dir);
		res.json({ clips });
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		res.status(500).json({ error: message });
	}
});

// Serve voice clip audio
app.get("/api/recordings/:id/voice-clips/:file", (req, res) => {
	const dir = requireDir(req, req.params.id, res);
	if (!dir) return;

	const { file } = req.params;
	if (!file.endsWith(".mp3")) {
		return res.status(400).json({ error: "Invalid audio file" });
	}

	// Intro/outro audio lives in recording dir, main clips in voiceover/
	const isIntroOutro = file === "intro-audio.mp3" || file === "outro-audio.mp3";
	const filePath = isIntroOutro
		? path.join(dir, file)
		: path.join(dir, "voiceover", file);

	if (!fs.existsSync(filePath)) {
		return res.status(404).json({ error: "Audio file not found" });
	}
	res.sendFile(filePath);
});

// Delete voice clip
app.delete("/api/recordings/:id/voice-clips/:file", async (req, res) => {
	const dir = requireDir(req, req.params.id, res);
	if (!dir) return;

	const { file } = req.params;
	const { text } = req.body || {};

	const isIntroOutro = file === "intro-audio.mp3" || file === "outro-audio.mp3";
	const filePath = isIntroOutro
		? path.join(dir, file)
		: path.join(dir, "voiceover", file);

	if (!fs.existsSync(filePath)) {
		return res.status(404).json({ error: "Audio file not found" });
	}

	// Delete local file
	fs.unlinkSync(filePath);

	// Delete from S3/CloudFront cache
	if (text && typeof text === "string") {
		await deleteTTSCache(text);
	}

	// Delete voiced video files since they're now stale
	const voiced = fs
		.readdirSync(dir)
		.filter((f) => f.endsWith(".webm") && f.includes("-voiced"));
	for (const v of voiced) {
		fs.unlinkSync(path.join(dir, v));
	}

	res.json({ success: true });
});

// Compose final video (SSE)
app.post("/api/recordings/:id/compose", async (req, res) => {
	const dir = requireDir(req, req.params.id, res);
	if (!dir) return;

	const send = setupSSE(res);
	const ac = new AbortController();
	res.on("close", () => {
		if (!res.writableFinished) ac.abort();
	});

	try {
		const result = await composeVideo(
			dir,
			req.body.video,
			(msg) => send("progress", msg),
			ac.signal,
		);
		send("done", `Final video: ${result.sizeMB.toFixed(1)}MB`);
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		if (!res.writableEnded) send("error", `Compose failed: ${message}`);
	}
	if (!res.writableEnded) res.end();
});

// Generate intro & outro (SSE)
app.post("/api/recordings/:id/intro", async (req, res) => {
	const dir = requireDir(req, req.params.id, res);
	if (!dir) return;

	const { tenantId, introText, outroText } = req.body;
	if (!tenantId || Number.isNaN(Number(tenantId))) {
		return res.status(400).json({ error: "tenantId required (number)" });
	}

	const send = setupSSE(res);
	const ac = new AbortController();
	res.on("close", () => {
		if (!res.writableFinished) ac.abort();
	});

	try {
		const result = await generateIntroOutro(
			dir,
			Number(tenantId),
			{ introText, outroText },
			(msg) => send("progress", msg),
			ac.signal,
		);
		send(
			"done",
			`Intro (${result.intro.duration.toFixed(1)}s) + Outro (${result.outro.duration.toFixed(1)}s) ready`,
		);
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		if (!res.writableEnded) send("error", `Failed: ${message}`);
	}
	if (!res.writableEnded) res.end();
});

// Preview demo page
app.post("/api/recordings/:id/preview", async (req, res) => {
	const dir = requireDir(req, req.params.id, res);
	if (!dir) return;

	const { tenantId, tagline, inventoryDescription, subtitle } = req.body;
	if (!tenantId || Number.isNaN(Number(tenantId))) {
		return res.status(400).json({ error: "tenantId required (number)" });
	}

	try {
		const bestVideo = pickBestVideo(dir);
		const protocol = req.protocol;
		const host = req.get("host") || `localhost:${PORT}`;
		const videoUrl = `${protocol}://${host}/api/recordings/${req.params.id}/video/${bestVideo}`;
		const html = await generatePreview(dir, Number(tenantId), videoUrl, {
			tagline,
			inventoryDescription,
			subtitle,
		});
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
	const dir = requireDir(req, req.params.id, res);
	if (!dir) return;

	const {
		tenantId,
		tagline,
		inventoryDescription,
		subtitle,
		introText,
		outroText,
		queries,
	} = req.body;
	if (!tenantId || Number.isNaN(Number(tenantId))) {
		return res.status(400).json({ error: "tenantId required (number)" });
	}

	try {
		const result = await publishRecording(dir, Number(tenantId), {
			userId: req.user?.userId,
			email: req.user?.email,
			tagline,
			inventoryDescription,
			subtitle,
			generatedContent: { subtitle, introText, outroText, queries },
		});
		res.json(result);
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		console.error(`[Publish] Failed:`, message);
		res.status(500).json({ error: message });
	}
});

// --- Simulation Routes ---

// Take a screenshot of the target URL
app.post("/api/simulate", async (req, res) => {
	const { url } = req.body;

	if (!url || typeof url !== "string") {
		return res.status(400).json({ error: "url is required" });
	}

	let browser: Browser | null = null;
	try {
		browser = await chromium.launch({ headless: true });
		const context = await browser.newContext({
			viewport: { width: 1920, height: 1080 },
			ignoreHTTPSErrors: true,
		});
		const page = await context.newPage();
		await page.goto(url, { waitUntil: "load", timeout: 60_000 });
		await page.waitForTimeout(3000);

		const screenshot = await page.screenshot({ type: "png" });
		const screenshotBase64 = screenshot.toString("base64");

		await browser.close();
		browser = null;

		console.log(`[Simulate] Screenshot taken for ${url}`);
		res.json({ screenshot: screenshotBase64 });
	} catch (err) {
		if (browser) await browser.close().catch(() => {});
		const message = err instanceof Error ? err.message : String(err);
		console.error("[Simulate] Error:", message);
		res.status(500).json({ error: message });
	}
});

app.listen(PORT, () => {
	console.log(`First Impression running at http://localhost:${PORT}`);
});
