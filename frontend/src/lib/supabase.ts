import { createClient } from '@supabase/supabase-js'

const supabaseUrl = import.meta.env.VITE_SUPABASE_URL
const supabaseAnonKey = import.meta.env.VITE_SUPABASE_ANON_KEY

// True kalau env Supabase sudah diisi. Dipakai App untuk menampilkan
// pesan konfigurasi yang jelas saat .env belum disetel.
export const supabaseConfigured = Boolean(supabaseUrl && supabaseAnonKey)

// CATATAN KEAMANAN:
// - Hanya memakai ANON key. RLS (auth.uid() = user_id) yang melindungi data.
// - JANGAN pernah memasukkan service_role key ke frontend.
export const supabase = createClient(
  supabaseUrl ?? 'http://localhost',
  supabaseAnonKey ?? 'public-anon-key-missing',
  {
    auth: {
      persistSession: true,
      autoRefreshToken: true,
    },
  },
)
