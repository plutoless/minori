# Meeting Search Contract Fix

**Status:** Approved for implementation  
**Date:** 2026-08-12

## Problem

Production `lark-cli vc +search --format json --as user` returns Meeting Record rows with the official shortcut projection:

- `id`: Meeting Record identifier;
- `display_info`: bounded display title;
- `meta_data.description`: provider display description;
- `meta_data.app_link`: provider link.

Minori instead expects the nonexistent row contract `meeting_id / topic / start_time`. A recent production search returned 30 rows, all 30 were omitted, and the run recorded `meeting_contract_error`. This was a Minori contract bug, not evidence that no meetings existed.

`vc +detail` also requires the additive user scope `vc:record:readonly`, which the current OAuth scope list does not request.

## Decision

Minori will parse only the official VC search projection. It will not retain a compatibility branch for the incorrect fixture contract.

For each row:

- a non-empty `id` is required and becomes the run-local Meeting Record identifier;
- a non-empty `display_info` is required and becomes the bounded title;
- a valid HTTP(S) `meta_data.app_link` is optional and becomes the candidate URL;
- `meta_data.description` is provider-formatted display text, not a structured timestamp, so Minori will not infer a start or end time from it;
- missing optional metadata does not invalidate an otherwise fetchable row.

Row normalization remains independent. A malformed row is omitted while valid siblings survive with `status: partial`. A non-empty page with no valid rows remains a fail-closed `meeting_contract_error`. Raw rows, display descriptions, tokens, and provider errors do not enter Neon or model context.

The search request's server-side start/end filter remains authoritative for deciding whether a Meeting Record belongs to the member's requested range. The absence of structured time in the search projection therefore does not make an in-range result unusable.

Meeting detail remains the authoritative source for structured start/end times and artifact associations, but discovery does not eagerly load detail for every search result. `searchMeetings` returns the lightweight candidates immediately. When the Agent needs meeting content, `fetchMeetingContent` loads detail for the selected run-local reference and then reads the selected available artifact. A request for a simple meeting list therefore avoids one detail flow per candidate, while a request to summarize meetings still reads the meetings needed for that answer. The existing soft-five behavior and execution budget govern broad requests; five is not a hard product cap.

The OAuth command, operator documentation, and release contract will add only `vc:record:readonly`; no Calendar, recording-media, meeting-control, or write scopes are added.

This fix does not redesign transcript-source selection. When a member requests an original transcript, Minori continues to read an original meeting text source already available through its existing typed tools and reports that the content is unavailable only when none can be read. User-facing replies do not expose Smart Meeting Note display types or OAuth routing details unless those details are needed to explain a concrete access limitation. The currently unavailable advanced Smart Meeting Note transcript scope is a known capability limitation, not a blocker for Meeting Record search, meeting detail, summaries, or readable Minute transcripts.

## Public seams and tests

Implementation is tested through these public seams:

1. `MeetingService.searchMeetings` accepts a literal official CLI response and returns normalized Meeting candidates.
2. Mixed valid and malformed rows return partial completeness; an all-invalid non-empty page returns `meeting_contract_error` without retaining raw values.
3. Optional `meta_data` fields do not make a fetchable row invalid, and display descriptions are not interpreted as structured time.
4. Meeting search does not eagerly call `getMeetingDetails`; fetching selected meeting content still obtains authoritative detail on demand.
5. The OAuth/release contract requires `vc:record:readonly` together with the existing bounded meeting scopes.

The old `meeting_id / topic / start_time` search fixture is replaced rather than preserved as compatibility behavior.

## Rollout

After code verification:

1. publish `vc:record:readonly` for the existing Minori Feishu app;
2. rerun OAuth for the Dedicated Knowledge User;
3. verify `vc +search` and `vc +detail` with content-free probes;
4. release through the existing protected PR, tag, Production Approval, and immutable-digest deployment path;
5. verify one real recent-meeting query and ensure valid rows are no longer reported as an unavailable search.

If permission publication or OAuth is incomplete, the existing production release remains in service; code deployment does not bypass the permission gate.
