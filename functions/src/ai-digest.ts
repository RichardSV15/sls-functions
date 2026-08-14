// Condenses a service-request payload into a couple of lines the crew can act
// on from a phone, replacing the enumerated "Wants / Frequency / - item / - item
// / One-time / Landscape / Optional / Additional" block in the office SMS.
//
// Deliberately scoped to the *soft* part of the alert. Name, phone, address, the
// dashboard link and the card-special block stay deterministic upstream — those
// are what the crew dials and drives to, and a hallucinated digit there costs a
// real visit. The model only ever compresses what the customer asked for.

import Anthropic from '@anthropic-ai/sdk';

// Haiku is the right tier here: this runs inside a Firestore onCreate trigger
// while the office is waiting on a text, and the task is compression, not
// reasoning. Overridable if a request pattern ever needs more headroom.
const MODEL = process.env.SERVICE_REQUEST_DIGEST_MODEL || 'claude-haiku-4-5-20251001';

/** Hard ceiling on the digest so it can't eat the SMS segment budget. */
const MAX_DIGEST_CHARS = 320;

const SYSTEM_PROMPT = `You compress lawn-care service requests into a text message for the Suarez Lawn Services crew.

Write 1-3 short lines, under 300 characters total. No greeting, no sign-off, no preamble.

Always state, when present:
- the cadence in plain words (weekly, every 2 weeks, every 4 weeks, monthly, one-time)
- what services were actually requested
- how many photos the customer attached
- anything in the customer's notes that changes what the crew brings or does (gate codes, dogs, access, dead spots, specific problem areas, deadlines)

Rules:
- Plain ASCII only. No emoji, no em-dashes, no curly quotes, no bullet characters. Use a hyphen or comma.
- Never invent, infer, or reformat a phone number, address, price, or date.
- Drop pleasantries and filler from the customer's notes. Keep only what is operationally useful.
- If the notes contain nothing actionable, omit them entirely rather than padding.
- If a field is missing, say nothing about it. Do not write "not specified".`;

export interface ServiceRequestDigestInput {
    serviceType?: string;
    recurringFrequency?: string;
    recurringServices?: string[] | string;
    oneTimeServices?: string;
    landscapingServices?: string;
    optionalDetails?: string;
    additionalInfo?: string;
    photoCount?: number;
    hasPromoPhoto?: boolean;
}

/**
 * Returns the digest, or `null` if the model is unavailable or misbehaves.
 *
 * Null is a normal outcome, not an error: the caller falls back to the
 * deterministic line-by-line block. An alert that arrives verbose is fine; an
 * alert that never arrives because the summarizer was down is not.
 */
export async function summarizeServiceRequest(
    input: ServiceRequestDigestInput,
    apiKey: string | undefined
): Promise<string | null> {
    if (!apiKey) return null;

    const recurring = Array.isArray(input.recurringServices)
        ? input.recurringServices.filter(Boolean).join(', ')
        : String(input.recurringServices || '');

    const facts = [
        input.serviceType ? `Service type: ${input.serviceType}` : '',
        input.recurringFrequency ? `Frequency: ${input.recurringFrequency}` : '',
        recurring ? `Recurring services: ${recurring}` : '',
        input.oneTimeServices ? `One-time services: ${input.oneTimeServices}` : '',
        input.landscapingServices ? `Landscaping services: ${input.landscapingServices}` : '',
        input.photoCount ? `Customer attached ${input.photoCount} photo(s)` : '',
        input.hasPromoPhoto ? 'Customer attached the card/promo price photo' : '',
        input.optionalDetails ? `Customer notes: ${input.optionalDetails}` : '',
        input.additionalInfo ? `Additional info: ${input.additionalInfo}` : '',
    ].filter(Boolean).join('\n');

    if (!facts) return null;

    try {
        const client = new Anthropic({ apiKey, maxRetries: 1, timeout: 8000 });
        const response = await client.messages.create({
            model: MODEL,
            max_tokens: 200,
            temperature: 0,
            system: SYSTEM_PROMPT,
            messages: [{ role: 'user', content: facts }],
        });

        const digest = response.content
            .filter((block): block is Anthropic.TextBlock => block.type === 'text')
            .map((block) => block.text)
            .join('')
            .trim();

        if (!digest) return null;
        return digest.length > MAX_DIGEST_CHARS
            ? `${digest.slice(0, MAX_DIGEST_CHARS).trimEnd()}...`
            : digest;
    } catch (error) {
        console.error('Service-request digest failed, falling back to plain body:', error);
        return null;
    }
}
