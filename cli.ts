import "dotenv/config";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
	addVoiceoverToVideo,
	composeVideo,
	defaultSubtitleText,
	generateIntroOutro,
	publishRecording,
	renderSpeedVideo,
	speedLabel,
	startRecording,
} from "./pipeline";
import { fetchTenantInfo } from "./tenant";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const RECORDINGS_DIR = path.join(__dirname, "recordings");

const RAG_CHATBOT_BASE_URL = process.env.RAG_CHATBOT_BASE_URL;
const FIRST_IMPRESSION_API_KEY = process.env.FIRST_IMPRESSION_API_KEY;

// ─── Types ───────────────────────────────────────────────────────────

interface Config {
	tenant: string;
	email?: string;
	url?: string;
	widgetUrl?: string;
	queries?: string[];
	speed: number;
	headed: boolean;
	noPublish: boolean;
	force: boolean;
	recording?: string;
	from: number;
}

interface PipelineState {
	tenantId: number;
	completedStep: number;
	url: string;
	widgetUrl: string;
	subtitle: string;
	introText: string;
	outroText: string;
	queries: string[];
	tagline: string;
	inventoryDescription: string;
	speed: number;
}

// ─── Arg parsing ─────────────────────────────────────────────────────

async function readStdin(): Promise<string> {
	const chunks: Buffer[] = [];
	for await (const chunk of process.stdin) chunks.push(chunk);
	return Buffer.concat(chunks).toString("utf-8");
}

function getArg(flag: string): string | undefined {
	const idx = process.argv.indexOf(flag);
	if (idx === -1 || idx + 1 >= process.argv.length) return undefined;
	const val = process.argv[idx + 1];
	if (val.startsWith("--")) return undefined;
	return val;
}

function getListArg(flag: string): string[] {
	const idx = process.argv.indexOf(flag);
	if (idx === -1) return [];
	const values: string[] = [];
	for (let i = idx + 1; i < process.argv.length; i++) {
		if (process.argv[i].startsWith("--")) break;
		values.push(process.argv[i]);
	}
	return values;
}

function printHelp(): void {
	console.log(`First Impression — autonomous tenant-to-publish pipeline

Usage:
  tsx cli.ts <tenantId>                                       Full autonomous run
  tsx cli.ts <tenantId> --email <user@example.com>            With user attribution
  tsx cli.ts <tenantId> --recording <id> --from <step>        Resume from step
  tsx cli.ts <tenantId> --url <url> --queries "q1" "q2"       Manual overrides
  echo '{"tenant":536222}' | tsx cli.ts                       JSON from stdin

Steps:
  1  Fetch tenant info & generate AI content (URL, queries, subtitle, intro/outro)
  2  Record browser session via Playwright
  3  Speed up video
  4  Generate intro & outro scenes
  5  Add voiceover narration
  6  Compose final video (intro + main + outro)
  7  Publish to S3

Options:
  --email <email>        User email for publish attribution (default: demo@xinfer.ai)
  --url <url>            Override target website URL (default: from tenant info)
  --widget-url <url>     Override widget script URL (default: from tenant subdomain)
  --queries "q1" "q2"    Override queries (default: AI-generated or suggested actions)
  --recording <id>       Resume an existing recording (required with --from)
  --from <step>          Start from step 1-7 (default: 1)
  --speed <number>       Speed multiplier (default: 2)
  --headed               Show browser during recording
  --no-publish           Stop after compose, skip publish
  --force                Skip duplicate detection, always publish new version
  -h, --help             Show this help message`);
}

async function parseConfig(): Promise<Config | null> {
	const args = process.argv.slice(2);

	// Help flags or no args on a TTY → show help
	if (
		args.includes("-h") ||
		args.includes("--help") ||
		(args.length === 0 && process.stdin.isTTY)
	) {
		printHelp();
		return null;
	}

	// Positional tenantId: `tsx cli.ts 536222 [--flags]`
	const firstArg = args[0];
	const positionalTenant =
		firstArg && !firstArg.startsWith("--") ? firstArg : undefined;

	// No args and stdin is piped → read JSON
	if (args.length === 0) {
		const input = await readStdin();
		const json = JSON.parse(input);
		return {
			tenant: String(json.tenant),
			email: json.email,
			url: json.url,
			widgetUrl: json.widgetUrl,
			queries: json.queries,
			speed: json.speed ?? 2,
			headed: json.headed ?? false,
			noPublish: json.noPublish ?? false,
			force: json.force ?? false,
			recording: json.recording,
			from: json.from ?? 1,
		};
	}

	return {
		tenant: positionalTenant || getArg("--tenant") || "",
		email: getArg("--email"),
		url: getArg("--url"),
		widgetUrl: getArg("--widget-url"),
		queries: getListArg("--queries"),
		speed: Number(getArg("--speed") || "2"),
		headed: process.argv.includes("--headed"),
		noPublish: process.argv.includes("--no-publish"),
		force: process.argv.includes("--force"),
		recording: getArg("--recording"),
		from: Number(getArg("--from") || "1"),
	};
}

// ─── AI content generation ──────────────────────────────────────────

interface GenerateResult {
	subtitle?: string;
	intro?: string;
	outro?: string;
	queries?: string[];
}

async function generateContent(tenantId: number): Promise<GenerateResult> {
	if (!RAG_CHATBOT_BASE_URL || !FIRST_IMPRESSION_API_KEY) {
		log(
			"Skipping AI generation (missing RAG_CHATBOT_BASE_URL or FIRST_IMPRESSION_API_KEY)",
		);
		return {};
	}

	const url = `${RAG_CHATBOT_BASE_URL}/api/first-impression/t/${tenantId}/generate`;
	const res = await fetch(url, {
		method: "POST",
		headers: {
			Authorization: `Bearer ${FIRST_IMPRESSION_API_KEY}`,
			"Content-Type": "application/json",
		},
	});

	if (!res.ok) {
		const body = await res.json().catch(() => ({}));
		log(
			`AI generation failed (${res.status}): ${(body as Record<string, string>).error || res.statusText}`,
		);
		return {};
	}

	return res.json();
}

// ─── State persistence ──────────────────────────────────────────────

function stateFilePath(dir: string): string {
	return path.join(dir, "state.json");
}

function saveState(dir: string, state: PipelineState): void {
	fs.writeFileSync(stateFilePath(dir), JSON.stringify(state, null, 2));
}

function loadState(dir: string): PipelineState | null {
	const p = stateFilePath(dir);
	if (!fs.existsSync(p)) return null;
	return JSON.parse(fs.readFileSync(p, "utf-8"));
}

// ─── Helpers ─────────────────────────────────────────────────────────

function log(msg: string) {
	console.log(`  ${msg}`);
}

// ─── Pipeline ────────────────────────────────────────────────────────

async function run() {
	const cfg = await parseConfig();
	if (!cfg) process.exit(0);

	if (!cfg.tenant) {
		printHelp();
		process.exit(1);
	}

	if (cfg.from > 1 && !cfg.recording) {
		console.error("--recording is required when using --from");
		process.exit(1);
	}

	const tenantId = Number(cfg.tenant);
	if (!fs.existsSync(RECORDINGS_DIR))
		fs.mkdirSync(RECORDINGS_DIR, { recursive: true });

	let dir: string;
	let state: PipelineState;

	if (cfg.recording) {
		dir = path.join(RECORDINGS_DIR, cfg.recording);
		if (!fs.existsSync(dir)) {
			throw new Error(`Recording not found: ${cfg.recording}`);
		}
	} else {
		dir = ""; // set in step 1
	}

	// ── [1/7] Fetch tenant info & generate AI content ──────────────

	if (cfg.from <= 1) {
		console.log("\n[1/7] Fetch tenant info & generate AI content");

		log("Fetching tenant info...");
		const info = await fetchTenantInfo(tenantId);
		log(`Tenant: ${info.setup.businessName || info.app.title || tenantId}`);

		// Derive URL
		const url =
			cfg.url || info.setup.website || info.app.homePageUrl || undefined;
		if (!url) {
			throw new Error(
				"Could not derive URL from tenant info. Use --url to specify.",
			);
		}
		log(`URL: ${url}`);

		// Derive widget URL
		const widgetUrl =
			cfg.widgetUrl ||
			(info.subdomain
				? `https://${info.subdomain}.xinfer.ai/widget.js`
				: undefined);
		if (widgetUrl) log(`Widget: ${widgetUrl}`);

		// AI-generate content
		log("Generating AI content...");
		const generated = await generateContent(tenantId);

		// Queries: CLI override > AI > suggested actions
		const queries =
			cfg.queries && cfg.queries.length > 0
				? cfg.queries
				: generated.queries && generated.queries.length > 0
					? generated.queries
					: info.app.suggestedActions.length > 0
						? info.app.suggestedActions
						: undefined;
		if (!queries || queries.length === 0) {
			throw new Error(
				"No queries available (AI, suggested actions, or --queries).",
			);
		}
		log(
			`Queries (${queries.length}): ${queries.map((q) => `"${q}"`).join(", ")}`,
		);

		// Subtitle: AI > default
		const subtitle = generated.subtitle || defaultSubtitleText(info);
		log(`Subtitle: ${subtitle.slice(0, 80)}...`);

		// Intro/outro text from AI (will fall back to defaults in narrate.ts if empty)
		const introText = generated.intro || "";
		const outroText = generated.outro || "";
		if (introText) log(`Intro text: ${introText.slice(0, 60)}...`);
		if (outroText) log(`Outro text: ${outroText.slice(0, 60)}...`);

		state = {
			tenantId,
			completedStep: 1,
			url,
			widgetUrl: widgetUrl || "",
			subtitle,
			introText,
			outroText,
			queries,
			tagline: info.setup.tagline || "",
			inventoryDescription: info.setup.inventoryDescription || "",
			speed: cfg.speed,
		};
	} else {
		// Resume: load state from recording dir
		const saved = loadState(dir);
		if (!saved) {
			throw new Error(
				`No state.json in recording ${cfg.recording}. Cannot resume — re-run from step 1.`,
			);
		}
		state = saved;
		console.log(
			`\nResuming from step ${cfg.from} (recording: ${cfg.recording})`,
		);
	}

	// ── [2/7] Record ──────────────────────────────────────────────

	if (cfg.from <= 2) {
		console.log("\n[2/7] Record");
		const result = startRecording(
			RECORDINGS_DIR,
			{
				url: state.url,
				queries: state.queries,
				headed: cfg.headed,
				widgetUrl: state.widgetUrl || undefined,
				tenantId,
			},
			(event) => log(event.message),
		);
		dir = result.dir;
		console.log(`  Recording ID: ${result.id}`);
		await result.promise;
		state.completedStep = 2;
		saveState(dir, state);
	}

	// ── [3/7] Speed up ───────────────────────────────────────────

	if (cfg.from <= 3) {
		console.log("\n[3/7] Speed up");
		await renderSpeedVideo(dir, "raw.webm", state.speed, log);
		state.completedStep = 3;
		saveState(dir, state);
	}

	// ── [4/7] Intro & outro ──────────────────────────────────────

	if (cfg.from <= 4) {
		console.log("\n[4/7] Generate intro & outro");
		await generateIntroOutro(
			dir,
			tenantId,
			{
				introText: state.introText || undefined,
				outroText: state.outroText || undefined,
			},
			log,
		);
		state.completedStep = 4;
		saveState(dir, state);
	}

	// ── [5/7] Voiceover ──────────────────────────────────────────

	if (cfg.from <= 5) {
		console.log("\n[5/7] Add voiceover");
		await addVoiceoverToVideo(
			dir,
			`raw-speed-${speedLabel(state.speed)}.webm`,
			tenantId,
			log,
		);
		state.completedStep = 5;
		saveState(dir, state);
	}

	// ── [6/7] Compose ────────────────────────────────────────────

	if (cfg.from <= 6) {
		console.log("\n[6/7] Compose final video");
		await composeVideo(dir, undefined, log);
		state.completedStep = 6;
		saveState(dir, state);
	}

	// ── [7/7] Publish ────────────────────────────────────────────

	if (cfg.noPublish) {
		console.log("\n[7/7] Publish — skipped (--no-publish)");
		return;
	}

	console.log("\n[7/7] Publish");
	const email = cfg.email || "demo@xinfer.ai";
	log(`Publishing as ${email}`);
	const result = await publishRecording(dir, tenantId, {
		force: cfg.force,
		email,
		autoCreateUser: true,
		subtitle: state.subtitle,
		tagline: state.tagline || undefined,
		inventoryDescription: state.inventoryDescription || undefined,
		generatedContent: {
			subtitle: state.subtitle,
			introText: state.introText,
			outroText: state.outroText,
			queries: state.queries,
		},
	});
	state.completedStep = 7;
	saveState(dir, state);
	console.log("  Published:", JSON.stringify(result, null, 2));
}

run().catch((err) => {
	console.error(`\nError: ${err.message}`);
	process.exit(1);
});
