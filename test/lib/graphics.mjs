// A window flipping between two known colors, and checks of the remote display against them: the picture checks of
// the graphics and windows suites (H.264 or not, the colors must come out right).

/** The two colors, as sRGB. */
export const FLIP_COLORS = [[0x1e, 0x64, 0xc8], [0xf0, 0xc8, 0x28]]

const hex = ([r, g, b]) => '#' + [r, g, b].map(v => v.toString(16).padStart(2, '0')).join('')

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

/** Windows: a maximized, borderless, topmost form flipping every 100 ms for `seconds` (PowerShell in the session). */
export const windowsFlip = seconds => `
Add-Type -AssemblyName System.Windows.Forms
$f = New-Object Windows.Forms.Form
$f.FormBorderStyle = 'None'; $f.WindowState = 'Maximized'; $f.TopMost = $true
$colors = @(${FLIP_COLORS.map(([r, g, b]) => `[Drawing.Color]::FromArgb(${r}, ${g}, ${b})`).join(', ')})
$script:i = 0
$f.BackColor = $colors[0]
$t = New-Object Windows.Forms.Timer; $t.Interval = 100
$t.Add_Tick({ $script:i = 1 - $script:i; $f.BackColor = $colors[$script:i] }); $t.Start()
$s = New-Object Windows.Forms.Timer; $s.Interval = ${seconds * 1000}
$s.Add_Tick({ $f.Close() }); $s.Start()
[Windows.Forms.Application]::Run($f)`

/**
 * Samples the middle of the remote display `count` times: each sample must be one of the two colors (within a
 * tolerance that H.264 and the other codecs keep to on flat colors, and that a wrong color range or matrix would
 * not), and both must show up. Returns { ok, seen: [a, b], wrong: [samples that were neither] }.
 */
export async function sampleFlip (t, pane, count = 24) {
    const seen = [0, 0]
    const wrong = []
    for (let i = 0; i < count; i++) {
        const px = await t.ev(`const cv = H.canvasElement(${pane}); if (!cv?.width) return null
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
