interface EmptyBrainStateProps {
  title: string
  message: string
  hint?: string
}

// Dipakai untuk berbagai kondisi "tidak ada graph": belum login, belum ada
// data seed, env belum disetel, dll. Tampil di tengah area visualizer.
export function EmptyBrainState({ title, message, hint }: EmptyBrainStateProps) {
  return (
    <div className="empty-state">
      <div className="empty-state__icon">🧠</div>
      <h2 className="empty-state__title">{title}</h2>
      <p className="empty-state__message">{message}</p>
      {hint && <p className="empty-state__hint">{hint}</p>}
    </div>
  )
}
