/**
 * Demo Page Generator
 *
 * Produces a self-contained static HTML page showcasing a recorded
 * XInfer chat widget demo alongside tenant business context.
 * Design matches the xinfer.ai homepage: dark theme, lime accent, warm feel.
 */

import type { TenantInfo } from "./tenant";

export interface DemoPageOptions {
	tenantInfo: TenantInfo;
	videoFilename: string; // e.g. "video.webm"
	snapshotFilename?: string; // e.g. "snapshot.png"
	assetsBaseUrl: string; // e.g. "https://assets.xinfer.com"
	tenantSlug: string; // used in URL path
	version?: number; // publish version (e.g. 1, 2, 3)
	publishedId?: number; // for access tracking pixel
	trackingUrl?: string; // GCF endpoint for access tracking
}

export function generateDemoPage(opts: DemoPageOptions): string {
	const {
		tenantInfo,
		videoFilename,
		snapshotFilename,
		assetsBaseUrl,
		tenantSlug,
		version,
		publishedId,
		trackingUrl,
	} = opts;
	const { setup, app } = tenantInfo;

	const businessName = setup.businessName || app.title || "Your Business";
	const tagline = setup.tagline || app.greetTitle || "";
	const inventoryDescription = setup.inventoryDescription || "";
	const assistantName = setup.assistantName || "AI Shopping Assistant";
	const versionSuffix = version ? `/v${version}` : "";
	const baseUrl = `${assetsBaseUrl}/demo/${tenantSlug}${versionSuffix}`;
	const ogImage = snapshotFilename ? `${baseUrl}/${snapshotFilename}` : "";
	const defaultLogo = "https://assets.xinfer.ai/logo-default.png";
	const tenantLogo = app.logo && app.logo !== defaultLogo ? app.logo : null;

	return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${esc(businessName)} &mdash; AI Demo by XInfer</title>
  <meta name="description" content="See how ${esc(businessName)} can transform customer experience with an AI-powered shopping assistant.">
  ${ogImage ? `<meta property="og:image" content="${esc(ogImage)}">` : ""}
  <meta property="og:title" content="${esc(businessName)} &mdash; AI Demo by XInfer">
  <meta property="og:description" content="A personalized AI assistant demo for ${esc(businessName)}">
  <meta property="og:type" content="website">
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&display=swap" rel="stylesheet">
  <style>
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }

    body {
      font-family: 'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      background: #000;
      color: #fff;
      line-height: 1.6;
      -webkit-font-smoothing: antialiased;
      -moz-osx-font-smoothing: grayscale;
    }

    .container {
      max-width: 1120px;
      margin: 0 auto;
      padding: 0 24px;
    }

    .container-narrow {
      max-width: 896px;
      margin: 0 auto;
      padding: 0 24px;
    }

    /* --- Header --- */
    .site-header {
      background: rgba(31,31,31,0.85);
      backdrop-filter: blur(12px);
      -webkit-backdrop-filter: blur(12px);
      border-bottom: 1px solid rgba(255,255,255,0.08);
      padding: 14px 0;
      position: sticky;
      top: 0;
      z-index: 100;
    }

    .header-inner {
      display: flex;
      align-items: center;
      justify-content: space-between;
    }

    .header-left {
      display: flex;
      align-items: center;
      gap: 10px;
      text-decoration: none;
    }

    .header-left img {
      height: 28px;
      display: block;
    }

    .header-left span {
      font-size: 16px;
      font-weight: 600;
      color: #fff;
      letter-spacing: -0.3px;
    }

    .header-right {
      display: flex;
      align-items: center;
      gap: 10px;
    }

    .header-right img {
      height: 26px;
      display: block;
      border-radius: 4px;
    }

    .header-business {
      font-size: 14px;
      color: rgba(255,255,255,0.5);
      font-weight: 500;
    }

    /* --- Hero --- */
    .hero {
      position: relative;
      text-align: center;
      padding: 96px 0 80px;
      overflow: hidden;
    }

    .hero-bg {
      position: absolute;
      inset: 0;
      z-index: 0;
    }

    .hero-bg img {
      width: 100%;
      height: 100%;
      object-fit: cover;
      opacity: 0.35;
    }

    .hero-bg::after {
      content: '';
      position: absolute;
      inset: 0;
      background: linear-gradient(to bottom, rgba(0,0,0,0.5) 0%, rgba(0,0,0,0.85) 100%);
    }

    .hero-content {
      position: relative;
      z-index: 1;
    }

    .hero-badge {
      display: inline-block;
      padding: 6px 16px;
      border-radius: 999px;
      background: rgba(200,246,74,0.12);
      border: 1px solid rgba(200,246,74,0.25);
      color: #c8f64a;
      font-size: 13px;
      font-weight: 600;
      letter-spacing: 0.3px;
      margin-bottom: 24px;
    }

    .hero h1 {
      font-size: 42px;
      font-weight: 700;
      color: #fff;
      margin-bottom: 16px;
      line-height: 1.2;
      letter-spacing: -0.5px;
    }

    .hero h1 em {
      color: #c8f64a;
      font-style: normal;
    }

    .hero p {
      font-size: 18px;
      color: rgba(255,255,255,0.65);
      max-width: 600px;
      margin: 0 auto;
      line-height: 1.7;
    }

    /* --- Section base --- */
    .section-dark {
      background: #000;
      padding: 80px 0;
    }

    .section-gray {
      background: #111827;
      padding: 80px 0;
    }

    .section-darker {
      background: #0a0a0a;
      padding: 80px 0;
    }

    .section-heading {
      text-align: center;
      margin-bottom: 48px;
    }

    .section-heading h2 {
      font-size: 30px;
      font-weight: 700;
      color: #fff;
      letter-spacing: -0.3px;
      margin-bottom: 12px;
    }

    .section-heading p {
      font-size: 16px;
      color: rgba(255,255,255,0.55);
      max-width: 560px;
      margin: 0 auto;
      line-height: 1.7;
    }

    /* --- Demo Video --- */
    .demo-video-wrap {
      position: relative;
      border-radius: 16px;
      overflow: hidden;
      background: #111;
      box-shadow: 0 8px 40px rgba(0,0,0,0.5), 0 0 0 1px rgba(255,255,255,0.06);
    }

    .demo-video-wrap video {
      width: 100%;
      display: block;
    }

    .demo-label {
      text-align: center;
      margin-top: 16px;
      font-size: 13px;
      color: rgba(255,255,255,0.35);
    }

    /* --- Business Context --- */
    .context-card {
      background: rgba(255,255,255,0.04);
      border: 1px solid rgba(255,255,255,0.08);
      border-radius: 16px;
      padding: 40px;
      max-width: 700px;
      margin: 0 auto;
    }

    .context-card h3 {
      font-size: 13px;
      font-weight: 600;
      text-transform: uppercase;
      letter-spacing: 1px;
      color: #c8f64a;
      margin-bottom: 16px;
    }

    .context-tagline {
      font-size: 20px;
      font-weight: 600;
      color: #fff;
      margin-bottom: 12px;
      line-height: 1.4;
    }

    .context-description {
      font-size: 15px;
      color: rgba(255,255,255,0.55);
      line-height: 1.7;
    }

    /* --- YouTube embed --- */
    .yt-wrap {
      position: relative;
      width: 100%;
      max-width: 896px;
      margin: 0 auto;
      border-radius: 16px;
      overflow: hidden;
      aspect-ratio: 16 / 9;
      box-shadow: 0 8px 40px rgba(0,0,0,0.4);
    }

    .yt-wrap iframe {
      position: absolute;
      inset: 0;
      width: 100%;
      height: 100%;
      border: 0;
    }

    /* --- Omnichannel grid --- */
    .channel-grid {
      display: grid;
      grid-template-columns: repeat(4, 1fr);
      gap: 20px;
    }

    .channel-card {
      background: rgba(255,255,255,0.04);
      border: 1px solid rgba(255,255,255,0.08);
      border-radius: 16px;
      padding: 28px;
    }

    .channel-icon {
      width: 36px;
      height: 36px;
      color: #c8f64a;
      margin-bottom: 14px;
    }

    .channel-card h3 {
      font-size: 16px;
      font-weight: 600;
      color: #fff;
      margin-bottom: 8px;
    }

    .channel-card p {
      font-size: 13px;
      color: rgba(255,255,255,0.45);
      line-height: 1.6;
    }

    .channel-footnote {
      text-align: center;
      margin-top: 32px;
      font-size: 13px;
      color: rgba(255,255,255,0.4);
    }

    /* --- CTA --- */
    .cta-section {
      text-align: center;
      padding: 96px 0;
      background: #000;
    }

    .cta-section h2 {
      font-size: 30px;
      font-weight: 700;
      color: #fff;
      margin-bottom: 12px;
      letter-spacing: -0.3px;
    }

    .cta-section p {
      font-size: 16px;
      color: rgba(255,255,255,0.55);
      margin-bottom: 32px;
    }

    .cta-buttons {
      display: flex;
      gap: 16px;
      justify-content: center;
      flex-wrap: wrap;
      align-items: center;
    }

    .btn-cta {
      display: inline-block;
      padding: 14px 32px;
      border-radius: 8px;
      font-size: 16px;
      font-weight: 600;
      text-decoration: none;
      transition: all 0.15s ease;
    }

    .btn-primary {
      background: #4f46e5;
      color: #fff;
      box-shadow: 0 2px 8px rgba(79,70,229,0.35);
    }

    .btn-primary:hover {
      background: #6366f1;
      box-shadow: 0 4px 16px rgba(79,70,229,0.45);
    }

    .btn-secondary {
      color: #fff;
      font-weight: 600;
    }

    .btn-secondary:hover { color: rgba(255,255,255,0.7); }

    .btn-secondary span { margin-left: 4px; }

    /* --- Footer --- */
    .site-footer {
      background: #111827;
      padding: 32px 0;
    }

    .footer-inner {
      display: flex;
      align-items: center;
      justify-content: space-between;
      flex-wrap: wrap;
      gap: 16px;
    }

    .footer-links {
      display: flex;
      gap: 24px;
    }

    .footer-links a {
      font-size: 13px;
      color: rgba(255,255,255,0.4);
      text-decoration: none;
      transition: color 0.15s;
    }

    .footer-links a:hover { color: rgba(255,255,255,0.7); }

    .footer-copy {
      font-size: 12px;
      color: rgba(255,255,255,0.3);
    }

    /* --- Responsive --- */
    @media (max-width: 900px) {
      .channel-grid { grid-template-columns: repeat(2, 1fr); }
    }

    @media (max-width: 640px) {
      .hero { padding: 64px 0 48px; }
      .hero h1 { font-size: 28px; }
      .hero p { font-size: 15px; }
      .section-dark, .section-gray, .section-darker { padding: 56px 0; }
      .section-heading h2 { font-size: 24px; }
      .channel-grid { grid-template-columns: 1fr; }
      .container, .container-narrow { padding: 0 16px; }
      .context-card { padding: 28px; }
      .cta-section { padding: 64px 0; }
      .footer-inner { flex-direction: column; text-align: center; }
    }
  </style>
</head>
<body>

  <!-- Header -->
  <header class="site-header">
    <div class="container header-inner">
      <a class="header-left" href="https://xinfer.ai">
        <img src="https://assets.xinfer.ai/logo/logo-ffffff.svg" alt="XInfer.AI">
        <span>XInfer.AI</span>
      </a>
      <div class="header-right">
        ${tenantLogo ? `<img src="${esc(tenantLogo)}" alt="${esc(businessName)}">` : ""}
        <span class="header-business">${esc(businessName)}</span>
      </div>
    </div>
  </header>

  <!-- Hero -->
  <section class="hero">
    <div class="hero-bg">
      <img src="https://assets.xinfer.ai/images/photo-one.png" alt="">
    </div>
    <div class="hero-content container">
      <div class="hero-badge">Personalized Demo</div>
      <h1>See how <em>${esc(businessName)}</em> can transform customer experience with AI</h1>
      <p>A personalized demo of ${esc(assistantName)} &mdash; an AI-powered assistant built for ${esc(businessName)}, delivering real-time product guidance and conversational shopping.</p>
    </div>
  </section>

  <!-- Demo Recording -->
  <section class="section-dark">
    <div class="container-narrow">
      <div class="section-heading">
        <h2>Your AI Assistant in Action</h2>
        <p>Watch ${esc(assistantName)} guide customers through products, answer questions, and drive conversions on your site.</p>
      </div>
      <div class="demo-video-wrap">
        <video src="${esc(videoFilename.startsWith("http") ? videoFilename : `${baseUrl}/${videoFilename}`)}" autoplay muted controls playsinline></video>
      </div>
      <p class="demo-label">Recorded live on ${esc(setup.website || tenantInfo.app.homePageUrl || "your website")}</p>
    </div>
  </section>

  ${
		tagline || inventoryDescription
			? `<!-- Business Context -->
  <section class="section-darker">
    <div class="container-narrow">
      <div class="context-card">
        <h3>We Understand Your Business</h3>
        ${tagline ? `<p class="context-tagline">${esc(tagline)}</p>` : ""}
        ${inventoryDescription ? `<p class="context-description">${esc(inventoryDescription)}</p>` : ""}
      </div>
    </div>
  </section>`
			: ""
	}

  <!-- Introducing XInfer.AI -->
  <section class="section-dark">
    <div class="container-narrow">
      <div class="section-heading">
        <h2>Introducing XInfer.AI</h2>
        <p>Go live with AI in hours, not months.</p>
      </div>
      <div class="yt-wrap">
        <iframe
          src="https://www.youtube.com/embed/mK-ymnuvIEQ?autoplay=0&vq=hd1080"
          title="Introducing XInfer.AI"
          allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture"
          allowfullscreen></iframe>
      </div>
    </div>
  </section>

  <!-- One AI Brain, Every Channel -->
  <section class="section-gray">
    <div class="container">
      <div class="section-heading">
        <h2>One AI Brain, Every Channel</h2>
        <p>A single intelligent engine powers web chat, voice, phone, and SMS. The more your AI learns, the smarter every channel becomes.</p>
      </div>
      <div class="channel-grid">
        <div class="channel-card">
          <svg class="channel-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>
          </svg>
          <h3>AI Web Chat</h3>
          <p>Text-based conversations on your website &mdash; answer questions, recommend products, and guide customers to purchase.</p>
        </div>
        <div class="channel-card">
          <svg class="channel-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <path d="M2 10v3"/><path d="M6 6v11"/><path d="M10 3v18"/><path d="M14 8v7"/><path d="M18 5v13"/><path d="M22 10v3"/>
          </svg>
          <h3>AI Voice Chat</h3>
          <p>Speech-to-speech conversations in the browser &mdash; hands-free browsing, cart management, and checkout by voice.</p>
        </div>
        <div class="channel-card">
          <svg class="channel-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72 12.84 12.84 0 0 0 .7 2.81 2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45 12.84 12.84 0 0 0 2.81.7A2 2 0 0 1 22 16.92z"/>
          </svg>
          <h3>AI Phone Agent</h3>
          <p>Customers call your number and speak with a knowledgeable AI agent 24/7 &mdash; no hold times, no missed calls.</p>
        </div>
        <div class="channel-card">
          <svg class="channel-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <path d="M7.9 20A9 9 0 1 0 4 16.1L2 22z"/>
          </svg>
          <h3>AI SMS Agent</h3>
          <p>Customers text your number for instant answers, product recommendations, and order updates &mdash; right from their phone.</p>
        </div>
      </div>
      <p class="channel-footnote">Train once, deploy everywhere. Every insight and conversation improvement is shared across all channels automatically.</p>
    </div>
  </section>

  <!-- CTA -->
  <section class="cta-section">
    <div class="container">
      <h2>Ready to get started?</h2>
      <p>Let us build a personalized AI assistant for ${esc(businessName)}.</p>
      <div class="cta-buttons">
        <a href="https://demo-store.xinfer.ai" target="_blank" rel="noopener noreferrer" class="btn-cta btn-primary">Try Demo</a>
        <a href="https://xinfer.ai" class="btn-cta btn-secondary">Learn more <span>&rarr;</span></a>
      </div>
    </div>
  </section>

  <!-- Footer -->
  <footer class="site-footer">
    <div class="container footer-inner">
      <div class="footer-links">
        <a href="https://xinfer.ai">XInfer.AI</a>
        <a href="https://www.youtube.com/@XInferDotAI">YouTube</a>
        <a href="https://xinfer.ai/home/md/about-us">About</a>
        <a href="https://xinfer.ai/home/pricing">Pricing</a>
      </div>
      <span class="footer-copy">&copy; ${new Date().getFullYear()} XINFER.AI. All rights reserved.</span>
    </div>
  </footer>

${publishedId && trackingUrl ? `<!-- Access tracking -->\n<img src="${esc(trackingUrl)}?pid=${publishedId}" width="1" height="1" alt="" style="position:absolute;left:-9999px" />` : ""}
</body>
</html>`;
}

function esc(str: string): string {
	return str
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;");
}
