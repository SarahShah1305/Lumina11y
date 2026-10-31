# Voice module

`VoiceProvider` is mounted once around the app in `App.tsx`. Use `useVoice()` from
any descendant screen or component. Speech output uses the device's available
voices and works offline. On iOS and Android, voice commands record a short
audio clip and send it to the Supabase `transcribe-audio` Edge Function, which
uses Gemini to return text. This requires microphone access and an internet
connection. Browser listening continues to use browser speech recognition.

## Speak

```tsx
const { speak, stopSpeaking } = useVoice();

speak('Your reminder is set.');
speak('First line.', { queue: false });
speak('Second line.', { queue: true });
speak('A slower announcement.', { rate: 0.8, pitch: 1, language: 'en-US' });
stopSpeaking();
```

Each new non-queued sentence stops previous speech. Queued sentences are read in
order. The default rate is 1 and follows the existing `settings.speechRate`
preference; `slower` and `faster` adjust the active voice rate within 0.75–1.5.
When a screen reader is enabled, the module uses an accessibility announcement
instead of speaking the same text twice.
For sensitive read-backs, pass `{ rememberLastResponse: false }` so Repeat does
not retain the dictated text.

## Register voice commands

Register commands when a screen mounts, and return the cleanup function from its
effect so the command disappears when the screen closes:

```tsx
const { registerCommand } = useVoice();

useEffect(() => registerCommand(
  ['open notes', 'notes'],
  () => navigate('Notes'),
  'Open your voice notes',
), [navigate, registerCommand]);
```

Matching is case-insensitive, ignores common filler words, and tolerates small
recognition errors. Built-ins include `go back`, `repeat`, `help`, `stop`,
`slower`, `faster`, and `logout`. Provide `onGoBack` and `onLogout` to
`VoiceProvider` to connect the app's own navigation and sign-out behavior.

## Register keyboard shortcuts

Shortcuts are active on web only and require Alt. They are ignored while focus
is in a text input, textarea, select, or content-editable element.

```tsx
const { registerShortcut } = useVoice();

useEffect(() => registerShortcut('Alt+N', 'Open notes', () => navigate('Notes')), [
  navigate,
  registerShortcut,
]);
```

The help command reads all currently registered voice commands and keyboard
shortcuts. Defaults are Alt+H for help, Alt+E for emergency help, Alt+R for
guided typing, and Alt+N for notes. Until the relevant feature registers a
handler, the reserved shortcuts explain that they are not connected yet.
The app also registers Alt+B for back navigation; Arrow Left and Arrow Right
move between screens on web.

## Listening and demo

Use `startListening()` and `stopListening()` from `useVoice()`, or render
`<VoiceButton />` for a large accessible toggle. Recognized text updates
`lastHeard` and is matched against registered commands. For one-shot dictation,
pass a callback to `startListening((text) => ...)`; the callback receives the
recognized text instead of dispatching it as a command.

`VoiceDemoScreen` is a development-only screen for testing speech, listening,
command matching (`demo greeting`), help, and the Alt+G shortcut. Render it under
`VoiceProvider` during development. In the web development app, open
`http://localhost:8081/?voiceDemo=1` to display it; the regular app screens are
unchanged. Web listening requires Chrome's `SpeechRecognition`/
`webkitSpeechRecognition` support, microphone permission, and an internet
connection. Mobile listening requests microphone access, stops any ongoing
speech output, records for 4.5 seconds, and submits the audio to the Edge
Function. A blank transcription is reported as silence. The transcribed text
uses the same command matching as other voice input, and speech output keeps
using the existing `settings.speechRate` preference.

## Set up Gemini transcription

The Gemini key must stay in Supabase, not in the app or an `EXPO_PUBLIC_`
variable. Link the Supabase CLI to this project, then run:

```powershell
npx supabase secrets set GEMINI_API_KEY=YOUR_GEMINI_API_KEY
npx supabase functions deploy transcribe-audio
```

This function is callable before a user signs in so voice navigation works in
the welcome flow. The Gemini key stays server-side; the function only accepts
audio clips up to 1 MB. Set usage limits for the Gemini key in Google AI Studio
and monitor its use. Audio is sent to Gemini for transcription; do not use voice
listening for information you do not want sent to that service.
