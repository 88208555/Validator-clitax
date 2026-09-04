const PUBLIC_BIND_ADDRESSES = new Set(['0.0.0.0', '::', '[::]', '0:0:0:0:0:0:0:0'])
const BIND_OPTION = /^(?:host|hostname|bind|bindhost|bindaddress|listenhost|listenaddress)$/i
const BIND_METHODS = new Set(['listen', 'bind'])
const SCRIPT_EXTENSION = /\.(?:[cm]?[jt]sx?)$/i

function decodeHostLiteral(value) {
  return value.replace(/\\(?:u\{([0-9a-f]+)\}|u([0-9a-f]{4})|x([0-9a-f]{2})|(.))/gi,
    (match, point, unicode, byte, character) => {
      const digits = point ?? unicode ?? byte
      if (digits === undefined) return character
      const code = parseInt(digits, 16)
      return code <= 0x10ffff ? String.fromCodePoint(code) : match
    })
}

function quotedToken(source, start) {
  const quote = source[start]
  let end = start + 1
  while (end < source.length) {
    if (source[end] === '\\') { end += 2; continue }
    if (source[end] === quote) {
      return { kind: 'literal', value: decodeHostLiteral(source.slice(start + 1, end)), start, end: end + 1 }
    }
    end += 1
  }
  return { kind: 'invalid', value: source.slice(start), start, end: source.length }
}

function templateTokens(source, start) {
  const tokens = []
  let index = start + 1
  while (index < source.length) {
    if (source[index] === '\\') { index += 2; continue }
    if (source[index] === '`') {
      if (tokens.length === 0) tokens.push(quotedToken(source, start))
      return { tokens, end: index + 1 }
    }
    if (source[index] === '$' && source[index + 1] === '{') {
      const expression = codeTokens(source, index + 2, true)
      tokens.push(...expression.tokens)
      index = expression.end
      continue
    }
    index += 1
  }
  return { tokens, end: source.length }
}

function codeTokens(source, start = 0, templateExpression = false) {
  const tokens = []
  let depth = 0
  for (let index = start; index < source.length;) {
    const tail = source.slice(index)
    const ignored = tail.match(/^(?:\s+|\/\/[^\n]*|\/\*[\s\S]*?(?:\*\/|$))/)
    if (ignored) { index += ignored[0].length; continue }
    if (source[index] === '`') {
      const template = templateTokens(source, index)
      tokens.push(...template.tokens)
      index = template.end
      continue
    }
    if (['"', "'"].includes(source[index])) {
      const token = quotedToken(source, index)
      tokens.push(token)
      index = token.end
      continue
    }
    if (source[index] === '}' && templateExpression && depth === 0) return { tokens, end: index + 1 }
    if (source[index] === '{') depth += 1
    if (source[index] === '}') depth -= 1
    const word = tail.match(/^[A-Za-z_$][\w$]*/)
    const value = word === null ? source[index] : word[0]
    tokens.push({ kind: word === null ? 'symbol' : 'word', value, start: index, end: index + value.length })
    index += value.length
  }
  return { tokens, end: source.length }
}

function bindHost(token, aliases) {
  if (token === undefined) return false
  return token.kind === 'literal' ? PUBLIC_BIND_ADDRESSES.has(token.value)
    : token.kind === 'word' && aliases.has(token.value)
}

function publicAliases(tokens) {
  const aliases = new Set()
  let changed = true
  while (changed) {
    changed = false
    for (let index = 0; index < tokens.length - 2; index += 1) {
      const token = tokens[index]
      if (token.kind === 'word' && tokens[index + 1].value === '='
        && bindHost(tokens[index + 2], aliases) && !aliases.has(token.value)) {
        aliases.add(token.value)
        changed = true
      }
    }
  }
  return aliases
}

function callArguments(tokens, opening) {
  const args = [[]]
  let depth = 0
  for (let index = opening + 1; index < tokens.length; index += 1) {
    const token = tokens[index]
    if (token.value === ')' && depth === 0) return args
    if (token.value === ',' && depth === 0) { args.push([]); continue }
    args[args.length - 1].push(token)
    if (['(', '[', '{'].includes(token.value)) depth += 1
    if ([')', ']', '}'].includes(token.value)) depth -= 1
  }
  return []
}

function scriptBindSites(source) {
  const { tokens } = codeTokens(source)
  const aliases = publicAliases(tokens)
  const sites = []
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index]
    const normalized = token.value.replaceAll('_', '').replaceAll('-', '')
    if (BIND_OPTION.test(normalized) && [':', '='].includes(tokens[index + 1]?.value)
      && bindHost(tokens[index + 2], aliases)) {
      sites.push({ offset: token.start, context: 'bind-option', address: tokens[index + 2].value })
    }
    if (!BIND_METHODS.has(token.value)) continue
    let opening = index + 1
    if (tokens[index - 1]?.value === '[' && tokens[opening]?.value === ']') opening += 1
    if (tokens[opening]?.value === '?' && tokens[opening + 1]?.value === '.') opening += 2
    if (tokens[opening]?.value !== '(') continue
    const args = callArguments(tokens, opening)
    const hosts = token.value === 'bind' ? args.slice(0, 2).flat() : args[1]
    if (hosts === undefined) continue
    const publicHost = hosts.find((candidate) => bindHost(candidate, aliases))
    if (publicHost) sites.push({ offset: token.start, context: `${token.value}-argument`, address: publicHost.value })
  }
  return sites
}

function configurationBindSites(source) {
  const sites = []
  const pattern = /(?:\b(?:host|hostname|bind(?:[_-]?(?:host|address))?|listen(?:[_-]?(?:host|address))?)\b["']?\s*(?:[:=]\s*|\s+)|--(?:host|bind|listen)(?:=|\s+))["']?(0\.0\.0\.0|\[::\]|::)(?=["'\s:;,]|$)/gi
  for (const match of source.matchAll(pattern)) {
    const lineStart = source.lastIndexOf('\n', match.index) + 1
    if (/^\s*(?:#|\/\/)/.test(source.slice(lineStart, match.index))) continue
    sites.push({ offset: match.index, context: 'bind-configuration', address: match[1] })
  }
  return sites
}

/** Inspect bind sinks and host configuration; address lists and outbound targets are not listeners. */
export function publicBindSites(path, source) {
  const sites = SCRIPT_EXTENSION.test(path) ? scriptBindSites(source) : configurationBindSites(source)
  return sites.map((site) => ({
    ...site, line: source.slice(0, site.offset).split('\n').length,
  }))
}
