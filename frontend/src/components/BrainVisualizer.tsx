import { useEffect, useRef } from 'react'
import CytoscapeComponent from 'react-cytoscapejs'
import type { Core, ElementDefinition } from 'cytoscape'

interface BrainVisualizerProps {
  elements: ElementDefinition[]
  onNodeClick: (nodeId: string) => void
  onBackgroundClick: () => void
  // berubah saat filter berubah → memicu re-layout.
  layoutKey: string
}

// Stylesheet Cytoscape. Aturan visual:
// - ukuran node = data(size)  (dari frequency_score)
// - ketebalan border = data(borderWidth) (dari importance_score)
// - opacity = data(opacity)   (confidence rendah → redup)
// - lebar edge = data(width)  (dari weight)
// - label node = name, label edge = relation_type
// - node berbentuk lingkaran kecil ala graph view Obsidian; warna membedakan type/cluster
const stylesheet = [
  {
    selector: 'node',
    style: {
      label: 'data(label)',
      shape: 'ellipse',
      'background-color': 'data(color)',
      width: 'data(size)',
      height: 'data(size)',
      'font-size': 'data(fontSize)',
      'border-width': 'data(borderWidth)',
      'border-color': 'rgba(226, 232, 240, 0.36)',
      opacity: 'data(opacity)',
      color: '#cbd5e1',
      'text-valign': 'bottom',
      'text-halign': 'center',
      'text-margin-y': 4,
      'text-outline-width': 2,
      'text-outline-color': '#0a0a0b',
      'min-zoomed-font-size': 8,
      // transisi halus untuk perubahan visual (mis. saat hover/seleksi).
      'transition-property': 'background-color, border-color, width, height',
      'transition-duration': '320ms',
    },
  },
  // tanda khusus confidence rendah: border putus-putus.
  {
    selector: 'node[lowConfidence = 1]',
    style: {
      'border-style': 'dashed',
      'border-color': '#94a3b8',
    },
  },
  {
    selector: 'node[pendingReview = 1]',
    style: {
      'border-color': '#fbbf24',
    },
  },
  {
    selector: 'node:selected',
    style: {
      'border-width': 4,
      'border-color': '#38bdf8',
    },
  },
  {
    selector: 'edge',
    style: {
      label: 'data(label)',
      width: 'data(width)',
      'line-color': 'rgba(100, 116, 139, 0.46)',
      'target-arrow-color': 'rgba(100, 116, 139, 0.46)',
      'target-arrow-shape': 'triangle',
      'curve-style': 'bezier',
      'font-size': 8,
      color: '#8b97aa',
      'text-rotation': 'autorotate',
      'text-background-color': '#0a0a0b',
      'text-background-opacity': 0.7,
      'text-background-padding': 2,
      'min-zoomed-font-size': 7,
    },
  },
  // edge yang sudah invalid → putus-putus & redup.
  {
    selector: 'edge[invalid = 1]',
    style: {
      'line-style': 'dashed',
      opacity: 0.4,
    },
  },
  {
    selector: 'edge:selected',
    style: {
      'line-color': '#38bdf8',
      'target-arrow-color': '#38bdf8',
    },
  },
]

// Layout force-directed (cose) → node menyebar organik & saling tarik-menarik
// berdasar relasi, membentuk kluster alami persis seperti graph view Obsidian.
// Tidak ada cincin/lingkaran paksa: posisi ditentukan simulasi gaya pegas.
const layout = {
  name: 'cose',
  animate: true,
  animationDuration: 900,
  animationEasing: 'ease-in-out-cubic' as const,
  // randomize awal supaya tiap run menyebar, lalu disettle oleh gaya.
  randomize: true,
  // gaya tolak antar-node (semakin besar → node makin merenggang).
  nodeRepulsion: () => 12000,
  // panjang ideal pegas (edge); jarak target antar node yang terhubung.
  idealEdgeLength: () => 120,
  // tarikan pegas pada edge.
  edgeElasticity: () => 120,
  // gravitasi lembut menjaga komponen lepas tidak terbang jauh.
  gravity: 0.4,
  // hindari node bertumpuk.
  nodeOverlap: 16,
  componentSpacing: 90,
  numIter: 1200,
  coolingFactor: 0.95,
  initialTemp: 220,
  padding: 40,
}

// Parameter animasi drift "mengambang" yang lambat & organik.
// Amplitudo dibuat cukup besar agar tetap terlihat meski graph di-zoom-to-fit.
const DRIFT_RADIUS = 14 // amplitudo gerak (px, koordinat model) di sekitar posisi dasar
const DRIFT_SPEED = 0.0011 // kecepatan sudut; ~1 putaran penuh per ~6 detik (slow tapi terlihat)

export function BrainVisualizer({
  elements,
  onNodeClick,
  onBackgroundClick,
  layoutKey,
}: BrainVisualizerProps) {
  const cyRef = useRef<Core | null>(null)
  const rafRef = useRef<number | null>(null)
  // Posisi dasar tiap node disimpan sebagai koordinat absolut (x, y) hasil
  // layout force-directed, plus fase & frekuensi acak untuk drift mengambang.
  const basePosRef = useRef<
    Map<string, { x: number; y: number; phase: number; freq: number }>
  >(new Map())
  // node yang sedang di-drag tidak boleh di-drift agar tidak "melawan" kursor.
  const draggingRef = useRef<Set<string>>(new Set())

  // Rekam posisi dasar tiap node setelah layout selesai.
  const captureBasePositions = (cy: Core) => {
    const map = basePosRef.current
    map.clear()
    cy.nodes().forEach((n) => {
      const p = n.position()
      map.set(n.id(), {
        x: p.x,
        y: p.y,
        // fase & frekuensi acak → tiap node mengambang beda ritme.
        phase: Math.random() * Math.PI * 2,
        freq: 0.6 + Math.random() * 0.8,
      })
    })
  }

  // Loop animasi: geser tiap node sedikit di sekeliling posisi dasarnya
  // (drift Lissajous lembut), tanpa rotasi global — layout tetap organik.
  const startDrift = (cy: Core) => {
    if (rafRef.current !== null) cancelAnimationFrame(rafRef.current)

    const tick = (t: number) => {
      const map = basePosRef.current
      const dragging = draggingRef.current
      cy.batch(() => {
        cy.nodes().forEach((n) => {
          const id = n.id()
          if (dragging.has(id)) return
          const base = map.get(id)
          if (!base) return
          // drift "mengambang" lembut (Lissajous) di sekitar posisi dasar.
          const a = t * DRIFT_SPEED * base.freq + base.phase
          n.position({
            x: base.x + Math.cos(a) * DRIFT_RADIUS,
            y: base.y + Math.sin(a * 0.9) * DRIFT_RADIUS,
          })
        })
      })
      rafRef.current = requestAnimationFrame(tick)
    }
    rafRef.current = requestAnimationFrame(tick)
  }

  // Pasang event handler sekali saat cy tersedia.
  const handleCy = (cy: Core) => {
    if (cyRef.current === cy) return
    cyRef.current = cy

    cy.on('tap', 'node', (evt) => {
      onNodeClick(evt.target.id())
    })
    cy.on('tap', (evt) => {
      // tap pada background (bukan node/edge) → tutup detail.
      if (evt.target === cy) onBackgroundClick()
    })

    // Saat user men-drag node, hentikan drift node itu lalu adopsi
    // posisi barunya sebagai posisi dasar setelah dilepas.
    cy.on('grab', 'node', (evt) => {
      draggingRef.current.add(evt.target.id())
    })
    cy.on('free', 'node', (evt) => {
      const n = evt.target
      const base = basePosRef.current.get(n.id())
      if (base) {
        // adopsi posisi lepas sebagai posisi dasar drift yang baru.
        const p = n.position()
        base.x = p.x
        base.y = p.y
      }
      draggingRef.current.delete(n.id())
    })
  }

  // Re-run layout saat elemen/filter berubah, lalu rekam posisi & mulai drift.
  useEffect(() => {
    const cy = cyRef.current
    if (!cy) return

    let started = false
    const begin = () => {
      if (started) return
      started = true
      captureBasePositions(cy)
      cy.fit(undefined, 40)
      startDrift(cy)
    }

    const lay = cy.layout(layout)
    lay.one('layoutstop', begin)
    lay.run()

    // Fallback: jika event layoutstop tak sempat terpasang/terpicu,
    // tetap mulai drift setelah animasi layout selesai.
    const fallback = window.setTimeout(begin, layout.animationDuration + 200)

    return () => window.clearTimeout(fallback)
    // layoutKey & elements length sebagai dependency.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [layoutKey, elements.length])

  // Bersihkan loop animasi saat unmount.
  useEffect(() => {
    return () => {
      if (rafRef.current !== null) cancelAnimationFrame(rafRef.current)
    }
  }, [])

  return (
    <CytoscapeComponent
      elements={elements}
      stylesheet={stylesheet}
      layout={layout}
      cy={handleCy}
      minZoom={0.2}
      maxZoom={2.5}
      wheelSensitivity={0.2}
      style={{ width: '100%', height: '100%' }}
    />
  )
}
