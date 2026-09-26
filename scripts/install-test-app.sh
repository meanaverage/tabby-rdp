#!/bin/sh
# macOS: installs "Tabby Test.app" in ~/Applications (Spotlight, Launchpad, Dock). It opens a separate Tabby with
# this plugin linked in (scripts/sandbox.sh) next to your normal one, with its settings in a permanent folder
# (default ~/.tabby-rdp-test). Rerun after moving the repository. Usage: scripts/install-test-app.sh [settings-folder]
set -eu
REPO="$(cd "$(dirname "$0")/.." && pwd)"
DIR="${1:-$HOME/.tabby-rdp-test}"
APP="$HOME/Applications/Tabby Test.app"
ICON_SRC=/Applications/Tabby.app/Contents/Resources/icon.icns
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

# Icon: Tabby's, with an orange TEST badge.
cat > "$WORK/badge.swift" <<'SWIFT'
import AppKit
let args = CommandLine.arguments
guard let base = NSImage(contentsOfFile: args[1]) else { fatalError("cannot read \(args[1])") }
let outDir = args[2]
for (name, px) in [("16x16", 16), ("16x16@2x", 32), ("32x32", 32), ("32x32@2x", 64), ("128x128", 128),
                   ("128x128@2x", 256), ("256x256", 256), ("256x256@2x", 512), ("512x512", 512), ("512x512@2x", 1024)] {
    let s = CGFloat(px)
    let rep = NSBitmapImageRep(bitmapDataPlanes: nil, pixelsWide: px, pixelsHigh: px, bitsPerSample: 8,
                               samplesPerPixel: 4, hasAlpha: true, isPlanar: false, colorSpaceName: .deviceRGB,
                               bytesPerRow: 0, bitsPerPixel: 0)!
    NSGraphicsContext.saveGraphicsState()
    NSGraphicsContext.current = NSGraphicsContext(bitmapImageRep: rep)
    base.draw(in: NSRect(x: 0, y: 0, width: s, height: s))
    if px >= 32 {  // too small to read below that; the name tells them apart
        let badge = NSRect(x: s * 0.14, y: s * 0.10, width: s * 0.72, height: s * 0.24)
        NSColor(calibratedRed: 1.0, green: 0.55, blue: 0.10, alpha: 1).setFill()
        NSBezierPath(roundedRect: badge, xRadius: s * 0.06, yRadius: s * 0.06).fill()
        let attrs: [NSAttributedString.Key: Any] = [
            .font: NSFont.systemFont(ofSize: s * 0.15, weight: .heavy),
            .foregroundColor: NSColor.white,
        ]
        let text = NSAttributedString(string: "TEST", attributes: attrs)
        let size = text.size()
        text.draw(at: NSPoint(x: badge.midX - size.width / 2, y: badge.midY - size.height / 2))
    }
    NSGraphicsContext.restoreGraphicsState()
    try! rep.representation(using: .png, properties: [:])!.write(to: URL(fileURLWithPath: "\(outDir)/icon_\(name).png"))
}
SWIFT
mkdir -p "$WORK/TabbyTest.iconset"
swift "$WORK/badge.swift" "$ICON_SRC" "$WORK/TabbyTest.iconset"
iconutil -c icns "$WORK/TabbyTest.iconset" -o "$WORK/TabbyTest.icns"

# Bundle
rm -rf "$APP"
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources"
cp "$WORK/TabbyTest.icns" "$APP/Contents/Resources/TabbyTest.icns"
cat > "$APP/Contents/Info.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>CFBundleName</key><string>Tabby Test</string>
    <key>CFBundleDisplayName</key><string>Tabby Test</string>
    <key>CFBundleIdentifier</key><string>dev.tabby-rdp.test-launcher</string>
    <key>CFBundleExecutable</key><string>tabby-test</string>
    <key>CFBundleIconFile</key><string>TabbyTest</string>
    <key>CFBundlePackageType</key><string>APPL</string>
    <key>CFBundleShortVersionString</key><string>1.0</string>
    <key>LSUIElement</key><true/>
</dict>
</plist>
PLIST
cat > "$APP/Contents/MacOS/tabby-test" <<LAUNCHER
#!/bin/sh
# Opens the Tabby test copy: plugin from $REPO, settings in $DIR.
# If it is already running, Tabby's single-instance lock just brings it to the front.
mkdir -p "$DIR"
nohup "$REPO/scripts/sandbox.sh" "$DIR" >> "$DIR/launcher.log" 2>&1 &
LAUNCHER
chmod 755 "$APP/Contents/MacOS/tabby-test"
codesign --force --sign - "$APP" >/dev/null 2>&1 || true

/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister -f "$APP"
mdimport "$APP" 2>/dev/null || true
echo "Installed $APP (test copy settings: $DIR)"
