/**
 * S3 Publisher (via presigned URLs)
 *
 * Uploads demo assets to S3 by requesting presigned PUT URLs
 * from the rag-chatbot API, then uploading directly.
 */

import "dotenv/config";
import fs from "node:fs";
import { type DemoPageOptions, generateDemoPage } from "./demo-page";
import type { TenantInfo } from "./tenant";

export interface PublishOptions {
	tenantInfo: TenantInfo;
	tenantSlug: string;
	videoPath: string; // absolute path to the video file on disk
	videoFile: string; // filename e.g. "final.webm"
	snapshotPath?: string; // absolute path to snapshot.png (optional)
	config?: Record<string, unknown>; // recording inputs for reproduction
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
	cacheBust?: string;
}

interface PublishApiResponse {
	uploads: Record<string, PresignedUpload>;
	baseUrl: string;
	publishedId?: number;
	version?: number;
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
	// Convert Buffer to Uint8Array for fetch compatibility
	const fetchBody = Buffer.isBuffer(body) ? new Uint8Array(body) : body;

	const res = await fetch(presignedUrl, {
		method: "PUT",
		headers: {
			"Content-Type": contentType,
			"Cache-Control": cacheControl,
		},
		body: fetchBody,
	});

	if (!res.ok) {
		const text = await res.text().catch(() => "");
		throw new Error(`S3 upload failed (${res.status}): ${text}`);
	}
}

/**
 * Update the published record URL with cache-bust query param.
 */
async function updatePublishedUrl(
	tenantId: number,
	publishedId: number,
	cacheBust: string,
): Promise<void> {
	const baseUrl = process.env.RAG_CHATBOT_BASE_URL;
	const apiKey = process.env.FIRST_IMPRESSION_API_KEY;
	if (!baseUrl || !apiKey) return;

	try {
		await fetch(
			`${baseUrl}/api/first-impression/t/${tenantId}/publish/${publishedId}`,
			{
				method: "PATCH",
				headers: {
					Authorization: `Bearer ${apiKey}`,
					"Content-Type": "application/json",
				},
				body: JSON.stringify({ cacheBust }),
			},
		);
	} catch {
		// Non-critical — don't fail the publish
	}
}

export async function publishDemo(
	opts: PublishOptions,
): Promise<PublishResult> {
	const { tenantInfo, tenantSlug, videoPath, videoFile, snapshotPath, config } =
		opts;

	// Build file list for presigned URLs
	const files: { name: string; contentType: string }[] = [
		{ name: "video.webm", contentType: "video/webm" },
		{ name: "index.html", contentType: "text/html; charset=utf-8" },
	];

	const hasSnapshot = snapshotPath && fs.existsSync(snapshotPath);
	if (hasSnapshot) {
		files.push({ name: "snapshot.png", contentType: "image/png" });
	}

	// Get presigned URLs + record the publish
	const { uploads, baseUrl, publishedId, version } = await callPublishApi(
		tenantInfo.tenantId,
		{
			slug: tenantSlug,
			files,
			videoFile,
			config,
			tenantSnapshot: tenantInfo as unknown as Record<string, unknown>,
		},
	);

	// Cache-bust: timestamp so CloudFront serves fresh content
	const cacheBust = `v=${Date.now()}`;
	const videoFilename = `video.webm?${cacheBust}`;

	// Update the published record URL with cache-bust version
	if (publishedId) {
		await updatePublishedUrl(tenantInfo.tenantId, publishedId, cacheBust);
	}

	// 1. Upload video (long cache — URL is cache-busted in HTML)
	const videoBuffer = fs.readFileSync(videoPath);
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

	// 3. Generate demo page HTML
	const assetsBaseUrl = "https://assets.xinfer.ai";
	const pageOpts: DemoPageOptions = {
		tenantInfo,
		videoFilename,
		snapshotFilename: hasSnapshot ? "snapshot.png" : undefined,
		assetsBaseUrl,
		tenantSlug,
		version,
		publishedId: publishedId ?? undefined,
		trackingUrl: process.env.FI_ACCESS_URL,
	};
	const html = generateDemoPage(pageOpts);

	// 4. Upload index.html (no-cache so CloudFront always fetches fresh)
	await uploadWithPresignedUrl(
		uploads["index.html"].url,
		html,
		"text/html; charset=utf-8",
		"public, no-cache",
	);

	// 5. Upload directory key (same HTML, for bare /demo/slug access)
	if (uploads.__dir__) {
		await uploadWithPresignedUrl(
			uploads.__dir__.url,
			html,
			"text/html; charset=utf-8",
			"public, no-cache",
		);
	}

	// Return public URL
	const url = `${baseUrl}?${cacheBust}`;
	return { url, publishedId: publishedId ?? undefined, version };
}
