#!/usr/bin/env bash
# Runs inside the work copy right after VSCodium's prepare_vscode.sh, from the
# work root. Replaces the VSCodium names and links that prepare_vscode.sh
# writes as literals, and removes its update feed.
set -e
cd vscode

# AR33 · Updates come from Arkestra's own feed and releases, never VSCodium's.
jq '.updateUrl = "https://raw.githubusercontent.com/tenarkhq/Arkestra/refs/heads/versions" |
    .downloadUrl = "https://github.com/tenarkhq/Arkestra/releases"' product.json > product.json.tmp && mv product.json.tmp product.json
grep -q '"updateUrl": "https://raw.githubusercontent.com/tenarkhq/Arkestra/' product.json

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
  # Compiled only if it has sources; npm-installed only if it has dependencies
  # (a theme extension has neither).
  if [[ -f "extensions/${NAME}/tsconfig.json" ]]; then
    grep -q "'extensions/${NAME}/tsconfig.json'" build/gulpfile.extensions.ts || \
      sed -i "s#^\(\s*\)'extensions/merge-conflict/tsconfig.json',#&\n\1'extensions/${NAME}/tsconfig.json',#" build/gulpfile.extensions.ts
    grep -q "'extensions/${NAME}/tsconfig.json'" build/gulpfile.extensions.ts
  fi
  if [[ -f "extensions/${NAME}/package-lock.json" ]]; then
    grep -q "'extensions/${NAME}'," build/npm/dirs.ts || \
      sed -i "s#^\(\s*\)'extensions/merge-conflict',#&\n\1'extensions/${NAME}',#" build/npm/dirs.ts
    grep -q "'extensions/${NAME}'," build/npm/dirs.ts
    # VSCodium's npm ci ran before this step, so the extension installs its own.
    (cd "extensions/${NAME}" && npm ci --no-audit --no-fund)
  fi
done

# The built-in Copilot extension stays (VS Code's Agent Host, see skip-patches.txt).
# Microsoft's own build downloads it as a ready VSIX; the desktop build here compiles
# it from source, as VS Code's server build already does (gulpfile.reh.ts).
# Both the desktop prepack (what build.sh runs) and core-ci get it.
if ! perl -ne '$f=1 if /^\t\t\tcompileCopilotExtensionBuildTask,$/; END { exit !$f }' build/gulpfile.vscode.ts; then
  perl -0pi -e 's/(\n(\t+)compileNonNativeExtensionsBuildTask,\n)(\t+compileExtensionMediaBuildTask,)/$1$2compileCopilotExtensionBuildTask,\n$3/g' build/gulpfile.vscode.ts
fi
perl -ne '$f=1 if /^\t\t\tcompileCopilotExtensionBuildTask,$/; END { exit !$f }' build/gulpfile.vscode.ts

# build/.moduleignore strips @github/copilot from every node_modules, which is right for
# the app's own modules but takes the Copilot CLI SDK out of the extension. Its packaging
# adds the package back (the packing step then prunes the other platforms' binaries).
if ! grep -q "extensions/copilot/node_modules/@github/copilot/\*\*" build/lib/extensions.ts; then
  perl -0pi -e 's/(export function packageCopilotExtensionStream\(\)[\s\S]*?return es\.merge\(\n(\t+)localExtensionsStream,\n)/$1$2gulp.src(["extensions\/copilot\/node_modules\/\@github\/copilot\/**", "!extensions\/copilot\/node_modules\/\@github\/copilot\/**\/{test,tests}\/**"], { base: ".", dot: true, allowEmpty: true }),\n/' build/lib/extensions.ts
fi
grep -q "extensions/copilot/node_modules/@github/copilot/\*\*" build/lib/extensions.ts

# The Copilot CLI ships native modules for every platform (e.g. its clipboard module);
# the Windows version stamping (rcedit) can only open Windows binaries.
if ! grep -q "Arkestra: other platforms" build/gulpfile.vscode.ts; then
  perl -0pi -e "s#glob\('\*\*/\*\.node', \{ cwd, ignore: 'extensions/node_modules/\@parcel/watcher/\*\*' \}\)#glob('**/*.node', { cwd, ignore: ['extensions/node_modules/\@parcel/watcher/**', '**/*.{darwin,linux,linuxmusl}-*.node', '**/{darwin,linux,linuxmusl}-*/**/*.node'] /* Arkestra: other platforms */ })#" build/gulpfile.vscode.ts
fi
grep -q "Arkestra: other platforms" build/gulpfile.vscode.ts

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
# The Windows installer step still needs the names (it stops a tunnel process if one runs);
# it gets them here, the app does not.
perl -pi -e "s#TunnelMutex: product\.win32TunnelMutex,#TunnelMutex: product.win32TunnelMutex ?? 'arkestra-tunnel',#; s#TunnelServiceMutex: product\.win32TunnelServiceMutex,#TunnelServiceMutex: product.win32TunnelServiceMutex ?? 'arkestra-tunnelservice',#; s#TunnelApplicationName: product\.tunnelApplicationName,#TunnelApplicationName: product.tunnelApplicationName ?? 'arkestra-tunnel',#" build/gulpfile.vscode.win32.ts
[[ "$( grep -c "?? 'arkestra-tunnel" build/gulpfile.vscode.win32.ts )" == 3 ]]

# AR04 · Nothing goes to Microsoft services on its own.
#   - Copilot account endpoints: with any GitHub sign-in the default-account service
#     would query them in the background; empty URLs make it skip every call.
#   - Voice chat streams to a Microsoft endpoint: removed.
#   - Help links point to Arkestra or go; badge images from Microsoft hosts are not loaded.
jq '
  .defaultChatAgent.entitlementUrl = "" | .defaultChatAgent.tokenEntitlementUrl = "" |
  .defaultChatAgent.managedSettingsUrl = "" | .defaultChatAgent.mcpRegistryDataUrl = "" |
  del(.voiceWsUrl, .keyboardShortcutsUrlLinux, .keyboardShortcutsUrlMac, .keyboardShortcutsUrlWin,
      .introductoryVideosUrl, .tipsAndTricksUrl, .twitterUrl, .checksumFailMoreInfoUrl, .releaseNotesUrl) |
  .documentationUrl = "https://github.com/tenarkhq/Arkestra#readme" |
  .requestFeatureUrl = "https://github.com/tenarkhq/Arkestra/issues" |
  .extensionAllowedBadgeProviders |= map(select(test("(^|\\.)(visualstudio\\.com|azure\\.com|microsoft\\.com)$") | not))
' product.json > product.json.tmp && mv product.json.tmp product.json

# AR04 · The sign-in success page loads Segoe UI from a Microsoft CDN in the browser;
# it keeps only the locally installed fonts.
perl -0pi -e 's/,?url\("https:\/\/c\.s-microsoft\.com[^"]*"\)(\s*format\("[^"]*"\))?//g' src/vs/workbench/api/node/loopbackServer.ts
if grep -q "s-microsoft" src/vs/workbench/api/node/loopbackServer.ts; then
  echo "after-prepare: Microsoft font URLs left in loopbackServer.ts" >&2
  exit 1
fi

# AR03 · Hidden and Removed rows: Arkestra's workbench defaults, one source overlay.
cp -R ../arkestra-overlay/. ./
grep -q "contrib/arkestra/browser/arkestraDefaults.contribution.js" src/vs/workbench/workbench.common.main.ts || \
  printf "\n// Arkestra\nimport './contrib/arkestra/browser/arkestraDefaults.contribution.js';\n" >> src/vs/workbench/workbench.common.main.ts
grep -q "contrib/arkestra/browser/arkestraDefaults.contribution.js" src/vs/workbench/workbench.common.main.ts

if [[ -f resources/linux/debian/postinst.template ]]; then
  sed -i -E 's/\bcodium(-insiders)?\b/arkestra/' resources/linux/debian/postinst.template
fi

cd ..
