const { execFile } = require('node:child_process')
const { promisify } = require('node:util')
const fs = require('node:fs/promises')
const os = require('node:os')
const path = require('node:path')

const run = promisify(execFile)
const { settings } = require('./ai-settings')
const pdfOptions = { timeout: 45000, maxBuffer: 512 * 1024 }
const pageLimit = 60
const ocrLimit = 20
const documentLimit = 120000

async function readPdf(buffer) {
  const { getDocument } = await import('pdfjs-dist/legacy/build/pdf.mjs')
  const pdf = await getDocument({ data: new Uint8Array(buffer), isEvalSupported: false, stopAtErrors: true,
    standardFontDataUrl: path.join(path.dirname(require.resolve('pdfjs-dist/package.json')), 'standard_fonts') + path.sep }).promise
  const pages = []
  let directory
  let scanned = 0
  let unreadable = 0
  let read = 0
  let clipped = false
  let characters = 0
  let ocrError
  try {
    for (let index = 1; index <= Math.min(pdf.numPages, pageLimit); index++) {
      let text = ''
      try {
        const page = await pdf.getPage(index)
        const content = await page.getTextContent()
        text = content.items.map(item => (item.str || '') + (item.hasEOL ? '\n' : ' ')).join('').trim()
        page.cleanup()
      } catch {
        // The rasterizer can recover text on some pages that PDF.js cannot parse.
      }
      let method = 'texto'
      if (text.replace(/\s/g, '').length < 30 && scanned < ocrLimit && !ocrError) {
        scanned++
        try {
          if (!directory) {
            directory = await fs.mkdtemp(path.join(os.tmpdir(), 'agente-pdf-'))
            await fs.writeFile(path.join(directory, 'source.pdf'), buffer)
          }
          const image = path.join(directory, 'page')
          await run(process.env.PDFTOPPM || 'pdftoppm',
            ['-f', String(index), '-l', String(index), '-singlefile', '-scale-to', '2000', '-gray', '-png', path.join(directory, 'source.pdf'), image], pdfOptions)
          const languages = settings().ocrLanguages
          const tessdata = process.env.TESSDATA_DIR
          const result = await run(process.env.TESSERACT || 'tesseract',
            [image + '.png', 'stdout', '-l', languages, ...(tessdata ? ['--tessdata-dir', tessdata] : [])], pdfOptions)
          const ocr = result.stdout.trim()
          if (ocr.length > text.length) {
            text = ocr
            method = 'OCR'
          }
        } catch (error) {
          if (error.code === 'ENOENT' || /traineddata|Failed loading language|Error opening data file/i.test(error.stderr || '')) {
            ocrError = 'OCR local indisponível. Confira pdftoppm, Tesseract e os idiomas instalados.'
          }
        }
      }
      if (!text) {
        unreadable++
        continue
      }
      if (text.replace(/\s/g, '').length < 30 && method !== 'OCR') clipped = true
      const available = Math.min(8000, documentLimit - characters)
      clipped ||= text.length > available
      pages.push('Página ' + index + ' (' + method + ')\n' + text.slice(0, available))
      read++
      characters += Math.min(text.length, available)
      if (characters >= documentLimit) break
    }
    const partial = clipped || read < pdf.numPages
    return {
      kind: 'pdf', text: pages.join('\n\n'), partial, pages: pdf.numPages, read, unreadable,
      ...(ocrError ? { note: ocrError } : {})
    }
  } finally {
    try { await pdf.destroy() } finally {
      if (directory) await fs.rm(directory, { recursive: true, force: true })
    }
  }
}

function mediaExcerpt(text, limit, score = () => 0) {
  if (text.length <= limit) return text
  const sections = []
  let page = ''
  for (const line of text.split('\n')) {
    const heading = /^Página \d+ \((?:texto|OCR)\)$/.test(line)
    if (heading) { page = line; continue }
    for (let position = 0; position < line.length; position += 650) {
      const content = line.slice(position, position + 650).trim()
      if (content) sections.push({ page, content, score: score(content), index: sections.length })
    }
  }
  const selected = []
  let size = 0
  for (const section of sections.sort((a, b) => b.score - a.score || a.index - b.index)) {
    const value = [section.page, section.content].filter(Boolean).join('\n')
    if (size + value.length + 2 > limit) continue
    selected.push({ ...section, value })
    size += value.length + 2
  }
  return selected.length ? selected.sort((a, b) => a.index - b.index).map(section => section.value).join('\n\n') : text.slice(0, limit)
}

module.exports = { readPdf, mediaExcerpt }
