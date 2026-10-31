import {
  AudioModule,
  RecordingPresets,
  requestRecordingPermissionsAsync,
  setAudioModeAsync,
  type AudioRecorder,
} from 'expo-audio';
import { Platform } from 'react-native';
import { speak, stopSpeakingAndWait } from './speak';
import { transcribeAudioFile, VoiceTranscriptionError } from './transcribe';

export type ListeningError =
  | 'permission-denied'
  | 'network'
  | 'timeout'
  | 'microphone-unavailable'
  | 'service-error'
  | 'configuration-error'
  | 'no-speech'
  | 'unsupported'
  | 'unknown';
export type RecognitionCallback = (text: string) => void;
export type ListeningErrorCallback = (error: ListeningError, details?: string) => void;

type ActiveRecording = {
  recorder: AudioRecorder;
  token: number;
  preparePromise: Promise<void>;
  prepared: boolean;
  released: boolean;
  speechDetected: boolean;
  silenceStartedAt: number | null;
  recordingStartedAt: number;
  noiseSamples: number[];
  noiseFloorDb: number | null;
  nextMeterLogAtMs: number;
  meteringUnavailableLogged: boolean;
  meterInterval: ReturnType<typeof setInterval> | null;
  cleanupPromise?: Promise<string | null>;
};

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

type BrowserNavigator = Navigator & {
  mediaDevices?: Navigator['mediaDevices'];
};

const listeningListeners = new Set<(isListening: boolean) => void>();
let listening = false;
let starting = false;
let startToken = 0;
let activeWebRecognition: WebSpeechRecognition | null = null;
let activeMicrophoneStream: MediaStream | null = null;
let activeRecorder: ActiveRecording | null = null;
let recordingTimeout: ReturnType<typeof setTimeout> | null = null;
let recorderCleanup: Promise<void> | null = null;
let resultCallback: RecognitionCallback | undefined;
let errorCallback: ListeningErrorCallback | undefined;
let errorReported = false;
const RECORDING_DURATION_MS = 4000;
const SILENCE_DURATION_MS = 600;
const NO_SPEECH_TIMEOUT_MS = 2500;
const NOISE_CALIBRATION_DURATION_MS = 300;
const METER_POLL_INTERVAL_MS = 100;
const SPEECH_ABOVE_NOISE_DB = 10;
const SILENCE_ABOVE_NOISE_DB = 6;
const VOICE_RECORDING_OPTIONS = {
  ...RecordingPresets.LOW_QUALITY,
  sampleRate: 16000,
  numberOfChannels: 1,
  bitRate: 32000,
  isMeteringEnabled: true,
  web: { mimeType: 'audio/webm', bitsPerSecond: 32000 },
};
let voiceFlowStartedAt = 0;
let pendingAudioModeRestore: Promise<void> | null = null;

function logVoiceTiming(step: string, details?: unknown): void {
  const elapsed = voiceFlowStartedAt ? ` +${Date.now() - voiceFlowStartedAt}ms` : '';
  console.log(`[voice ${new Date().toISOString()}${elapsed}] ${step}`, details ?? '');
}

function setListening(value: boolean): void {
  listening = value;
  listeningListeners.forEach((listener) => listener(value));
}

function messageForError(error: ListeningError, details?: string): string {
  let message: string;
  if (error === 'permission-denied') message = 'Microphone permission was denied. Allow microphone access to use voice commands.';
  else if (error === 'network') message = 'The transcription service could not be reached. Check your internet connection and Supabase URL.';
  else if (error === 'timeout') message = 'Voice transcription timed out after 15 seconds. Check your internet connection and try again.';
  else if (error === 'microphone-unavailable') message = 'The microphone could not start. Check microphone access and try again.';
  else if (error === 'service-error') message = 'Speech transcription failed. Please try again or use the on-screen buttons.';
  else if (error === 'configuration-error') message = 'Speech transcription is not configured. Please contact the app administrator.';
  else if (error === 'no-speech') message = "I didn't hear anything. Try again, or use a keyboard shortcut.";
  else if (error === 'unsupported') message = 'Voice listening is not supported in this browser. Use the on-screen buttons instead.';
  else message = 'Something went wrong while listening. Please try again or use the on-screen buttons.';
  return details ? `${message} Details: ${details}` : message;
}

function errorDetails(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function reportError(error: ListeningError, details?: string): void {
  if (errorReported) return;
  errorReported = true;
  const callback = errorCallback;
  resultCallback = undefined;
  errorCallback = undefined;
  stopListening(false);
  try {
    callback?.(error, details);
  } catch (callbackError) {
    console.error('Speech recognition error callback failed.', callbackError);
  }
  if (!callback) void speak(messageForError(error, details));
}

function mapRecognitionError(error: string): ListeningError {
  if (error === 'not-allowed' || error === 'service-not-allowed') return 'permission-denied';
  if (error === 'network') return 'service-error';
  if (error === 'no-speech' || error === 'speech-timeout') return 'no-speech';
  if (error === 'unsupported') return 'unsupported';
  return 'service-error';
}

function emitResult(text: string): void {
  const cleanedText = text.trim();
  if (!cleanedText) {
    reportError('no-speech');
    return;
  }
  const callback = resultCallback;
  resultCallback = undefined;
  errorCallback = undefined;
  stopListening(false);
  try {
    callback?.(cleanedText);
  } catch (error) {
    console.error('Speech recognition result callback failed.', error);
  }
}

function releaseMicrophone(): void {
  activeMicrophoneStream?.getTracks().forEach((track) => track.stop());
  activeMicrophoneStream = null;
}

function restoreAudioMode(): Promise<void> {
  return setAudioModeAsync({ allowsRecording: false, playsInSilentMode: true });
}

function stopMeterPolling(session: ActiveRecording): void {
  if (session.meterInterval) {
    clearInterval(session.meterInterval);
    session.meterInterval = null;
  }
}

function startMeterPolling(session: ActiveRecording): void {
  stopMeterPolling(session);
  session.meterInterval = setInterval(() => {
    if (
      activeRecorder !== session ||
      session.released ||
      !session.prepared
    ) {
      stopMeterPolling(session);
      return;
    }

    try {
      const { isRecording, metering } = session.recorder.getStatus();
      if (!isRecording) return;
      if (typeof metering !== 'number' || !Number.isFinite(metering)) {
        if (!session.meteringUnavailableLogged) {
          session.meteringUnavailableLogged = true;
          logVoiceTiming('Metering unavailable; using four-second recording limit.');
        }
      } else {
        const elapsedMs = Date.now() - session.recordingStartedAt;
        if (elapsedMs >= session.nextMeterLogAtMs) {
          logVoiceTiming('Microphone metering:', {
            elapsedMs,
            levelDb: metering,
            noiseFloorDb: session.noiseFloorDb,
          });
          session.nextMeterLogAtMs = (Math.floor(elapsedMs / 200) + 1) * 200;
        }

        if (session.noiseFloorDb === null) {
          if (elapsedMs <= NOISE_CALIBRATION_DURATION_MS) {
            session.noiseSamples.push(metering);
            return;
          }
          const samples = session.noiseSamples;
          session.noiseFloorDb = samples.length
            ? samples.reduce((sum, sample) => sum + sample, 0) / samples.length
            : metering;
          logVoiceTiming('Noise calibration complete:', {
            noiseFloorDb: Math.round(session.noiseFloorDb * 10) / 10,
            speechThresholdDb: Math.round((session.noiseFloorDb + SPEECH_ABOVE_NOISE_DB) * 10) / 10,
            silenceThresholdDb: Math.round((session.noiseFloorDb + SILENCE_ABOVE_NOISE_DB) * 10) / 10,
            samples: samples.length,
          });
        }

        if (metering >= session.noiseFloorDb + SPEECH_ABOVE_NOISE_DB) {
          if (!session.speechDetected) logVoiceTiming('Speech detected above adaptive noise threshold:', metering);
          session.speechDetected = true;
          session.silenceStartedAt = null;
        } else if (
          session.speechDetected &&
          metering <= session.noiseFloorDb + SILENCE_ABOVE_NOISE_DB
        ) {
          if (session.silenceStartedAt === null) {
            session.silenceStartedAt = Date.now();
          } else if (Date.now() - session.silenceStartedAt >= SILENCE_DURATION_MS) {
            logVoiceTiming('Stopping after 600ms near the calibrated noise floor; metering level:', metering);
            stopMeterPolling(session);
            void finishRecording(session.token, session.recorder);
          }
        } else if (session.speechDetected) {
          session.silenceStartedAt = null;
        }
      }

      if (!session.speechDetected && Date.now() - session.recordingStartedAt >= NO_SPEECH_TIMEOUT_MS) {
        logVoiceTiming('Stopping because no speech was detected within 2.5 seconds.');
        stopMeterPolling(session);
        void finishRecording(session.token, session.recorder, true);
      }
    } catch (error) {
      stopMeterPolling(session);
      console.error('Could not read microphone metering status.', error);
      logVoiceTiming('Metering failed; using four-second recording limit.');
    }
  }, METER_POLL_INTERVAL_MS);
}

function cleanupRecorder(session: ActiveRecording, waitForAudioModeRestore = true): Promise<string | null> {
  if (session.cleanupPromise) return session.cleanupPromise;
  session.cleanupPromise = (async () => {
    stopMeterPolling(session);
    let cleanupError: unknown;
    let uri: string | null = null;
    try {
      await session.preparePromise;
    } catch (error) {
      cleanupError = error;
    }

    if (session.prepared && !session.released) {
      try {
        if (session.recorder.isRecording) {
          await session.recorder.stop();
          logVoiceTiming('Recording stopped.');
        }
      } catch (error) {
        cleanupError ??= error;
      }
      try {
        uri = session.recorder.uri;
        logVoiceTiming('Recording stopped; file URI:', uri);
      } catch (error) {
        cleanupError ??= error;
      }
    }

    if (!session.released) {
      session.released = true;
      try {
        session.recorder.release();
      } catch (error) {
        cleanupError ??= error;
      }
    }

    const audioModeRestore = restoreAudioMode();
    if (waitForAudioModeRestore) {
      try {
        await audioModeRestore;
      } catch (error) {
        cleanupError ??= error;
      }
    } else {
      pendingAudioModeRestore = audioModeRestore
        .catch((error: unknown) => {
          console.error('Audio mode could not be restored after recording.', error);
        })
        .finally(() => {
          pendingAudioModeRestore = null;
        });
    }

    if (cleanupError) throw cleanupError;
    return uri;
  })();
  return session.cleanupPromise;
}

async function finishRecording(token: number, recorder: AudioRecorder, noSpeechDetected = false): Promise<void> {
  if (recordingTimeout) clearTimeout(recordingTimeout);
  recordingTimeout = null;

  try {
    const session = activeRecorder;
    if (!session || session.recorder !== recorder || session.token !== token) return;
    const uri = await cleanupRecorder(session, false);
    if (activeRecorder === session) activeRecorder = null;
    if (token !== startToken) return;

    if (!uri) {
      reportError('no-speech');
      return;
    }
    if (noSpeechDetected) {
      reportError('no-speech');
      return;
    }

    const transcript = await transcribeAudioFile(uri);
    if (token === startToken) emitResult(transcript);
  } catch (error) {
    console.error('Voice recording or transcription failed.', error);
    if (token === startToken) {
      if (error instanceof VoiceTranscriptionError) {
        reportError(error.kind, error.details);
      } else {
        reportError('service-error', errorDetails(error));
      }
    }
  }
}

async function startNativeListening(token: number): Promise<void> {
  let recorder: AudioRecorder | null = null;
  let recorderSession: ActiveRecording | null = null;
  try {
    try {
      await stopSpeakingAndWait();
    } catch (error) {
      console.error('Speech output could not stop before recording.', error);
      reportError('service-error', errorDetails(error));
      return;
    }
    if (token !== startToken) return;

    const permission = await requestRecordingPermissionsAsync();
    if (token !== startToken) return;
    if (!permission.granted) {
      reportError('permission-denied');
      return;
    }

    if (pendingAudioModeRestore) await pendingAudioModeRestore;
    await setAudioModeAsync({ allowsRecording: true, playsInSilentMode: true });
    if (token !== startToken) {
      await restoreAudioMode();
      return;
    }

    recorder = new AudioModule.AudioRecorder(VOICE_RECORDING_OPTIONS);
    const session: ActiveRecording = {
      recorder,
      token,
      preparePromise: Promise.resolve(),
      prepared: false,
      released: false,
      speechDetected: false,
      silenceStartedAt: null,
      recordingStartedAt: 0,
      noiseSamples: [],
      noiseFloorDb: null,
      nextMeterLogAtMs: 200,
      meteringUnavailableLogged: false,
      meterInterval: null,
    };
    recorderSession = session;
    activeRecorder = session;
    session.preparePromise = recorder.prepareToRecordAsync();
    await session.preparePromise;
    session.prepared = true;
    if (token !== startToken) {
      await cleanupRecorder(session);
      if (activeRecorder === session) activeRecorder = null;
      return;
    }

    speak('Listening now. Speak your command.', {
      onDone: () => {
        if (
          token !== startToken ||
          !listening ||
          activeRecorder !== session ||
          session.released ||
          !session.prepared
        ) return;
        try {
          session.recorder.record();
          session.recordingStartedAt = Date.now();
          logVoiceTiming('Recording started.');
          startMeterPolling(session);
          recordingTimeout = setTimeout(() => {
            void finishRecording(token, session.recorder);
          }, RECORDING_DURATION_MS);
        } catch (error) {
          console.error('Audio recording could not start.', error);
          reportError('microphone-unavailable', errorDetails(error));
        }
      },
      onStopped: () => {
        if (token === startToken) stopListening(false);
      },
    });
  } catch (error) {
    console.error('Microphone recording could not be prepared.', error);
    if (recorderSession) {
      try {
        await cleanupRecorder(recorderSession);
      } catch (cleanupError) {
        console.error('Microphone recorder cleanup failed.', cleanupError);
      }
      if (activeRecorder === recorderSession) activeRecorder = null;
    } else if (recorder) {
      try {
        recorder.release();
      } catch (releaseError) {
        console.error('Unprepared audio recorder could not be released.', releaseError);
      }
    }
    try {
      await restoreAudioMode();
    } catch (modeError) {
      console.error('Audio mode could not be restored after recording setup failed.', modeError);
    }
    if (token === startToken) {
      reportError('microphone-unavailable', errorDetails(error));
    }
  }
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
  if (listening || starting || recorderCleanup) return;
  starting = true;
  const token = ++startToken;
  voiceFlowStartedAt = Date.now();
  logVoiceTiming('Listening flow started.');
  errorReported = false;
  resultCallback = onResult;
  errorCallback = onError;
  setListening(true);

  try {
    if (Platform.OS === 'web') {
      if (typeof window === 'undefined') {
        reportError('unsupported');
        return;
      }
      const browserNavigator = typeof navigator === 'undefined' ? null : navigator as BrowserNavigator;
      const recognitionWindow = window as SpeechRecognitionWindow;
      const Recognition = recognitionWindow.SpeechRecognition ?? recognitionWindow.webkitSpeechRecognition;
      if (!Recognition) {
        reportError('unsupported');
        return;
      }
      if (!browserNavigator?.mediaDevices?.getUserMedia) {
        reportError('microphone-unavailable');
        return;
      }
      let microphoneStream: MediaStream;
      try {
        microphoneStream = await browserNavigator.mediaDevices.getUserMedia({ audio: true });
      } catch (error) {
        const name = error instanceof Error ? error.name : '';
        reportError(name === 'NotAllowedError' || name === 'PermissionDeniedError'
          ? 'permission-denied'
          : 'microphone-unavailable');
        return;
      }
      if (token !== startToken) {
        microphoneStream.getTracks().forEach((track) => track.stop());
        return;
      }
      activeMicrophoneStream = microphoneStream;
      const instance = new Recognition();
      activeWebRecognition = instance;
      let receivedResult = false;
      instance.lang = language;
      instance.interimResults = false;
      instance.maxAlternatives = 1;
      instance.onresult = (event) => {
        const result = event.results[event.resultIndex];
        if (result?.isFinal) {
          receivedResult = true;
          emitResult(result[0].transcript);
        }
      };
      instance.onerror = (event) => reportError(mapRecognitionError(event.error));
      instance.onend = () => {
        if (activeWebRecognition === instance) {
          activeWebRecognition = null;
        }
        releaseMicrophone();
        setListening(false);
        if (!receivedResult && !errorReported) reportError('no-speech');
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

    await startNativeListening(token);
  } catch (error) {
    if (token === startToken) {
      console.error('Voice listening could not start.', error);
      reportError('service-error');
    }
  } finally {
    if (token === startToken) starting = false;
  }
}

export function stopListening(announce = true): void {
  const cleanupErrorCallback = errorCallback;
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
  if (recordingTimeout) {
    clearTimeout(recordingTimeout);
    recordingTimeout = null;
  }
  if (activeRecorder) {
    const session = activeRecorder;
    activeRecorder = null;
    const cleanup = cleanupRecorder(session);
    recorderCleanup = cleanup.then(() => undefined).catch((error: unknown) => {
      console.error('Audio recorder cleanup failed.', error);
      errorReported = true;
      const details = errorDetails(error);
      try {
        cleanupErrorCallback?.('microphone-unavailable', details);
      } catch (callbackError) {
        console.error('Listening cleanup error callback failed.', callbackError);
      }
      if (!cleanupErrorCallback) void speak(messageForError('microphone-unavailable', details));
      return;
    }).finally(() => {
      recorderCleanup = null;
      if (announce && !errorReported) void speak('Stopped listening.');
    });
  } else if (announce) {
    void speak('Stopped listening.');
  }
  resultCallback = undefined;
  errorCallback = undefined;
  setListening(false);
}
