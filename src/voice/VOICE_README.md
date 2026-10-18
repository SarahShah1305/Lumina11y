# Voice module

`VoiceProvider` is mounted once around the app in `App.tsx`. Use `useVoice()` from
any descendant screen or component. Speech output uses the device's available
voices and works offline. Speech recognition depends on browser or device
recognition support and may need an internet connection.

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
shortcuts. Defaults are Alt+H for help, Alt+T for photo text, Alt+E for
emergency help, Alt+R for guided typing, and Alt+N for notes. Until the relevant
feature registers a handler, the reserved shortcuts explain that they are not
connected yet.

## Listening and demo

Use `startListening()` and `stopListening()` from `useVoice()`, or render
`<VoiceButton />` for a large accessible toggle. Recognized text updates
`lastHeard` and is matched against registered commands.

`VoiceDemoScreen` is a development-only screen for testing speech, recognition,
command matching (`demo greeting`), help, and the Alt+G shortcut. Render it under
`VoiceProvider` during development. In the web development app, open
`http://localhost:8081/?voiceDemo=1` to display it; the regular app screens are
unchanged. Web recognition requires browser
`SpeechRecognition`/`webkitSpeechRecognition` support and microphone
permission. Android and iOS require a native development build for
`expo-speech-recognition`; Expo Go reports a spoken availability message instead
of crashing. Listening errors, including denied permission, no speech, and
network failure, are spoken with keyboard-shortcut guidance when applicable.
