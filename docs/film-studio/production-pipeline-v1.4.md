# filmAI Studio production pipeline — v1.4

This release connects the saved multitrack NLE timeline to an FFmpeg compositor and adds cast/reference continuity plus resumable time-segmented master rendering. It uses the existing Prisma `FilmProduction`, `FilmTimeline`, `FilmAsset` and `FilmRenderJob` records; no additional schema migration is required.

## Multitrack FFmpeg master

- `POST /api/film-studio/render-multitrack` starts a render from the saved timeline. Supply `productionId`, optional `expectedRevision`, optional `segmentSeconds` (30–120; default 90), optional `.cube` LUT, SRT subtitles, ducking controls and master gain.
- The first call creates a durable `FilmRenderJob`, renders one bounded segment, stores the segment in the existing object store and writes its key plus completed segment indexes into the job payload.
- Repeat the call with `{ productionId, renderJobId }` to process the next segment. The response reports `queued`, progress, completed segment count and total segment count.
- When every segment is checkpointed, the next call assembles the MP4 using the FFmpeg concat demuxer, archives the master as a permanent `FilmAsset`, and returns a signed asset URL.
- A failed or interrupted job can be resumed with the same `renderJobId`. Completed segments are skipped. The source timeline revision must remain unchanged; otherwise create a new render job.
- The Render Queue exposes a Resume action for queued or failed multitrack jobs. The legacy `/api/film-studio/render-jobs/process` endpoint rejects multitrack jobs so they cannot accidentally be sent to the older single-sequence renderer.

Picture compositing:
- Multiple video, title and effect tracks are layered in z-order.
- Contiguous overlapping clips on a video track use FFmpeg `xfade` with frame-derived duration and offset. Supported styles include fade, dissolve, wipes, slides and circle transitions. The overlap must equal the configured transition duration; other independently positioned visual layers use alpha fades and timed overlays.
- Per-clip grading supports brightness, contrast, saturation, gamma, exposure, temperature, tint and vignette. Clip effects include blur, sharpen, vignette and grain. The master can also apply a `.cube` 3D LUT and burn in SRT subtitles.

Audio:
- Audio tracks can declare `audioRole` as `dialogue`, `music` or `effects`; absent a role, track names are used to infer the bus. The editor exposes the bus-role selector and visual layer order.
- Each clip supports timeline placement and gain. Dialogue, music and effects are mixed as separate buses.
- When dialogue and music are both present, `sidechaincompress` ducks the music bus under dialogue. Threshold, ratio, attack and release can be configured on the API. The UI uses conservative defaults.

## Character reference and voice registry

- `GET /api/film-studio/cast?productionId=...` returns the cast registry, signed character-reference image URLs, scene reference sets and screenplay dialogue with voice assignments.
- `PUT /api/film-studio/cast` requires `productionId`, `expectedRevision`, `cast` and `sceneReferences`. Character entries contain `character`, `voiceId`, optional `language`/`notes`, and up to 20 owned image asset IDs in `referenceAssetIds`.
- Scene reference entries contain `sceneId`, `characterAssetIds`, `locationAssetIds` and `styleAssetIds`. All references must be image assets owned by the production.
- Scene reference sets inherit the previous scene's character, location and style assets unless overridden or supplemented. The cumulative references and previous-scene handoff are added to the scene prompt.
- Dialogue speaker names are matched case-insensitively to cast members. Configured voice IDs and language are added to the voice continuity lock for scene generation.
- In Engine settings, configure one ComfyUI image-loader node ID per selected reference image and the loader input key. Scene submission uploads each selected owned image to ComfyUI `/upload/image` and writes the returned filename into the corresponding loader node before queueing the workflow. The workflow must expose compatible image loader/conditioning nodes; otherwise ComfyUI will reject the graph.

## Resumability and operational notes

Rendering is time-segmented and checkpointed in the database, but the current driver is request-driven: the UI submits one segment request at a time. It is not yet a Temporal.io workflow or an independent always-on worker. For unattended long-running production, invoke the same segment processor from a supervised worker/Temporal activity and preserve the same job-claim and checkpoint rules.

Each segment renders only its time window plus up to ten seconds of transition pre-roll and post-roll. The padded window preserves cross-boundary transitions and audio timing without reprocessing the full feature for every segment. SRT cues are rebased into the padded local segment clock before burn-in. The timeline is revision-fenced so a changed edit cannot silently alter a render in progress.

Character reference images are uploaded and bound to configured ComfyUI image-loader nodes. Identity conditioning still depends on the configured graph's loader/adapter semantics (for example IP-Adapter/PuLID); merely loading an image does not guarantee identity consistency. Voice IDs are prompt/workflow metadata; the configured speech model must implement those IDs. FFmpeg VFX controls are filter-based and do not provide keyframe animation, masks, tracking or full ACES/OCIO colour management.

## Verification

Run the focused test suite:

```bash
npx vitest run tests/unit/film-studio/production-toolkit.test.ts tests/unit/film-studio/production-pipeline.test.ts
```

Apply the existing migrations and regenerate Prisma as usual:

```bash
npx prisma migrate deploy
npx prisma generate
```
