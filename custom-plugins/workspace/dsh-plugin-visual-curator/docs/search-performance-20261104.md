---
description: "Measured Unsplash search yield, pagination and latency for bounded automotive queries on 2026-11-04."
---

# Search measurements: 2026-11-04

English | [中文](search-performance-20261104.zh.md)

## Summary

This reference records 28 read-only Unsplash searches using Visual Curator 0.2.7 and a separate native-model comparison using 12 fixed public car-search candidates. It separates candidate retrieval, unique images and metadata signals from pixel acceptance. The measurements support a 50- or 100-candidate retrieval pool and show the two-stage result for one 12-image sample; they do not establish general recall, stable model speed or a permanent provider limit.

## Table of Contents

- [Search interpretation](#search-interpretation)
- [Interface and limits](#interface-and-limits)
- [Query observations](#query-observations)
- [Unique candidate pools](#unique-candidate-pools)
- [Measurement method](#measurement-method)
- [Model latency](#model-latency)
- [Dev Note](#dev-note)

## Search interpretation

Unsplash describes a search that considers tags, title, story, location and collections. Multiple keywords place images matching all tags first, then include images matching a subset; the keywords are not a strict AND filter. A subject-first query therefore retrieves candidates without proving that the subject appears or dominates the image. [Official search explanation](https://help.unsplash.com/en/articles/2574035-multiple-tag-searching)

The tested short queries retain more automotive metadata signals than the long sentence. Use a small first probe across currently enabled subject and scene directions, then use saved pixel-review feedback to deepen productive directions within the same frozen page and candidate budgets. An architecture anchor only applies when the enabled rules include that environment; it is not a default vehicle standard.

A candidate pool is distinct from the requested number of qualified images. Source IDs require deduplication across queries and pages. Metadata matches and a successful preview review do not verify an original file; an unavailable source original cannot be replaced by a preview and reported as an original.

## Interface and limits

The experiment exercises the current source adapter against the Unsplash Web search endpoint. The documented public JSON API is a different endpoint and does not define the Web interface's sustainable rate limit.

| Interface | Parameters and evidence | Limit interpretation |
|---|---|---|
| Current Web adapter | GET https://unsplash.com/napi/search/photos; query, page and per_page | The adapter accepts caller page sizes 1–100 and sends at most 30 |
| Observed Web response | Requested per_page 30, 50 and 100 each returned 20 results | An observation from this experiment, not a permanent 20-image or request-rate guarantee |
| Official public JSON API | GET https://api.unsplash.com/search/photos; query, page, per_page, order_by and optional filters | Documentation states at most 30 items per page; these documented limits do not describe napi |
| Official public JSON API rate | Demo 50 requests/hour; approved production 1,000 requests/hour | These values apply to api.unsplash.com; this experiment does not establish a Web quota |

The [official API documentation](https://unsplash.com/documentation#search-photos) owns public API parameters and limits. The current Web adapter sends no orientation, color, language or collection filter for a full-library search. No HTTP 429 or search failure occurred in the 28 calls.

## Query observations

Every first-page query below returned 20 results with no within-page ID duplication. “Subject signal” counts English automotive words in description or alt_description, including vehicle and common car brands; it is metadata evidence, not a measured visual match rate. Totals are the remote response's reported values and can change even between pages of one query.

| Query | Reported total | Subject signal | Search milliseconds |
|---|---:|---:|---:|
| car | 17,972 | 19/20 | 4,014 |
| car forest | 3,201 | 16/20 | 939 |
| car forest road | 1,687 | 12/20 | 502 |
| forest road car | 8,527 | 12/20 | 1,016 |
| automobile forest road | 4,838 | 6/20 | 881 |
| sports car mountain road | 244 | 15/20 | 817 |
| classic car architecture | 4,293 | 17/20 | 1,216 |
| car driving on a winding forest road warm cinematic golden hour moody reflections | 984 | 5/20 | 1,124 |
| 汽车 森林 公路 | 6,624 | 9/20 | 1,401 |

The case-insensitive subject expression matches car, cars, vehicle, vehicles, automobile, automobiles, suv, porsche, bmw, ferrari, lamborghini, mercedes, audi, sedan or coupe as whole words. It can miss a visible car without those words and cannot determine focal prominence, composition or style. The annotated pages each contained five premium/plus descriptors; this is also an observation, not a fixed premium quota.

## Unique candidate pools

The continuation recheck uses car forest road with caller page size 100. Each call still returned 20 results. The sequence reaches 50 unique candidates on page 3 and 100 on page 6, so five pages cannot be assumed to supply 100 unique candidates.

| Page | Returned | New unique IDs | Cumulative unique IDs | Search milliseconds |
|---|---:|---:|---:|---:|
| 1 | 20 | 20 | 20 | 2,523 |
| 2 | 20 | 19 | 39 | 610 |
| 3 | 20 | 20 | 59 | 632 |
| 4 | 20 | 17 | 76 | 687 |
| 5 | 20 | 20 | 96 | 565 |
| 6 | 20 | 16 | 112 | 1,055 |

The six calls took 6,072 ms in total. A separate five-page pass returned 100 records and 96 unique IDs in 3,939 ms. Three pages of sports car mountain road returned 60 records and 55 unique IDs in 2,568 ms; three pages of classic car architecture returned 60 records and 56 unique IDs in 2,927 ms. The first pages of the first seven short queries contained 140 records and 118 unique IDs.

These counts establish retrieval feasibility for this workload. They do not determine how many candidates survive a pixel screen or how many vision calls a 50- or 100-candidate run needs.

## Measurement method

The 28 calls comprise one smoke request, 21 comparison requests and six continuation requests. They use UnsplashApi and CurlUnsplashTransport with no account credentials, no retries, a 30-second request deadline and a 4 MiB response bound. The two direct per_page probes use the same transport. Requests are sequential under Node 24.14.0 on Windows; no image download or LLM request is included.

Timing starts before the adapter or transport request and ends after its parsed result returns. It includes DNS, curl startup, HTTP and JSON handling. The 21 comparison samples have median 850 ms and nearest-rank P90 1,216 ms; the first request in that process takes 4,014 ms, while the separate smoke takes 4,264 ms. Provider caches and network conditions are uncontrolled, so these are descriptive samples rather than latency guarantees.

All comparison times, in request order, are 4,014; 939; 502; 1,016; 881; 817; 1,216; 1,124; 1,401; 466; 475; 816; 828; 970; 850; 945; 806; 799; 912; 850; 831 ms. The six continuation times are listed in the pool table. The smoke is the remaining 4,264 ms sample.

The experiment stores aggregate counts and timings only. It does not record private prompts, account identifiers, credentials, photo IDs or authenticated response bodies. Public-mode results do not establish the selected account's behavior, keyword semantics beyond the official explanation, or a sustained Web request-rate limit.

## Model latency

A separate opt-in experiment uses the same 12 public candidates, selected native model, synthetic dominant-car and road-or-forest rules, and concurrency of three for both paths. The baseline runs one final review per candidate; the new worker uses two batches of six thumbnails, then reviews the four survivors. Every native request passes through NativeVisionProvider, the registered LLM adapter, attachment admission and RunEngine records in an isolated temporary root.

| Measurement | Single-image final review | Six-image screening plus deep review |
|---|---:|---:|
| Model requests | 12 | 6: two screening and four deep reviews |
| Wall time | 98,976 ms | 80,904 ms |
| Downloaded image bytes | 2,765,703 | 1,187,664 |
| Image transfers | 12 | 16: 12 thumbnails and four full previews |
| Uncached input tokens | 13,364 | 11,943 |
| Cache-read input tokens | 15,360 | 5,888 |
| Output tokens, including reasoning | 26,490 | 17,126 |
| Accumulated image-preparation queue | 10,579 ms | 1,846 ms |
| Accumulated native image preparation | 9,673 ms | 2,027 ms |
| Accumulated model time | 191,695 ms | 122,744 ms |
| Final passes | 1 | 1 |

This pass reduces model requests by 50%, wall time by 18.3% and downloaded bytes by 57.1%. Screening rejects eight candidates and falls back on none. It does not reject the one image that passes the baseline, and that image also passes the new final review. One baseline-positive image cannot establish a general false-rejection rate.

The connection preflight adds one committed model request and 35,921 ms outside the comparison: the successful round contains 19 model requests in total. It uses registered model defaults without increasing output limits; provider and task retries are disabled for the diagnostic's hard 40-call, 10-minute bound. Credential-file bytes remain unchanged. The fixture keeps complete request metadata and admitted attachments under its isolated root for replay and emits aggregate results.

Wall time covers the worker through committed completion, including thumbnail loading, screening transforms, deep-preview loading and storage writes; it excludes corpus collection and case setup. Queue and preparation values above describe the native attachment phase, so thumbnail preparation before that phase remains in wall time. Concurrent request durations are summed and can exceed wall time. pi-ai reports disjoint uncached and cached input and folds reasoning into output. Case order and upstream caches are uncontrolled; this single pass is evidence for this sample, not a calibrated performance guarantee or a comparison of original-file delivery.

## Dev Note

None.
