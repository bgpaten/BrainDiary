import type { PersonaMode, PersonaRouteResult } from '../types/brain'

const MODE_KEYWORDS: Record<PersonaMode, string[]> = {
  social_response: [],
  factual_brain_reader: [
    'apa itu',
    'hubungan',
    'project apa',
    'siapa',
    'kapan',
    'berapa',
    'data',
    'muncul',
    'sering',
  ],
  self_clone_reflection: [
    'saya ini orang seperti apa',
    'pola pikir',
    'takut',
    'sebenarnya saya',
    'yang saya kejar',
    'diri saya',
    'refleksi',
    'menurut diary',
  ],
  strategic_mirror: [
    'harus fokus',
    'fokuskan',
    'apa yang salah',
    'langkah paling cepat',
    'menghambat',
    'strategi',
    'prioritas',
    'eksekusi',
  ],
  diary_owner_voice: [
    'jawab seperti saya',
    'kalau saya yang ngomong',
    'gaya saya',
    'seolah kamu',
    'versi diary saya',
    'seperti pemilik diary',
  ],
  contradiction_detector: [
    'tidak saya lakukan',
    'kontradiksi',
    'pola buruk',
    'romantisasi',
    'saya bilang tapi',
    'bohongi diri',
    'menghindar',
  ],
  planning_guard: [
    'fitur apa lagi',
    'roadmap besar',
    'tambah agent',
    'fase berikutnya',
    'lanjut fitur',
    'bikin fitur',
    'next phase',
  ],
  unknown_or_insufficient_memory: [],
}

export function normalizeQuestion(question: string): string {
  return question.toLowerCase().trim().replace(/[^a-z0-9\s]+/g, ' ').replace(/\s+/g, ' ')
}

export function detectPersonaMode(question: string, context?: { sourceCount?: number; warnings?: string[] }): PersonaRouteResult {
  const normalized = normalizeQuestion(question)
  if (isSocialGreeting(normalized)) {
    return {
      mode: 'social_response',
      reason: 'Pertanyaan adalah sapaan ringan, jadi jawab pendek tanpa retrieval report.',
      confidence: 0.82,
    }
  }
  const sourceCount = context?.sourceCount ?? 1
  if (sourceCount === 0) {
    return {
      mode: 'unknown_or_insufficient_memory',
      reason: 'Context retrieval tidak menemukan memory relevan.',
      confidence: 0.9,
    }
  }

  const scores = new Map<PersonaMode, number>()
  for (const [mode, keywords] of Object.entries(MODE_KEYWORDS) as Array<[PersonaMode, string[]]>) {
    scores.set(mode, keywords.reduce((score, keyword) => score + (normalized.includes(keyword) ? 1 : 0), 0))
  }

  if (/\b(apa|siapa|kapan|berapa|hubungan|project)\b/.test(normalized)) {
    scores.set('factual_brain_reader', (scores.get('factual_brain_reader') ?? 0) + 1)
  }
  if (/\b(fokus|prioritas|strategi|cepat|hambat|salah)\b/.test(normalized)) {
    scores.set('strategic_mirror', (scores.get('strategic_mirror') ?? 0) + 1)
  }
  if (/\b(kontradiksi|buruk|romantisasi|tidak saya lakukan)\b/.test(normalized)) {
    scores.set('contradiction_detector', (scores.get('contradiction_detector') ?? 0) + 2)
  }

  const ranked = [...scores.entries()].sort((a, b) => b[1] - a[1])
  const [mode, score] = ranked[0]
  if (!mode || score <= 0) {
    return {
      mode: context?.warnings?.length ? 'unknown_or_insufficient_memory' : 'factual_brain_reader',
      reason: context?.warnings?.length ? 'Context memiliki warning dan intent tidak jelas.' : 'Pertanyaan paling dekat dengan pembacaan factual.',
      confidence: 0.45,
    }
  }

  return {
    mode,
    reason: reasonForMode(mode),
    confidence: Math.min(0.95, 0.55 + score * 0.12),
  }
}

function reasonForMode(mode: PersonaMode): string {
  const reasons: Record<PersonaMode, string> = {
    social_response: 'Pertanyaan adalah sapaan ringan, jadi jawab pendek tanpa retrieval report.',
    factual_brain_reader: 'Pertanyaan meminta fakta/data dari brain.',
    self_clone_reflection: 'Pertanyaan meminta refleksi diri berdasarkan diary dan memory.',
    strategic_mirror: 'Pertanyaan meminta evaluasi strategi, fokus, atau langkah eksekusi.',
    diary_owner_voice: 'Pertanyaan meminta jawaban dengan gaya komunikasi pemilik diary.',
    contradiction_detector: 'Pertanyaan meminta konflik antara klaim, pola, dan perilaku.',
    planning_guard: 'Pertanyaan mengarah ke penambahan fitur/roadmap sehingga perlu guard terhadap scope creep.',
    unknown_or_insufficient_memory: 'Memory relevan belum cukup untuk menjawab dengan aman.',
  }
  return reasons[mode]
}

function isSocialGreeting(normalized: string): boolean {
  return [
    /^hi+$/i,
    /^hai+$/i,
    /^halo+$/i,
    /^hello+$/i,
    /^p+$/i,
    /^ping$/i,
    /^bro+$/i,
    /^yo$/i,
    /^hei$/i,
    /^assalamu\s?alaikum/i,
    /^salam/i,
    /^selamat pagi$/i,
    /^selamat siang$/i,
    /^selamat sore$/i,
    /^selamat malam$/i,
  ].some((pattern) => pattern.test(normalized))
}
