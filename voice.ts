/**
 * ElevenLabs Text-to-Speech
 *
 * Converts text to speech using ElevenLabs API with configured voice settings.
 * Caches results by hashing all parameters + text to avoid redundant API calls.
 */

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import "dotenv/config";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CACHE_DIR = path.join(__dirname, ".voice-cache");

export interface VoiceOptions {
	text: string;
	outputFormat?: string; // default: "mp3_44100_128"
}

export async function textToSpeech(opts: VoiceOptions): Promise<Buffer> {
	const apiKey = process.env.ELEVENLABS_API_KEY;
	const voiceId = process.env.ELEVENLABS_VOICE_ID;
	const model = process.env.ELEVENLABS_VOICE_MODEL || "eleven_flash_v2_5";

	if (!apiKey) throw new Error("ELEVENLABS_API_KEY not configured in .env");
	if (!voiceId) throw new Error("ELEVENLABS_VOICE_ID not configured in .env");

	const speed = Number.parseFloat(process.env.ELEVENLABS_VOICE_SPEED || "1.0");
	const stability = Number.parseFloat(
		process.env.ELEVENLABS_VOICE_STABILITY || "0.5",
	);
	const similarityBoost = Number.parseFloat(
		process.env.ELEVENLABS_VOICE_SIMILARITY_BOOST || "0.75",
	);
	const style = Number.parseFloat(process.env.ELEVENLABS_VOICE_STYLE || "0.0");
	const useSpeakerBoost =
		process.env.ELEVENLABS_VOICE_SPEAKER_BOOST !== "false";
	const outputFormat = opts.outputFormat || "mp3_44100_128";

	// Build cache key from all parameters that affect the output
	const cacheKey = JSON.stringify({
		text: opts.text,
		voiceId,
		model,
		outputFormat,
		speed,
		stability,
		similarityBoost,
		style,
		useSpeakerBoost,
	});
	const hash = crypto
		.createHash("sha256")
		.update(cacheKey)
		.digest("hex")
		.slice(0, 16);
	const ext = outputFormat.startsWith("mp3") ? "mp3" : outputFormat;
	const cachePath = path.join(CACHE_DIR, `${hash}.${ext}`);

	// Check cache
	if (fs.existsSync(cachePath)) {
		return fs.readFileSync(cachePath);
	}

	// Call API
	const url = `https://api.elevenlabs.io/v1/text-to-speech/${voiceId}?output_format=${outputFormat}`;

	const res = await fetch(url, {
		method: "POST",
		headers: {
			"xi-api-key": apiKey,
			"Content-Type": "application/json",
		},
		body: JSON.stringify({
			text: opts.text,
			model_id: model,
			voice_settings: {
				stability,
				similarity_boost: similarityBoost,
				style,
				use_speaker_boost: useSpeakerBoost,
				speed,
			},
		}),
	});

	if (!res.ok) {
		const body = await res.text();
		throw new Error(`ElevenLabs API error ${res.status}: ${body}`);
	}

	const arrayBuffer = await res.arrayBuffer();
	const buffer = Buffer.from(arrayBuffer);

	// Save to cache
	if (!fs.existsSync(CACHE_DIR)) {
		fs.mkdirSync(CACHE_DIR, { recursive: true });
	}
	fs.writeFileSync(cachePath, buffer);

	return buffer;
}
