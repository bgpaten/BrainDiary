// Minimal type declaration for react-cytoscapejs (paket tidak menyertakan types).
declare module 'react-cytoscapejs' {
  import { Component } from 'react'
  import cytoscape from 'cytoscape'

  export interface CytoscapeComponentProps {
    elements: cytoscape.ElementDefinition[]
    stylesheet?: cytoscape.Stylesheet[] | unknown[]
    style?: React.CSSProperties
    className?: string
    layout?: cytoscape.LayoutOptions | Record<string, unknown>
    cy?: (cy: cytoscape.Core) => void
    minZoom?: number
    maxZoom?: number
    wheelSensitivity?: number
    [key: string]: unknown
  }

  export default class CytoscapeComponent extends Component<CytoscapeComponentProps> {
    static normalizeElements(elements: {
      nodes: cytoscape.ElementDefinition[]
      edges: cytoscape.ElementDefinition[]
    }): cytoscape.ElementDefinition[]
  }
}
