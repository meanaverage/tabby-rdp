/**
 * A character that can change how the text around it reads without showing itself, in a name someone else chose (an
 * .rdp file's, see RemoteDesktopService.importRdp; an `ssh` destination a host reports, see RemoteTargets.nestedSSH;
 * what a server's certificate says of itself): control and format characters (bidi overrides and isolates, zero-width
 * ones, tags), the other default-ignorable ones (variation selectors, the combining grapheme joiner, Hangul fillers),
 * line and paragraph separators, private-use and unpaired surrogate code points, and blanks other than the space
 * (no-break and wide spaces, the braille blank).
 */
export const UNSHOWABLE = /[\p{Cc}\p{Cf}\p{Co}\p{Cs}\p{Zl}\p{Zp}\p{Default_Ignorable_Code_Point}⠀]|(?! )\p{Zs}/u

/**
 * A zero-width joiner or non-joiner between two letters of a script that writes words with them: Arabic (as Persian
 * does) and the Indic scripts. There it can change how the letters join, and so show; between letters of other scripts
 * (Latin, say) it shows nothing at all, and `ad\u200dmin` reads as `admin`.
 */
const WORD_JOINERS = new RegExp(['Arabic', 'Devanagari', 'Bengali', 'Gurmukhi', 'Gujarati', 'Oriya', 'Tamil', 'Telugu', 'Kannada', 'Malayalam', 'Sinhala']
    .map(script => `(?<=[\\p{L}\\p{M}])(?<=\\p{scx=${script}})[\\u200c\\u200d](?=[\\p{L}\\p{M}])(?=\\p{scx=${script}})`).join('|'), 'gu')

/** `text` without the joiners its scripts write words with (see WORD_JOINERS): what UNSHOWABLE then finds doesn't show. */
export function withoutWordJoiners (text: string): string {
    return text.replace(WORD_JOINERS, '')
}

/**
 * Text someone else chose, as it is shown and logged: what could reorder or hide part of it (UNSHOWABLE) as U+FFFD, and
 * at most `max` characters of it, an ellipsis saying where it was cut.
 */
export function showable (text: string, max = Infinity): string {
    const shown = text.replace(new RegExp(UNSHOWABLE.source, 'gu'), '�')
    if (shown.length <= max) {
        return shown
    }
    // Not between the two halves of a character outside the BMP, which would leave half of one.
    let end = Math.max(0, max - 1)
    if (end > 0 && /[\ud800-\udbff]/.test(shown[end - 1])) {
        end--
    }
    return `${shown.slice(0, end)}…`
}
