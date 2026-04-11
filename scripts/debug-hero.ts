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

  // Track failed requests
  const failedRequests: string[] = [];
  page.on("requestfailed", (req) => {
    if (req.resourceType() === "image") {
      failedRequests.push(
        req.url().slice(0, 150) + " -> " + req.failure()?.errorText,
      );
    }
  });

  await page.goto("https://eprestaurant.com", {
    waitUntil: "load",
    timeout: 60000,
  });
  try {
    await page.waitForLoadState("networkidle", { timeout: 15000 });
  } catch {}
  await page.waitForTimeout(3000);

  // Check all images loading status
  const imgStatus = await page.evaluate(() => {
    return Array.from(document.querySelectorAll("img")).map((img, i) => ({
      index: i,
      complete: img.complete,
      naturalWidth: img.naturalWidth,
      naturalHeight: img.naturalHeight,
      loading: img.loading,
      src: (img.src || "").slice(0, 120),
      hasSrcset: Boolean(img.srcset),
      width: img.offsetWidth,
      height: img.offsetHeight,
      top: Math.round(img.getBoundingClientRect().top),
    }));
  });

  console.log("=== IMAGE LOAD STATUS ===");
  for (const img of imgStatus) {
    const loaded = img.complete && img.naturalWidth > 0;
    if (img.width > 100 || !loaded) {
      console.log(
        `${loaded ? "OK  " : "FAIL"} [${img.width}x${img.height} top:${img.top}]` +
          ` natural:${img.naturalWidth}x${img.naturalHeight}` +
          ` loading=${img.loading}` +
          ` srcset=${img.hasSrcset}` +
          ` ${img.src}`,
      );
    }
  }

  console.log("\n=== FAILED IMAGE REQUESTS ===");
  for (const f of failedRequests) console.log(f);
  if (failedRequests.length === 0) console.log("(none)");

  // Get hero img detail
  const heroImg = await page.evaluate(() => {
    const img = document.querySelector(
      "[data-landing-hero-carousel] img, section img",
    ) as HTMLImageElement | null;
    if (!img) return null;
    return {
      src: img.src,
      srcset: img.srcset?.slice(0, 300),
      currentSrc: img.currentSrc,
      complete: img.complete,
      naturalWidth: img.naturalWidth,
      naturalHeight: img.naturalHeight,
    };
  });
  console.log("\n=== HERO IMG DETAIL ===");
  console.log(JSON.stringify(heroImg, null, 2));

  await browser.close();
})();
