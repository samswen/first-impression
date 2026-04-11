import { chromium } from "playwright";

(async () => {
  const browser = await chromium.launch({ headless: true });
  const ctx = await browser.newContext({
    viewport: { width: 1920, height: 1080 },
    userAgent:
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
  });
  await ctx.addInitScript(() => {
    Object.defineProperty(navigator, "webdriver", { get: () => false });
  });
  const page = await ctx.newPage();

  await page.goto("https://eprestaurant.com", {
    waitUntil: "load",
    timeout: 60000,
  });
  try {
    await page.waitForLoadState("networkidle", { timeout: 15000 });
  } catch {}

  // Check carousel structure
  const carousel = await page.evaluate(() => {
    const el = document.querySelector("[data-landing-hero-carousel]");
    if (!el) return { found: false };
    const interval = el.getAttribute("data-carousel-interval");
    const items = el.querySelectorAll("[data-carousel-item]");
    const children = Array.from(items).map((item, i) => {
      const imgs = item.querySelectorAll("img");
      const rect = (item as HTMLElement).getBoundingClientRect();
      const style = window.getComputedStyle(item as HTMLElement);
      return {
        index: i,
        hasImg: imgs.length > 0,
        imgSrc: imgs[0]?.src?.slice(0, 80) || "none",
        imgComplete: imgs[0]?.complete ?? false,
        imgNaturalWidth: imgs[0]?.naturalWidth ?? 0,
        display: style.display,
        opacity: style.opacity,
        visibility: style.visibility,
        width: Math.round(rect.width),
        height: Math.round(rect.height),
        classes: (item.className?.toString() || "").slice(0, 100),
      };
    });
    return { found: true, interval, slideCount: items.length, slides: children };
  });
  console.log("=== CAROUSEL at t=0 ===");
  console.log(JSON.stringify(carousel, null, 2));

  // Screenshot at t=0
  await page.screenshot({
    path: "/Users/sam/projects/first-impression/scripts/carousel-t0.png",
    fullPage: false,
  });
  console.log("Screenshot at t=0 saved");

  // Wait 15 seconds (past the 12s interval)
  console.log("Waiting 15s for carousel to advance...");
  await page.waitForTimeout(15000);

  // Check carousel again
  const carousel2 = await page.evaluate(() => {
    const el = document.querySelector("[data-landing-hero-carousel]");
    if (!el) return { found: false };
    const items = el.querySelectorAll("[data-carousel-item]");
    return Array.from(items).map((item, i) => {
      const imgs = item.querySelectorAll("img");
      const style = window.getComputedStyle(item as HTMLElement);
      return {
        index: i,
        hasImg: imgs.length > 0,
        imgComplete: imgs[0]?.complete ?? false,
        imgNaturalWidth: imgs[0]?.naturalWidth ?? 0,
        display: style.display,
        opacity: style.opacity,
        classes: (item.className?.toString() || "").slice(0, 100),
      };
    });
  });
  console.log("\n=== CAROUSEL at t=15s ===");
  console.log(JSON.stringify(carousel2, null, 2));

  // Screenshot at t=15
  await page.screenshot({
    path: "/Users/sam/projects/first-impression/scripts/carousel-t15.png",
    fullPage: false,
  });
  console.log("Screenshot at t=15s saved");

  await browser.close();
})();
