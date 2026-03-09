import "dotenv/config";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
	addVoiceoverToVideo,
	composeVideo,
	generateIntroOutro,
	publishRecording,
	renderSpeedVideo,
	startRecording,
} from "./pipeline";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const RECORDINGS_DIR = path.join(__dirname, "recordings");

interface Config {
	tenant: string;
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

async function readStdin(): Promise<string> {
	const chunks: Buffer[] = [];
	for await (const chunk of process.stdin) chunks.push(chunk);
	return Buffer.concat(chunks).toString("utf-8");
}

async function parseConfig(): Promise<Config> {
	// If no CLI args beyond the script name, read JSON from stdin
	const hasArgs = process.argv.slice(2).some((a) => a.startsWith("--"));

	if (!hasArgs) {
		const input = await readStdin();
		const json = JSON.parse(input);
		return {
			tenant: String(json.tenant),
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
		tenant: getArg("--tenant") || "",
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

// --- Arg helpers ---

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

function log(msg: string) {
	console.log(`  ${msg}`);
}

// --- Pipeline ---

async function run() {
	const cfg = await parseConfig();

	if (!cfg.tenant) {
		console.error(
			'Usage: tsx cli.ts --tenant <id> --url <targetUrl> [--widget-url <widgetUrl>] --queries "q1" "q2" ...',
		);
		console.error(
			"       tsx cli.ts --tenant <id> --recording <id> --from <step>",
		);
		console.error(
			'       echo \'{"tenant":536222,"url":"...","queries":["..."]}\' | tsx cli.ts',
		);
		process.exit(1);
	}

	if (cfg.from === 1 && !cfg.recording && (!cfg.url || !cfg.queries?.length)) {
		console.error("url and queries are required when starting a new recording");
		process.exit(1);
	}

	if (cfg.from > 1 && !cfg.recording) {
		console.error("recording is required when using --from");
		process.exit(1);
	}

	if (!fs.existsSync(RECORDINGS_DIR))
		fs.mkdirSync(RECORDINGS_DIR, { recursive: true });

	let dir: string;

	if (cfg.recording) {
		dir = path.join(RECORDINGS_DIR, cfg.recording);
		if (!fs.existsSync(dir)) {
			throw new Error(`Recording not found: ${cfg.recording}`);
		}
	} else {
		dir = ""; // set in step 1
	}

	// [1/6] Start recording
	if (cfg.from <= 1) {
		console.log("\n[1/6] Start recording");
		const result = startRecording(
			RECORDINGS_DIR,
			{
				url: cfg.url!,
				queries: cfg.queries!,
				headed: cfg.headed,
				widgetUrl: cfg.widgetUrl,
				tenantId: Number(cfg.tenant),
			},
			(event) => log(event.message),
		);
		dir = result.dir;
		console.log(`  Recording ID: ${result.id}`);
		await result.promise;
	}

	// [2/6] Speed up
	if (cfg.from <= 2) {
		console.log("\n[2/6] Speed up");
		await renderSpeedVideo(dir, "raw.webm", cfg.speed, log);
	}

	// [3/6] Generate intro & outro
	if (cfg.from <= 3) {
		console.log("\n[3/6] Generate intro & outro");
		await generateIntroOutro(dir, Number(cfg.tenant), log);
	}

	// [4/6] Add voiceover
	if (cfg.from <= 4) {
		console.log("\n[4/6] Add voiceover");
		const speedLabel =
			cfg.speed < 1
				? `${(1 / cfg.speed).toFixed(1).replace(/\.0$/, "")}th`
				: `${cfg.speed.toString().replace(/\.0$/, "")}x`;
		await addVoiceoverToVideo(
			dir,
			`raw-speed-${speedLabel}.webm`,
			Number(cfg.tenant),
			log,
		);
	}

	// [5/6] Compose final video
	if (cfg.from <= 5) {
		console.log("\n[5/6] Compose final video");
		await composeVideo(dir, undefined, log);
	}

	// [6/6] Publish
	if (cfg.noPublish) {
		console.log("\n[6/6] Publish — skipped (--no-publish)");
		return;
	}

	console.log("\n[6/6] Publish");
	const result = await publishRecording(dir, Number(cfg.tenant), {
		force: cfg.force,
	});
	console.log("  Published:", JSON.stringify(result, null, 2));
}

run().catch((err) => {
	console.error(`\nError: ${err.message}`);
	process.exit(1);
});
