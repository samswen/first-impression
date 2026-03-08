/**
 * Text-to-Speech via rag-chatbot API
 *
 * Calls POST /api/first-impression/tts which handles ElevenLabs + S3 caching.
 * Returns the audio buffer (MP3) by following the 302 redirect to the CDN URL.
 */

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
