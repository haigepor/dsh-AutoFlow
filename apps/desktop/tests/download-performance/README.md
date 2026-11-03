# Desktop update download measurements

English | [中文](README.zh.md)

## Summary

Windows public full-file downloads use bounded parallel Range requests through Electron. Motrix's engine was downloaded, verified, run, and measured as a candidate; it is not shipped. The [recorded measurements](results-2026-11-03.json) distinguish production transport, prototypes, complete downloads, and interrupted samples. These results describe this Windows machine and these routes on 2026-11-03.

## Contents

- [Engine choice](#engine-choice)
- [Measurements](#measurements)
- [Recovery and integrity](#recovery-and-integrity)
- [Reproduce and qualify](#reproduce-and-qualify)
- [Limits and rollback](#limits-and-rollback)

## Engine choice

The official [Motrix 2.2.0 release](https://github.com/agalwood/Motrix/releases/tag/v2.2.0) pins [aria2 1.37.0-motrix.21](https://github.com/agalwood/Motrix/blob/v2.2.0/scripts/engine.lock.json). [MDXP](https://github.com/motrixapp/mdxp) is the JSON-RPC client protocol, not the transfer engine. The standalone engine reports SQLite3-Persistence and GPL-2.0-or-later with the source's OpenSSL linking exception; the Motrix application license does not determine the engine license.

| Option | Transfer and ownership | Distribution and maintenance |
| --- | --- | --- |
| A: installed Motrix via MDXP | Depends on another application's pairing, configuration, queue, availability, and persistence | No bundled engine; requires an additional installed application and integration with its task lifecycle; not exercised against a user's Motrix |
| B: private bundled Motrix aria2 | Useful throughput on some routes; owns its sockets, SQLite progress, RPC, process exit, proxy routing, and trust configuration | Official x64 ZIP is 4,618,529 bytes; executable is 11,426,816 bytes, before notices and source materials; requires additional lifecycle, packaging, and proxy work |
| C: Electron Range transport | Four workers improved GHFast throughput in the earlier checkpoint implementation while retaining Electron proxy, PAC, certificate handling, and updater ownership | No additional native binary or dependency; separate digest-checked interval journal; selected for Windows |

The tested [official x64 archive](https://github.com/motrixapp/aria2/releases/tag/v1.37.0-motrix.21) SHA256 is `cc3925dba967b6a5fc5c33c5f5bbe81f14ca436f5970b03a5043a11741b5c41c`; the extracted executable SHA256 is `0e692a88146d5eb12ec0c3fe3de2055812b01c5c80147a6e88ecd51985ab5dd6`. Its reported libraries are zlib 1.3.2, expat 2.8.3, SQLite 3.53.4, OpenSSL 3.5.8, c-ares 1.34.8, and libssh2 1.11.1. The ZIP contains the executable; a product redistribution would also need the applicable licenses, notices, and corresponding source arrangements. No engine asset is redistributed by this change.

The fork's `--enable-sqlite3-persistence` replaces text sessions and per-download `.aria2` control files; its database/WAL stores piece bitfields and in-flight progress. Motrix's configuration uses a different save cadence in SQLite mode. The fork explicitly loads Windows ROOT certificates, so it does not inherently require a separate CA file; this still does not import Electron session-specific proxy or certificate policy. Motrix itself has proxy routing, SOCKS bridging, and CA export code. The benchmark used private loopback RPC, a random token, independent SQLite files, strict TLS, and an explicit system/bundled CA bundle. It never contacted another Motrix instance. These integration costs, the measured benefit of C, and the absence of a consistent engine-wide speed advantage favor C; the data does not establish that C always beats aria2.

## Measurements

Environment: Windows 11 build 26200, Intel Core i5-14400, 16 logical processors, NTFS, Node 24.14.0, Electron 44.7.0. The public file is the official 408,869,724-byte Windows installer for `0.2.2-alpha.2.20261103.2`. Cases run sequentially, with fresh application caches and destinations. OS, DNS/TLS, and CDN caches are shared and uncontrolled; later cases are not cold-cache equivalents. Public payload totals in the JSON exclude protocol overhead and some preliminary diagnostics, so they are a lower bound on test traffic.

The following bounded public samples used the earlier, less frequent checkpoint cadence. They do not establish the throughput of the final cadence.

| Configured workers | Electron GHFast, ascending order, MiB/s | Electron GHFast, descending order, MiB/s | aria2 GHFast, reverse order, MiB/s |
| --- | --- | --- | --- |
| 1 | 0.69 | 2.71 | 0.29 |
| 4 | 2.12 | 4.80 | 1.86 |
| 8 | HTTP 429; retained bytes | HTTP 429; retained bytes | 2.98 |
| 16 | HTTP 429; retained bytes | HTTP 429; retained bytes | 1.74 |

Electron samples have 30-second budgets; rate-limited cases stop earlier without same-source retry. aria2 has 15-second budgets and a 1 MiB minimum split size; its actual socket count can be lower than its configured split count. These different budgets and adaptive splits prohibit a precise cross-engine speed ranking. The same-route Electron comparisons support four workers, while the 429 responses oppose defaulting to eight or sixteen. A separate GH-Proxy matrix shows no reliable concurrency gain, with approximately 0.12–0.35 MiB/s. Recorded public payload traffic totals at least 1,699.39 MiB. An earlier uncapped-range prototype reached 5.02 MiB/s at sixteen workers but is excluded from shipping speed claims.

A complete GHFast download through the earlier bounded interval implementation takes 119.93 seconds: 118.17 seconds transfer, 0.82 seconds to first byte, 1.61 seconds whole-file SHA512, and 0.14 seconds final copy. Checkpoint work totals 0.42 seconds. Every byte passes the official size and SHA512 checks. That run uses the preceding `session.fetch` adapter. A second complete run through the proxy-authentication adapter, also before the final checkpoint cadence, takes 247.79 seconds (1.57 MiB/s): transfer 244.74 seconds, first byte 1.10 seconds, checkpoint work 0.41 seconds, SHA512 2.86 seconds and copy 0.18 seconds. The variation limits conclusions about engine speed; both runs verify every byte against the official feed. The earlier automatic-source sample spends 3.63 seconds probing before transfer; that sample did not retain its selected source ID and is not concurrency evidence.

After tightening the final checkpoint cadence so active workers leave at most about 1 MiB unjournaled in aggregate, two Electron loopback runs on a 64 MiB file average 584 ms at one worker and 1,295 ms at four. Cumulative checkpoint work is 112/899 ms, SHA512 348/339 ms, copy 24/30 ms, and mean peak RSS 252/260 MiB. Checkpoint durations are summed across workers and can overlap. The four-worker result is slower on this local workload; background activity and warm filesystem state affect these short samples, and they do not predict internet throughput. Earlier Node and Electron loopback measurements in the JSON used the previous checkpoint cadence. A new same-source public run with 1, 4, 8, and 16 workers failed before receiving bytes with `net::ERR_CONNECTION_TIMED_OUT` in all four cases. The final cadence therefore still needs a successful public comparison and complete download measurement.

CPU, RSS, and event-loop samples cover the benchmark's main process, not Chromium's network process, aria2 CPU, or the entire machine. Disk sync, checkpoint, hash, and copy times are measured; physical disk IOPS and total wire traffic are not. The earlier complete public run has main-process CPU usage of 4.49 seconds, peak RSS 210 MiB, event-loop p99 20.94 ms and maximum 25.20 ms. The earlier proxy-authentication run uses 8.12 seconds of main CPU, peaks at 170 MiB RSS, and records event-loop p99 20.69 ms and maximum 50.66 ms. These are scheduling measurements, not end-to-end input-latency measurements.

## Recovery and integrity

The [Desktop transport documentation](../../README.md#local-updater-qualification) owns cache names and configuration. Each restored interval is hashed independently; a changed interval is requested again without trusting sparse allocation. Legacy import verifies its original prefix, copies it into a separate payload, and keeps the original prefix and journal. One owner admits at most the configured workers and waits for their requests, writes, and journal saves before changing source or returning a pause. Partial intervals are saved on pause and ordinary failures; abrupt exit reuses only previously journaled bytes.

Native differential, authenticated, and metadata-incomplete downloads stay native. The full on-disk artifact must pass size and official SHA512 before native preparation can report readiness. Closing a download window does not pause it or grant installation. Proxy authentication is forwarded through the existing updater login event; this change adds no credential dialog and never forwards origin authentication or account cookies to public mirrors.

## Reproduce and qualify

Run from the repository root with workspace dependencies installed:

```sh
node apps/desktop/scripts/measure-update-download.mjs
node apps/desktop/scripts/test-local-updater.mjs
node apps/desktop/scripts/test-update-download-package.mjs
```

The first command bundles the current transport and runs two 64 MiB loopback rounds through Electron. Optional `--artifact <json>` reads trusted feed fields `url`, `version`, `size`, and `sha512`; `--source ghfast --connections 1,4,8,16 --rounds 2 --budget-ms 30000` selects a bounded public comparison. Zero budget means completion rather than a timed pause. An HTTP failure is recorded separately from a timed pause. All output, userData, caches, and logs use a unique `.desktop-build/qualification/download-performance-*` directory. The other commands qualify actual Electron/NSIS preparation and a separate unsigned Windows x64 ASAR transport application. The ASAR application contains inert bytes and no external download engine; it is not a full product installer.

## Limits and rollback

Focused tests cover overlapping download rejection, exact concurrent ranges, pause, source changes, journal restoration, changed cache bytes, legacy conversion, no Range, wrong/truncated/encoded responses, hash rejection, 403/429, stalls, slow-source failover, disconnects, and checkpoint failure. Real Electron adds fixed/PAC/authenticated proxies, Cookie isolation, untrusted certificate refusal, forced process exit and restart, a partial positional write followed by injected ENOSPC, background close/reopen, native preparation, and separate installation authorization. Screenshot failures are reported independently; unavailable display capture does not establish visual acceptance.

Physical volume exhaustion, hard power loss, enterprise NTLM/Kerberos and complex PAC deployments, a clean-machine full product installation, publisher-signature verification of the live unsigned installer, and macOS behavior remain unverified. aria2 launch/crash recovery is not a shipped product path. The release channel, installed-version comparison, language selection, and installation policy remain owned by the existing coordinator and shell.

Plugin archives reuse the same interval transport with their official SHA256; their existing Node proxy policy remains separate from Electron networking.

Set `DSH_DESKTOP_UPDATE_CONNECTIONS=1` and restart to disable concurrency while retaining new-format resume. For code rollback, revert only this task's transport, tests, and documentation, preserving unrelated workspace changes. Keep interval files: older binaries cannot consume them and can resume only the retained legacy prefix. Reapplying the interval reader recovers the new progress. Do not rename a sparse interval payload to `payload.part`.
