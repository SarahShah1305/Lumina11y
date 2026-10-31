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

function jsonResponse(body: Record<string, string>, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function isTextPart(value: unknown): value is { text: string } {
  return isRecord(value) && typeof value.text === 'string';
}

function logTiming(startedAt: number, step: string, details?: unknown): void {
  console.log(`[transcribe ${new Date().toISOString()} +${Date.now() - startedAt}ms] ${step}`, details ?? '');
}

runtime.Deno.serve(async (request) => {
  if (request.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });
  if (request.method !== 'POST') return jsonResponse({ error: 'method_not_allowed' }, 405);

  const startedAt = Date.now();
  const apiKey = runtime.Deno.env.get('GEMINI_API_KEY');
  if (!apiKey) return jsonResponse({ error: 'transcription_not_configured' }, 503);

  try {
    const contentLength = Number(request.headers.get('content-length'));
    if (Number.isFinite(contentLength) && contentLength > 2 * 1024 * 1024) {
      return jsonResponse({ error: 'audio_too_large' }, 413);
    }

    const body: unknown = await request.json();
    if (!isRecord(body) || typeof body.audioBase64 !== 'string' || typeof body.mimeType !== 'string') {
      return jsonResponse({ error: 'invalid_audio_request' }, 400);
    }
    const { audioBase64 } = body;
    const mimeType = body.mimeType.trim().toLowerCase();
    if (!audioBase64) {
      return jsonResponse({ error: 'no_audio_received' }, 400);
    }
    logTiming(startedAt, 'Audio base64 received:', {
      base64Length: audioBase64.length,
      mimeType,
    });
    if (mimeType !== 'audio/mp4') {
      return jsonResponse({ error: 'unsupported_audio_format' }, 415);
    }
    if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(audioBase64)) {
      return jsonResponse({ error: 'invalid_audio_encoding' }, 400);
    }
    const decodedSize = Math.floor(audioBase64.length * 3 / 4) -
      (audioBase64.endsWith('==') ? 2 : audioBase64.endsWith('=') ? 1 : 0);
    if (decodedSize === 0) {
      return jsonResponse({ error: 'no_audio_received' }, 400);
    }
    if (decodedSize > 1024 * 1024) {
      return jsonResponse({ error: 'audio_too_large' }, 413);
    }

    logTiming(startedAt, 'Audio received:', {
      sizeKB: Math.round((decodedSize / 1024) * 10) / 10,
      base64Length: audioBase64.length,
      mimeType,
    });

    logTiming(startedAt, 'Gemini request sent.');
    const geminiResponse = await fetch(
      'https://generativelanguage.googleapis.com/v1beta/models/gemini-3.5-flash-lite:generateContent',
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-goog-api-key': apiKey,
        },
        body: JSON.stringify({
          contents: [{
            parts: [
              { text: 'Transcribe the audio. Return only the spoken words, with no labels or explanation. If no speech is audible, return an empty response.' },
              { inline_data: { mime_type: mimeType, data: audioBase64 } },
            ],
          }],
          generationConfig: {
            temperature: 0,
            maxOutputTokens: 20,
            thinkingConfig: { thinkingLevel: 'minimal' },
          },
        }),
      },
    );
    logTiming(startedAt, 'Gemini response received:', {
      status: geminiResponse.status,
      statusText: geminiResponse.statusText,
    });

    if (!geminiResponse.ok) {
      const responseBody = await geminiResponse.text();
      console.error('Gemini transcription request failed.', geminiResponse.status, responseBody);
      return jsonResponse({ error: 'transcription_failed' }, 502);
    }

    const payload: unknown = await geminiResponse.json();
    if (!isRecord(payload) || !Array.isArray(payload.candidates)) {
      console.error('Gemini returned an invalid transcription response.', payload);
      return jsonResponse({ error: 'invalid_transcription_response' }, 502);
    }

    const firstCandidate = payload.candidates[0];
    if (!isRecord(firstCandidate)) {
      return jsonResponse({ transcript: '' });
    }
    const content = firstCandidate.content;
    if (!isRecord(content) || !Array.isArray(content.parts)) {
      return jsonResponse({ transcript: '' });
    }

    const transcript = content.parts
      .filter(isTextPart)
      .map((part) => part.text)
      .join(' ')
      .trim();

    logTiming(startedAt, 'Transcript parsed:', transcript || '[empty]');
    return jsonResponse({ transcript });
  } catch (error) {
    console.error('Audio transcription function failed.', error);
    return jsonResponse({ error: 'transcription_failed' }, 500);
  }
});
