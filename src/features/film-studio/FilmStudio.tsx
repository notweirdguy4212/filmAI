'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { splitScreenplayIntoScenes } from './script-breakdown'
import { buildFilmScenePrompt } from './prompt-builder'
import { exportCmx3600Edl, extractDialogueLines } from './production-toolkit'
import { assignVoicesToDialogue } from './production-pipeline'
import { buildShotListCsv, buildDirectorShotBreakdownCsv } from './shot-list'
import { Link } from '@/i18n/navigation'
import { useUserModels } from '@/lib/query/hooks/useUserModels'
import { BrandLogoShape } from '@/components/ui/icons/BrandLogoShape'
import {
  Aperture, AudioLines, Check, ChevronDown, Clapperboard, Clock3, Download, FileSpreadsheet, FileText,
  Film, Gauge, ImagePlus, Layers3, Library, LoaderCircle,
  Menu, Mic2, MonitorPlay, Music2, RefreshCw, Scissors, Settings2,
  ShieldCheck, Sparkles, Subtitles, WandSparkles, Video, X,
} from 'lucide-react'

type Scene = { id: string; title: string; text: string; duration: number; status: 'draft' | 'queued' | 'ready'; promptId?: string; mediaJobId?: string; startFrame?: number; endFrame?: number; continuityNotes?: string } 
type FilmProject = { title: string; format: string; genre: string; script: string; scenes: Scene[]; workflow: string; promptNodeId: string; promptInput: string; negativePromptNodeId: string; negativePromptInput: string; referenceImageNodeIds: string; referenceImageInput: string; characterBible: string; voiceBible: string; locationBible: string; visualStyle: string; negativePrompt: string; musicWorkflow: string; voiceWorkflow: string; lipSyncWorkflow: string; effectsWorkflow: string; musicPrompt: string; voicePrompt: string; lipSyncPrompt: string; effectsPrompt: string; musicPromptNodeId: string; voicePromptNodeId: string; lipSyncPromptNodeId: string; effectsPromptNodeId: string; musicPromptInput: string; voicePromptInput: string; lipSyncPromptInput: string; effectsPromptInput: string; updatedAt: string }
type Engine = { id: string; label: string; state: 'online' | 'offline' | 'unconfigured'; detail: string }
type EditorClip = { id: string; assetId: string; title: string; startFrame: number; sourceInFrame: number; sourceOutFrame: number; gain?: number; transitionInFrames?: number; transitionOutFrames?: number; transitionType?: 'fade' | 'dissolve' | 'wipeleft' | 'wiperight' | 'slideleft' | 'slideright' | 'circleopen' | 'circleclose'; sourceFps?: number; grade?: { brightness?: number; contrast?: number; saturation?: number; gamma?: number; exposure?: number; temperature?: number; tint?: number; vignette?: number }; effects?: Array<{ type: 'blur' | 'sharpen' | 'vignette' | 'grain'; amount?: number }> }
type EditorTrack = { id: string; name: string; kind: 'video' | 'audio' | 'title' | 'effect'; muted?: boolean; locked?: boolean; audioRole?: 'dialogue' | 'music' | 'effects'; zIndex?: number; clips: EditorClip[] }
const defaultEditorTracks = (): EditorTrack[] => [{ id: 'video-1', name: 'Main picture', kind: 'video', clips: [] }, { id: 'video-2', name: 'Overlay / cutaways', kind: 'video', clips: [] }, { id: 'audio-1', name: 'Dialogue & score', kind: 'audio', clips: [] }]

const STORAGE_KEY = 'filmai-studio-project-v1'
const QUEUE_KEY = 'filmai-studio-queue-v1'
const PRODUCTION_KEY = 'filmai-studio-production-id-v1'
const DEFAULT_SCRIPT = `THE LAST SIGNAL\n\nFADE IN:\n\nEXT. COASTAL ROAD — DAWN\nA lone radio tower blinks above the sleeping shoreline. Mara steps out of an old car, carrying a receiver that has not worked in years.\n\nMARA\n(into the receiver)\nIf anyone can hear me, answer now.\n\nINT. LIGHTHOUSE — MOMENTS LATER\nDust hangs in the beam of a rotating lamp. A voice crackles through the receiver, impossibly close.\n\nVOICE (V.O.)\nYou should not have come back.\n\nEXT. CLIFF EDGE — SUNSET\nMara watches the tower go dark. Far out at sea, a second light answers.`

const initialProject: FilmProject = {
  title: 'The Last Signal', format: 'Short film', genre: 'Sci-fi drama', script: DEFAULT_SCRIPT,
  scenes: [
    { id: 's1', title: 'Coastal Road — Dawn', text: 'A lone radio tower blinks above the sleeping shoreline. Mara steps out of an old car, carrying a receiver that has not worked in years.', duration: 8, status: 'draft' },
    { id: 's2', title: 'Lighthouse — Interior', text: 'Dust hangs in the beam of a rotating lamp. A voice crackles through the receiver, impossibly close.', duration: 8, status: 'draft' },
    { id: 's3', title: 'Cliff Edge — Sunset', text: 'Mara watches the tower go dark. Far out at sea, a second light answers.', duration: 8, status: 'draft' },
  ], workflow: '', promptNodeId: '', promptInput: 'text', negativePromptNodeId: '', negativePromptInput: 'text', referenceImageNodeIds: '', referenceImageInput: 'image', characterBible: '', voiceBible: 'Keep each character voice distinct and stable across scenes; preserve the approved accent, pitch, timbre, cadence and emotional range.', locationBible: '', visualStyle: 'Cinematic naturalism, motivated lighting, controlled camera movement, coherent screen direction, realistic skin and materials, consistent lens language.', negativePrompt: 'identity drift, inconsistent wardrobe, flicker, extra limbs, distorted hands, text, watermark, low resolution', musicWorkflow: '', voiceWorkflow: '', lipSyncWorkflow: '', effectsWorkflow: '', musicPrompt: '', voicePrompt: '', lipSyncPrompt: '', effectsPrompt: '', musicPromptNodeId: '', voicePromptNodeId: '', lipSyncPromptNodeId: '', effectsPromptNodeId: '', musicPromptInput: 'text', voicePromptInput: 'text', lipSyncPromptInput: 'text', effectsPromptInput: 'text', updatedAt: new Date().toISOString(),
}



function downloadFile(name: string, content: string, type = 'application/json') {
  const blob = new Blob([content], { type })
  const url = URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.href = url
  link.download = name
  link.hidden = true
  document.body.appendChild(link)
  link.click()
  link.remove()
  // Let the browser begin the download before releasing the object URL.
  window.setTimeout(() => URL.revokeObjectURL(url), 30_000)
}

export default function FilmStudio() {
  const [project, setProject] = useState<FilmProject>(initialProject)
  const { data: userModels } = useUserModels()
  const [activeTab, setActiveTab] = useState('script')
  const [activeScene, setActiveScene] = useState('s1')
  const [directorMode, setDirectorMode] = useState<'screenplay' | 'story-director' | 'shot-breakdown' | 'production-plan'>('story-director')
  const [directorModel, setDirectorModel] = useState('')
  const [directorBrief, setDirectorBrief] = useState('')
  const [directorResult, setDirectorResult] = useState('')
  const [directorBusy, setDirectorBusy] = useState(false)
  const [screenplayImportBusy, setScreenplayImportBusy] = useState(false)
  const [engines, setEngines] = useState<Engine[]>([
    { id: 'comfyui', label: 'ComfyUI', state: 'unconfigured', detail: 'Connect a local ComfyUI server' },
    { id: 'wan', label: 'Wan video', state: 'unconfigured', detail: 'Available through a ComfyUI Wan workflow or local runner' },
  ])
  const [workflowOpen, setWorkflowOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  const [notice, setNotice] = useState('')
  const [lastSaved, setLastSaved] = useState('Not saved yet')
  const [queue, setQueue] = useState<{ id: string; jobId?: string; scene: string; state: string; media?: { url: string; kind: string; filename: string }[] }[]>([])
  const [mobileNav, setMobileNav] = useState(false)
  const [productionId, setProductionId] = useState('')
  const [hydrated, setHydrated] = useState(false)
  const [serverSaved, setServerSaved] = useState(false)
  const [renderBusy, setRenderBusy] = useState(false)
  const [renderResolution, setRenderResolution] = useState<'1080p' | '720p' | '4k'>('1080p')
  const [grade, setGrade] = useState({ brightness: 0, contrast: 1, saturation: 1 })
  const [subtitleFile, setSubtitleFile] = useState<File | null>(null)
  const [subtitleBusy, setSubtitleBusy] = useState(false)
  const [subtitleCount, setSubtitleCount] = useState(0)
  const [subtitleSrt, setSubtitleSrt] = useState('')
  const [selectedAudioJobId, setSelectedAudioJobId] = useState('')
  const [lutCube, setLutCube] = useState('')
  const [lutName, setLutName] = useState('')
  const [assets, setAssets] = useState<{ id: string; filename: string; kind: string; sizeBytes: string; url: string; checksum: string; metadata?: { durationSeconds?: number; durationIsEstimate?: boolean; sourceFps?: number } | null }[]>([])
  const [timelineTracks, setTimelineTracks] = useState<EditorTrack[]>(defaultEditorTracks)
  const timelineRevisionRef = useRef(0)
  const [timelineFps, setTimelineFps] = useState(24)
  const [timelineReady, setTimelineReady] = useState(false)
  const [timelineProductionId, setTimelineProductionId] = useState('')
  const [timelineSaveState, setTimelineSaveState] = useState('Loading timeline…')
  const [castAssignments, setCastAssignments] = useState<{ character: string; voiceId: string; language?: string; notes?: string; referenceAssetIds: string[] }[]>([])
  const [castSceneReferences, setCastSceneReferences] = useState<{ sceneId: string; characterAssetIds: string[]; locationAssetIds: string[]; styleAssetIds: string[]; continuitySummary?: string }[]>([])
  const [castRevision, setCastRevision] = useState(0)
  const [castStatus, setCastStatus] = useState('Character references not loaded')
  const [castBusy, setCastBusy] = useState(false)
  const [selectedTimelineTrack, setSelectedTimelineTrack] = useState('video-1')
  const [gpuStatus, setGpuStatus] = useState('GPU telemetry not checked')
  const [lipSyncSpeaker, setLipSyncSpeaker] = useState('')
  const [lipSyncDialogue, setLipSyncDialogue] = useState('')
  const [lipSyncVideoAssetId, setLipSyncVideoAssetId] = useState('')
  const [lipSyncAudioAssetId, setLipSyncAudioAssetId] = useState('')
  const [lipSyncVideoNodeId, setLipSyncVideoNodeId] = useState('')
  const [lipSyncAudioNodeId, setLipSyncAudioNodeId] = useState('')
  const [lipSyncPromptNodeId, setLipSyncPromptNodeId] = useState('')
  const [lipSyncVideoUploadPath, setLipSyncVideoUploadPath] = useState('/upload/image')
  const [lipSyncAudioUploadPath, setLipSyncAudioUploadPath] = useState('/upload/image')
  const [freeVideoFiles, setFreeVideoFiles] = useState<File[]>([])
  const [freeVideoDuration, setFreeVideoDuration] = useState(4)
  const [freeVideoRatio, setFreeVideoRatio] = useState<'16:9' | '9:16' | '1:1'>('16:9')
  const [freeVideoBusy, setFreeVideoBusy] = useState(false)
  const [freeVideoProgress, setFreeVideoProgress] = useState(0)
  const [freeVideoUrl, setFreeVideoUrl] = useState('')
  const freeVideoCanvasRef = useRef<HTMLCanvasElement>(null)
  const [renderJobs, setRenderJobs] = useState<{ id: string; status: string; progress: number; failure?: string | null; outputAssetId?: string | null; payload?: { mode?: string } }[]>([])
  const productionCreateStarted = useRef(false)

  useEffect(() => {
    try {
      const savedProductionId = localStorage.getItem(PRODUCTION_KEY)
      if (savedProductionId) setProductionId(savedProductionId)
      const rawQueue = localStorage.getItem(QUEUE_KEY)
      if (rawQueue) setQueue(JSON.parse(rawQueue) as { id: string; jobId?: string; scene: string; state: string; media?: { url: string; kind: string; filename: string }[] }[])
      const raw = localStorage.getItem(STORAGE_KEY)
      if (raw) {
        const saved = JSON.parse(raw) as Partial<FilmProject>
        if (saved && Array.isArray(saved.scenes)) setProject({ ...initialProject, ...saved })
      }
    } catch { setNotice('A saved project could not be read. Your current session is still available.') }
    finally { setHydrated(true) }
  }, [])

  useEffect(() => {
    if (!hydrated) return
    try { localStorage.setItem(QUEUE_KEY, JSON.stringify(queue)) } catch { /* project autosave reports storage errors */ }
  }, [queue, hydrated])

  useEffect(() => {
    if (!hydrated) return
    const timer = window.setTimeout(() => {
      const next = { ...project, updatedAt: new Date().toISOString() }
      try { localStorage.setItem(STORAGE_KEY, JSON.stringify(next)); setLastSaved(new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })) }
      catch { setNotice('Browser storage is full. Export a project backup to protect your work.') }
      if (productionId) {
        void fetch('/api/film-studio/production', { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: productionId, title: project.title, format: project.format, genre: project.genre, script: project.script, scenes: project.scenes, settings: { workflow: project.workflow, promptNodeId: project.promptNodeId, promptInput: project.promptInput, negativePromptNodeId: project.negativePromptNodeId, negativePromptInput: project.negativePromptInput, characterBible: project.characterBible, voiceBible: project.voiceBible, locationBible: project.locationBible, visualStyle: project.visualStyle, negativePrompt: project.negativePrompt, musicWorkflow: project.musicWorkflow, voiceWorkflow: project.voiceWorkflow, lipSyncWorkflow: project.lipSyncWorkflow, effectsWorkflow: project.effectsWorkflow, musicPrompt: project.musicPrompt, voicePrompt: project.voicePrompt, lipSyncPrompt: project.lipSyncPrompt, effectsPrompt: project.effectsPrompt, musicPromptNodeId: project.musicPromptNodeId, voicePromptNodeId: project.voicePromptNodeId, lipSyncPromptNodeId: project.lipSyncPromptNodeId, effectsPromptNodeId: project.effectsPromptNodeId, musicPromptInput: project.musicPromptInput, voicePromptInput: project.voicePromptInput, lipSyncPromptInput: project.lipSyncPromptInput, effectsPromptInput: project.effectsPromptInput } }) })
          .then((response) => { if (!response.ok) throw new Error('Server save failed'); setServerSaved(true) })
          .catch(() => { setServerSaved(false); setNotice('Local autosave succeeded, but cloud project sync failed. Check your database connection.') })
      }
    }, 700)
    return () => window.clearTimeout(timer)
  }, [project, productionId, hydrated])

  useEffect(() => {
    if (!hydrated || productionId || productionCreateStarted.current) return
    productionCreateStarted.current = true
    void fetch('/api/film-studio/production', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ title: project.title, format: project.format, genre: project.genre, script: project.script, scenes: project.scenes, settings: { workflow: project.workflow, promptNodeId: project.promptNodeId, promptInput: project.promptInput, negativePromptNodeId: project.negativePromptNodeId, negativePromptInput: project.negativePromptInput, characterBible: project.characterBible, voiceBible: project.voiceBible, locationBible: project.locationBible, visualStyle: project.visualStyle, negativePrompt: project.negativePrompt, musicWorkflow: project.musicWorkflow, voiceWorkflow: project.voiceWorkflow, lipSyncWorkflow: project.lipSyncWorkflow, effectsWorkflow: project.effectsWorkflow, musicPrompt: project.musicPrompt, voicePrompt: project.voicePrompt, lipSyncPrompt: project.lipSyncPrompt, effectsPrompt: project.effectsPrompt, musicPromptNodeId: project.musicPromptNodeId, voicePromptNodeId: project.voicePromptNodeId, lipSyncPromptNodeId: project.lipSyncPromptNodeId, effectsPromptNodeId: project.effectsPromptNodeId, musicPromptInput: project.musicPromptInput, voicePromptInput: project.voicePromptInput, lipSyncPromptInput: project.lipSyncPromptInput, effectsPromptInput: project.effectsPromptInput } }) })
      .then(async (response) => { const result = await response.json(); if (!response.ok || !result.production?.id) throw new Error(result.error || 'Production persistence is unavailable.') ; return result.production.id as string })
      .then((id) => { setProductionId(id); localStorage.setItem(PRODUCTION_KEY, id); setServerSaved(true) })
      .catch(() => { productionCreateStarted.current = false; setNotice('Cloud production storage is unavailable. Your local autosave remains active; configure the database to enable durable jobs.') })
  }, [hydrated, productionId, project])

  useEffect(() => {
    if (!productionId || !hydrated) return
    let cancelled = false
    void fetch(`/api/film-studio/production?id=${encodeURIComponent(productionId)}`, { cache: 'no-store' }).then((response) => response.ok ? response.json() : null).then((data) => {
      if (cancelled || !data?.production) return
      const saved = data.production as { screenplay?: string; scenes?: Scene[]; settings?: Partial<FilmProject>; title?: string; format?: string; genre?: string }
      setProject((current) => ({ ...current, ...(saved.settings ?? {}), title: saved.title ?? current.title, format: saved.format ?? current.format, genre: saved.genre ?? current.genre, script: saved.screenplay ?? current.script, scenes: Array.isArray(saved.scenes) ? saved.scenes : current.scenes }))
    }).catch(() => undefined)
    return () => { cancelled = true }
  }, [productionId, hydrated])

  const refreshEngines = useCallback(async () => {
    try {
      const response = await fetch('/api/film-studio/engines', { cache: 'no-store' })
      if (!response.ok) throw new Error('Engine status request failed')
      const data = await response.json() as { engines?: Engine[] }
      if (data.engines) setEngines(data.engines)
    } catch { setNotice('Could not check engine connections. Check the application server and try again.') }
  }, [])

  const refreshQueue = useCallback(async (silent = false) => {
    if (!productionId) { setNotice('The production database has not assigned this project an ID yet.'); return }
    try {
      const response = await fetch(`/api/film-studio/queue?productionId=${encodeURIComponent(productionId)}`, { cache: 'no-store' })
      const data = await response.json() as { jobs?: { id: string; providerJobId?: string; sceneId: string; sceneTitle: string; status: string }[]; error?: string }
      if (!response.ok || !data.jobs) throw new Error(data.error || 'Could not refresh the persistent queue.')
      setQueue(data.jobs.map((job) => ({ id: job.providerJobId || job.id, jobId: job.id, scene: job.sceneTitle, state: job.status[0]?.toUpperCase() + job.status.slice(1) })))
      setProject((current) => ({ ...current, scenes: current.scenes.map((scene) => {
        const latestJob = data.jobs!.find((item) => item.sceneId === scene.id)
        return latestJob?.status === 'completed' ? { ...scene, status: 'ready', mediaJobId: latestJob.id } : latestJob?.status === 'failed' ? { ...scene, status: 'draft', mediaJobId: undefined } : scene
      }) }))
      if (!silent) setNotice('Persistent render queue and generated scene media are up to date.')
    } catch (error) { if (!silent) setNotice(error instanceof Error ? error.message : 'Queue refresh failed.') }
  }, [productionId])
  useEffect(() => { void refreshEngines() }, [refreshEngines])

  const refreshAssets = useCallback(async () => {
    if (!productionId) return
    try { const response = await fetch(`/api/film-studio/assets?productionId=${encodeURIComponent(productionId)}`, { cache: 'no-store' }); const data = await response.json() as { assets?: typeof assets }; if (response.ok && data.assets) setAssets(data.assets) } catch { /* asset library remains available offline */ }
  }, [productionId])
  const refreshGpu = useCallback(async () => {
    try { const response = await fetch('/api/film-studio/gpu', { cache: 'no-store' }); const data = await response.json() as { gpu?: { devices?: { name: string; freeBytes: number; totalBytes: number }[]; recommendedConcurrentJobs?: number; reason?: string } }; const devices = data.gpu?.devices ?? []; setGpuStatus(devices.length ? `${devices.map((device) => `${device.name}: ${(device.freeBytes / 1024 ** 3).toFixed(1)} / ${(device.totalBytes / 1024 ** 3).toFixed(1)} GiB free`).join(' · ')} · ${data.gpu?.recommendedConcurrentJobs ?? 1} concurrent job slot(s)` : data.gpu?.reason ?? 'GPU telemetry unavailable; conservative scheduling is active') } catch { setGpuStatus('GPU telemetry unavailable') }
  }, [])
  const refreshRenderJobs = useCallback(async () => {
    if (!productionId) return
    try { const response = await fetch(`/api/film-studio/render-jobs?productionId=${encodeURIComponent(productionId)}`, { cache: 'no-store' }); const data = await response.json() as { jobs?: typeof renderJobs }; if (response.ok && data.jobs) setRenderJobs(data.jobs) } catch { /* durable jobs remain on the server */ }
  }, [productionId])
  const ingestGeneratedAsset = async (jobId: string, kind: 'video' | 'audio' | 'image') => {
    if (!productionId) return
    setNotice(`Permanently importing generated ${kind} into the production asset library…`)
    try { const response = await fetch('/api/film-studio/assets', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ productionId, jobId, kind }) }); const data = await response.json() as { error?: string; asset?: { filename: string } }; if (!response.ok) throw new Error(data.error || 'Asset ingestion failed.'); await refreshAssets(); setNotice(`Stored ${data.asset?.filename ?? 'generated media'} permanently in the production asset library.`) }
    catch (error) { setNotice(error instanceof Error ? error.message : 'Asset ingestion failed.') }
  }

  useEffect(() => {
    if (!productionId) return
    setTimelineReady(false); setTimelineProductionId(''); setTimelineSaveState('Loading timeline…')
    void fetch(`/api/film-studio/timeline?productionId=${encodeURIComponent(productionId)}`, { cache: 'no-store' }).then(async (response) => {
      const data = await response.json() as { timeline?: { tracks?: EditorTrack[]; revision?: number; fps?: number } }
      if (!response.ok || !data.timeline) throw new Error('Could not load the saved multitrack timeline.')
      setTimelineTracks(Array.isArray(data.timeline.tracks) && data.timeline.tracks.length ? data.timeline.tracks : defaultEditorTracks())
      timelineRevisionRef.current = data.timeline.revision ?? 0; setTimelineFps(data.timeline.fps ?? 24); setTimelineProductionId(productionId); setTimelineReady(true); setTimelineSaveState('Timeline loaded')
    }).catch((error) => { setTimelineSaveState(error instanceof Error ? error.message : 'Timeline load failed; saved edits were not overwritten') })
  }, [productionId])

  useEffect(() => {
    if (!timelineReady || !productionId || timelineProductionId !== productionId) return
    const timer = window.setTimeout(() => {
      setTimelineSaveState('Saving…')
      void fetch('/api/film-studio/timeline', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ productionId, fps: timelineFps, width: renderResolution === '4k' ? 3840 : renderResolution === '720p' ? 1280 : 1920, height: renderResolution === '4k' ? 2160 : renderResolution === '720p' ? 720 : 1080, tracks: timelineTracks, expectedRevision: timelineRevisionRef.current || undefined }) }).then(async (response) => {
        const data = await response.json() as { timeline?: { revision: number }; error?: string }
        if (!response.ok || !data.timeline) throw new Error(data.error || 'Timeline save failed.')
        timelineRevisionRef.current = data.timeline.revision; setTimelineSaveState('Saved to production database')
      }).catch((error) => setTimelineSaveState(error instanceof Error ? error.message : 'Timeline save failed'))
    }, 750)
    return () => window.clearTimeout(timer)
  }, [timelineTracks, timelineFps, timelineReady, timelineProductionId, productionId, renderResolution])

  const addEditorTrack = (kind: EditorTrack['kind']) => {
    const id = `${kind}-${crypto.randomUUID()}`
    const track: EditorTrack = { id, name: `${kind[0].toUpperCase()}${kind.slice(1)} ${timelineTracks.filter((item) => item.kind === kind).length + 1}`, kind, clips: [] }
    setTimelineTracks((items) => [...items, track]); setSelectedTimelineTrack(id)
  }
  const addAssetToTimeline = (assetId: string) => {
    const asset = assets.find((item) => item.id === assetId)
    if (!asset) return
    const track = timelineTracks.find((item) => item.id === selectedTimelineTrack)
    if (!track || (track.kind === 'audio' ? asset.kind !== 'audio' : track.kind === 'video' ? !['video', 'image'].includes(asset.kind) : track.kind === 'title' ? asset.kind !== 'image' : !['image', 'video'].includes(asset.kind))) { setNotice('Choose a compatible track for this asset.'); return }
    const durationSeconds = asset.metadata?.durationSeconds ?? 5
    const sourceFps = asset.metadata?.sourceFps ?? timelineFps
    const frames = Math.max(1, Math.round(durationSeconds * sourceFps))
    setTimelineTracks((items) => items.map((item) => item.id !== track.id ? item : { ...item, clips: [...item.clips, { id: crypto.randomUUID(), assetId: asset.id, title: asset.filename, startFrame: item.clips.reduce((end, clip) => Math.max(end, clip.startFrame + Math.round((clip.sourceOutFrame - clip.sourceInFrame) * timelineFps / (clip.sourceFps ?? timelineFps))), 0), sourceInFrame: 0, sourceOutFrame: frames, sourceFps, ...(asset.metadata?.durationIsEstimate ? { transitionInFrames: 0 } : {}) }] }))
  }
  const updateEditorClip = (trackId: string, clipId: string, patch: Partial<EditorClip>) => setTimelineTracks((items) => items.map((track) => track.id !== trackId ? track : { ...track, clips: track.clips.map((clip) => clip.id === clipId ? { ...clip, ...patch } : clip) }))
  const removeEditorClip = (trackId: string, clipId: string) => setTimelineTracks((items) => items.map((track) => track.id !== trackId ? track : { ...track, clips: track.clips.filter((clip) => clip.id !== clipId) }))

  useEffect(() => {
    if (!productionId) return
    void refreshQueue(true); void refreshAssets(); void refreshGpu(); void refreshRenderJobs()
    const timer = window.setInterval(() => { void refreshQueue(true); void refreshAssets(); void refreshGpu(); void refreshRenderJobs() }, 15000)
    return () => window.clearInterval(timer)
  }, [productionId, refreshQueue, refreshAssets, refreshGpu, refreshRenderJobs])

  const selectedScene = project.scenes.find((scene) => scene.id === activeScene) ?? project.scenes[0]
  const totalDuration = useMemo(() => project.scenes.reduce((sum, scene) => sum + scene.duration, 0), [project.scenes])
  const importProject = async (file?: File) => {
    if (!file) return
    try {
      const parsed = JSON.parse(await file.text()) as Partial<FilmProject>
      if (typeof parsed.title !== 'string' || typeof parsed.script !== 'string' || !Array.isArray(parsed.scenes)) throw new Error('This file is not a valid filmAI Studio project.')
      const scenes = parsed.scenes.filter((scene): scene is Scene => Boolean(scene) && typeof scene.id === 'string' && typeof scene.title === 'string' && typeof scene.text === 'string' && typeof scene.duration === 'number' && ['draft', 'queued', 'ready'].includes(scene.status))
      if (scenes.length !== parsed.scenes.length) throw new Error('The project contains invalid scene records.')
      setProject({ ...initialProject, ...parsed, scenes, updatedAt: new Date().toISOString() })
      setActiveScene(scenes[0]?.id ?? '')
      setNotice(`Imported ${file.name}. The project will autosave in this browser.`)
    } catch (error) { setNotice(error instanceof Error ? error.message : 'Could not import this project file.') }
  }

  const importScreenplay = async (file?: File) => {
    if (!file) return
    setScreenplayImportBusy(true)
    setNotice(`Importing screenplay: ${file.name}…`)
    try {
      const form = new FormData()
      form.set('file', file)
      const response = await fetch('/api/film-studio/screenplay/import', { method: 'POST', body: form })
      const result = await response.json() as { screenplay?: string; fileName?: string; wordCount?: number; error?: string }
      if (!response.ok || !result.screenplay) throw new Error(result.error || 'Screenplay import failed.')
      const scenes = splitScreenplayIntoScenes(result.screenplay)
      const importedTitle = (result.fileName || file.name).replace(/\.[^.]+$/, '').replace(/[_-]+/g, ' ').trim()
      setProject((current) => ({ ...current, title: current.title === initialProject.title ? importedTitle.slice(0, 191) : current.title, script: result.screenplay!, scenes, updatedAt: new Date().toISOString() }))
      setActiveScene(scenes[0]?.id ?? '')
      setNotice(`Imported ${result.fileName || file.name} · ${result.wordCount ?? 0} words · ${scenes.length} scenes detected. Review the screenplay and scene breakdown before production.`)
    } catch (error) {
      setNotice(error instanceof Error ? error.message : 'Could not import this screenplay.')
    } finally { setScreenplayImportBusy(false) }
  }

  const update = (patch: Partial<FilmProject>) => setProject((current) => ({ ...current, ...patch }))
  const updateScene = (id: string, patch: Partial<Scene>) => setProject((current) => ({ ...current, scenes: current.scenes.map((scene) => scene.id === id ? { ...scene, ...patch } : scene) }))
  const moveScene = (id: string, offset: number) => {
    const index = project.scenes.findIndex((scene) => scene.id === id)
    const target = index + offset
    if (index < 0 || target < 0 || target >= project.scenes.length) return
    const scenes = [...project.scenes]
    ;[scenes[index], scenes[target]] = [scenes[target], scenes[index]]
    update({ scenes })
  }

  const generateScenes = () => {
    const scenes = splitScreenplayIntoScenes(project.script)
    if (!scenes.length) { setNotice('Add scene headings such as INT. ROOM — NIGHT or EXT. STREET — DAY before breaking down the script.'); return }
    update({ scenes }); setActiveScene(scenes[0].id); setNotice(`${scenes.length} scenes created from the screenplay.`)
  }

  const runDirector = async () => {
    if (!directorModel.trim()) { setNotice('Enter a configured text model key from your account model settings.'); return }
    setDirectorBusy(true); setDirectorResult(''); setNotice('filmAI Story Director is developing your production…')
    try {
      const response = await fetch('/api/film-studio/director', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ productionId, model: directorModel.trim(), mode: directorMode, brief: directorBrief, screenplay: project.script, title: project.title, genre: project.genre, format: project.format, visualStyle: project.visualStyle, characterBible: project.characterBible, locationBible: project.locationBible }),
      })
      const result = await response.json() as { text?: string; error?: string; structured?: unknown; provider?: string; model?: string }
      if (!response.ok || !result.text) throw new Error(result.error || 'Story Director request failed.')
      setDirectorResult(result.text)
      setNotice(`Story Director completed${result.provider ? ` · ${result.provider}` : ''}. Review the result before applying it.`)
    } catch (error) { setNotice(error instanceof Error ? error.message : 'Story Director request failed.') }
    finally { setDirectorBusy(false) }
  }

  const applyDirectorScreenplay = () => {
    if (!directorResult.trim()) return
    let screenplay = directorResult.trim().replace(/^```(?:json|text)?\s*/i, '').replace(/\s*```$/, '')
    try {
      const parsed = JSON.parse(screenplay) as { screenplay?: unknown }
      if (typeof parsed.screenplay === 'string') screenplay = parsed.screenplay
    } catch { /* plain screenplay text is expected in screenplay mode */ }
    if (!screenplay.trim()) { setNotice('The director result does not contain screenplay text.'); return }
    update({ script: screenplay })
    setActiveTab('script')
    setNotice('Director screenplay applied. Review and edit it before production.')
  }

  const exportDirectorShotCsv = () => {
    try {
      const clean = directorResult.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '')
      const parsed = JSON.parse(clean) as unknown
      const csv = buildDirectorShotBreakdownCsv(parsed)
      downloadFile(`${(project.title || 'filmAI').replace(/[^a-z0-9-_]+/gi, '-')}-director-shot-breakdown.csv`, csv, 'text/csv;charset=utf-8')
      setNotice('AI director shot breakdown exported as a spreadsheet-safe CSV.')
    } catch (error) { setNotice(error instanceof Error ? error.message : 'Could not export the shot breakdown.') }
  }

  const queueAllDraftScenes = async () => {
    const pending = project.scenes.filter((scene) => scene.status === 'draft')
    const audioSteps = [
      { id: 'music-score', title: 'Original music score', prompt: project.musicPrompt, workflow: project.musicWorkflow, nodeId: project.musicPromptNodeId, input: project.musicPromptInput },
      { id: 'voice-dialogue', title: 'Voice and dialogue', prompt: project.voicePrompt, workflow: project.voiceWorkflow, nodeId: project.voicePromptNodeId, input: project.voicePromptInput },
      { id: 'sound-effects', title: 'Sound design effects', prompt: project.effectsPrompt, workflow: project.effectsWorkflow, nodeId: project.effectsPromptNodeId, input: project.effectsPromptInput },
    ].filter((step) => step.workflow.trim() && step.prompt.trim())
    if (!pending.length && !audioSteps.length) { setNotice('There are no draft scenes or configured audio tasks to submit.'); return }
    setNotice(`Starting automated production pipeline: ${pending.length} scene(s) and ${audioSteps.length} audio task(s).`)
    for (let index = 0; index < pending.length; index += 1) {
      setNotice(`Automated pipeline · submitting scene ${index + 1} of ${pending.length}: ${pending[index].title}`)
      const jobId = await queueScene(pending[index])
      if (jobId) setProject((current) => ({ ...current, scenes: current.scenes.map((scene) => scene.id === pending[index].id ? { ...scene, status: 'queued', mediaJobId: jobId } : scene) }))
      if (!jobId) { setNotice(`Pipeline paused at ${pending[index].title}. Fix the reported issue, then resume remaining tasks.`); return }
    }
    for (let index = 0; index < audioSteps.length; index += 1) {
      const step = audioSteps[index]
      setNotice(`Automated pipeline · submitting audio task ${index + 1} of ${audioSteps.length}: ${step.title}`)
      const jobId = await submitWorkflow({ sceneId: step.id, title: step.title, prompt: step.prompt, workflowText: step.workflow, promptNodeId: step.nodeId, promptInput: step.input })
      if (!jobId) { setNotice(`Pipeline paused at ${step.title}. Fix the reported issue, then resume remaining tasks.`); return }
    }
    setNotice(`Automated production pipeline submitted ${pending.length} scene(s) and ${audioSteps.length} audio task(s). Monitor the durable jobs in Render queue; review outputs before editing.`)
  }

  const submitWorkflow = async (input: { sceneId: string; title: string; prompt: string; workflowText: string; promptNodeId?: string; promptInput?: string; negativePrompt?: string; negativeNodeId?: string; negativeInput?: string; referenceImageAssetIds?: string[] }) => {
    if (!productionId) { setNotice('Production database is not ready yet. Wait for the project to sync, then retry.'); return }
    if (!input.workflowText.trim()) { setWorkflowOpen(true); setNotice('Add a ComfyUI API workflow in Engine settings before submitting a generation.'); return }
    let workflow: Record<string, { inputs?: Record<string, unknown> }>
    try { workflow = JSON.parse(input.workflowText) as typeof workflow }
    catch { setNotice('The workflow JSON is invalid. Correct it in Engine settings.'); setWorkflowOpen(true); return }
    if (!workflow || typeof workflow !== 'object' || Array.isArray(workflow)) { setNotice('Workflow must be a ComfyUI API-format object.'); return }
    if (input.promptNodeId) {
      const node = workflow[input.promptNodeId]
      if (!node?.inputs) { setNotice(`Prompt node ${input.promptNodeId} was not found in the workflow.`); return }
      node.inputs[input.promptInput || 'text'] = input.prompt
    }
    if (input.negativeNodeId && input.negativePrompt) {
      const node = workflow[input.negativeNodeId]
      if (!node?.inputs) { setNotice(`Negative prompt node ${input.negativeNodeId} was not found in the workflow.`); return }
      node.inputs[input.negativeInput || 'text'] = input.negativePrompt
    }
    const referenceNodeIds = project.referenceImageNodeIds.split(',').map((value) => value.trim()).filter(Boolean)
    const referenceAssetIds = [...new Set(input.referenceImageAssetIds ?? [])]
    if (referenceAssetIds.length && referenceNodeIds.length < referenceAssetIds.length) {
      setNotice(`This scene uses ${referenceAssetIds.length} reference image(s), but only ${referenceNodeIds.length} loader node ID(s) are configured. Add one compatible image-loader node ID per reference image.`)
      return
    }
    const referenceImages = referenceAssetIds.map((assetId, index) => ({ assetId, nodeId: referenceNodeIds[index], input: project.referenceImageInput || 'image' }))
    setBusy(true); setNotice('Submitting generation workflow…')
    try {
      const response = await fetch('/api/film-studio/queue', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ workflow, productionId, sceneId: input.sceneId, sceneTitle: input.title, prompt: input.prompt, ...(referenceImages.length ? { referenceImages } : {}) }) })
      const result = await response.json() as { prompt_id?: string; jobId?: string; error?: string }
      if (!response.ok || !result.prompt_id || !result.jobId) throw new Error(result.error || 'ComfyUI did not accept the workflow')
      setQueue((items) => [{ id: result.prompt_id!, jobId: result.jobId, scene: input.title, state: 'Queued' }, ...items])
      setNotice(`Generation submitted. Durable job ${result.jobId.slice(0, 8)} is queued.`)
      return result.jobId
    } catch (error) { setNotice(error instanceof Error ? error.message : 'Generation submission failed.') }
    finally { setBusy(false) }
  }

  const queueScene = async (scene: Scene) => {
    const previousIndex = project.scenes.findIndex((item) => item.id === scene.id) - 1
    const sceneReferences = castSceneReferences.find((item) => item.sceneId === scene.id)
    const previousSceneSummary = [previousIndex >= 0 ? `${project.scenes[previousIndex].title}: ${project.scenes[previousIndex].text}` : scene.continuityNotes, sceneReferences?.continuitySummary].filter(Boolean).join(' ')
    const dialogue = extractDialogueLines(scene.text)
    const voiceLocks = assignVoicesToDialogue(dialogue, castAssignments).filter((line) => line.voice).map((line) => `${line.speaker} -> ${line.voice?.voiceId}${line.voice?.language ? ` (${line.voice.language})` : ''}`)
    const characterReferenceAssetIds = [...new Set([...castAssignments.filter((member) => dialogue.some((line) => line.speaker.toUpperCase() === member.character.toUpperCase())).flatMap((member) => member.referenceAssetIds), ...(sceneReferences?.characterAssetIds ?? [])])]
    const built = buildFilmScenePrompt({ title: scene.title, description: scene.text, characterBible: project.characterBible, voiceBible: [project.voiceBible, voiceLocks.length ? `FIXED CHARACTER VOICE ASSIGNMENTS: ${voiceLocks.join('; ')}` : ''].filter(Boolean).join('\n'), locationBible: project.locationBible, visualStyle: project.visualStyle, continuityNotes: [previousSceneSummary, scene.continuityNotes].filter(Boolean).join(' '), previousSceneSummary, dialogue, characterReferenceAssetIds, locationReferenceAssetIds: sceneReferences?.locationAssetIds, styleReferenceAssetIds: sceneReferences?.styleAssetIds, negativePrompt: project.negativePrompt })
    const jobId = await submitWorkflow({ sceneId: scene.id, title: scene.title, prompt: built.prompt, workflowText: project.workflow, promptNodeId: project.promptNodeId, promptInput: project.promptInput, negativePrompt: built.negativePrompt, negativeNodeId: project.negativePromptNodeId, negativeInput: project.negativePromptInput, referenceImageAssetIds: [...new Set([...characterReferenceAssetIds, ...(sceneReferences?.locationAssetIds ?? []), ...(sceneReferences?.styleAssetIds ?? [])])] })
    if (jobId) updateScene(scene.id, { status: 'queued', mediaJobId: jobId })
    return jobId
  }

  const transcribeSubtitles = async () => {
    if (!subtitleFile) { setNotice('Choose an audio or video file before generating subtitles.'); return }
    setSubtitleBusy(true); setNotice('Transcribing dialogue and aligning subtitle segments…')
    try {
      const form = new FormData(); form.append('file', subtitleFile)
      const response = await fetch('/api/film-studio/subtitles', { method: 'POST', body: form })
      const result = await response.json() as { srt?: string; count?: number; error?: string }
      if (!response.ok || !result.srt) throw new Error(result.error || 'Subtitle generation failed.')
      downloadFile(`${project.title.replace(/[^a-z0-9-_]+/gi, '-') || 'filmAI'}-subtitles.srt`, result.srt, 'text/plain')
      setSubtitleSrt(result.srt); setSubtitleCount(result.count ?? 0); setNotice(`Generated ${result.count ?? 0} timestamped subtitle segments and downloaded the SRT file.`)
    } catch (error) { setNotice(error instanceof Error ? error.message : 'Subtitle transcription failed.') }
    finally { setSubtitleBusy(false) }
  }

  const submitBoundLipSync = async () => {
    if (!productionId || !project.lipSyncWorkflow.trim() || !selectedScene || !lipSyncSpeaker.trim() || !lipSyncDialogue.trim() || !lipSyncVideoAssetId || !lipSyncAudioAssetId || !lipSyncVideoNodeId.trim() || !lipSyncAudioNodeId.trim()) { setNotice('Choose a permanent source video and dialogue audio, speaker, exact dialogue and loader node IDs.'); return }
    let workflow: Record<string, { inputs?: Record<string, unknown> }>
    try { workflow = JSON.parse(project.lipSyncWorkflow) as typeof workflow } catch { setNotice('The lip-sync workflow JSON is invalid.'); return }
    setBusy(true); setNotice(`Binding source video and dialogue audio for ${lipSyncSpeaker}…`)
    try {
      const response = await fetch('/api/film-studio/lipsync', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ productionId, sceneId: selectedScene.id, sceneTitle: selectedScene.title, speaker: lipSyncSpeaker, dialogue: lipSyncDialogue, videoAssetId: lipSyncVideoAssetId, audioAssetId: lipSyncAudioAssetId, workflow, videoNodeId: lipSyncVideoNodeId, audioNodeId: lipSyncAudioNodeId, promptNodeId: lipSyncPromptNodeId || undefined, videoUploadPath: lipSyncVideoUploadPath, audioUploadPath: lipSyncAudioUploadPath }) })
      const result = await response.json() as { jobId?: string; error?: string }
      if (!response.ok || !result.jobId) throw new Error(result.error || 'Lip-sync submission failed.')
      await refreshQueue(true); setNotice(`Lip-sync submitted for ${lipSyncSpeaker}. Job ${result.jobId.slice(0, 8)} is in the persistent generation queue.`)
    } catch (error) { setNotice(error instanceof Error ? error.message : 'Lip-sync binding failed.') }
    finally { setBusy(false) }
  }

  const renderFilm = async () => {
    const clips = project.scenes.filter((scene) => scene.mediaJobId && scene.status === 'ready').map((scene) => ({ jobId: scene.mediaJobId!, startFrame: scene.startFrame ?? 0, ...(scene.endFrame && scene.endFrame > 0 ? { endFrame: scene.endFrame } : {}) }))
    if (!productionId || clips.length === 0) { setNotice('Generate and complete at least one video scene before rendering.'); return }
    if (clips.length > 30) { setNotice('This render contains more than 30 clips. Split the film into separate render parts, then assemble the parts.'); return }
    setRenderBusy(true); setNotice('Saving a durable render job to the production database…')
    try {
      const payload = { productionId, clips, audioJobId: selectedAudioJobId || undefined, subtitles: subtitleSrt || undefined, lutCube: lutCube || undefined, fps: 24, width: renderResolution === '4k' ? 3840 : renderResolution === '1080p' ? 1920 : 1280, height: renderResolution === '4k' ? 2160 : renderResolution === '1080p' ? 1080 : 720, grade }
      const queued = await fetch('/api/film-studio/render-jobs', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) })
      const queuedData = await queued.json() as { job?: { id: string }; error?: string }
      if (!queued.ok || !queuedData.job?.id) throw new Error(queuedData.error || 'Could not persist the render job.')
      await refreshRenderJobs()
      setNotice(`Render job ${queuedData.job.id.slice(0, 8)} is saved. Starting the server-side render worker…`)
      const processed = await fetch('/api/film-studio/render-jobs/process', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ jobId: queuedData.job.id }) })
      const result = await processed.json() as { asset?: { filename: string; url: string; sizeBytes: number }; error?: string }
      if (!processed.ok || !result.asset?.url) throw new Error(result.error || 'Render worker failed.')
      await refreshRenderJobs(); await refreshAssets()
      const link = document.createElement('a'); link.href = result.asset.url; link.download = result.asset.filename; link.click()
      setNotice(`Render completed and permanently stored (${(result.asset.sizeBytes / 1024 / 1024).toFixed(1)} MB).`)
    } catch (error) { await refreshRenderJobs(); setNotice(error instanceof Error ? error.message : 'Final render failed.') }
    finally { setRenderBusy(false) }
  }


  const runMultitrackRenderJob = async (existingJobId?: string) => {
    if (!productionId) throw new Error('Create or load a production before rendering.')
    let renderJobId = existingJobId
    for (let step = 0; step < 10000; step += 1) {
      const response = await fetch('/api/film-studio/render-multitrack', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(renderJobId
          ? { productionId, renderJobId }
          : { productionId, expectedRevision: timelineRevisionRef.current, subtitles: subtitleSrt || undefined, lutCube: lutCube || undefined, ducking: { enabled: true, threshold: 0.035, ratio: 8, attackMs: 15, releaseMs: 420 }, segmentSeconds: 90 }),
      })
      const result = await response.json() as { jobId?: string; status?: string; progress?: number; completedSegments?: number; totalSegments?: number; asset?: { filename: string; url: string; sizeBytes: number }; error?: string }
      if (result.jobId) renderJobId = result.jobId
      if (!response.ok) {
        if (renderJobId) setNotice(`Render paused with a saved checkpoint (${renderJobId.slice(0, 8)}). Use Resume in the render queue. ${result.error || ''}`)
        throw new Error(result.error || 'Multitrack render failed.')
      }
      if (result.status === 'completed' && result.asset?.url) {
        await refreshRenderJobs()
        await refreshAssets()
        const link = document.createElement('a')
        link.href = result.asset.url
        link.download = result.asset.filename
        link.click()
        setNotice(`Multitrack master rendered and archived (${(result.asset.sizeBytes / 1024 / 1024).toFixed(1)} MB).`)
        return
      }
      await refreshRenderJobs()
      setNotice(`Feature render checkpoint: ${result.completedSegments ?? 0}/${result.totalSegments ?? '?'} segments complete (${result.progress ?? 0}%).`)
    }
    throw new Error('Render exceeded the maximum segment count for one browser session. Resume the saved job from the render queue.')
  }

  const renderMultitrackFilm = async () => {
    if (!productionId || !timelineReady || !timelineTracks.some((track) => track.clips.length)) {
      setNotice('Save a multitrack timeline with at least one permanent asset before rendering.')
      return
    }
    if (!timelineSaveState.toLowerCase().includes('saved')) {
      setNotice('Wait for the timeline autosave to complete before starting the multitrack master.')
      return
    }
    setRenderBusy(true)
    setNotice('Starting checkpointed multitrack FFmpeg rendering…')
    try { await runMultitrackRenderJob() }
    catch (error) { setNotice(error instanceof Error ? error.message : 'Multitrack render failed.') }
    finally { setRenderBusy(false); void refreshRenderJobs() }
  }

  const resumeMultitrackFilm = async (jobId: string) => {
    setRenderBusy(true)
    setNotice(`Resuming saved feature render ${jobId.slice(0, 8)}…`)
    try { await runMultitrackRenderJob(jobId) }
    catch (error) { setNotice(error instanceof Error ? error.message : 'Multitrack render resume failed.') }
    finally { setRenderBusy(false); void refreshRenderJobs() }
  }


  const createFreeVideo = async () => {
    const canvas = freeVideoCanvasRef.current
    if (!canvas || !freeVideoFiles.length) { setNotice('Add at least one image to create a free video.'); return }
    if (!canvas.captureStream || typeof MediaRecorder === 'undefined') { setNotice('Your browser does not support local video recording. Try the latest Chrome, Edge or Firefox.'); return }
    setFreeVideoBusy(true); setFreeVideoProgress(0); setNotice('Creating your video locally in this browser…')
    try {
      const dimensions = freeVideoRatio === '9:16' ? [720, 1280] : freeVideoRatio === '1:1' ? [1080, 1080] : [1280, 720]
      canvas.width = dimensions[0]; canvas.height = dimensions[1]
      const context = canvas.getContext('2d')
      if (!context) throw new Error('Could not initialise the video canvas.')
      const images = await Promise.all(freeVideoFiles.map((file) => new Promise<HTMLImageElement>((resolve, reject) => {
        const image = new Image(); const url = URL.createObjectURL(file)
        image.onload = () => { URL.revokeObjectURL(url); resolve(image) }
        image.onerror = () => { URL.revokeObjectURL(url); reject(new Error(`Could not load ${file.name}.`)) }
        image.src = url
      })))
      const stream = canvas.captureStream(30)
      const mimeType = ['video/webm;codecs=vp9', 'video/webm;codecs=vp8', 'video/webm'].find((type) => MediaRecorder.isTypeSupported(type))
      const recorder = new MediaRecorder(stream, mimeType ? { mimeType } : undefined)
      const chunks: BlobPart[] = []
      recorder.ondataavailable = (event) => { if (event.data.size) chunks.push(event.data) }
      const stopped = new Promise<Blob>((resolve) => { recorder.onstop = () => resolve(new Blob(chunks, { type: recorder.mimeType || 'video/webm' })) })
      recorder.start(250)
      const framesPerImage = freeVideoDuration * 30
      for (let index = 0; index < images.length; index++) {
        const image = images[index]
        for (let frame = 0; frame < framesPerImage; frame++) {
          const progress = frame / Math.max(1, framesPerImage - 1)
          const scale = 1.04 + progress * 0.1
          const imageRatio = image.width / image.height; const canvasRatio = canvas.width / canvas.height
          let drawWidth = canvas.width, drawHeight = canvas.height
          if (imageRatio > canvasRatio) drawWidth = canvas.height * imageRatio
          else drawHeight = canvas.width / imageRatio
          drawWidth *= scale; drawHeight *= scale
          const drift = (progress - .5) * 24
          context.fillStyle = '#080a10'; context.fillRect(0, 0, canvas.width, canvas.height)
          context.drawImage(image, (canvas.width - drawWidth) / 2 + drift, (canvas.height - drawHeight) / 2, drawWidth, drawHeight)
          const gradient = context.createLinearGradient(0, canvas.height * .55, 0, canvas.height)
          gradient.addColorStop(0, 'rgba(0,0,0,0)'); gradient.addColorStop(1, 'rgba(0,0,0,.28)')
          context.fillStyle = gradient; context.fillRect(0, 0, canvas.width, canvas.height)
          setFreeVideoProgress(Math.round(((index * framesPerImage + frame + 1) / (images.length * framesPerImage)) * 100))
          await new Promise((resolve) => window.setTimeout(resolve, 1000 / 30))
        }
      }
      recorder.stop(); stream.getTracks().forEach((track) => track.stop())
      const blob = await stopped
      if (freeVideoUrl) URL.revokeObjectURL(freeVideoUrl)
      const url = URL.createObjectURL(blob); setFreeVideoUrl(url)
      setNotice('Your free video is ready. Download it as a WebM file or add the source images to your edit.')
    } catch (error) { setNotice(error instanceof Error ? error.message : 'Local video creation failed.') }
    finally { setFreeVideoBusy(false) }
  }

  const navItems = [
    { id: 'script', label: 'Screenplay', icon: Clapperboard }, { id: 'director', label: 'AI Story Director', icon: WandSparkles }, { id: 'storyboard', label: 'Storyboard', icon: Layers3 },
    { id: 'timeline', label: 'Timeline', icon: Scissors }, { id: 'free-video', label: 'Free video lab', icon: Video }, { id: 'assets', label: 'Asset library', icon: Library },
    { id: 'audio', label: 'Audio & voices', icon: AudioLines }, { id: 'render', label: 'Render queue', icon: MonitorPlay },
  ]

  return (
    <div className="film-studio-shell filmai-studio-theme">
      <header className="film-topbar">
        <div className="film-brand"><BrandLogoShape uid="film-studio-header" size={42} title="filmAI" className="filmai-brand-symbol film-brand-mark"/><div><strong>filmAI <span>STUDIO</span></strong><small>YOUR AI CREATIVE PRODUCTION SUITE</small></div></div>
        <div className="film-top-project"><span className="film-live-dot"/> <span>{project.title || 'Untitled project'}</span><ChevronDown size={14}/></div>
        <div className="film-top-actions"><span className="film-save-state"><Check size={13}/> Saved {lastSaved}</span><button className="film-icon-button" title="Refresh engine status" onClick={() => void refreshEngines()}><RefreshCw size={16}/></button><label className="film-import-button"><input type="file" accept=".json,.filmai.json,application/json" onChange={(e) => { void importProject(e.target.files?.[0]); e.currentTarget.value = '' }}/>Import</label><button className="film-export-button" onClick={() => downloadFile(`${(project.title || 'film-project').toLowerCase().replace(/[^a-z0-9]+/g, '-')}.filmai.json`, JSON.stringify(project, null, 2))}><Download size={15}/> Export project</button><button className="film-export-button" onClick={() => downloadFile(`${(project.title || 'film-project').toLowerCase().replace(/[^a-z0-9]+/g, '-')}-shot-list.csv`, buildShotListCsv(project.scenes), 'text/csv;charset=utf-8')}><FileSpreadsheet size={15}/> Shot list CSV</button><button className="film-mobile-menu" onClick={() => setMobileNav(!mobileNav)}><Menu size={18}/></button></div>
      </header>

      <div className="film-studio-body">
        <aside className={`film-sidebar ${mobileNav ? 'is-open' : ''}`}>
          <div className="film-sidebar-label">PRODUCTION</div>
          {navItems.map(({ id, label, icon: Icon }) => <button key={id} className={`film-nav-item ${activeTab === id ? 'active' : ''}`} onClick={() => { setActiveTab(id); setMobileNav(false) }}><Icon size={17}/><span>{label}</span>{id === 'render' && queue.length > 0 && <i>{queue.length}</i>}</button>)}
          <div className="film-sidebar-divider"/><div className="film-sidebar-label">PROJECT</div>
          <button className="film-nav-item" onClick={() => setWorkflowOpen(true)}><Settings2 size={17}/><span>Engine settings</span></button>
          <div className="film-sidebar-bottom"><div className="film-engine-heading"><span>CONNECTED ENGINES</span><button onClick={() => void refreshEngines()} aria-label="Refresh"><RefreshCw size={13}/></button></div>{engines.map((engine) => <div className="film-engine-row" key={engine.id}><span className={`film-engine-dot ${engine.state}`}/><span>{engine.label}</span><small>{engine.state === 'online' ? 'Online' : engine.state === 'offline' ? 'Offline' : 'Setup'}</small></div>)}<div className="film-sidebar-foot"><ShieldCheck size={13}/> Local-first project workspace</div></div>
        </aside>

        <main className="film-main">
          <div className="film-page-heading"><div><div className="film-eyebrow">{project.format.toUpperCase()} <span>•</span> {project.genre.toUpperCase()}</div><h1>{navItems.find((item) => item.id === activeTab)?.label ?? 'Studio'}</h1><p>Shape the story, build every shot, and bring your film together.</p></div><div className="film-project-meta"><span><Clock3 size={14}/>{Math.floor(totalDuration / 60)}m {totalDuration % 60}s planned</span><span><Film size={14}/>{project.scenes.length} scenes</span></div></div>
          {notice && <div className="film-notice" role="status">{notice}<button onClick={() => setNotice('')} aria-label="Dismiss"><X size={14}/></button></div>}

          {activeTab === 'script' && <section className="film-script-layout"><div className="film-panel film-script-panel"><div className="film-panel-head"><div><h2>Screenplay</h2><p>Write or paste your script. Use INT. and EXT. headings to identify scenes.</p></div><div className="film-timeline-actions"><label className="film-import-button"><input type="file" accept=".pdf,.docx,.txt,.fountain,application/pdf,application/vnd.openxmlformats-officedocument.wordprocessingml.document,text/plain" disabled={screenplayImportBusy} onChange={(e) => { void importScreenplay(e.target.files?.[0]); e.currentTarget.value = '' }}/>{screenplayImportBusy ? <LoaderCircle size={13} className="spin"/> : <FileText size={13}/>} {screenplayImportBusy ? 'Importing…' : 'Import screenplay'}</label><span className="film-panel-tag">DRAFT</span></div></div><div className="film-project-fields"><label>PROJECT TITLE<input value={project.title} onChange={(e) => update({ title: e.target.value })}/></label><label>FORMAT<select value={project.format} onChange={(e) => update({ format: e.target.value })}><option>Short film</option><option>Drama series</option><option>Documentary</option><option>Feature film</option><option>Commercial</option></select></label><label>GENRE<input value={project.genre} onChange={(e) => update({ genre: e.target.value })}/></label></div><div className="film-continuity-grid"><label>VISUAL STYLE BIBLE<textarea rows={2} value={project.visualStyle} onChange={(e) => update({ visualStyle: e.target.value })} placeholder="Lens language, lighting, palette, camera movement, realism…"/></label><label>CHARACTER CONTINUITY BIBLE<textarea rows={2} value={project.characterBible} onChange={(e) => update({ characterBible: e.target.value })} placeholder="Mara: age range, face, hair, costume, silhouette, voice, distinguishing details…"/></label></div><textarea className="film-screenplay" spellCheck value={project.script} onChange={(e) => update({ script: e.target.value })} aria-label="Screenplay editor"/><div className="film-script-footer"><span>{project.script.trim().split(/\s+/).filter(Boolean).length} words · Autosaved locally</span><button className="film-primary-button" onClick={generateScenes}><WandSparkles size={15}/> Break into scenes</button></div></div><div className="film-side-stack"><div className="film-panel film-story-card"><div className="film-mini-icon"><Sparkles size={17}/></div><h3>From script to screen</h3><p>Break your screenplay into editable scenes, then send each scene to your connected generation workflow.</p><div className="film-step-list"><span><i>01</i> Script breakdown</span><span><i>02</i> Visual direction</span><span><i>03</i> Shot generation</span><span><i>04</i> Edit & assemble</span></div></div><div className="film-panel film-engine-card"><div className="film-card-title"><h3>Generation engines</h3><button onClick={() => setWorkflowOpen(true)}>Configure</button></div>{engines.map((engine) => <div className="film-engine-card-row" key={engine.id}><div><strong>{engine.label}</strong><small>{engine.detail}</small></div><span className={`film-status-pill ${engine.state}`}>{engine.state}</span></div>)}</div></div></section>}

          {activeTab === 'director' && <section className="film-panel film-wide-panel film-director-workspace">
            <div className="film-panel-head"><div><h2>AI screenplay writer & story director</h2><p>Develop scripts, direct the story, break scenes into camera coverage and prepare production plans using a model configured in your account.</p></div><span className="film-panel-tag">AI DEVELOPMENT</span></div>
            <div className="film-director-grid">
              <label>DIRECTOR MODE<select value={directorMode} onChange={(e) => setDirectorMode(e.target.value as typeof directorMode)}><option value="story-director">Story director · treatment & screenplay</option><option value="screenplay">Screenplay writer · full script</option><option value="shot-breakdown">Scene-to-shot breakdown · camera plan</option><option value="production-plan">Production pipeline · schedule & tasks</option></select></label>
              <label>CONFIGURED TEXT MODEL<select value={directorModel} onChange={(e) => setDirectorModel(e.target.value)}><option value="">Choose a configured text model…</option>{(userModels?.llm ?? []).map((model) => <option key={model.value} value={model.value}>{model.label}{model.providerName ? ` · ${model.providerName}` : ''}</option>)}</select></label>
            </div>
            <label className="film-config-label">CREATIVE BRIEF / DIRECTOR'S NOTES<textarea rows={5} value={directorBrief} onChange={(e) => setDirectorBrief(e.target.value)} placeholder="Describe the premise, audience, emotional impact, target runtime, references, constraints, themes and the kind of film you want to make…"/></label>
            <div className="film-director-context"><span><b>Project</b> {project.title}</span><span><b>Format</b> {project.format}</span><span><b>Genre</b> {project.genre}</span><span><b>Scenes</b> {project.scenes.length}</span></div>
            <div className="film-director-actions"><button className="film-primary-button" disabled={directorBusy} onClick={() => void runDirector()}>{directorBusy ? <LoaderCircle size={15} className="spin"/> : <WandSparkles size={15}/>} {directorBusy ? 'Directing…' : 'Run AI Story Director'}</button><span className="film-muted-note">Choose from your account's configured language models. Provider terms, quotas and usage charges apply.</span></div>
            {directorResult && <div className="film-director-result"><div className="film-panel-head"><div><h3>Director's output</h3><p>Review the generated material. Nothing is applied to your project until you choose an action.</p></div><div className="film-timeline-actions"><button className="film-secondary-button" onClick={() => downloadFile(`filmAI-${directorMode}-output.md`, directorResult, 'text/markdown;charset=utf-8')}><Download size={14}/> Export result</button>{directorMode === 'shot-breakdown' && <button className="film-secondary-button" onClick={exportDirectorShotCsv}><FileSpreadsheet size={14}/> Export shot CSV</button>}</div></div><pre>{directorResult}</pre><div className="film-director-actions"><button className="film-primary-button" disabled={directorMode === 'shot-breakdown' || directorMode === 'production-plan'} onClick={applyDirectorScreenplay}>Apply screenplay to project</button><button className="film-secondary-button" onClick={() => { setDirectorBrief(''); setDirectorResult('') }}>Clear workspace</button></div></div>}
            <div className="film-director-capabilities"><article><Sparkles size={18}/><b>Story development</b><span>Loglines, treatments, character arcs, story beats and director vision.</span></article><article><Clapperboard size={18}/><b>Shot planning</b><span>Shot sizes, lenses, camera movement, durations and generation prompts.</span></article><article><Layers3 size={18}/><b>Production planning</b><span>Scene complexity, asset needs, continuity risks and finishing gates.</span></article></div>
          </section>}

          {activeTab === 'storyboard' && <section className="film-panel film-wide-panel"><div className="film-panel-head"><div><h2>Scene storyboard</h2><p>Review each scene, refine its visual direction, and generate shots one at a time.</p></div><div className="film-timeline-actions"><button className="film-secondary-button" onClick={generateScenes}><RefreshCw size={14}/> Rebuild from script</button><button className="film-primary-button" disabled={busy || (!project.scenes.some((scene) => scene.status === 'draft') && !(project.musicWorkflow.trim() && project.musicPrompt.trim()) && !(project.voiceWorkflow.trim() && project.voicePrompt.trim()) && !(project.effectsWorkflow.trim() && project.effectsPrompt.trim()))} onClick={() => void queueAllDraftScenes()}><WandSparkles size={14}/> Run production pipeline</button></div></div>{project.scenes.length ? <div className="film-scene-grid">{project.scenes.map((scene, index) => <article className={`film-scene-card ${activeScene === scene.id ? 'selected' : ''}`} key={scene.id} onClick={() => setActiveScene(scene.id)}><div className="film-scene-art">{scene.mediaJobId && scene.status === 'ready' ? <video className="film-generated-preview" src={`/api/film-studio/media?jobId=${encodeURIComponent(scene.mediaJobId)}`} controls muted playsInline preload="metadata"/> : <div className="film-scene-art-glow"/>}<span>SCENE {String(index + 1).padStart(2, '0')}</span><Clapperboard size={25}/><small>{scene.title}</small></div><div className="film-scene-content"><div className="film-scene-title"><strong>{scene.title}</strong><span>{scene.duration}s</span></div><p>{scene.text || 'Add a scene description to guide the generation.'}</p><div className="film-scene-actions"><span className={`film-scene-status ${scene.status}`}>{scene.status}</span><button disabled={busy} onClick={(e) => { e.stopPropagation(); void queueScene(scene) }}>{busy ? <LoaderCircle size={13} className="spin"/> : <Sparkles size={13}/>} Generate shot</button></div></div></article>)}</div> : <div className="film-empty-state"><ImagePlus size={28}/><h3>No scenes yet</h3><p>Break your screenplay into scenes to start storyboarding.</p><button className="film-primary-button" onClick={generateScenes}>Create scenes</button></div>}{selectedScene && <div className="film-scene-editor"><div><h3>Scene direction</h3><p>Refine the selected scene before sending it to your generation workflow.</p></div><label>SCENE TITLE<input value={selectedScene.title} onChange={(e) => updateScene(selectedScene.id, { title: e.target.value })}/></label><label>VISUAL DESCRIPTION / PROMPT<textarea rows={4} value={selectedScene.text} onChange={(e) => updateScene(selectedScene.id, { text: e.target.value })}/></label><label>SHOT CONTINUITY NOTES<input value={selectedScene.continuityNotes ?? ''} onChange={(e) => updateScene(selectedScene.id, { continuityNotes: e.target.value })} placeholder="Keep screen direction; match previous shot wardrobe and lighting…"/></label><div className="film-scene-editor-actions"><button className="film-secondary-button" onClick={() => moveScene(selectedScene.id, -1)}>Move earlier</button><button className="film-secondary-button" onClick={() => moveScene(selectedScene.id, 1)}>Move later</button><button className="film-primary-button" disabled={busy} onClick={() => void queueScene(selectedScene)}><Sparkles size={14}/> Generate selected scene</button></div></div>}</section>}

          {activeTab === 'timeline' && <section className="film-panel film-wide-panel"><div className="film-panel-head"><div><h2>Editorial timeline</h2><p>Arrange your generated scene clips and set their planned durations.</p></div><span className="film-panel-tag">ASSEMBLY</span></div><div className="film-timeline-ruler"><span>00:00</span><span>{Math.floor(totalDuration / 2)}s</span><span>{totalDuration}s</span></div><div className="film-track-label">VIDEO 01 <span>V1</span></div><div className="film-timeline-track">{project.scenes.map((scene, index) => <div className="film-timeline-clip" key={scene.id} style={{ flex: `${Math.max(scene.duration, 2)} 1 0` }}><b>{String(index + 1).padStart(2, '0')} · {scene.title}</b><small>{scene.duration}s · {scene.status === 'ready' ? 'Media ready' : scene.status === 'queued' ? 'Generation queued' : 'Awaiting media'}</small><div className="film-clip-progress"/></div>)}</div><div className="film-track-label">AUDIO 01 <span>A1</span></div><div className="film-audio-track"><AudioLines size={17}/><span>Choose a completed generated score or dialogue job below to include it in the final render</span></div><div className="film-timeline-controls"><label>Selected scene duration <input type="number" min="1" max="600" value={selectedScene?.duration ?? 8} onChange={(e) => selectedScene && updateScene(selectedScene.id, { duration: Math.max(1, Math.min(600, Number(e.target.value) || 1)) })}/> seconds</label><div className="film-timeline-actions"><button className="film-secondary-button" disabled={!selectedScene || project.scenes[0]?.id === selectedScene.id} onClick={() => selectedScene && moveScene(selectedScene.id, -1)}>Move earlier</button><button className="film-secondary-button" disabled={!selectedScene || project.scenes[project.scenes.length - 1]?.id === selectedScene.id} onClick={() => selectedScene && moveScene(selectedScene.id, 1)}>Move later</button><button className="film-secondary-button" onClick={() => downloadFile('filmAI-edit-decision-list.json', JSON.stringify({ title: project.title, fps: 24, scenes: project.scenes.map((s) => ({ id: s.id, title: s.title, durationSeconds: s.duration, promptId: s.promptId ?? null })) }, null, 2))}><Download size={14}/> Export edit list</button><button className="film-secondary-button" onClick={() => downloadFile('filmAI-frame-accurate.edl', exportCmx3600Edl(project.title, project.scenes.map((scene) => ({ id: scene.id, title: scene.title, durationSeconds: scene.duration, sourceInFrame: scene.startFrame ?? 0, ...(scene.endFrame && scene.endFrame > (scene.startFrame ?? 0) ? { sourceOutFrame: scene.endFrame } : {}) })), 24), 'text/plain')}><Scissors size={14}/> Export 24fps EDL</button><button className="film-secondary-button" onClick={() => { let t = 0; const stamp = (v: number) => { const ms = Math.round(v * 1000); const h = Math.floor(ms / 3600000); const m = Math.floor(ms % 3600000 / 60000); const sec = Math.floor(ms % 60000 / 1000); const milli = ms % 1000; return `${String(h).padStart(2,'0')}:${String(m).padStart(2,'0')}:${String(sec).padStart(2,'0')},${String(milli).padStart(3,'0')}` }; const srt = project.scenes.map((scene, i) => { const start = t; t += scene.duration; return `${i+1}\n${stamp(start)} --> ${stamp(t)}\n${scene.title}: ${scene.text}\n` }).join('\n'); downloadFile('filmAI-scene-subtitles.srt', srt, 'text/plain') }}><Subtitles size={14}/> Export timed scene captions</button></div></div><div className="film-frame-controls"><label>Start frame<input type="number" min="0" max="10000000" value={selectedScene?.startFrame ?? 0} onChange={(e) => selectedScene && updateScene(selectedScene.id, { startFrame: Math.max(0, Number(e.target.value) || 0) })}/></label><label>End frame (0 = source end)<input type="number" min="0" max="10000000" value={selectedScene?.endFrame ?? 0} onChange={(e) => selectedScene && updateScene(selectedScene.id, { endFrame: Math.max(0, Number(e.target.value) || 0) })}/></label><label>Export resolution<select value={renderResolution} onChange={(e) => setRenderResolution(e.target.value as '1080p' | '720p' | '4k')}><option value="1080p">1080p</option><option value="720p">720p</option><option value="4k">4K UHD</option></select></label></div><div className="film-frame-controls"><label>Soundtrack / dialogue<select value={selectedAudioJobId} onChange={(e) => setSelectedAudioJobId(e.target.value)}><option value="">No audio track</option>{queue.filter((job) => job.jobId && job.state === 'Completed' && /music|voice|audio|score|sound|effects/i.test(job.scene)).map((job) => <option key={job.jobId} value={job.jobId}>{job.scene}</option>)}</select></label><label>Subtitle track<span>{subtitleSrt ? `${subtitleCount} timed cues ready · will be burned in` : 'No timed subtitle file loaded'}</span></label></div><div className="film-grade-controls"><label>Brightness<input type="range" min="-0.2" max="0.2" step="0.01" value={grade.brightness} onChange={(e) => setGrade((g) => ({ ...g, brightness: Number(e.target.value) }))}/></label><label>Contrast<input type="range" min="0.5" max="1.8" step="0.05" value={grade.contrast} onChange={(e) => setGrade((g) => ({ ...g, contrast: Number(e.target.value) }))}/></label><label>Saturation<input type="range" min="0" max="2" step="0.05" value={grade.saturation} onChange={(e) => setGrade((g) => ({ ...g, saturation: Number(e.target.value) }))}/></label></div><label className="film-lut-upload">3D colour LUT (.cube)<input type="file" accept=".cube,text/plain" onChange={(e) => { const file = e.target.files?.[0]; if (!file) return; if (file.size > 2 * 1024 * 1024) { setNotice('LUT files must be 2 MB or smaller.'); return } void file.text().then((text) => { setLutCube(text); setLutName(file.name); setNotice(`Loaded colour LUT: ${file.name}`) }) }}/><span>{lutName || 'Optional .cube look file'}</span></label><div className="film-timeline-actions"><button className="film-primary-button" disabled={renderBusy || !project.scenes.some((scene) => scene.status === 'ready' && scene.mediaJobId)} onClick={() => void renderFilm()}>{renderBusy ? <LoaderCircle size={14} className="spin"/> : <Film size={14}/>} Render final film</button></div><p className="film-muted-note">This quick render assembles the ordered storyboard scene clips. For the complete picture/audio composite, use Render multitrack master in the multitrack editor: it composites video, overlay and effect tracks, applies supported transitions and grading, mixes dialogue/music/effects buses with automatic music ducking, and renders checkpointed segments into an H.264 MP4. Both render paths support 720p, 1080p and 4K UHD output subject to source media and server capacity.</p></section>}

          {activeTab === 'timeline' && <section className="film-panel film-wide-panel"><div className="film-panel-head"><div><h2>Multitrack editor</h2><p>Place permanently stored picture, overlay, title/effect and audio assets on separate frame-based tracks.</p></div><span className="film-panel-tag">{timelineSaveState}</span></div><div className="film-timeline-actions"><label>Frame rate<select value={timelineFps} onChange={(e) => setTimelineFps(Number(e.target.value))}><option value={24}>24 fps</option><option value={25}>25 fps</option><option value={30}>30 fps</option><option value={50}>50 fps</option><option value={60}>60 fps</option></select></label><label>Target track<select value={selectedTimelineTrack} onChange={(e) => setSelectedTimelineTrack(e.target.value)}>{timelineTracks.map((track) => <option key={track.id} value={track.id}>{track.name} · {track.kind}</option>)}</select></label><label>Add permanent asset<select defaultValue="" onChange={(e) => { if (e.target.value) addAssetToTimeline(e.target.value); e.currentTarget.value = '' }}><option value="">Choose asset to add…</option>{assets.map((asset) => <option key={asset.id} value={asset.id}>{asset.filename} · {asset.kind}</option>)}</select></label><button className="film-secondary-button" onClick={() => addEditorTrack('video')}>+ Video track</button><button className="film-secondary-button" onClick={() => addEditorTrack('audio')}>+ Audio track</button><button className="film-secondary-button" onClick={() => addEditorTrack('title')}>+ Title track</button><button className="film-secondary-button" onClick={() => addEditorTrack('effect')}>+ Effects track</button><button className="film-primary-button" disabled={renderBusy || !timelineReady || !timelineTracks.some((track) => track.clips.length)} onClick={() => void renderMultitrackFilm()}><Film size={14}/> Render multitrack master</button></div>{timelineTracks.map((track) => <div className="film-nle-track" key={track.id}><div className="film-track-label">{track.name.toUpperCase()} <span>{track.kind.toUpperCase()}</span>{track.kind === 'audio' ? <select aria-label="Audio bus role" value={track.audioRole ?? (/dialog|voice|speech/i.test(track.name) ? 'dialogue' : /music|score/i.test(track.name) ? 'music' : 'effects')} onChange={(e) => setTimelineTracks((items) => items.map((item) => item.id === track.id ? { ...item, audioRole: e.target.value as EditorTrack['audioRole'] } : item))}><option value="dialogue">Dialogue bus</option><option value="music">Music bus</option><option value="effects">Effects bus</option></select> : <label>Layer <input aria-label="Visual layer order" type="number" value={track.zIndex ?? 0} onChange={(e) => setTimelineTracks((items) => items.map((item) => item.id === track.id ? { ...item, zIndex: Number(e.target.value) || 0 } : item))}/></label>}</div>{track.clips.length ? track.clips.map((clip) => <div className="film-nle-clip" key={clip.id}><strong>{clip.title}</strong><div className="film-frame-controls"><label>Timeline start frame<input type="number" min="0" value={clip.startFrame} onChange={(e) => updateEditorClip(track.id, clip.id, { startFrame: Math.max(0, Number(e.target.value) || 0) })}/></label><label>Source in frame<input type="number" min="0" value={clip.sourceInFrame} onChange={(e) => updateEditorClip(track.id, clip.id, { sourceInFrame: Math.max(0, Number(e.target.value) || 0) })}/></label><label>Source out frame<input type="number" min="1" value={clip.sourceOutFrame} onChange={(e) => updateEditorClip(track.id, clip.id, { sourceOutFrame: Math.max(1, Number(e.target.value) || 1) })}/></label><label>Transition in (frames)<input type="number" min="0" max={timelineFps * 10} value={clip.transitionInFrames ?? 0} onChange={(e) => updateEditorClip(track.id, clip.id, { transitionInFrames: Math.max(0, Number(e.target.value) || 0) })}/></label><label>Transition out (frames)<input type="number" min="0" max={timelineFps * 10} value={clip.transitionOutFrames ?? 0} onChange={(e) => updateEditorClip(track.id, clip.id, { transitionOutFrames: Math.max(0, Number(e.target.value) || 0) })}/></label><label>Transition style<select value={clip.transitionType ?? "fade"} onChange={(e) => updateEditorClip(track.id, clip.id, { transitionType: e.target.value as EditorClip["transitionType"] })}><option value="fade">Crossfade</option><option value="dissolve">Dissolve</option><option value="wipeleft">Wipe left</option><option value="wiperight">Wipe right</option><option value="slideleft">Slide left</option><option value="slideright">Slide right</option><option value="circleopen">Circle open</option><option value="circleclose">Circle close</option></select></label>{track.kind !== "audio" ? <><label>Contrast<input type="range" min="0.5" max="1.8" step="0.05" value={clip.grade?.contrast ?? 1} onChange={(e) => updateEditorClip(track.id, clip.id, { grade: { ...clip.grade, contrast: Number(e.target.value) } })}/></label><label>Saturation<input type="range" min="0" max="2" step="0.05" value={clip.grade?.saturation ?? 1} onChange={(e) => updateEditorClip(track.id, clip.id, { grade: { ...clip.grade, saturation: Number(e.target.value) } })}/></label><label>Exposure<input type="range" min="-3" max="3" step="0.1" value={clip.grade?.exposure ?? 0} onChange={(e) => updateEditorClip(track.id, clip.id, { grade: { ...clip.grade, exposure: Number(e.target.value) } })}/></label><label>VFX<select value={clip.effects?.[0]?.type ?? "none"} onChange={(e) => updateEditorClip(track.id, clip.id, { effects: e.target.value === "none" ? [] : [{ type: e.target.value as "blur" | "sharpen" | "vignette" | "grain", amount: 0.35 }] })}><option value="none">No effect</option><option value="blur">Blur</option><option value="sharpen">Sharpen</option><option value="vignette">Vignette</option><option value="grain">Film grain</option></select></label></> : <label>Clip gain<input type="range" min="0" max="4" step="0.05" value={clip.gain ?? 1} onChange={(e) => updateEditorClip(track.id, clip.id, { gain: Number(e.target.value) })}/></label>}<button className="film-secondary-button" onClick={() => removeEditorClip(track.id, clip.id)}>Remove clip</button></div></div>) : <p className="film-muted-note">No clips on this track. Choose a compatible permanent asset above.</p>}</div>)}<p className="film-muted-note">Timeline edits autosave to the production database using revision checks. Render multitrack master composites picture, overlay and effect tracks, applies frame-based alpha crossfades and clip grading, mixes separate dialogue/music/effects buses, and ducks music under dialogue. Feature masters render in bounded time segments; each completed segment is archived and checkpointed in the durable render job so interrupted jobs can resume without re-rendering finished segments.</p></section>}

          {activeTab === 'assets' && <section className="film-panel film-wide-panel"><div className="film-panel-head"><div><h2>Production asset library</h2><p>Generated scenes, dialogue, music and final masters stored in permanent object storage.</p></div><button className="film-secondary-button" onClick={() => void refreshAssets()}><RefreshCw size={14}/> Refresh</button></div><div className="film-connected-asset"><div className="film-mini-icon"><Library size={19}/></div><div><h3>Project Asset Hub</h3><p>Character records, appearance references, locations, props, folders and managed media operations.</p><Link href="/workspace/asset-hub" className="film-primary-button">Open Asset Hub <span aria-hidden="true">→</span></Link></div></div>{assets.length ? <div className="film-queue-list">{assets.map((asset) => <div className="film-queue-item" key={asset.id}><div className="film-queue-icon"><Library size={17}/></div><div><strong>{asset.filename}</strong><small>{asset.kind.toUpperCase()} · {(Number(asset.sizeBytes) / 1024 / 1024).toFixed(1)} MB · SHA-256 {asset.checksum.slice(0, 12)}…</small></div><a href={asset.url} target="_blank" rel="noreferrer">Open asset</a></div>)}</div> : <div className="film-empty-state"><Library size={26}/><h3>No permanent assets yet</h3><p>Use “Save permanently” on completed generation jobs to ingest their output into this production.</p></div>}</section>}

          {activeTab === 'audio' && <section className="film-panel film-wide-panel"><div className="film-panel-head"><div><h2>Audio & voices</h2><p>Plan dialogue, voiceover, score and sound design for each scene.</p></div><span className="film-panel-tag">SOUND DEPARTMENT</span></div><div className="film-audio-modules"><div><Mic2 size={20}/><strong>Voice & dialogue</strong><p>Voice synthesis and character voice consistency depend on a connected speech model or ComfyUI audio workflow.</p><span>Workflow dependent</span></div><div><Music2 size={20}/><strong>Music & score</strong><p>Generate or import a score through a supported audio model, then add the output to your editing workflow.</p><span>Workflow dependent</span></div><div><Subtitles size={20}/><strong>Subtitles & captions</strong><p>Export subtitle files from a prepared transcript. Timing requires dialogue audio or manually supplied timecodes.</p><span>Whisper timed transcription</span></div></div><div className="film-audio-workflow"><div className="film-panel-head"><div><h3>Character identity & voice registry</h3><p>Bind each screenplay speaker to a stable voice ID and approved character reference images. Scene references inherit forward to preserve continuity.</p></div><div className="film-timeline-actions"><button className="film-secondary-button" disabled={castBusy || !productionId} onClick={() => void loadCastSettings()}><RefreshCw size={14}/> Load cast</button><button className="film-primary-button" disabled={castBusy || !productionId || castAssignments.length === 0} onClick={() => void saveCastSettings()}><Check size={14}/> Save cast & references</button></div></div><p className="film-muted-note">{castStatus}</p>{castAssignments.map((member, index) => <div className="film-frame-controls" key={member.character}><label>Character<input value={member.character} onChange={(e) => setCastAssignments((items) => items.map((item, i) => i === index ? { ...item, character: e.target.value } : item))}/></label><label>Voice ID<input value={member.voiceId} onChange={(e) => setCastAssignments((items) => items.map((item, i) => i === index ? { ...item, voiceId: e.target.value } : item))} placeholder="Provider voice / speaker ID"/></label><label>Language<input value={member.language ?? ''} onChange={(e) => setCastAssignments((items) => items.map((item, i) => i === index ? { ...item, language: e.target.value } : item))} placeholder="en-GB"/></label><label>Character reference images<select multiple value={member.referenceAssetIds} onChange={(e) => setCastAssignments((items) => items.map((item, i) => i === index ? { ...item, referenceAssetIds: Array.from(e.target.selectedOptions, (option) => option.value) } : item))}>{assets.filter((asset) => asset.kind === 'image').map((asset) => <option key={asset.id} value={asset.id}>{asset.filename}</option>)}</select></label></div>)}{castSceneReferences.map((sceneRef, index) => <div className="film-frame-controls" key={sceneRef.sceneId}><label>Scene reference · {project.scenes.find((scene) => scene.id === sceneRef.sceneId)?.title ?? sceneRef.sceneId}<select multiple value={sceneRef.characterAssetIds} onChange={(e) => setCastSceneReferences((items) => items.map((item, i) => i === index ? { ...item, characterAssetIds: Array.from(e.target.selectedOptions, (option) => option.value) } : item))}>{assets.filter((asset) => asset.kind === 'image').map((asset) => <option key={asset.id} value={asset.id}>{asset.filename}</option>)}</select></label><label>Location references<select multiple value={sceneRef.locationAssetIds} onChange={(e) => setCastSceneReferences((items) => items.map((item, i) => i === index ? { ...item, locationAssetIds: Array.from(e.target.selectedOptions, (option) => option.value) } : item))}>{assets.filter((asset) => asset.kind === 'image').map((asset) => <option key={asset.id} value={asset.id}>{asset.filename}</option>)}</select></label><label>Style references<select multiple value={sceneRef.styleAssetIds} onChange={(e) => setCastSceneReferences((items) => items.map((item, i) => i === index ? { ...item, styleAssetIds: Array.from(e.target.selectedOptions, (option) => option.value) } : item))}>{assets.filter((asset) => asset.kind === 'image').map((asset) => <option key={asset.id} value={asset.id}>{asset.filename}</option>)}</select></label></div>)}</div><div className="film-audio-workflow"><label>MUSIC GENERATION PROMPT<textarea rows={3} value={project.musicPrompt} onChange={(e) => update({ musicPrompt: e.target.value })} placeholder="Compose an original score: mood, tempo, instrumentation, structure and duration…"/></label><label>VOICE / DIALOGUE PROMPT<textarea rows={3} value={project.voicePrompt} onChange={(e) => update({ voicePrompt: e.target.value })} placeholder="Describe narration, language, delivery, pacing and dialogue…"/></label><label>SOUND DESIGN / FOLEY PROMPT<textarea rows={3} value={project.effectsPrompt} onChange={(e) => update({ effectsPrompt: e.target.value })} placeholder="Describe ambience, room tone, footsteps, impacts, transitions, environmental textures and timing…"/></label><label>LIP-SYNC DIRECTION<textarea rows={3} value={project.lipSyncPrompt} onChange={(e) => update({ lipSyncPrompt: e.target.value })} placeholder="Describe the speaking character, delivery, expression and synchronization target…"/></label><div className="film-timeline-actions"><button className="film-secondary-button" onClick={() => setWorkflowOpen(true)}><Settings2 size={14}/> Configure workflows</button><button className="film-primary-button" disabled={busy || !project.musicWorkflow.trim() || !project.musicPrompt.trim()} onClick={() => void submitWorkflow({ sceneId: 'music-score', title: 'Original music score', prompt: project.musicPrompt, workflowText: project.musicWorkflow, promptNodeId: project.musicPromptNodeId, promptInput: project.musicPromptInput })}><Music2 size={14}/> Generate music</button><button className="film-primary-button" disabled={busy || !project.voiceWorkflow.trim() || !project.voicePrompt.trim()} onClick={() => void submitWorkflow({ sceneId: 'voice-dialogue', title: 'Voice and dialogue', prompt: project.voicePrompt, workflowText: project.voiceWorkflow, promptNodeId: project.voicePromptNodeId, promptInput: project.voicePromptInput })}><Mic2 size={14}/> Generate voice</button><button className="film-primary-button" disabled={busy || !project.lipSyncWorkflow.trim() || !project.lipSyncPrompt.trim()} onClick={() => void submitWorkflow({ sceneId: 'lip-sync', title: 'Lip-sync workflow', prompt: project.lipSyncPrompt, workflowText: project.lipSyncWorkflow, promptNodeId: project.lipSyncPromptNodeId, promptInput: project.lipSyncPromptInput })}><AudioLines size={14}/> Submit lip-sync</button><button className="film-primary-button" disabled={busy || !project.effectsWorkflow.trim() || !project.effectsPrompt.trim()} onClick={() => void submitWorkflow({ sceneId: 'sound-effects', title: 'Sound design effects', prompt: project.effectsPrompt, workflowText: project.effectsWorkflow, promptNodeId: project.effectsPromptNodeId, promptInput: project.effectsPromptInput })}><AudioLines size={14}/> Generate sound design</button></div></div><div className="film-continuity-grid"><label>Speaking character<select value={lipSyncSpeaker} onChange={(e) => setLipSyncSpeaker(e.target.value)}><option value="">Choose character</option>{[...new Set(project.scenes.flatMap((scene) => extractDialogueLines(scene.text).map((line) => line.speaker)))].map((speaker) => <option key={speaker} value={speaker}>{speaker}</option>)}</select></label><label>Exact dialogue<textarea rows={2} value={lipSyncDialogue} onChange={(e) => setLipSyncDialogue(e.target.value)} placeholder="Paste the exact line this character must speak; do not paraphrase."/></label><label>Permanent source video<select value={lipSyncVideoAssetId} onChange={(e) => setLipSyncVideoAssetId(e.target.value)}><option value="">Select video asset</option>{assets.filter((asset) => asset.kind === 'video').map((asset) => <option key={asset.id} value={asset.id}>{asset.filename}</option>)}</select></label><label>Permanent dialogue audio<select value={lipSyncAudioAssetId} onChange={(e) => setLipSyncAudioAssetId(e.target.value)}><option value="">Select audio asset</option>{assets.filter((asset) => asset.kind === 'audio').map((asset) => <option key={asset.id} value={asset.id}>{asset.filename}</option>)}</select></label><label>Video loader node ID<input value={lipSyncVideoNodeId} onChange={(e) => setLipSyncVideoNodeId(e.target.value)} placeholder="ComfyUI node ID"/></label><label>Audio loader node ID<input value={lipSyncAudioNodeId} onChange={(e) => setLipSyncAudioNodeId(e.target.value)} placeholder="ComfyUI node ID"/></label><label>Optional direction prompt node ID<input value={lipSyncPromptNodeId} onChange={(e) => setLipSyncPromptNodeId(e.target.value)} placeholder="ComfyUI node ID"/></label><label>Video upload endpoint<input value={lipSyncVideoUploadPath} onChange={(e) => setLipSyncVideoUploadPath(e.target.value)} placeholder="/upload/image"/></label><label>Audio upload endpoint<input value={lipSyncAudioUploadPath} onChange={(e) => setLipSyncAudioUploadPath(e.target.value)} placeholder="/upload/image"/></label><div className="film-timeline-actions"><button className="film-secondary-button" onClick={() => void refreshAssets()}><RefreshCw size={14}/> Refresh permanent assets</button><button className="film-primary-button" disabled={busy || !project.lipSyncWorkflow.trim()} onClick={() => void submitBoundLipSync()}><AudioLines size={14}/> Bind media & generate lip-sync</button></div></div><div className="film-subtitle-tool"><div><h3>Automatic subtitle timing</h3><p>Transcribe dialogue with a configured Whisper-compatible endpoint and export segment-timed SRT captions.</p></div><label className="film-import-button"><input type="file" accept="audio/*,video/*" onChange={(e) => setSubtitleFile(e.target.files?.[0] ?? null)}/>{subtitleFile ? subtitleFile.name : 'Choose audio / video'}</label><button className="film-primary-button" disabled={!subtitleFile || subtitleBusy} onClick={() => void transcribeSubtitles()}>{subtitleBusy ? <LoaderCircle size={14} className="spin"/> : <Subtitles size={14}/>} Generate timed subtitles</button>{subtitleCount > 0 ? <span>{subtitleCount} timed segments generated</span> : null}</div><p className="film-muted-note">Voice, music and lip-sync jobs use your configured ComfyUI API workflows. The bound lip-sync workflow now uploads selected permanent video/audio assets to compatible ComfyUI upload endpoints and maps them into configured loader nodes. Node compatibility remains workflow-dependent. Subtitle timing uses your configured Whisper-compatible service. Configure the provider endpoints and keys on the application server; the client never receives provider secrets.</p></section>}

          {activeTab === 'free-video' && <section className="film-panel film-wide-panel film-free-video"><div className="film-panel-head"><div><h2>Free video lab</h2><p>Turn your own images into a cinematic motion video — no API key, subscription or cloud credits required.</p></div><span className="film-panel-tag">100% LOCAL</span></div><div className="film-free-video-grid"><div className="film-free-video-controls"><label className="film-free-upload"><input type="file" accept="image/*" multiple onChange={(event) => setFreeVideoFiles(Array.from(event.target.files ?? []).slice(0, 30))}/><ImagePlus size={25}/><strong>{freeVideoFiles.length ? `${freeVideoFiles.length} images selected` : 'Choose your images'}</strong><span>JPG, PNG or WebP · up to 30 images</span></label><label>VIDEO FORMAT<select value={freeVideoRatio} onChange={(event) => setFreeVideoRatio(event.target.value as typeof freeVideoRatio)}><option value="16:9">Landscape · 16:9</option><option value="9:16">Portrait · 9:16</option><option value="1:1">Square · 1:1</option></select></label><label>SECONDS PER IMAGE <strong>{freeVideoDuration}s</strong><input type="range" min="2" max="10" value={freeVideoDuration} onChange={(event) => setFreeVideoDuration(Number(event.target.value))}/></label><div className="film-free-video-summary"><span>{freeVideoFiles.length} shots</span><span>~{freeVideoFiles.length * freeVideoDuration}s total</span><span>30 FPS</span></div><button className="film-primary-button" disabled={!freeVideoFiles.length || freeVideoBusy} onClick={() => void createFreeVideo()}>{freeVideoBusy ? <LoaderCircle size={15} className="spin"/> : <Video size={15}/>} {freeVideoBusy ? `Creating ${freeVideoProgress}%` : 'Create free video'}</button>{freeVideoBusy && <div className="film-free-progress"><i style={{ width: `${freeVideoProgress}%` }}/></div>}<p className="film-muted-note">Uses a gentle cinematic zoom and pan (Ken Burns effect). Processing happens on your device; images are not uploaded. Export format: WebM.</p></div><div className="film-free-video-preview"><canvas ref={freeVideoCanvasRef} /><div className="film-free-preview-overlay"><Video size={22}/><strong>{freeVideoUrl ? 'Your video is ready' : 'Your preview will appear here'}</strong><span>{freeVideoUrl ? 'Review the generated clip below' : 'Select images, then create your motion video'}</span></div>{freeVideoUrl && <><video src={freeVideoUrl} controls playsInline/><a className="film-primary-button" href={freeVideoUrl} download={`${(project.title || 'filmAI-video').toLowerCase().replace(/[^a-z0-9]+/g, '-')}.webm`}><Download size={15}/> Download video</a></>}</div></div>{freeVideoFiles.length > 0 && <div className="film-free-file-list">{freeVideoFiles.map((file, index) => <span key={`${file.name}-${index}`}>{String(index + 1).padStart(2, '0')} · {file.name}</span>)}</div>}</section>}

          {activeTab === 'render' && <section className="film-panel film-wide-panel"><div className="film-panel-head"><div><h2>Render queue</h2><p>Track jobs submitted to your connected ComfyUI server.</p></div><button className="film-secondary-button" onClick={() => { void refreshEngines(); void refreshQueue() }}><RefreshCw size={14}/> Refresh</button></div><div className="film-config-note"><Gauge size={14}/> GPU-aware scheduling: {gpuStatus}</div>{renderJobs.length ? <div className="film-queue-list">{renderJobs.map((job) => <div className="film-queue-item" key={job.id}><div className="film-queue-icon"><Film size={17}/></div><div><strong>Final film render</strong><small>Render {job.id.slice(0, 10)} · {job.progress}%</small></div><span>{job.status}</span>{job.failure ? <small>{job.failure}</small> : null}{job.payload?.mode === 'multitrack' && ['queued', 'failed'].includes(job.status) ? <button className="film-secondary-button" disabled={renderBusy} onClick={() => void resumeMultitrackFilm(job.id)}>Resume segmented render</button> : null}{job.status === 'failed' && job.payload?.mode !== 'multitrack' ? <button className="film-secondary-button" onClick={() => { setRenderBusy(true); void fetch('/api/film-studio/render-jobs/process', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ jobId: job.id }) }).then(async (response) => { const result = await response.json() as { error?: string }; if (!response.ok) throw new Error(result.error || 'Render retry failed.'); setNotice('Render retry completed and the master was stored.'); void refreshAssets(); }).catch((error) => setNotice(error instanceof Error ? error.message : 'Render retry failed.')).finally(() => { setRenderBusy(false); void refreshRenderJobs() }) }}>Retry render</button> : null}</div>)}</div> : null}{queue.length ? <div className="film-queue-list">{queue.map((job) => <div className="film-queue-item" key={job.id}><div className="film-queue-icon"><MonitorPlay size={17}/></div><div><strong>{job.scene}</strong><small>Job {job.id}</small></div><span className={job.state === 'Completed' ? 'film-job-complete' : job.state === 'Failed' ? 'film-job-failed' : ''}>{job.state}</span>{job.state === 'Completed' && job.jobId ? <button className="film-secondary-button" onClick={() => void ingestGeneratedAsset(job.jobId!, /music|voice|audio|score|sound|effects/i.test(job.scene) ? 'audio' : 'video')}>Save permanently</button> : null}{job.state === 'Completed' && job.jobId ? <div className="film-output-links"><a href={`/api/film-studio/media?jobId=${encodeURIComponent(job.jobId)}&kind=${/music|voice|audio|score|sound|effects/i.test(job.scene) ? 'audio' : 'video'}`} target="_blank" rel="noreferrer">Open generated { /music|voice|audio|score|sound|effects/i.test(job.scene) ? 'audio' : 'video' }</a></div> : null}</div>)}</div> : <div className="film-empty-state"><Gauge size={28}/><h3>Queue is clear</h3><p>Generated scene jobs will appear here after a successful submission.</p></div>}<p className="film-muted-note">Jobs, provider IDs, prompts and generated-output metadata are persisted in the production database. Refresh reconciles active jobs against ComfyUI history; completed scene videos are available in the storyboard and final renderer.</p></section>}

          <footer className="film-footer"><span>filmAI Studio <b>·</b> Production workspace</span><span>{serverSaved ? 'Database synced' : 'Local recovery'} · Autosave {lastSaved}</span></footer>
        </main>
      </div>

      {workflowOpen && <div className="film-modal-backdrop" role="presentation" onMouseDown={(e) => { if (e.target === e.currentTarget) setWorkflowOpen(false) }}><section className="film-settings-modal" role="dialog" aria-modal="true" aria-labelledby="engine-settings-title"><div className="film-modal-head"><div><span>GENERATION CONFIGURATION</span><h2 id="engine-settings-title">Engine settings</h2></div><button className="film-icon-button" onClick={() => setWorkflowOpen(false)}><X size={17}/></button></div><p>Connect ComfyUI on the application host, then paste API-format workflows exported from its UI. The workflow node IDs below map filmAI prompts into your selected model graph.</p><div className="film-config-note"><span className="film-engine-dot online"/> Server endpoint is configured by <code>FILMAI_COMFYUI_URL</code> on the application host.</div><label className="film-config-label">VIDEO / IMAGE WORKFLOW JSON<textarea value={project.workflow} onChange={(e) => update({ workflow: e.target.value })} placeholder={'Paste a Wan, LTX-Video, image or other ComfyUI API workflow…'} rows={7}/></label><div className="film-config-row"><label>POSITIVE PROMPT NODE ID<input value={project.promptNodeId} onChange={(e) => update({ promptNodeId: e.target.value })} placeholder="e.g. 6 (optional)"/></label><label>PROMPT INPUT KEY<input value={project.promptInput} onChange={(e) => update({ promptInput: e.target.value })} placeholder="text"/></label></div><div className="film-config-row"><label>NEGATIVE PROMPT NODE ID<input value={project.negativePromptNodeId} onChange={(e) => update({ negativePromptNodeId: e.target.value })} placeholder="e.g. 7 (optional)"/></label><label>NEGATIVE INPUT KEY<input value={project.negativePromptInput} onChange={(e) => update({ negativePromptInput: e.target.value })} placeholder="text"/></label></div><div className="film-config-row"><label>REFERENCE IMAGE LOADER NODE IDs<input value={project.referenceImageNodeIds} onChange={(e) => update({ referenceImageNodeIds: e.target.value })} placeholder="e.g. 12, 15, 18"/></label><label>REFERENCE IMAGE INPUT KEY<input value={project.referenceImageInput} onChange={(e) => update({ referenceImageInput: e.target.value })} placeholder="image"/></label></div><p className="film-muted-note">Configure one compatible ComfyUI image-loader node per selected reference image, in the order character → location → style. The server uploads each owned image asset and binds its returned filename to the matching workflow node.</p><label className="film-config-label">CHARACTER CONTINUITY BIBLE<textarea rows={3} value={project.characterBible} onChange={(e) => update({ characterBible: e.target.value })} placeholder="Describe each recurring character's face, hair, age range, wardrobe, build, accessories and distinguishing traits."/></label><label className="film-config-label">CHARACTER VOICE BIBLE<textarea rows={3} value={project.voiceBible} onChange={(e) => update({ voiceBible: e.target.value })} placeholder="Mara: warm, restrained mid-range voice, consistent accent and cadence. Voice: distant filtered radio voice…"/></label><label className="film-config-label">LOCATION / BACKGROUND CONTINUITY BIBLE<textarea rows={4} value={project.locationBible} onChange={(e) => update({ locationBible: e.target.value })} placeholder="Describe fixed architecture, room layout, set dressing, prop placement, weather, time of day, lighting direction and background extras. Specify what must never change."/></label><label className="film-config-label">GLOBAL VISUAL BIBLE<textarea rows={3} value={project.visualStyle} onChange={(e) => update({ visualStyle: e.target.value })}/></label><label className="film-config-label">GLOBAL NEGATIVE PROMPT<textarea rows={2} value={project.negativePrompt} onChange={(e) => update({ negativePrompt: e.target.value })}/></label><label className="film-config-label">MUSIC WORKFLOW JSON<textarea rows={4} value={project.musicWorkflow} onChange={(e) => update({ musicWorkflow: e.target.value })} placeholder="Optional ComfyUI audio/music API workflow…"/></label><div className="film-config-row"><label>MUSIC PROMPT NODE<input value={project.musicPromptNodeId} onChange={(e) => update({ musicPromptNodeId: e.target.value })} placeholder="Node ID"/></label><label>MUSIC INPUT KEY<input value={project.musicPromptInput} onChange={(e) => update({ musicPromptInput: e.target.value })}/></label></div><label className="film-config-label">SOUND DESIGN / SFX WORKFLOW JSON<textarea rows={4} value={project.effectsWorkflow} onChange={(e) => update({ effectsWorkflow: e.target.value })} placeholder="Optional ComfyUI sound-effects / Foley API workflow…"/></label><div className="film-config-row"><label>SOUND DESIGN PROMPT NODE<input value={project.effectsPromptNodeId} onChange={(e) => update({ effectsPromptNodeId: e.target.value })} placeholder="Node ID"/></label><label>SOUND DESIGN INPUT KEY<input value={project.effectsPromptInput} onChange={(e) => update({ effectsPromptInput: e.target.value })}/></label></div><label className="film-config-label">VOICE WORKFLOW JSON<textarea rows={4} value={project.voiceWorkflow} onChange={(e) => update({ voiceWorkflow: e.target.value })} placeholder="Optional ComfyUI speech/voice API workflow…"/></label><div className="film-config-row"><label>VOICE PROMPT NODE<input value={project.voicePromptNodeId} onChange={(e) => update({ voicePromptNodeId: e.target.value })} placeholder="Node ID"/></label><label>VOICE INPUT KEY<input value={project.voicePromptInput} onChange={(e) => update({ voicePromptInput: e.target.value })}/></label></div><label className="film-config-label">LIP-SYNC WORKFLOW JSON<textarea rows={4} value={project.lipSyncWorkflow} onChange={(e) => update({ lipSyncWorkflow: e.target.value })} placeholder="Optional ComfyUI lip-sync API workflow…"/></label><div className="film-config-row"><label>LIP-SYNC PROMPT NODE<input value={project.lipSyncPromptNodeId} onChange={(e) => update({ lipSyncPromptNodeId: e.target.value })} placeholder="Node ID"/></label><label>LIP-SYNC INPUT KEY<input value={project.lipSyncPromptInput} onChange={(e) => update({ lipSyncPromptInput: e.target.value })}/></label></div><p className="film-config-help">If a prompt node ID is supplied, the scene description is inserted into that node's input field before queueing. Leave it blank to submit the workflow unchanged.</p><div className="film-modal-actions"><button className="film-secondary-button" onClick={() => { update({ workflow: '', promptNodeId: '', negativePromptNodeId: '' }); }}>Clear workflow</button><button className="film-primary-button" onClick={() => setWorkflowOpen(false)}><Check size={14}/> Save settings</button></div></section></div>}
    </div>
  )
}
