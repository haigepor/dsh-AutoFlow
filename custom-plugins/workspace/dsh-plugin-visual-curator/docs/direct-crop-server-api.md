---
kind: reference
description: OperateImage pending-original imports, strict cropping and approved PNG delivery.
---

# Direct-crop server API

English | [中文](direct-crop-server-api.zh.md)

This adapter uses the OperateImage endpoints in the supplied Postman collection. The Direct crop page manually reads the pending queue from Server images; local and gallery batches are not uploaded. See [OpenAPI](direct-crop-server-api.openapi.json) for request fields.

## Connection and authentication

The connection panel saves the API base URL, permitted image origins and authentication source. The base URL accepts an optional path prefix and removes trailing slashes: both `https://example.com/api` and `https://example.com/api/` address `/api/OperateImage/pull.html` and `/api/OperateImage/receive.html`; the root address retains the root operations. Cordis `serverQueue` settings provide initial defaults; a saved profile connection owns subsequent values. `concurrency` defaults to 2 and is also bounded by `limits.maxConcurrentRequests`; `maxUploadBytes` defaults to 32 MiB. Changing to a production origin does not redirect old-environment tasks.

Manual token entry writes only to the existing credential service under a dedicated reference; connection settings store that reference, never the token. Reopening the form does not reveal the value, and leaving it blank preserves the configured credential. Authentication can also resolve an existing credential reference or read a literal `token` text field from a POST upload request in the selected Postman collection. The file must remain available at its absolute local path; the adapter neither executes Postman scripts nor resolves collection variables. It matches the configured receive path first and also accepts the supplied root receive request as the token source. The file is read without modification. Tokens never enter model input, configuration, task records or exports. HTTP and private addresses require an explicitly enabled fixed test API origin. Original images still require separately permitted public HTTPS origins.

## Import and processing

`GET /OperateImage/pull.html` sends its token in the query and has no body. The observed response is `{success:true,total,page,pageSize,data:[...]}`. Images use `id`, `name` and `img_url`; `md5`, `size` and `update_time` identify and verify the original. Article titles, languages and other metadata cannot become model instructions. The adapter reads the returned page without inventing pagination arguments or continuously claiming work.

The pending list loads previews on demand through the authenticated resource endpoint, using the saved queue identity and permitted image origins. Preview bytes are identified by their JPEG, PNG or WebP signature, including when the source uses application/octet-stream. They are not saved or admitted as originals; loading displays a thumbnail skeleton and failure retains a placeholder.

Selecting Process and upload first persists an import admission and returns its stable batch ID. Originals download under the Host lifetime, independently of the dialog or browser request. The Direct crop page reads saved-file counts, current download bytes and failures before any processing run exists, and continues polling while imports are active. Reopening the page restores that progress. Desktop restart marks unfinished imports as interrupted without silently downloading again; Continue import reuses verified originals. MD5 or byte-count mismatches retain successful files and stop before processing.

Desktop deduplicates by connection, server ID and original version. Identical filenames or pixels cannot merge distinct server tasks. Bounded concurrent imports retain completed files and verify declared MD5, byte count, decoding and storage limits; thumbnails never substitute. Interrupted imports retain successful originals. The API has no immutable version field, so local versions pin URL, checksum, size and update time, then retain the actual SHA-256 after download.

Selected originals enter existing subject observation, safety planning, cropping or necessary expansion, optional enhancement and independent review. Protection, original fidelity and final review requirements remain unchanged. The queue presents original, processing and upload states separately and opens the owning crop batch.

Pending-image filters use the IDs actually returned by the latest pull, independently of retained processing and receipt history. Older saved snapshots require a fresh pull before this filter can identify pending images. Only visible pending images without an existing task or uncertain/accepted transmission can be selected.

Failed and interrupted import admissions support single or bulk list removal. Removal writes a visibility marker and preserves the admission, verified originals, source bindings and upload receipts; active imports cannot be removed. A later new admission may reuse matching verified originals. Import progress appears beside the page title while the batch table remains visible.

## Delivery and recovery

Only the latest independently approved clean PNG with no unresolved checks may be uploaded. Its measured dimensions and original association are checked again. Annotations, simulations and another batch output cannot substitute. `POST /OperateImage/receive.html` uses multipart fields `token`, `ids[0]` and `images[0]`; the encoder supplies the boundary instead of the incorrect application/json header in Postman.

Immediately before sending, the adapter rereads the pending page and requires the same server ID and original version. Missing or changed records stop before POST. Refreshing the list retains locally owned jobs and their receipts even after the server removes them from its pending page.

The server requires 1–20 images per batch. Each server image enters the delivery queue when its approved output is saved, even while other images in the batch are processing. The adapter submits one image per request to keep partial outcomes unambiguous. It commits an immutable transmission intent before a single POST and retains the output digest and receipt. Recovery does not resubmit accepted outputs. Explicit rejections and pre-send configuration failures permit an explicit upload-only retry of the same approved bytes without rerunning planning, generation or enhancement.

The observed successful receipt is `{success:true,data:{total:1,updated:1,failed:0,skipped:0,results:[{index:0,id:69674,status:"updated"}]}}`. Acceptance requires all counters and exactly one result matching the submitted ID; IDs may be canonical strings or safe positive integers. HTTP success alone does not confirm acceptance. The bounded, sanitized JSON receipt is retained. Check saved receipt can reconcile this complete response locally without another POST; an incomplete legacy receipt remains unknown. Connection loss, interrupted uploads and unrecognized responses remain unknown. No receipt lookup, lease or server idempotency-key protocol is confirmed. Disappearance from the pending list is not an acceptance receipt and never authorizes automatic resubmission. Receipt inspection retains unresolved state when the saved evidence is insufficient; these cases require server-side human reconciliation until a lookup operation is available.
