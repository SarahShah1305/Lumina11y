import * as Speech from 'expo-speech';
import { AccessibilityInfo, Platform } from 'react-native';

export type SpeakOptions = {
  rate?: number;
  pitch?: number;
  language?: string;
  queue?: boolean;
  onDone?: () => void;
  onStopped?: () => void;
};

type QueuedSpeech = {
  text: string;
  options: SpeakOptions;
};

let defaultRate = 1;
let speaking = false;
let generation = 0;
let activeItemId = 0;
let nextItemId = 1;
let activeItem: QueuedSpeech | null = null;
const queue: QueuedSpeech[] = [];

export function setDefaultSpeechRate(rate: number): void {
  if (!Number.isFinite(rate) || rate <= 0) {
    throw new Error('Speech rate must be a positive number.');
  }
  defaultRate = rate;
}

export function getDefaultSpeechRate(): number {
  return defaultRate;
}

export function isSpeaking(): boolean {
  return speaking || queue.length > 0;
}

function completeSpeech(activeGeneration: number, itemId: number): void {
  if (activeGeneration !== generation || itemId !== activeItemId) return;
  const completedItem = activeItem;
  activeItem = null;
  activeItemId = 0;
  speaking = false;
  try {
    completedItem?.options.onDone?.();
  } catch (error) {
    console.error('Speech completion callback failed.', error);
  }
  const next = queue.shift();
  if (next) beginSpeech(next, activeGeneration);
}

function speakWithDevice(item: QueuedSpeech, activeGeneration: number, itemId: number): void {
  try {
    Speech.speak(item.text, {
      rate: item.options.rate ?? defaultRate,
      pitch: item.options.pitch,
      language: item.options.language,
      onDone: () => completeSpeech(activeGeneration, itemId),
      onStopped: () => completeSpeech(activeGeneration, itemId),
      onError: (error) => {
        console.error('Text-to-speech failed.', error);
        completeSpeech(activeGeneration, itemId);
      },
    });
  } catch (error) {
    console.error('Text-to-speech could not start.', error);
    completeSpeech(activeGeneration, itemId);
  }
}

function beginSpeech(item: QueuedSpeech, activeGeneration: number): void {
  const itemId = nextItemId++;
  speaking = true;
  activeItem = item;
  activeItemId = itemId;
  if (Platform.OS === 'web') {
    speakWithDevice(item, activeGeneration, itemId);
    return;
  }
  void AccessibilityInfo.isScreenReaderEnabled()
    .then((screenReaderEnabled) => {
      if (activeGeneration !== generation || itemId !== activeItemId) return;
      if (screenReaderEnabled) {
        AccessibilityInfo.announceForAccessibility(item.text);
        setTimeout(() => completeSpeech(activeGeneration, itemId), 700);
        return;
      }
      speakWithDevice(item, activeGeneration, itemId);
    })
    .catch((error: unknown) => {
      console.error('Could not determine screen reader status.', error);
      if (activeGeneration === generation && itemId === activeItemId) {
        speakWithDevice(item, activeGeneration, itemId);
      }
    });
}

function cancelActiveSpeech(): void {
  const cancelledItem = activeItem;
  generation += 1;
  queue.length = 0;
  speaking = false;
  activeItem = null;
  activeItemId = 0;
  try {
    cancelledItem?.options.onStopped?.();
  } catch (error) {
    console.error('Speech cancellation callback failed.', error);
  }
  void Speech.stop().catch((error: unknown) => {
    console.error('Could not stop speech.', error);
  });
}

export function speak(text: string, options: SpeakOptions = {}): void {
  const cleanedText = text.trim();
  if (!cleanedText) return;

  const item = { text: cleanedText, options };
  if (options.queue) {
    queue.push(item);
    if (!speaking) {
      const next = queue.shift();
      if (next) beginSpeech(next, generation);
    }
    return;
  }

  cancelActiveSpeech();
  beginSpeech(item, generation);
}

export function stopSpeaking(): void {
  cancelActiveSpeech();
}
