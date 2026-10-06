# Backlog delivery — 2026-10-06

## #1223: declined and closed

[Source PR #1223](https://github.com/rynfar/meridian/pull/1223) was closed without
merging at unchanged head `537ccad864336a4f4dc25f925e92177cd12fe6b2`,
2026-10-06 15:52:07 UTC. Its ownerless-grace recovery can admit another holder
after an unreadable owner record and elapsed time, without proving that the
original holder is dead or fencing it. The retained same-boot, stopped-holder
control acquired a replacement while the original PID remained alive. This is
evidence against the submitted recovery rule; it is not a power-loss/ext4 crash
reproduction.

The independent final disposition checked the complete source diff and current
protocol callers. On current main `338630adb2832381e7ddfcee7bb8567e61cc9293`, the
relevant lock protocol still matches the source parent. No source change arrived
before closure. No public comment was posted.

This supersedes the earlier recommendation to keep the excluded recovery in
#1223 open. It does not claim that the reported crash problem is fixed or that
the separately reviewed fsync/publication subset was accepted. Revisit recovery
with affirmative owner-death/boot evidence or a fencing protocol; elapsed grace
alone is insufficient.

## #1286: accepted with corrections, awaiting delivery CI

[Source PR #1286](https://github.com/rynfar/meridian/pull/1286) was created during
this delivery pass. Consequently the fresh Meridian inventory still has 20
open PRs: one source was closed and one new source arrived.

The source head is `b7caeacaf89f3f9c95d2e13ca5d1e53556eb6b46`. Its actual
Nowaker commit was cherry-picked as `20d81324d2fcc061722df1c82bb2f36710694c1c`,
preserving `Nowaker <spam@nowaker.net>` and AuthorDate
`2026-10-05T01:50:27Z`. The isolated integration branch starts at current main
`338630adb2832381e7ddfcee7bb8567e61cc9293`.

Separate maintainer correction `fdc4c5023b4202669943ac28a5471b68fe12e589`
uses one 45-second PATH lookup/probe budget across candidates, leaving room
within desktop startup's existing 60-second health wait. Profile listing
resolves the executable once, including a miss, instead of repeating its wait
for every browser profile. Auth checks remain per profile. Token-only lists
do not resolve an executable. Existing executable preference, explicit override,
and public health data remain unchanged.

The first independent review's desktop and repeated-profile findings were
corrected. Its synchronous-readiness finding used an older checkout and is
superseded: this main already has asynchronous readiness resolution, which was
not changed. A fresh independent review is checking canonical current callers
and the complete integration.

Focused validation passes: 51 tests, 89 assertions, zero failures; typecheck
and build pass. [Durable native timing proof](evidence/1286-claude-cold-start.md)
passes all twelve actual-macOS baseline/fixed controls with Claude 2.1.289.
Fresh independent review accepts the complete correction and exact harness.
The original full `npm test` retains one unchanged store benchmark failure;
the isolated baseline/current graph is byte-identical and both comparisons
pass. Previously unreached stages pass separately. No benchmark threshold
was changed and the first failure remains recorded. Delivery CI, including
`test`, and exact-head merge verification remain pending. The first live fixture's
sync arm failed an unsupported fallback-source assertion after its PATH was
changed inside Bun; its result was not logged first. That failure remains
retained, and the corrected fixture supplies PATH before launching each fresh
Bun arm. It does not count as a passed before/after control.

This pass adds no shared guardian or general test-platform work. The owner's
dirty checkout remains preserved; releases and public comments remain
unauthorized.
