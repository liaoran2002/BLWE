/**
 * B 站接口相关 IPC
 *
 * 逻辑与迁移前的 electron/ipcHandlers.js 保持一致，仅补充类型。
 */
import { mainHandle } from '@common/mainIpc'
import { AUDIO_QUALITY_OPTIONS, findQualityOption, qualityLabelOf } from '@common/constants'
import * as biliApi from '../biliApi'
import { isUrlUsable, readQualityOptions } from '../biliApi'
import type { DashStreams } from '../biliApi'
import { getSetting } from '../utils/setting'
import { readVideoQuality } from '../utils/quality'
import type * as cacheManager from '../utils/cache'

/** 缓存总开关（cache.enable 之前也是死的，顺手接上） */
const cacheEnabled = (): boolean => getSetting()['cache.enable']

interface ApiContext {
  biliApi: typeof biliApi
  cacheManager: typeof cacheManager
}

/**
 * 缓存里的一条搜索结果条目
 *
 * `title` / `pic` / `author` 等字段直接来自 B 站搜索接口，
 * 解析播放地址时**必须原样保留**（见 resolveVideo 里的合并注释）。
 */
interface CachedSearchItem {
  bvid: string
  title?: string
  pic?: string
  author?: string
  duration?: number
  view_result?: BiliApiResponse
  playurl_result?: BiliApiResponse & {
    loginState?: boolean
    /** 这次解析有没有试过 dash（试过但没拿到，下次就别反复重取） */
    dashTried?: boolean
  }
  [key: string]: unknown
}

type BiliApiResponse = Awaited<ReturnType<typeof biliApi.resolveVideoUrl>>['viewData']

/** 搜索接口返回体里真正带 data 的那层（见 biliApi.searchSong） */
interface SearchPayload {
  data?: {
    result?: CachedSearchItem[]
    selectedBvid?: string
  }
}

/**
 * 「缓存地址已过期」的原因（写在注释里，日志保持一行）
 *
 * 直链寿命约 2 小时、缓存却有 3 天，隔一阵再听就会成片过期 ——
 * 属于预期内现象，所以不单独做日志闸门，直接在下面注释说明。
 */

/**
 * 取 durl（渐进式 mp4）地址
 *
 * dash 的双轨不在这里处理 —— 它需要两条流一起给，见 `extractDashStreams`。
 */
const extractDurl = (playData: BiliApiResponse | undefined): string | null => {
  const durl = (
    playData?.data as
      | { durl?: Array<{ url?: string; backup_url?: string[]; backupUrl?: string[] }> }
      | undefined
  )?.durl
  const first = durl?.[0]
  if (!first) return null
  // 和 biliApi 那边同一套规则：`url` 可能是 P2P 节点（普通请求 403），优先用常规 CDN 的备用地址
  return biliApi.pickNormalCdnUrl(first.url, first.backup_url ?? first.backupUrl)
}

/**
 * 用 `view_result` 里的信息补齐搜索条目缺失的 `title` / `pic`
 *
 * 旧版本解析播放地址时把条目整个替换成 `{ bvid, view_result, playurl_result }`，
 * 丢掉了标题和封面并写回了缓存。这类坏数据不会自己好：
 * 缓存命中时走的是「地址还能用」分支，根本不会碰条目。
 * 所以每次解析都顺手回填一次，让坏缓存随使用自愈。
 */
const backfillFromView = (item: CachedSearchItem): CachedSearchItem => {
  const info = item.view_result?.data
  const title =
    typeof item.title === 'string' && item.title
      ? item.title
      : typeof info?.title === 'string'
        ? info.title
        : undefined
  const pic =
    typeof item.pic === 'string' && item.pic
      ? item.pic
      : typeof info?.pic === 'string'
        ? info.pic
        : undefined
  return {
    ...item,
    ...(title ? { title } : {}),
    ...(pic ? { pic } : {}),
  }
}

export const registerApiHandlers = (context: ApiContext): void => {
  const { cacheManager } = context

  mainHandle('api:getUserInfo', () => biliApi.getUserInfo())

  mainHandle('api:searchSong', async ({ keyword, skipCache }) => {
    if (!keyword || !keyword.trim()) {
      throw new Error('关键词不能为空')
    }

    /**
     * `skipCache`（视频列表的刷新按钮）会真的重新搜一次。
     *
     * 重新搜到的结果**不带** view/playurl 数据，直接写回会把缓存里已解析好的
     * dash 地址全冲掉（下次每首都要重解析），所以这里与旧条目做一次合并：
     * 同一个 bvid 保留旧的 view_result / playurl_result。
     */
    const cached = cacheEnabled() ? await cacheManager.get<SearchPayload>(keyword) : null
    if (cached && cached.data && !skipCache) {
      // 缓存里存的是上一次的完整返回体，这里还原成调用方期望的 { data }
      const payload = cached.data as unknown as SearchPayload
      return { data: payload.data ?? cached.data }
    }

    const result = await biliApi.searchSong(keyword)

    if (result.code !== 0) {
      throw new Error(result.message ?? '搜索失败')
    }
    const results = result.data?.result
    if (Array.isArray(results)) {
      result.data!.result = results.filter(
        (item) => (item as { type?: string }).type === 'video',
      )
    }
    /**
     * **空结果不写缓存**（踩过）
     *
     * 缓存的意义是「省一次网络往返」。而「搜到 0 个」这个结果：
     *  - 省不下什么（下次还是得联网才知道有没有）；
     *  - 却会把一次**偶发失败**（断网、风控、接口抽风、登录态刚好过期）
     *    固化成「这首歌 3 天内永远找不到视频」—— 而且因为读的是缓存，
     *    连网络都不会碰一下，用户只能手动点「刷新」才有救。
     *
     * 所以这里直接跳过写入：空结果永远不落盘，下次自然就是真实搜索。
     * 注意判断的是**过滤后的视频条数**，不是 `code` —— B 站有时会正常返回
     * 但 `result` 里全是非视频条目（番剧 / 专栏），对播放器来说等于空。
     */
    const videoCount = Array.isArray(result.data?.result) ? result.data.result.length : 0
    if (videoCount === 0) {
      console.warn(`[search] 《${keyword}》搜索结果为空，不写入缓存（避免把偶发失败固化）`)
    } else if (cacheEnabled()) {
      const oldItems = (cached?.data as unknown as SearchPayload | undefined)?.data?.result
      const oldByBvid = new Map<string, CachedSearchItem>()
      if (Array.isArray(oldItems)) {
        for (const item of oldItems) {
          if (item?.bvid) oldByBvid.set(item.bvid, item)
        }
      }
      if (oldByBvid.size > 0 && Array.isArray(result.data?.result)) {
        result.data.result = (result.data.result as CachedSearchItem[]).map((item) => {
          const old = item?.bvid ? oldByBvid.get(item.bvid) : undefined
          if (!old) return item
          // 旧数据打底、新搜索结果覆盖标题/封面等展示字段，但保留解析结果
          return {
            ...old,
            ...item,
            view_result: old.view_result,
            playurl_result: old.playurl_result,
          }
        })
      }
      await cacheManager.save(keyword, result)
    }
    return { data: result.data ?? [] }
  })

  /** 「添加视频」：把用户粘贴的链接 / BV 号解析成可预览的信息 */
  mainHandle('api:parseVideo', async ({ input }) => biliApi.parseVideoInput(input))

  mainHandle('api:resolveVideo', async ({ bvid, keyword, skipCache, noDash, qn, audioId }) => {
    try {
      /**
       * 每次解析前都确认一次登录态（必要时重拉 nav）。
       *
       * 不能直接读缓存的登录标志：登录窗口刚登录完时那份 nav 数据还是「未登录」，
       * 用它判断会把「该重新解析成更高清晰度」误判成「缓存可用」，
       * 于是登录后播放清晰度不变、必须重启才生效。
       *
       * 注意它可能是 `null`（这次没问到）：那就**不能**据它下结论，
       * 见下面 loginChanged 与写缓存那两处。
       */
      const loggedIn = await biliApi.ensureLoginState()
      // 本次要用的清晰度 / 音质：调用方（播放器上手动切换）优先，否则用设置里的默认值
      const wantQn = qn ?? getSetting()['player.videoQuality']
      const wantAudioId = audioId ?? getSetting()['player.audioQuality']

      /** 本次是不是真的重新解析过（决定要不要写缓存，见下面的保存处） */
      let resolvedFresh = false
      /** durl（渐进式 mp4）地址；走 dash 时为 null */
      let videoUrl: string | null = null
      /** dash 双轨（音视频分开）；走 durl 时为 null */
      let dash: DashStreams | null = null
      let viewData: BiliApiResponse | undefined
      let playData: BiliApiResponse | undefined
      let cached: Awaited<ReturnType<typeof cacheManager.get<SearchPayload>>> = null
      let results: CachedSearchItem[] = []

      // 读取缓存（有 keyword 才走缓存逻辑）
      if (keyword && cacheEnabled()) {
        cached = await cacheManager.get<SearchPayload>(keyword)
        const payload = cached?.data as unknown as SearchPayload | undefined
        results = Array.isArray(payload?.data?.result) ? payload.data.result : []
      }

      // 在缓存列表中查找当前 bvid 对应的视频项
      const targetIndex = results.findIndex((item) => item.bvid === bvid)
      let targetVideo: CachedSearchItem | undefined = results[targetIndex]

      // 分支：使用缓存 / 重新解析
      if (targetVideo && !skipCache) {
        const prevDashTried = targetVideo.playurl_result?.dashTried === true
        const cachedDurl = extractDurl(targetVideo.playurl_result)
        const cachedDash = biliApi.extractDashStreams(
          targetVideo.playurl_result,
          wantQn,
          wantAudioId,
        )
        const hasValidData = Boolean(targetVideo.view_result && targetVideo.playurl_result)
        /**
         * 缓存是不是「未登录时取的」。
         *
         * `loginState` 是解析当时由主进程写进缓存的登录态快照。
         * 未登录能拿到的清晰度被平台压得很低（实测只有 360P/720P），
         * 所以「缓存是未登录时取的 + 现在已登录」必须重取，
         * 否则登录完还得重启才看得到高清。
         */
        /**
         * 缓存条目里记的登录态快照。
         *
         * **只有明确是 `false`（当时确实未登录）才值得重取**：
         * 没有这个字段（老条目 / 当时登录态未知）不该被当成「未登录时取的」，
         * 否则每次解析都要白重取一遍 —— 这就是「没退出登录却老在重新解析」的来源之一。
         */
        const cachedLoginState = targetVideo.playurl_result?.loginState
        const loginChanged = loggedIn === true && cachedLoginState === false
        /**
         * 关键：以前只判断「缓存里有没有数据」，从不检查播放地址是否过期。
         * B 站直链带签名时效（deadline），实测缓存里 38 条地址有 21 条已过期，
         * 于是播放器拿到死链 -> 触发 error -> 用户看到「视频加载失败，已跳过」。
         * 这里加上时效校验，过期就重新解析。dash 的两条流都要检查。
         */
        const urlUsable =
          isUrlUsable(cachedDurl ?? cachedDash?.videoUrl ?? null) &&
          (!cachedDash || isUrlUsable(cachedDash.audioUrl))
        // 想要 dash、缓存里却没有，且之前没试过 dash -> 重取一次做升级。
        // 必须要求「缓存里确实有播放数据」：否则这条只是该视频的首次解析，
        // 打日志会变成「每切一首歌就重新解析」的假象（而且文案也不对）。
        const needDashUpgrade = hasValidData && !noDash && !cachedDash && !prevDashTried
        // 明确要求 durl（dash 播放失败后的兜底）但缓存只有 dash -> 也要重取
        const needDurl = Boolean(noDash) && !cachedDurl

        if (hasValidData && !loginChanged && urlUsable && !needDashUpgrade && !needDurl) {
          videoUrl = cachedDurl
          dash = cachedDash
        } else {
          if (loginChanged) {
            console.log('[video] 缓存的地址是未登录时取的，现已登录，重新解析:', bvid)
          }
          if (!urlUsable && (cachedDurl || cachedDash)) {
            /**
             * 这条是**预期内**的，不是故障：实测 B 站直链签名寿命中位正好 120 分钟，而搜索缓存默认留 3 天。
             * 所以「隔一阵再听」必然碰到，重新解析即可 —— 不解析反而会拿死链去播。
             */
            console.log(`[video] 缓存地址已过期，重新解析:`, bvid)
          }
          if (needDashUpgrade) {
            console.log(
              `[video] 缓存里没有 dash 流（${cachedDurl ? '只有 durl' : '只有旧数据'}），重新解析尝试 dash 高清:`,
              bvid,
            )
          }
          // 缓存数据失效 / 地址过期，重新拉取
          resolvedFresh = true
          const resolved = await biliApi.resolveVideoUrl(bvid, {
            noDash,
            qn: wantQn,
            audioId: wantAudioId,
          })
          videoUrl = resolved.videoUrl
          dash = resolved.dash
          viewData = resolved.viewData
          playData = resolved.playData
          targetVideo.view_result = viewData
          targetVideo.playurl_result = {
            ...playData,
            /**
             * 记下解析当时的登录态快照。
             *
             * `loggedIn` 为 `null`（这次没问到）时**保留上一次的快照**：
             * 以前无条件写 `!!loggedIn`，一次网络抖动就把条目标成「未登录时取的」，
             * 于是以后每次解析都判定「未登录时取的，现已登录」→ 白重取一遍。
             */
            ...(loggedIn === null
              ? cachedLoginState === undefined
                ? {}
                : { loginState: cachedLoginState }
              : { loginState: loggedIn }),
            // 记下「这次试过 dash」：试过但没拿到，下次就别反复重取
            dashTried: !noDash || prevDashTried,
          }
        }
      } else {
        // 无缓存项 / 强制跳过缓存：直接调用接口解析
        resolvedFresh = true
        const resolved = await biliApi.resolveVideoUrl(bvid, {
            noDash,
            qn: wantQn,
            audioId: wantAudioId,
          })
        videoUrl = resolved.videoUrl
        dash = resolved.dash
        viewData = resolved.viewData
        playData = resolved.playData
        /**
         * 关键修复：这里必须**合并**而不是**替换**。
         *
         * 原来写的是 `targetVideo = { bvid, view_result, playurl_result }`，
         * 于是搜索结果条目里的 `title` / `pic` / `author` / `duration` 全被丢掉；
         * 而这个数组稍后会被写回搜索缓存（见下面的 selectedBvid 写回），
         * 下次 searchSong 拿到的这一项就没有标题和封面了 ——
         * 表现是播放器里视频标题空白、视频封面也回退不出来，
         * 并且会把 `title: ''` / `cover: null` 一起写进歌单的 videoCache。
         */
        targetVideo = {
          ...targetVideo,
          bvid,
          view_result: viewData,
          // 登录态未知（null）时干脆不写这个字段：写了 false 就等于「未登录时取的」
          playurl_result: {
            ...playData,
            ...(loggedIn === null ? {} : { loginState: loggedIn }),
            dashTried: !noDash,
          },
        }
        if (targetIndex >= 0) results[targetIndex] = targetVideo
        else results.push(targetVideo)
      }

      // 补齐旧版本写坏的条目（缓存命中分支不会碰 title/pic，必须在这里回填）
      if (targetVideo) {
        targetVideo = backfillFromView(targetVideo)
        if (targetIndex >= 0) results[targetIndex] = targetVideo
      }

      // 有 keyword 时统一更新缓存（selectedBvid + 数据）
      /**
       * 只有**真的重新解析过**才写回
       *
       * 踩过：原来只要读到过这个 keyword 的缓存就无条件整包 `save` ——
       * 纯缓存命中、续播、预热下一首都会触发一次「同步 stringify + 写盘 + rename」
       * （这个 JSON 最大能到几 MB），既阻塞主进程又白白磨损磁盘，而且什么都没改。
       * （`backfillFromView` 那种老条目修补属于极少数情况，交给下次重解析一并落盘。）
       */
      if (keyword && cached && resolvedFresh) {
        /**
         * 这里存的必须是**整包返回体**（`{ code, data: { result, selectedBvid } }`），
         * 不是里面的 `data` —— `api:searchSong` 与渲染层都按外层结构读。
         */
        const cachedPayload = cached.data as unknown as SearchPayload | undefined
        if (cachedPayload?.data) {
          /**
           * 写回前**重新读一次**缓存再合并。
           *
           * 上面这段解析要跑 view + playurl 两次网络往返（秒级），期间
           * `api:searchSong`（同一 keyword）或者用户快速切歌可能已经写了新结果；
           * 直接把手里这份老快照整体 save 回去会把新结果覆盖掉（反向顺序则丢掉刚解析出的地址）。
           * 两个 handler 都是 async，await 处一定会交错，所以必须合并而不是覆盖。
           */
          const fresh = cacheEnabled() ? await cacheManager.get<SearchPayload>(keyword) : null
          const freshPayload = fresh?.data as unknown as SearchPayload | undefined
          const freshResults = Array.isArray(freshPayload?.data?.result)
            ? [...(freshPayload.data.result as CachedSearchItem[])]
            : [...results]
          /**
           * 只把**本次真正动过的那一个条目**覆盖进去
           *
           * 踩过：这里原来遍历整份本地快照 `results`，逐条 `{...fresh, ...item}` ——
           * 等于把「开始解析之前看到的其它条目」也一起写回去。快速连点两个候选视频
           * （同 keyword、不同 bvid）或预热与切歌重叠时，后写的一方会用它快照里别的 bvid 的
           * 旧 view/playurl 回滚对方刚解析出的新地址，表现就是「地址刚解析完又没了、反复重新解析」。
           */
          const changed = targetVideo?.bvid ? [targetVideo] : []
          for (const item of changed) {
            if (!item?.bvid) continue
            const at = freshResults.findIndex((x) => x?.bvid === item.bvid)
            if (at >= 0) freshResults[at] = { ...freshResults[at], ...item }
            else freshResults.push(item)
          }
          cachedPayload.data.result = freshResults
          cachedPayload.data.selectedBvid = bvid
          // 其它字段（分页 / 总数之类）如果新快照有，就一起带上
          if (freshPayload?.data && freshPayload.data !== cachedPayload.data) {
            Object.assign(cachedPayload.data, {
              ...freshPayload.data,
              result: freshResults,
              selectedBvid: bvid,
            })
          }
          if (cacheEnabled()) await cacheManager.save(keyword, cachedPayload)
        }
      }

      /**
       * 顺手把「正在解析的这个视频」的标题 / 封面 / 清晰度回传。
       *
       * 渲染层靠它显示视频标题/封面，就不用依赖 `videoList` 里能否找到这个 bvid：
       * `selectedBvid` 是历史选择，完全可能不在本次搜索结果里，
       * 那时列表查不到，标题和封面就只能空着。
       *
       * 清晰度同理：只认 playurl 响应自己报的 `quality`
       * （请求里固定写的 qn=64 会被平台降级，不代表实际档位）。
       */
      const viewInfo = targetVideo?.view_result?.data
      const title =
        (typeof targetVideo?.title === 'string' && targetVideo.title) ||
        (typeof viewInfo?.title === 'string' ? viewInfo.title : null)
      const pic =
        typeof viewInfo?.pic === 'string' ? viewInfo.pic : (targetVideo?.pic ?? null)
      const quality = readVideoQuality(
        targetVideo?.playurl_result,
        // dash 时传视频轨地址，让清晰度取到「实际在播的那条流」
        videoUrl ?? dash?.videoUrl ?? null,
      )
      // 音质：dash 音频流的 id -> 展示名
      const playingAudioId = dash?.audioId ?? null
      const audioLabel =
        playingAudioId === null ? null : qualityLabelOf(AUDIO_QUALITY_OPTIONS, playingAudioId)
      const audioDesc =
        playingAudioId === null
          ? null
          : (findQualityOption(AUDIO_QUALITY_OPTIONS, playingAudioId)?.description ?? audioLabel)

      /**
       * 这个视频当前可选的清晰度 / 音质（给播放器上的切换菜单用）
       *
       * 注意它来自**缓存的 playurl 响应**：dash 响应里一次就带回所有可访问档位，
       * 所以手动切换清晰度不需要重新请求接口，直接换一条流即可。
       */
      const options = readQualityOptions(targetVideo?.playurl_result)


      return {
        videoUrl,
        dash,
        title,
        pic,
        quality: quality?.label ?? null,
        qualityDesc: quality?.description ?? null,
        audioQuality: audioLabel,
        audioQualityDesc: audioDesc,
        options,
      }
    } catch (err) {
      console.error('解析视频地址异常：', err)
      /**
       * `AUTH_FAILED` 是 `requestPlayUrl` 特意抛出来的（cookie 过期 / 没权限），
       * 原来和其它异常一样被拍成「视频地址解析失败」，渲染层永远不知道该重新登录。
       * 这里保留错误码，让界面能提示「登录已失效」。
       */
      if (err instanceof Error && err.message === 'AUTH_FAILED') {
        return { videoUrl: null, error: 'AUTH_FAILED' }
      }
      return { videoUrl: null, error: '视频地址解析失败' }
    }
  })
}
