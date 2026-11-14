#!/usr/bin/env bash
# Runs inside the work copy right after VSCodium's prepare_vscode.sh, from the
# work root. Replaces the VSCodium names and links that prepare_vscode.sh
# writes as literals, and removes its update feed.
set -e
cd vscode

# VSCodium's update feed would offer VSCodium builds; Arkestra has none yet.
jq 'del(.updateUrl)' product.json > product.json.tmp && mv product.json.tmp product.json

brand() {
  [[ -f "$1" ]] || return 0
  sed -i -E \
    -e 's#https://github\.com/VSCodium/vscodium/graphs/contributors#https://github.com/tenarkhq/Arkestra#g' \
    -e 's#https://github\.com/VSCodium/vscodium\#download-install#https://github.com/tenarkhq/Arkestra/releases#g' \
    -e 's#https://(www\.)?vscodium\.com/img/vscodium\.png#https://github.com/tenarkhq/Arkestra#g' \
    -e 's#https://(www\.)?vscodium\.com#https://github.com/tenarkhq/Arkestra#g' \
    -e 's#VSCodium Team#Tenark#g' \
    -e 's#VSCodium#Arkestra#g' \
    "$1"
}

for f in package.json resources/server/manifest.json build/lib/electron.ts \
         resources/linux/code.appdata.xml resources/linux/debian/control.template \
         resources/linux/rpm/code.spec.template build/win32/code.iss; do
  brand "$f"
done

# VSCodium hides every built-in AI feature by default (chat.disableAIFeatures
# = true). Arkestra is built on that chat and agent surface, so the default
# stays false; anyone can still turn them off in the settings.
perl -0pi -e 's/(localize\('"'"'chat\.disableAIFeatures'"'"'[^\n]*\n\s*default: )true/${1}false/' \
  src/vs/workbench/contrib/chat/browser/chat.shared.contribution.ts
grep -A1 "localize('chat.disableAIFeatures'" src/vs/workbench/contrib/chat/browser/chat.shared.contribution.ts | grep -q "default: false"

# Source maps of an Arkestra build are published under Arkestra, not VSCodium.
for f in build/gulpfile.vscode.ts build/gulpfile.vscode.web.ts build/gulpfile.reh.ts build/gulpfile.extensions.ts; do
  [[ -f "$f" ]] && sed -i 's#https://github.com/VSCodium/sourcemaps/#https://github.com/tenarkhq/arkestra-sourcemaps/#g' "$f"
done

# Arkestra's own built-in extensions: copied in, compiled and installed with
# the others.
for EXT in ../arkestra-extensions/*/; do
  NAME="$( basename "${EXT}" )"
  rm -rf "extensions/${NAME}"
  cp -R "${EXT}" "extensions/${NAME}"
  grep -q "'extensions/${NAME}/tsconfig.json'" build/gulpfile.extensions.ts || \
    sed -i "s#^\(\s*\)'extensions/merge-conflict/tsconfig.json',#&\n\1'extensions/${NAME}/tsconfig.json',#" build/gulpfile.extensions.ts
  grep -q "'extensions/${NAME}'," build/npm/dirs.ts || \
    sed -i "s#^\(\s*\)'extensions/merge-conflict',#&\n\1'extensions/${NAME}',#" build/npm/dirs.ts
  grep -q "'extensions/${NAME}/tsconfig.json'" build/gulpfile.extensions.ts
  grep -q "'extensions/${NAME}'," build/npm/dirs.ts
done

# AR03 · Removed: built-in extensions Arkestra does not ship.
#   microsoft-authentication, tunnel-forwarding: Microsoft sign-in and relay.
#   grunt, gulp, jake: outdated task runners; available from Open VSX.
for NAME in microsoft-authentication tunnel-forwarding grunt gulp jake; do
  rm -rf "extensions/${NAME}"
  sed -i "\#^\s*'extensions/${NAME}/tsconfig.json',\$#d" build/gulpfile.extensions.ts
  sed -i "\#^\s*'extensions/${NAME}',\$#d" build/npm/dirs.ts
  if grep -q "'extensions/${NAME}[/']" build/gulpfile.extensions.ts build/npm/dirs.ts; then
    echo "after-prepare: ${NAME} is still listed in the build" >&2
    exit 1
  fi
done

# AR03 · Removed: Remote Tunnels need these product keys; without them the feature is off.
jq 'del(.tunnelApplicationName, .tunnelApplicationConfig, .win32TunnelMutex, .win32TunnelServiceMutex)' product.json > product.json.tmp && mv product.json.tmp product.json

# AR03 · Hidden and Removed rows: Arkestra's workbench defaults, one source overlay.
cp -R ../arkestra-overlay/. ./
grep -q "contrib/arkestra/browser/arkestraDefaults.contribution.js" src/vs/workbench/workbench.common.main.ts || \
  printf "\n// Arkestra\nimport './contrib/arkestra/browser/arkestraDefaults.contribution.js';\n" >> src/vs/workbench/workbench.common.main.ts
grep -q "contrib/arkestra/browser/arkestraDefaults.contribution.js" src/vs/workbench/workbench.common.main.ts

if [[ -f resources/linux/debian/postinst.template ]]; then
  sed -i -E 's/\bcodium(-insiders)?\b/arkestra/' resources/linux/debian/postinst.template
fi

cd ..
