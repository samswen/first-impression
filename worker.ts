import "dotenv/config";
import { spawn } from "node:child_process";
import { createWriteStream, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { PublishCommand, SNSClient } from "@aws-sdk/client-sns";
import {
	DeleteMessageCommand,
	ReceiveMessageCommand,
	SQSClient,
} from "@aws-sdk/client-sqs";

// ─── Types ───────────────────────────────────────────────────────────

interface QueueTask {
	tenantId: number;
	email?: string;
	url?: string;
	widgetUrl?: string;
	queries?: string[];
	force?: boolean;
	snapshotUrl?: string;
	snapshotMobileUrl?: string;
}

// ─── Config ──────────────────────────────────────────────────────────

const SQS_QUEUE_URL = process.env.SQS_QUEUE_URL;
const SNS_FAILURE_TOPIC_ARN = process.env.SNS_FAILURE_TOPIC_ARN;
const AWS_REGION = process.env.AWS_REGION || "us-east-2";

if (!SQS_QUEUE_URL) {
	console.error("SQS_QUEUE_URL is required");
	process.exit(1);
}

const sqs = new SQSClient({ region: AWS_REGION });
const sns = SNS_FAILURE_TOPIC_ARN
	? new SNSClient({ region: AWS_REGION })
	: null;

// ─── Helpers ─────────────────────────────────────────────────────────

function log(msg: string) {
	console.log(`[worker] ${msg}`);
}

function buildCliArgs(task: QueueTask): string[] {
	const args = [String(task.tenantId)];
	if (task.email) args.push("--email", task.email);
	if (task.url) args.push("--url", task.url);
	if (task.widgetUrl) args.push("--widget-url", task.widgetUrl);
	if (task.force) args.push("--force");
	if (task.queries && task.queries.length > 0) {
		args.push("--queries", ...task.queries);
	}
	if (task.snapshotUrl) args.push("--snapshot-url", task.snapshotUrl);
	if (task.snapshotMobileUrl)
		args.push("--snapshot-mobile-url", task.snapshotMobileUrl);
	return args;
}

const CLI_TIMEOUT_MS = 30 * 60 * 1000; // 30 minutes

function runCli(
	args: string[],
): Promise<{ exitCode: number; timedOut: boolean; logPath: string }> {
	return new Promise((resolve, reject) => {
		// Capture all CLI output to a log file for S3 upload
		const logPath = path.join(tmpdir(), `fi-pipeline-${Date.now()}.log`);
		const logStream = createWriteStream(logPath, { flags: "w" });

		const child = spawn("tsx", ["cli.ts", ...args], {
			cwd: import.meta.dirname,
			stdio: ["inherit", "pipe", "pipe"],
			env: { ...process.env, FI_PIPELINE_LOG: logPath },
		});

		// Tee stdout/stderr to both console and log file
		child.stdout?.on("data", (chunk: Buffer) => {
			process.stdout.write(chunk);
			logStream.write(chunk);
		});
		child.stderr?.on("data", (chunk: Buffer) => {
			process.stderr.write(chunk);
			logStream.write(chunk);
		});

		let timedOut = false;
		const timer = setTimeout(() => {
			timedOut = true;
			log("CLI process timed out after 30 minutes, killing...");
			child.kill("SIGTERM");
			// Force kill if it doesn't exit within 10s
			setTimeout(() => child.kill("SIGKILL"), 10_000);
		}, CLI_TIMEOUT_MS);

		child.on("error", (err) => {
			clearTimeout(timer);
			logStream.end();
			reject(err);
		});
		child.on("exit", (code) => {
			clearTimeout(timer);
			logStream.end();
			resolve({ exitCode: code ?? 1, timedOut, logPath });
		});
	});
}

async function sendFailureNotification(
	task: QueueTask,
	exitCode: number,
	reason?: string,
): Promise<void> {
	if (!sns || !SNS_FAILURE_TOPIC_ARN) return;

	const subject = `First Impression failed: tenant ${task.tenantId}`;
	const message = [
		`Pipeline failed for tenant ${task.tenantId}`,
		reason ? `Reason: ${reason}` : `Exit code: ${exitCode}`,
		`Task: ${JSON.stringify(task, null, 2)}`,
		"",
		"The message will return to the queue after the visibility timeout.",
	].join("\n");

	try {
		await sns.send(
			new PublishCommand({
				TopicArn: SNS_FAILURE_TOPIC_ARN,
				Subject: subject,
				Message: message,
			}),
		);
		log("Failure notification sent");
	} catch (err) {
		const msg = err instanceof Error ? err.message : String(err);
		log(`Failed to send SNS notification: ${msg}`);
	}
}

async function shouldShutdown(): Promise<boolean> {
	try {
		// Get IMDSv2 token
		const tokenRes = await fetch("http://169.254.169.254/latest/api/token", {
			method: "PUT",
			headers: { "X-aws-ec2-metadata-token-ttl-seconds": "60" },
		});
		const token = await tokenRes.text();

		// Read shutdown tag
		const tagRes = await fetch(
			"http://169.254.169.254/latest/meta-data/tags/instance/shutdown",
			{ headers: { "X-aws-ec2-metadata-token": token } },
		);

		if (!tagRes.ok) return true; // tag missing → shutdown
		const value = await tagRes.text();
		return value.trim() !== "no";
	} catch {
		// Not on EC2 (local dev) → don't shutdown
		return false;
	}
}

// ─── Main loop ───────────────────────────────────────────────────────

async function poll(): Promise<boolean> {
	const res = await sqs.send(
		new ReceiveMessageCommand({
			QueueUrl: SQS_QUEUE_URL,
			MaxNumberOfMessages: 1,
			WaitTimeSeconds: 20,
			VisibilityTimeout: 1800,
		}),
	);

	const messages = res.Messages;
	if (!messages || messages.length === 0) return false;

	const msg = messages[0];
	const receiptHandle = msg.ReceiptHandle;

	let task: QueueTask;
	try {
		task = JSON.parse(msg.Body || "{}");
	} catch {
		log(`Invalid message body: ${msg.Body}`);
		// Delete malformed messages so they don't block the queue
		if (receiptHandle) {
			await sqs.send(
				new DeleteMessageCommand({
					QueueUrl: SQS_QUEUE_URL,
					ReceiptHandle: receiptHandle,
				}),
			);
		}
		return true;
	}

	if (!task.tenantId) {
		log("Message missing tenantId, deleting");
		if (receiptHandle) {
			await sqs.send(
				new DeleteMessageCommand({
					QueueUrl: SQS_QUEUE_URL,
					ReceiptHandle: receiptHandle,
				}),
			);
		}
		return true;
	}

	log(`Processing tenant ${task.tenantId}`);
	const args = buildCliArgs(task);
	log(`CLI args: tsx cli.ts ${args.join(" ")}`);

	const { exitCode, timedOut, logPath } = await runCli(args);

	// Clean up temp pipeline log (already uploaded to S3 during publish if successful)
	try {
		unlinkSync(logPath);
	} catch {
		// non-fatal
	}

	if (!timedOut && exitCode === 0) {
		log(`Tenant ${task.tenantId} completed successfully`);
		if (receiptHandle) {
			await sqs.send(
				new DeleteMessageCommand({
					QueueUrl: SQS_QUEUE_URL,
					ReceiptHandle: receiptHandle,
				}),
			);
			log("Message deleted from queue");
		}
	} else if (timedOut) {
		log(`Tenant ${task.tenantId} timed out after 30 minutes`);
		await sendFailureNotification(task, exitCode, "Timed out after 30 minutes");
	} else {
		log(`Tenant ${task.tenantId} failed with exit code ${exitCode}`);
		await sendFailureNotification(task, exitCode);
		// Don't delete — message returns to queue after visibility timeout
	}

	return true;
}

async function main() {
	log("Starting SQS worker");
	log(`Queue: ${SQS_QUEUE_URL}`);
	if (SNS_FAILURE_TOPIC_ARN) log(`SNS: ${SNS_FAILURE_TOPIC_ARN}`);

	while (true) {
		try {
			const hadMessage = await poll();

			if (!hadMessage) {
				log("Queue empty, checking shutdown tag...");
				if (await shouldShutdown()) {
					log("Shutting down instance");
					spawn("sudo", ["shutdown", "-h", "now"], { stdio: "inherit" });
					return;
				}
				log("Shutdown tag is 'no', sleeping 60s...");
				await new Promise((r) => setTimeout(r, 60_000));
			}
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			log(`Error: ${msg}`);
			// Brief pause before retrying
			await new Promise((r) => setTimeout(r, 5_000));
		}
	}
}

main();
