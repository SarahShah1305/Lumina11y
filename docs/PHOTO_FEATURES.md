# Photo features

The Photo helper lets a signed-in user use the phone camera or choose a picture
from the gallery. It has four modes:

- **Read text** reads visible writing as printed and marks unclear words as
  `[unclear]` rather than guessing.
- **Describe picture** gives a short description for a blind or low-vision user.
- **Medicine label** reads the name, strength, form, expiry, instructions, and
  warnings that are visible on the package. It does not invent label details or
  advise a dose, and it reminds the user to confirm with a pharmacist or doctor.
- **Currency note** tries to identify Pakistani rupee notes in denominations of
  10, 20, 50, 100, 500, 1,000, or 5,000.

## Photo files

- `src/photo/PhotoFlow.tsx` contains the photo screens: mode selection, camera
  permission, live preview, gallery selection, loading, and results. It speaks
  the instructions and results using the shared voice provider and applies the
  user's palette and text scale.
- `src/photo/analyzeImage.ts` prepares and sends a photo. It resizes the image
  to about 1,024 pixels wide, compresses it as JPEG at about 60% quality,
  converts it to base64 without a data URL prefix, and calls the
  `analyze-image` Supabase function. It also handles timeouts and friendly
  errors.

## How image analysis works

The app calls the Supabase Edge Function named `analyze-image` with the photo
and selected mode. The function requires a signed-in user, checks that the
image is within the roughly 4 MB limit, and sends the image to Gemini. It asks
Gemini for structured JSON with the recognized text, description, quality,
confidence, and mode-specific details. The function uses the
`gemini-3.5-flash-lite` model and returns the parsed result to the app.

The Gemini credential is kept on the server as a Supabase Edge Function secret
named `GEMINI_API_KEY`. The function reads it from `Deno.env`; the app never
receives or sends that Gemini key. The app uses the existing Supabase client to
call the function. Do not add the Gemini key to `.env`, app configuration, or
any `EXPO_PUBLIC_` variable.

To deploy, make sure the Supabase project is linked, add `GEMINI_API_KEY` in
the Supabase project's Edge Function secrets, then deploy the function:

```sh
npx supabase functions deploy analyze-image
```

## Photo quality and confidence

When the function reports an image quality issue, PhotoFlow shows and speaks a
matching guide, then offers **Try again** to return to the camera:

- **Too dark:** turn on a light or move somewhere brighter.
- **Too bright:** move away from direct light.
- **Too blurry:** hold the phone steady.
- **Too far:** move closer to the object.
- **Too close:** move the phone further back.
- **Partly cut off:** keep the whole object in view.

The app also checks the result's confidence. A high-confidence result is read
normally. A medium-confidence result starts with “I think this says” (or “I
think this shows” for a description) and asks the listener to check it if it
matters. A low-confidence result starts with “I'm not fully sure” and asks for
another photo. For low-confidence currency, it says it is not sure about the
note and asks someone to check it. If no text is found in Read text mode, the
app says so and suggests moving closer or adding more light.

## Shared files

- `App.tsx` registers PhotoFlow as a signed-in screen, passes the current
  palette and text scale, provides the return-to-Home callback, and adds the
  **Read with camera** menu option and voice commands.
- `supabase/functions/analyze-image/index.ts` is the server-side function that
  authenticates the request, calls Gemini, validates its JSON response, and
  returns friendly errors.

The photo feature reuses `src/lib/supabase.ts` and `src/voice/`; those shared
modules were not changed to add the photo feature.

## Test on a phone

1. Configure the app's Supabase URL and publishable key in the ignored local
   `.env` file. Configure the Gemini key as the Supabase Edge Function secret,
   then deploy `analyze-image` as described above.
2. From the project folder, start Expo with `npx expo start --clear`, then scan
   its QR code with Expo Go on the phone. Keep the phone and computer on the
   same Wi-Fi network, or use Expo's tunnel option if needed.
3. Sign in and tap **Read with camera**. Choose each mode and grant camera
   permission when asked. If permission was denied, use **Open settings** to
   allow it.
4. Take a photo, then try **Read again**, **Stop reading**, **Take another
   photo**, and **Back**. Also try **Choose from gallery**.
5. Try a dark, blurry, distant, or partly cut-off image to hear the quality
   guide. Try clear and difficult-to-read images to hear how confidence changes
   the wording. Test currency with a Pakistani rupee note.

Image analysis needs an internet connection and a signed-in session. Camera and
gallery access depend on the phone's permissions.
