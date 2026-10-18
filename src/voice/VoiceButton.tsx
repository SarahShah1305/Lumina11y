import React from 'react';
import { Pressable, StyleSheet, Text } from 'react-native';
import { useVoice } from './VoiceContext';

export function VoiceButton() {
  const { isListening, startListening, stopListening } = useVoice();
  const label = isListening ? 'Stop listening' : 'Tap to speak';

  return (
    <Pressable
      accessibilityLabel={label}
      accessibilityHint={isListening ? 'Stops listening for a voice command' : 'Starts listening for a voice command'}
      accessibilityRole="button"
      accessibilityState={{ busy: isListening }}
      onPress={() => {
        if (isListening) stopListening();
        else void startListening();
      }}
      style={({ pressed }) => [styles.button, pressed && styles.pressed]}
    >
      <Text style={styles.label}>{isListening ? 'Stop listening' : 'Tap to speak'}</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  button: {
    alignItems: 'center',
    backgroundColor: '#005b75',
    borderColor: '#003747',
    borderRadius: 18,
    borderWidth: 3,
    justifyContent: 'center',
    minHeight: 72,
    minWidth: 220,
    paddingHorizontal: 24,
    paddingVertical: 16,
  },
  pressed: { opacity: 0.78 },
  label: { color: '#ffffff', fontSize: 22, fontWeight: '800', textAlign: 'center' },
});
