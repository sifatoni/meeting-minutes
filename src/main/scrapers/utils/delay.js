/**
 * Timing and human-behaviour simulation utilities.
 * All async helpers are safe to call even if the page is closing — errors are swallowed.
 */

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

function randInt(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

/** Named alias for readability at call-sites. */
function humanDelay(min = 2000, max = 5000) {
  return sleep(min + Math.random() * (max - min));
}

/**
 * Simulate realistic downward (and occasionally upward) scrolling.
 * All scroll amounts are computed in Node.js and passed into evaluate() as
 * plain numbers so browser-context code never calls Node.js helpers.
 */
async function randomScroll(page, depth = "normal") {
  try {
    const steps = depth === "light" ? 1 : randInt(2, 5);
    for (let i = 0; i < steps; i++) {
      // Alternate between behavior: 'smooth' and mouse.wheel (more human)
      if (Math.random() > 0.5) {
        const delta = randInt(150, 400);
        await page.mouse.wheel({ deltaY: delta });
      } else {
        const amount = randInt(180, 420);
        await page.evaluate((px) => window.scrollBy({ top: px, behavior: "smooth" }), amount);
      }
      await sleep(randInt(400, 1200));
    }
    
    // Humans often scroll back up slightly to re-read
    if (Math.random() > 0.7) {
      const back = randInt(100, 250);
      await page.mouse.wheel({ deltaY: -back });
      await sleep(randInt(500, 1000));
    }
  } catch (_) {}
}

/**
 * Move the mouse to several random screen positions with natural step counts.
 * Uses the Puppeteer `steps` option to make movement non-linear.
 */
async function simulateMouseMovement(page) {
  try {
    const vp = page.viewport() || { width: 1280, height: 800 };
    const moves = randInt(4, 9);
    for (let i = 0; i < moves; i++) {
      const x = randInt(100, vp.width - 100);
      const y = randInt(100, vp.height - 100);
      
      // Use non-linear steps for more organic movement
      await page.mouse.move(x, y, { steps: randInt(15, 35) });
      
      // Occasional click on empty space (mimics focus)
      if (Math.random() > 0.9) {
        await page.mouse.click(x, y, { delay: randInt(50, 150) });
      }
      
      await sleep(randInt(100, 300));
    }
  } catch (_) {}
}

/**
 * Brief pause + micro-scroll to simulate the moment between reading the page
 * and scrolling to the next batch of results.
 */
async function readingPause(page) {
  // Random "thinking" pause
  const ms = randInt(1000, 2500);
  await sleep(ms);
  
  if (Math.random() > 0.5) {
    await randomScroll(page, "light");
  }
}

module.exports = { sleep, randInt, humanDelay, randomScroll, simulateMouseMovement, readingPause };
