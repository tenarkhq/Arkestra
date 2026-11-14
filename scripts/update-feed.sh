#!/usr/bin/env bash
# AR33 · Writes Arkestra's update feed: one latest.json per platform and installer kind,
# in the layout VSCodium's update patch reads
# (<updateUrl>/<quality>/<platform>/<arch>[/<target>]/latest.json).
# Usage: scripts/update-feed.sh <assets-dir> <feed-dir>
# Env: RELEASE_VERSION, ASSETS_REPOSITORY, VSCODE_QUALITY (default stable),
#      FEED_DARWIN=yes to include macOS (only signed builds can update themselves there).
set -euo pipefail

ASSETS="$1"
FEED="$2"
QUALITY="${VSCODE_QUALITY:-stable}"
: "${RELEASE_VERSION:?}" "${ASSETS_REPOSITORY:?}"

# The commit the build writes into product.json (vendor/vscodium/version.sh).
BUILD_SOURCEVERSION="$( echo "${RELEASE_VERSION/-*/}" | sha1sum | cut -d' ' -f1 )"
URL_BASE="https://github.com/${ASSETS_REPOSITORY}/releases/download/${RELEASE_VERSION}"

# 1.143.17651 → 1.143.17651.0 (vendor/vscodium/update_version.sh transformVersion).
IFS='.' read -r -a PARTS <<< "${RELEASE_VERSION%-insider}"
PRODUCT_VERSION="${PARTS[0]}.${PARTS[1]}.$((10#${PARTS[2]})).0"
TIMESTAMP="$( date +%s )000"

entry() { # <asset file name> <feed path>
  local file="${ASSETS}/$1"
  if [[ ! -f "${file}" ]]; then
    echo "update-feed: ${1} is missing from ${ASSETS}" >&2
    exit 1
  fi
  local sha1 sha256
  sha1="$( awk '{ print $1 }' "${file}.sha1" 2> /dev/null || true )"
  sha256="$( awk '{ print $1 }' "${file}.sha256" 2> /dev/null || true )"
  [[ -n "${sha1}" ]] || sha1="$( sha1sum "${file}" | cut -d' ' -f1 )"
  [[ -n "${sha256}" ]] || sha256="$( sha256sum "${file}" | cut -d' ' -f1 )"
  mkdir -p "${FEED}/${QUALITY}/$2"
  jq -n --arg url "${URL_BASE}/$1" --arg name "${RELEASE_VERSION}" --arg version "${BUILD_SOURCEVERSION}" \
    --arg productVersion "${PRODUCT_VERSION}" --arg hash "${sha1}" --arg timestamp "${TIMESTAMP}" --arg sha256hash "${sha256}" \
    '{ url: $url, name: $name, version: $version, productVersion: $productVersion, hash: $hash, timestamp: $timestamp, sha256hash: $sha256hash }' \
    > "${FEED}/${QUALITY}/$2/latest.json"
  echo "update-feed: ${QUALITY}/$2 → $1"
}

entry "Arkestra-linux-x64-${RELEASE_VERSION}.tar.gz" linux/x64
entry "ArkestraSetup-x64-${RELEASE_VERSION}.exe" win32/x64/system
entry "ArkestraUserSetup-x64-${RELEASE_VERSION}.exe" win32/x64/user
entry "Arkestra-win32-x64-${RELEASE_VERSION}.zip" win32/x64/archive
if [[ "${FEED_DARWIN:-no}" == "yes" ]]; then
  entry "Arkestra-darwin-arm64-${RELEASE_VERSION}.zip" darwin/arm64
fi
