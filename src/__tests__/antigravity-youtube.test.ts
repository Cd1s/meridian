import { afterEach, describe, expect, it } from "bun:test"
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { augmentAgRequestWithYouTube, resetYouTubeContextCache } from "../proxy/backends/antigravityYouTube"

const savedEnvironment = {
  enabled: process.env.MERIDIAN_AGY_YOUTUBE_CONTEXT,
  binary: process.env.MERIDIAN_AGY_YTDLP_PATH,
  proxy: process.env.MERIDIAN_AGY_YOUTUBE_PROXY,
}
const workspaces: string[] = []

afterEach(async () => {
  resetYouTubeContextCache()
  if (savedEnvironment.enabled === undefined) delete process.env.MERIDIAN_AGY_YOUTUBE_CONTEXT
  else process.env.MERIDIAN_AGY_YOUTUBE_CONTEXT = savedEnvironment.enabled
  if (savedEnvironment.binary === undefined) delete process.env.MERIDIAN_AGY_YTDLP_PATH
  else process.env.MERIDIAN_AGY_YTDLP_PATH = savedEnvironment.binary
  if (savedEnvironment.proxy === undefined) delete process.env.MERIDIAN_AGY_YOUTUBE_PROXY
  else process.env.MERIDIAN_AGY_YOUTUBE_PROXY = savedEnvironment.proxy
  await Promise.all(workspaces.splice(0).map(path => rm(path, { recursive: true, force: true })))
})

async function fakeYtDlp(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "meridian-youtube-test-"))
  workspaces.push(directory)
  const script = join(directory, "yt-dlp")
  await writeFile(script, `#!/bin/sh
if printf '%s\\n' "$@" | grep -q -- '-J'; then
  printf '%s' '{"id":"dQw4w9WgXcQ","title":"Fixture title","channel":"Fixture channel","duration":65,"upload_date":"20261121","description":"Fixture description","subtitles":{"en":[{}]}}'
  exit 0
fi
out=
prev=
for arg in "$@"; do
  if [ "$prev" = "-o" ]; then out="$arg"; fi
  prev="$arg"
done
printf '%s\\n' 'WEBVTT' '' '00:00.000 --> 00:02.000' 'hello fixture' '' '00:02.000 --> 00:04.000' 'hello fixture' > "$out.en.vtt"
`)
  await chmod(script, 0o755)
  return script
}

describe("Antigravity YouTube context", () => {
  it("is disabled by default", async () => {
    delete process.env.MERIDIAN_AGY_YOUTUBE_CONTEXT
    const body = { model: "gemini-fixture-low", messages: [{ role: "user", content: "https://youtu.be/dQw4w9WgXcQ" }] }
    expect(await augmentAgRequestWithYouTube(body)).toBe(body)
  })

  it("adds bounded metadata and subtitle text with a local yt-dlp", async () => {
    process.env.MERIDIAN_AGY_YOUTUBE_CONTEXT = "1"
    process.env.MERIDIAN_AGY_YTDLP_PATH = await fakeYtDlp()
    process.env.MERIDIAN_AGY_YOUTUBE_PROXY = "socks5://proxy.invalid:1080"
    const body = { model: "gemini-fixture-low", messages: [{ role: "user", content: "Review https://www.youtube.com/watch?v=dQw4w9WgXcQ" }] }
    const enriched = await augmentAgRequestWithYouTube(body) as { messages: Array<{ content: Array<{ type: string; text?: string }> }> }
    expect(enriched).not.toBe(body)
    expect(enriched.messages[0]!.content).toHaveLength(2)
    expect(enriched.messages[0]!.content[1]!.text).toContain("Fixture title")
    expect(enriched.messages[0]!.content[1]!.text).toContain("hello fixture")
    expect(JSON.stringify(body)).not.toContain("Fixture title")
  })

  it("continues with a bounded failure note and limits links per message", async () => {
    process.env.MERIDIAN_AGY_YOUTUBE_CONTEXT = "1"
    process.env.MERIDIAN_AGY_YTDLP_PATH = "/path/that/does/not/exist"
    const urls = ["dQw4w9WgXcQ", "BaW_jenozKcQ", "9bZkp7q19f0", "M7lc1UVf-VE"]
    const body = { model: "gemini-fixture-low", messages: [{ role: "user", content: urls.map(id => `https://youtu.be/${id}`).join(" ") }] }
    const enriched = await augmentAgRequestWithYouTube(body) as { messages: Array<{ content: Array<{ type: string; text?: string }> }> }
    expect(enriched.messages[0]!.content).toHaveLength(4)
    expect(enriched.messages[0]!.content.slice(1).every(block => block.text?.includes("could not be fetched"))).toBe(true)
  })

  it("does not duplicate an existing context block", async () => {
    process.env.MERIDIAN_AGY_YOUTUBE_CONTEXT = "1"
    process.env.MERIDIAN_AGY_YTDLP_PATH = await fakeYtDlp()
    const body = { model: "gemini-fixture-low", messages: [{ role: "user", content: [
      { type: "text", text: "https://youtu.be/dQw4w9WgXcQ" },
      { type: "text", text: "[YouTube video context added by Meridian for https://www.youtube.com/watch?v=dQw4w9WgXcQ]" },
    ] }] }
    const enriched = await augmentAgRequestWithYouTube(body)
    expect(enriched).toEqual(body)

    const legacy = { model: "gemini-fixture-low", messages: [{ role: "user", content: [
      { type: "text", text: "https://youtu.be/dQw4w9WgXcQ" },
      { type: "text", text: "[YouTube video context added by the gateway for https://www.youtube.com/watch?v=dQw4w9WgXcQ]" },
    ] }] }
    expect(await augmentAgRequestWithYouTube(legacy)).toEqual(legacy)
  })
})
