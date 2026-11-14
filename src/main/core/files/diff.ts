/**
 * Minimal unified diff (LCS on lines) for non-Git workspaces. Large inputs fall back to a
 * whole-file replacement hunk rather than an expensive or wrong diff.
 */
export function unifiedDiff(path: string, a: string, b: string, context = 3): string {
  const x = a === '' ? [] : a.split('\n')
  const y = b === '' ? [] : b.split('\n')
  const header = `--- a/${path}\n+++ b/${path}\n`
  if (x.length * y.length > 4_000_000) {
    return `${header}@@ -1,${x.length} +1,${y.length} @@\n${x.map((l) => `-${l}`).join('\n')}${x.length ? '\n' : ''}${y.map((l) => `+${l}`).join('\n')}`
  }
  const n = x.length
  const m = y.length
  const lcs: Uint32Array[] = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1))
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) lcs[i]![j] = x[i] === y[j] ? lcs[i + 1]![j + 1]! + 1 : Math.max(lcs[i + 1]![j]!, lcs[i]![j + 1]!)
  type Op = { t: ' ' | '-' | '+'; l: string; ai: number; bi: number }
  const ops: Op[] = []
  let i = 0
  let j = 0
  while (i < n || j < m) {
    if (i < n && j < m && x[i] === y[j]) ops.push({ t: ' ', l: x[i]!, ai: i++, bi: j++ })
    else if (i < n && (j >= m || lcs[i + 1]![j]! >= lcs[i]![j + 1]!)) ops.push({ t: '-', l: x[i]!, ai: i++, bi: j })
    else ops.push({ t: '+', l: y[j]!, ai: i, bi: j++ })
  }
  const out: string[] = []
  let k = 0
  while (k < ops.length) {
    if (ops[k]!.t === ' ') {
      k++
      continue
    }
    const start = Math.max(0, k - context)
    let end = k
    while (end < ops.length) {
      if (ops[end]!.t !== ' ') {
        end++
        continue
      }
      let run = 0
      while (end + run < ops.length && ops[end + run]!.t === ' ') run++
      if (run > context * 2 || end + run >= ops.length) {
        end = Math.min(ops.length, end + context)
        break
      }
      end += run
    }
    const hunk = ops.slice(start, end)
    const aStart = hunk[0]!.ai + 1
    const bStart = hunk[0]!.bi + 1
    const aLen = hunk.filter((o) => o.t !== '+').length
    const bLen = hunk.filter((o) => o.t !== '-').length
    out.push(`@@ -${aLen ? aStart : aStart - 1},${aLen} +${bLen ? bStart : bStart - 1},${bLen} @@`)
    for (const o of hunk) out.push(`${o.t}${o.l}`)
    k = end
  }
  return header + out.join('\n')
}
