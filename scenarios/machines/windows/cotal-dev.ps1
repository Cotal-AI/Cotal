# cotal-dev for Windows: the same commands as on macOS and the Linux test VM.
#   cotal-dev.ps1 update | build | app | status
#   cotal-dev.ps1 profile new <name> [--from <template>] | shell <name> | run <name> -- <command> | reset <name> | rm <name> | list
# The live checkout is $env:COTAL_DEV_REPO (default ~\Projects\Cotal-live). Profiles work without a
# checkout too: they then use the `cotal` command on PATH.
$ErrorActionPreference = 'Stop'
$repo = if ($env:COTAL_DEV_REPO) { $env:COTAL_DEV_REPO } else { Join-Path $HOME 'Projects\Cotal-live' }
$profiles = Join-Path $HOME '.cotal-profiles'
$installedApp = Join-Path $env:LOCALAPPDATA 'Cotal\cotal-desktop.exe'

function Fail($message) { [Console]::Error.WriteLine("cotal-dev: $message"); exit 1 }
function Must { param([scriptblock]$Block, [string]$What) & $Block; if ($LASTEXITCODE -ne 0) { Fail "$What failed" } }

function Running($path) {
  @(Get-Process -ErrorAction SilentlyContinue | Where-Object { $_.Path -and $_.Path.StartsWith($path, [StringComparison]::OrdinalIgnoreCase) }).Count -gt 0
}

# The checkout's build when there is one, otherwise the cotal command on PATH. `status` says which.
function Cli {
  $built = Join-Path $repo 'bin\dist\cotal.js'
  if (Test-Path -LiteralPath $built) { return @('node', $built) }
  $onPath = Get-Command cotal -ErrorAction SilentlyContinue
  if ($onPath) { return @($onPath.Source) }
  Fail "no cotal: build the checkout at $repo, or install cotal"
}
function Cotal { $cli = Cli; if ($cli.Count -gt 1) { & $cli[0] $cli[1] @args } else { & $cli[0] @args } }

function Build {
  Push-Location $repo
  try {
    $t = Get-Date
    Must { corepack pnpm install --frozen-lockfile --reporter=silent } 'pnpm install'
    $log = Join-Path $repo '.cotal-dev-build.log'
    corepack pnpm build *> $log
    if ($LASTEXITCODE -ne 0) { Get-Content $log -Tail 25; Fail "build failed (full log: $log)" }
    Write-Output "built $(git log -1 --format='%h %s') in $([int]((Get-Date) - $t).TotalSeconds)s"
  } finally { Pop-Location }
}

function Update {
  Push-Location $repo
  try {
    Must { git fetch --quiet origin main } 'git fetch'
    $dirty = git status --porcelain --untracked-files=no
    if (-not $dirty -and (git rev-list --count origin/main..HEAD) -eq '0') { Must { git merge --ff-only --quiet origin/main } 'fast-forward' }
    else { git rebase --autostash --quiet origin/main; if ($LASTEXITCODE -ne 0) { Fail "your changes conflict with main. Fix the files, then 'git rebase --continue' (or '--abort'), then 'cotal-dev.ps1 build'" } }
  } finally { Pop-Location }
  Build
}

function App {
  if (Running $installedApp) { Fail 'quit the installed Cotal app first (tray icon > Quit). The dev app hands off to a running Cotal and closes.' }
  Push-Location $repo
  try {
    $stamp = Join-Path $repo '.cotal-dev-runtime-staged'
    $built = Join-Path $repo 'bin\dist\cotal.js'
    if (-not (Test-Path $built)) { Fail "nothing is built yet; run 'cotal-dev.ps1 build' first" }
    if (-not (Test-Path $stamp) -or (Get-Item $built).LastWriteTime -gt (Get-Item $stamp).LastWriteTime) {
      if (Running (Join-Path $repo 'desktop\src-tauri\target')) { Fail 'a dev app from this checkout is still running; quit it first' }
      Write-Output "staging the app's runtime from this build..."
      Remove-Item -Recurse -Force -ErrorAction SilentlyContinue desktop\src-tauri\runtime, desktop\src-tauri\binaries
      Get-ChildItem desktop\src-tauri -Directory -Filter '.runtime-stage-*' | Remove-Item -Recurse -Force
      Must { corepack pnpm --filter cotal-ai seeded-connectors } 'seeding connectors'
      Must { corepack pnpm --dir desktop prepare:runtime } 'staging the runtime'
      New-Item -ItemType File -Force $stamp | Out-Null
    }
    corepack pnpm --dir desktop app:dev
  } finally { Pop-Location }
}

function Status {
  Write-Output "cotal: $((Cli) -join ' ')"
  if (-not (Test-Path (Join-Path $repo '.git'))) { Write-Output "checkout: none at $repo"; return }
  Push-Location $repo
  try {
    git fetch --quiet origin main
    Write-Output "checkout: $repo"
    Write-Output "  at $(git log -1 --format='%h %s (%cr)')"
    Write-Output "  $(git rev-list --count HEAD..origin/main) commit(s) behind main, $(git rev-list --count origin/main..HEAD) of your own"
  } finally { Pop-Location }
}

# Profiles: isolated Cotal homes, each with its own service. APPDATA and LOCALAPPDATA stay as they
# are, because other tools such as npm rely on them; XDG_CONFIG_HOME moves Cotal's seed and extensions.
function ProfileDir($name) {
  if ($name -notmatch '^[a-z0-9][a-z0-9-]{0,19}$') { Fail 'a profile name is 1-20 lowercase letters, digits and dashes' }
  Join-Path $profiles $name
}

function Private($dir) {
  New-Item -ItemType Directory -Force $dir | Out-Null
  & icacls $dir /inheritance:r /grant:r "${env:USERNAME}:(OI)(CI)F" '*S-1-5-18:(OI)(CI)F' '*S-1-5-32-544:(OI)(CI)F' | Out-Null
  if ($LASTEXITCODE -ne 0) { Fail "could not make $dir private" }
}

function Enter($name) {
  $dir = ProfileDir $name
  if (-not (Test-Path $dir)) { Fail "no profile '$name'. Make it: cotal-dev.ps1 profile new $name" }
  $real = (Resolve-Path $dir).Path
  if ($real.StartsWith((Join-Path $HOME '.cotal\'), [StringComparison]::OrdinalIgnoreCase)) { Fail "profile '$name' is inside the real Cotal home" }
  $env:COTAL_PROFILE = $name; $env:COTAL_PROFILE_DIR = $real
  $env:COTAL_HOME = "$real\home"; $env:XDG_CONFIG_HOME = "$real\config"; $env:XDG_DATA_HOME = "$real\data"
  $env:XDG_STATE_HOME = "$real\state"; $env:XDG_CACHE_HOME = "$real\cache"; $env:COTAL_ALLOW_CHECKOUT_SEED = '1'
  $root = (Cotal ext root | Out-String).Trim()
  if ($LASTEXITCODE -ne 0 -or -not $root.StartsWith("$real\", [StringComparison]::OrdinalIgnoreCase)) { Fail "profile '$name' is not isolated: cotal ext root is $root" }
}

# Every `cotal daemon` call inside a profile reaches that profile's own service, never the default one.
function ProfileCotal { if ($args.Count -gt 0 -and $args[0] -eq 'daemon') { Cotal @args --daemon-home "$env:COTAL_PROFILE_DIR\daemon" } else { Cotal @args } }

function ProfileNew($name, $template = 'blank') {
  $dir = ProfileDir $name
  if (Test-Path $dir) { Fail "profile '$name' exists. Reset it: cotal-dev.ps1 profile reset $name" }
  New-Item -ItemType Directory -Force (Join-Path $profiles '_templates\blank') | Out-Null
  $source = Join-Path $profiles "_templates\$template"
  if (-not (Test-Path $source)) { Fail "no template '$template' in $profiles\_templates" }
  Private $dir
  foreach ($sub in 'home', 'config', 'data', 'state', 'cache', 'daemon') { New-Item -ItemType Directory -Force (Join-Path $dir $sub) | Out-Null }
  Copy-Item -Recurse -Force "$source\*" $dir -ErrorAction SilentlyContinue
  Set-Content -LiteralPath (Join-Path $dir '.template') $template
  Enter $name
  Write-Output "made profile '$name' from template '$template' at $dir"
}

# Removes the profile's own service first, so no scheduled task is left pointing at a deleted folder.
# A profile that never installed one is refused as TARGET_NOT_FOUND, which leaves nothing to remove.
function ProfileRemove($name) {
  $dir = ProfileDir $name
  if (-not (Test-Path $dir)) { Fail "no profile '$name'" }
  Enter $name
  $answer = ProfileCotal daemon uninstall --yes --json | Out-String
  try { $reply = $answer | ConvertFrom-Json } catch { Fail "could not remove profile '$name's service; nothing was deleted: $answer" }
  if ($reply.outcome -ne 'ok' -and $reply.error.code -ne 'TARGET_NOT_FOUND') { Fail "could not remove profile '$name's service; nothing was deleted: $answer" }
  Remove-Item -Recurse -Force $dir
}

function Profile([string[]]$rest) {
  $verb = if ($rest.Count) { $rest[0] } else { 'list' }
  $name = if ($rest.Count -gt 1) { $rest[1] } else { '' }
  switch ($verb) {
    'new' { if ($rest.Count -gt 3 -and $rest[2] -eq '--from') { ProfileNew $name $rest[3] } else { ProfileNew $name } }
    'shell' {
      Enter $name
      $prompt = "function global:prompt { '(cotal:$name) ' + (Get-Location) + '> ' }"
      # `profile run` adds the profile's --daemon-home to every `cotal daemon` call.
      $wrapper = 'function global:cotal { & ' + "'$PSCommandPath'" + ' profile run $env:COTAL_PROFILE -- cotal @args }'
      powershell -NoLogo -NoExit -Command "$prompt; $wrapper"
    }
    'run' {
      if ($rest.Count -lt 4 -or $rest[2] -ne '--') { Fail 'usage: cotal-dev.ps1 profile run <name> -- <command>' }
      Enter $name
      $command = $rest[3..($rest.Count - 1)]
      if ($command[0] -eq 'cotal') { $tail = if ($command.Count -gt 1) { $command[1..($command.Count - 1)] } else { @() }; ProfileCotal @tail }
      else { $tail = if ($command.Count -gt 1) { $command[1..($command.Count - 1)] } else { @() }; & $command[0] @tail }
      exit $LASTEXITCODE
    }
    'reset' {
      $dir = ProfileDir $name
      $template = if (Test-Path "$dir\.template") { (Get-Content "$dir\.template").Trim() } else { 'blank' }
      ProfileRemove $name
      ProfileNew $name $template
    }
    'rm' { ProfileRemove $name; Write-Output "removed profile '$name'" }
    'list' {
      Get-ChildItem $profiles -Directory -ErrorAction SilentlyContinue | Where-Object Name -ne '_templates' | ForEach-Object {
        $t = if (Test-Path "$($_.FullName)\.template") { (Get-Content "$($_.FullName)\.template").Trim() } else { '?' }
        Write-Output "$($_.Name) (from $t)"
      }
    }
    default { Fail 'profile commands: new <name> [--from <template>], shell, run <name> -- <command>, reset, rm, list' }
  }
}

switch ($(if ($args.Count) { $args[0] } else { 'help' })) {
  'update' { Update }
  'build' { Build }
  'app' { App }
  'status' { Status }
  'profile' { Profile ([string[]]$(if ($args.Count -gt 1) { $args[1..($args.Count - 1)] } else { @() })) }
  default { Get-Content $PSCommandPath -TotalCount 3 | Select-Object -Skip 1 | ForEach-Object { $_.TrimStart('# ') } }
}
