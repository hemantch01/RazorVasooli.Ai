/**
 * RazorVasooli.Ai — Hinglish Voice & Reply Understanding Service
 *
 * Capabilities:
 *  1. Natural Hinglish Dunning Voice Script Generator
 *  2. Direct Gemini 2.0 Audio Generation (Gemini Speech Modality)
 *  3. Hinglish Customer Reply Understanding & Intent Extraction
 *  4. Fallback Audio Synthesizer (Zero-dependency PCM/WAV generator)
 */

export interface VoiceCallContext {
  invoiceId: string;
  customerName: string;
  amount: number;
  declineCode: string;
  paymentLink?: string;
  discountPercent?: number;
  channel?: string;
}

export interface VoiceGenerationResult {
  script: string;
  englishTranslation: string;
  audioBase64?: string;
  mimeType: string;
  provider: "gemini_direct_audio" | "synthetic_wav" | "browser_tts";
  intent?: string;
  suggestedAction: string;
}

export interface HinglishParseResult {
  originalMessage: string;
  intent: "promise" | "optout" | "discount_request" | "paid" | "dispute" | "question";
  confidence: number;
  promisedDate?: string;
  promisedAmount?: number;
  sentiment: "cooperative" | "neutral" | "frustrated" | "hostile";
  extractedDetails: {
    daysMentioned?: number;
    salaryContext?: boolean;
    optOutRequested?: boolean;
    discountInquired?: boolean;
  };
  recommendedAction: string;
}

// 1. Natural Hinglish Dunning Voice Script Generator

export function generateHinglishVoiceScript(ctx: VoiceCallContext): { script: string; englishTranslation: string } {
  const name = ctx.customerName.replace(/\*+/g, "").trim() || "Customer";
  const amountFormatted = `₹${ctx.amount.toLocaleString("en-IN")}`;
  const discount = ctx.discountPercent || 5;
  const discountedAmount = `₹${Math.round(ctx.amount * (1 - discount / 100)).toLocaleString("en-IN")}`;

  switch (ctx.declineCode) {
    case "INSUFFICIENT_FUNDS":
      return {
        script: `Namaste ${name} ji! Main TechCorp se RazorVasooli AI bol raha hoon. Aapka ${amountFormatted} ka subscription payment balance issue ki wajah se complete nahi ho paya. Kya main aapke WhatsApp par instant UPI link bhej doon? Aur humne aapke liye ${discount}% loyalty discount bhi lagaya hai, toh naya amount sirf ${discountedAmount} hai.`,
        englishTranslation: `Hello ${name}! This is RazorVasooli AI from TechCorp. Your subscription payment of ${amountFormatted} could not be completed due to balance. Shall I send an instant UPI link to your WhatsApp? We also applied a ${discount}% discount, so the new amount is only ${discountedAmount}.`,
      };

    case "BAD_REQUEST_PAYMENT_TIMED_OUT":
    case "NETWORK_ERROR":
      return {
        script: `Hello ${name} ji! RazorVasooli team se update hai. Aapka ${amountFormatted} ka payment technical timeout ki wajah se atak gaya tha. Aapke account se koi extra deduction nahi hua hai. Kya main 1-click retry UPI link message kar doon?`,
        englishTranslation: `Hello ${name}! Update from RazorVasooli team. Your payment of ${amountFormatted} timed out due to a technical glitch. No extra deduction happened. May I message you a 1-click retry UPI link?`,
      };

    case "CARD_EXPIRED":
      return {
        script: `Namaste ${name} ji! Lagta hai aapka card expiry date cross kar gaya hai. Subscription ko uninterrupted chalane ke liye kya aap naya payment method ya UPI update karna chahenge? Main instant link send kar raha hoon.`,
        englishTranslation: `Hello ${name}! Looks like your registered card has expired. To keep your subscription active without interruption, would you like to update to a new card or UPI? Sending you the link.`,
      };

    case "BANK_DECLINED":
    case "AUTHENTICATION_FAILED":
      return {
        script: `Namaste ${name} ji! Bank security check ya OTP issue ki wajah se ${amountFormatted} ka transaction decline hua tha. Aap chahein toh instant QR code ya UPI app ke through 1 minute me complete kar sakte hain.`,
        englishTranslation: `Hello ${name}! The transaction of ${amountFormatted} was declined due to bank security or OTP issue. If you prefer, you can complete it in 1 minute via instant UPI QR code.`,
      };

    default:
      return {
        script: `Namaste ${name} ji! TechCorp se RazorVasooli assistance call hai. Aapka recent invoice of ${amountFormatted} pending hai. Humne aapke liye instant recovery link prepare kiya hai with ${discount}% discount. Kya main link share kar doon?`,
        englishTranslation: `Hello ${name}! RazorVasooli assistance call from TechCorp. Your invoice of ${amountFormatted} is pending. We have prepared an instant payment link with ${discount}% discount. Shall I share the link?`,
      };
  }
}

// 2. Direct Gemini TTS Voice Audio Generation
//    (uses the dedicated gemini-2.5-flash-preview-tts model — standard
//     gemini-*-flash chat models cannot emit audio)

/** Wrap raw 16-bit PCM samples in a RIFF/WAV header so browsers can play it. */
function pcmToWavBase64(pcm: Buffer, sampleRate = 24000, channels = 1, bitsPerSample = 16): string {
  const byteRate = (sampleRate * channels * bitsPerSample) / 8;
  const blockAlign = (channels * bitsPerSample) / 8;
  const header = Buffer.alloc(44);
  header.write("RIFF", 0);
  header.writeUInt32LE(36 + pcm.length, 4);
  header.write("WAVE", 8);
  header.write("fmt ", 12);
  header.writeUInt32LE(16, 16); // fmt chunk size
  header.writeUInt16LE(1, 20); // PCM format
  header.writeUInt16LE(channels, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(byteRate, 28);
  header.writeUInt16LE(blockAlign, 32);
  header.writeUInt16LE(bitsPerSample, 34);
  header.write("data", 36);
  header.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([header, pcm]).toString("base64");
}

export async function generateGeminiVoiceResponse(
  ctx: VoiceCallContext,
  geminiApiKey?: string
): Promise<VoiceGenerationResult> {
  const { script, englishTranslation } = generateHinglishVoiceScript(ctx);
  const apiKey = geminiApiKey || process.env.GEMINI_API_KEY;
  const ttsModels = [
    "gemini-3.1-flash-tts-preview",
    "gemini-2.5-flash-preview-tts",
    "gemini-2.5-flash-lite-preview-tts",
    "gemini-2.5-pro-preview-tts",
  ];

  if (apiKey && !apiKey.includes("mock") && !apiKey.includes("YourKey")) {
    for (const model of ttsModels) {
      try {
        const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;

        const payload = {
          contents: [
            {
              parts: [
                {
                  text: `Speak this as a polite, empathetic Indian revenue recovery voice agent named RazorVasooli, with a warm, professional, respectful tone in natural Hinglish:\n\n"${script}"`,
                },
              ],
            },
          ],
          generationConfig: {
            responseModalities: ["AUDIO"],
            speechConfig: {
              voiceConfig: {
                prebuiltVoiceConfig: {
                  voiceName: "Aoede", // Conversational, warm voice
                },
              },
            },
          },
        };

        const res = await fetch(endpoint, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload),
        });

        if (res.ok) {
          const data = (await res.json()) as any;
          const candidate = data.candidates?.[0];
          const parts = candidate?.content?.parts || [];

          // Check if inline audio data was returned
          const audioPart = parts.find((p: any) => p.inlineData && p.inlineData.mimeType?.startsWith("audio/"));
          if (audioPart) {
            const mimeType: string = audioPart.inlineData.mimeType || "audio/wav";
            let audioBase64: string = audioPart.inlineData.data;

            if (/L16|pcm/i.test(mimeType)) {
              const rateMatch = mimeType.match(/rate=(\d+)/i);
              const sampleRate = rateMatch ? parseInt(rateMatch[1], 10) : 24000;
              audioBase64 = pcmToWavBase64(Buffer.from(audioPart.inlineData.data, "base64"), sampleRate);
            }

            return {
              script,
              englishTranslation,
              audioBase64,
              mimeType: "audio/wav",
              provider: "gemini_direct_audio",
              suggestedAction: "Sent Hinglish voice recovery call via Gemini Audio Modality",
            };
          }
        } else {
          console.warn(`[Voice] Model ${model} TTS non-200: ${res.status}`);
        }
      } catch (err: any) {
        console.warn(`[Voice] Model ${model} TTS failed:`, err?.message || err);
      }
    }
  }

  // Fallback: Generate clean synthetic audio tone or browser TTS signal
  const wavBase64 = generateSyntheticBeepWav();

  return {
    script,
    englishTranslation,
    audioBase64: wavBase64,
    mimeType: "audio/wav",
    provider: "synthetic_wav",
    suggestedAction: "Generated Hinglish script for Web Speech API / browser voice synthesis",
  };
}

// 3. Hinglish Customer Reply Understanding & Intent Extraction (Task 6.3)

export function parseHinglishReply(message: string): HinglishParseResult {
  const normalized = message.toLowerCase().trim();

  // Pattern 1: Opt-Out / Stop messages (DPDP regulatory compliance)
  const optOutPatterns = [
    /band karo/,
    /mat karo/,
    /pareshaan mat/,
    /stop/,
    /unsubscribe/,
    /cancel/,
    /don't call/,
    /call mat karo/,
    /message mat bhejo/,
    /nahi chahiye/,
  ];
  if (optOutPatterns.some((p) => p.test(normalized))) {
    return {
      originalMessage: message,
      intent: "optout",
      confidence: 0.95,
      sentiment: "hostile",
      extractedDetails: { optOutRequested: true },
      recommendedAction: "Trigger immediate DPDP Opt-Out compliance hard-stop (SKIPPED_COMPLIANCE)",
    };
  }

  // Pattern 2: Payment Promise (Payday / Date-specific with explicit keywords)
  const promiseDateMatch = normalized.match(/\b([1-9]|[12]\d|3[01])\s*(?:tarikh|tareekh|th|st|nd|rd)\b/);
  const salaryMatch = /\b(salary|tankhwa|tankha|paise aane do|salary aane do|payday)\b/.test(normalized);
  const tomorrowMatch = /\b(kal|tomorrow|agle hafte|next week|agle mahine)\b/.test(normalized);
  const explicitPromisePhrase = /\b(pakka de dunga|pay kar dunga|payment kar dunga|kar dunga|pay karunga|bhej dunga)\b/.test(normalized);

  if (salaryMatch || (promiseDateMatch && explicitPromisePhrase) || (tomorrowMatch && explicitPromisePhrase)) {
    let promisedDate: string | undefined;
    const now = new Date();

    if (promiseDateMatch && parseInt(promiseDateMatch[1], 10) <= 31) {
      const day = parseInt(promiseDateMatch[1], 10);
      const targetMonth = day < now.getDate() ? now.getMonth() + 1 : now.getMonth();
      const targetYear = now.getFullYear();
      promisedDate = new Date(targetYear, targetMonth, day).toISOString().split("T")[0];
    } else if (tomorrowMatch) {
      const target = new Date(now.getTime() + 24 * 3600000);
      promisedDate = target.toISOString().split("T")[0];
    } else if (salaryMatch) {
      // Default Indian payday window: 5th of next month
      const targetMonth = now.getDate() > 5 ? now.getMonth() + 1 : now.getMonth();
      promisedDate = new Date(now.getFullYear(), targetMonth, 5).toISOString().split("T")[0];
    }

    return {
      originalMessage: message,
      intent: "promise",
      confidence: 0.92,
      promisedDate,
      sentiment: "cooperative",
      extractedDetails: {
        salaryContext: salaryMatch,
        daysMentioned: promiseDateMatch ? parseInt(promiseDateMatch[1], 10) : undefined,
      },
      recommendedAction: `Pause active dunning sequence $\\to$ schedule Promise Sweeper for ${promisedDate || "next payday"}`,
    };
  }

  // Pattern 3: Discount / Offer Request
  if (
    normalized.includes("discount") ||
    normalized.includes("offer") ||
    normalized.includes("kam karo") ||
    normalized.includes("kam ho sakta") ||
    normalized.includes("thoda kam")
  ) {
    return {
      originalMessage: message,
      intent: "discount_request",
      confidence: 0.88,
      sentiment: "cooperative",
      extractedDetails: { discountInquired: true },
      recommendedAction: "Apply 10% progressive retention discount $\\to$ send new Razorpay payment link",
    };
  }

  // Pattern 4: Already Paid Claim
  if (
    normalized.includes("already paid") ||
    normalized.includes("pay kar diya") ||
    normalized.includes("de diya") ||
    normalized.includes("paise kat gaye")
  ) {
    return {
      originalMessage: message,
      intent: "paid",
      confidence: 0.85,
      sentiment: "neutral",
      extractedDetails: {},
      recommendedAction: "Trigger instant Razorpay payment reconciliation check via payment ID",
    };
  }

  // Pattern 5: Dispute
  if (normalized.includes("galat") || normalized.includes("wrong charge") || normalized.includes("fraud")) {
    return {
      originalMessage: message,
      intent: "dispute",
      confidence: 0.80,
      sentiment: "frustrated",
      extractedDetails: {},
      recommendedAction: "Escalate to Tier-2 human support agent with priority flag",
    };
  }

  // Default: General Question
  return {
    originalMessage: message,
    intent: "question",
    confidence: 0.70,
    sentiment: "neutral",
    extractedDetails: {},
    recommendedAction: "Provide payment breakdown and send WhatsApp payment link with FAQ",
  };
}

// 4. Lightweight Fallback WAV Synthesizer (PCM 44.1kHz audio chime)

function generateSyntheticBeepWav(): string {
  // Generates a valid 0.5-second 44.1kHz mono WAV chime as Base64
  const sampleRate = 44100;
  const duration = 0.4;
  const numSamples = Math.floor(sampleRate * duration);
  const dataSize = numSamples * 2; // 16-bit
  const buffer = Buffer.alloc(44 + dataSize);

  // RIFF header
  buffer.write("RIFF", 0);
  buffer.writeUInt32LE(36 + dataSize, 4);
  buffer.write("WAVE", 8);
  buffer.write("fmt ", 12);
  buffer.writeUInt32LE(16, 16); // subchunk1 size
  buffer.writeUInt16LE(1, 20);  // PCM format
  buffer.writeUInt16LE(1, 22);  // Mono
  buffer.writeUInt32LE(sampleRate, 24);
  buffer.writeUInt32LE(sampleRate * 2, 28); // byte rate
  buffer.writeUInt16LE(2, 32);  // block align
  buffer.writeUInt16LE(16, 34); // bits per sample
  buffer.write("data", 36);
  buffer.writeUInt32LE(dataSize, 40);

  // Generate a pleasant warm harmonic chime (523Hz C5 -> 659Hz E5)
  for (let i = 0; i < numSamples; i++) {
    const t = i / sampleRate;
    const freq = t < 0.2 ? 523.25 : 659.25;
    const env = Math.exp(-t * 4); // exponential decay
    const sample = Math.sin(2 * Math.PI * freq * t) * env * 0.4 * 32767;
    buffer.writeInt16LE(Math.max(-32768, Math.min(32767, Math.floor(sample))), 44 + i * 2);
  }

  return buffer.toString("base64");
}

// 2b. Phase V1: Arbitrary-text TTS + Voice-Note Understanding (Telegram channel)

/**
 * Synthesize ARBITRARY text (e.g. a live agent reply) to WAV audio via the
 * Gemini TTS endpoint. Unlike generateGeminiVoiceResponse() this takes free
 * text, not a VoiceCallContext. Returns undefined audio when no API key or on
 * failure — callers should gracefully fall back to text-only replies.
 */
export async function synthesizeSpeech(
  text: string,
  geminiApiKey?: string
): Promise<{ audioBase64?: string; provider: "gemini_direct_audio" | "unavailable" }> {
  const apiKey = geminiApiKey || process.env.GEMINI_API_KEY;
  if (!apiKey || !text.trim()) return { provider: "unavailable" };

  const ttsModels = [
    "gemini-3.1-flash-tts-preview",
    "gemini-2.5-flash-preview-tts",
    "gemini-2.5-flash-lite-preview-tts",
    "gemini-2.5-pro-preview-tts",
  ];

  for (const model of ttsModels) {
    try {
      const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;
      const payload = {
        contents: [{ parts: [{ text: `Speak this as a warm, polite Indian recovery assistant in natural Hinglish:\n\n"${text}"` }] }],
        generationConfig: {
          responseModalities: ["AUDIO"],
          speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: "Aoede" } } },
        },
      };
      const res = await fetch(endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      if (!res.ok) {
        console.warn(`[Voice] Model ${model} TTS non-200: ${res.status}`);
        continue;
      }
      const data = (await res.json()) as any;
      const parts = data.candidates?.[0]?.content?.parts || [];
      const audioPart = parts.find((p: any) => p.inlineData && p.inlineData.mimeType?.startsWith("audio/"));
      if (!audioPart) continue;

      const mimeType: string = audioPart.inlineData.mimeType || "audio/wav";
      let audioBase64: string = audioPart.inlineData.data;
      if (/L16|pcm/i.test(mimeType)) {
        const rateMatch = mimeType.match(/rate=(\d+)/i);
        const sampleRate = rateMatch ? parseInt(rateMatch[1], 10) : 24000;
        audioBase64 = pcmToWavBase64(Buffer.from(audioPart.inlineData.data, "base64"), sampleRate);
      }
      return { audioBase64, provider: "gemini_direct_audio" };
    } catch (err: any) {
      console.warn(`[Voice] Model ${model} synthesizeSpeech failed:`, err?.message || err);
    }
  }

  return { provider: "unavailable" };
}

export interface VoiceNoteUnderstanding {
  transcript: string;
  parse: HinglishParseResult;
  source: "gemini_transcribe";
}

/**
 * Understand an inbound customer VOICE NOTE: download happens at the caller;
 * here we send the audio to Gemini Flash (multimodal input) for Hinglish
 * transcription, then run the existing parseHinglishReply() for structured
 * intent — one model call for hearing, tested rules for intent.
 */
export async function understandVoiceNote(
  audioBase64: string,
  mimeType: string,
  geminiApiKey?: string
): Promise<VoiceNoteUnderstanding | null> {
  const apiKey = geminiApiKey || process.env.GEMINI_API_KEY;
  if (!apiKey) return null;

  try {
    const transcriptionModel = process.env.GEMINI_MODEL || "gemini-3-flash-preview";
    const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/${transcriptionModel}:generateContent?key=${apiKey}`;
    const payload = {
      contents: [
        {
          parts: [
            { text: "This is a Hinglish voice note from a customer about a pending payment. Transcribe it exactly in Latin script (Roman Hindi + English words). Reply with ONLY the transcript text, nothing else." },
            { inlineData: { mimeType: mimeType || "audio/ogg", data: audioBase64 } },
          ],
        },
      ],
      generationConfig: { temperature: 0.1 },
    };
    const res = await fetch(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    if (!res.ok) {
      console.warn("[Voice] transcription non-200:", res.status);
      return null;
    }
    const data = (await res.json()) as any;
    const transcript = (data.candidates?.[0]?.content?.parts || [])
      .filter((p: any) => p.text)
      .map((p: any) => p.text)
      .join(" ")
      .trim();
    if (!transcript) return null;

    // Structured intent via the existing tested parser (single source of truth)
    const parse = parseHinglishReply(transcript);
    return { transcript, parse, source: "gemini_transcribe" };
  } catch (err: any) {
    console.warn("[Voice] understandVoiceNote failed:", err?.message || err);
    return null;
  }
}
