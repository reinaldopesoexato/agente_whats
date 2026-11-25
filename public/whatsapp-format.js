// This factory also runs in the WhatsApp page, where the complete last message is available.
function createWhatsAppFormatting() {
  const delimiters = { '**':'strong', '*':'strong', _:'em', '~':'s', '~~':'s', '`':'code' }

  function inline(line, sink, depth = 0) {
    if (sink.full) return
    if (depth >= 4) { sink.text(line); return }
    const tokens = /(`)([^\n`]+)\1|(?<![\p{L}\p{N}_])(\*\*|\*|_|~~|~)(?!\s)([^\n]+?)(?<!\s)\3(?![\p{L}\p{N}_])/gu
    let start = 0
    for (const match of line.matchAll(tokens)) {
      sink.text(line.slice(start,match.index))
      if (sink.full) return
      sink.open(delimiters[match[1] || match[3]])
      if (match[1]) sink.text(match[2])
      else inline(match[4],sink,depth+1)
      sink.close()
      if (sink.full) return
      start = match.index + match[0].length
    }
    sink.text(line.slice(start))
  }

  function *blocks(input) {
    const text = String(input || '').replace(/\r\n?/g,'\n')
    function *lines(value) {
      let start = 0
      while (start <= value.length) {
        const end = value.indexOf('\n', start)
        const body = value.slice(start, end < 0 ? value.length : end)
        const bullet = /^(?:[-*] |(\d+)\. )(.+)$/.exec(body)
        if (bullet) yield {type:bullet[1] ? 'ol' : 'ul', number:bullet[1], body:bullet[2]}
        else if (body.startsWith('> ')) yield {type:'blockquote',body:body.slice(2)}
        else yield {type:'div',body}
        if (end < 0) break
        start = end + 1
      }
    }
    let start = 0
    for (const match of text.matchAll(/```([\s\S]+?)```/g)) {
      if (match.index > start) yield* lines(text.slice(start,match.index).replace(/\n$/,''))
      yield {type:'pre',body:match[1].replace(/^\n|\n$/g,'')}
      start = match.index + match[0].length
    }
    if (start < text.length) yield* lines(start ? text.slice(start).replace(/^\n/,'') : text)
  }

  function preview(input, limit = 140) {
    let remaining = limit
    const result = {text:'',styles:[]}
    const active = []
    const sink = {
      get full() { return remaining <= 0 },
      open(tag) { active.push(tag) },
      close() { active.pop() },
      text(value) {
        const from = result.text.length
        for (const char of value) {
          if (!remaining) break
          result.text += char
          remaining--
        }
        if (active.length && result.text.length > from) {
          result.styles.push({from,to:result.text.length,tags:[...active]})
        }
      }
    }
    // A plain prefix cannot acquire an opening marker from the omitted suffix.
    const head = input.slice(0,limit*2)
    if (!/[\r\n*`_~>]/.test(head) && !/^(?:- |\d+\. )/.test(head)) {
      sink.text(input)
      return result
    }
    let first = true
    for (const block of blocks(input)) {
      if (block.type === 'div' && !block.body.trim()) continue
      if (!first && !/\s$/.test(result.text)) sink.text(' ')
      first = false
      if (block.type === 'ol') sink.text(block.number+'. ')
      if (block.type === 'ul') sink.text('• ')
      if (block.type === 'blockquote') sink.open('quote')
      if (block.type === 'pre') {
        sink.open('code')
        sink.text(block.body)
        sink.close()
      } else inline(block.body,sink)
      if (block.type === 'blockquote') sink.close()
      if (sink.full) break
    }
    return result
  }

  function renderPreview(document, {text,styles}) {
    const result = document.createDocumentFragment()
    const stack = []
    let offset = 0
    for (const {from,to,tags} of styles) {
      if (from > offset) {
        stack.length = 0
        result.append(text.slice(offset,from))
      }
      let shared = 0
      while (shared < stack.length && stack[shared].tag === tags[shared]) shared++
      stack.length = shared
      let parent = stack.at(-1)?.el || result
      for (const tag of tags.slice(shared)) {
        if (!['quote','strong','em','s','code'].includes(tag)) continue
        const el = document.createElement(tag === 'quote' ? 'span' : tag)
        if (tag === 'quote') el.className = 'chat-preview-quote'
        stack.push({tag,el})
        parent.append(el)
        parent = el
      }
      parent.append(text.slice(from,to))
      offset = to
    }
    result.append(text.slice(offset))
    return result
  }

  function formatWhatsApp(document, input, options = {}) {
    if (options.preview) return renderPreview(document,preview(String(input || '')))
    const result = document.createDocumentFragment()
    let list
    for (const block of blocks(input)) {
      const isList = block.type === 'ul' || block.type === 'ol'
      if (!isList) list = null
      else if (list?.localName !== block.type) {
        list = document.createElement(block.type)
        if (block.number) list.start = Number(block.number)
        result.append(list)
      }
      const node = document.createElement(isList ? 'li' : block.type)
      if (block.number) node.value = Number(block.number)
      const container = list || result
      container.append(node)
      if (block.type === 'pre') node.textContent = block.body
      else if (!block.body && block.type === 'div') node.append(document.createElement('br'))
      else {
        let parent = node
        inline(block.body,{
          text(value) { parent.append(value) },
          open(tag) { const child = document.createElement(tag); parent.append(child); parent = child },
          close() { parent = parent.parentNode }
        })
      }
    }
    return result
  }
  return {preview,renderPreview,formatWhatsApp}
}
const {formatWhatsApp,renderPreview:renderWhatsAppPreview} = createWhatsAppFormatting()
if (typeof module !== 'undefined') module.exports = {createWhatsAppFormatting,formatWhatsApp}
