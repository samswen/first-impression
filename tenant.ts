/**
 * Tenant Data Fetcher
 *
 * Fetches business info from the rag-chatbot API for use in demo page generation.
 */

import "dotenv/config";

export interface TenantInfo {
	tenantId: number;
	subdomain: string | null;
	setup: {
		businessName: string | null;
		businessType: string | null;
		tagline: string | null;
		inventoryDescription: string | null;
		website: string | null;
		assistantName: string | null;
		personality: string | null;
	};
	app: {
		title: string | null;
		homePageUrl: string | null;
		greetTitle: string | null;
		greetBody: string | null;
		suggestedActions: string[];
		logo: string | null;
	};
	catalog?: {
		totalProducts: number;
		topCategory: string | null;
		topCategoryCount: number;
		sampleProducts: string[];
	};
}

export async function fetchTenantInfo(tenantId: number): Promise<TenantInfo> {
	const baseUrl = process.env.RAG_CHATBOT_BASE_URL;
	const apiKey = process.env.FIRST_IMPRESSION_API_KEY;

	if (!baseUrl) {
		throw new Error("RAG_CHATBOT_BASE_URL not configured in .env");
	}
	if (!apiKey) {
		throw new Error("FIRST_IMPRESSION_API_KEY not configured in .env");
	}

	const url = `${baseUrl}/api/first-impression/t/${tenantId}`;
	const res = await fetch(url, {
		headers: { Authorization: `Bearer ${apiKey}` },
	});

	if (!res.ok) {
		const body = await res.json().catch(() => ({}));
		throw new Error(
			`Failed to fetch tenant ${tenantId}: ${res.status} ${body.error || res.statusText}`,
		);
	}

	return res.json();
}
