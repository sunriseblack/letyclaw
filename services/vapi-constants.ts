// Current DeepgramTranscriber.language enum from Vapi's live API schema.
export const VAPI_DEEPGRAM_LANGUAGES: ReadonlySet<string> = new Set([
  "ar", "az", "ba", "be", "bg", "bn", "br", "bs", "ca", "cs", "da", "da-DK",
  "de", "de-CH", "el", "en", "en-AU", "en-CA", "en-GB", "en-IE", "en-IN",
  "en-NZ", "en-US", "es", "es-419", "es-LATAM", "et", "eu", "fa", "fi", "fr",
  "fr-CA", "ha", "haw", "he", "hi", "hi-Latn", "hr", "hu", "id", "is", "it",
  "ja", "jw", "kn", "ko", "ko-KR", "ln", "lt", "lv", "mk", "mr", "ms", "multi",
  "nl", "nl-BE", "no", "pl", "pt", "pt-BR", "pt-PT", "ro", "ru", "sk", "sl",
  "sn", "so", "sr", "su", "sv", "sv-SE", "ta", "taq", "te", "th", "th-TH", "tl",
  "tr", "tt", "uk", "ur", "vi", "yo", "zh", "zh-CN", "zh-HK", "zh-Hans",
  "zh-Hant", "zh-TW",
]);

const DECEPTIVE_VOICE_IDENTITY_PATTERNS: readonly RegExp[] = [
  /(?:say|claim|tell (?:them|the person)|pretend|act as if).{0,60}(?:i am|you are|you're|im)\s+(?:a\s+)?(?:human|real person)/i,
  /(?:do not|don't|never)\s+(?:say|mention|reveal|disclose).{0,40}(?:ai|automated|assistant|bot)/i,
  /(?:not|isn't|aren't)\s+(?:an?\s+)?(?:ai|automated assistant|bot|robot)/i,
  /(?:you are|you're|identify yourself as|introduce yourself as)\s+(?:a\s+)?(?:human|real person)/i,
  /(?:hide|conceal).{0,40}(?:ai|automated|assistant|bot|robot)/i,
];

export function requestsDeceptiveVoiceIdentity(text: string): boolean {
  return DECEPTIVE_VOICE_IDENTITY_PATTERNS.some((pattern) => pattern.test(text));
}

export function requestsRepresentedPersonImpersonation(text: string, personName: string): boolean {
  const escapedName = personName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(
    `(?:pretend to be|introduce yourself as|claim (?:that )?(?:you are|you're)|say (?:that )?(?:you are|you're)|this is|i am|i'm)\\s+${escapedName}\\b`,
    "i",
  ).test(text);
}
