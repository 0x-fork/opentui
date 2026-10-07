import { spawnSync } from "node:child_process"
import { appendFileSync, readFileSync } from "node:fs"
import { dirname, join, resolve } from "node:path"
import process from "node:process"
import { setTimeout as sleep } from "node:timers/promises"
import { fileURLToPath } from "node:url"

import { registryIntegrity } from "./npm-publish"

// Releases main. release.yml publishes each commit on main that changes the version, so a release is
// a "Release vX.Y.Z" commit on main, pushed directly or merged from a pull request.
//
//   bun run release <patch|minor|major|version> [--pr | --dry-run] [--no-watch]
//
// 1. Checks that main is checked out without uncommitted changes and matches origin/main.
// 2. Waits for the checks of that commit, and fails if one fails: the checks that the branch rules
//    require, and every workflow run that the push to main started.
// 3. Runs prepare-release, commits "Release vX.Y.Z", and pushes the commit to main. That needs the
//    right to bypass the branch rules.
// 4. Follows the release.yml run of the commit. Its publish job ends when npm serves every package,
//    and this script reports that time.
//
// --pr pushes the commit to a release/vX.Y.Z branch and opens a pull request instead. Merging it
// releases. The "Prepare Release" workflow, the release button, runs this mode.
//
// --dry-run tags the commit vX.Y.Z-dry.N and pushes only the tag. main does not change, and the
// release run builds and packs every package but publishes nothing. --no-watch stops after the push.
//
//   bun scripts/release.ts wait-checks <sha>
//
// Waits for the checks of one commit, as in step 2. release.yml runs it for the commit that a release
// commit builds on, because main can move between opening a release pull request and merging it.

type Mode = "push" | "pr" | "dry-run"

interface Options {
  target: string
  mode: Mode
  watch: boolean
}

interface Release {
  version: string
  sha: string
  // The ref that was pushed, without refs/heads/ or refs/tags/.
  ref: string
  pushedAt: number
}

interface RequiredCheck {
  context: string
  integration_id?: number
}

interface CheckRun {
  name: string
  status: string
  conclusion: string | null
  app: { id: number } | null
}

interface WorkflowRun {
  id: number
  name: string
  status: string
  conclusion: string | null
  head_sha: string
  html_url: string
}

interface Job {
  name: string
  status: string
  conclusion: string | null
}

const BRANCH = "main"
const RELEASE_WORKFLOW = "release.yml"
const NPM_PUBLISH_JOB = "NPM Publish / publish"
const RELEASE_TYPES = ["patch", "minor", "major"]
const VERSION_PATTERN = /^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/
const PASSING = new Set(["success", "neutral", "skipped"])
const POLL_MS = 10_000
const MAX_API_FAILURES = 5
const CHECKS_TIMEOUT_MS = 30 * 60_000
const RUN_START_TIMEOUT_MS = 3 * 60_000
const RUN_TIMEOUT_MS = 60 * 60_000
const USAGE = [
  "Usage: bun run release <patch|minor|major|version> [--pr | --dry-run] [--no-watch]",
  "       bun scripts/release.ts wait-checks <sha>",
].join("\n")

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..")

// A definite failure. Polling retries other errors, which are usually failed API requests.
class ReleaseError extends Error {}

function parseOptions(args: readonly string[]): Options {
  const flags = args.filter((arg) => arg.startsWith("--"))
  const positional = args.filter((arg) => !arg.startsWith("--"))
  const unknown = flags.filter((flag) => !["--pr", "--dry-run", "--no-watch"].includes(flag))
  if (unknown.length > 0) throw new ReleaseError(`Unknown option ${unknown.join(", ")}\n${USAGE}`)
  if (flags.includes("--pr") && flags.includes("--dry-run")) throw new ReleaseError(`Use --pr or --dry-run\n${USAGE}`)
  if (positional.length !== 1) throw new ReleaseError(USAGE)
  const target = positional[0]!.replace(/^v/, "")
  if (!RELEASE_TYPES.includes(target) && !VERSION_PATTERN.test(target)) {
    throw new ReleaseError(`Not a release type or version: ${positional[0]}\n${USAGE}`)
  }
  // release.yml handles tags that contain these as snapshots and dry runs.
  if (target.includes("snapshot") || target.includes("-dry.")) {
    throw new ReleaseError(`A release version cannot contain "snapshot" or "-dry.": ${target}`)
  }
  const mode = flags.includes("--pr") ? "pr" : flags.includes("--dry-run") ? "dry-run" : "push"
  return { target, mode, watch: !flags.includes("--no-watch") }
}

function run(command: string, args: readonly string[], options: { inherit?: boolean } = {}): string {
  const result = spawnSync(command, args, {
    cwd: repoRoot,
    encoding: "utf8",
    stdio: options.inherit ? "inherit" : ["ignore", "pipe", "pipe"],
  })
  if (result.error) throw result.error
  if (result.status !== 0) {
    const output = [result.stdout, result.stderr].map((text) => text?.trim()).filter(Boolean)
    const shown = args.map((arg) =>
      arg.length > 60 || arg.includes("\n") ? `${arg.slice(0, 40).split("\n")[0]}...` : arg,
    )
    throw new Error([`${command} ${shown.join(" ")} failed`, ...output].join("\n"))
  }
  return result.stdout?.trim() ?? ""
}

function git(...args: string[]): string {
  return run("git", args)
}

function gh<T>(path: string): T {
  return JSON.parse(run("gh", ["api", path])) as T
}

function ghPost<T>(path: string, fields: Record<string, string>): T {
  const args = Object.entries(fields).flatMap(([key, value]) => ["--raw-field", `${key}=${value}`])
  return JSON.parse(run("gh", ["api", "--method", "POST", ...args, path])) as T
}

// Reads every page of a list endpoint. `jq` selects the items of one page.
function ghList<T>(path: string, jq: string): T[] {
  return run("gh", ["api", "--paginate", "--jq", jq, path])
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as T)
}

function short(sha: string | undefined): string {
  return sha ? sha.slice(0, 9) : "nothing"
}

function formatDuration(ms: number): string {
  const seconds = Math.round(ms / 1000)
  return `${Math.floor(seconds / 60)}m${String(seconds % 60).padStart(2, "0")}s`
}

async function poll<T>(what: string, timeoutMs: number, attempt: () => T | undefined): Promise<T> {
  const start = Date.now()
  let failures = 0
  while (true) {
    try {
      const result = attempt()
      failures = 0
      if (result !== undefined) return result
    } catch (error) {
      if (error instanceof ReleaseError || ++failures >= MAX_API_FAILURES) throw error
      console.error(`${error instanceof Error ? error.message : error}; retrying`)
    }
    if (Date.now() - start > timeoutMs) {
      throw new ReleaseError(`Timed out after ${formatDuration(timeoutMs)} waiting for ${what}`)
    }
    await sleep(POLL_MS)
  }
}

function githubRepo(): string {
  if (process.env.GITHUB_REPOSITORY) return process.env.GITHUB_REPOSITORY
  const url = git("remote", "get-url", "origin")
  const match = /github\.com[:/](.+?)(?:\.git)?\/?$/.exec(url)
  if (!match) throw new ReleaseError(`origin is not a GitHub repository: ${url}`)
  return match[1]!
}

function remoteSha(ref: string): string | undefined {
  return git("ls-remote", "origin", ref).split(/\s+/)[0] || undefined
}

// Returns the commit of main.
function checkMain(): string {
  let branch = ""
  try {
    branch = git("symbolic-ref", "--quiet", "--short", "HEAD")
  } catch {}
  if (branch !== BRANCH) throw new ReleaseError(`Check out ${BRANCH} to release. HEAD is ${branch || "detached"}.`)
  if (git("status", "--porcelain", "--untracked-files=no")) {
    throw new ReleaseError("Commit or stash the uncommitted changes first")
  }
  const head = git("rev-parse", "HEAD")
  const remote = remoteSha(`refs/heads/${BRANCH}`)
  if (head !== remote) {
    throw new ReleaseError(`Local ${BRANCH} is at ${short(head)} but origin/${BRANCH} is at ${short(remote)}`)
  }
  return head
}

function requiredChecks(repo: string): RequiredCheck[] {
  const rules = gh<Array<{ type: string; parameters?: { required_status_checks?: RequiredCheck[] } }>>(
    `repos/${repo}/rules/branches/${BRANCH}`,
  )
  return rules.flatMap((rule) =>
    rule.type === "required_status_checks" ? (rule.parameters?.required_status_checks ?? []) : [],
  )
}

// Returns the checks that have not finished. Throws if one failed.
function pendingChecks(repo: string, sha: string, required: readonly RequiredCheck[]): string[] {
  const checkRuns = ghList<CheckRun>(`repos/${repo}/commits/${sha}/check-runs?per_page=100`, ".check_runs[]")
  const workflowRuns = ghList<WorkflowRun>(
    `repos/${repo}/actions/runs?head_sha=${sha}&event=push&branch=${BRANCH}&per_page=100`,
    ".workflow_runs[]",
  )
  const pending: string[] = []
  const failed: string[] = []
  for (const check of required) {
    const matches = checkRuns.filter(
      (checkRun) =>
        checkRun.name === check.context &&
        (check.integration_id === undefined || checkRun.app?.id === check.integration_id),
    )
    const failure = matches.find(
      (checkRun) => checkRun.status === "completed" && !PASSING.has(checkRun.conclusion ?? ""),
    )
    if (failure) failed.push(`${check.context}: ${failure.conclusion}`)
    else if (matches.length === 0 || matches.some((checkRun) => checkRun.status !== "completed")) {
      pending.push(check.context)
    }
  }
  for (const workflowRun of workflowRuns) {
    if (workflowRun.status !== "completed") pending.push(workflowRun.name)
    else if (!PASSING.has(workflowRun.conclusion ?? "")) {
      failed.push(`${workflowRun.name}: ${workflowRun.conclusion} (${workflowRun.html_url})`)
    }
  }
  if (failed.length > 0) throw new ReleaseError(`Checks failed on ${short(sha)}:\n  ${failed.join("\n  ")}`)
  return [...new Set(pending)]
}

async function waitForChecks(repo: string, sha: string): Promise<void> {
  const required = requiredChecks(repo)
  let reported = ""
  await poll(`the checks of ${short(sha)}`, CHECKS_TIMEOUT_MS, () => {
    const pending = pendingChecks(repo, sha, required)
    if (pending.length === 0) return true
    const summary = pending.join(", ")
    if (summary !== reported) console.log(`Waiting for ${pending.length} checks on ${short(sha)}: ${summary}`)
    reported = summary
    return undefined
  })
  console.log(`Checks passed on ${short(sha)}`)
}

function coreVersion(): string {
  return (JSON.parse(readFileSync(join(repoRoot, "packages", "core", "package.json"), "utf8")) as { version: string })
    .version
}

// Semver precedence: negative when left is older than right.
function compareVersions(left: string, right: string): number {
  const [leftCore = "", leftPre] = left.split(/-(.*)/)
  const [rightCore = "", rightPre] = right.split(/-(.*)/)
  const leftParts = leftCore.split(".").map(Number)
  const rightParts = rightCore.split(".").map(Number)
  for (let index = 0; index < 3; index++) {
    const difference = leftParts[index]! - rightParts[index]!
    if (difference !== 0) return difference
  }
  if (leftPre === undefined || rightPre === undefined)
    return (leftPre === undefined ? 1 : 0) - (rightPre === undefined ? 1 : 0)
  const leftIds = leftPre.split(".")
  const rightIds = rightPre.split(".")
  for (let index = 0; index < Math.max(leftIds.length, rightIds.length); index++) {
    const leftId = leftIds[index]
    const rightId = rightIds[index]
    if (leftId === undefined || rightId === undefined) return leftId === undefined ? -1 : 1
    if (leftId === rightId) continue
    const leftNumeric = /^\d+$/.test(leftId)
    const rightNumeric = /^\d+$/.test(rightId)
    if (leftNumeric && rightNumeric) return Number(leftId) - Number(rightId)
    if (leftNumeric !== rightNumeric) return leftNumeric ? -1 : 1
    return leftId < rightId ? -1 : 1
  }
  return 0
}

function nextDryRunTag(version: string): string {
  const prefix = `v${version}-dry.`
  const numbers = git("ls-remote", "--tags", "--refs", "origin", `refs/tags/${prefix}*`)
    .split("\n")
    .map((line) => Number(line.split(`refs/tags/${prefix}`)[1]))
    .filter(Number.isInteger)
  return `${prefix}${Math.max(0, ...numbers) + 1}`
}

// The commit that a tag on origin points to.
function remoteTagCommit(tag: string): string | undefined {
  const lines = git("ls-remote", "--tags", "origin", `refs/tags/${tag}`, `refs/tags/${tag}^{}`).split("\n")
  const peeled = lines.find((line) => line.endsWith("^{}")) ?? lines[0]
  return peeled?.split(/\s+/)[0] || undefined
}

function push(ref: string, sha: string): void {
  try {
    run("git", ["push", "origin", ref], { inherit: true })
  } catch (error) {
    // The push can reach origin and still fail here, for example when the connection drops.
    const target = ref.slice(ref.indexOf(":") + 1)
    const landed = target.startsWith("refs/tags/")
      ? remoteTagCommit(target.slice("refs/tags/".length))
      : remoteSha(target)
    if (landed === sha) return
    throw error
  }
}

// Undoes the release commit, tag, and branch. The working tree had no uncommitted changes before them.
function restore(base: string, tag: string | undefined, branch: string | undefined): void {
  console.error(`Restoring ${BRANCH} to ${short(base)}`)
  git("switch", "--quiet", "--force", BRANCH)
  git("reset", "--quiet", "--hard", base)
  if (tag) spawnSync("git", ["tag", "--delete", tag], { cwd: repoRoot, stdio: "ignore" })
  if (branch) spawnSync("git", ["branch", "--delete", "--force", branch], { cwd: repoRoot, stdio: "ignore" })
}

async function pushRelease(options: Options, base: string): Promise<Release> {
  const previous = coreVersion()
  let tag: string | undefined
  let branch: string | undefined
  let interrupted = false
  const onInterrupt = () => {
    interrupted = true
  }
  const stopIfInterrupted = () => {
    if (interrupted) throw new ReleaseError("Interrupted")
  }
  process.on("SIGINT", onInterrupt)
  try {
    // A dry run commits on a detached HEAD, so main does not change.
    if (options.mode === "dry-run") git("switch", "--quiet", "--detach")
    const prepareArgs = RELEASE_TYPES.includes(options.target) ? [`--${options.target}`] : [options.target]
    console.log(`Running prepare-release ${prepareArgs[0]}...`)
    run("bun", ["scripts/prepare-release.ts", ...prepareArgs])
    stopIfInterrupted()

    const version = coreVersion()
    // npm moves the latest tag to each published version, older or not.
    if (compareVersions(version, previous) <= 0) {
      throw new ReleaseError(`${version} is not newer than ${previous}, the version on ${BRANCH}`)
    }
    if (remoteSha(`refs/tags/v${version}`)) throw new ReleaseError(`Tag v${version} already exists on origin`)
    if ((await registryIntegrity("@opentui/core", version)) !== undefined) {
      throw new ReleaseError(`@opentui/core@${version} is already on npm`)
    }
    if (options.mode === "pr") {
      branch = `release/v${version}`
      if (remoteSha(`refs/heads/${branch}`)) throw new ReleaseError(`Branch ${branch} already exists on origin`)
      git("switch", "--quiet", "--create", branch)
    }
    stopIfInterrupted()

    console.log(`Prepared ${previous} -> ${version}. Committing...`)
    run("git", ["commit", "--quiet", "--all", "--message", `Release v${version}`], { inherit: true })
    if (options.mode === "dry-run") {
      tag = nextDryRunTag(version)
      run("git", ["tag", "--annotate", tag, "--message", `Release ${tag}`], { inherit: true })
    }
    const sha = git("rev-parse", "HEAD")
    stopIfInterrupted()

    const ref = tag ?? branch ?? BRANCH
    push(tag ? `refs/tags/${tag}` : `HEAD:refs/heads/${ref}`, sha)
    const release = { version, sha, ref, pushedAt: Date.now() }
    if (options.mode !== "push") git("switch", "--quiet", BRANCH)
    if (branch) git("branch", "--quiet", "--delete", "--force", branch)
    return release
  } catch (error) {
    try {
      restore(base, tag, branch)
    } catch (restoreError) {
      console.error(restoreError instanceof Error ? restoreError.message : restoreError)
    }
    throw error
  } finally {
    process.off("SIGINT", onInterrupt)
  }
}

async function findReleaseRun(repo: string, release: Release): Promise<WorkflowRun> {
  const path = `repos/${repo}/actions/workflows/${RELEASE_WORKFLOW}/runs?event=push&branch=${encodeURIComponent(release.ref)}&head_sha=${release.sha}&per_page=10`
  return poll(`the ${RELEASE_WORKFLOW} run of ${short(release.sha)}`, RUN_START_TIMEOUT_MS, () =>
    gh<{ workflow_runs: WorkflowRun[] }>(path).workflow_runs.find(
      (workflowRun) => workflowRun.head_sha === release.sha,
    ),
  )
}

// Pull requests opened with the GITHUB_TOKEN of a workflow start no workflows, so the required checks
// do not run on them.
function openPullRequest(repo: string, release: Release): string {
  const body = [
    `Merging this pull request releases v${release.version}. release.yml publishes each commit on ${BRANCH} that changes the version.`,
    "",
    "This commit changes only versions. Before it builds, release.yml waits for the checks of the commit that this one is merged onto.",
  ].join("\n")
  try {
    return ghPost<{ html_url: string }>(`repos/${repo}/pulls`, {
      title: `Release v${release.version}`,
      head: release.ref,
      base: BRANCH,
      body,
    }).html_url
  } catch (error) {
    spawnSync("git", ["push", "--quiet", "origin", "--delete", `refs/heads/${release.ref}`], {
      cwd: repoRoot,
      stdio: "ignore",
    })
    throw error
  }
}

// Prints each job as it starts and ends. Returns the finished run and when the publish job succeeded.
async function watchRelease(
  repo: string,
  releaseRun: WorkflowRun,
  release: Release,
  dryRun: boolean,
): Promise<{ finished: WorkflowRun; npmDoneAt?: number }> {
  const states = new Map<string, string>()
  let npmDoneAt: number | undefined
  const finished = await poll(releaseRun.html_url, RUN_TIMEOUT_MS, () => {
    for (const job of ghList<Job>(`repos/${repo}/actions/runs/${releaseRun.id}/jobs?per_page=100`, ".jobs[]")) {
      const state =
        job.status === "completed" ? (job.conclusion ?? "completed") : job.status === "in_progress" ? "started" : ""
      if (!state || state === "skipped" || states.get(job.name) === state) continue
      states.set(job.name, state)
      console.log(`${formatDuration(Date.now() - release.pushedAt).padStart(7)}  ${job.name}: ${state}`)
      if (job.name === NPM_PUBLISH_JOB && state === "success" && npmDoneAt === undefined) {
        npmDoneAt = Date.now()
        console.log(
          dryRun
            ? "Dry run: every package packed, nothing published"
            : `npm serves every package of ${release.version}`,
        )
      }
    }
    const current = gh<WorkflowRun>(`repos/${repo}/actions/runs/${releaseRun.id}`)
    return current.status === "completed" ? current : undefined
  })
  return { finished, npmDoneAt }
}

function report(lines: readonly string[]): void {
  console.log(`\n${lines.join("\n")}`)
  const summary = process.env.GITHUB_STEP_SUMMARY
  if (summary) appendFileSync(summary, `${lines.join("\n")}\n`)
}

async function main(): Promise<void> {
  const args = process.argv.slice(2)
  if (args[0] === "wait-checks") {
    if (args.length !== 2) throw new ReleaseError(USAGE)
    await waitForChecks(githubRepo(), args[1]!)
    return
  }

  const options = parseOptions(args)
  const repo = githubRepo()
  const base = checkMain()
  console.log(`Releasing ${repo} ${BRANCH} at ${short(base)}: ${options.target}, ${options.mode}`)

  await waitForChecks(repo, base)
  if (checkMain() !== base) throw new ReleaseError(`${BRANCH} moved while the checks ran. Release again.`)

  const release = await pushRelease(options, base)
  console.log(`Pushed Release v${release.version} (${short(release.sha)}) to ${release.ref}`)
  if (options.mode === "pr") {
    const url = openPullRequest(repo, release)
    report([`Opened ${url}`, `- Merge it to release v${release.version}.`])
    return
  }

  const tag = options.mode === "dry-run" ? release.ref : `v${release.version}`
  const releaseRun = await findReleaseRun(repo, release)
  console.log(`Release run: ${releaseRun.html_url}`)
  if (!options.watch) {
    report([`Pushed ${tag}`, `- Release run: ${releaseRun.html_url}`])
    return
  }

  const dryRun = options.mode === "dry-run"
  const { finished, npmDoneAt } = await watchRelease(repo, releaseRun, release, dryRun)
  const elapsed = (time: number) => formatDuration(time - release.pushedAt)
  if (finished.conclusion !== "success") {
    report([
      `Release ${tag} failed: ${finished.conclusion}`,
      `- Release run: ${finished.html_url}`,
      "- Publishing resumes where it stopped: re-run the failed jobs, then follow them with `gh run watch`.",
    ])
    throw new ReleaseError(`The release run of ${tag} ended with ${finished.conclusion}`)
  }
  report([
    dryRun ? `Dry run ${tag} passed` : `Released ${tag}`,
    ...(npmDoneAt === undefined
      ? []
      : [
          dryRun
            ? `- Packages packed ${elapsed(npmDoneAt)} after the push`
            : `- npm serves every package ${elapsed(npmDoneAt)} after the push`,
        ]),
    `- Release run finished ${elapsed(Date.now())} after the push: ${finished.html_url}`,
    `- GitHub release: https://github.com/${repo}/releases/tag/${tag}`,
  ])
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error)
  process.exit(1)
})
