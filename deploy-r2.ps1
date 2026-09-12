<#
.SYNOPSIS
  1. Creates the flickto-content R2 bucket (if needed)
  2. Uploads all static content to it (remote)
  3. Copies latest.json from flickto-daily into content/daily/

.NOTES
  Requires: npx wrangler (authenticated)
  Run from: flickto-server/
#>

$BUCKET = "flickto-content"
$OLD_BUCKET = "flickto-daily"

Write-Host "Uploading static content to R2 bucket: $BUCKET (remote)" -ForegroundColor Cyan

# ── Legal pages (extensionless keys so /privacy and /delete resolve directly) ──
Write-Host "  privacy" -ForegroundColor Gray
cmd /c "npx wrangler r2 object put $BUCKET/privacy --file content/privacy.html --ct text/html --remote"

Write-Host "  delete" -ForegroundColor Gray
cmd /c "npx wrangler r2 object put $BUCKET/delete --file content/delete.html --ct text/html --remote"

# ── Content JSON files ──
foreach ($file in Get-ChildItem content/content -File -Filter "*.json") {
    $key = "content/$($file.Name)"
    Write-Host "  $key" -ForegroundColor Gray
    cmd /c "npx wrangler r2 object put $BUCKET/$key --file `"$($file.FullName)`" --ct application/json --remote"
}

# ── Content HTML (content landing page) ──
if (Test-Path content/content/index.html) {
    Write-Host "  content/index.html" -ForegroundColor Gray
    cmd /c "npx wrangler r2 object put $BUCKET/content/index.html --file content/content/index.html --ct text/html --remote"
}

# ── Award seasons ──
foreach ($file in Get-ChildItem content/content/awards -File -Filter "*.json") {
    $key = "content/awards/$($file.Name)"
    Write-Host "  $key" -ForegroundColor Gray
    cmd /c "npx wrangler r2 object put $BUCKET/$key --file `"$($file.FullName)`" --ct application/json --remote"
}

# ── One Take guess index ──
# The whole guess universe (~31k titles, ~1.4 MB), read once by every client for
# autocomplete and for grading. The filename carries the version so it can be cached
# hard and forever; content/game/latest.json names the one currently in use. Publish a
# NEW version rather than overwriting, or clients holding the old file will grade
# against a guess list the puzzle no longer agrees with.
# Regenerate with: worker/daily-ai/scripts/build-game-data.mjs
foreach ($file in Get-ChildItem content/content/game -File -Filter "*.json" -ErrorAction SilentlyContinue) {
    $key = "content/game/$($file.Name)"
    Write-Host "  $key" -ForegroundColor Gray
    cmd /c "npx wrangler r2 object put $BUCKET/$key --file `"$($file.FullName)`" --ct application/json --remote"
}

# ── .well-known (Android App Links) ──
if (Test-Path content/.well-known/assetlinks.json) {
    Write-Host "  .well-known/assetlinks.json" -ForegroundColor Gray
    cmd /c "npx wrangler r2 object put $BUCKET/.well-known/assetlinks.json --file content/.well-known/assetlinks.json --ct application/json --remote"
}

# ── Copy latest daily JSON from flickto-daily → flickto-content/content/daily/ ──
Write-Host "`nCopying daily content from '$OLD_BUCKET' to '$BUCKET/content/daily/'..." -ForegroundColor Cyan

$tempDir = Join-Path $env:TEMP "flickto-daily-migrate"
if (Test-Path $tempDir) { Remove-Item $tempDir -Recurse -Force }
New-Item $tempDir -ItemType Directory | Out-Null

$today = (Get-Date).ToString("yyyy-MM-dd")
$filesToCopy = @("latest.json", "$today.json")

foreach ($fname in $filesToCopy) {
    $localFile = Join-Path $tempDir $fname
    Write-Host "  $OLD_BUCKET/$fname -> $BUCKET/content/daily/$fname" -ForegroundColor Gray
    cmd /c "npx wrangler r2 object get $OLD_BUCKET/$fname --file `"$localFile`" --remote" 2>$null
    if (Test-Path $localFile) {
        cmd /c "npx wrangler r2 object put $BUCKET/content/daily/$fname --file `"$localFile`" --ct application/json --remote"
    } else {
        Write-Host "    (not found in old bucket, skipping)" -ForegroundColor DarkGray
    }
}

Remove-Item $tempDir -Recurse -Force -ErrorAction SilentlyContinue

# ── Clean up test object ──
cmd /c "npx wrangler r2 object delete $BUCKET/test.txt --remote" 2>$null

Write-Host "`nDone!" -ForegroundColor Green
Write-Host @"

Next steps:
  1. Go to Cloudflare Dashboard -> R2 -> flickto-content -> Settings
  2. Under 'Public Access -> Custom Domains', click 'Connect Domain'
  3. Enter: flickto.app
  4. Deploy the content worker (removes its old routes):
       cd flickto-server/content && npx wrangler deploy
  5. Deploy daily-ai (now writes to flickto-content/content/daily/):
       cd flickto-server/worker/daily-ai && npx wrangler deploy
"@ -ForegroundColor Yellow
