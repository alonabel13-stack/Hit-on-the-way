// Public settings. None of these are secrets: the Supabase "anon" key only allows
// calling the game's functions, and the Spotify Client ID is shown during sign-in anyway.
export const CONFIG = {
  supabaseUrl: 'https://YOUR-PROJECT.supabase.co',
  supabaseAnonKey: 'YOUR-SUPABASE-ANON-KEY',
  spotifyClientId: '5acdccad5a7544cbad21108f1e9b46fc',
};

// For local testing only: a JSON object saved in localStorage under "hotw_config_override"
// replaces any of the values above on this device.
try {
  const o = JSON.parse(localStorage.getItem('hotw_config_override') || 'null');
  if (o && typeof o === 'object') Object.assign(CONFIG, o);
} catch {}

export const isConfigured = () => !CONFIG.supabaseUrl.includes('YOUR-PROJECT');
