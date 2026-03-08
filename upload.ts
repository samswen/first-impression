/**
 * S3 Publisher
 *
 * Uploads a demo video, optional snapshot, and generated HTML page
 * to S3 under demo/[tenant-slug]/.
 */

import "dotenv/config";
import fs from "node:fs";
import { PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { type DemoPageOptions, generateDemoPage } from "./demo-page";
import type { TenantInfo } from "./tenant";

export interface PublishOptions {
	tenantInfo: TenantInfo;
	tenantSlug: string;
	videoPath: string; // absolute path to the video file on disk
	snapshotPath?: string; // absolute path to snapshot.png (optional)
}

export interface PublishResult {
	url: string;
}

function getS3Client(): {
	client: S3Client;
	bucket: string;
	assetsBaseUrl: string;
} {
	const region = process.env.AWS_REGION;
	const accessKeyId = process.env.AWS_ACCESS_KEY_ID;
	const secretAccessKey = process.env.AWS_SECRET_ACCESS_KEY;
	const bucket = process.env.S3_BUCKET;

	if (!region || !accessKeyId || !secretAccessKey || !bucket) {
		throw new Error(
			"Missing AWS config. Set AWS_REGION, AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY, and S3_BUCKET in .env",
		);
	}

	const assetsBaseUrl =
		process.env.ASSETS_BASE_URL ||
		`https://${bucket}.s3.${region}.amazonaws.com`;

	const client = new S3Client({
		region,
		credentials: { accessKeyId, secretAccessKey },
	});

	return { client, bucket, assetsBaseUrl };
}

async function uploadFile(
	client: S3Client,
	bucket: string,
	key: string,
	body: Buffer | string,
	contentType: string,
	cacheControl = "public, max-age=31536000, immutable",
): Promise<void> {
	await client.send(
		new PutObjectCommand({
			Bucket: bucket,
			Key: key,
			Body: body,
			ContentType: contentType,
			CacheControl: cacheControl,
		}),
	);
}

export async function publishDemo(
	opts: PublishOptions,
): Promise<PublishResult> {
	const { tenantInfo, tenantSlug, videoPath, snapshotPath } = opts;
	const { client, bucket, assetsBaseUrl } = getS3Client();

	const prefix = `demo/${tenantSlug}`;

	// Cache-bust: use a timestamp so CloudFront serves fresh content on each publish
	const cacheBust = `v=${Date.now()}`;
	const videoFilename = `video.webm?${cacheBust}`;
	const videoKey = "video.webm";
	const snapshotFilename = "snapshot.png";

	// 1. Upload video (long cache — URL is cache-busted in HTML)
	const videoBuffer = fs.readFileSync(videoPath);
	await uploadFile(
		client,
		bucket,
		`${prefix}/${videoKey}`,
		videoBuffer,
		"video/webm",
	);

	// 2. Upload snapshot if exists
	let hasSnapshot = false;
	if (snapshotPath && fs.existsSync(snapshotPath)) {
		const snapBuffer = fs.readFileSync(snapshotPath);
		await uploadFile(
			client,
			bucket,
			`${prefix}/${snapshotFilename}`,
			snapBuffer,
			"image/png",
		);
		hasSnapshot = true;
	}

	// 3. Generate demo page HTML (with cache-busted video src)
	const pageOpts: DemoPageOptions = {
		tenantInfo,
		videoFilename,
		snapshotFilename: hasSnapshot ? snapshotFilename : undefined,
		assetsBaseUrl,
		tenantSlug,
	};
	const html = generateDemoPage(pageOpts);

	// 4. Upload index.html — no-cache so CloudFront always fetches fresh
	const htmlCacheControl = "public, no-cache";
	await uploadFile(
		client,
		bucket,
		`${prefix}/index.html`,
		html,
		"text/html; charset=utf-8",
		htmlCacheControl,
	);
	await uploadFile(
		client,
		bucket,
		prefix,
		html,
		"text/html; charset=utf-8",
		htmlCacheControl,
	);

	// 5. Return public URL (cache-busted so CloudFront serves fresh HTML)
	const url = `${assetsBaseUrl}/demo/${tenantSlug}?${cacheBust}`;
	return { url };
}
