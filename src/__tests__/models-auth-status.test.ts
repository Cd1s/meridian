/**
 * Auth-status caching and resilience — against the REAL implementation (#707).
 *
 * This file previously declared its own `authCache`, `lastKnownGood`, TTLs and
 * caching logic and asserted against that copy. It never imported
 * `../proxy/models`, so all 8 tests would have passed with
 * `getClaudeAuthStatusAsync` deleted — no coverage at all of the resilience
 * behaviour it claimed to test.
 *
 * The original objection to mocking was real and is quoted in the old file:
 * bun's `mock.module` is global and leaks across files. It no longer applies —
 * `package.json` excludes this file from the main `bun test` run and executes
 * it as its own invocation, so a module mock here cannot reach other files.
 *
 * Two things make the real implementation testable deterministically:
 *   - `MERIDIAN_CLAUDE_PATH` short-circuits executable resolution, so no real
 *     binary is probed.
 *   - `profileAuthCaches` is keyed by profile id, so a unique profile per test
 *     gives isolation without any shared-singleton race — which is what drove
 *     the reimplementation in the first place.
 */
import { describe, it, expect, beforeEach, afterEach, afterAll, mock, setSystemTime } from "bun:test"
import * as realChildProcess from "node:child_process"
import { mkdtempSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

/**
 * Controls what the mocked `claude auth status` does on the next call.
 * "hang" models a spawn stalled on a loaded host: the callback is parked in
 * `hungSpawns` until the test settles it with `releaseHungSpawns`.
 */
let authBehavior: "success" | "fail" | "hang" = "success"
let execFileCalls = 0
/** Options the probe passed to execFile, so spawn flags can be asserted. */
let execFileOptions: any
let currentPayload = { loggedIn: true, email: "test@test.com", subscriptionType: "max" }
let hungSpawns: Array<(err: Error | null, out: { stdout: string; stderr: string }) => void> = []

function releaseHungSpawns(): void {
  const pending = hungSpawns
  hungSpawns = []
  for (const done of pending) done(null, { stdout: JSON.stringify(currentPayload), stderr: "" })
}

// The /health test loads server.ts, which imports more of child_process than
// the auth probe uses; only exec and execFile are replaced.
mock.module("child_process", () => ({
  ...realChildProcess,
  exec: (_cmd: string, optsOrCb: any, cb?: any) => {
    const done = typeof optsOrCb === "function" ? optsOrCb : cb
    done?.(null, { stdout: "", stderr: "" })
  },
  execFile: (_file: string, _args: any, optsOrCb: any, cb?: any) => {
    execFileCalls++
    execFileOptions = typeof optsOrCb === "function" ? undefined : optsOrCb
    const done = typeof optsOrCb === "function" ? optsOrCb : cb
    if (authBehavior === "hang") {
      hungSpawns.push(done)
      return
    }
    if (authBehavior === "fail") {
      done?.(new Error("claude auth status failed"), { stdout: "", stderr: "" })
      return
    }
    done?.(null, { stdout: JSON.stringify(currentPayload), stderr: "" })
  },
}))

const savedClaudePath = process.env.MERIDIAN_CLAUDE_PATH
process.env.MERIDIAN_CLAUDE_PATH = "/fake/claude"

const {
  getClaudeAuthStatusAsync,
  getAuthCacheInfo,
  resetCachedClaudeAuthStatus,
  expireAuthStatusCache,
  pendingAuthStatusRefresh,
  authStatusFailureTtlMs,
} = await import("../proxy/models")

afterAll(() => {
  if (savedClaudePath === undefined) delete process.env.MERIDIAN_CLAUDE_PATH
  else process.env.MERIDIAN_CLAUDE_PATH = savedClaudePath
})

const NOT_SETTLED = Symbol("not settled")

function settledWithin<T>(promise: Promise<T>, ms: number): Promise<T | typeof NOT_SETTLED> {
  return Promise.race([promise, new Promise<typeof NOT_SETTLED>((r) => setTimeout(() => r(NOT_SETTLED), ms))])
}

/** Let the refresh reach execFile: it first awaits executable resolution. */
const tick = () => new Promise((r) => setTimeout(r, 10))

/** Unique profile per test — the isolation that replaces the local copy. */
let profileSeq = 0
const nextProfile = () => `auth-test-${++profileSeq}`

describe("getClaudeAuthStatusAsync — real implementation", () => {
  beforeEach(() => {
    authBehavior = "success"
    execFileCalls = 0
    execFileOptions = undefined
    hungSpawns = []
    currentPayload = { loggedIn: true, email: "test@test.com", subscriptionType: "max" }
    resetCachedClaudeAuthStatus()
  })

  afterEach(() => {
    releaseHungSpawns()
    setSystemTime()
  })

  // Windows allocates a visible console for a child launched without this flag,
  // and the probe re-runs on cache expiry, so a service with no console of its
  // own flashed a window on most prompts (#1172). The flag is a no-op elsewhere,
  // so this guards the fix from every platform CI runs on.
  it("hides the console window when probing auth status", async () => {
    await getClaudeAuthStatusAsync(nextProfile())
    expect(execFileCalls).toBe(1)
    expect(execFileOptions?.windowsHide).toBe(true)
  })

  it("fetches and returns auth status on a cold cache", async () => {
    const status = await getClaudeAuthStatusAsync(nextProfile())
    expect(status).toEqual(currentPayload)
    expect(execFileCalls).toBe(1)
  })

  it("serves from cache within the TTL instead of re-running the CLI", async () => {
    const p = nextProfile()
    await getClaudeAuthStatusAsync(p)
    expect(await getClaudeAuthStatusAsync(p)).toEqual(currentPayload)
    // The point of the cache: one subprocess, not two.
    expect(execFileCalls).toBe(1)
  })

  it("re-fetches once the TTL has expired", async () => {
    const p = nextProfile()
    await getClaudeAuthStatusAsync(p)
    expireAuthStatusCache()
    await getClaudeAuthStatusAsync(p)
    await pendingAuthStatusRefresh(p)
    expect(execFileCalls).toBe(2)
  })

  it("picks up a changed payload after expiry, one call later", async () => {
    const p = nextProfile()
    const previous = await getClaudeAuthStatusAsync(p)
    currentPayload = { loggedIn: true, email: "new@test.com", subscriptionType: "team" }
    expireAuthStatusCache()
    // The caller that finds the cache expired is answered from it...
    expect(await getClaudeAuthStatusAsync(p)).toEqual(previous!)
    await pendingAuthStatusRefresh(p)
    // ...and the refresh it started answers the next one.
    expect(await getClaudeAuthStatusAsync(p)).toEqual(currentPayload)
  })

  it("does not wait on the auth-status spawn once the cache has expired", async () => {
    // The /health freeze: a load balancer probing with a 2 s timeout marked the
    // proxy down whenever the expired cache made the probe wait on a spawn
    // that a loaded host stretched past it.
    const p = nextProfile()
    const previous = await getClaudeAuthStatusAsync(p)
    expireAuthStatusCache()
    authBehavior = "hang"

    expect(await settledWithin(getClaudeAuthStatusAsync(p), 200)).toEqual(previous!)
    await tick()
    expect(hungSpawns).toHaveLength(1)

    currentPayload = { loggedIn: true, email: "later@test.com", subscriptionType: "max" }
    releaseHungSpawns()
    await pendingAuthStatusRefresh(p)
    expect(await getClaudeAuthStatusAsync(p)).toEqual(currentPayload)
  })

  it("starts a single background refresh for concurrent callers after expiry", async () => {
    const p = nextProfile()
    const previous = await getClaudeAuthStatusAsync(p)
    expireAuthStatusCache()
    authBehavior = "hang"

    const results = await settledWithin(
      Promise.all(Array.from({ length: 5 }, () => getClaudeAuthStatusAsync(p))),
      200,
    )
    expect(results).toEqual(Array.from({ length: 5 }, () => previous!))
    await tick()
    // One warm-up spawn plus exactly one refresh, still in flight.
    expect(execFileCalls).toBe(2)
    expect(await settledWithin(getClaudeAuthStatusAsync(p), 200)).toEqual(previous!)
    await tick()
    expect(execFileCalls).toBe(2)
  })

  it("still waits on a cold start with nothing to fall back on", async () => {
    const p = nextProfile()
    authBehavior = "hang"
    const first = getClaudeAuthStatusAsync(p)
    expect(await settledWithin(first, 100)).toBe(NOT_SETTLED)
    releaseHungSpawns()
    expect(await first).toEqual(currentPayload)
  })

  it("falls back to last-known-good when the auth check fails", async () => {
    // The resilience property with no real coverage before: a transient CLI
    // failure must not blank the proxy's view of auth.
    const p = nextProfile()
    const good = await getClaudeAuthStatusAsync(p)
    expect(good).toEqual(currentPayload)

    authBehavior = "fail"
    expireAuthStatusCache()
    expect(await getClaudeAuthStatusAsync(p)).toEqual(currentPayload)
  })

  it("returns null when the first check fails and there is no last-known-good", async () => {
    authBehavior = "fail"
    expect(await getClaudeAuthStatusAsync(nextProfile())).toBeNull()
  })

  it("marks the cache as failed so /health can report it", async () => {
    const p = nextProfile()
    authBehavior = "fail"
    await getClaudeAuthStatusAsync(p)
    expect(getAuthCacheInfo(p).isFailure).toBe(true)
  })

  it("clears the failure flag once a later check succeeds", async () => {
    const p = nextProfile()
    authBehavior = "fail"
    await getClaudeAuthStatusAsync(p)
    expect(getAuthCacheInfo(p).isFailure).toBe(true)

    authBehavior = "success"
    expireAuthStatusCache()
    await getClaudeAuthStatusAsync(p)
    const info = getAuthCacheInfo(p)
    expect(info.isFailure).toBe(false)
    expect(info.lastSuccessAt).toBeGreaterThan(0)
  })

  it("records lastSuccessAt only on success", async () => {
    const p = nextProfile()
    authBehavior = "fail"
    await getClaudeAuthStatusAsync(p)
    expect(getAuthCacheInfo(p).lastSuccessAt).toBe(0)
  })

  it("doubles the retry delay per consecutive failure, capped at 5 minutes", () => {
    expect(authStatusFailureTtlMs(1)).toBe(5_000)
    expect(authStatusFailureTtlMs(2)).toBe(10_000)
    expect(authStatusFailureTtlMs(3)).toBe(20_000)
    expect(authStatusFailureTtlMs(6)).toBe(160_000)
    expect(authStatusFailureTtlMs(7)).toBe(300_000)
    expect(authStatusFailureTtlMs(1_000)).toBe(300_000)
  })

  it("backs off after repeated failures and resets on success", async () => {
    // A flat 5 s retry re-spawned `claude auth status` on every health probe
    // for as long as the check kept failing.
    const p = nextProfile()
    let now = Date.parse("2026-01-01T00:00:00Z")
    const advance = (ms: number) => { now += ms; setSystemTime(new Date(now)) }
    setSystemTime(new Date(now))

    authBehavior = "fail"
    await getClaudeAuthStatusAsync(p)
    expect(execFileCalls).toBe(1)

    advance(4_000)
    await getClaudeAuthStatusAsync(p)
    expect(execFileCalls).toBe(1)
    advance(1_500)
    await getClaudeAuthStatusAsync(p)
    expect(execFileCalls).toBe(2)

    // Second consecutive failure: 10 s, not 5 s.
    advance(6_000)
    await getClaudeAuthStatusAsync(p)
    expect(execFileCalls).toBe(2)
    advance(4_500)
    await getClaudeAuthStatusAsync(p)
    expect(execFileCalls).toBe(3)

    // Third: 20 s.
    advance(15_000)
    await getClaudeAuthStatusAsync(p)
    expect(execFileCalls).toBe(3)
    advance(5_500)
    authBehavior = "success"
    expect(await getClaudeAuthStatusAsync(p)).toEqual(currentPayload)
    expect(execFileCalls).toBe(4)

    // A success resets the count: the next failure is retried after 5 s again.
    advance(61_000)
    authBehavior = "fail"
    await getClaudeAuthStatusAsync(p)
    await pendingAuthStatusRefresh(p)
    expect(execFileCalls).toBe(5)
    expect(getAuthCacheInfo(p).isFailure).toBe(true)
    advance(5_500)
    await getClaudeAuthStatusAsync(p)
    await pendingAuthStatusRefresh(p)
    expect(execFileCalls).toBe(6)
  })

  it("de-duplicates concurrent cold-cache calls into one subprocess", async () => {
    // Without the in-flight promise, a burst of requests on a cold cache would
    // spawn one `claude auth status` each.
    const p = nextProfile()
    const results = await Promise.all([
      getClaudeAuthStatusAsync(p),
      getClaudeAuthStatusAsync(p),
      getClaudeAuthStatusAsync(p),
    ])
    for (const r of results) expect(r).toEqual(currentPayload)
    expect(execFileCalls).toBe(1)
  })

  it("keeps profiles isolated — one account's failure does not poison another", async () => {
    // The reason the cache is per-profile at all: two Claude accounts have
    // independent auth state.
    const good = nextProfile()
    const bad = nextProfile()
    await getClaudeAuthStatusAsync(good)

    authBehavior = "fail"
    await getClaudeAuthStatusAsync(bad)

    expect(getAuthCacheInfo(good).isFailure).toBe(false)
    expect(getAuthCacheInfo(bad).isFailure).toBe(true)
    // The healthy profile still serves from its own cache, no new subprocess.
    const callsBefore = execFileCalls
    expect(await getClaudeAuthStatusAsync(good)).toEqual(currentPayload)
    expect(execFileCalls).toBe(callsBefore)
  })

  it("reports zeroed cache info for a profile never checked", async () => {
    expect(getAuthCacheInfo("never-seen")).toEqual({
      lastCheckedAt: 0,
      lastSuccessAt: 0,
      isFailure: false,
    })
  })
})

/**
 * Credential-file mtime invalidation under MERIDIAN_CREDENTIALS_READONLY.
 *
 * A read-only instance never refreshes its own tokens, so the only thing that
 * ever changes its auth status is a rotation performed by the instance that
 * owns them. Time-based expiry alone would keep serving the pre-rotation
 * answer for up to a full TTL after one lands.
 *
 * Lives here rather than in credentials-readonly.test.ts because it asserts on
 * the real auth-status cache: four files in the main `bun test` run call
 * `mock.module("../proxy/models", …)`, which is global, so those assertions
 * only hold in this file's own isolated invocation.
 */
describe("auth-status cache — credential mtime invalidation", () => {
  let dir: string
  let credFile: string

  beforeEach(() => {
    authBehavior = "success"
    execFileCalls = 0
    resetCachedClaudeAuthStatus()
    dir = mkdtempSync(join(tmpdir(), "meridian-readonly-mtime-"))
    credFile = join(dir, ".credentials.json")
    // Fabricated placeholder — only the file's mtime matters here.
    writeFileSync(credFile, JSON.stringify({ claudeAiOauth: { accessToken: "placeholder" } }))
  })

  afterEach(() => {
    delete process.env.MERIDIAN_CREDENTIALS_READONLY
    rmSync(dir, { recursive: true, force: true })
  })

  /** Push mtime forward a whole second so the change is unambiguous. */
  function ageCredentialFile(): void {
    const next = new Date(statSync(credFile).mtimeMs + 1000)
    utimesSync(credFile, next, next)
  }

  it("re-reads when the other instance rotates the credential file", async () => {
    process.env.MERIDIAN_CREDENTIALS_READONLY = "1"
    const p = nextProfile()
    const overrides = { CLAUDE_CONFIG_DIR: dir }

    await getClaudeAuthStatusAsync(p, overrides)
    expect(execFileCalls).toBe(1)

    await getClaudeAuthStatusAsync(p, overrides)
    expect(execFileCalls).toBe(1)

    ageCredentialFile()
    await getClaudeAuthStatusAsync(p, overrides)
    await pendingAuthStatusRefresh(p)
    expect(execFileCalls).toBe(2)
  })

  it("picks up the rotated payload rather than the cached one", async () => {
    process.env.MERIDIAN_CREDENTIALS_READONLY = "1"
    const p = nextProfile()
    const overrides = { CLAUDE_CONFIG_DIR: dir }

    await getClaudeAuthStatusAsync(p, overrides)
    currentPayload = { loggedIn: true, email: "rotated@test.com", subscriptionType: "max" }

    ageCredentialFile()
    await getClaudeAuthStatusAsync(p, overrides)
    await pendingAuthStatusRefresh(p)
    expect(await getClaudeAuthStatusAsync(p, overrides)).toEqual(currentPayload)
  })

  it("leaves the time-based cache untouched when the flag is absent", async () => {
    const p = nextProfile()
    const overrides = { CLAUDE_CONFIG_DIR: dir }

    await getClaudeAuthStatusAsync(p, overrides)
    expect(execFileCalls).toBe(1)

    ageCredentialFile()
    await getClaudeAuthStatusAsync(p, overrides)
    expect(execFileCalls).toBe(1)
  })
})

/**
 * The same property end to end: `/health` over the real auth-status cache.
 * Caddy probes it with a 2 s timeout, so a probe that waits on the spawn is a
 * proxy marked down.
 */
describe("/health with an expired auth-status cache", () => {
  beforeEach(() => {
    authBehavior = "success"
    execFileCalls = 0
    hungSpawns = []
    currentPayload = { loggedIn: true, email: "test@test.com", subscriptionType: "max" }
    resetCachedClaudeAuthStatus()
  })

  afterEach(() => {
    releaseHungSpawns()
  })

  it("answers healthy from the previous status while the refresh is stalled", async () => {
    const { createProxyServer } = await import("../proxy/server")
    const { app } = createProxyServer({ port: 0, host: "127.0.0.1" })
    const probe = async () => {
      const res = await app.fetch(new Request("http://localhost/health"))
      return { status: res.status, body: await res.json() as Record<string, unknown> }
    }

    expect((await probe()).body.status).toBe("healthy")
    expireAuthStatusCache()
    authBehavior = "hang"

    const stalled = await settledWithin(probe(), 1_000)
    expect(stalled).not.toBe(NOT_SETTLED)
    if (stalled === NOT_SETTLED) return
    expect(stalled.status).toBe(200)
    expect(stalled.body.status).toBe("healthy")
    await tick()
    expect(hungSpawns).toHaveLength(1)
  })
})
