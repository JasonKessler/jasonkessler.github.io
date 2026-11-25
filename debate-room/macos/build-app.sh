#!/bin/bash
set -euo pipefail
macos_dir="$(cd -- "$(dirname -- "$0")" && pwd)"
source_dir="$(dirname -- "$macos_dir")"
version="$(/usr/libexec/PlistBuddy -c 'Print :CFBundleShortVersionString' "$macos_dir/Info.plist")"
for page in index.html guest.html; do
    if ! /usr/bin/grep -Fq "<small id=\"release-version\">v${version}</small>" "$source_dir/$page"; then
        printf 'Update the visible version in %s to match Info.plist (%s).\n' "$page" "$version" >&2
        exit 1
    fi
done
output_dir="${1:-$source_dir/build}"
mkdir -p "$output_dir"
output_dir="$(cd -- "$output_dir" && pwd)"
staging="$(mktemp -d "$output_dir/.debate-build.XXXXXX")"
trap 'rm -rf -- "$staging"' EXIT
app="$staging/Debate Room.app"
mkdir -p "$app/Contents/MacOS" "$app/Contents/Resources"
cp "$macos_dir/Info.plist" "$app/Contents/"
cp "$macos_dir/run-service.sh" "$macos_dir/internet_bridge.py" "$macos_dir/video-call.html" "$app/Contents/Resources/"
for file in call-media.js index.html local-ai.js local-ai.css ai-participants.js local_service.py requirements.txt README.md; do
    cp "$source_dir/$file" "$app/Contents/Resources/"
done
swiftc -O -target arm64-apple-macosx14.0 -o "$app/Contents/MacOS/DebateRoom" "$macos_dir/"*.swift
codesign --force --sign - --identifier io.github.jasonkessler.debateroom "$app"
codesign --verify --strict "$app"
if [[ -e "$output_dir/Debate Room.app" ]]; then
    echo "An app already exists in $output_dir. Choose a new output directory." >&2
    exit 1
fi
mv "$app" "$output_dir/"
ditto -c -k --keepParent "$output_dir/Debate Room.app" "$output_dir/Debate Room for Mac.zip"
printf '%s\n' "$output_dir/Debate Room.app"
