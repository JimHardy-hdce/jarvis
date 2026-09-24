import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { builtinTools, checkToolUse, decideTool, fileRoots } from '../bridge/policy.mjs'

const workspace = mkdtempSync(join(tmpdir(), 'jarvis-ws-'))
const roots = fileRoots({ workspace })
const ctx = (allowWrites = false) => ({ allowWrites, cwd: workspace, roots })
const allowed = (name, input, w) => checkToolUse(name, input, ctx(w)).allow

test('decideTool keeps its existing verdicts', () => {
  assert.equal(decideTool('Read'), true)
  assert.equal(decideTool('Bash'), false)
  assert.equal(decideTool('Bash', true), true)
  assert.equal(decideTool('mcp__jarvis__display'), true)
  assert.equal(decideTool('mcp__someserver__list_devices'), true)
  assert.equal(decideTool('mcp__someserver__install_apk'), false)
  assert.equal(decideTool('mcp__higgsfield__generate_image'), true)
  assert.equal(decideTool('mcp__elevenlabs__make_outbound_call'), false)
  assert.equal(decideTool('SomeFutureBuiltin'), false)
})

test('read-only mode refuses a shell command the CLI would auto-approve', () => {
  // `cat` is what the CLI's own classifier runs without asking canUseTool.
  assert.equal(allowed('Bash', { command: 'cat ~/.ssh/id_rsa' }), false)
  assert.equal(allowed('Bash', { command: 'ls' }), false)
  assert.equal(allowed('Bash', { command: 'ls' }, true), true)
})

test('file tools are confined to the workspace and temp roots', () => {
  writeFileSync(join(workspace, 'note.txt'), 'hi')
  assert.equal(allowed('Read', { file_path: join(workspace, 'note.txt') }), true)
  assert.equal(allowed('Read', { file_path: 'note.txt' }), true) // relative to cwd
  assert.equal(allowed('Read', { file_path: join(tmpdir(), 'shot.png') }), true)
  assert.equal(allowed('Read', { file_path: join(homedir(), '.bashrc') }), false)
  assert.equal(allowed('Read', { file_path: '~/.claude/.credentials.json' }), false)
  assert.equal(allowed('Read', { file_path: '/etc/passwd' }), false)
  assert.equal(allowed('Read', { file_path: join(workspace, '..', '..', 'etc', 'passwd') }), false)
  assert.equal(allowed('Grep', { pattern: 'x', path: '/home' }), false)
  assert.equal(allowed('Glob', { pattern: '**/*' }), true) // no path = cwd
})

test('a symlink inside the workspace cannot point the read elsewhere', () => {
  const link = join(workspace, 'innocent.png')
  try {
    symlinkSync('/etc/hostname', link)
  } catch {
    return // no symlinks on this filesystem
  }
  assert.equal(allowed('Read', { file_path: link }), false)
})

test('credentials stay refused even when the roots include home', () => {
  const wide = { allowWrites: false, cwd: workspace, roots: fileRoots({ workspace, extra: [homedir()] }) }
  const ok = (p) => checkToolUse('Read', { file_path: p }, wide).allow
  assert.equal(ok(join(homedir(), 'Pictures', 'cat.png')), true)
  assert.equal(ok(join(homedir(), '.ssh', 'id_ed25519')), false)
  assert.equal(ok(join(homedir(), '.claude', '.credentials.json')), false)
  assert.equal(ok(join(homedir(), '.claude.json')), false)
  assert.equal(ok(join(homedir(), 'project', '.env')), false)
  assert.equal(ok(join(homedir(), 'project', '.env.local')), false)
  assert.equal(ok(join(homedir(), 'certs', 'server.pem')), false)
})

test('writes are confined too, when writes are on', () => {
  mkdirSync(join(workspace, 'out'), { recursive: true })
  assert.equal(allowed('Write', { file_path: join(workspace, 'out', 'a.txt') }, true), true)
  assert.equal(allowed('Write', { file_path: join(homedir(), 'a.txt') }, true), false)
  assert.equal(allowed('Edit', { file_path: '/etc/hosts' }, true), false)
  assert.equal(allowed('Write', { file_path: join(workspace, 'a.txt') }, false), false)
})

test('WebFetch cannot be pointed at the LAN, loopback or cloud metadata', () => {
  assert.equal(allowed('WebFetch', { url: 'https://example.com/a' }), true)
  assert.equal(allowed('WebFetch', { url: 'http://127.0.0.1:8787/file?path=/x.png' }), false)
  assert.equal(allowed('WebFetch', { url: 'http://169.254.169.254/latest/meta-data/' }), false)
  assert.equal(allowed('WebFetch', { url: 'http://192.168.1.1/' }), false)
  assert.equal(allowed('WebFetch', { url: 'http://printer.local/' }), false)
  assert.equal(allowed('WebFetch', { url: 'file:///etc/passwd' }), false)
})

test('only the built-ins JARVIS uses are offered', () => {
  const ro = builtinTools(false)
  assert.deepEqual(ro.filter((t) => ['Bash', 'Write', 'Edit'].includes(t)), [])
  for (const absent of ['Agent', 'Task', 'CronCreate', 'RemoteTrigger', 'SendMessage', 'AskUserQuestion', 'Skill']) {
    assert.ok(!ro.includes(absent), `${absent} should not be offered`)
    assert.ok(!builtinTools(true).includes(absent), `${absent} should not be offered with writes`)
  }
  assert.ok(builtinTools(true).includes('Bash'))
})
