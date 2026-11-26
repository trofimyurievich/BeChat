#!/usr/bin/env bash
set -euo pipefail
root=$(cd "$(dirname "$0")/.." && pwd)
out=${1:-"$root/build/ios"}
mkdir -p "$out"
out=$(cd "$out" && pwd)
stage=$(mktemp -d "$out/package.XXXXXX")
trap 'rm -rf -- "$stage"' EXIT
xcodebuild -project "$root/ios/BeChat.xcodeproj" -scheme BeChat -configuration Release \
  -sdk iphoneos -destination 'generic/platform=iOS' -derivedDataPath "$out/DerivedData" \
  CODE_SIGNING_ALLOWED=NO CODE_SIGNING_REQUIRED=NO CODE_SIGN_IDENTITY="" build
app="$out/DerivedData/Build/Products/Release-iphoneos/BeChat.app"
test -f "$app/BeChat" && test -f "$app/Assets.car"
/usr/libexec/PlistBuddy -c 'Print :CFBundleIdentifier' "$app/Info.plist" | grep -Fxq ru.onbequick.bechat
xcrun lipo -verify_arch arm64 "$app/BeChat"
xcrun vtool -show-build "$app/BeChat" > "$out/macho-platform.txt"
grep -Eq 'platform[[:space:]]+IOS$' "$out/macho-platform.txt"
mkdir "$stage/Payload"
ditto "$app" "$stage/Payload/BeChat.app"
(cd "$stage" && /usr/bin/zip -qry "$stage/BeChat.ipa" Payload)
mv "$stage/BeChat.ipa" "$out/BeChat.ipa"
/usr/bin/unzip -tq "$out/BeChat.ipa"
(cd "$out" && shasum -a 256 BeChat.ipa > ios-sha256.txt)

