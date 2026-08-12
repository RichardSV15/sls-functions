// GSM-7 sanitizing + segment-aware capping for outbound SMS.
//
// Twilio 30019 ("content size exceeds carrier limit") bit us twice — 2026-06-10
// and 2026-08-11. Both times the body was under the 1,000-char cap, so length
// was never the real problem. A single character outside the GSM 03.38 alphabet
// forces the WHOLE message into UCS-2, where a concatenated segment holds 67
// characters instead of 153. The same 1,000-char body is 7 segments in GSM-7 and
// 15 in UCS-2, and carriers start rejecting well before 15.
//
// The characters that did it were our own: the `…` appended by the truncation
// helper and the em-dashes/middle-dots in the card-special lines. The guard
// meant to prevent oversized messages was itself forcing the expensive encoding.

/** GSM 03.38 basic set — one septet each. */
const GSM7_BASIC = new Set(
    ('@£$¥èéùìòÇ\nØø\rÅåΔ_ΦΓΛΩΠΨΣΘΞÆæßÉ !"#¤%&\'()*+,-./0123456789:;<=>?' +
        '¡ABCDEFGHIJKLMNOPQRSTUVWXYZÄÖÑÜ§¿abcdefghijklmnopqrstuvwxyzäöñüà').split('')
);

/** GSM 03.38 extension set — two septets each (escape + char). */
const GSM7_EXTENDED = new Set(['^', '{', '}', '\\', '[', '~', ']', '|', '€']);

/**
 * Unicode we actually emit (or that customers paste) mapped to GSM-safe
 * equivalents. Anything not listed and not in the GSM sets gets dropped, so
 * this map only needs to cover characters whose meaning we care about keeping.
 */
const TRANSLITERATIONS: Record<string, string> = {
    '\u2026': '...',                                    // …
    '\u2014': '-', '\u2013': '-', '\u2012': '-', '\u2015': '-', '\u2212': '-',
    '\u2018': "'", '\u2019': "'", '\u201A': "'", '\u201B': "'", '\u2032': "'",
    '\u201C': '"', '\u201D': '"', '\u201E': '"', '\u2033': '"',
    '\u00B7': '-', '\u2022': '-', '\u25CF': '-', '\u25AA': '-', '\u00B0': ' deg',
    '\u2192': '->', '\u2190': '<-', '\u21D2': '=>',
    '\u2264': '<=', '\u2265': '>=', '\u2260': '!=', '\u00D7': 'x', '\u00F7': '/',
    '\u00A0': ' ', '\u2007': ' ', '\u202F': ' ', '\u200B': '', '\uFEFF': '',
    '\u2122': 'TM', '\u00AE': '(R)', '\u00A9': '(C)', '\u2013\u2013': '--',
    '\u2611': '[x]', '\u2610': '[ ]', '\u2713': 'y', '\u2714': 'y', '\u2717': 'n',
    '\u00BD': '1/2', '\u00BC': '1/4', '\u00BE': '3/4',
};

/**
 * Force `text` into the GSM 03.38 alphabet so Twilio never escalates to UCS-2.
 *
 * Accented Latin that GSM already covers (é, ñ, ü, à …) is preserved — Spanish
 * customer names and notes survive intact. Everything else is transliterated
 * where we have a sensible equivalent, stripped where we don't. Emoji vanish.
 */
export function sanitizeForGsm7(text: string): string {
    // NFC first so "e + combining acute" becomes the single é that GSM allows.
    const normalized = String(text ?? '').normalize('NFC');

    let out = '';
    for (const char of normalized) {
        if (GSM7_BASIC.has(char) || GSM7_EXTENDED.has(char)) {
            out += char;
            continue;
        }
        const replacement = TRANSLITERATIONS[char];
        if (replacement !== undefined) {
            out += replacement;
            continue;
        }
        // Last resort: strip accents and keep the base letter if GSM allows it.
        const stripped = char.normalize('NFD').replace(/[\u0300-\u036f]/g, '');
        if (stripped.length === 1 && GSM7_BASIC.has(stripped)) out += stripped;
    }
    return out;
}

/** Septet cost of an already-sanitized string (extension chars cost two). */
export function gsm7Length(text: string): number {
    let total = 0;
    for (const char of text) total += GSM7_EXTENDED.has(char) ? 2 : 1;
    return total;
}

/** Septets per segment once a message splits (UDH eats 7 of the 160). */
const SEPTETS_PER_CONCAT_SEGMENT = 153;

/** Segment count Twilio will bill and the carrier will reassemble. */
export function gsm7SegmentCount(text: string): number {
    const length = gsm7Length(text);
    if (length <= 160) return 1;
    return Math.ceil(length / SEPTETS_PER_CONCAT_SEGMENT);
}

/**
 * Sanitize, then hard-cap to `maxSegments` concatenated segments.
 *
 * Six segments is deliberately conservative: comfortably under every US carrier
 * cap we've seen, and the service-request body puts the dashboard link near the
 * top precisely so it survives this cut.
 */
export function prepareSmsBody(text: string, maxSegments = 6): string {
    const sanitized = sanitizeForGsm7(text);
    const budget = maxSegments * SEPTETS_PER_CONCAT_SEGMENT;
    if (gsm7Length(sanitized) <= budget) return sanitized;

    const suffix = '...';
    let out = '';
    let used = 0;
    for (const char of sanitized) {
        const cost = GSM7_EXTENDED.has(char) ? 2 : 1;
        if (used + cost > budget - suffix.length) break;
        out += char;
        used += cost;
    }
    return `${out.trimEnd()}${suffix}`;
}
