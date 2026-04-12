/**
 * S3 Publisher (via presigned URLs)
 *
 * Uploads demo assets to S3 by requesting presigned PUT URLs
 * from the rag-chatbot API, then uploading directly.
 */

import "dotenv/config";
import { createHash } from "node:crypto";
import fs from "node:fs";
import {
	type DemoPageOptions,
	generateDemoInteractivePage,
	generateDemoPage,
} from "./demo-page";
import type { TenantInfo } from "./tenant";

export interface PublishOptions {
	tenantInfo: TenantInfo;
	tenantSlug: string;
	videoPath: string; // absolute path to the video file on disk
	videoFile: string; // filename e.g. "final.webm"
	snapshotPath?: string; // absolute path to snapshot.png (optional)
	snapshotMobilePath?: string; // absolute path to snapshot-mobile.png (optional)
	diagLogPath?: string; // absolute path to snapshot-diag.log (optional)
	mobileDiagLogPath?: string; // absolute path to snapshot-mobile-diag.log (optional)
	config?: Record<string, unknown>; // recording inputs for reproduction
	targetUrl?: string; // target site URL for interactive demo redirect
	widgetUrl?: string; // widget script URL (when not already on site)
	force?: boolean; // skip duplicate detection, always publish new version
	userId?: number; // first-impression user ID for publish attribution
	email?: string; // user email for publish attribution (resolved server-side)
	autoCreateUser?: boolean; // auto-create user if email not found (CLI only)
	subtitle?: string; // AI-generated hero subtitle for demo page
	generatedContent?: Record<string, unknown>; // AI-generated text fields to save in snapshot
}

export interface PublishResult {
	url: string;
	publishedId?: number;
	version?: number;
}

interface PresignedUpload {
	url: string;
	publicUrl: string;
}

/**
 * Request presigned S3 upload URLs from the rag-chatbot API.
 */
interface PublishApiRequest {
	slug: string;
	files: { name: string; contentType: string }[];
	videoFile?: string;
	config?: Record<string, unknown>;
	tenantSnapshot?: Record<string, unknown>;
	contentHash?: string;
	userId?: number;
	userEmail?: string;
	autoCreateUser?: boolean;
}

interface PublishApiResponse {
	uploads: Record<string, PresignedUpload>;
	baseUrl: string;
	publishedId?: number;
	version?: number;
	duplicate?: boolean;
}

async function callPublishApi(
	tenantId: number,
	body: PublishApiRequest,
): Promise<PublishApiResponse> {
	const baseUrl = process.env.RAG_CHATBOT_BASE_URL;
	const apiKey = process.env.FIRST_IMPRESSION_API_KEY;

	if (!baseUrl) throw new Error("RAG_CHATBOT_BASE_URL not configured");
	if (!apiKey) throw new Error("FIRST_IMPRESSION_API_KEY not configured");

	const url = `${baseUrl}/api/first-impression/t/${tenantId}/publish`;
	const res = await fetch(url, {
		method: "POST",
		headers: {
			Authorization: `Bearer ${apiKey}`,
			"Content-Type": "application/json",
		},
		body: JSON.stringify(body),
	});

	if (!res.ok) {
		const text = await res.text().catch(() => "");
		throw new Error(`Publish API error ${res.status}: ${text}`);
	}

	return res.json();
}

/**
 * Upload a file to S3 using a presigned PUT URL.
 */
async function uploadWithPresignedUrl(
	presignedUrl: string,
	body: Buffer | string,
	contentType: string,
	cacheControl = "public, max-age=31536000, immutable",
): Promise<void> {
	const res = await fetch(presignedUrl, {
		method: "PUT",
		headers: {
			"Content-Type": contentType,
			"Cache-Control": cacheControl,
			...(Buffer.isBuffer(body)
				? { "Content-Length": String(body.byteLength) }
				: {}),
		},
		body: Buffer.isBuffer(body)
			? new Blob([body.subarray() as BlobPart])
			: body,
	});

	if (!res.ok) {
		const text = await res.text().catch(() => "");
		throw new Error(`S3 upload failed (${res.status}): ${text}`);
	}
}

export async function publishDemo(
	opts: PublishOptions,
): Promise<PublishResult> {
	const {
		tenantInfo,
		tenantSlug,
		videoPath,
		videoFile,
		snapshotPath,
		snapshotMobilePath,
		diagLogPath,
		mobileDiagLogPath,
		config,
		targetUrl,
		widgetUrl,
		force,
		userId,
		email,
		autoCreateUser,
		generatedContent,
	} = opts;

	// Read video and compute content hash for dedup (skip when forcing)
	const videoBuffer = fs.readFileSync(videoPath);
	const contentHash = force
		? undefined
		: createHash("md5").update(videoBuffer).digest("hex");

	// Build file list for presigned URLs
	const files: { name: string; contentType: string }[] = [
		{ name: "video.webm", contentType: "video/webm" },
		{ name: "index.html", contentType: "text/html; charset=utf-8" },
	];

	const hasSnapshot = snapshotPath && fs.existsSync(snapshotPath);
	if (hasSnapshot) {
		files.push({ name: "snapshot.png", contentType: "image/png" });
	}

	const hasMobileSnapshot =
		snapshotMobilePath && fs.existsSync(snapshotMobilePath);
	if (hasMobileSnapshot) {
		files.push({ name: "snapshot-mobile.png", contentType: "image/png" });
	}

	const hasDiagLog = diagLogPath && fs.existsSync(diagLogPath);
	if (hasDiagLog) {
		files.push({ name: "snapshot-diag.log", contentType: "text/plain" });
	}

	const hasMobileDiagLog =
		mobileDiagLogPath && fs.existsSync(mobileDiagLogPath);
	if (hasMobileDiagLog) {
		files.push({ name: "snapshot-mobile-diag.log", contentType: "text/plain" });
	}

	const pipelineLogPath = process.env.FI_PIPELINE_LOG;
	const hasPipelineLog = pipelineLogPath && fs.existsSync(pipelineLogPath);
	if (hasPipelineLog) {
		files.push({ name: "pipeline.log", contentType: "text/plain" });
	}

	if (targetUrl) {
		files.push({ name: "demo.html", contentType: "text/html; charset=utf-8" });
	}



	// Build tenant snapshot — include generated content for future improvements
	const tenantSnapshot: Record<string, unknown> = {
		...(tenantInfo as unknown as Record<string, unknown>),
		...(generatedContent ? { generatedContent } : {}),
	};

	// Get presigned URLs + record the publish (API may return duplicate)
	const { uploads, baseUrl, publishedId, version, duplicate } =
		await callPublishApi(tenantInfo.tenantId, {
			slug: tenantSlug,
			files,
			videoFile,
			config,
			tenantSnapshot,
			contentHash,
			userId,
			userEmail: email,
			autoCreateUser,
		});

	// If the API detected identical content, skip all uploads
	if (duplicate) {
		console.log(`[Publish] Duplicate detected — reusing v${version}`);
		return { url: baseUrl, publishedId: publishedId ?? undefined, version };
	}

	// 1. Upload video
	await uploadWithPresignedUrl(
		uploads["video.webm"].url,
		videoBuffer,
		"video/webm",
	);

	// 2. Upload snapshot if exists
	if (hasSnapshot) {
		const snapBuffer = fs.readFileSync(snapshotPath);
		await uploadWithPresignedUrl(
			uploads["snapshot.png"].url,
			snapBuffer,
			"image/png",
		);
	}

	// 2b. Upload mobile snapshot if exists
	if (hasMobileSnapshot) {
		const mobileSnapBuffer = fs.readFileSync(snapshotMobilePath);
		await uploadWithPresignedUrl(
			uploads["snapshot-mobile.png"].url,
			mobileSnapBuffer,
			"image/png",
		);
	}

	// 2c. Upload diagnostic logs if exist
	if (hasDiagLog) {
		const diagBuffer = fs.readFileSync(diagLogPath);
		await uploadWithPresignedUrl(
			uploads["snapshot-diag.log"].url,
			diagBuffer,
			"text/plain",
		);
	}
	if (hasMobileDiagLog) {
		const mobileDiagBuffer = fs.readFileSync(mobileDiagLogPath);
		await uploadWithPresignedUrl(
			uploads["snapshot-mobile-diag.log"].url,
			mobileDiagBuffer,
			"text/plain",
		);
	}
	if (hasPipelineLog) {
		const pipelineLogBuffer = fs.readFileSync(pipelineLogPath);
		await uploadWithPresignedUrl(
			uploads["pipeline.log"].url,
			pipelineLogBuffer,
			"text/plain",
		);
	}

	// 3. Create admin invitation link (non-fatal if it fails)
	let inviteUrl: string | undefined;
	const ragBaseUrl = process.env.RAG_CHATBOT_BASE_URL;
	const fiApiKey = process.env.FIRST_IMPRESSION_API_KEY;
	if (ragBaseUrl && fiApiKey) {
		try {
			const inviteRes = await fetch(
				`${ragBaseUrl}/api/first-impression/t/${tenantInfo.tenantId}/admin-invite`,
				{
					method: "POST",
					headers: {
						"Content-Type": "application/json",
						Authorization: `Bearer ${fiApiKey}`,
					},
					body: JSON.stringify({
						expiryDays: 14,
						maxVisits: 7,
						maxRedeems: 2,
						createdBy: email,
						publishedId: publishedId ?? undefined,
					}),
				},
			);
			if (inviteRes.ok) {
				const inviteData = await inviteRes.json();
				inviteUrl = inviteData.inviteUrl;
				console.log(`[Publish] Admin invite created: ${inviteUrl}`);
			} else {
				console.warn(
					`[Publish] Admin invite creation failed: ${inviteRes.status}`,
				);
			}
		} catch (err) {
			console.warn(
				`[Publish] Admin invite creation error: ${err instanceof Error ? err.message : err}`,
			);
		}
	}

	// 4. Generate demo page HTML
	const assetsBaseUrl = "https://assets.xinfer.ai";
	const pageOpts: DemoPageOptions = {
		tenantInfo,
		videoFilename: "video.webm",
		snapshotFilename: hasSnapshot ? "snapshot.png" : undefined,
		assetsBaseUrl,
		tenantSlug,
		version,
		publishedId: publishedId ?? undefined,
		trackingUrl: process.env.FI_ACCESS_URL,
		isPreviewMode: !!widgetUrl,
		subtitle: opts.subtitle,
		inviteUrl,
	};
	const html = generateDemoPage(pageOpts);

	// 4. Upload index.html (immutable — versioned path never changes)
	await uploadWithPresignedUrl(
		uploads["index.html"].url,
		html,
		"text/html; charset=utf-8",
	);

	// 5. Generate and upload demo.html
	if (targetUrl) {
		const demoHtml = generateDemoInteractivePage({
			targetUrl,
			snapshotUrl:
				widgetUrl && hasSnapshot
					? uploads["snapshot.png"].publicUrl
					: undefined,
			snapshotMobileUrl:
				widgetUrl && hasMobileSnapshot
					? uploads["snapshot-mobile.png"].publicUrl
					: undefined,
			widgetUrl,
		});
		await uploadWithPresignedUrl(
			uploads["demo.html"].url,
			demoHtml,
			"text/html; charset=utf-8",
		);
	}

	// 6. Upload directory key (same HTML, for bare /demo/slug/vN access)
	if (uploads.__dir__) {
		await uploadWithPresignedUrl(
			uploads.__dir__.url,
			html,
			"text/html; charset=utf-8",
		);
	}

	return { url: baseUrl, publishedId: publishedId ?? undefined, version };
}
