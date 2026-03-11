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
	isPreviewMode?: boolean; // true when widget is not on the live site
	subtitle?: string; // AI-generated hero subtitle
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
		isPreviewMode,
		subtitle,
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

    .play-overlay {
      position: absolute;
      inset: 0;
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      gap: 16px;
      background: rgba(0,0,0,0.3);
      border: none;
      cursor: pointer;
      transition: background 0.2s;
    }

    .play-overlay:hover {
      background: rgba(0,0,0,0.15);
    }

    .play-overlay.hidden { display: none; }

    /* Custom video controls */
    .video-controls {
      position: absolute;
      bottom: 0;
      left: 0;
      right: 0;
      display: flex;
      align-items: center;
      gap: 12px;
      padding: 0 16px;
      height: 52px;
      background: linear-gradient(transparent, rgba(0,0,0,0.85));
      transition: opacity 0.3s;
      z-index: 2;
    }
    .video-controls.vc-hidden { opacity: 0; pointer-events: none; }
    .vc-play {
      background: none;
      border: none;
      color: #fff;
      cursor: pointer;
      padding: 8px;
      min-width: 48px;
      min-height: 48px;
      display: flex;
      align-items: center;
      justify-content: center;
      flex-shrink: 0;
    }
    .vc-play:hover { color: #c8f64a; }
    .vc-progress {
      flex: 1;
      height: 48px;
      display: flex;
      align-items: center;
      cursor: pointer;
      position: relative;
    }
    .vc-track {
      width: 100%;
      height: 4px;
      background: rgba(255,255,255,0.2);
      border-radius: 2px;
      overflow: hidden;
    }
    .vc-progress:hover .vc-track { height: 6px; }
    .vc-filled {
      height: 100%;
      background: #c8f64a;
      border-radius: 2px;
      width: 0%;
    }
    .vc-time {
      font-size: 13px;
      color: rgba(255,255,255,0.7);
      white-space: nowrap;
      font-variant-numeric: tabular-nums;
      flex-shrink: 0;
    }

    .play-label {
      display: flex;
      align-items: center;
      gap: 6px;
      font-size: 14px;
      font-weight: 500;
      color: #c8f64a;
      font-family: 'Inter', sans-serif;
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

    /* --- Intro video --- */
    .intro-video-wrap {
      position: relative;
      width: 100%;
      max-width: 896px;
      margin: 0 auto;
      border-radius: 16px;
      overflow: hidden;
      background: #111;
      box-shadow: 0 8px 40px rgba(0,0,0,0.4), 0 0 0 1px rgba(255,255,255,0.06);
    }

    .intro-video-wrap video {
      width: 100%;
      display: block;
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

    /* --- Try It Live --- */
    .try-grid {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 24px;
    }

    .try-card {
      background: rgba(255,255,255,0.04);
      border: 1px solid rgba(255,255,255,0.08);
      border-radius: 16px;
      padding: 32px;
    }

    .try-card-full {
      grid-column: 1 / -1;
    }

    .try-card-icon {
      width: 40px;
      height: 40px;
      border-radius: 10px;
      background: rgba(200,246,74,0.1);
      display: flex;
      align-items: center;
      justify-content: center;
      margin-bottom: 16px;
      color: #c8f64a;
    }

    .try-card h3 {
      font-size: 18px;
      font-weight: 600;
      color: #fff;
      margin-bottom: 8px;
    }

    .try-card > p {
      font-size: 14px;
      color: rgba(255,255,255,0.5);
      margin-bottom: 20px;
      line-height: 1.6;
    }

    .try-steps {
      list-style: none;
      counter-reset: step;
    }

    .try-steps li {
      counter-increment: step;
      display: flex;
      align-items: flex-start;
      gap: 14px;
      padding: 10px 0;
      font-size: 14px;
      color: rgba(255,255,255,0.75);
      line-height: 1.5;
    }

    .try-steps li + li {
      border-top: 1px solid rgba(255,255,255,0.06);
    }

    .try-steps li::before {
      content: counter(step);
      flex-shrink: 0;
      width: 26px;
      height: 26px;
      border-radius: 50%;
      background: rgba(200,246,74,0.12);
      color: #c8f64a;
      font-size: 13px;
      font-weight: 600;
      display: flex;
      align-items: center;
      justify-content: center;
    }

    .try-phone {
      font-size: 16px;
      font-weight: 600;
      color: #fff;
      letter-spacing: 0.3px;
    }

    .try-note {
      margin-top: 16px;
      padding: 14px 16px;
      background: rgba(200,246,74,0.06);
      border: 1px solid rgba(200,246,74,0.12);
      border-radius: 10px;
      font-size: 13px;
      color: rgba(255,255,255,0.55);
      line-height: 1.6;
    }

    .try-note strong {
      color: rgba(255,255,255,0.8);
    }

    .try-links {
      display: flex;
      gap: 12px;
      flex-wrap: wrap;
    }

    .try-btn {
      display: inline-flex;
      align-items: center;
      gap: 8px;
      padding: 10px 20px;
      border-radius: 8px;
      font-size: 14px;
      font-weight: 600;
      text-decoration: none;
      transition: all 0.15s ease;
    }

    .try-btn-primary {
      background: #4f46e5;
      color: #fff;
    }

    .try-btn-primary:hover {
      background: #6366f1;
    }

    .try-btn-outline {
      background: transparent;
      color: rgba(255,255,255,0.7);
      border: 1px solid rgba(255,255,255,0.15);
    }

    .try-btn-outline:hover {
      border-color: rgba(255,255,255,0.3);
      color: #fff;
    }

    @media (max-width: 640px) {
      .hero { padding: 64px 0 48px; }
      .hero h1 { font-size: 28px; }
      .hero p { font-size: 15px; }
      .section-dark, .section-gray, .section-darker { padding: 56px 0; }
      .section-heading h2 { font-size: 24px; }
      .channel-grid { grid-template-columns: 1fr; }
      .try-grid { grid-template-columns: 1fr; }
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
      <p>${esc(subtitle || "")}</p>
    </div>
  </section>

  <!-- Demo Recording -->
  <section class="section-dark">
    <div class="container-narrow">
      <div class="section-heading">
        <h2>Your AI Assistant in Action</h2>
      </div>
      <div class="demo-video-wrap">
        <video id="demoVideo" src="${esc(videoFilename.startsWith("http") ? videoFilename : `${baseUrl}/${videoFilename}`)}" playsinline preload="metadata" poster="${snapshotFilename ? `${baseUrl}/${snapshotFilename}` : ""}"></video>
        <button class="play-overlay" id="playOverlay" aria-label="Play video">
          <svg width="64" height="64" viewBox="0 0 64 64" fill="none">
            <circle cx="32" cy="32" r="32" fill="rgba(0,0,0,0.55)"/>
            <polygon points="26,20 26,44 46,32" fill="#fff"/>
          </svg>
          <span class="play-label">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"/>
              <path d="M15.54 8.46a5 5 0 0 1 0 7.07"/>
              <path d="M19.07 4.93a10 10 0 0 1 0 14.14"/>
            </svg>
            Watch with sound
          </span>
        </button>
        <div class="video-controls vc-hidden" id="demoControls">
          <button class="vc-play" aria-label="Play/Pause">
            <svg class="vc-icon-play" width="22" height="22" viewBox="0 0 24 24" fill="currentColor"><polygon points="6,3 20,12 6,21"/></svg>
            <svg class="vc-icon-pause" width="22" height="22" viewBox="0 0 24 24" fill="currentColor" style="display:none"><rect x="5" y="3" width="4" height="18"/><rect x="15" y="3" width="4" height="18"/></svg>
          </button>
          <div class="vc-progress">
            <div class="vc-track"><div class="vc-filled"></div></div>
          </div>
          <span class="vc-time">0:00 / 0:00</span>
        </div>
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
      <div class="intro-video-wrap">
        <video id="introVideo" src="https://assets.xinfer.ai/videos/intro-xinfer-ai.mp4" playsinline preload="metadata"></video>
        <button class="play-overlay" id="introPlayOverlay" aria-label="Play video">
          <svg width="64" height="64" viewBox="0 0 64 64" fill="none">
            <circle cx="32" cy="32" r="32" fill="rgba(0,0,0,0.55)"/>
            <polygon points="26,20 26,44 46,32" fill="#fff"/>
          </svg>
          <span class="play-label">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"/>
              <path d="M15.54 8.46a5 5 0 0 1 0 7.07"/>
              <path d="M19.07 4.93a10 10 0 0 1 0 14.14"/>
            </svg>
            Watch with sound
          </span>
        </button>
        <div class="video-controls vc-hidden" id="introControls">
          <button class="vc-play" aria-label="Play/Pause">
            <svg class="vc-icon-play" width="22" height="22" viewBox="0 0 24 24" fill="currentColor"><polygon points="6,3 20,12 6,21"/></svg>
            <svg class="vc-icon-pause" width="22" height="22" viewBox="0 0 24 24" fill="currentColor" style="display:none"><rect x="5" y="3" width="4" height="18"/><rect x="15" y="3" width="4" height="18"/></svg>
          </button>
          <div class="vc-progress">
            <div class="vc-track"><div class="vc-filled"></div></div>
          </div>
          <span class="vc-time">0:00 / 0:00</span>
        </div>
      </div>
    </div>
  </section>

  <!-- Try It Live -->
  <section class="section-darker">
    <div class="container">
      <div class="section-heading">
        <h2>Try It Live</h2>
        <p>Experience ${esc(assistantName)} across every channel &mdash; web, phone, and SMS.</p>
      </div>
      <div class="try-grid">

        <!-- Web Chat -->
        <div class="try-card">
          <div class="try-card-icon">
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>
            </svg>
          </div>
          <h3>Web Chat &mdash; Text &amp; Voice</h3>
          ${
						isPreviewMode
							? `<p>See a preview of how the AI assistant would look on your website. The page shows a screenshot of your site with the chat widget overlaid &mdash; your actual site has not been modified. Supports text and voice input.</p>`
							: `<p>Your AI assistant is already live on your website. Visit your site and start a conversation &mdash; look for the chat widget in the bottom corner. It supports both text and voice input.</p>`
					}
          <div class="try-links">
            <a href="${baseUrl}/demo.html" target="_blank" class="try-btn try-btn-primary">${isPreviewMode ? "Open Preview" : "Visit Your Website"} &rarr;</a>
            ${tenantInfo.subdomain ? `<a href="https://${esc(tenantInfo.subdomain)}.xinfer.ai/chat" target="_blank" class="try-btn try-btn-outline">Standalone Chat</a>` : ""}
          </div>
          ${tenantInfo.subdomain ? `<p style="margin-top:12px;font-size:12px;color:rgba(255,255,255,0.35)">Standalone Chat opens the assistant in a full-page view, separate from your website.</p>` : ""}
        </div>

        <!-- Phone Agent -->
        <div class="try-card">
          <div class="try-card-icon">
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72 12.84 12.84 0 0 0 .7 2.81 2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45 12.84 12.84 0 0 0 2.81.7A2 2 0 0 1 22 16.92z"/>
            </svg>
          </div>
          <h3>AI Phone Agent</h3>
          <p>Call and speak with the AI agent in real time.</p>
          <ol class="try-steps">
            <li>Call our toll-free number <span class="try-phone">1&nbsp;(888)&nbsp;666&#8209;1834</span></li>
            <li>Enter your account ID <span class="try-phone">${tenantInfo.tenantId}</span> followed by the <strong>#</strong> key</li>
            <li>You&rsquo;ll be connected to your AI Phone Agent for a live test</li>
          </ol>
          <div class="try-note">
            <strong>Dedicated number:</strong> If a dedicated phone number has been provisioned for your account, callers are connected directly to the AI agent with no IVR menu.
          </div>
        </div>

        <!-- SMS Agent -->
        <div class="try-card try-card-full">
          <div class="try-card-icon">
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <path d="M7.9 20A9 9 0 1 0 4 16.1L2 22z"/>
            </svg>
          </div>
          <h3>AI SMS Agent</h3>
          <p>After your first phone call, your number is linked to your account for 30 days. During that period, text <span class="try-phone">1&nbsp;(888)&nbsp;666&#8209;1834</span> to chat with your AI SMS Agent.</p>
          <div class="try-note">
            <strong>Note:</strong> SMS agent requires pre-configuration before testing. Contact us if you&rsquo;d like SMS enabled for your account.
          </div>
        </div>

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

<script>
(function(){
  function fmt(s){
    if(isNaN(s))return'0:00';
    var m=Math.floor(s/60),sec=Math.floor(s%60);
    return m+':'+(sec<10?'0':'')+sec;
  }

  function initVideo(videoId, overlayId, controlsId) {
    var v=document.getElementById(videoId);
    var o=document.getElementById(overlayId);
    var c=document.getElementById(controlsId);
    if(!v||!o||!c)return;

    var playBtn=c.querySelector('.vc-play');
    var iconPlay=c.querySelector('.vc-icon-play');
    var iconPause=c.querySelector('.vc-icon-pause');
    var progress=c.querySelector('.vc-progress');
    var filled=c.querySelector('.vc-filled');
    var timeEl=c.querySelector('.vc-time');
    var hideTimer=null;
    var started=false;

    function showControls(){
      c.classList.remove('vc-hidden');
    }
    function hideControls(){
      if(!v.paused&&!v.ended) c.classList.add('vc-hidden');
    }
    function resetHideTimer(){
      clearTimeout(hideTimer);
      showControls();
      if(!v.paused&&!v.ended) hideTimer=setTimeout(hideControls,3000);
    }
    function updateIcons(){
      if(v.paused||v.ended){
        iconPlay.style.display='';
        iconPause.style.display='none';
      }else{
        iconPlay.style.display='none';
        iconPause.style.display='';
      }
    }

    // Play overlay: initial "Watch with sound"
    o.addEventListener('click',function(){
      v.muted=false;
      v.play();
    });

    // Play event
    v.addEventListener('play',function(){
      started=true;
      o.classList.add('hidden');
      updateIcons();
      resetHideTimer();
    });

    // Pause event
    v.addEventListener('pause',function(){
      clearTimeout(hideTimer);
      updateIcons();
      if(!started){
        o.classList.remove('hidden');
        c.classList.add('vc-hidden');
      }else{
        showControls();
      }
    });

    // Ended event
    v.addEventListener('ended',function(){
      clearTimeout(hideTimer);
      updateIcons();
      showControls();
    });

    // Progress update
    v.addEventListener('timeupdate',function(){
      if(v.duration){
        filled.style.width=(v.currentTime/v.duration*100)+'%';
        timeEl.textContent=fmt(v.currentTime)+' / '+fmt(v.duration);
      }
    });

    v.addEventListener('loadedmetadata',function(){
      timeEl.textContent='0:00 / '+fmt(v.duration);
    });

    // Play/pause button
    playBtn.addEventListener('click',function(e){
      e.stopPropagation();
      if(v.paused||v.ended){v.muted=false;v.play();}
      else v.pause();
      resetHideTimer();
    });

    // Seek on progress bar click/touch
    function seek(e){
      var rect=progress.getBoundingClientRect();
      var x=(e.touches?e.touches[0].clientX:e.clientX)-rect.left;
      var pct=Math.max(0,Math.min(1,x/rect.width));
      if(v.duration) v.currentTime=pct*v.duration;
      resetHideTimer();
    }
    progress.addEventListener('click',function(e){e.stopPropagation();seek(e);});
    progress.addEventListener('touchend',function(e){e.stopPropagation();e.preventDefault();
      var rect=progress.getBoundingClientRect();
      var x=e.changedTouches[0].clientX-rect.left;
      var pct=Math.max(0,Math.min(1,x/rect.width));
      if(v.duration) v.currentTime=pct*v.duration;
      resetHideTimer();
    });

    // Show controls on interaction with video area
    var wrap=v.parentElement;
    wrap.addEventListener('mousemove',function(){if(started)resetHideTimer();});
    wrap.addEventListener('touchstart',function(e){
      if(started&&!o.contains(e.target)&&!c.contains(e.target)){
        if(c.classList.contains('vc-hidden')){
          resetHideTimer();
        }else if(!v.paused){
          hideControls();
          clearTimeout(hideTimer);
        }
      }
    });

    // Prevent controls clicks from bubbling to wrap
    c.addEventListener('click',function(e){e.stopPropagation();});
    c.addEventListener('touchstart',function(e){e.stopPropagation();});
  }

  initVideo('demoVideo','playOverlay','demoControls');
  initVideo('introVideo','introPlayOverlay','introControls');
})();
</script>
${publishedId && trackingUrl ? `<!-- Access tracking -->\n<img src="${esc(trackingUrl)}?pid=${publishedId}" width="1" height="1" alt="" style="position:absolute;left:-9999px" />` : ""}
</body>
</html>`;
}

export interface DemoInteractivePageOptions {
	targetUrl: string;
	snapshotUrl?: string; // when set with widgetUrl, renders preview mode
	snapshotMobileUrl?: string; // mobile snapshot for responsive preview
	widgetUrl?: string; // widget script to inject over the snapshot
}

export function generateDemoInteractivePage(
	opts: DemoInteractivePageOptions,
): string {
	const { targetUrl, snapshotUrl, snapshotMobileUrl, widgetUrl } = opts;

	// Preview mode: snapshot background + widget + disclosure banner
	if (snapshotUrl && widgetUrl) {
		return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>AI Assistant Preview</title>
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600&display=swap" rel="stylesheet">
  <style>
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
    html, body { width: 100%; height: 100%; overflow: hidden; font-family: 'Inter', sans-serif; }
    body {
      background-color: #1a1a1a;
      background-image: url('${esc(snapshotUrl)}');
      background-size: 1920px 1080px;
      background-repeat: no-repeat;
      background-position: right top;
    }
    @media (max-height: 1080px) {
      body { background-size: auto 100vh; }
    }
    @media (max-width: 768px) {
      html, body { overflow: auto; }
      body {
        ${snapshotMobileUrl ? `background-image: url('${esc(snapshotMobileUrl)}');` : ""}
        background-size: 100% auto;
        background-position: top center;
      }
    }
    .preview-banner {
      position: fixed;
      top: 0;
      left: 0;
      right: 0;
      z-index: 999999;
      background: rgba(17,24,39,0.92);
      backdrop-filter: blur(8px);
      -webkit-backdrop-filter: blur(8px);
      border-bottom: 1px solid rgba(200,246,74,0.2);
      padding: 10px 20px;
      display: flex;
      align-items: center;
      justify-content: center;
      gap: 12px;
    }
    .preview-badge {
      display: inline-block;
      padding: 3px 10px;
      border-radius: 999px;
      background: rgba(200,246,74,0.15);
      border: 1px solid rgba(200,246,74,0.3);
      color: #c8f64a;
      font-size: 11px;
      font-weight: 600;
      text-transform: uppercase;
      letter-spacing: 0.5px;
    }
    .preview-text {
      font-size: 13px;
      color: rgba(255,255,255,0.7);
    }
    .preview-dismiss {
      position: absolute;
      right: 16px;
      background: none;
      border: none;
      color: rgba(255,255,255,0.4);
      cursor: pointer;
      font-size: 18px;
      padding: 4px;
      line-height: 1;
    }
    .preview-dismiss:hover { color: rgba(255,255,255,0.7); }
  </style>
</head>
<body>
  <div class="preview-banner" id="previewBanner">
    <span class="preview-badge">Preview</span>
    <span class="preview-text">This is a simulation &mdash; your website has not been modified. The background is a screenshot of <strong>${esc(targetUrl)}</strong>.</span>
    <button class="preview-dismiss" onclick="document.getElementById('previewBanner').remove()" title="Dismiss">&times;</button>
  </div>
  <script src="${esc(widgetUrl)}" async></script>
</body>
</html>`;
	}

	// Default: redirect to the live site (widget already installed)
	return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta http-equiv="refresh" content="0;url=${esc(targetUrl)}">
  <title>Redirecting\u2026</title>
</head>
<body>
  <p>Redirecting to <a href="${esc(targetUrl)}">${esc(targetUrl)}</a>\u2026</p>
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
