#!/bin/sh
set -e

# Keep yt-dlp fresh. YouTube changes often and breaks older yt-dlp builds, so we
# self-update on every container start instead of baking in a version that goes
# stale between image rebuilds. Non-fatal when offline so the app still boots.
echo "> Updating yt-dlp..."
yt-dlp -U 2>/dev/null || echo "> yt-dlp update skipped (offline or already latest)"

exec "$@"
