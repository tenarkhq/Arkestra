#!/usr/bin/env bash
# Prepares an Arkestra source tree: a fresh work copy of the vendored VSCodium
# scripts with the Arkestra identity, the pinned VS Code source, VSCodium's
# patches, and the Arkestra names. Usage: scripts/prepare.sh [work-dir]
# Build afterwards from the work dir with VSCodium's build.sh (AR02 does it in CI).
set -eo pipefail  # no -u: the VSCodium scripts read unset variables
ROOT="$( cd "$( dirname "${BASH_SOURCE[0]}" )/.." && pwd )"
WORK="${1:-${ROOT}/build/work}"

# shellcheck source=../branding/arkestra.env
. "${ROOT}/branding/arkestra.env"
export CI_BUILD="${CI_BUILD:-no}"
export OS_NAME="${OS_NAME:-linux}"

rm -rf "${WORK}"
mkdir -p "${WORK}"
cp -a "${ROOT}/vendor/vscodium/." "${WORK}/"

# VSCodium merges the work root's product.json over VS Code's as its last
# product step, so the Arkestra keys win there.
jq -s '.[0] * .[1]' "${ROOT}/vendor/vscodium/product.json" "${ROOT}/branding/product.json" > "${WORK}/product.json"

# Leave out the VSCodium patches Arkestra keeps the feature of.
grep -v -E '^\s*(#|$)' "${ROOT}/branding/skip-patches.txt" | while IFS= read -r PATCH; do
  rm -f "${WORK}/patches/${PATCH}"
done

# Arkestra's own built-in extensions go in with the names step.
mkdir -p "${WORK}/arkestra-extensions"
cp -R "${ROOT}/extensions/." "${WORK}/arkestra-extensions/"
rm -rf "${WORK}"/arkestra-extensions/*/node_modules "${WORK}"/arkestra-extensions/*/out

# Run the Arkestra names after VSCodium's own literals.
cp "${ROOT}/branding/after-prepare.sh" "${WORK}/after-prepare.sh"
printf '\n. ./after-prepare.sh\n' >> "${WORK}/prepare_vscode.sh"

cd "${WORK}"
. ./get_repo.sh
if [[ "${ARKESTRA_SKIP_PREPARE:-no}" != "yes" ]]; then
  . ./prepare_vscode.sh
fi
