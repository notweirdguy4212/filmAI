# filmAI Studio production pipeline — v1.2

This release strengthens the existing Next.js/Prisma/ComfyUI architecture rather than replacing it. The film workspace remains at `/en/film-studio` (locale prefix varies by deployment).

## Implemented in this upgrade

- **Durable productions:** `FilmProduction` stores screenplay, scene breakdown, production settings, revision number and ownership. A linked core `Project` keeps the production inside the existing project model.
- **Durable render jobs:** `FilmProductionJob` stores the scene, provider, submitted workflow, ComfyUI prompt ID, state, output metadata, failure and timestamps. Jobs survive browser reloads and can be listed by production.
- **Server autosave:** the editor keeps browser recovery and debounced server synchronization. Database sync state is shown separately from local recovery.
- **ComfyUI submission and reconciliation:** scene requests are persisted before submission; provider failures are recorded. Polling ComfyUI history updates durable job status and output metadata.
- **Generated-media ingestion:** completed job outputs are exposed through authenticated preview routes and staged from ComfyUI into temporary render storage for final assembly. They are not yet archived into the managed object store.
- **Continuity prompt builder:** a global visual-style bible and character bible are injected into each scene prompt. This improves text conditioning but cannot guarantee identical faces or costumes; use reference-image, LoRA, IP-Adapter, PuLID or model-specific identity workflows where supported.
- **Frame-accurate editing and assembly:** source in/out points are normalized to the selected output frame rate before trimming; scene order is preserved, CMX3600 EDL includes source/timeline timecodes, and FFmpeg assembles an H.264 MP4. Basic brightness/contrast/saturation controls and optional validated `.cube` 3D LUT application are supported.
- **Timed subtitles:** video uploads have their audio extracted with FFmpeg; a Whisper-compatible multipart transcription endpoint returns segment-timed SRT captions which can be burned into the final MP4. A scene-card SRT export remains available as a fallback.
- **Engine discovery:** the ComfyUI `/object_info` catalogue is inspected for Wan, LTX, Hunyuan, audio/speech, lip-sync and upscaling node families. A detected node does not certify that model weights are installed or inference will succeed.

## Database rollout

Apply the migration before deploying the application:

```bash
npx prisma migrate deploy
npx prisma generate
```

The migration adds `film_productions` and `film_production_jobs`, and adds the optional `Project.filmProduction` relation. Existing projects and data are not rewritten.

## Environment

Required for ComfyUI scene generation:

```env
FILMAI_COMFYUI_URL=http://127.0.0.1:8188
DATABASE_URL=mysql://...
```

Optional independently hosted endpoints:

```env
FILMAI_WHISPER_URL=http://127.0.0.1:8082/v1/audio/transcriptions
FILMAI_WHISPER_API_KEY=optional-server-side-token
FILMAI_WHISPER_MODEL=whisper-1
```

Whisper must accept the OpenAI-compatible multipart `/audio/transcriptions` request and return `verbose_json` segments. The ComfyUI engine inspector reads `/object_info` and detects available Wan, LTX, Hunyuan, audio, lip-sync and upscaling node families. A detected node is not proof that weights are installed or inference will succeed. For ComfyUI, export an **API-format** workflow and set the prompt node ID/input key in Engine settings. Model-specific custom nodes and weights remain separately installed.

## Integration map

| Production stage | Integration path | Current boundary |
|---|---|---|
| Text/image/video-to-video | ComfyUI API workflows; bundled Wan 2.1 source | Model weights and custom nodes are installed separately |
| Long-form continuity | Global character/style prompt bibles + image/reference workflows | Prompt conditioning alone cannot guarantee identity lock |
| Voice generation | Compatible TTS/ComfyUI workflow or configured TTS service | No built-in voice cloning or TTS adapter is claimed |
| Lip-sync | Compatible ComfyUI lip-sync workflow | Model nodes, face tracking and inference workflow required |
| Music/SFX | ACE-Step or other audio-capable ComfyUI workflows | The workflow and model nodes must be installed/configured by the operator |
| Subtitles | Whisper-compatible segment transcription, SRT export and SRT burn-in | Provider must return segment timestamps; human review remains necessary |
| Editorial | Frame-based trim, FFmpeg MP4 assembly, 24 fps CMX3600 EDL, basic grade, `.cube` LUT, fades, optional one-track audio mux and SRT burn-in | Bounded renderer; no multitrack NLE, advanced VFX or persistent final-render job history |
| Final master | Authenticated ComfyUI media ingestion + FFmpeg clip normalization and assembly | Bounded synchronous export; not a durable long-running render worker |

## Prompt templates

### 1. Feature-film scene generation

```text
Create one coherent cinematic shot for the scene below. Treat this as one shot in
an existing film, not a standalone montage.

SCENE: {scene_heading}
ACTION: {visible_action}
CHARACTERS: {character_bible}
LOCATION / PERIOD: {environment_bible}
CONTINUITY FROM PREVIOUS SHOT: {continuity_notes}
VISUAL LANGUAGE: {visual_style_bible}
CAMERA: {shot_size}, {lens}, {camera_motion}, {composition}
LIGHT: {key_direction}, {contrast}, {practical_sources}
DURATION: {duration_seconds}s

Preserve exact character identity, costume, hair, props, screen direction, time of
day and geography. Use motivated motion and physically plausible interactions.
No titles, subtitles, logos, watermarks, sudden cuts or unrequested extra people.
```

### 2. Character reference sheet

```text
Create a neutral production reference sheet for {character_name}. Keep one
recognizable identity across every view. Include front, three-quarter, profile
and full-body views, with the same face shape, age, hair, skin tone, body
proportions, costume, footwear and signature props in every view. Neutral studio
lighting, uncluttered background, consistent scale, no dramatic pose changes.
```

### 3. Environment continuity sheet

```text
Create a reusable location bible for {location_name}. Show the master geography,
entrances and exits, key landmarks, practical light sources, dominant materials,
weather, time-of-day palette and camera-safe screen directions. Maintain the same
architecture and object placement in all later shots unless the script changes it.
```

### 4. Documentary interview / archival shot

```text
Generate a restrained documentary-style shot about {subject}. Prioritize factual
visual clarity, natural light, plausible period details and observational camera
work. Do not invent readable signs, statistics, quotes, documents or identifiable
historical evidence. Any factual claim or archival image must be supplied and
verified by the production team.
```

### 5. Dialogue performance shot

```text
A single continuous dialogue shot. Speaker: {speaker}. Exact spoken line:
{dialogue}. Performance direction: {emotion_and_subtext}. Framing: {framing}.
Keep mouth movement natural and avoid adding dialogue or changing the words.
Maintain the established character design, wardrobe and eyeline. No captions or
on-screen text; subtitles are added in post.
```

### 6. Music brief

```text
Compose an original instrumental score for {scene}. Emotional arc: {arc}.
Tempo range: {bpm}. Instrument palette: {instruments}. Dynamics: {dynamics}.
Leave dialogue frequency space, avoid vocals unless explicitly requested, resolve
cleanly to the requested duration, and do not imitate a named living artist.
```

### 7. Sound-effects brief

```text
Create isolated production sound for {event}. Perspective: {distance_and_space}.
Texture: {material_and_detail}. Duration: {duration}. Provide clean tails and no
music, speech, reverb-heavy mastering or unrelated background sounds.
```

### 8. Shot repair / video-to-video

```text
Preserve the source clip's action, timing, camera path, composition and scene
geography. Change only: {requested_change}. Keep character identity, wardrobe,
lighting direction and prop continuity. Do not add new actions, people, cuts,
text, logos or camera movement. Retain the original frame rate and duration.
```

## Operational notes

- Keep workflow JSON small and avoid embedding binary media in API requests.
- Use a shared, durable database for production metadata; do not rely on browser storage for queue truth.
- ComfyUI output bytes remain on the ComfyUI host and are streamed through authenticated proxy routes. Configure trusted network access and protect the ComfyUI host itself.
- The final renderer accepts up to 24 clips per synchronous request and applies bounded per-file/aggregate media-size checks. This is suitable for short-to-medium assemblies, not an unrestricted feature-length render service. Use a persistent worker and object-storage staging for longer masters.
- Use a storage-backed ingestion adapter before deleting or rotating ComfyUI output history. This release does not duplicate generated media into S3/MinIO.
- The frame-rate EDL defaults to 24 fps. If a project uses another rate, change the helper call and export settings together; drop-frame timecode is not implemented.
- Do not assume that a scene-level SRT is suitable for final dialogue captions. Run ASR and human review for release masters.
