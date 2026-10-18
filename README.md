# Lumina11y

Lumina11y is an accessibility-focused Expo app for blind and low-vision users. Person 1's foundation includes the welcome flow, a step-by-step tutorial, Supabase account access, and saved accessibility preferences.

## What works in this milestone

- Welcome and tutorial screens, with accessible headings, button names, and spoken step announcements.
- Email/password account creation, sign-in, persistent sessions, and sign-out through Supabase Auth.
- An accessibility settings page for text size, colour theme, and preferred speech speed.
- Settings cached on the phone and synced to that signed-in user's Supabase row.
- Row Level Security policies so authenticated users can only read or change their own settings.

The voice speed is saved as a preference for Person 2's voice work to use. Voice playback itself is not connected yet. Notes, reminders, photo descriptions, and emergency contacts remain later work.

## Connect the Supabase backend

This repository contains the app integration and the SQL migration. It does not contain a Supabase project or its connection values; those belong to the team.

1. Create or select the team's Supabase project.
2. In Supabase **SQL Editor**, run [`supabase/migrations/20261018000000_user_settings.sql`](supabase/migrations/20261018000000_user_settings.sql). Supabase Auth stores registered accounts in its managed `auth.users` table; the migration creates `public.user_settings` linked to each account.
3. In the Supabase project, copy the **Project URL** and **publishable key** from the Connect/API settings. Do not use a `service_role` or secret key in the mobile app.
4. Copy `.env.example` to `.env` in this folder and fill in the project URL and publishable key:

   ```text
   EXPO_PUBLIC_SUPABASE_URL=https://your-project-id.supabase.co
   EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY=your-publishable-key
   ```

5. In Supabase Authentication settings, choose whether new accounts require email confirmation. When confirmation is enabled, users must confirm the message sent to their email before signing in.
6. Start or restart Expo after saving `.env` so the app loads the values.

The publishable key is included in the app bundle by design. Row Level Security in the migration protects user data; never put the Supabase secret/service-role key in `.env` for this app.

## Run in Expo Go

From the repository folder, run:

```sh
npm install
npx expo start --clear
```

Scan the QR code with Expo Go. Keep the phone and computer on the same Wi-Fi network. Use `npx expo start --tunnel` if local network discovery is blocked. Press `Ctrl+C` to stop the server.

## Settings data flow

After sign-in, Lumina11y loads the account's `user_settings` row. If one does not exist, it creates a row with the defaults. Changing a setting updates the screen immediately, caches it on the phone, and writes it to that user's row. If the network or Supabase is unavailable, the app reports that the change stayed on the phone and could not sync.

The settings columns are `text_scale`, `color_theme`, and `speech_rate`. Voice implementation should read `speech_rate` from the app's settings state (and not create a second voice-speed preference).

## Person 2 handoff

- Supabase client: `src/lib/supabase.ts`.
- Preference types and defaults: `src/types.ts`.
- Per-user load/save and local cache: `src/lib/preferences.ts`.
- Database table and owner-only policies: `supabase/migrations/20261018000000_user_settings.sql`.
- App screens and flow: `App.tsx`.

Person 2 can connect voice playback to `settings.speechRate` in `App.tsx`/`src/types.ts`. Keep the existing per-user setting and its database column as the single source of truth.
