'use strict'

function renderMarkdown(text) {
  const fragment = document.createDocumentFragment()
  const make = (tag, content) => {
    const node = document.createElement(tag)
    if (content !== undefined) node.textContent = content
    return node
  }
  function inline(parent, value) {
    const pattern = /`[^`\n]+`|\*\*[^*\n]+\*\*|__[^_\n]+__|\*[^*\n]+\*|~~[^~\n]+~~|\[[^\]\n]+\]\([^\s)]+\)/g
    let cursor = 0
    for (const match of value.matchAll(pattern)) {
      parent.append(document.createTextNode(value.slice(cursor, match.index)))
      const token = match[0]
      if (token.startsWith('[')) {
        const [, label, address] = /^\[([^\]]+)\]\(([^)]+)\)$/.exec(token)
        if (/^https?:\/\//i.test(address)) {
          const anchor = make('a', label)
          anchor.href = address
          anchor.target = '_blank'
          anchor.rel = 'noopener noreferrer'
          parent.append(anchor)
        } else parent.append(document.createTextNode(label))
      } else {
        const tag = token.startsWith('`') ? 'code' : token.startsWith('~~') ? 'del' :
          token.startsWith('**') || token.startsWith('__') ? 'strong' : 'em'
        const trim = ['strong', 'del'].includes(tag) ? 2 : 1
        parent.append(make(tag, token.slice(trim, -trim)))
      }
      cursor = match.index + token.length
    }
    parent.append(document.createTextNode(value.slice(cursor)))
  }

  const lines = String(text || '').replace(/\r\n?/g, '\n').split('\n')
  const cells = line => line.trim().replace(/^\||\|$/g, '').split('|').map(item => item.trim())
  const listItem = /^\s*([-+*]|\d+[.)])\s+(.*)$/
  const isTable = index => lines[index]?.includes('|') && lines[index + 1]?.includes('|') &&
    cells(lines[index + 1]).every(cell => /^:?-{3,}:?$/.test(cell))
  for (let index = 0; index < lines.length;) {
    const line = lines[index]
    if (!line.trim()) { index++; continue }
    const heading = /^(#{1,6})\s+(.+)$/.exec(line)
    const list = listItem.exec(line)
    if (/^\s*`{3,}/.test(line)) {
      const code = []
      index++
      while (index < lines.length && !/^\s*`{3,}\s*$/.test(lines[index])) code.push(lines[index++])
      if (index < lines.length) index++
      const pre = make('pre')
      pre.append(make('code', code.join('\n')))
      fragment.append(pre)
    } else if (heading) {
      const node = make('h' + Math.min(6, heading[1].length + 2))
      inline(node, heading[2])
      fragment.append(node)
      index++
    } else if (isTable(index)) {
      const table = make('table')
      const wrapper = make('div')
      wrapper.className = 'markdown-table'
      const head = table.createTHead().insertRow()
      const headers = cells(line)
      for (const cell of headers) {
        const node = make('th')
        node.scope = 'col'
        inline(node, cell)
        head.append(node)
      }
      const body = table.createTBody()
      index += 2
      while (index < lines.length && lines[index].includes('|') && lines[index].trim()) {
        const row = body.insertRow()
        const columns = cells(lines[index++])
        headers.forEach((_, column) => inline(row.insertCell(), columns[column] || ''))
      }
      wrapper.append(table)
      fragment.append(wrapper)
    } else if (list) {
      const ordered = /^\d/.test(list[1])
      const node = make(ordered ? 'ol' : 'ul')
      if (ordered) node.start = Number.parseInt(list[1], 10)
      while (index < lines.length) {
        const match = listItem.exec(lines[index])
        if (!match || /^\d/.test(match[1]) !== ordered) break
        const item = make('li')
        inline(item, match[2])
        node.append(item)
        index++
      }
      fragment.append(node)
    } else if (/^>/.test(line)) {
      const node = make('blockquote')
      while (index < lines.length && /^>/.test(lines[index])) {
        const paragraph = make('p')
        inline(paragraph, lines[index++].replace(/^>\s?/, ''))
        node.append(paragraph)
      }
      fragment.append(node)
    } else {
      const node = make('p')
      inline(node, line)
      index++
      while (index < lines.length && lines[index].trim() &&
          !/^\s*(?:#{1,6}\s|`{3,}|>)/.test(lines[index]) && !listItem.test(lines[index]) && !isTable(index)) {
        node.append(make('br'))
        inline(node, lines[index++])
      }
      fragment.append(node)
    }
  }
  return fragment
}
