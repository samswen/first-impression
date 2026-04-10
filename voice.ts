/**
 * Text-to-Speech via rag-chatbot API
 *
 * Calls POST /api/first-impression/tts which handles ElevenLabs + S3 caching.
 * Returns the audio buffer (MP3) by following the 302 redirect to the CDN URL.
 *
 * TTS pronunciation: write "X Infer dot AI" (with spaces) in any text that
 * will be spoken aloud. ElevenLabs mispronounces "XInfer" and "Xinfer.AI"
 * as a single word. The spaced-out form produces correct pronunciation.
 */

import crypto from "node:crypto";
import "dotenv/config";

export interface VoiceOptions {
	text: string;
	outputFormat?: string; // default: "mp3_44100_128"
}

export async function textToSpeech(opts: VoiceOptions): Promise<Buffer> {
	const baseUrl = process.env.RAG_CHATBOT_BASE_URL;
	const apiKey = process.env.FIRST_IMPRESSION_API_KEY;

	if (!baseUrl) {
		throw new Error("RAG_CHATBOT_BASE_URL not configured in .env");
	}
	if (!apiKey) {
		throw new Error("FIRST_IMPRESSION_API_KEY not configured in .env");
	}

	const url = `${baseUrl}/api/first-impression/tts`;

	const body: Record<string, unknown> = { text: opts.text };
	if (opts.outputFormat) {
		body.outputFormat = opts.outputFormat;
	}

	const res = await fetch(url, {
		method: "POST",
		headers: {
			Authorization: `Bearer ${apiKey}`,
			"Content-Type": "application/json",
		},
		body: JSON.stringify(body),
		redirect: "follow",
	});

	if (!res.ok) {
		const errText = await res.text().catch(() => "");
		throw new Error(`TTS API error ${res.status}: ${errText}`);
	}

	const arrayBuffer = await res.arrayBuffer();
	return Buffer.from(arrayBuffer);
}

/**
 * Compute the TTS cache hash for given text.
 * Must match the backend TTS route's hash computation exactly.
 */
function computeTTSHash(text: string): string {
	const voiceId = process.env.ELEVENLABS_VOICE_ID || "";
	const model = process.env.ELEVENLABS_VOICE_MODEL || "eleven_flash_v2_5";
	const outputFormat = "mp3_44100_128";
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

	const cacheKey = JSON.stringify({
		text,
		voiceId,
		model,
		outputFormat,
		speed,
		stability,
		similarityBoost,
		style,
		useSpeakerBoost,
	});

	return crypto
		.createHash("sha256")
		.update(cacheKey)
		.digest("hex")
		.slice(0, 16);
}

/**
 * Delete a TTS cached audio from S3 + CloudFront via the rag-chatbot API.
 * Non-fatal on failure — logs warning and returns.
 */
export async function deleteTTSCache(text: string): Promise<void> {
	const baseUrl = process.env.RAG_CHATBOT_BASE_URL;
	const apiKey = process.env.FIRST_IMPRESSION_API_KEY;

	if (!baseUrl || !apiKey) {
		console.warn(
			"[TTS] Cannot delete cache: missing RAG_CHATBOT_BASE_URL or FIRST_IMPRESSION_API_KEY",
		);
		return;
	}

	const hash = computeTTSHash(text);
	const url = `${baseUrl}/api/first-impression/tts/${hash}`;

	try {
		const res = await fetch(url, {
			method: "DELETE",
			headers: { Authorization: `Bearer ${apiKey}` },
		});

		if (!res.ok) {
			console.warn(
				`[TTS] Cache delete failed (${res.status}) for hash ${hash}`,
			);
		}
	} catch (err) {
		console.warn("[TTS] Cache delete error:", err);
	}
}
