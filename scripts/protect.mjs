/**
 * 打包保护流水线（**只在 `npm run pack` / `npm run dist` 里跑**，开发不受影响）
 *
 * 顺序很重要：
 *   1. **V8 字节码**：`out/main/index.js`、`out/preload/index.js` 用 bytenode 编成 `.jsc`，
 *      原文件换成一个几行的加载器。字节码必须在**同一个 V8** 下编译，
 *      所以 bytenode 会拉起 Electron 自己来编译（`electronMain` / `electronRenderer`），
 *      而且主进程与预加载的 V8 不是同一套 flags，**不能混用**（bytenode 会直接报错拒绝）。
 *   2. **混淆**：渲染层的 js 过一遍 javascript-obfuscator（字符串数组 + 十六进制标识符）。
 *   3. **加密**：html / js / css 用 AES-256-GCM 就地加密，运行时由 `blwe://` 协议解密。
 *      （混淆必须在加密之前 —— 加密之后就是密文了，混淆器读不懂。）
 *
 * 为什么步骤 1 里保留加载器而不是直接换入口：electron-builder 的 `files` 与 `package.json main`
 * 都指向 `out/main/index.js`，原地替换最省事，也不会漏改打包配置。
 */
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'
import JavaScriptObfuscator from 'javascript-obfuscator'

const require = createRequire(import.meta.url)
const root = path.resolve(import.meta.dirname, '..')
const bytenode = require('bytenode')

/**
 * 清掉 `ELECTRON_RUN_AS_NODE`
 *
 * bytenode 编译字节码时要**拉起 Electron 自己**（必须用同一套 V8），
 * 它会以 `ELECTRON_RUN_AS_NODE=1 electron.exe --no-sandbox …` 的方式跑。
 * 如果当前环境里本来就带着这个变量（有些 CI / 终端会设），Electron 会退化成纯 Node，
 * 于是 `--no-sandbox` 变成「bad option」——报错信息完全看不出真正原因。
 */
delete process.env.ELECTRON_RUN_AS_NODE

const MAGIC = Buffer.from('BLWE1')
const IV_LEN = 12
const TAG_LEN = 16

const log = (...args) => console.log('[protect]', ...args)
const rel = (p) => path.relative(root, p).replace(/\\/g, '/')
const size = (n) => `${(n / 1024).toFixed(1)} KB`

/** 从 bundleKey.ts 里读密钥（和运行时是同一个常量），环境变量优先 */
const readKey = () => {
  if (process.env.BLWE_BUNDLE_KEY) return process.env.BLWE_BUNDLE_KEY
  const src = fs.readFileSync(path.join(root, 'electron/main/bundleKey.ts'), 'utf8')
  const m = /BUNDLE_KEY\s*=\s*'([0-9a-fA-F]+)'/.exec(src)
  if (!m) throw new Error('读不到 BUNDLE_KEY（electron/main/bundleKey.ts）')
  return m[1]
}

const aesKey = () => crypto.createHash('sha256').update(readKey(), 'utf8').digest()

// #region 1. V8 字节码

const LOADER = `'use strict'
/*
 * 打包保护生成的加载器（源码在 scripts/protect.mjs）
 * 真正的代码在同目录的 .jsc 里 —— V8 字节码，不是明文 JS。
 *
 * 注意必须用 require('./index.jsc') 这种形式：
 * bytenode 会挂上 .jsc 的模块扩展，这样字节码是作为 **CommonJS 模块**被加载的；
 * 换成 runBytecodeFile() 只会把模块包装函数定义出来、不执行
 * （踩过：窗口永远不出现，而且不报任何错）。
 */
require('bytenode')

module.exports = require('./index.jsc')
`

/**
 * 把一个构建产物编成字节码 + 换成交互式加载器
 *
 * @param where 'main' 主进程；'preload' 预加载（跑在渲染进程里，V8 flags 不同，必须选对）
 */
const compileToBytecode = async (file, where) => {
  const out = file.replace(/\.js$/, '.jsc')
  const before = fs.statSync(file).size
  await bytenode.compileFile({
    filename: file,
    output: out,
    compileAsModule: true,
    electronMain: where === 'main',
    electronRenderer: where === 'preload',
  })
  fs.writeFileSync(file, LOADER, 'utf8')
  log(
    `字节码 ${rel(file)} -> ${rel(out)}（${size(before)} -> ${size(fs.statSync(out).size)}）+ 加载器`,
  )
}

// #endregion

// #region 2. 渲染层混淆

const OBFUSCATOR_OPTIONS = {
  compact: true,
  target: 'browser',
  sourceType: 'module',
  // 十六进制标识符：反编译出来的名字全是 _0x1a2b 这种
  identifierNamesGenerator: 'hexadecimal',
  // 关键：**不要**重命名全局。Vue / Element Plus 的产物靠全局与模块约定跑，
  // 打开它会把运行时特征改掉（实测会白屏）。
  renameGlobals: false,
  renameProperties: false,
  stringArray: true,
  stringArrayThreshold: 0.75,
  stringArrayEncoding: ['base64'],
  rotateStringArray: true,
  shuffleStringArray: true,
  splitStrings: true,
  splitStringsChunkLength: 12,
  // 控制流平坦化 / 死代码：体积和风险都陡增（这个 bundle 有 1MB+），保持关闭
  controlFlowFlattening: false,
  deadCodeInjection: false,
  // 自校验与调试保护会把「反调试」那套跑在用户机器上，容易误伤（也拖慢启动）
  selfDefending: false,
  debugProtection: false,
  disableConsoleOutput: false,
  // 保留 source map 关掉后的可读注释没必要，直接紧凑输出
  comments: false,
}

const walk = (dir, ext) => {
  const out = []
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) out.push(...walk(full, ext))
    else if (ext.includes(path.extname(entry.name).toLowerCase())) out.push(full)
  }
  return out
}

const obfuscateRenderer = async (rendererDir) => {
  const files = walk(rendererDir, ['.js', '.mjs'])
  let saved = 0
  for (const file of files) {
    const code = fs.readFileSync(file, 'utf8')
    const result = JavaScriptObfuscator.obfuscate(code, {
      ...OBFUSCATOR_OPTIONS,
      inputFileName: rel(file),
    })
    const obf = result.getObfuscatedCode()
    fs.writeFileSync(file, obf, 'utf8')
    saved += code.length - obf.length
    log(`混淆 ${rel(file)}（${size(code.length)} -> ${size(obf.length)}）`)
  }
  log(`混淆完成：${files.length} 个文件，净变化 ${size(Math.abs(saved))}${saved < 0 ? '（变大）' : '（变小）'}`)
}

// #endregion

// #region 3. 产物加密

const encryptFile = (file) => {
  const plain = fs.readFileSync(file)
  // 已经加密过就别再加密一层（重复执行的兜底）
  if (plain.subarray(0, MAGIC.length).equals(MAGIC)) return 0
  const iv = crypto.randomBytes(IV_LEN)
  const cipher = crypto.createCipheriv('aes-256-gcm', aesKey(), iv)
  const enc = Buffer.concat([cipher.update(plain), cipher.final()])
  fs.writeFileSync(file, Buffer.concat([MAGIC, iv, cipher.getAuthTag(), enc]))
  return plain.length
}

const encryptRenderer = (rendererDir) => {
  const files = walk(rendererDir, ['.html', '.js', '.css'])
  let total = 0
  for (const file of files) total += encryptFile(file)
  log(`加密 ${files.length} 个产物（共 ${size(total)}，AES-256-GCM）`)
}

// #endregion

/** 加载器的特征串：用来判断「这个文件已经被保护过了」 */
const LOADER_MARK = "require('bytenode')"

/** 文件是不是已经是密文（看魔数头） */
const isEncrypted = (file) => {
  try {
    const fd = fs.openSync(file, 'r')
    const head = Buffer.alloc(MAGIC.length)
    fs.readSync(fd, head, 0, MAGIC.length, 0)
    fs.closeSync(fd)
    return head.equals(MAGIC)
  } catch {
    return false
  }
}

/** 文件是不是已经是加载器（说明这个产物保护过了） */
const isLoader = (file) => {
  try {
    return fs.readFileSync(file, 'utf8').includes(LOADER_MARK)
  } catch {
    return false
  }
}

/**
 * 前置检查：`out/` 必须是**干净的明文**
 *
 * 这个脚本会把 `out/` 原地改写成「主进程/预加载=字节码加载器 + 渲染层=密文」，
 * 所以它**不能**在已经处理过的产物上再跑一遍（会把加载器当源码再编、把密文再加密一层），
 * 更不能在**混合态**上跑 —— 混合态是这么来的：`out/renderer` 还是上一轮的密文，
 * 而 main 被重新构建成明文（一次部分重建就会这样）。
 * 那种状态下启动应用，明文主进程没有解密协议，直接把密文当 HTML 加载 → **满屏乱码**（真发生过）。
 *
 * 所以这里一律先验证再动手：只要发现字节码 / 密文的痕迹，就直接报错让人先 `npm run build:only`。
 * 宁可报错也不要闷头做出一份坏产物，或者（更早的写法）静默「跳过」把混合态留在那儿。
 */
const assertOutIsPlain = () => {
  const mainJs = path.join(root, 'out/main/index.js')
  const mainJsc = path.join(root, 'out/main/index.jsc')
  const preloadJsc = path.join(root, 'out/preload/index.jsc')
  const html = path.join(root, 'out/renderer/index.html')
  const dirty = []
  if (fs.existsSync(mainJsc)) dirty.push('out/main/index.jsc（字节码）')
  if (fs.existsSync(preloadJsc)) dirty.push('out/preload/index.jsc（字节码）')
  if (fs.existsSync(mainJs) && isLoader(mainJs)) dirty.push('out/main/index.js（字节码加载器）')
  if (fs.existsSync(html) && isEncrypted(html)) dirty.push('out/renderer/index.html（密文）')
  if (dirty.length > 0) {
    throw new Error(
      'out/ 不是干净的明文产物，不能在这上面做保护：\n  - ' +
        dirty.join('\n  - ') +
        '\n先跑 npm run build:only 还原成明文，再重新 npm run pack。',
    )
  }
}

const main = async () => {
  const outDir = path.join(root, 'out')
  if (!fs.existsSync(path.join(outDir, 'main/index.js'))) {
    throw new Error('out/main/index.js 不存在，先跑 electron-vite build')
  }
  assertOutIsPlain()

  // 1) 字节码（只对主进程 / 预加载）
  await compileToBytecode(path.join(outDir, 'main/index.js'), 'main')
  await compileToBytecode(path.join(outDir, 'preload/index.js'), 'preload')

  // 2) + 3) 渲染层：先混淆再加密
  const rendererDir = path.join(outDir, 'renderer')
  await obfuscateRenderer(rendererDir)
  encryptRenderer(rendererDir)

  log('保护流水线完成：主进程/预加载=字节码，渲染层=混淆 + 加密（就地改写 out/）')
}

main().catch((err) => {
  console.error('[protect] 失败:', err)
  process.exit(1)
})
