import { File } from 'expo-file-system';
import { supabase } from '../lib/supabase';

export type VoiceTranscriptionErrorKind = 'network' | 'timeout' | 'configuration-error' | 'service-error';

export class VoiceTranscriptionError extends Error {
  constructor(readonly kind: VoiceTranscriptionErrorKind, readonly details?: string) {
    super(kind);
    this.name = 'VoiceTranscriptionError';
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function logTranscriptionTiming(startedAt: number, step: string, details?: unknown): void {
  const elapsed = Date.now() - startedAt;
  console.log(`[voice ${new Date().toISOString()} +${elapsed}ms] ${step}`, details ?? '');
}

function isTimeoutError(error: { name?: string; context?: unknown }): boolean {
  if (error.name === 'AbortError') return true;
  if (error.context instanceof Error) return error.context.name === 'AbortError';
  return isRecord(error.context) && (
    error.context.name === 'AbortError' ||
    (typeof error.context.message === 'string' && /timed?\s*out|abort/i.test(error.context.message))
  );
}

function getErrorDetails(error: unknown, status?: number, timedOut = false): string {
  if (!isRecord(error)) {
    return `name=UnknownError; message=${String(error)}; status=${status ?? 'none'}; timeout=${timedOut}; context=none`;
  }
  const context = error.context;
  let contextDetails = 'none';
  if (context instanceof Response) {
    contextDetails = `Response(status=${context.status}, statusText=${context.statusText})`;
  } else if (context instanceof Error) {
    contextDetails = `${context.name}: ${context.message}`;
  } else if (isRecord(context)) {
    contextDetails = `name=${String(context.name ?? 'unknown')}, message=${String(context.message ?? '')}`;
  } else if (context !== undefined) {
    contextDetails = String(context);
  }
  return `name=${String(error.name ?? 'UnknownError')}; message=${String(error.message ?? '')}; status=${status ?? 'none'}; timeout=${timedOut}; context=${contextDetails}`;
}

async function checkSupabaseReachability(startedAt: number): Promise<boolean> {
  const supabaseUrl = process.env.EXPO_PUBLIC_SUPABASE_URL;
  if (!supabaseUrl) {
    logTranscriptionTiming(startedAt, 'Connectivity check skipped: Supabase URL is not configured.');
    return true;
  }

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 3000);
  try {
    const response = await fetch(supabaseUrl, { method: 'HEAD', signal: controller.signal });
    logTranscriptionTiming(startedAt, 'Supabase connectivity check received a response:', {
      status: response.status,
    });
    return true;
  } catch (error) {
    console.error('Supabase connectivity check failed.', error);
    logTranscriptionTiming(
      startedAt,
      'Supabase connectivity check failed:',
      getErrorDetails(error, undefined, error instanceof Error && error.name === 'AbortError'),
    );
    return false;
  } finally {
    clearTimeout(timeoutId);
  }
}

async function invokeWithFetchFallback(
  audioBase64: string,
  mimeType: string,
  startedAt: number,
  invokeError: unknown,
  invokeStatus?: number,
): Promise<string> {
  const supabaseUrl = process.env.EXPO_PUBLIC_SUPABASE_URL?.replace(/\/+$/, '');
  const publishableKey = process.env.EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY;
  if (!supabaseUrl || !publishableKey || !supabase) {
    throw new VoiceTranscriptionError(
      'configuration-error',
      getErrorDetails(invokeError, invokeStatus),
    );
  }

  let accessToken: string | null = null;
  try {
    const { data, error } = await supabase.auth.getSession();
    if (error) console.error('Could not read the current Supabase session for transcription.', error);
    accessToken = data.session?.access_token ?? null;
  } catch (error) {
    console.error('Could not read the current Supabase session for transcription.', error);
  }
  const authorizationToken = accessToken || publishableKey;
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 15000);
  const requestUrl = `${supabaseUrl}/functions/v1/transcribe-audio`;

  logTranscriptionTiming(startedAt, 'Sending direct fetch fallback:', {
    url: requestUrl,
    method: 'POST',
    contentType: 'application/json',
    authorization: accessToken ? 'session access token' : 'publishable key fallback',
    apikeyConfigured: true,
    base64Length: audioBase64.length,
    timeoutMs: 15000,
  });
  try {
    const response = await fetch(requestUrl, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${authorizationToken}`,
        apikey: publishableKey,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ audioBase64, mimeType }),
      signal: controller.signal,
    });
    const responseText = await response.text();
    logTranscriptionTiming(startedAt, 'Direct fetch fallback response received:', {
      status: response.status,
      statusText: response.statusText,
      response: responseText,
    });
    let responseBody: unknown;
    try {
      responseBody = JSON.parse(responseText);
    } catch (error) {
      console.error('Direct fetch transcription response was not valid JSON.', error);
    }

    if (!response.ok) {
      const message = isRecord(responseBody) && typeof responseBody.message === 'string'
        ? responseBody.message
        : responseText || response.statusText;
      const details = `name=FunctionsFetchFallbackError; message=${message}; status=${response.status}; timeout=false; context=${responseText || 'none'}`;
      if (response.status === 503 && isRecord(responseBody) && responseBody.error === 'transcription_not_configured') {
        throw new VoiceTranscriptionError('configuration-error', details);
      }
      throw new VoiceTranscriptionError('service-error', details);
    }
    if (!isRecord(responseBody) || typeof responseBody.transcript !== 'string') {
      throw new VoiceTranscriptionError(
        'service-error',
        `name=InvalidResponse; message=The transcription function response did not contain transcript text; status=${response.status}; timeout=false; context=${responseText}`,
      );
    }
    const transcript = responseBody.transcript.trim();
    logTranscriptionTiming(startedAt, 'Transcript returned by direct fetch:', transcript || '[empty]');
    return transcript;
  } catch (error) {
    if (error instanceof VoiceTranscriptionError) throw error;
    const timedOut = error instanceof Error && error.name === 'AbortError';
    const fallbackDetails = getErrorDetails(error, undefined, timedOut);
    console.error('Direct fetch transcription request failed.', {
      name: error instanceof Error ? error.name : 'UnknownError',
      message: error instanceof Error ? error.message : String(error),
      status: undefined,
      context: error,
      timedOut,
    });
    logTranscriptionTiming(startedAt, 'Direct fetch transcription request failed:', fallbackDetails);
    if (timedOut) throw new VoiceTranscriptionError('timeout', fallbackDetails);
    const reachable = await checkSupabaseReachability(startedAt);
    const kind = reachable ? 'service-error' : 'network';
    throw new VoiceTranscriptionError(
      kind,
      `${fallbackDetails}; original=${getErrorDetails(invokeError, invokeStatus)}`,
    );
  } finally {
    clearTimeout(timeoutId);
  }
}

export async function transcribeAudioFile(uri: string): Promise<string> {
  if (!supabase) throw new VoiceTranscriptionError('configuration-error');

  const startedAt = Date.now();
  const file = new File(uri);
  try {
    const fileSize = file.size;
    const fileSizeKb = Math.round((fileSize / 1024) * 10) / 10;
    const extension = file.extension.toLocaleLowerCase();
    const mimeType = extension === '.m4a' ? 'audio/mp4' : file.type || 'audio/mp4';
    logTranscriptionTiming(startedAt, 'Recorded file details:', {
      uri,
      sizeBytes: fileSize,
      sizeKB: fileSizeKb,
      extension,
      mimeType,
    });

    if (fileSize === 0) {
      logTranscriptionTiming(startedAt, 'Recording is empty; no request will be sent.');
      return '';
    }

    const audioBase64 = await file.base64();
    if (!audioBase64) {
      logTranscriptionTiming(startedAt, 'Recorded file returned empty base64; no request will be sent.');
      return '';
    }

    logTranscriptionTiming(startedAt, 'Recorded audio encoded as base64:', {
      base64Length: audioBase64.length,
      sizeKB: fileSizeKb,
      mimeType,
    });
    logTranscriptionTiming(startedAt, 'Sending transcription request:', {
      uri,
      sizeBytes: fileSize,
      sizeKB: fileSizeKb,
      base64Length: audioBase64.length,
      approximateAudioBytes: Math.floor(audioBase64.length * 3 / 4),
      mimeType,
      contentType: 'application/json',
      method: 'POST',
      supabaseClientConfigured: Boolean(supabase),
      publishableKeyConfigured: Boolean(process.env.EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY),
      authSessionLookup: 'managed by Supabase client; explicit fallback if invoke fails',
      timeoutMs: 15000,
    });
    const { data, error, response } = await supabase.functions.invoke<{ transcript: string }>(
      'transcribe-audio',
      {
        body: { audioBase64, mimeType },
        headers: { 'Content-Type': 'application/json' },
        timeout: 15000,
      },
    );
    if (error) {
      const responseStatus = response?.status ??
        ('context' in error && error.context instanceof Response ? error.context.status : undefined);
      const timedOut = isTimeoutError(error);
      const details = getErrorDetails(error, responseStatus, timedOut);
      console.error('Speech transcription request failed.', {
        name: 'name' in error ? error.name : 'UnknownError',
        message: 'message' in error ? error.message : String(error),
        status: responseStatus,
        context: 'context' in error ? error.context : undefined,
        timedOut,
      });
      logTranscriptionTiming(startedAt, 'Transcription request failed:', details);
      if ('name' in error && error.name === 'FunctionsFetchError' && !timedOut) {
        return await invokeWithFetchFallback(
          audioBase64,
          mimeType,
          startedAt,
          error,
          responseStatus,
        );
      }
      let responseText = '';
      if ('context' in error && error.context instanceof Response) {
        logTranscriptionTiming(startedAt, 'Transcription response received:', {
          status: responseStatus,
          statusText: error.context.statusText,
        });
        try {
          responseText = await error.context.clone().text();
          console.error('[voice] Transcription error response body:', responseText);
          let responseBody: unknown;
          try {
            responseBody = JSON.parse(responseText);
          } catch (parseError) {
            console.error('Transcription error response was not valid JSON.', parseError);
          }
          if (isRecord(responseBody) && responseBody.error === 'transcription_not_configured') {
            throw new VoiceTranscriptionError('configuration-error', `${details}; response=${responseText}`);
          }
        } catch (responseError) {
          if (responseError instanceof VoiceTranscriptionError) throw responseError;
          console.error('Could not read the transcription error response.', responseError);
        }
      }
      if (timedOut) {
        logTranscriptionTiming(startedAt, 'Transcription request timed out.');
        throw new VoiceTranscriptionError('timeout', details);
      }
      if (
        !responseStatus &&
        'name' in error &&
        (error.name === 'FunctionsFetchError' || error.name === 'FunctionsRelayError')
      ) {
        const reachable = await checkSupabaseReachability(startedAt);
        if (!reachable) throw new VoiceTranscriptionError('network', details);
      }
      const serverDetails = responseText ? `${details}; response=${responseText}` : details;
      throw new VoiceTranscriptionError('service-error', serverDetails);
    }

    logTranscriptionTiming(startedAt, 'Transcription response received:', {
      status: response?.status ?? 'unknown',
      statusText: response?.statusText ?? '',
    });
    if (typeof data?.transcript !== 'string') {
      console.error('[voice] Transcription response has no transcript field:', data);
      throw new VoiceTranscriptionError('service-error');
    }
    const transcript = data.transcript.trim();
    logTranscriptionTiming(startedAt, 'Transcript returned:', transcript || '[empty]');
    return transcript;
  } finally {
    try {
      file.delete();
    } catch (error) {
      console.error('Recorded voice clip could not be removed from local storage.', error);
    }
  }
}
