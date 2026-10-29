// A rough stand-in for the terminal's layout, so a test can read a pane as
// lines of text: the kit validates and exercises the tree but never paints it.
// A row Box shortens its children that may shrink (flexShrink not 0) when the
// row is wider than the width; Text wraps, or is cut where it says truncate.
// Borders are not drawn. Enough to see whether a row keeps to one line.

export type Drawn = { type: string; props: Record<string, unknown>; children?: unknown[] }

function isDrawn(value: unknown): value is Drawn {
  return typeof value === 'object' && value !== null && 'type' in value
}

function childrenOf(node: Drawn): unknown[] {
  return Array.isArray(node.children) ? node.children : []
}

function textOf(value: unknown): string {
  if (typeof value === 'string') return value
  if (!isDrawn(value)) return ''
  if (value.type === 'Button') return buttonText(value)
  if (value.type === 'Select' || value.type === 'Input') return controlText(value)
  // A Link draws its label (the terminal makes it an OSC 8 span), or its URL when it has none.
  if (value.type === 'Link' && childrenOf(value).length === 0) return String(value.props.label ?? value.props.href ?? '')
  let text = ''
  for (const child of childrenOf(value)) text += textOf(child)
  return text
}

function buttonText(node: Drawn): string {
  let label = typeof node.props.label === 'string' ? node.props.label : ''
  if (childrenOf(node).length > 0) {
    label = ''
    for (const child of childrenOf(node)) label += textOf(child)
  }
  // The terminal draws a button's label between brackets and spaces.
  return node.props.plain === true ? label : `[ ${label} ]`
}

function controlText(node: Drawn): string {
  const label = typeof node.props.label === 'string' ? node.props.label : ''
  if (node.type === 'Input') {
    const value = typeof node.props.value === 'string' ? node.props.value : ''
    const placeholder = typeof node.props.placeholder === 'string' ? node.props.placeholder : ''
    return `${label}: [${value === '' ? placeholder : value}]`
  }
  let shown = ''
  for (const option of (node.props.options ?? []) as { value: string; label: string }[]) {
    if (option.value === node.props.value) shown = option.label
  }
  return `${label}[${shown} ▾]`
}

function cut(text: string, width: number): string {
  if (text.length <= width) return text
  return width <= 1 ? text.slice(0, Math.max(0, width)) : `${text.slice(0, width - 1)}…`
}

function wrap(text: string, width: number): string[] {
  const lines: string[] = []
  for (const part of text.split('\n')) {
    let rest = part
    while (rest.length > width) {
      lines.push(rest.slice(0, width))
      rest = rest.slice(width)
    }
    lines.push(rest)
  }
  return lines
}

function widest(lines: string[]): number {
  let longest = 0
  for (const line of lines) {
    if (line.length > longest) longest = line.length
  }
  return longest
}

const UNBOUNDED = 10_000

function paintNode(value: unknown, width: number): string[] {
  if (typeof value === 'string') return wrap(value, width)
  if (!isDrawn(value)) return []
  if (value.type === 'Box') return paintBox(value, width)
  if (value.type === 'Text') {
    const text = textOf(value)
    const wrapMode = typeof value.props.wrap === 'string' ? value.props.wrap : 'wrap'
    if (wrapMode.startsWith('truncate')) {
      const lines: string[] = []
      for (const line of text.split('\n')) lines.push(cut(line, width))
      return lines
    }
    return wrap(text, width)
  }
  return wrap(textOf(value), width)
}

function paintBox(box: Drawn, width: number): string[] {
  const paddingLeft = typeof box.props.paddingLeft === 'number' ? box.props.paddingLeft : typeof box.props.paddingX === 'number' ? box.props.paddingX : 0
  const inner = typeof box.props.width === 'number' ? Math.min(box.props.width, width) - paddingLeft : width - paddingLeft
  const indent = ' '.repeat(paddingLeft)
  const lines: string[] = []
  // A Box lays its children out in a row unless it says column.
  if (box.props.flexDirection !== 'column') {
    for (const line of paintRow(childrenOf(box), inner)) lines.push(indent + line)
    return lines
  }
  for (const child of childrenOf(box)) {
    for (const line of paintNode(child, inner)) lines.push(indent + line)
  }
  return lines
}

function mayShrink(child: unknown): boolean {
  return !(isDrawn(child) && child.props.flexShrink === 0)
}

function paintRow(children: unknown[], width: number): string[] {
  const natural: number[] = []
  for (const child of children) natural.push(widest(paintNode(child, UNBOUNDED)))
  let fixed = 0
  let shrinkable = 0
  for (let index = 0; index < children.length; index++) {
    if (mayShrink(children[index])) shrinkable += natural[index] as number
    else fixed += natural[index] as number
  }
  const room = Math.max(0, width - fixed)
  const columns: string[][] = []
  const widths: number[] = []
  for (let index = 0; index < children.length; index++) {
    const own = natural[index] as number
    let given = own
    if (fixed + shrinkable > width && mayShrink(children[index])) given = shrinkable === 0 ? 0 : Math.max(1, Math.floor((own * room) / shrinkable))
    columns.push(paintNode(children[index], Math.max(1, given)))
    widths.push(given)
  }
  let height = 0
  for (const column of columns) height = Math.max(height, column.length)
  const lines: string[] = []
  for (let row = 0; row < height; row++) {
    let line = ''
    for (let index = 0; index < columns.length; index++) {
      line += ((columns[index] as string[])[row] ?? '').padEnd(widths[index] as number)
    }
    lines.push(line)
  }
  return lines
}

// An element drawn with no props at all still has an empty set.
function withProps(value: unknown): unknown {
  if (!isDrawn(value)) return value
  const children: unknown[] = []
  for (const child of childrenOf(value)) children.push(withProps(child))
  return { ...value, props: value.props ?? {}, children }
}

// The lines a drawn tree comes to at `width` columns.
export function paint(tree: unknown, width: number): string[] {
  const lines: string[] = []
  for (const line of paintNode(withProps(tree), width)) lines.push(line.trimEnd())
  return lines
}

// The painted lines as one block, for a test that prints a picture.
export function picture(tree: unknown, width: number): string {
  const lines = paint(tree, width)
  const rule = '-'.repeat(width)
  return [`+${rule}+`, ...lines.map(line => `|${line.padEnd(width)}|`), `+${rule}+`].join('\n')
}
