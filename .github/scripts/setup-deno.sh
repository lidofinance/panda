#!/usr/bin/env bash
set -euo pipefail

# Pinned Deno for the Linux x86_64 GitHub Actions runners.
deno_version=2.9.7
deno_sha256=c6527f24f4b16031d3ae4fa9f658d5f11534c8d84ce7dc8502420280919c3490
deno_directory="$RUNNER_TEMP/deno"

mkdir -p "$deno_directory"
curl --fail --show-error --location --retry 3 \
  "https://github.com/denoland/deno/releases/download/v${deno_version}/deno-x86_64-unknown-linux-gnu.zip" \
  --output "$deno_directory/deno.zip"
echo "$deno_sha256  $deno_directory/deno.zip" | sha256sum --check
unzip -q -o "$deno_directory/deno.zip" -d "$deno_directory"
chmod +x "$deno_directory/deno"
echo "$deno_directory" >> "$GITHUB_PATH"
"$deno_directory/deno" --version
