import { execFile } from "node:child_process"
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { promisify } from "node:util"
import { AntigravityError } from "./antigravityProtocol"

const exec = promisify(execFile)

const YOUTUBE_URL = /https?:\/\/(?:www\.|m\.|music\.)?(?:youtube\.com\/(?:watch\?(?:[^\s#]*?&)?v=|shorts\/|live\/|embed\/)|youtu\.be\/)([A-Za-z0-9_-]{11})/g
const CONTEXT_PREFIX = "[YouTube video context added by Meridian"
const MAX_CONTEXT_BYTES = 60_000
const MAX_VIDEOS_PER_MESSAGE = 3
const MAX_CACHE_ENTRIES = 500
const CACHE_TTL_MS = 24 * 60 * 60 * 1000
const FAILURE_TTL_MS = 10 * 60 * 1000
const cache = new Map<string, { expiresAt: number; text: string }>()
const pending = new Map<string, Promise<string>>()

type VideoInfo = {
  id?: string
  title?: string
  channel?: string
  uploader?: string
  duration?: number
  upload_date?: string
  description?: string
  language?: string
  subtitles?: Record<string, unknown[]>
  automatic_captions?: Record<string, unknown[]>
}

function enabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.MERIDIAN_AGY_YOUTUBE_CONTEXT === "1"
}

function boundedText(text: string, limit: number): { text: string; shortened: boolean } {
  const bytes = Buffer.byteLength(text)
  if (bytes <= limit) return { text, shortened: false }
  const head = Buffer.from(text).subarray(0, Math.floor(limit * 0.75)).toString("utf8")
  const tail = Buffer.from(text).subarray(-Math.floor(limit * 0.2)).toString("utf8")
  return { text: `${head}\n[... middle omitted for length ...]\n${tail}`, shortened: true }
}

function vttText(raw: string): string {
  const lines: string[] = []
  for (const original of raw.split(/\r?\n/)) {
    const line = original.trim()
    if (!line || line === "WEBVTT" || line.includes("-->") || /^\d+$/.test(line) || /^(Kind|Language|NOTE|STYLE):/.test(line)) continue
    const clean = line.replace(/<[^>]+>/g, "").replaceAll("&nbsp;", " ").replaceAll("&amp;", "&").trim()
    if (clean && lines.at(-1) !== clean) lines.push(clean)
  }
  return lines.join("\n")
}

function chooseTrack(info: VideoInfo): { kind: "manual" | "auto-generated"; language: string } | undefined {
  const language = info.language?.split("-")[0]
  const preferred = [info.language, language, "zh-Hans", "zh-CN", "zh", "zh-Hant", "en", "en-US"].filter((value): value is string => Boolean(value))
  const subtitles = Object.fromEntries(Object.entries(info.subtitles ?? {}).filter(([key]) => key !== "live_chat"))
  for (const languageCode of [...preferred, ...Object.keys(subtitles).sort()]) if (subtitles[languageCode]) return { kind: "manual", language: languageCode }
  const captions = info.automatic_captions ?? {}
  for (const languageCode of [...preferred.map(value => `${value}-orig`), ...preferred, ...Object.keys(captions).filter(key => key.endsWith("-orig")).sort()]) {
    if (captions[languageCode]) return { kind: "auto-generated", language: languageCode }
  }
  return undefined
}

function videoUrl(id: string): string {
  return `https://www.youtube.com/watch?v=${id}`
}

function cacheGet(id: string): string | undefined {
  const hit = cache.get(id)
  if (!hit || hit.expiresAt <= Date.now()) {
    if (hit) cache.delete(id)
    return undefined
  }
  cache.delete(id)
  cache.set(id, hit)
  return hit.text
}

function cachePut(id: string, text: string, ttl: number): void {
  cache.delete(id)
  cache.set(id, { expiresAt: Date.now() + ttl, text })
  while (cache.size > MAX_CACHE_ENTRIES) cache.delete(cache.keys().next().value!)
}

function durationText(value: number | undefined): string {
  const duration = Number.isFinite(value) && value !== undefined ? Math.max(0, Math.floor(value)) : 0
  return `${Math.floor(duration / 3600)}:${String(Math.floor(duration / 60) % 60).padStart(2, "0")}:${String(duration % 60).padStart(2, "0")}`
}

async function fetchVideoContext(id: string, signal?: AbortSignal): Promise<string> {
  const existing = cacheGet(id)
  if (existing) return existing
  const running = pending.get(id)
  if (running) return running
  const task = fetchVideoContextUncached(id, signal).finally(() => pending.delete(id))
  pending.set(id, task)
  return task
}

async function fetchVideoContextUncached(id: string, signal?: AbortSignal): Promise<string> {
  const url = videoUrl(id)
  const binary = process.env.MERIDIAN_AGY_YTDLP_PATH || "yt-dlp"
  const proxy = process.env.MERIDIAN_AGY_YOUTUBE_PROXY
  const base = ["--no-playlist", "--no-warnings", "--skip-download", ...(proxy ? ["--proxy", proxy] : [])]
  try {
    const metadata = await exec(binary, [...base, "-J", url], { timeout: 60_000, maxBuffer: 2 * 1024 * 1024, signal })
    const info = JSON.parse(metadata.stdout || "{}") as VideoInfo
    if (!info || info.id !== id) throw new Error("metadata unavailable")
    const track = chooseTrack(info)
    let transcript = ""
    if (track) {
      const directory = await mkdtemp(join(tmpdir(), "meridian-youtube-"))
      try {
        const flag = track.kind === "manual" ? "--write-subs" : "--write-auto-subs"
        await exec(binary, [...base, flag, "--sub-langs", track.language, "--sub-format", "vtt", "-o", join(directory, "subtitle"), url], { timeout: 60_000, maxBuffer: 256 * 1024, signal })
        const files = (await readdir(directory)).filter(file => file.endsWith(".vtt")).sort()
        if (files[0]) transcript = vttText(await readFile(join(directory, files[0]), "utf8"))
      } finally {
        await rm(directory, { recursive: true, force: true })
      }
    }
    const lines = [
      `${CONTEXT_PREFIX} for ${url}]`,
      `Title: ${info.title || ""}`,
      `Channel: ${info.channel || info.uploader || ""}`,
      `Duration: ${durationText(info.duration)}`,
      `Upload date: ${info.upload_date || ""}`,
    ]
    const description = info.description?.trim()
    if (description) lines.push(`Description:\n${boundedText(description, 3_000).text}`)
    if (transcript) {
      const fitted = boundedText(transcript, MAX_CONTEXT_BYTES)
      lines.push(`Transcript (${track?.kind} subtitles, language ${track?.language}${fitted.shortened ? ", shortened" : ""}; spoken words only, no visuals):\n${fitted.text}`)
    } else {
      lines.push("No subtitles or captions are available for this video, so only the details above are known; the video itself cannot be watched here.")
    }
    const text = lines.join("\n")
    cachePut(id, text, CACHE_TTL_MS)
    return text
  } catch (error) {
    if (signal?.aborted) throw new AntigravityError("Request cancelled", 499, "api_error")
    const text = `${CONTEXT_PREFIX} for ${url}] The video details could not be fetched (${error instanceof Error ? error.constructor.name : "Error"}); the video itself cannot be watched here.`
    cachePut(id, text, FAILURE_TTL_MS)
    return text
  }
}

function videoIds(text: string): string[] {
  const ids: string[] = []
  for (const match of text.matchAll(YOUTUBE_URL)) {
    const id = match[1]
    if (id && !ids.includes(id) && ids.length < MAX_VIDEOS_PER_MESSAGE) ids.push(id)
  }
  return ids
}

function isContextBlock(value: unknown): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false
  const block = value as { text?: unknown }
  return typeof block.text === "string" && block.text.startsWith(CONTEXT_PREFIX)
}

function textBlockVideoIds(value: unknown): string[] {
  if (!value || typeof value !== "object" || Array.isArray(value)) return []
  const block = value as { type?: unknown; text?: unknown }
  return block.type === "text" && typeof block.text === "string" ? videoIds(block.text) : []
}

/** Add bounded YouTube context to user messages when explicitly enabled. */
export async function augmentAgRequestWithYouTube(value: unknown, signal?: AbortSignal): Promise<unknown> {
  if (!enabled() || !value || typeof value !== "object" || Array.isArray(value)) return value
  const input = value as Record<string, unknown>
  if (!Array.isArray(input.messages)) return value
  const messages = [] as unknown[]
  for (const message of input.messages) {
    if (!message || typeof message !== "object" || Array.isArray(message)) { messages.push(message); continue }
    const current = message as Record<string, unknown>
    if (current.role !== "user") { messages.push(message); continue }
    const original = typeof current.content === "string" ? [{ type: "text", text: current.content }] : current.content
    if (!Array.isArray(original)) { messages.push(message); continue }
    if (original.some(isContextBlock)) {
      messages.push(message)
      continue
    }
    const ids = original.flatMap(textBlockVideoIds)
    if (!ids.length) { messages.push(message); continue }
    const additions = await Promise.all(ids.map(id => fetchVideoContext(id, signal)))
    messages.push({ ...current, content: [...original, ...additions.map(text => ({ type: "text", text }))] })
  }
  return { ...input, messages }
}

export function resetYouTubeContextCache(): void {
  cache.clear()
  pending.clear()
}
