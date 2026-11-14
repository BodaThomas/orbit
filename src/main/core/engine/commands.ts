import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, isAbsolute, join, resolve } from 'node:path'

/**
 * Shell command analysis for the tool policy (level 1).
 *
 * A command is judged on its arguments and effects, never on the executable name alone:
 * `git status` is an inspection, `git push --force` a destructive remote action; `rm a.txt`
 * an edit, `rm -rf src` a mass deletion; `sh -c "…"` is analysed recursively.
 *
 * Pure apart from two filesystem probes (`node_modules/.bin`, path resolution done by the
 * policy). It is still a heuristic over text: anything it cannot see through (command
 * substitution, variables, scripts, unknown programs) is classified `opaque`/`unknown`
 * and never auto-approved by Orbit on that basis alone.
 */

export type CommandCategory =
  // Routine: auto-approvable in supervised mode (see policy.ts for the exact conditions).
  | 'readonly'
  | 'verify'
  | 'build'
  | 'git-local'
  // Needs review: Orbit cannot tell what it does.
  | 'network'
  | 'unknown'
  | 'opaque'
  // Sensitive: always a human (or refused).
  | 'install'
  | 'git-remote'
  | 'delete'
  | 'git-destructive'
  | 'hooks'
  | 'publish'
  | 'database'
  | 'deploy'
  | 'secrets'
  | 'privileged'

export const ROUTINE: CommandCategory[] = ['readonly', 'verify', 'build', 'git-local']
export const REVIEW: CommandCategory[] = ['network', 'unknown', 'opaque']
/** Most severe last. */
const ORDER: CommandCategory[] = ['readonly', 'verify', 'build', 'git-local', 'network', 'unknown', 'opaque', 'install', 'git-remote', 'delete', 'git-destructive', 'hooks', 'publish', 'database', 'deploy', 'secrets', 'privileged']

export { CATEGORY_LABELS } from '@shared/permission-labels'

export function severity(c: CommandCategory): number {
  return ORDER.indexOf(c)
}
export function worst(a: CommandCategory, b: CommandCategory): CommandCategory {
  return severity(a) >= severity(b) ? a : b
}

export interface CommandAnalysis {
  /** Most severe category over every segment. */
  category: CommandCategory
  /** One entry per simple command found (pipes, `;`, `&&`, subshells, `sh -c` bodies…). */
  segments: { argv: string[]; category: CommandCategory; reason: string }[]
  /** Path-like arguments, resolved against the tracked working directory (`cd` included). */
  paths: string[]
  /** Paths the command writes to (redirections, cp/mv targets, tee…). */
  writes: string[]
  /** Short French explanation of the most severe segment. */
  reason: string
  /** The command needs these companion permissions at all. */
  needs: { write: boolean; network: boolean }
}

// Tokenizer

interface Tok {
  t: 'word' | 'op'
  v: string
  /** Word contained an unquoted `$` expansion, `$(…)` or backticks. */
  dynamic?: boolean
}

/** Minimal POSIX-ish tokenizer: quotes, escapes, operators, redirections, heredocs. */
export function tokenize(src: string): { tokens: Tok[]; substitutions: string[] } {
  const tokens: Tok[] = []
  const substitutions: string[] = []
  let i = 0
  let cur = ''
  let inWord = false
  let dynamic = false
  const push = () => {
    if (inWord) tokens.push({ t: 'word', v: cur, dynamic })
    cur = ''
    inWord = false
    dynamic = false
  }
  const readBalanced = (start: number, open: string, close: string): number => {
    let depth = 1
    let j = start
    while (j < src.length && depth > 0) {
      if (src[j] === '\\') j++
      else if (src[j] === open) depth++
      else if (src[j] === close) depth--
      j++
    }
    return j
  }
  while (i < src.length) {
    const c = src[i]!
    if (c === '\\' && i + 1 < src.length) {
      if (src[i + 1] === '\n') {
        i += 2
        continue
      }
      cur += src[i + 1]
      inWord = true
      i += 2
      continue
    }
    if (c === "'") {
      const end = src.indexOf("'", i + 1)
      cur += src.slice(i + 1, end < 0 ? src.length : end)
      inWord = true
      i = end < 0 ? src.length : end + 1
      continue
    }
    if (c === '"') {
      let j = i + 1
      while (j < src.length && src[j] !== '"') {
        if (src[j] === '\\' && j + 1 < src.length) {
          cur += src[j + 1]
          j += 2
          continue
        }
        if (src[j] === '$' && src[j + 1] === '(') {
          const end = readBalanced(j + 2, '(', ')')
          substitutions.push(src.slice(j + 2, end - 1))
          cur += src.slice(j, end)
          dynamic = true
          j = end
          continue
        }
        if (src[j] === '`') {
          const end = src.indexOf('`', j + 1)
          substitutions.push(src.slice(j + 1, end < 0 ? src.length : end))
          dynamic = true
          j = end < 0 ? src.length : end + 1
          continue
        }
        if (src[j] === '$' && /[A-Za-z_{]/.test(src[j + 1] ?? '')) dynamic = true
        cur += src[j]
        j++
      }
      inWord = true
      i = j + 1
      continue
    }
    if (c === '$' && src[i + 1] === '(') {
      const end = readBalanced(i + 2, '(', ')')
      substitutions.push(src.slice(i + 2, end - 1))
      cur += src.slice(i, end)
      inWord = true
      dynamic = true
      i = end
      continue
    }
    if (c === '`') {
      const end = src.indexOf('`', i + 1)
      substitutions.push(src.slice(i + 1, end < 0 ? src.length : end))
      inWord = true
      dynamic = true
      i = end < 0 ? src.length : end + 1
      continue
    }
    if ((c === '<' || c === '>') && src[i + 1] === '(') {
      // Process substitution <(…) / >(…)
      push()
      const end = readBalanced(i + 2, '(', ')')
      substitutions.push(src.slice(i + 2, end - 1))
      tokens.push({ t: 'word', v: '/dev/fd/63', dynamic: true })
      i = end
      continue
    }
    if (c === '$' && /[A-Za-z_{0-9@*#?!$-]/.test(src[i + 1] ?? '')) dynamic = true
    if (c === '#' && !inWord) {
      // Comment until end of line.
      while (i < src.length && src[i] !== '\n') i++
      continue
    }
    if (/\s/.test(c)) {
      push()
      if (c === '\n') tokens.push({ t: 'op', v: ';' })
      i++
      continue
    }
    // Operators (longest first).
    const ops = ['&&', '||', '|&', ';;', '<<<', '<<-', '<<', '>>', '&>>', '&>', '>&', '<&', '>|', '|', ';', '&', '(', ')', '<', '>', '{', '}']
    const op = ops.find((o) => src.startsWith(o, i))
    if (op && !(op === '{' || op === '}') ) {
      // `2>` / `2>&1`: a lone fd number before a redirection belongs to it.
      if ((op.startsWith('>') || op.startsWith('<') || op === '&>' || op === '&>>') && inWord && /^\d$/.test(cur)) {
        cur = ''
        inWord = false
      } else push()
      if (op === '<<' || op === '<<-') {
        // Heredoc: the body is data for the command, never commands of the line itself.
        let j = i + op.length
        while (src[j] === ' ') j++
        const m = /^(['"]?)([A-Za-z_][A-Za-z0-9_]*)\1/.exec(src.slice(j))
        tokens.push({ t: 'op', v: '<<' })
        if (m) {
          tokens.push({ t: 'word', v: m[2]! })
          const restStart = src.indexOf('\n', j)
          if (restStart >= 0) {
            // Keep the rest of the current line, drop the body up to the delimiter line.
            const lineRest = src.slice(j + m[0].length, restStart)
            const lines = src.slice(restStart + 1).split('\n')
            const endIdx = lines.findIndex((l) => l.replace(/^\t+/, '') === m[2])
            const after = endIdx < 0 ? '' : lines.slice(endIdx + 1).join('\n')
            const rest = tokenize(`${lineRest}\n${after}`)
            tokens.push(...rest.tokens)
            substitutions.push(...rest.substitutions)
            return { tokens, substitutions }
          }
          i = j + m[0].length
          continue
        }
        i = j
        continue
      }
      tokens.push({ t: 'op', v: op })
      i += op.length
      continue
    }
    if ((c === '{' || c === '}') && !inWord && (src[i + 1] === undefined || /[\s;]/.test(src[i + 1]!))) {
      push()
      tokens.push({ t: 'op', v: ';' })
      i++
      continue
    }
    cur += c
    inWord = true
    i++
  }
  push()
  return { tokens, substitutions }
}

// Program knowledge

const READONLY = new Set(
  'ls ll la cat bat head tail wc grep egrep fgrep rg ag ack fd tree pwd echo printf which whereis type file stat du df basename dirname realpath readlink sort uniq cut tr diff cmp comm jq yq column nl od hexdump xxd md5 md5sum shasum sha1sum sha256sum true false test [ date uname whoami id hostname sw_vers seq sleep wait : less more history locale nproc arch'.split(
    ' ',
  ),
)
const SHELLS = new Set(['sh', 'bash', 'zsh', 'dash', 'ksh', 'fish'])
const INTERPRETERS = new Set(['node', 'python', 'python3', 'ruby', 'perl', 'php', 'deno', 'bun', 'lua', 'Rscript', 'osascript', 'swift', 'ts-node', 'tsx'])
const WRAPPERS = new Set(['time', 'nice', 'nohup', 'command', 'builtin', 'exec', 'caffeinate', 'stdbuf'])
const PRIVILEGED = new Set(['sudo', 'su', 'doas', 'chown', 'chgrp', 'mkfs', 'diskutil', 'shutdown', 'reboot', 'halt', 'launchctl', 'osascript', 'csrutil', 'spctl', 'systemsetup', 'networksetup', 'scutil', 'pmset', 'nvram', 'kextload', 'tmutil', 'dscl', 'passwd', 'visudo', 'crontab', 'at', 'systemctl', 'service', 'iptables', 'pfctl', 'mount', 'umount'])
const DB_CLIENTS = new Set(['psql', 'pg_dump', 'pg_restore', 'mysql', 'mariadb', 'mysqldump', 'mongosh', 'mongo', 'mongodump', 'mongorestore', 'redis-cli', 'sqlcmd', 'cqlsh', 'clickhouse-client', 'clickhouse', 'cockroach', 'influx'])
const CLOUD = new Set(['vercel', 'netlify', 'fly', 'flyctl', 'wrangler', 'firebase', 'heroku', 'railway', 'render', 'amplify', 'serverless', 'sls', 'cdk', 'sam', 'pulumi', 'eb', 'gcloud', 'aws', 'az', 'doctl', 'kubectl', 'helm', 'terraform', 'tofu', 'ansible', 'ansible-playbook', 'eas', 'expo', 'fastlane', 'xcrun', 'surge', 'gsutil', 'linode-cli', 'hcloud', 'supabase', 'neonctl', 'planetscale', 'pscale', 'turso', 'convex', 'appcenter', 'ssh-copy-id'])
const REMOTE_SHELL = new Set(['ssh', 'scp', 'sftp', 'ftp', 'telnet', 'nc', 'ncat', 'netcat', 'socat', 'mosh'])
const HTTP = new Set(['curl', 'wget', 'http', 'https', 'httpie', 'xh', 'aria2c'])
const SECRET_READERS = new Set(['printenv', 'env', 'set', 'pbpaste', 'security', 'keychain', 'op', 'pass', 'gpg', 'ssh-add', 'vault', 'doppler', 'infisical'])
/** Local verifiers that may be run through npx/bunx when installed in the project. */
const VERIFY_TOOLS = new Set(['tsc', 'vitest', 'jest', 'mocha', 'ava', 'tap', 'eslint', 'prettier', 'biome', 'oxlint', 'stylelint', 'playwright', 'cypress', 'vue-tsc', 'svelte-check', 'astro', 'knip', 'depcheck', 'markdownlint', 'cspell', 'tsd', 'attw', 'publint'])
const VERIFY_SCRIPT = /^(test|tests|t|tst|lint|typecheck|type-check|types|check|checks|verify|validate|format:check|fmt:check|prettier:check|e2e|ci|coverage|spec|audit:ci|knip)([:\-_.].*)?$/i
const BUILD_SCRIPT = /^(build|compile|bundle|format|fmt|prettier|lint:fix|fix|generate|gen|codegen|clean:cache|prepare)([:\-_.].*)?$/i
const DEPLOY_SCRIPT = /(deploy|release|ship|promote|rollout)/i
const PUBLISH_SCRIPT = /(publish|upload|send|notify|tweet|post)/i
const DB_SCRIPT = /(migrat|db[:\-_]|seed|prisma:(deploy|push|reset)|drizzle:(push|migrate))/i

/** Variables that change which program, library or config actually runs. */
const DANGEROUS_ENV = /^(PATH|LD_PRELOAD|LD_LIBRARY_PATH|DYLD_[A-Z_]+|NODE_OPTIONS|BASH_ENV|ENV|GIT_SSH|GIT_SSH_COMMAND|GIT_EXEC_PATH|GIT_CONFIG[A-Z_]*|GIT_DIR|GIT_WORK_TREE|PYTHONSTARTUP|PYTHONPATH|RUBYOPT|PERL5OPT|EDITOR|VISUAL|PAGER|GIT_PAGER|npm_config_[a-z_]+|NPM_CONFIG_[A-Z_]+)$/

const isOpt = (a: string) => a.startsWith('-') && a !== '-' && a !== '--'
const firstNonOpt = (args: string[]) => args.find((a) => !isOpt(a))
const has = (args: string[], ...flags: string[]) => args.some((a) => flags.includes(a) || flags.some((f) => f.startsWith('--') && a.startsWith(`${f}=`)))
const hasShort = (args: string[], letter: string) => args.some((a) => /^-[a-zA-Z]+$/.test(a) && a.includes(letter))
const LOCAL_HOST = /^(localhost|127\.0\.0\.1|::1|0\.0\.0\.0|host\.docker\.internal|\[::1\])$/i

type Seg = { category: CommandCategory; reason: string; write?: boolean; network?: boolean; inner?: string[] }
const seg = (category: CommandCategory, reason: string, extra: Partial<Seg> = {}): Seg => ({ category, reason, ...extra })

interface Ctx {
  cwd: string
  workspace: string
  depth: number
}

function classifyNpmLike(tool: string, args: string[], ctx: Ctx): Seg {
  const [sub0, ...rest] = args.filter((a) => a !== '--silent' && a !== '-s' && a !== '--if-present')
  const sub = sub0 ?? (tool === 'yarn' ? 'install' : '')
  const script = (name: string | undefined): Seg => {
    if (!name) return seg('readonly', 'Liste des scripts du projet.')
    if (DEPLOY_SCRIPT.test(name)) return seg('deploy', `Script « ${name} » (déploiement probable).`, { network: true })
    if (PUBLISH_SCRIPT.test(name)) return seg('publish', `Script « ${name} » (publication probable).`, { network: true })
    if (DB_SCRIPT.test(name)) return seg('database', `Script « ${name} » (base de données).`)
    if (VERIFY_SCRIPT.test(name)) return seg('verify', `Script de vérification « ${name} ».`)
    if (BUILD_SCRIPT.test(name)) return seg('build', `Script de compilation « ${name} ».`, { write: true })
    return seg('opaque', `Script « ${name} » du projet : effet inconnu d’Orbit.`)
  }
  switch (sub) {
    case 'test':
    case 't':
    case 'tst':
      return seg('verify', 'Tests du projet.')
    case 'run':
    case 'run-script':
      return script(firstNonOpt(rest))
    case 'install':
    case 'i':
    case 'ci':
    case 'add':
    case 'remove':
    case 'rm':
    case 'uninstall':
    case 'un':
    case 'update':
    case 'up':
    case 'upgrade':
    case 'link':
    case 'dlx':
    case 'exec':
    case 'x':
    case 'create':
    case 'init':
    case 'dedupe':
    case 'rebuild':
    case 'patch':
      return seg('install', `${tool} ${sub} : installation ou exécution de paquets.`, { network: true, write: true })
    case 'audit':
      return has(rest, 'fix') ? seg('install', `${tool} audit fix : modifie les dépendances.`, { network: true, write: true }) : seg('network', `${tool} audit : interroge le registre.`, { network: true })
    case 'publish':
    case 'unpublish':
    case 'deprecate':
    case 'dist-tag':
    case 'owner':
    case 'access':
    case 'login':
    case 'logout':
    case 'adduser':
    case 'token':
    case 'version':
    case 'team':
    case 'org':
      return seg('publish', `${tool} ${sub} : action sur le registre public.`, { network: true })
    case 'ls':
    case 'list':
    case 'll':
    case 'why':
    case 'explain':
    case 'help':
    case 'config':
    case 'get':
    case 'prefix':
    case 'root':
    case 'bin':
    case '--version':
    case '-v':
    case 'pkg':
      return has(rest, 'set', 'delete') ? seg('opaque', `${tool} config set : configuration du gestionnaire.`) : seg('readonly', `${tool} ${sub} : inspection.`)
    case 'outdated':
    case 'view':
    case 'info':
    case 'show':
    case 'search':
      return seg('network', `${tool} ${sub} : interroge le registre.`, { network: true })
    case 'pack':
      return seg('build', `${tool} pack : archive locale.`, { write: true })
    case 'start':
    case 'dev':
    case 'serve':
    case 'preview':
      return seg('opaque', `${tool} ${sub} : lance un serveur ou un script du projet.`)
    case 'tsc':
    case 'vitest':
    case 'jest':
    case 'eslint':
    case 'prettier':
      return classify([sub, ...rest], ctx)
    default:
      // `yarn build`, `pnpm lint`, `bun test`… run a package script directly.
      if (tool === 'bun' && sub === 'test') return seg('verify', 'Tests du projet.')
      if (tool !== 'npm') return script(sub)
      return seg('unknown', `npm ${sub} : sous-commande non reconnue.`)
  }
}

function classifyGit(args: string[], ctx: Ctx): Seg {
  // Global options before the subcommand.
  let i = 0
  while (i < args.length && isOpt(args[i]!)) {
    const a = args[i]!
    if (a === '-c' || a.startsWith('--config-env') || a.startsWith('--exec-path')) return seg('opaque', 'git -c : configuration ponctuelle (peut exécuter des programmes).')
    if (a === '-C' || a === '--git-dir' || a === '--work-tree' || a === '--namespace') i += 2
    else i++
  }
  const sub = args[i] ?? ''
  const rest = args.slice(i + 1)
  const r = (category: CommandCategory, reason: string, extra: Partial<Seg> = {}) => seg(category, `git ${sub} : ${reason}`, extra)
  switch (sub) {
    case 'status':
    case 'diff':
    case 'log':
    case 'show':
    case 'blame':
    case 'rev-parse':
    case 'ls-files':
    case 'ls-tree':
    case 'describe':
    case 'shortlog':
    case 'grep':
    case 'reflog':
    case 'cat-file':
    case 'merge-base':
    case 'version':
    case '--version':
    case 'help':
    case 'check-ignore':
    case 'count-objects':
    case 'whatchanged':
    case 'name-rev':
    case 'rev-list':
    case 'for-each-ref':
    case 'show-ref':
    case 'var':
    case 'range-diff':
      if (sub === 'reflog' && (rest[0] === 'expire' || rest[0] === 'delete')) return r('git-destructive', 'efface l’historique de récupération.', { write: true })
      if (has(rest, '--output', '--ext-diff') || rest.some((a) => a.startsWith('--output='))) return r('opaque', 'option qui écrit un fichier ou lance un programme.')
      return r('readonly', 'inspection du dépôt.')
    case 'branch': {
      if (hasShort(rest, 'D') || has(rest, '--force', '-f') || (has(rest, '--delete', '-d') && has(rest, '--force'))) return r('git-destructive', 'suppression forcée de branche.', { write: true })
      if (rest.length === 0 || rest.every((a) => ['-a', '-r', '-v', '-vv', '--list', '-l', '--show-current', '--all', '--remotes', '--merged', '--no-merged', '--contains'].includes(a) || a.startsWith('--format') || a.startsWith('--sort')))
        return r('readonly', 'liste des branches.')
      return r('git-local', 'gestion locale des branches.', { write: true })
    }
    case 'tag':
      if (rest.length === 0 || has(rest, '-l', '--list', '-n')) return r('readonly', 'liste des étiquettes.')
      if (has(rest, '-d', '--delete', '-f', '--force')) return r('git-destructive', 'supprime ou remplace une étiquette.', { write: true })
      return r('git-local', 'étiquette locale.', { write: true })
    case 'remote':
      if (!rest.length || has(rest, '-v', '--verbose') || ['show', 'get-url'].includes(rest[0] ?? '')) return r(rest[0] === 'show' ? 'network' : 'readonly', 'inspection des dépôts distants.', { network: rest[0] === 'show' })
      return r('git-remote', 'modifie les dépôts distants.', { write: true })
    case 'config':
      if (has(rest, '--get', '--get-all', '--get-regexp', '--list', '-l', '--show-origin') || rest.filter((a) => !isOpt(a)).length <= 1) return r('readonly', 'lecture de la configuration.')
      return r('hooks', 'modifie la configuration Git (alias, hooks, pager : peut exécuter des programmes).', { write: true })
    case 'stash':
      if (['list', 'show'].includes(rest[0] ?? '')) return r('readonly', 'inspection des remises.')
      if (['drop', 'clear'].includes(rest[0] ?? '')) return r('git-destructive', 'supprime des modifications remisées.', { write: true })
      return r('git-local', 'remise locale.', { write: true })
    case 'add':
    case 'commit':
    case 'merge':
    case 'cherry-pick':
    case 'revert':
    case 'mv':
    case 'init':
    case 'notes':
    case 'am':
    case 'bisect':
    case 'apply':
    case 'format-patch':
    case 'worktree':
    case 'sparse-checkout':
    case 'mergetool':
    case 'difftool':
      if (sub === 'worktree' && ['remove', 'prune'].includes(rest[0] ?? '')) return r('git-destructive', 'supprime un espace de travail.', { write: true })
      if (sub === 'worktree' && rest[0] === 'list') return r('readonly', 'liste des espaces de travail.')
      if ((sub === 'mergetool' || sub === 'difftool')) return r('opaque', 'lance un outil externe.')
      return r('git-local', 'opération locale sur le dépôt.', { write: true })
    case 'rm':
      return hasShort(rest, 'r') || rest.some((a) => /[*?]/.test(a) || a === '.') ? r('delete', 'suppression récursive de fichiers suivis.', { write: true }) : r('git-local', 'retire un fichier suivi.', { write: true })
    case 'switch':
      return has(rest, '--discard-changes', '-f', '--force', '-C', '--force-create') ? r('git-destructive', 'abandonne des modifications locales.', { write: true }) : r('git-local', 'change de branche.', { write: true })
    case 'checkout':
      if (has(rest, '-f', '--force', '-B', '--ours', '--theirs') || rest.includes('--') || rest.includes('.')) return r('git-destructive', 'écrase des fichiers de l’espace de travail.', { write: true })
      return r('git-local', 'change de branche.', { write: true })
    case 'restore':
      return rest.length > 0 && rest.every((a) => a === '--staged' || a === '-S' || !isOpt(a)) && has(rest, '--staged', '-S') && !has(rest, '--worktree', '-W')
        ? r('git-local', 'retire de l’index.', { write: true })
        : r('git-destructive', 'abandonne des modifications non enregistrées.', { write: true })
    case 'reset': {
      if (has(rest, '--hard', '--merge', '--keep')) return r('git-destructive', 'abandonne des modifications.', { write: true })
      const refs = rest.filter((a) => !isOpt(a))
      const dashdash = rest.indexOf('--')
      const onlyPaths = refs.length > 0 && refs.every((x) => x !== 'HEAD' && existsSync(resolve(ctx.cwd, x)))
      if (refs.length === 0 || dashdash >= 0 || onlyPaths || (refs.length === 1 && refs[0] === 'HEAD') || (refs[0] === 'HEAD' && refs.slice(1).every((x) => existsSync(resolve(ctx.cwd, x)))))
        return r('git-local', 'retire de l’index.', { write: true })
      return r('git-destructive', 'déplace la branche (réécrit l’historique local).', { write: true })
    }
    case 'clean':
      return has(rest, '-n', '--dry-run') ? r('readonly', 'simulation.') : r('delete', 'supprime les fichiers non suivis.', { write: true })
    case 'rebase':
    case 'filter-branch':
    case 'filter-repo':
    case 'update-ref':
    case 'replace':
    case 'gc':
    case 'prune':
    case 'commit-tree':
    case 'symbolic-ref':
      return r('git-destructive', 'réécrit ou élague l’historique.', { write: true })
    case 'push': {
      const force = has(rest, '--force', '-f', '--force-with-lease', '--delete', '-d', '--mirror', '--prune') || rest.some((a) => a.startsWith('+') || a.startsWith(':') || a.startsWith('--force-with-lease'))
      return force ? r('git-destructive', 'push forcé ou suppression distante.', { network: true }) : r('git-remote', 'envoie des commits vers un dépôt distant.', { network: true })
    }
    case 'pull':
    case 'fetch':
    case 'clone':
    case 'ls-remote':
    case 'submodule':
    case 'lfs':
    case 'request-pull':
    case 'send-email':
    case 'svn':
    case 'archive':
      if (sub === 'archive' && !has(rest, '--remote')) return r('build', 'archive locale.', { write: true })
      if (sub === 'send-email') return r('publish', 'envoie des e-mails.', { network: true })
      return r('git-remote', 'communique avec un dépôt distant.', { network: true, write: sub !== 'ls-remote' })
    default:
      void ctx
      return r('unknown', 'sous-commande non reconnue.')
  }
}

function classifyHttp(tool: string, args: string[]): Seg {
  const method = (() => {
    for (let i = 0; i < args.length; i++) {
      const a = args[i]!
      if (a === '-X' || a === '--request') return (args[i + 1] ?? '').toUpperCase()
      if (a.startsWith('-X') && a.length > 2) return a.slice(2).toUpperCase()
      if (a.startsWith('--request=')) return a.slice(10).toUpperCase()
    }
    return null
  })()
  const sends =
    (method && method !== 'GET' && method !== 'HEAD' && method !== 'OPTIONS') ||
    has(args, '-d', '--data', '--data-raw', '--data-binary', '--data-urlencode', '-F', '--form', '-T', '--upload-file', '--json', '--post-data', '--post-file', '--method', '--body-data', '--body-file') ||
    args.some((a) => /^(-d|-F|-T).+/.test(a) || /^--(data|form|json|post-)/.test(a)) ||
    ((tool === 'http' || tool === 'https' || tool === 'xh' || tool === 'httpie') && /^(POST|PUT|PATCH|DELETE)$/i.test(args.find((a) => !isOpt(a)) ?? ''))
  if (sends) return seg('publish', `${tool} : envoie des données à un service externe.`, { network: true })
  if (has(args, '-o', '--output', '-O', '--remote-name', '-P') || tool === 'wget' || tool === 'aria2c') return seg('network', `${tool} : téléchargement.`, { network: true, write: true })
  return seg('network', `${tool} : requête réseau en lecture.`, { network: true })
}

function classifyDbClient(tool: string, args: string[], env: Record<string, string>): Seg {
  const joined = [...args, ...Object.values(env)].join(' ')
  const hosts: string[] = []
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!
    if (a === '-h' || a === '--host' || a === '-H') hosts.push(args[i + 1] ?? '')
    else if (a.startsWith('--host=')) hosts.push(a.slice(7))
  }
  for (const m of joined.matchAll(/[a-z+]+:\/\/(?:[^@\s/]+@)?([^:/\s?]+)/gi)) hosts.push(m[1]!)
  const remote = hosts.some((h) => h && !LOCAL_HOST.test(h)) || /\b(prod|production|live|primary)\b/i.test(joined)
  if (remote) return seg('database', `${tool} : base de données distante ou de production.`, { network: true })
  return seg('opaque', `${tool} : base de données locale (effet de la requête inconnu d’Orbit).`)
}

function classifyCloud(tool: string, args: string[]): Seg {
  const sub = firstNonOpt(args) ?? ''
  if (has(args, '--version', '-v', '-V', 'version', 'help', '--help', '-h') && args.length <= 2) return seg('readonly', `${tool} : version ou aide.`)
  if (tool === 'supabase' && /^(db|migration)$/.test(sub)) return seg('database', `supabase ${sub} : base de données du projet.`, { network: true })
  if ((tool === 'wrangler' || tool === 'vercel' || tool === 'netlify') && sub === 'dev') return seg('opaque', `${tool} dev : serveur local.`)
  if ((tool === 'vercel' || tool === 'netlify') && /^(env|secrets?)$/.test(sub)) return seg('secrets', `${tool} ${sub} : variables secrètes du projet.`, { network: true })
  if ((tool === 'terraform' || tool === 'tofu') && /^(plan|validate|fmt|show|output|version|providers)$/.test(sub)) return seg(sub === 'plan' ? 'network' : 'verify', `${tool} ${sub} : sans modification de l’infrastructure.`, { network: sub === 'plan' })
  if (tool === 'kubectl' && /^(get|describe|logs|top|explain|version|config|api-resources|diff)$/.test(sub)) return seg('network', `kubectl ${sub} : lecture du cluster.`, { network: true })
  if (tool === 'helm' && /^(list|ls|status|get|history|template|lint|show|search|version)$/.test(sub)) return seg('network', `helm ${sub} : lecture.`, { network: true })
  if (tool === 'xcrun' && !/^(altool|notarytool|stapler)$/.test(sub)) return seg('build', `xcrun ${sub} : outil de développement local.`)
  return seg('deploy', `${tool}${sub ? ` ${sub}` : ''} : action sur une infrastructure ou un service en ligne.`, { network: true })
}

function classifyMigrationTool(tool: string, args: string[]): Seg | null {
  const sub = args.filter((a) => !isOpt(a)).join(' ')
  if (tool === 'prisma') {
    if (/^(generate|format|validate|version|-v)/.test(sub)) return seg('build', `prisma ${sub} : génération locale.`, { write: true })
    if (/^(studio)/.test(sub)) return seg('opaque', 'prisma studio : serveur local.')
    if (/^migrate (dev|diff|status)/.test(sub)) return seg('opaque', `prisma ${sub} : base de développement (effet inconnu d’Orbit).`)
    return seg('database', `prisma ${sub} : modifie la base de données.`, { network: true })
  }
  if (tool === 'drizzle-kit') {
    if (/^(generate|check|up|introspect|pull|export)/.test(sub)) return seg('build', `drizzle-kit ${sub} : génération locale.`, { write: true })
    if (/^studio/.test(sub)) return seg('opaque', 'drizzle-kit studio : serveur local.')
    return seg('database', `drizzle-kit ${sub} : modifie la base de données.`, { network: true })
  }
  if (['knex', 'sequelize', 'typeorm', 'alembic', 'flyway', 'liquibase', 'dbmate', 'goose', 'migrate', 'atlas', 'sqitch'].includes(tool)) return seg('database', `${tool} : migration de base de données.`, { network: true })
  return null
}

/** Classifies one simple command (argv after redirections and env assignments were removed). */
function classify(argv: string[], ctx: Ctx, env: Record<string, string> = {}): Seg {
  if (!argv.length) return seg('readonly', 'Commande vide.')
  const [rawCmd, ...args] = argv as [string, ...string[]]
  const cmd = basename(rawCmd)
  const pathExec = rawCmd.includes('/')

  // Wrappers and launchers: look through them.
  if (cmd === 'command' && (args[0] === '-v' || args[0] === '-V')) return seg('readonly', 'command -v : recherche d’un programme.')
  if (WRAPPERS.has(cmd)) return argv.length > 1 ? classify(args.filter((a, i) => !(i === 0 && isOpt(a))), ctx, env) : seg('readonly', `${cmd}.`)
  if (cmd === 'timeout' || cmd === 'gtimeout') return classify(args.slice(args.findIndex((a) => !isOpt(a)) + 1), ctx, env)
  if (cmd === 'env') {
    const extra: Record<string, string> = {}
    let k = 0
    while (k < args.length) {
      const a = args[k]!
      if (a === '-u' || a === '--unset' || a === '-C' || a === '--chdir') k += 2
      else if (a === '-S' || a.startsWith('--split-string')) return seg('opaque', 'env -S : ligne de commande reconstruite.')
      else if (isOpt(a)) k++
      else if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(a)) {
        extra[a.split('=')[0]!] = a.slice(a.indexOf('=') + 1)
        k++
      } else break
    }
    if (k >= args.length) return seg('secrets', 'env : affiche les variables d’environnement.')
    if (Object.keys(extra).some((n) => DANGEROUS_ENV.test(n))) return seg('opaque', 'Variable d’environnement qui change le programme réellement exécuté.')
    return classify(args.slice(k), ctx, { ...env, ...extra })
  }
  if (cmd === 'xargs') {
    let i = 0
    while (i < args.length && isOpt(args[i]!)) i += /^-[IJLnPsEd]$/.test(args[i]!) ? 2 : 1
    const inner = classify(args.slice(i).length ? args.slice(i) : ['echo'], ctx, env)
    return ROUTINE.includes(inner.category) && inner.category !== 'readonly' ? seg(worst(inner.category, 'opaque'), `xargs : ${inner.reason} (arguments venant de l’entrée)`) : inner
  }
  if (PRIVILEGED.has(cmd)) return seg('privileged', `${cmd} : action système privilégiée.`)
  if (cmd === 'chmod') return hasShort(args, 'R') || has(args, '--recursive') ? seg('privileged', 'chmod récursif.') : seg('build', 'chmod : droits d’un fichier.', { write: true })
  if (cmd === 'dd' || cmd === 'shred' || cmd === 'srm' || cmd === 'wipe') return seg(cmd === 'dd' ? 'privileged' : 'delete', `${cmd} : écriture ou effacement bas niveau.`, { write: true })
  if (cmd === 'defaults') return args[0] === 'read' ? seg('readonly', 'defaults read.') : seg('privileged', 'defaults : préférences système.')
  if (cmd === 'kill' || cmd === 'pkill' || cmd === 'killall') return seg('opaque', `${cmd} : arrête des processus.`)
  if (cmd === 'open' || cmd === 'xdg-open') return seg('opaque', `${cmd} : ouvre une application ou une page.`)
  if (SECRET_READERS.has(cmd)) {
    if (cmd === 'set' && args.length > 0) return seg('readonly', 'set : option du shell.')
    if (cmd === 'gpg' && has(args, '--version')) return seg('readonly', 'gpg --version.')
    return seg('secrets', `${cmd} : lit des secrets ou l’environnement.`)
  }
  if (cmd === 'export' || cmd === 'unset' || cmd === 'alias' || cmd === 'local' || cmd === 'declare' || cmd === 'readonly' || cmd === 'cd' || cmd === 'pushd' || cmd === 'popd' || cmd === 'trap' || cmd === 'shopt' || cmd === 'umask') {
    if (cmd === 'export' && args.some((a) => /^(PATH|LD_PRELOAD|LD_LIBRARY_PATH|DYLD_[A-Z_]+|NODE_OPTIONS|BASH_ENV|ENV|PROMPT_COMMAND|GIT_[A-Z_]+|PYTHONPATH|PYTHONSTARTUP|RUBYOPT|PERL5OPT)=/.test(a)))
      return seg('opaque', 'export : modifie le chargement des programmes suivants.')
    if (cmd === 'export' && args.length === 0) return seg('secrets', 'export : affiche les variables d’environnement.')
    if (cmd === 'alias' || cmd === 'trap') return seg('opaque', `${cmd} : redéfinit le comportement du shell.`)
    return seg('readonly', `${cmd}.`)
  }
  if (cmd === 'source' || cmd === '.') return seg('opaque', `${cmd} : exécute un fichier de script.`)
  if (cmd === 'eval') return seg('opaque', 'eval : exécute un texte construit dynamiquement.', { inner: [args.join(' ')] })
  if (SHELLS.has(cmd)) {
    const ci = args.findIndex((a) => /^-[a-z]*c[a-z]*$/.test(a))
    if (ci >= 0 && args[ci + 1] !== undefined) return seg('readonly', `${cmd} -c`, { inner: [args[ci + 1]!] })
    return seg('opaque', `${cmd} : exécute un script ou l’entrée standard.`)
  }
  if (INTERPRETERS.has(cmd)) {
    if (has(args, '--version', '-v', '-V', '--help') && args.length === 1) return seg('readonly', `${cmd} --version.`)
    if (cmd === 'bun' || cmd === 'deno') {
      const sub = args[0]
      if (sub === 'test') return seg('verify', `${cmd} test.`)
      if (cmd === 'deno' && (sub === 'check' || sub === 'lint' || (sub === 'fmt' && has(args, '--check')))) return seg('verify', `deno ${sub}.`)
      if (cmd === 'bun' && sub && sub !== 'run' && !sub.includes('.') && !sub.includes('/')) return classifyNpmLike('bun', args, ctx)
      if (cmd === 'bun' && sub === 'run') return classifyNpmLike('bun', args, ctx)
    }
    if (/^python3?$/.test(cmd) && args[0] === '-m') {
      const mod = args[1] ?? ''
      if (/^(pytest|unittest|mypy|pyright|ruff|black|flake8|pylint|doctest|compileall|tox|nox)$/.test(mod)) return classify([mod, ...args.slice(2)], ctx, env)
      if (mod === 'pip' || mod === 'ensurepip' || mod === 'venv' || mod === 'virtualenv') return mod === 'pip' ? classify(['pip', ...args.slice(2)], ctx, env) : seg('build', `python -m ${mod}.`, { write: true })
      if (mod === 'http.server') return seg('opaque', 'Serveur HTTP local.')
      if (mod === 'json.tool') return seg('readonly', 'python -m json.tool.')
    }
    if (has(args, '-e', '-c', '--eval', '-p', '--print', '-r', '-E')) return seg('opaque', `${cmd} : exécute du code passé en ligne de commande.`)
    return seg('opaque', `${cmd} : exécute un programme du projet (effet inconnu d’Orbit).`)
  }
  if (cmd === 'npx' || cmd === 'bunx' || cmd === 'pnpx' || (cmd === 'pnpm' && args[0] === 'dlx') || (cmd === 'pnpm' && args[0] === 'exec') || (cmd === 'yarn' && args[0] === 'dlx') || cmd === 'uvx' || cmd === 'pipx') {
    const rest = cmd === 'pnpm' || cmd === 'yarn' ? args.slice(1) : args
    const pkg = firstNonOpt(rest.filter((a, i) => !(i > 0 && /^(-p|--package)$/.test(rest[i - 1]!))))
    const local = pkg && VERIFY_TOOLS.has(pkg) && existsSync(join(ctx.workspace, 'node_modules', '.bin', pkg))
    if (local) return classify(rest.slice(rest.indexOf(pkg!)), ctx, env)
    return seg('install', `${cmd} ${pkg ?? ''} : télécharge et exécute un paquet.`, { network: true })
  }
  if (cmd === 'npm' || cmd === 'pnpm' || cmd === 'yarn') return classifyNpmLike(cmd, args, ctx)
  if (cmd === 'git') return classifyGit(args, ctx)
  if (cmd === 'gh' || cmd === 'glab') {
    const [a, b] = args.filter((x) => !isOpt(x))
    if (a === 'auth' && (b === 'token' || b === 'status')) return seg('secrets', `${cmd} auth ${b} : jeton d’accès.`)
    if (a === 'api') {
      const write = has(args, '-X', '--method', '-f', '-F', '--field', '--raw-field', '--input') && !args.some((x, i) => (x === '-X' || x === '--method') && /^GET$/i.test(args[i + 1] ?? ''))
      return write ? seg('publish', `${cmd} api : requête d’écriture sur le service.`, { network: true }) : seg('network', `${cmd} api : lecture.`, { network: true })
    }
    if (['view', 'list', 'status', 'checks', 'diff', 'ls', 'watch', 'search'].includes(b ?? '') || ['search', 'browse', 'help', 'version', '--version'].includes(a ?? ''))
      return a === 'browse' ? seg('opaque', `${cmd} browse : ouvre le navigateur.`) : seg('network', `${cmd} ${a ?? ''} ${b ?? ''} : lecture.`.replace(/\s+:/, ' :'), { network: true })
    if (a === 'pr' && b === 'checkout') return seg('git-remote', `${cmd} pr checkout.`, { network: true, write: true })
    return seg('publish', `${cmd} ${a ?? ''} ${b ?? ''} : action sur le service (création, fusion, commentaire…).`.replace(/\s+:/, ' :'), { network: true })
  }
  if (HTTP.has(cmd)) return classifyHttp(cmd, args)
  if (REMOTE_SHELL.has(cmd)) return seg('publish', `${cmd} : connexion à une autre machine.`, { network: true })
  if (cmd === 'rsync') return args.some((a) => /^[^/]*:/.test(a) && !/^[A-Za-z]:\\/.test(a)) ? seg('publish', 'rsync vers une autre machine.', { network: true }) : hasDelete(args) ? seg('delete', 'rsync --delete.', { write: true }) : seg('build', 'rsync local.', { write: true })
  if (DB_CLIENTS.has(cmd)) return classifyDbClient(cmd, args, env)
  if (cmd === 'sqlite3') return seg('opaque', 'sqlite3 : base locale (effet de la requête inconnu d’Orbit).')
  const migration = classifyMigrationTool(cmd, args)
  if (migration) return migration
  if (CLOUD.has(cmd)) return classifyCloud(cmd, args)
  if (cmd === 'docker' || cmd === 'podman' || cmd === 'nerdctl') {
    const sub = args.filter((a) => !isOpt(a))
    const s = sub[0] === 'compose' || sub[0] === 'container' || sub[0] === 'image' ? `${sub[0]} ${sub[1] ?? ''}` : (sub[0] ?? '')
    if (/^(ps|images|logs|inspect|version|info|compose ps|compose logs|compose config|image ls|container ls|stats|top|history|diff)/.test(s)) return seg('readonly', `${cmd} ${s} : inspection.`)
    if (/^(push|login|logout|compose push|image push|buildx imagetools)/.test(s)) return seg('publish', `${cmd} ${s} : publication d’image.`, { network: true })
    if (/^(rm|rmi|system prune|volume rm|volume prune|image prune|container prune|network rm|compose down|compose rm|builder prune)/.test(s)) return seg('delete', `${cmd} ${s} : supprime des conteneurs, images ou volumes.`)
    if (/^(build|compose build|buildx build)/.test(s)) return seg('build', `${cmd} ${s} : construction d’image.`, { network: true })
    if (/^(pull|compose pull)/.test(s)) return seg('install', `${cmd} ${s} : télécharge une image.`, { network: true })
    return seg('opaque', `${cmd} ${s} : lance un conteneur ou une commande.`)
  }
  if (cmd === 'rm' || cmd === 'rmdir' || cmd === 'unlink' || cmd === 'trash') {
    if (cmd === 'rmdir' || cmd === 'unlink' || cmd === 'trash') return seg('build', `${cmd} : supprime un élément.`, { write: true })
    const targets = args.filter((a) => !isOpt(a))
    const recursive = hasShort(args, 'r') || hasShort(args, 'R') || has(args, '--recursive')
    const broad = targets.some((t) => /[*?[]/.test(t) || t === '.' || t === '..' || t === '/' || t === '~' || t.endsWith('/') || /^\.{1,2}\/?$/.test(t)) || targets.length > 5
    if (recursive || broad) return seg('delete', `rm${recursive ? ' récursif' : ''} : suppression ${broad ? 'large' : 'de dossiers'}.`, { write: true })
    return seg('build', 'rm : supprime un fichier.', { write: true })
  }
  if (cmd === 'find') {
    if (has(args, '-delete')) return seg('delete', 'find -delete : suppression en masse.', { write: true })
    const ei = args.findIndex((a) => /^-(exec|execdir|ok|okdir)$/.test(a))
    if (ei >= 0) {
      const end = args.findIndex((a, i) => i > ei && (a === ';' || a === '\\;' || a === '+'))
      const inner = args.slice(ei + 1, end < 0 ? undefined : end).map((a) => (a === '{}' ? 'FICHIER' : a))
      const c = classify(inner, ctx, env)
      return seg(c.category === 'readonly' ? 'readonly' : worst(c.category, 'build'), `find -exec : ${c.reason}`, { write: c.write })
    }
    if (has(args, '-fprint', '-fprintf', '-fls')) return seg('build', 'find : écrit un fichier.', { write: true })
    return seg('readonly', 'find : recherche de fichiers.')
  }
  if (cmd === 'sed' || cmd === 'gsed') {
    const inPlace = args.some((a) => /^-[a-zA-Z]*i/.test(a) || a.startsWith('--in-place'))
    const script = args.filter((a) => !isOpt(a)).join(' ')
    if (/(^|[;}\n]\s*)(e|w)\b|\/[ew]\s|\/[gpIi]*[ew]\b/.test(script)) return seg('opaque', 'sed : écrit un fichier ou exécute une commande.')
    return inPlace ? seg('build', 'sed -i : modifie des fichiers.', { write: true }) : seg('readonly', 'sed : transformation de texte.')
  }
  if (cmd === 'awk' || cmd === 'gawk' || cmd === 'mawk') {
    const script = args.filter((a) => !isOpt(a)).join(' ')
    return /system\s*\(|\|\s*"|getline|print[^;}]*>/.test(script) ? seg('opaque', 'awk : exécute une commande ou écrit un fichier.') : seg('readonly', 'awk : transformation de texte.')
  }
  if (cmd === 'tee') return seg('build', 'tee : écrit un fichier.', { write: true })
  if (['mkdir', 'touch', 'cp', 'mv', 'ln', 'install', 'truncate', 'ditto', 'patch', 'tar', 'zip', 'unzip', 'gzip', 'gunzip', 'bzip2', 'xz', 'unxz', '7z', 'split', 'csplit', 'iconv'].includes(cmd)) {
    if (cmd === 'tar' && args.some((a) => /^-?[a-z]*t[a-z]*f?$/.test(a) && !/[cxru]/.test(a))) return seg('readonly', 'tar : liste d’une archive.')
    return seg('build', `${cmd} : modifie des fichiers.`, { write: true })
  }
  if (cmd === 'tsc' || cmd === 'vue-tsc') return has(args, '--noEmit', '--noemit') || has(args, '--version', '-v', '--help', '--showConfig') ? seg('verify', 'tsc : vérification des types.') : seg('build', 'tsc : compilation.', { write: true })
  if (['vitest', 'jest', 'mocha', 'ava', 'tap', 'pytest', 'py.test', 'mypy', 'pyright', 'flake8', 'pylint', 'rspec', 'phpunit', 'svelte-check', 'knip', 'depcheck', 'cspell', 'markdownlint', 'shellcheck', 'hadolint', 'tsd', 'attw', 'publint', 'oxlint', 'stylelint', 'unittest', 'doctest', 'tox', 'nox'].includes(cmd)) {
    if ((cmd === 'stylelint' || cmd === 'markdownlint' || cmd === 'oxlint') && has(args, '--fix')) return seg('build', `${cmd} --fix : corrige des fichiers.`, { write: true })
    if (cmd === 'jest' || cmd === 'vitest') if (has(args, '-u', '--updateSnapshot', '--update')) return seg('build', `${cmd} : met à jour des instantanés.`, { write: true })
    return seg('verify', `${cmd} : tests ou analyse.`)
  }
  if (cmd === 'eslint') return has(args, '--fix', '--fix-dry-run') && !has(args, '--fix-dry-run') ? seg('build', 'eslint --fix : corrige des fichiers.', { write: true }) : seg('verify', 'eslint : analyse.')
  if (cmd === 'prettier') return has(args, '--write', '-w') ? seg('build', 'prettier --write : reformate des fichiers.', { write: true }) : seg('verify', 'prettier : vérification du format.')
  if (cmd === 'biome') return has(args, '--write', '--apply', '--fix', '--apply-unsafe') || args[0] === 'format' && !has(args, '--check') ? seg('build', 'biome : corrige des fichiers.', { write: true }) : seg('verify', 'biome : analyse.')
  if (cmd === 'ruff') return args[0] === 'format' && !has(args, '--check', '--diff') ? seg('build', 'ruff format.', { write: true }) : has(args, '--fix') ? seg('build', 'ruff --fix.', { write: true }) : seg('verify', 'ruff : analyse.')
  if (cmd === 'black' || cmd === 'isort' || cmd === 'gofmt' || cmd === 'rustfmt' || cmd === 'swiftformat' || cmd === 'clang-format' || cmd === 'swift-format') return has(args, '--check', '-l', '--diff', '-d', '--lint', '--dry-run') ? seg('verify', `${cmd} : vérification du format.`) : seg('build', `${cmd} : reformate des fichiers.`, { write: true })
  if (cmd === 'go') {
    const sub = args[0] ?? ''
    if (/^(test|vet)$/.test(sub)) return seg('verify', `go ${sub}.`)
    if (/^(build|fmt|generate|mod tidy|mod vendor)$/.test(sub) || (sub === 'mod' && /^(tidy|vendor|init|edit)$/.test(args[1] ?? ''))) return seg(sub === 'mod' && args[1] === 'tidy' ? 'install' : 'build', `go ${sub}.`, { write: true, network: sub === 'mod' && args[1] === 'tidy' })
    if (/^(version|env|list|doc|help)$/.test(sub)) return seg('readonly', `go ${sub}.`)
    if (/^(get|install|mod)$/.test(sub)) return seg('install', `go ${sub} : télécharge des modules.`, { network: true, write: true })
    if (sub === 'run') return seg('opaque', 'go run : exécute un programme du projet.')
    return seg('unknown', `go ${sub}.`)
  }
  if (cmd === 'cargo') {
    const sub = args[0] ?? ''
    if (/^(test|check|bench|nextest)$/.test(sub) || (sub === 'clippy' && !has(args, '--fix')) || (sub === 'fmt' && has(args, '--check'))) return seg('verify', `cargo ${sub}.`)
    if (/^(build|fmt|doc|clippy|fix|clean)$/.test(sub)) return seg('build', `cargo ${sub}.`, { write: true })
    if (/^(tree|metadata|version|--version|-V|help|search|pkgid|locate-project|read-manifest)$/.test(sub)) return seg('readonly', `cargo ${sub}.`)
    if (/^(install|add|remove|rm|update|fetch|vendor|generate-lockfile|uninstall)$/.test(sub)) return seg('install', `cargo ${sub} : dépendances.`, { network: true, write: true })
    if (/^(publish|login|logout|owner|yank)$/.test(sub)) return seg('publish', `cargo ${sub} : registre public.`, { network: true })
    if (sub === 'run') return seg('opaque', 'cargo run : exécute un programme du projet.')
    return seg('unknown', `cargo ${sub}.`)
  }
  if (cmd === 'swift' || cmd === 'xcodebuild') {
    const s = args.find((a) => !isOpt(a)) ?? ''
    if (/^(test|-version|--version)$/.test(s) || has(args, 'test', '-version', '-showsdks', '-list')) return seg(has(args, 'test') || s === 'test' ? 'verify' : 'readonly', `${cmd} ${s}.`)
    if (cmd === 'swift' && s === 'package') return /^(resolve|update|add-dependency)$/.test(args[1] ?? '') ? seg('install', 'swift package : dépendances.', { network: true, write: true }) : seg('readonly', `swift package ${args[1] ?? ''}.`)
    if (cmd === 'swift' && s === 'run') return seg('opaque', 'swift run.')
    return seg('build', `${cmd} : compilation.`, { write: true })
  }
  if (cmd === 'make' || cmd === 'gmake' || cmd === 'just' || cmd === 'task' || cmd === 'rake' || cmd === 'mage') {
    const targets = args.filter((a) => !isOpt(a) && !a.includes('='))
    if (has(args, '-n', '--dry-run', '--just-print', '-l', '--list', '--summary')) return seg('readonly', `${cmd} : simulation.`)
    let worstSeg: Seg = seg('build', `${cmd} : cible par défaut du projet.`, { write: true })
    if (cmd !== 'make' && cmd !== 'gmake' && !targets.length) worstSeg = seg('opaque', `${cmd} : recette par défaut.`)
    for (const t of targets) {
      const s = DEPLOY_SCRIPT.test(t) ? seg('deploy', `${cmd} ${t}.`, { network: true }) : PUBLISH_SCRIPT.test(t) ? seg('publish', `${cmd} ${t}.`, { network: true }) : DB_SCRIPT.test(t) ? seg('database', `${cmd} ${t}.`) : /^(install|deps|setup|bootstrap|vendor)$/.test(t) ? seg('install', `${cmd} ${t}.`, { network: true, write: true }) : /^(clean|distclean|purge|nuke)$/.test(t) ? seg('delete', `${cmd} ${t}.`, { write: true }) : VERIFY_SCRIPT.test(t) ? seg('verify', `${cmd} ${t}.`) : BUILD_SCRIPT.test(t) || /^(all|default|dist|release-build)$/.test(t) ? seg('build', `${cmd} ${t}.`, { write: true }) : seg('opaque', `${cmd} ${t} : recette du projet.`)
      if (severity(s.category) > severity(worstSeg.category) || worstSeg.reason.includes('défaut')) worstSeg = s
    }
    return worstSeg
  }
  if (cmd === 'mvn' || cmd === 'gradle' || (pathExec && /^(gradlew|mvnw)$/.test(cmd))) {
    const goals = args.filter((a) => !isOpt(a))
    if (goals.some((g) => /deploy|publish|release/i.test(g))) return seg('deploy', `${cmd} : publication d’artefacts.`, { network: true })
    if (goals.length && goals.every((g) => /^(test|check|verify|lint|validate|clean)$/i.test(g))) return seg('verify', `${cmd} ${goals.join(' ')}.`)
    return seg('build', `${cmd} ${goals.join(' ')} : compilation.`, { write: true, network: true })
  }
  if (cmd === 'pip' || cmd === 'pip3' || cmd === 'uv' || cmd === 'poetry' || cmd === 'pipenv' || cmd === 'conda' || cmd === 'gem' || cmd === 'bundle' || cmd === 'composer' || cmd === 'brew' || cmd === 'port' || cmd === 'apt' || cmd === 'apt-get' || cmd === 'pod' || cmd === 'carthage' || cmd === 'mint' || cmd === 'dotnet' || cmd === 'mix' || cmd === 'hex' || cmd === 'nuget') {
    const sub = args.find((a) => !isOpt(a)) ?? ''
    if (/^(list|show|freeze|check|info|search|outdated|doctor|config|env|--version|version|help|tree|why|exec)$/.test(sub) && !(cmd === 'bundle' && sub === 'exec') && !(cmd === 'uv' && sub === 'run')) return seg('readonly', `${cmd} ${sub}.`)
    if ((cmd === 'bundle' && sub === 'exec') || ((cmd === 'uv' || cmd === 'poetry' || cmd === 'pipenv') && sub === 'run')) return classify(args.slice(args.indexOf(sub) + 1), ctx, env)
    if (cmd === 'dotnet' && /^(test)$/.test(sub)) return seg('verify', 'dotnet test.')
    if (cmd === 'dotnet' && /^(build|format|clean)$/.test(sub)) return seg('build', `dotnet ${sub}.`, { write: true })
    if (cmd === 'mix' && sub === 'test') return seg('verify', 'mix test.')
    if (/^(publish|upload|push)$/.test(sub)) return seg('publish', `${cmd} ${sub} : registre public.`, { network: true })
    return seg('install', `${cmd} ${sub} : installation de dépendances ou de logiciels.`, { network: true, write: true })
  }
  if (cmd === 'twine' || cmd === 'vsce' || cmd === 'ovsx') return seg('publish', `${cmd} : publication.`, { network: true })
  if (READONLY.has(cmd)) return seg('readonly', `${cmd} : lecture.`)
  if (pathExec) return seg('opaque', `${rawCmd} : exécute un script ou un programme du projet.`)
  return seg('unknown', `${cmd} : programme inconnu d’Orbit.`)
}

function hasDelete(args: string[]): boolean {
  return args.some((a) => a.startsWith('--delete') || a === '--remove-source-files')
}

// Paths

/** Resolves a word that names a path. `null` when it cannot (variables, globs at the root…). */
function pathOf(word: string, cwd: string): string | null {
  const home = process.env.HOME ?? homedir()
  let w = word
  if (/^~(\/|$)/.test(w)) w = home + w.slice(1)
  w = w.replace(/^\$\{?HOME\}?(?=\/|$)/, home)
  if (w.includes('$')) return null
  return isAbsolute(w) ? resolve(w) : resolve(cwd, w)
}

/** Does this argument look like a filesystem path (rather than a pattern, ref, URL or message)? */
function looksLikePath(a: string): boolean {
  if (!a || a.startsWith('-')) return false
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(a)) return false
  if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(a)) return false
  if (a.includes('\n') || a.length > 4096) return false
  return a.startsWith('/') || a.startsWith('~') || a.startsWith('./') || a.startsWith('../') || a === '..' || a === '.' || /^\$\{?HOME\}?/.test(a) || /(^|\/)\.\.(\/|$)/.test(a) || /^[\w.@-]+(\/[\w.@*?-]+)+\/?$/.test(a) || /^\.[\w-]+/.test(a) || /\.[a-z0-9]{1,6}$/i.test(a)
}

// Entry point

/**
 * Analyses a full command line. `workspace` is the companion's real folder; relative paths
 * are resolved against `cwd` (default: the workspace) while following `cd`.
 */
export function analyzeCommand(command: string, workspace: string, cwd = workspace, depth = 0): CommandAnalysis {
  const out: CommandAnalysis = { category: 'readonly', segments: [], paths: [], writes: [], reason: 'Commande vide.', needs: { write: false, network: false } }
  const add = (argv: string[], s: Seg) => {
    const first = out.segments.length === 0
    out.segments.push({ argv, category: s.category, reason: s.reason })
    if (s.write) out.needs.write = true
    if (s.network) out.needs.network = true
    if (first || severity(s.category) > severity(out.category)) {
      out.category = s.category
      out.reason = s.reason
    }
  }
  if (depth > 4) {
    add([command], seg('opaque', 'Imbrication de shells trop profonde.'))
    return out
  }
  const { tokens, substitutions } = tokenize(command)
  for (const sub of substitutions) {
    const inner = analyzeCommand(sub, workspace, cwd, depth + 1)
    mergeInto(out, inner)
    add(['$(…)'], seg(inner.category === 'readonly' ? 'opaque' : worst(inner.category, 'opaque'), 'Substitution de commande : l’argument réel n’est connu qu’à l’exécution.'))
  }

  let current = cwd
  let words: Tok[] = []
  let prevOp: string | null = null
  let prevCategory: CommandCategory | null = null
  const flush = (nextOp: string | null) => {
    const argv: string[] = []
    const env: Record<string, string> = {}
    let dynamicArg = false
    let k = 0
    // Leading assignments: FOO=bar cmd
    while (k < words.length && words[k]!.t === 'word' && /^[A-Za-z_][A-Za-z0-9_]*=/.test(words[k]!.v)) {
      const w = words[k]!.v
      env[w.split('=')[0]!] = w.slice(w.indexOf('=') + 1)
      k++
    }
    for (; k < words.length; k++) {
      const w = words[k]!
      if (w.t === 'op' && ['>', '>>', '>|', '&>', '&>>', '>&'].includes(w.v)) {
        const target = words[k + 1]
        k++
        if (!target || target.t !== 'word') continue
        if (/^\d+$/.test(target.v) || target.v === '-' || /^\/dev\/(null|stdout|stderr|tty|fd\/\d+)$/.test(target.v)) continue
        const p = target.dynamic ? null : pathOf(target.v, current)
        if (!p) add([`> ${target.v}`], seg('opaque', 'Redirection vers un chemin dynamique.'))
        else {
          out.writes.push(p)
          out.paths.push(p)
          out.needs.write = true
          add([`> ${target.v}`], seg('build', 'Redirection : écrit un fichier.', { write: true }))
        }
        continue
      }
      if (w.t === 'op' && (w.v === '<' || w.v === '<&' || w.v === '<<<' || w.v === '<<')) {
        const target = words[k + 1]
        k++
        if (w.v === '<' && target?.t === 'word') {
          const p = target.dynamic ? null : pathOf(target.v, current)
          if (p) out.paths.push(p)
        }
        continue
      }
      if (w.t === 'word') {
        if (w.dynamic) dynamicArg = true
        argv.push(w.v)
      }
    }
    words = []
    if (Object.keys(env).some((n) => DANGEROUS_ENV.test(n)))
      add(argv.length ? argv : ['env'], seg('opaque', 'Variable d’environnement qui change le programme réellement exécuté.'))
    if (!argv.length) {
      prevOp = nextOp
      return
    }
    const cmdName = basename(argv[0]!)
    // Data piped into a shell or interpreter: if it comes from the network, it is remote code.
    if (prevOp === '|' && (SHELLS.has(cmdName) || INTERPRETERS.has(cmdName)) && argv.length <= 2 && !argv.some((a) => /^-[a-z]*c/.test(a))) {
      add(argv, prevCategory && ['network', 'publish', 'install'].includes(prevCategory) ? seg('install', 'Code téléchargé exécuté directement (curl … | sh).', { network: true }) : seg('opaque', `${cmdName} exécute le texte reçu par le tube.`))
      prevCategory = 'opaque'
      prevOp = nextOp
      return
    }
    const s = classify(argv, { cwd: current, workspace, depth }, env)
    if (dynamicArg && ROUTINE.includes(s.category) && s.category !== 'readonly') s.category = 'opaque'
    // `echo $API_TOKEN`: expanding a credential-looking variable prints a secret.
    if (argv.some((a) => /\$\{?[A-Za-z0-9_]*(KEY|TOKEN|SECRET|PASS|PASSWD|PASSWORD|AUTH|CRED|PRIVATE|COOKIE|SESSION)[A-Za-z0-9_]*/i.test(a))) {
      s.category = worst(s.category, 'secrets')
      s.reason = 'La commande développe une variable qui contient probablement un secret.'
    }
    add(argv, s)
    prevCategory = s.category
    for (const inner of s.inner ?? []) mergeInto(out, analyzeCommand(inner, workspace, current, depth + 1))
    // Paths: every path-like argument is checked by the policy (inside / outside / protected).
    const args = argv.slice(1)
    for (let i = 0; i < args.length; i++) {
      let a = args[i]!
      const eq = /^--?[A-Za-z][\w-]*=(.+)$/.exec(a)
      if (eq) a = eq[1]!
      if (!looksLikePath(a)) continue
      const p = pathOf(a, current)
      if (!p) {
        if (!ROUTINE.includes(s.category) || s.category === 'readonly') continue
        add(argv, seg('opaque', 'Chemin construit à partir d’une variable.'))
        continue
      }
      out.paths.push(p)
      if (s.write) out.writes.push(p)
    }
    if (cmdName === 'cd' || cmdName === 'pushd') {
      const target = args.find((a) => !isOpt(a))
      const p = target ? pathOf(target, current) : (process.env.HOME ?? homedir())
      if (p) {
        current = p
        out.paths.push(p)
      } else add(argv, seg('opaque', 'cd vers un chemin dynamique.'))
    }
    if (cmdName === 'git') {
      const ci = argv.indexOf('-C')
      if (ci > 0 && argv[ci + 1]) {
        const p = pathOf(argv[ci + 1]!, current)
        if (p) out.paths.push(p)
      }
    }
    prevOp = nextOp
  }
  for (const t of tokens) {
    if (t.t === 'op' && ['&&', '||', ';', '|', '|&', '&', ';;', '(', ')'].includes(t.v)) {
      flush(t.v === '|&' ? '|' : t.v)
      continue
    }
    words.push(t)
  }
  flush(null)
  if (!out.segments.length) out.reason = 'Commande vide.'
  out.paths = [...new Set(out.paths)]
  out.writes = [...new Set(out.writes)]
  return out
}

function mergeInto(out: CommandAnalysis, inner: CommandAnalysis) {
  const first = out.segments.length === 0
  for (const s of inner.segments) out.segments.push(s)
  out.paths.push(...inner.paths)
  out.writes.push(...inner.writes)
  if (inner.needs.write) out.needs.write = true
  if (inner.needs.network) out.needs.network = true
  if (inner.segments.length && (first || severity(inner.category) > severity(out.category))) {
    out.category = inner.category
    out.reason = inner.reason
  }
}

/** Stable form of a command for persistent grants: same words, same order, normalised spacing. */
export function normalizeCommand(command: string): string {
  return command.trim().replace(/\s+/g, ' ')
}
