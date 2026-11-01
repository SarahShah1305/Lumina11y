const runtime = globalThis as typeof globalThis & {
  Deno: {
    env: { get(name: string): string | undefined };
    serve(handler: (request: Request) => Response | Promise<Response>): void;
  };
};

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

const model = 'gemini-3.5-flash-lite';
const maxImageBytes = 4 * 1024 * 1024;
const modes = ['text', 'describe', 'medicine', 'currency', 'framing'] as const;
type Mode = typeof modes[number];
type Quality = 'ok' | 'too_dark' | 'too_bright' | 'too_blurry' | 'too_far' | 'too_close' | 'partly_cut_off' | 'wrong_angle';
type Confidence = 'high' | 'medium' | 'low';

function jsonResponse(body: Record<string, unknown>, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function promptFor(mode: Mode): string {
  if (mode === 'framing') {
    return 'Check only whether the camera position is suitable. Return ONLY valid JSON with exactly two fields: {"quality":"ok"|"too_dark"|"too_bright"|"too_blurry"|"too_far"|"too_close"|"partly_cut_off"|"wrong_angle","hint":string}. The hint must be one short, specific sentence telling the user how to improve the view. Use too_dark for dim lighting, too_blurry for blur, too_far when the main subject is small in the frame, partly_cut_off when relevant parts are outside the frame, and wrong_angle when the camera is tilted or viewing the subject from an angle that obscures text or details. For wrong_angle, tell the user to hold the phone straight in front of the object. Use too_bright or too_close when applicable. "ok" is allowed only when the image is clearly lit, sharp, straight-on, and the entire subject fills the frame. If unsure about image quality or angle, return the matching issue instead of ok. Do not identify or describe the subject.';
  }
  const common = `Return ONLY valid JSON with exactly these fields: {"text":string,"description":string,"quality":"ok"|"too_dark"|"too_bright"|"too_blurry"|"too_far"|"too_close"|"partly_cut_off"|"wrong_angle","confidence":"high"|"medium"|"low","details":object}. No markdown or extra text. Inspect image quality before reading or describing anything. If lighting is dim, report too_dark. If blurry or out of focus, report too_blurry. If the subject or text is small in the frame or far away, report too_far. If text or the subject is cut off, report partly_cut_off. If the camera angle obscures the subject or text, report wrong_angle. If too bright or too close, use the matching quality. For ANY quality other than ok, confidence MUST be low and do not guess content. "ok" is allowed only when the image is clearly lit, sharp, straight-on, and the subject fills the frame with all relevant text or parts fully visible. If uncertain whether any of these requirements is met, return the matching quality issue instead of ok. Use empty strings when text or description is not applicable.`;
  const instructions: Record<Mode, string> = {
    text: 'Read visible text exactly as written. Mark unclear words as [unclear]; never guess. Put the transcription in text, and use details as an empty object.',
    describe: 'Write 1 to 3 short plain sentences for a blind user, covering the scene, main objects, people, colours, and any visible text. Put them in description, and use details as an empty object.',
    medicine: 'Copy only printed information from medicine packaging. Set details to {"name":string,"strength":string,"form":string,"expiry":string,"instructionsOnLabel":string,"warningsOnLabel":string}. Leave unknown or unreadable values empty. Never invent information or advise doses.',
    currency: 'Identify Pakistani rupee notes only: 10, 20, 50, 100, 500, 1000, or 5000. Set details to {"currency":string,"denomination":number|string,"side":string}. If unsure, set confidence to low and do not guess; leave currency and denomination empty. Side may be front, back, or unknown.',
    framing: '',
  };
  return `${common} ${instructions[mode]}`;
}

function parseModelJson(text: string): Record<string, unknown> | null {
  const cleaned = text.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim();
  try {
    const parsed: unknown = JSON.parse(cleaned);
    if (!isRecord(parsed)) return null;
    const qualities: Quality[] = ['ok', 'too_dark', 'too_bright', 'too_blurry', 'too_far', 'too_close', 'partly_cut_off', 'wrong_angle'];
    const confidences: Confidence[] = ['high', 'medium', 'low'];
    if (typeof parsed.text !== 'string' || typeof parsed.description !== 'string' ||
      !qualities.includes(parsed.quality as Quality) || !confidences.includes(parsed.confidence as Confidence) ||
      !isRecord(parsed.details)) return null;
    if (parsed.quality !== 'ok') parsed.confidence = 'low';
    return parsed;
  } catch {
    return null;
  }
}

function parseFramingJson(text: string): { quality: Quality; hint: string } | null {
  const cleaned = text.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim();
  try {
    const parsed: unknown = JSON.parse(cleaned);
    if (!isRecord(parsed) || !['ok', 'too_dark', 'too_bright', 'too_blurry', 'too_far', 'too_close', 'partly_cut_off', 'wrong_angle'].includes(String(parsed.quality)) ||
      typeof parsed.hint !== 'string' || !parsed.hint.trim()) return null;
    return { quality: parsed.quality as Quality, hint: parsed.hint.trim() };
  } catch {
    return null;
  }
}

async function isAuthenticated(request: Request): Promise<boolean> {
  const authorization = request.headers.get('authorization');
  const match = authorization?.match(/^Bearer\s+(.+)$/i);
  const supabaseUrl = runtime.Deno.env.get('SUPABASE_URL');
  const anonKey = runtime.Deno.env.get('SUPABASE_ANON_KEY');
  if (!match || !supabaseUrl || !anonKey) return false;
  try {
    const response = await fetch(`${supabaseUrl.replace(/\/+$/, '')}/auth/v1/user`, {
      headers: { apikey: anonKey, Authorization: `Bearer ${match[1]}` },
      signal: AbortSignal.timeout(5000),
    });
    return response.ok;
  } catch {
    return false;
  }
}

runtime.Deno.serve(async (request) => {
  if (request.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });
  if (request.method !== 'POST') return jsonResponse({ error: 'method_not_allowed', message: 'Please send a POST request.' }, 405);
  if (!await isAuthenticated(request)) return jsonResponse({ error: 'unauthorized', message: 'Please sign in to analyze an image.' }, 401);

  const apiKey = runtime.Deno.env.get('GEMINI_API_KEY');
  if (!apiKey) return jsonResponse({ error: 'analysis_not_configured', message: 'Image analysis is not configured yet.' }, 503);

  try {
    const contentLength = Number(request.headers.get('content-length'));
    if (Number.isFinite(contentLength) && contentLength > 6 * 1024 * 1024) {
      return jsonResponse({ error: 'image_too_large', message: 'That image is too large. Please choose an image under 4 MB.' }, 413);
    }
    const body: unknown = await request.json();
    if (!isRecord(body) || typeof body.image !== 'string' || typeof body.mode !== 'string' ||
      !modes.includes(body.mode as Mode)) {
      return jsonResponse({ error: 'invalid_image_request', message: 'Please provide a base64 JPEG image and a supported analysis mode.' }, 400);
    }
    const image = body.image;
    if (!image || image.startsWith('data:') || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(image)) {
      return jsonResponse({ error: 'invalid_image', message: 'The image could not be read. Please choose a JPEG image and try again.' }, 400);
    }
    const imageBytes = Math.floor(image.length * 3 / 4) - (image.endsWith('==') ? 2 : image.endsWith('=') ? 1 : 0);
    if (!imageBytes) return jsonResponse({ error: 'no_image_received', message: 'Please choose an image to analyze.' }, 400);
    if (imageBytes > maxImageBytes) {
      return jsonResponse({ error: 'image_too_large', message: 'That image is too large. Please choose an image under 4 MB.' }, 413);
    }

    let geminiResponse: Response;
    try {
      geminiResponse = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey },
          body: JSON.stringify({
            contents: [{ parts: [{ text: promptFor(body.mode as Mode) }, { inline_data: { mime_type: 'image/jpeg', data: image } }] }],
            generationConfig: { temperature: 0, responseMimeType: 'application/json', maxOutputTokens: body.mode === 'framing' ? 120 : 500 },
          }),
          signal: AbortSignal.timeout(30000),
        },
      );
    } catch (error) {
      if (error instanceof DOMException && error.name === 'TimeoutError') {
        return jsonResponse({ error: 'analysis_timeout', message: 'Image analysis took too long. Please try again.' }, 504);
      }
      return jsonResponse({ error: 'analysis_unavailable', message: 'The image service could not be reached. Please try again.' }, 502);
    }

    if (geminiResponse.status === 429) {
      return jsonResponse({ error: 'rate_limited', message: 'The service is busy, please try again in a minute.' }, 429);
    }
    if (!geminiResponse.ok) {
      console.error('Gemini image analysis request failed.', geminiResponse.status);
      return jsonResponse({ error: 'analysis_failed', message: 'Image analysis could not be completed. Please try again.' }, 502);
    }

    let payload: unknown;
    try {
      payload = await geminiResponse.json();
    } catch {
      return jsonResponse({ error: 'invalid_service_response', message: 'The image service returned an unreadable response. Please try again.' }, 502);
    }
    if (!isRecord(payload) || !Array.isArray(payload.candidates)) {
      return jsonResponse({ error: 'invalid_service_response', message: 'The image service returned an unexpected response. Please try again.' }, 502);
    }
    const candidate = payload.candidates[0];
    const content = isRecord(candidate) && isRecord(candidate.content) ? candidate.content : null;
    const parts = content && Array.isArray(content.parts) ? content.parts : [];
    const reply = parts.filter((part) => isRecord(part) && typeof part.text === 'string').map((part) => (part as { text: string }).text).join('\n');
    if (body.mode === 'framing') {
      const framing = parseFramingJson(reply);
      if (!framing) return jsonResponse({ error: 'invalid_analysis_output', message: 'The image service returned an unclear position check. Please try again.' }, 502);
      return jsonResponse(framing);
    }
    const result = parseModelJson(reply);
    if (!result) return jsonResponse({ error: 'invalid_analysis_output', message: 'The image service returned an unclear result. Please try again.' }, 502);
    return jsonResponse(result);
  } catch (error) {
    console.error('Image analysis function failed.', error instanceof Error ? error.message : 'unknown error');
    return jsonResponse({ error: 'analysis_failed', message: 'Image analysis could not be completed. Please try again.' }, 500);
  }
});
