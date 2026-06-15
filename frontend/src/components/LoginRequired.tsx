import { useState } from 'react'
import { supabase } from '../lib/supabase'

// Login MINIMAL (email + password). Sesuai batasan fase: tidak membangun
// sistem auth kompleks. User dibuat lewat Supabase Dashboard / sign up.
// RLS butuh session agar bisa membaca brain data milik user.
export function LoginRequired() {
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function handleLogin(e: React.FormEvent) {
    e.preventDefault()
    setBusy(true)
    setError(null)
    const { error } = await supabase.auth.signInWithPassword({ email, password })
    setBusy(false)
    if (error) setError(error.message)
    // sukses → onAuthStateChange di App akan memuat ulang.
  }

  return (
    <div className="login-required">
      <div className="empty-state__icon">🔒</div>
      <h2 className="empty-state__title">Login diperlukan untuk membaca brain data</h2>
      <p className="empty-state__message">
        Karena Row Level Security aktif, kamu harus login agar bisa melihat node &amp; edge milikmu.
      </p>

      <form className="login-form" onSubmit={handleLogin}>
        <input
          type="email"
          placeholder="Email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          required
        />
        <input
          type="password"
          placeholder="Password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          required
        />
        <button type="submit" className="btn btn--primary" disabled={busy}>
          {busy ? 'Masuk…' : 'Login'}
        </button>
      </form>

      {error && <p className="status status--err">✕ {error}</p>}
      <p className="empty-state__hint">
        Belum punya akun? Buat user lewat Supabase Dashboard → Authentication → Users, lalu pastikan
        user_id pada data seed diganti ke id user tersebut.
      </p>
    </div>
  )
}
