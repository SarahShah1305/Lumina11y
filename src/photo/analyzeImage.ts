import { manipulateAsync, SaveFormat } from 'expo-image-manipulator';
import { supabase } from '../lib/supabase';

export type PhotoMode = 'text' | 'describe' | 'medicine' | 'currency';
export type PhotoQuality = 'ok' | 'too_dark' | 'too_bright' | 'too_blurry' | 'too_far' | 'too_close' | 'partly_cut_off';
export type PhotoConfidence = 'high' | 'medium' | 'low';
export type PhotoPosition = { quality: PhotoQuality; hint: string };

export type PhotoAnalysis = {
  text: string;
  description: string;
  quality: PhotoQuality;
  confidence: PhotoConfidence;
  details: Record<string, unknown>;
};

const timeoutMessage = 'Image analysis took too long. Please check your connection and try again.';
const qualityValues: PhotoQuality[] = ['ok', 'too_dark', 'too_bright', 'too_blurry', 'too_far', 'too_close', 'partly_cut_off'];

function friendlyError(error: unknown): string {
  if (error instanceof Error && error.message) return error.message;
  return 'The photo could not be analyzed. Check your internet connection and try again.';
}

async function prepareImage(uri: string, width: number, quality: number): Promise<string> {
  try {
    const resized = await manipulateAsync(uri, [{ resize: { width } }], {
      compress: quality,
      format: SaveFormat.JPEG,
      base64: true,
    });
    if (!resized.base64) throw new Error('missing base64');
    return resized.base64;
  } catch {
    throw new Error('The photo could not be prepared. Please choose another photo and try again.');
  }
}

async function invokeAnalysis<T>(image: string, mode: string): Promise<T> {
  if (!supabase) throw new Error('Photo analysis is not configured. Please contact the app administrator.');

  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  try {
    const timeout = new Promise<never>((_, reject) => {
      timeoutId = setTimeout(() => reject(new Error(timeoutMessage)), 30000);
    });
    const request = supabase.functions.invoke<T>('analyze-image', {
      body: { image, mode },
    });
    const { data, error } = await Promise.race([request, timeout]);
    if (error) {
      const status = typeof error.context === 'object' && error.context !== null && 'status' in error.context
        ? Number(error.context.status)
        : 0;
      if (status === 401) throw new Error('Please sign in before analyzing a photo.');
      if (status === 413) throw new Error('That photo is too large. Please choose a smaller image.');
      if (status === 429) throw new Error('The service is busy, please try again in a minute.');
      if (status >= 500) throw new Error('The photo service is unavailable right now. Please try again shortly.');
      throw new Error('The photo could not be analyzed. Check your internet connection and try again.');
    }
    if (!data || typeof data !== 'object') {
      throw new Error('The photo service returned an unclear result. Please try again.');
    }
    return data;
  } catch (error) {
    if (error instanceof Error && error.message === timeoutMessage) throw error;
    if (error instanceof Error && error.message.startsWith('Please sign in')) throw error;
    if (error instanceof Error && error.message.startsWith('That photo')) throw error;
    if (error instanceof Error && error.message.startsWith('The service is busy')) throw error;
    if (error instanceof Error && error.message.startsWith('The photo service is unavailable')) throw error;
    if (error instanceof Error && error.message.startsWith('The photo service returned')) throw error;
    if (error instanceof Error && error.message.startsWith('The photo could not be analyzed')) throw error;
    throw new Error(friendlyError(error));
  } finally {
    if (timeoutId) clearTimeout(timeoutId);
  }
}

export async function analyzeImage(uri: string, mode: PhotoMode): Promise<PhotoAnalysis> {
  const image = await prepareImage(uri, 1024, 0.6);
  const data = await invokeAnalysis<PhotoAnalysis>(image, mode);
  if (!data || typeof data.text !== 'string' || typeof data.description !== 'string' ||
    !qualityValues.includes(data.quality) || !['high', 'medium', 'low'].includes(data.confidence) ||
    typeof data.details !== 'object' || data.details === null) {
    throw new Error('The photo service returned an unclear result. Please try again.');
  }
  return data;
}

export async function checkImagePosition(uri: string): Promise<PhotoPosition> {
  const image = await prepareImage(uri, 512, 0.35);
  const data = await invokeAnalysis<PhotoPosition>(image, 'framing');
  if (!data || !qualityValues.includes(data.quality) || typeof data.hint !== 'string' || !data.hint.trim()) {
    throw new Error('The photo service returned an unclear position check. Please try again.');
  }
  return data;
}
