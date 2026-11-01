/**
 * wy 加密
 *
 * 移植自 lx-music-desktop 的 src/renderer/utils/musicSdk/wy/utils/crypto.js
 *
 * LX 用 Node 的 `crypto` 模块实现（这也是它只能在 electron-renderer 下跑的原因之一），
 * 本项目在主进程里直接用，无需任何第三方加密库。
 *
 * 提供两条通道：
 *  - weapi：AES-128-CBC 两次 + RSA，配合 `/weapi/*` 接口（返回完整歌曲数据）
 *  - linuxapi：AES-128-ECB，配合 `/api/linux/forward`（轻量，但 tracks 常被裁剪到 10 首）
 */
import {
  createCipheriv,
  publicEncrypt,
  randomBytes,
  constants,
} from 'node:crypto'

const iv = Buffer.from('0102030405060708')
const presetKey = Buffer.from('0CoJUm6Qyw8W8jud')
const linuxapiKey = Buffer.from('rFgB&h#%2?^eDg:Q')
const base62 = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789'
const publicKey =
  '-----BEGIN PUBLIC KEY-----\n' +
  'MIGfMA0GCSqGSIb3DQEBAQUAA4GNADCBiQKBgQDgtQn2JZ34ZC28NWYpAUd98iZ37BUrX/aKzmFbt7clFSs6sXqHauqKWqdtLkF2KexO40H1YTX8z2lSgBBOAxLsvaklV8k4cBFK9snQXE9/DDaFt6Rr7iVZMldczhC0JNgTz+SHXT6CBHuX3e9SdB1Ua44oncaTWz7OBGLbCiK45wIDAQAB\n' +
  '-----END PUBLIC KEY-----'

const aesEncrypt = (buffer: Buffer, mode: string, key: Buffer, ivValue: string | null): Buffer => {
  // ECB 模式不使用 iv；Node 的类型签名要求传值，这里与 LX 保持一致传空
  const cipher = createCipheriv(mode, key, (ivValue ?? '') as unknown as Buffer)
  return Buffer.concat([cipher.update(buffer), cipher.final()])
}

const rsaEncrypt = (buffer: Buffer, key: string): Buffer => {
  // RSA_NO_PADDING 要求输入长度正好等于模长（128 字节），左侧补零
  const padded = Buffer.concat([Buffer.alloc(128 - buffer.length), buffer])
  return publicEncrypt({ key, padding: constants.RSA_NO_PADDING }, padded)
}

/** weapi 表单加密（配合 /weapi/* 接口） */
export const weapi = (object: unknown): { params: string; encSecKey: string } => {
  const text = JSON.stringify(object)
  // randomBytes 返回 Uint8Array，这里显式转成 Buffer 以便参与 Buffer 拼接
  const secretKey = Buffer.from(randomBytes(16).map((n) => base62.charAt(n % 62).charCodeAt(0)))
  return {
    params: aesEncrypt(
      Buffer.from(
        aesEncrypt(Buffer.from(text), 'aes-128-cbc', presetKey, iv.toString()).toString('base64'),
      ),
      'aes-128-cbc',
      secretKey,
      iv.toString(),
    ).toString('base64'),
    encSecKey: rsaEncrypt(secretKey.reverse(), publicKey).toString('hex'),
  }
}

/** linuxapi 表单加密（配合 /api/linux/forward） */
export const linuxapi = (object: unknown): { eparams: string } => {
  const text = JSON.stringify(object)
  return {
    eparams: aesEncrypt(Buffer.from(text), 'aes-128-ecb', linuxapiKey, null)
      .toString('hex')
      .toUpperCase(),
  }
}
