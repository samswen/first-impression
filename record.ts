import { Recorder } from "./recorder";

const recorder = new Recorder({
	url: process.env.URL || "https://demo-store.xinfer.ai",
	queries: [
		"Show me snowboards under $700",
		"Tell me about the Hydrogen",
		"Add it to my cart",
		"Let's check out",
	],
	headed: process.env.HEADED === "true",
});

recorder
	.run((e) => console.log(`[${e.type}] ${e.message}`))
	.then((result) => {
		console.log(`\nDone! Recording saved to ${result.dir}`);
		console.log(`Timeline: ${result.timeline.length} actions`);
	})
	.catch((err) => {
		console.error("Recording failed:", err);
		process.exit(1);
	});
