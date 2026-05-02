# SpyLeads Instagram Profile Scraper

Apify Actor for SpyLeads SaaS — scrapes Instagram profiles by hashtag.

## Input

| Field | Type | Required | Default | Description |
|---|---|---|---|---|
| `query` | string | ✅ | — | Hashtag (no #). Example: `fitness` |
| `type` | string | — | `hashtag` | Query type (only `hashtag` supported) |
| `maxResults` | integer | — | `50` | Max profiles to return (max 150) |
| `minFollowers` | integer | — | `0` | Min follower filter (0 = no filter) |
| `maxFollowers` | integer | — | `0` | Max follower filter (0 = no filter) |

## Output (per profile)

```json
{
  "username": "fitcoach",
  "followers": 14200,
  "bio": "Online trainer | DM for coaching",
  "email": "coach@gmail.com",
  "category": "Fitness Coach",
  "location": "Mumbai",
  "profile_url": "https://www.instagram.com/fitcoach/",
  "is_verified": false
}
```

## Safe Scraping Settings

- `maxConcurrency: 1` — one page at a time
- Random delays: 3–8 seconds between requests
- Playwright headless Chrome with realistic User-Agent

## How It Works

1. Opens `instagram.com/explore/tags/{hashtag}/`
2. Intercepts Instagram's internal API responses (network-level, not DOM scraping)
3. Collects usernames from post data
4. Visits each profile page
5. Extracts follower count, bio, email, category, location
6. Applies follower filters
7. Pushes results to Apify Dataset

## Deploy to Apify

1. Create a new Actor on [Apify Console](https://console.apify.com)
2. Upload this folder as source
3. Build with the included Dockerfile
4. Run with your desired input

## Flask Backend Integration

```python
from apify_client import ApifyClient

client = ApifyClient("YOUR_APIFY_TOKEN")

run = client.actor("YOUR_USERNAME/spyleads-instagram-scraper").call(
    run_input={
        "query": "fitness",
        "type": "hashtag",
        "maxResults": 50
    }
)

items = client.dataset(run["defaultDatasetId"]).list_items().items
```
