import { requireOptionalNativeModule } from 'expo';
import { Platform, type EventSubscription } from 'react-native';
import type { ExpoSpeechRecognitionOptions } from 'expo-speech-recognition';
import { speak } from './speak';

export type ListeningError = 'permission-denied' | 'network' | 'no-speech' | 'unsupported' | 'unknown';
export type RecognitionCallback = (text: string) => void;
export type ListeningErrorCallback = (error: ListeningError) => void;

type WebSpeechResult = {
  isFinal: boolean;
  0: { transcript: string };
};

type WebSpeechEvent = {
  resultIndex: number;
  results: ArrayLike<WebSpeechResult>;
};

type WebSpeechErrorEvent = { error: string };

type WebSpeechRecognition = {
  lang: string;
  interimResults: boolean;
  maxAlternatives: number;
  onresult: ((event: WebSpeechEvent) => void) | null;
  onerror: ((event: WebSpeechErrorEvent) => void) | null;
  onend: (() => void) | null;
  start(): void;
  stop(): void;
  abort(): void;
};

type SpeechRecognitionWindow = Window & {
  SpeechRecognition?: new () => WebSpeechRecognition;
  webkitSpeechRecognition?: new () => WebSpeechRecognition;
};

type NativeSpeechRecognition = {
  requestPermissionsAsync(): Promise<{ granted: boolean }>;
  start(options: ExpoSpeechRecognitionOptions): void;
  stop(): void;
  addListener(eventName: 'result', listener: (event: { isFinal: boolean; results: { transcript: string }[] }) => void): EventSubscription;
  addListener(eventName: 'error', listener: (event: { error: string }) => void): EventSubscription;
  addListener(eventName: 'end', listener: () => void): EventSubscription;
};

const listeningListeners = new Set<(isListening: boolean) => void>();
let listening = false;
let starting = false;
let startToken = 0;
let activeWebRecognition: WebSpeechRecognition | null = null;
let nativeRecognition: NativeSpeechRecognition | null = null;
let nativeSubscriptions: EventSubscription[] = [];
let resultCallback: RecognitionCallback | undefined;
let errorCallback: ListeningErrorCallback | undefined;

function setListening(value: boolean): void {
  listening = value;
  listeningListeners.forEach((listener) => listener(value));
}

function messageForError(error: ListeningError): string {
  if (error === 'permission-denied') return 'Microphone permission was denied. Allow microphone access to use voice commands.';
  if (error === 'network') return 'Listening needs internet. Use keyboard shortcuts instead.';
  if (error === 'no-speech') return "I didn't hear anything. Try again, or use a keyboard shortcut.";
  if (error === 'unsupported') return 'Voice listening is not supported here. Use keyboard shortcuts instead.';
  return 'Listening could not start. Use keyboard shortcuts instead.';
}

function reportError(error: ListeningError): void {
  setListening(false);
  try {
    errorCallback?.(error);
  } catch (callbackError) {
    console.error('Speech recognition error callback failed.', callbackError);
  }
  void speak(messageForError(error));
}

function mapRecognitionError(error: string): ListeningError {
  if (error === 'not-allowed' || error === 'service-not-allowed') return 'permission-denied';
  if (error === 'network') return 'network';
  if (error === 'no-speech' || error === 'speech-timeout') return 'no-speech';
  if (error === 'unsupported') return 'unsupported';
  return 'unknown';
}

function emitResult(text: string): void {
  const cleanedText = text.trim();
  if (!cleanedText) return;
  try {
    resultCallback?.(cleanedText);
  } catch (error) {
    console.error('Speech recognition result callback failed.', error);
  }
}

function clearNativeSubscriptions(): void {
  nativeSubscriptions.forEach((subscription) => subscription.remove());
  nativeSubscriptions = [];
  nativeRecognition = null;
}

export function isListening(): boolean {
  return listening;
}

export function subscribeToListening(listener: (isListening: boolean) => void): () => void {
  listeningListeners.add(listener);
  return () => listeningListeners.delete(listener);
}

export async function startListening(
  onResult?: RecognitionCallback,
  onError?: ListeningErrorCallback,
  language = 'en-US',
): Promise<void> {
  if (listening || starting) return;
  starting = true;
  const token = ++startToken;
  resultCallback = onResult;
  errorCallback = onError;
  setListening(true);

  try {
    if (Platform.OS === 'web') {
      if (typeof window === 'undefined') {
        reportError('unsupported');
        return;
      }
      const recognitionWindow = window as SpeechRecognitionWindow;
      const Recognition = recognitionWindow.SpeechRecognition ?? recognitionWindow.webkitSpeechRecognition;
      if (!Recognition) {
        reportError('unsupported');
        return;
      }
      const instance = new Recognition();
      activeWebRecognition = instance;
      instance.lang = language;
      instance.interimResults = false;
      instance.maxAlternatives = 1;
      instance.onresult = (event) => {
        const result = event.results[event.resultIndex];
        if (result?.isFinal) emitResult(result[0].transcript);
      };
      instance.onerror = (event) => reportError(mapRecognitionError(event.error));
      instance.onend = () => {
        if (activeWebRecognition === instance) {
          activeWebRecognition = null;
        }
        setListening(false);
      };
      speak('Listening...', {
        onDone: () => {
          if (token === startToken && listening && activeWebRecognition === instance) {
            try {
              instance.start();
            } catch (error) {
              console.error('Browser speech recognition could not start.', error);
              reportError('unsupported');
            }
          }
        },
        onStopped: () => stopListening(false),
      });
      return;
    }

    const optionalModule = requireOptionalNativeModule<NativeSpeechRecognition>('ExpoSpeechRecognition');
    if (!optionalModule) {
      reportError('unsupported');
      return;
    }
    const permission = await optionalModule.requestPermissionsAsync();
    if (token !== startToken) return;
    if (!permission.granted) {
      reportError('permission-denied');
      return;
    }
    nativeRecognition = optionalModule;
    nativeSubscriptions = [
      optionalModule.addListener('result', (event) => {
        const finalResult = event.isFinal ? event.results[0]?.transcript : undefined;
        if (finalResult) emitResult(finalResult);
      }),
      optionalModule.addListener('error', (event) => reportError(mapRecognitionError(event.error))),
      optionalModule.addListener('end', () => {
        setListening(false);
        clearNativeSubscriptions();
      }),
    ];
    speak('Listening...', {
      onDone: () => {
        if (token === startToken && listening && nativeRecognition === optionalModule) {
          try {
            optionalModule.start({ lang: language, interimResults: false, continuous: false });
          } catch (error) {
            console.error('Native speech recognition could not start.', error);
            clearNativeSubscriptions();
            reportError('unsupported');
          }
        }
      },
      onStopped: () => stopListening(false),
    });
  } catch (error) {
    if (token === startToken) {
      console.error('Speech recognition could not start.', error);
      clearNativeSubscriptions();
      reportError('unsupported');
    }
  } finally {
    if (token === startToken) starting = false;
  }
}

export function stopListening(announce = true): void {
  startToken += 1;
  starting = false;
  if (activeWebRecognition) {
    activeWebRecognition.onresult = null;
    activeWebRecognition.onerror = null;
    activeWebRecognition.onend = null;
    try {
      activeWebRecognition.stop();
    } catch (error) {
      console.error('Browser speech recognition could not stop.', error);
    }
    activeWebRecognition = null;
  }
  if (nativeRecognition) {
    try {
      nativeRecognition.stop();
    } catch (error) {
      console.error('Native speech recognition could not stop.', error);
    }
    clearNativeSubscriptions();
  }
  setListening(false);
  if (announce) void speak('Stopped listening.');
}
