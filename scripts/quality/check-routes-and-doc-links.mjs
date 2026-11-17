import { existsSync, readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'

const root = process.cwd()
const failures = []
const count = { pages: 0, apiRoutes: 0, apiReferences: 0, localDocLinks: 0, studioLinks: 0, appLinks: 0 }

function walk(directory, predicate = () => true) {
  if (!existsSync(directory)) return []
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(directory, entry.name)
    if (entry.isDirectory()) return walk(full, predicate)
    return predicate(full) ? [full] : []
  })
}

const routeFiles = walk(path.join(root, 'src/app'), (file) => /(?:page|route)\.tsx?$/.test(file))
const pageRoutes = new Set()
const apiRoutes = []
for (const file of routeFiles) {
  const relative = path.relative(path.join(root, 'src/app'), file).split(path.sep).join('/')
  const route = relative.replace(/\/(?:page|route)\.tsx?$/, '').replace(/\/(?:page|route)\.tsx?$/, '')
  if (relative.startsWith('api/')) apiRoutes.push(`/${route}`)
  else if (path.basename(file).startsWith('page.')) pageRoutes.add(`/${route}`.replace(/\/\//g, '/'))
}
count.pages = pageRoutes.size
count.apiRoutes = apiRoutes.length

function routeExists(candidate, routes) {
  const normalized = candidate.split('?')[0].split('#')[0].replace(/\/$/, '') || '/'
  return [...routes].some((route) => {
    const pattern = route.split('/').map((part) => part.startsWith('[') && part.endsWith(']') ? '[^/]+' : part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('/')
    return new RegExp(`^${pattern}/?$`).test(normalized)
  })
}

const studioFile = path.join(root, 'src/features/film-studio/FilmStudio.tsx')
const studioSource = readFileSync(studioFile, 'utf8')
for (const match of studioSource.matchAll(/fetch\(\s*(['"`])([^'"`]+)\1/g)) {
  const raw = match[2]
  if (!raw.startsWith('/api/')) continue
  const endpoint = raw.replace(/\$\{[^}]+\}/g, 'route-param').split('?')[0]
  count.apiReferences += 1
  if (!routeExists(endpoint, apiRoutes)) failures.push(`Film Studio API endpoint has no route handler: ${raw}`)
}
for (const match of studioSource.matchAll(/<Link\b[^>]*\bhref="([^"]+)"/g)) {
  const href = match[1]
  if (!href.startsWith('/')) continue
  count.studioLinks += 1
  if (!routeExists(`/[locale]${href}`, pageRoutes)) failures.push(`Film Studio internal link has no page route: ${href}`)
}

for (const file of walk(path.join(root, 'src'), (candidate) => candidate.endsWith('.tsx'))) {
  const source = readFileSync(file, 'utf8')
  for (const match of source.matchAll(/<Link\b[^>]*?\bhref\s*=\s*[\"']([^\"']+)[\"']/gs)) {
    const href = match[1]
    if (!href.startsWith('/')) continue
    count.appLinks += 1
    if (!routeExists(`/[locale]${href}`, pageRoutes)) failures.push(`Internal application link has no localized page route: ${path.relative(root, file)} -> ${href}`)
  }
}

const markdownFiles = walk(root, (file) => file.endsWith('.md') && !file.includes(`${path.sep}node_modules${path.sep}`) && !file.includes(`${path.sep}.git${path.sep}`))
for (const file of markdownFiles) {
  const source = readFileSync(file, 'utf8')
  for (const match of source.matchAll(/!?\[[^\]]*\]\(([^)]+)\)/g)) {
    const rawDestination = match[1].trim()
    const destination = (rawDestination.startsWith('<') ? rawDestination.match(/^<([^>]+)>/)?.[1] : rawDestination.split(/\s+/, 1)[0])?.split(/[?#]/, 1)[0] ?? ''
    if (!destination || /^(?:[a-z][a-z\d+.-]*:|\/\/|#)/i.test(destination)) continue
    const decoded = decodeURIComponent(destination)
    const target = path.resolve(path.dirname(file), decoded)
    count.localDocLinks += 1
    if (!target.startsWith(root + path.sep) && target !== root) failures.push(`Markdown link escapes repository: ${path.relative(root, file)} -> ${destination}`)
    else if (!existsSync(target)) failures.push(`Broken Markdown link: ${path.relative(root, file)} -> ${destination}`)
  }
}

console.log(`Route/document audit: ${count.pages} page routes, ${count.apiRoutes} API handlers, ${count.apiReferences} Film Studio API references, ${count.studioLinks} Studio links, ${count.appLinks} application links, ${count.localDocLinks} local Markdown links.`)
if (failures.length) {
  console.error(`\n${failures.length} issue(s) found:`)
  for (const failure of failures) console.error(`- ${failure}`)
  process.exitCode = 1
} else {
  console.log('All audited routes and local documentation links resolve.')
}
