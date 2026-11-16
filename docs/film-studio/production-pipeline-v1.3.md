# filmAI Studio production pipeline — v1.3

This upgrade extends the existing Next.js, Prisma, ComfyUI and S3-compatible storage architecture. It does not replace the core project system.

## New data model

- `FilmTimeline`: persistent multitrack timeline JSON, frame rate, output dimensions and optimistic revision number.
- `FilmAsset`: permanent generated media with storage key, MIME type, byte size, SHA-256 checksum, source generation job and metadata.
- `FilmRenderJob`: persistent final-master request, status, progress, attempt count, failure details and output asset reference.
- `FilmProductionJob.scheduler`: a snapshot of GPU capacity used when a generation job was submitted.

Apply migrations and regenerate Prisma:

```bash
npx prisma migrate deploy
npx prisma generate
```

## API contracts

### Multitrack timeline

- `GET /api/film-studio/timeline?productionId=...`
- `PUT /api/film-studio/timeline`

`PUT` accepts `productionId`, `fps`, `width`, `height`, `tracks`, and optional `expectedRevision`. Track kinds are `video`, `audio`, `title`, and `effect`. Clips use integer `startFrame`, `sourceInFrame`, `sourceOutFrame`, `transitionInFrames`, and `transitionOutFrames`. Validation permits at most 32 tracks and 30 total clips per timeline, rejects duplicate clip IDs and invalid frame ranges, and uses a revision check to prevent stale overwrites.

### Permanent generated assets

- `GET /api/film-studio/assets?productionId=...`
- `POST /api/film-studio/assets` with `{ productionId, jobId, kind, filename? }`

Completed generation outputs are automatically copied from ComfyUI to the configured S3/MinIO provider during queue reconciliation (first supported output per media kind). The manual endpoint supports an explicit re-import. The asset record stores a SHA-256 checksum and is delivered through an authenticated signed-storage URL. Ingestion rejects mismatched MIME types and media larger than 500 MB.

### Persistent final renders

- `POST /api/film-studio/render-jobs` persists a render request; 1–30 clips are accepted and at most three active render requests per production are allowed.
- `GET /api/film-studio/render-jobs?productionId=...` returns durable job status.
- `POST /api/film-studio/render-jobs/process` claims a queued job, invokes the authenticated FFmpeg renderer server-side, uploads the final MP4 to object storage and links it as a `FilmAsset`.

The render job survives browser reloads and its output is permanently stored. The process endpoint is request-triggered in this release, not an always-on independent worker. Running jobs with a stale heartbeat are marked failed after ten minutes and can be retried from the Render Queue. A production deployment should invoke processing from a supervised worker/Temporal activity for unattended long-running masters and automatic retries after host restarts.

The renderer accepts up to 30 completed generated clips per request and supports 720p, 1080p and 4K UHD output, source-frame trimming based on probed source frame rate, clean cuts between scenes, opening/closing fades and a higher-quality H.264 encode preset. It prefers permanent archived source assets and can render them when ComfyUI is offline. It still uses a single ordered video sequence plus one optional soundtrack, not a full multitrack compositor.

### GPU telemetry and scheduling

- `GET /api/film-studio/gpu` reads ComfyUI `/system_stats`.
- Generation submission snapshots reported VRAM and applies conservative per-production back-pressure. If telemetry is missing, concurrency defaults to one active job. This is a guardrail, not a replacement for ComfyUI's internal scheduler or a model-aware VRAM estimator.

### Bound lip-sync

- `POST /api/film-studio/lipsync` accepts production/scene IDs, speaker name, exact dialogue, permanent source video/audio asset IDs, workflow JSON, video/audio loader node IDs and optional prompt node ID.
- The server verifies ownership, loads the permanent assets, uploads them through configurable ComfyUI `/upload/...` endpoints, injects the returned filenames into the configured loader nodes and submits the workflow.
- Optional `videoUploadPath` and `audioUploadPath` support custom extension endpoints. Defaults are `/upload/image`; custom ComfyUI nodes may require a different endpoint or accepted media type. The route reports upload incompatibility instead of pretending the lip-sync job was created.

## Dialogue and continuity controls

Screenplay splitting is now line-based around `INT.`, `EXT.`, `INT/EXT.` and `SCENE n` headings. It retains character cues, parentheticals and spoken dialogue. Scene prompts extract speaker-labelled dialogue and include hard constraints:

- Only the named character speaks their line.
- Background characters remain silent unless explicitly scripted.
- No invented, translated, paraphrased or reassigned dialogue.
- Keep character identity, hair, wardrobe, body proportions, props and emotional state stable.
- Keep environment geography, architecture, set dressing, weather, time of day, background extras and lighting direction stable.

These instructions are model conditioning, not a guarantee. For reliable recurring cast, use reference-image conditioning, IP-Adapter/PuLID or a character LoRA where supported, and review generated shots before editorial lock.

## Production prompt templates

### Character dialogue / performance

```text
SCENE: {scene_heading}
SPEAKER: {character_name}
EXACT DIALOGUE: {verbatim_dialogue}
PERFORMANCE: {emotion, pace, accent, subtext}
VOICE IDENTITY: {approved_voice_reference}

Only {character_name} speaks this line. Do not reassign it to another character,
add narration, translate, paraphrase or invent words. Background characters stay
silent unless scripted. Mouth movement follows the exact supplied words. Preserve
the approved face, hair, costume, age impression and body proportions.
```

### Location / background continuity

```text
LOCATION BIBLE: {location_name}
PRESERVE: geography, architecture, entrances, windows, furniture, practical lights,
props, weather, time of day, background extras, material palette and screen direction.
CHANGE ONLY: {explicit_scripted_change}

Match the approved location reference. Do not redesign, relocate, remove, add or
rearrange background elements unless the scene explicitly calls for it.
```

### Video-to-video repair

```text
Preserve the source shot's duration, frame rate, camera movement, composition,
blocking, screen direction, cast identity, wardrobe and environment. Change only:
{one_requested_change}. Keep every unmentioned visual and audio property stable.
```

## Operational constraints

- Configure `FILMAI_COMFYUI_URL` on the application server and ensure the server can reach it.
- Configure S3/MinIO using the existing application storage environment variables. The asset library uses the same storage provider as the rest of the application.
- The ComfyUI host must accept the selected upload paths and loader filename formats. Restrict network access to trusted application hosts.
- The master renderer still has bounded media size and execution limits. A 30-clip request is a per-request ceiling, not a claim of unrestricted feature-length rendering.
- Multi-track timeline data is persisted and validated, but full track compositing, audio ducking/mixing, keyframes, transitions between tracks and VFX are not yet wired into the FFmpeg master render.
- Always review generated dialogue, subtitle alignment, continuity and rights before publishing.
