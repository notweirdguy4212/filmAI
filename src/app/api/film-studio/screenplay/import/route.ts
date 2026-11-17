import { NextRequest, NextResponse } from 'next/server'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import mammoth from 'mammoth'
import { requireUserAuth, isErrorResponse } from '@/lib/api-auth'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const maxDuration = 60

const execFileAsync = promisify(execFile)
const MAX_FILE_BYTES = 20 * 1024 * 1024
const MAX_TEXT_CHARS = 2_000_000
const ALLOWED_EXTENSIONS = new Set(['.pdf', '.docx', '.txt', '.fountain'])

function normalizeScreenplayText(value: string): string {
  const text = value
    .normalize('NFC')
    .replace(/\r\n?/g, '\n')
    .replace(/\u0000/g, '')
    .replace(/\u00a0/g, ' ')
    .replace(/[\u200b\u200c\u200d\ufeff]/g, '')
    .trim()
  if (!text) throw new Error('The uploaded file contains no extractable screenplay text.')
  if (text.length > MAX_TEXT_CHARS) throw new Error('The extracted screenplay exceeds the 2 million character limit.')
  return text
}

async function extractPdf(buffer: Buffer): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'filmai-screenplay-'))
  const inputPath = join(directory, 'screenplay.pdf')
  try {
    await writeFile(inputPath, buffer, { mode: 0o600 })
    const { stdout } = await execFileAsync('pdftotext', ['-layout', inputPath, '-'], {
      encoding: 'utf8', timeout: 45_000, maxBuffer: 12 * 1024 * 1024,
    })
    return stdout
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code === 'ENOENT') throw new Error('PDF import requires Poppler pdftotext. Install poppler-utils on the application host.')
    throw new Error('Could not extract text from this PDF. It may be encrypted, scanned, or damaged; OCR is not currently enabled.')
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
}

export async function POST(request: NextRequest) {
  const auth = await requireUserAuth()
  if (isErrorResponse(auth)) return auth

  let form: FormData
  try { form = await request.formData() }
  catch { return NextResponse.json({ error: 'Upload a screenplay file using multipart form data.' }, { status: 400 }) }

  const file = form.get('file')
  if (!(file instanceof File)) return NextResponse.json({ error: 'A screenplay file is required.' }, { status: 400 })
  const extension = file.name.toLowerCase().match(/\.[a-z0-9]+$/)?.[0] ?? ''
  if (!ALLOWED_EXTENSIONS.has(extension)) return NextResponse.json({ error: 'Supported screenplay formats are PDF, DOCX, TXT and Fountain (.fountain).' }, { status: 415 })
  if (file.size <= 0) return NextResponse.json({ error: 'The selected file is empty.' }, { status: 400 })
  if (file.size > MAX_FILE_BYTES) return NextResponse.json({ error: 'Screenplay files must be 20 MB or smaller.' }, { status: 413 })

  try {
    const buffer = Buffer.from(await file.arrayBuffer())
    const extracted = extension === '.docx'
      ? (await mammoth.extractRawText({ buffer })).value
      : extension === '.pdf'
        ? await extractPdf(buffer)
        : new TextDecoder('utf-8', { fatal: true }).decode(buffer)
    const screenplay = normalizeScreenplayText(extracted)
    return NextResponse.json({
      fileName: file.name.replace(/[\\/\u0000]/g, '_').slice(0, 255),
      format: extension.slice(1),
      screenplay,
      characterCount: screenplay.length,
      wordCount: screenplay.split(/\s+/).filter(Boolean).length,
    })
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Screenplay import failed.'
    return NextResponse.json({ error: message.slice(0, 500) }, { status: 422 })
  }
}
