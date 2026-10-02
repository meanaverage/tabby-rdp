// A window flipping between two known colors, and checks of the remote display against them: the picture checks of
// the graphics and windows suites (H.264 or not, the colors must come out right).
import type { TestContext } from './harness.js'

/** The two colors, as sRGB. */
export const FLIP_COLORS: [number, number, number][] = [[0x1e, 0x64, 0xc8], [0xf0, 0xc8, 0x28]]

const hex = ([r, g, b]: [number, number, number]) => '#' + [r, g, b].map(v => v.toString(16).padStart(2, '0')).join('')

/** GNOME: a full-screen GTK window flipping every 100 ms for `seconds` (python3 with GTK 3, as GNOME has). */
export const GNOME_FLIP = `
import sys, gi
gi.require_version('Gtk', '3.0')
from gi.repository import Gtk, Gdk, GLib
colors, state = ${JSON.stringify(FLIP_COLORS.map(hex))}, [0]
css = Gtk.CssProvider()
def flip():
    state[0] ^= 1
    css.load_from_data(('window { background: %s; }' % colors[state[0]]).encode())
    return True
Gtk.StyleContext.add_provider_for_screen(Gdk.Screen.get_default(), css, Gtk.STYLE_PROVIDER_PRIORITY_USER)
w = Gtk.Window(title='trd-flip')
w.fullscreen()
w.connect('destroy', Gtk.main_quit)
flip()
w.show_all()
GLib.timeout_add(100, flip)
GLib.timeout_add_seconds(int(sys.argv[1]), Gtk.main_quit)
Gtk.main()
`

/**
 * Windows: a maximized, borderless, topmost form flipping every half second for `seconds` (PowerShell in the
 * session), its top 40% moving noise. Windows sends flat colors with its lossless codecs; the noise is what it takes
 * for video and streams as H.264, after about five seconds of it (and not while the whole window keeps changing
 * faster than that). The middle stays flat for sampling.
 */
export const windowsFlip = (seconds: number): string => `
Add-Type -AssemblyName System.Windows.Forms, System.Drawing
$f = New-Object Windows.Forms.Form
$f.FormBorderStyle = 'None'; $f.WindowState = 'Maximized'; $f.TopMost = $true
$colors = @(${FLIP_COLORS.map(([r, g, b]) => `[Drawing.Color]::FromArgb(${r}, ${g}, ${b})`).join(', ')})
$script:i = 0
$f.BackColor = $colors[0]
$p = New-Object Windows.Forms.PictureBox
$p.Dock = 'Top'; $p.SizeMode = 'StretchImage'
$f.Controls.Add($p)
$f.Add_Shown({ $p.Height = [int]($f.ClientSize.Height * 0.4) })
$w = 256; $h = 24; $r = New-Object Random; $b = New-Object byte[] ($w * $h * 4)
$t = New-Object Windows.Forms.Timer; $t.Interval = 33
$t.Add_Tick({
    $script:n = ($script:n + 1) % 15
    if ($script:n -eq 0) { $script:i = 1 - $script:i; $f.BackColor = $colors[$script:i] }
    $r.NextBytes($b)
    $m = New-Object Drawing.Bitmap $w, $h, ([Drawing.Imaging.PixelFormat]::Format32bppRgb)
    $d = $m.LockBits((New-Object Drawing.Rectangle 0, 0, $w, $h), 'WriteOnly', $m.PixelFormat)
    [Runtime.InteropServices.Marshal]::Copy($b, 0, $d.Scan0, $b.Length); $m.UnlockBits($d)
    $o = $p.Image; $p.Image = $m; if ($o) { $o.Dispose() }
}); $t.Start()
$s = New-Object Windows.Forms.Timer; $s.Interval = ${seconds * 1000}
$s.Add_Tick({ $f.Close() }); $s.Start()
[Windows.Forms.Application]::Run($f)`

/**
 * Samples the middle of the remote display `count` times: each sample must be one of the two colors (within a
 * tolerance that H.264 and the other codecs keep to on flat colors, and that a wrong color range or matrix would
 * not), and both must show up. Returns { ok, seen: [a, b], wrong: [samples that were neither] }.
 */
export interface FlipSample {
    /** Whether both colors showed up and few enough samples were neither. */
    ok: boolean
    /** How many samples were each color. */
    seen: [number, number]
    /** The samples that were neither (a pixel caught mid-update, or a wrong color). */
    wrong: (number[] | null)[]
}

export async function sampleFlip (t: TestContext, pane: string, count = 24): Promise<FlipSample> {
    const seen: [number, number] = [0, 0]
    const wrong: (number[] | null)[] = []
    for (let i = 0; i < count; i++) {
        const px = await t.ev<number[] | null>(`const cv = H.canvasElement(${pane}); if (!cv?.width) return null
            return [...cv.getContext('2d').getImageData(Math.floor(cv.width / 2), Math.floor(cv.height / 2), 1, 1).data].slice(0, 3)`)
        const match = px ? FLIP_COLORS.findIndex(c => c.every((v, k) => Math.abs(v - px[k]) <= 12)) : -1
        if (match >= 0) {
            seen[match]++
        } else {
            wrong.push(px)
        }
        await t.sleep(130)
    }
    // A sample can catch a frame on its way in (the canvas mid-update), so allow the odd one.
    return { ok: seen[0] > 0 && seen[1] > 0 && wrong.length <= 2, seen, wrong }
}
