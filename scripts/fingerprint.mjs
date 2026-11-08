/**
 * 生成发布用的构建指纹：`release/fingerprint.json`
 *
 * 内容就是 `app.asar` 的 sha256。应用那边拿它和自己体内的 `app.asar` 比 ——
 * 不一样就说明「发布页上的构建」和「我正在跑的这份」不是同一份，于是提示有新版。
 *
 * 为什么是 app.asar 而不是 exe：
 *  - 安装版用户跑的是安装目录里的 `BLWE.exe`，发布出来的是 NSIS 安装包，
 *    两者不是同一个文件，哈希永远对不上；
 *  - `app.asar` 在安装版和便携版里都是同一份，才有可比性。
 *
 * 用法：
 *   npm run fingerprint            # 自动找 release/win-unpacked
 *   node scripts/fingerprint.mjs <app.asar 路径>
 *
 * ⚠️ 发布时要把 `release/fingerprint.json` 作为**发布附件**上传，文件名不能改
 * （应用靠 `fingerprint.json` 这个名字在 release assets 里找它）。
 */
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'

/** 各平台打包产物里 app.asar 的默认位置 */
const CANDIDATES = [
  'release/win-unpacked/resources/app.asar',
  'release/linux-unpacked/resources/app.asar',
  'release/mac/BLWE.app/Contents/Resources/app.asar',
]

const input = process.argv[2]
const asarPath = input ? path.resolve(input) : CANDIDATES.find((p) => fs.existsSync(p))
if (!asarPath || !fs.existsSync(asarPath)) {
  console.error('[fingerprint] 找不到 app.asar，先跑 npm run pack 或 npm run dist')
  process.exit(1)
}

const bytes = fs.readFileSync(asarPath)
const sha256 = crypto.createHash('sha256').update(bytes).digest('hex')

/** 固定写到 `release/fingerprint.json`：和安装包放一起，方便一起上传 */
const outFile = path.resolve('release/fingerprint.json')
fs.mkdirSync(path.dirname(outFile), { recursive: true })
fs.writeFileSync(
  outFile,
  `${JSON.stringify({ sha256, size: bytes.length, builtAt: Date.now() }, null, 2)}\n`,
  'utf8',
)

console.log(`[fingerprint] ${asarPath}`)
console.log(`[fingerprint] sha256 = ${sha256}`)
console.log(`[fingerprint] 已写入 ${outFile}`)
console.log('[fingerprint] 发布时把它作为附件上传，文件名必须是 fingerprint.json')
