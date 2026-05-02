/**
 * SpyLeads Instagram Profile Scraper
 * Apify Actor - src/main.js
 *
 * Strategy:
 *  1. Open Instagram hashtag page via Playwright
 *  2. Intercept XHR/fetch calls to capture Instagram's internal GraphQL
 *     responses (most reliable — avoids brittle DOM scraping)
 *  3. Collect post author usernames from intercepted data
 *  4. Visit each profile page, intercept the profile JSON response
 *  5. Extract: username, followers, bio, email, category, location, profile_url
 *  6. Apply follower filters
 *  7. Push to Apify dataset
 */

import { Actor } from 'apify';
import { PlaywrightCrawler, Dataset } from 'crawlee';

// ─────────────────────────────────────────────
// HELPERS
// ─────────────────────────────────────────────

/**
 * Random int between min and max (inclusive)
 */
function randomDelay(minMs = 3000, maxMs = 8000) {
  return Math.floor(Math.random() * (maxMs - minMs + 1)) + minMs;
}

/**
 * Sleep for given ms
 */
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Extract email-like strings from bio text
 */
function extractEmailFromBio(bio = '') {
  const match = bio.match(/[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}/);
  return match ? match[0] : null;
}

/**
 * Build the hashtag page URL
 */
function hashtagUrl(tag) {
  return `https://www.instagram.com/explore/tags/${encodeURIComponent(tag)}/`;
}

/**
 * Build a profile URL from username
 */
function profileUrl(username) {
  return `https://www.instagram.com/${username}/`;
}

// ─────────────────────────────────────────────
// MAIN ACTOR
// ─────────────────────────────────────────────

await Actor.init();

const input = await Actor.getInput();

const {
  query = '',
  type = 'hashtag',
  maxResults = 50,
  minFollowers = 0,
  maxFollowers = 0,
} = input || {};

if (!query) {
  throw new Error('Input "query" is required. Pass a hashtag without the # symbol.');
}

console.log(`\n🚀 SpyLeads Actor Starting`);
console.log(`   Query     : #${query}`);
console.log(`   Max       : ${maxResults}`);
console.log(`   Followers : ${minFollowers || 'any'} – ${maxFollowers || 'any'}`);
console.log(``);

// ─────────────────────────────────────────────
// PROXY SETUP (this is why other scrapers work!)
// Instagram blocks datacenter IPs instantly.
// Apify's residential proxies rotate real IPs.
// ─────────────────────────────────────────────
const proxyConfiguration = await Actor.createProxyConfiguration({
  groups: ['RESIDENTIAL'],
  countryCode: 'IN',
});
console.log(`   Proxy     : RESIDENTIAL (IN)`);

// Collected usernames from hashtag page
const collectedUsernames = new Set();

// Final results
const results = [];

// ─────────────────────────────────────────────
// PHASE 1: COLLECT USERNAMES FROM HASHTAG PAGE
// ─────────────────────────────────────────────

console.log(`[Phase 1] Opening hashtag page: #${query}`);

const hashtagCrawler = new PlaywrightCrawler({
  maxConcurrency: 1,
  maxRequestRetries: 2,
  requestHandlerTimeoutSecs: 90,
  proxyConfiguration,

  launchContext: {
    launchOptions: {
      headless: true,
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-blink-features=AutomationControlled',
      ],
    },
  },

  // Intercept Instagram's internal API calls to capture post data
  preNavigationHooks: [
    async ({ page }) => {
      // Set headers including User-Agent (Playwright uses setExtraHTTPHeaders, not setUserAgent)
      await page.setExtraHTTPHeaders({
        'Accept-Language': 'en-US,en;q=0.9',
        'Accept':
          'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
        'User-Agent':
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) ' +
          'AppleWebKit/537.36 (KHTML, like Gecko) ' +
          'Chrome/124.0.0.0 Safari/537.36',
      });

      // Intercept Instagram GraphQL / API responses
      page.on('response', async (response) => {
        const url = response.url();

        // Instagram loads hashtag feed through these endpoints
        if (
          url.includes('/api/v1/tags/') ||
          url.includes('/graphql/query') ||
          url.includes('tag_feed') ||
          url.includes('explore/tags')
        ) {
          try {
            const contentType = response.headers()['content-type'] || '';
            if (!contentType.includes('application/json')) return;

            const body = await response.json().catch(() => null);
            if (!body) return;

            // Parse usernames from GraphQL response (top posts & recent posts)
            parseUsernamesFromGraphQL(body, collectedUsernames, maxResults);
          } catch (_) {
            // Silently skip non-parseable responses
          }
        }
      });
    },
  ],

  async requestHandler({ page, request }) {
    console.log(`[Phase 1] Page loaded: ${request.url}`);

    // Wait for content to appear
    await page.waitForTimeout(randomDelay(3000, 5000));

    // Scroll to trigger lazy-loaded posts (fires more API calls)
    const scrolls = Math.ceil(maxResults / 12); // ~12 posts visible per scroll
    for (let i = 0; i < scrolls && collectedUsernames.size < maxResults; i++) {
      await page.evaluate(() => window.scrollBy(0, 800));
      await sleep(randomDelay(2000, 4000));
      console.log(`[Phase 1] Scroll ${i + 1}/${scrolls} — ${collectedUsernames.size} usernames so far`);
    }

    // Fallback: try to parse usernames from page HTML shared data
    const sharedData = await page
      .evaluate(() => {
        try {
          const scripts = document.querySelectorAll('script[type="application/json"]');
          for (const s of scripts) {
            const text = s.textContent || '';
            if (text.includes('username') && text.length > 100) return text;
          }
          // Try window._sharedData
          return window._sharedData ? JSON.stringify(window._sharedData) : null;
        } catch {
          return null;
        }
      })
      .catch(() => null);

    if (sharedData) {
      parseUsernamesFromGraphQL(JSON.parse(sharedData), collectedUsernames, maxResults);
    }

    console.log(`[Phase 1] Done. Collected ${collectedUsernames.size} usernames.`);
  },
});

await hashtagCrawler.run([hashtagUrl(query)]);

// ─────────────────────────────────────────────
// PHASE 2: VISIT EACH PROFILE AND EXTRACT DATA
// ─────────────────────────────────────────────

const usernameList = [...collectedUsernames].slice(0, maxResults);

if (usernameList.length === 0) {
  console.log('⚠️  No usernames collected. Instagram may have blocked or changed selectors.');
  await Actor.exit();
}

console.log(`\n[Phase 2] Visiting ${usernameList.length} profiles...`);

const profileCrawler = new PlaywrightCrawler({
  maxConcurrency: 1,
  maxRequestRetries: 2,
  requestHandlerTimeoutSecs: 60,
  proxyConfiguration,

  launchContext: {
    launchOptions: {
      headless: true,
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-blink-features=AutomationControlled',
      ],
    },
  },

  preNavigationHooks: [
    async ({ page }) => {
      // Set User-Agent via headers (Playwright doesn't have page.setUserAgent)
      await page.setExtraHTTPHeaders({
        'User-Agent':
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) ' +
          'AppleWebKit/537.36 (KHTML, like Gecko) ' +
          'Chrome/124.0.0.0 Safari/537.36',
      });

      // Intercept profile API response
      page.on('response', async (response) => {
        const url = response.url();

        if (
          url.includes('/api/v1/users/') ||
          url.includes('/api/v1/usernames/') ||
          (url.includes('graphql') && url.includes('user'))
        ) {
          try {
            const contentType = response.headers()['content-type'] || '';
            if (!contentType.includes('application/json')) return;

            const body = await response.json().catch(() => null);
            if (!body) return;

            // Tag the response to the page for later retrieval
            const existing = await page.evaluate(() => window.__profileData__);
            if (!existing) {
              await page.evaluate(
                (data) => { window.__profileData__ = data; },
                body,
              );
            }
          } catch (_) {}
        }
      });
    },
  ],

  async requestHandler({ page, request }) {
    const username = request.userData.username;
    console.log(`[Phase 2] Profile: @${username}`);

    // Polite delay between profiles — crucial to avoid blocks
    await sleep(randomDelay(3000, 7000));

    await page.waitForTimeout(randomDelay(2000, 4000));

    // Try intercepted API data first
    let profileData = await page.evaluate(() => window.__profileData__).catch(() => null);

    // Fallback: parse from embedded <script> JSON in page HTML
    if (!profileData) {
      const rawData = await page
        .evaluate(() => {
          try {
            // Instagram embeds profile data in a script tag
            const scripts = document.querySelectorAll('script[type="application/json"]');
            for (const s of scripts) {
              const text = s.textContent || '';
              if (
                text.includes('"username"') &&
                text.includes('"follower_count"') &&
                text.length > 200
              ) {
                return text;
              }
            }
            // Legacy _sharedData fallback
            return window._sharedData ? JSON.stringify(window._sharedData) : null;
          } catch {
            return null;
          }
        })
        .catch(() => null);

      if (rawData) {
        try {
          profileData = JSON.parse(rawData);
        } catch (_) {}
      }
    }

    // Parse the profile object from whatever shape Instagram returned
    const profile = extractProfileFields(username, profileData, request.url);

    if (!profile) {
      console.log(`[Phase 2] ⚠️  Could not extract data for @${username}`);
      return;
    }

    // Apply follower filters
    if (minFollowers > 0 && profile.followers < minFollowers) return;
    if (maxFollowers > 0 && profile.followers > maxFollowers) return;

    results.push(profile);
    await Dataset.pushData(profile);
    console.log(`[Phase 2] ✅ @${username} — ${profile.followers} followers`);
  },
});

// Build request list from collected usernames
const profileRequests = usernameList.map((username) => ({
  url: profileUrl(username),
  userData: { username },
}));

await profileCrawler.run(profileRequests);

// ─────────────────────────────────────────────
// DONE
// ─────────────────────────────────────────────

console.log(`\n✅ SpyLeads Actor Complete`);
console.log(`   Profiles extracted : ${results.length}`);
console.log(`   Hashtag queried    : #${query}`);

await Actor.exit();


// ─────────────────────────────────────────────
// PARSE HELPERS
// ─────────────────────────────────────────────

/**
 * Walk a GraphQL response object recursively and pull out
 * any "username" strings into collectedUsernames.
 * Instagram's response structure changes often — recursive search
 * is more robust than hardcoded paths.
 */
function parseUsernamesFromGraphQL(obj, set, limit) {
  if (!obj || typeof obj !== 'object') return;
  if (set.size >= limit) return;

  if (obj.username && typeof obj.username === 'string') {
    set.add(obj.username);
  }

  for (const val of Object.values(obj)) {
    if (set.size >= limit) break;
    if (typeof val === 'object') {
      parseUsernamesFromGraphQL(val, set, limit);
    }
  }
}

/**
 * Given raw data from Instagram (any shape) and a username,
 * return a normalized profile object.
 */
function extractProfileFields(username, rawData, pageUrl) {
  // Walk the object tree looking for the user node
  const userNode = findUserNode(rawData, username);

  if (!userNode) {
    return {
      username,
      followers: 0,
      bio: null,
      email: null,
      category: null,
      location: null,
      profile_url: pageUrl,
      is_verified: null,
    };
  }

  const followers =
    userNode.follower_count ??
    userNode.edge_followed_by?.count ??
    userNode.followers?.count ??
    0;

  const bio = userNode.biography || userNode.bio || null;
  const email = extractEmailFromBio(bio || '') || userNode.public_email || null;
  const category = userNode.category_name || userNode.category || null;
  const location = userNode.city_name || userNode.location || null;

  return {
    username: userNode.username || username,
    followers,
    bio,
    email,
    category,
    location,
    profile_url: `https://www.instagram.com/${username}/`,
    is_verified: userNode.is_verified || false,
  };
}

/**
 * Recursively find a node in obj that looks like an Instagram user
 * (has a "username" matching the expected username).
 */
function findUserNode(obj, username, depth = 0) {
  if (!obj || typeof obj !== 'object' || depth > 12) return null;

  if (
    obj.username === username &&
    (obj.follower_count !== undefined ||
      obj.edge_followed_by !== undefined ||
      obj.biography !== undefined)
  ) {
    return obj;
  }

  for (const val of Object.values(obj)) {
    const found = findUserNode(val, username, depth + 1);
    if (found) return found;
  }

  return null;
}
