import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { CameraView, useCameraPermissions, type CameraCapturedPicture } from 'expo-camera';
import * as ImagePicker from 'expo-image-picker';
import { Linking, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { useVoice } from '../voice';
import { analyzeImage, type PhotoAnalysis, type PhotoMode, type PhotoQuality } from './analyzeImage';

type Palette = {
  background: string;
  card: string;
  text: string;
  muted: string;
  accent: string;
  accentText: string;
  border: string;
  input: string;
};

type PhotoFlowProps = {
  palette: Palette;
  scale: number;
  onBack: () => void;
};

type ViewName = 'mode' | 'camera' | 'loading' | 'result';

const modeOptions: { label: string; mode: PhotoMode }[] = [
  { label: 'Read text', mode: 'text' },
  { label: 'Describe picture', mode: 'describe' },
  { label: 'Medicine label', mode: 'medicine' },
  { label: 'Currency note', mode: 'currency' },
];

const qualityMessages: Partial<Record<PhotoQuality, string>> = {
  too_dark: 'It is too dark. Turn on a light or move to a brighter place, then try again.',
  too_bright: 'It is too bright. Move away from direct light and try again.',
  too_blurry: 'The photo is blurry. Hold the phone steady and try again.',
  too_far: 'Move closer to the object and try again.',
  too_close: 'Move the phone a little further back and try again.',
  partly_cut_off: 'Part of the object is cut off. Keep the whole object in view and try again.',
};

function PhotoButton({
  label,
  onPress,
  palette,
  scale,
  secondary = false,
  large = false,
}: {
  label: string;
  onPress: () => void;
  palette: Palette;
  scale: number;
  secondary?: boolean;
  large?: boolean;
}) {
  return (
    <Pressable
      accessibilityLabel={label}
      accessibilityRole="button"
      onPress={onPress}
      style={({ pressed }) => [
        styles.button,
        large && styles.largeButton,
        {
          backgroundColor: secondary ? palette.card : palette.accent,
          borderColor: secondary ? palette.border : palette.accent,
          borderWidth: secondary ? 2 : 0,
          opacity: pressed ? 0.78 : 1,
        },
      ]}
    >
      <Text style={{
        color: secondary ? palette.text : palette.accentText,
        fontSize: (large ? 22 : 19) * scale,
        lineHeight: (large ? 30 : 26) * scale,
        fontWeight: '800',
        textAlign: 'center',
      }}>{label}</Text>
    </Pressable>
  );
}

function detailText(value: unknown): string {
  if (typeof value === 'string') return value.trim();
  if (typeof value === 'number') return String(value);
  return '';
}

function resultSpeech(mode: PhotoMode, result: PhotoAnalysis): string {
  if (mode === 'currency' && result.confidence === 'low') {
    return 'I\'m not sure about this note. Please ask someone to check it.';
  }

  let content = '';
  if (mode === 'medicine') {
    const fields = [
      ['Name', result.details.name],
      ['Strength', result.details.strength],
      ['Form', result.details.form],
      ['Expiry', result.details.expiry],
      ['Instructions on label', result.details.instructionsOnLabel],
      ['Warnings on label', result.details.warningsOnLabel],
    ] as const;
    content = fields.map(([label, value]) => {
      const text = detailText(value);
      return text ? `${label}: ${text}.` : '';
    }).filter(Boolean).join(' ');
    if (!content) content = 'I could not read any medicine label information.';
  } else if (mode === 'currency') {
    const denomination = detailText(result.details.denomination);
    const currency = detailText(result.details.currency);
    content = denomination
      ? `This looks like a ${denomination} ${currency || 'rupee'} note.`
      : 'I could not identify the denomination.';
    const side = detailText(result.details.side);
    if (side && side !== 'unknown') content += ` This appears to show the ${side} side.`;
  } else if (mode === 'describe') {
    content = result.description || result.text;
  } else {
    content = result.text;
    if (!content) return 'I could not find any text. Try moving closer or adding more light.';
  }

  if (result.confidence === 'medium') {
    const intro = mode === 'describe' ? 'I think this shows' : 'I think this says';
    content = `${intro} ${content} Please check if it matters.`;
  } else if (result.confidence === 'low') {
    content = `I'm not fully sure. ${content} Please take another photo to be sure.`;
  }

  if (mode === 'medicine') {
    content += ' Please confirm with a pharmacist or doctor before taking any medicine.';
  }
  return content;
}

export function PhotoFlow({ palette, scale, onBack }: PhotoFlowProps) {
  const { speak, stopSpeaking } = useVoice();
  const [view, setView] = useState<ViewName>('mode');
  const [mode, setMode] = useState<PhotoMode>('text');
  const [result, setResult] = useState<PhotoAnalysis | null>(null);
  const [errorMessage, setErrorMessage] = useState('');
  const [permission, requestPermission] = useCameraPermissions();
  const cameraRef = useRef<CameraView>(null);
  const resultMessage = useMemo(() => result ? resultSpeech(mode, result) : '', [mode, result]);
  const qualityMessage = result ? qualityMessages[result.quality] : undefined;

  useEffect(() => {
    speak('Choose what you want to do with the camera.');
    return () => stopSpeaking();
  }, [speak, stopSpeaking]);

  useEffect(() => {
    if (view === 'camera' && permission && !permission.granted) {
      speak('Camera permission is needed. Allow camera access to take a photo, or choose one from your gallery.');
    }
  }, [permission, speak, view]);

  const analyzePhoto = useCallback(async (uri: string, selectedMode = mode) => {
    stopSpeaking();
    setErrorMessage('');
    setResult(null);
    setView('loading');
    speak('Reading your photo, please wait');
    try {
      const analysis = await analyzeImage(uri, selectedMode);
      stopSpeaking();
      setResult(analysis);
      setView('result');
    } catch (error) {
      stopSpeaking();
      const message = error instanceof Error ? error.message : 'The photo could not be analyzed. Please try again.';
      setErrorMessage(message);
      setView('camera');
      speak(message);
    }
  }, [mode, speak, stopSpeaking]);

  useEffect(() => {
    if (view !== 'result' || !result) return;
    stopSpeaking();
    speak(qualityMessage || resultMessage);
  }, [qualityMessage, result, resultMessage, speak, stopSpeaking, view]);

  const selectMode = (selectedMode: PhotoMode) => {
    stopSpeaking();
    setMode(selectedMode);
    setErrorMessage('');
    setView('camera');
  };

  const takePhoto = async () => {
    if (!cameraRef.current) return;
    try {
      const picture: CameraCapturedPicture | undefined = await cameraRef.current.takePictureAsync({ quality: 0.8 });
      if (picture?.uri) await analyzePhoto(picture.uri);
    } catch {
      const message = 'The camera could not take a photo. Please try again.';
      setErrorMessage(message);
      speak(message);
    }
  };

  const chooseFromGallery = async () => {
    try {
      const choice = await ImagePicker.launchImageLibraryAsync({
        mediaTypes: ['images'],
        allowsEditing: false,
        quality: 1,
      });
      if (!choice.canceled && choice.assets[0]?.uri) await analyzePhoto(choice.assets[0].uri);
    } catch {
      const message = 'The photo gallery could not be opened. Please try again.';
      setErrorMessage(message);
      speak(message);
    }
  };

  const goBack = () => {
    stopSpeaking();
    onBack();
  };

  const openSettings = async () => {
    try {
      await Linking.openSettings();
    } catch {
      const message = 'Open your device settings and allow camera access for this app.';
      setErrorMessage(message);
      speak(message);
    }
  };

  const title = view === 'mode' ? 'Photo helper' : view === 'camera' ? 'Take a photo' :
    view === 'loading' ? 'Reading your photo' : qualityMessage ? 'Try another photo' : 'Photo result';

  return (
    <View style={[styles.container, { backgroundColor: palette.background }]}>
      <ScrollView contentContainerStyle={styles.content}>
        <Text accessibilityRole="header" style={{ color: palette.text, fontSize: 30 * scale, lineHeight: 38 * scale, fontWeight: '900' }}>
          {title}
        </Text>

        {view === 'mode' && (
          <View style={styles.actions}>
            {modeOptions.map((option) => (
              <PhotoButton key={option.mode} label={option.label} onPress={() => selectMode(option.mode)} palette={palette} scale={scale} large />
            ))}
            <PhotoButton label="Back" onPress={goBack} palette={palette} scale={scale} secondary />
          </View>
        )}

        {view === 'camera' && (
          <View style={styles.actions}>
            {errorMessage ? <Text accessibilityLiveRegion="polite" style={{ color: palette.text, fontSize: 20 * scale, lineHeight: 28 * scale }}>{errorMessage}</Text> : null}
            {!permission?.granted ? (
              <>
                <Text style={{ color: palette.text, fontSize: 20 * scale, lineHeight: 28 * scale }}>
                  Camera permission is needed. Allow camera access to take a photo, or choose one from your gallery.
                </Text>
                {permission?.canAskAgain && <PhotoButton label="Allow camera access" onPress={() => { void requestPermission(); }} palette={palette} scale={scale} large />}
                <PhotoButton label="Open settings" onPress={() => { void openSettings(); }} palette={palette} scale={scale} large />
              </>
            ) : (
              <CameraView ref={cameraRef} style={styles.camera} facing="back" />
            )}
            {permission?.granted && <PhotoButton label="Take photo" onPress={() => { void takePhoto(); }} palette={palette} scale={scale} large />}
            <PhotoButton label="Choose from gallery" onPress={() => { void chooseFromGallery(); }} palette={palette} scale={scale} secondary />
            <PhotoButton label="Back" onPress={() => { stopSpeaking(); setErrorMessage(''); setView('mode'); }} palette={palette} scale={scale} secondary />
          </View>
        )}

        {view === 'loading' && (
          <Text accessibilityLiveRegion="polite" style={{ color: palette.text, fontSize: 22 * scale, lineHeight: 32 * scale }}>
            Reading your photo, please wait.
          </Text>
        )}

        {view === 'result' && result && (
          <View style={styles.actions}>
            {qualityMessage ? (
              <>
                <Text accessibilityLiveRegion="polite" style={{ color: palette.text, fontSize: 22 * scale, lineHeight: 32 * scale, fontWeight: '700' }}>{qualityMessage}</Text>
                <PhotoButton label="Try again" onPress={() => { stopSpeaking(); setView('camera'); }} palette={palette} scale={scale} large />
              </>
            ) : (
              <>
                {result.text ? <Text style={{ color: palette.text, fontSize: 22 * scale, lineHeight: 32 * scale }}>{result.text}</Text> :
                  mode === 'text' ? <Text style={{ color: palette.text, fontSize: 22 * scale, lineHeight: 32 * scale }}>I could not find any text. Try moving closer or adding more light.</Text> : null}
                {result.description ? <Text style={{ color: palette.text, fontSize: 22 * scale, lineHeight: 32 * scale }}>{result.description}</Text> : null}
                {mode === 'medicine' && (
                  <View style={styles.details}>
                    {([
                      ['Name', result.details.name],
                      ['Strength', result.details.strength],
                      ['Form', result.details.form],
                      ['Expiry', result.details.expiry],
                      ['Instructions on label', result.details.instructionsOnLabel],
                      ['Warnings on label', result.details.warningsOnLabel],
                    ] as const).map(([label, value]) => {
                      const text = detailText(value);
                      return text ? <Text key={label} style={{ color: palette.text, fontSize: 19 * scale, lineHeight: 27 * scale }}>{label}: {text}</Text> : null;
                    })}
                  </View>
                )}
                {mode === 'currency' && <Text style={{ color: palette.text, fontSize: 19 * scale, lineHeight: 27 * scale }}>{detailText(result.details.denomination)} {detailText(result.details.currency)} · {detailText(result.details.side)}</Text>}
                <PhotoButton label="Read again" onPress={() => speak(resultMessage)} palette={palette} scale={scale} secondary />
                <PhotoButton label="Stop reading" onPress={stopSpeaking} palette={palette} scale={scale} secondary />
                <PhotoButton label="Take another photo" onPress={() => { stopSpeaking(); setErrorMessage(''); setView('camera'); }} palette={palette} scale={scale} large />
              </>
            )}
            <PhotoButton label="Back" onPress={goBack} palette={palette} scale={scale} secondary />
          </View>
        )}
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  content: { gap: 16, padding: 16, paddingBottom: 28 },
  actions: { gap: 12, marginTop: 8 },
  button: { alignItems: 'center', borderRadius: 16, justifyContent: 'center', minHeight: 60, paddingHorizontal: 18, paddingVertical: 12 },
  largeButton: { minHeight: 76 },
  camera: { alignSelf: 'stretch', height: 340, overflow: 'hidden', borderColor: '#526e7c', borderRadius: 16, borderWidth: 2 },
  details: { gap: 8 },
});
