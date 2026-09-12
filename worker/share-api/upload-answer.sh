#!/usr/bin/env bash
# The PRIVATE half of today's puzzle. Without it share-api has no answer to verify
# against, so every correct guess comes back `unverified` (HTTP 400) and nothing reaches
# the leaderboard, the stats or the streak.
#
#   cd "C:/Users/reser/Workspaces/Media Remote/flickto-server/worker/share-api"
#   bash upload-answer.sh
set -euo pipefail

npx wrangler r2 object put flickto-content/game-state/answers/2026-08-12.json \
  --file ./answer-2026-08-12.json --content-type application/json

echo
echo "Checking a correct guess now verifies..."
sleep 2
curl -s -X POST https://flickto.app/api/daily-game/result \
  -H 'Content-Type: application/json' \
  -d '{"results":[{"date":"2026-08-12","puzzleNumber":1,"guesses":[37165],"types":[0]}]}'
echo
echo 'Expect {"accepted":1,"anonymous":true}. If it still says unverified, the object did not land.'
echo
echo 'NOTE: that check submits one ANONYMOUS result, which adds 1 to the public'
echo 'distribution for today. It does not touch your account or the leaderboard.'
