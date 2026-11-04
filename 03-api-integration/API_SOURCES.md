# F1 INSIDER API Sources

The archive uses public 2024 data from [Jolpica](https://api.jolpi.ca/ergast/f1/):

- `driverstandings.json?limit=10&offset=0` for the driver directory; subsequent pages use offsets 10 and 20.
- `races.json?limit=10&offset=0` for the race directory; subsequent pages use offsets 10 and 20.
- `driverstandings.json?limit=100&offset=0`, `constructorstandings.json?limit=100&offset=0`, and `races.json?limit=100&offset=0` for complete collections where needed. The loader follows `MRData.total` and the returned records when further API pages are required.
- `drivers/{driverId}/driverstandings.json?limit=100&offset=0` for driver details. `drivers/{driverId}.json` provides identity when no standings entry exists.
- `constructors/{constructorId}/constructorstandings.json?limit=100&offset=0` and `constructors/{constructorId}/drivers.json?limit=100&offset=0` for constructor details and historical lineups.
- `{round}/races.json?limit=100&offset=0` for race details.

Paths above are relative to `https://api.jolpi.ca/ergast/f1/2024/`. Links use actual API driver IDs, constructor IDs, and round numbers. Older driver slug links are still resolved from API identity records.

Driver standings include driver identity, nationality, birth date, permanent number, and constructor associations. The site reuses these fields rather than fetching the complete driver directory separately on every page. Home, Teams, Standings, and Search share cached complete standings. Directory search loads a full API collection once when needed because Jolpica does not expose arbitrary text search; subsequent filtering and search pagination are local. Unfiltered Drivers and Races use API pagination. Standings show all records. Teams has ten records and no pagination control.

Per-page championship/calendar requests before cache reuse: Home 3, Drivers 2, Teams 2, Races 1, Standings 2, Search 3. Driver and race detail pages normally use one filtered Jolpica request; constructor detail pages use up to two. A fresh complete driver-standings cache is reused for constructor lineups. Legacy slug resolution and identity-only records may need an additional lookup. Media and Analysis requests are separate.

OpenF1 provides 2024 meeting data, circuit illustrations, and flags:

- `https://api.openf1.org/v1/meetings?year=2024`

T1API provides driver portraits through the documented media endpoint:

- `https://api.t1f1.com/api/static/media/drivers/{DRIVER_CODE}`

T1API's JSON portrait directory does not permit browser `fetch()` from the static site origin due to CORS. The site therefore requests individual documented image endpoints through image elements, matches codes with Jolpica driver records, and shows initials if an image fails to load. It does not use a server proxy. Team logos are omitted unless an individual asset is verified in a browser.

Checks on 2026-11-04 against the [T1API reference documentation](https://docs.t1f1.com/docs/endpoints) and live responses:

- `/api/static/teams`: 11 reference teams, with current assignments; these do not replace 2024 Jolpica records.
- `/api/static/media/teams`: `year: 2026`, 11 logos, all `available: false`.
- `/api/static/media/teams/RBR`: HTTP 404. No unavailable logo is inserted into cards.
- `/api/static/media/drivers`: `year: 2026`, 22 records, 19 marked available. This is current reference imagery, not a verified 2024 photograph collection. Portrait identity uses the Jolpica driver code; uniforms and current reference team assignments must not be interpreted as 2024 data.
- `/api/static/media/drivers/VER`: HTTP 200, `image/png`.
- No documented, available 2024 car photograph endpoint was verified. Team cards retain their monograms, colors, and car-model typography. No car-photo substitute was introduced.

The browser caches failed portrait URLs for one hour to avoid retrying unavailable images on every filter or modal render. Successful images use the browser's HTTP cache.

Wikimedia Commons Action API supplies the homepage editorial photographs and the F1 INSIDER Formula One brand mark. The site reads thumbnail URLs and attribution metadata from API responses; the brand mark is requested by file title (`Formula_One_logo.svg`) and successful metadata is cached in session storage. Its Commons metadata identifies the logo as public domain.

All data is requested in the browser. The site uses session storage to cache successful JSON responses for the current tab session. No API keys or backend services are required.

Jolpica and OpenF1 meeting metadata expire after 30 days; Analysis responses after seven days; Commons editorial queries after seven days; the Commons brand mark after 30 days. Expired valid JSON remains available if refresh fails, with a visible warning. Failed responses and empty refreshes do not overwrite saved nonempty records. Matching concurrent requests share a promise. Failed requests are not repeatedly retried during the same document session. Storage being unavailable does not prevent in-memory reuse. Complete responses saved under the older Jolpica cache keys also remain usable after a failed refresh; their real records are filtered or paged locally for the offline fallback, without rewriting their saved timestamp.

Analysis uses OpenF1 `meetings`, `sessions`, `drivers`, `car_data`, `location`, `overtakes`, `laps`, `race_control`, `stints`, `position`, and `session_result`. Meeting metadata uses the same session-cache key as the race directory. Telemetry and replay show the first two minutes for one selected driver. Grid vs. Results compares the first recorded position with the returned finish, and displays returned DNF/DNS/DSQ flags when the finish is null; it is not an official starting-grid feed.

See [IMPLEMENTATION_REPORT.md](IMPLEMENTATION_REPORT.md) for the browser checks, endpoint evidence, and remaining verification limits.
