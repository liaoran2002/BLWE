/**
 * B 站接口相关 IPC
 *
 * 逻辑与迁移前的 electron/ipcHandlers.js 保持一致，仅补充类型。
 *
 * 本次数据层改造后这里有两处**行为**变化（都是需求，不是顺手改的）：
 *  1. `api:searchSong` 用「主进程合并」产出的顺序取代了渲染层的 `applyFavoriteOrder`：
 *     收藏项在前、保持相对顺序，新结果接在后面 —— 渲染层拿到的顺序就是最终顺序。
 *  2. `api:resolveVideo` 原来靠「整包读缓存 → 改一条 → 整包写回」来落盘解析结果，
 *     现在改成按主键更新一行（见 cache.ts 的 `updateVideoResult`），
 *     那段「写回前重读一次再合并、且只挑本次动过的那一条覆盖」的防御逻辑随之删除。
 */
import { mainHandle } from '@common/mainIpc'
import { AUDIO_QUALITY_OPTIONS, findQualityOption, qualityLabelOf } from '@common/constants'
import { rankVideos } from '@common/utils/videoRank'
import { joinSearchKey } from '@common/types/playlist'
import { durationToSeconds } from '@common/utils/duration'
import * as biliApi from '../biliApi'
import { isUrlUsable, readQualityOptions } from '../biliApi'
import type { DashStreams } from '../biliApi'
import { getSetting } from '../utils/setting'
import { findSongDuration } from '../utils/playlist'
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
 *
 * **这里不再有 `view_result` / `playurl_result`**：schema v2 把解析结果拆成了
 * `videos` 表上的结构化列，`cache.listVideos()` 交出来的 `VideoRow.playurl`
 * 是拼好的最小响应形状，够喂给 `extractDashStreams` / `readQualityOptions`。
 */
interface CachedSearchItem {
  bvid: string
  title?: string
  pic?: string
  author?: string
  duration?: number | string | null
  /** 是否已收藏；由主进程写入并回传，渲染层据此显示实心爱心 */
  favorites?: boolean
  [key: string]: unknown
}

type BiliApiResponse = Awaited<ReturnType<typeof biliApi.resolveVideoUrl>>['viewData']

/** 搜索接口返回体里真正带 data 的那层（见 biliApi.searchSong） */
interface SearchPayload {
  data?: {
    result?: CachedSearchItem[]
    selectedBvid?: string
    [key: string]: unknown
  }
  [key: string]: unknown
}

/**
 * 「缓存地址已过期」的原因（写在注释里，日志保持一行）
 *
 * 直链寿命约 2 小时、元数据永不过期，隔一阵再听就会成片过期 ——
 * 属于预期内现象，所以不单独做日志闸门，直接在下面注释说明。
 */

/*
 * 注意：这里**没有** `extractDurl`。
 *
 * 它现在只在 `cache.ts` 里有一份（写库时提取 `durl_url` 用）。读缓存那条路
 * 改成结构化列之后，handler 不再需要自己从响应里抠地址 —— 而「优先常规 CDN
 * 的备用地址」这条规则一旦两处各写一份，改一处漏一处就会出现「有的视频放不出来」。
 */

/**
 * 合并「收藏项 + 本次新搜索结果」
 *
 * 顺序规则（用户明确要求，顺序不能错）：
 *  1. 已收藏的条目保留在数组**最前面**，且保持它们**原有的相对顺序**；
 *  2. 新搜索结果里同 bvid 的：用它**覆盖**元数据（标题/封面/UP主/时长），
 *     但保留 `favorites` 标记；
 *  3. 其余新结果接在收藏项后面；
 *  4. 最后再回源刷新「新结果里没有的收藏项」的标题/封面。
 *
 * 为什么必须在主进程合并：渲染层只看得到「最终列表」，
 * 如果让渲染层自己把收藏插到前面，那「哪些是新搜到的、哪些是收藏快照」
 * 就只有它知道，重新搜索时又得再拼一次 —— 两处各拼一次必然对不上。
 *
 * 调用点只有一处（空结果那条路先返回了，不会走到这里），所以不做
 * 「要不要回源刷新」的参数 —— 一个永真的开关只会让人以为它可配。
 */
const mergeWithFavorites = async (
  freshItems: CachedSearchItem[],
  oldRows: ReturnType<typeof cacheManager.listVideos>,
): Promise<CachedSearchItem[]> => {
  const favoriteRows = oldRows.filter((row) => row.favorites)
  const freshByBvid = new Map<string, CachedSearchItem>()
  for (const item of freshItems) {
    if (item?.bvid) freshByBvid.set(item.bvid, item)
  }

  const merged: CachedSearchItem[] = []
  const seen = new Set<string>()

  // 规格里的第 1、2 条：收藏项在前（保持相对顺序），元数据以新搜索结果为准
  for (const row of favoriteRows) {
    if (seen.has(row.bvid)) continue
    seen.add(row.bvid)
    const hit = freshByBvid.get(row.bvid)
    merged.push(
      hit
        ? { ...hit, bvid: row.bvid, favorites: true }
        : {
            bvid: row.bvid,
            title: row.title,
            pic: row.pic ?? undefined,
            author: row.author ?? undefined,
            duration: row.duration ?? undefined,
            favorites: true,
          },
    )
  }

  /**
   * 规格里的第 3 条（顺序上的最后一步）：其余新结果接在收藏项后面
   *
   * 注意这一步在**回源刷新之前**完成（见下面第 4 条）：先把列表顺序定死，
   * 再去做那个会用几秒的网络请求。
   */
  for (const item of freshItems) {
    if (!item?.bvid || seen.has(item.bvid)) continue
    seen.add(item.bvid)
    merged.push({ ...item, favorites: false })
  }

  /**
   * 规格里的第 4 条：新结果里没有的收藏项，回源补标题 / 封面
   *
   * **必须是最后一步**（用户特别强调了顺序）：它是逐个 await 的网络请求，
   * 要是插在拼装过程中间，整个列表的顺序就得等网络跑完才定得下来；
   * 放在最后，它只在这条 item 上原地改 title / pic，动不了任何顺序。
   */
  for (const item of merged) {
    if (!item.favorites || freshByBvid.has(item.bvid)) continue
    try {
      const info = await biliApi.parseVideoInput(item.bvid)
      if (info.title) item.title = info.title
      if (info.pic) item.pic = info.pic
      if (info.author) item.author = info.author
      if (typeof info.duration === 'number') item.duration = info.duration
    } catch (err) {
      /**
       * 刷新失败**不能**影响这次搜索：收藏项的标题/封面在库里本来就有一份，
       * 刷不出来就继续用旧的（列表里也不会变成空壳）。
       */
      console.warn(`[search] 刷新收藏视频信息失败（沿用已存的值）: ${item.bvid}`, err)
    }
  }

  return merged
}

export const registerApiHandlers = (context: ApiContext): void => {
  const { cacheManager } = context

  mainHandle('api:getUserInfo', () => biliApi.getUserInfo())

  mainHandle('api:searchSong', async ({ song, singer, skipCache }) => {
    const songName = String(song ?? '').trim()
    const singerName = String(singer ?? '').trim()
    if (!songName) {
      throw new Error('歌名不能为空')
    }

    /**
     * 歌名与歌手**分开收**（渲染层也是分开传的）
     *
     * 为什么要分开，而不是收一个 `"歌名-歌手"` 再拆：
     *  - 歌名、歌手本来就是两个独立字段（歌单、界面都分开存）；
     *  - 拼成串再拆是**有歧义**的 —— 歌名本身可能含 `-`
     *    （`下坠Falling` / `R.` / `若是明仔载`），按 `-` 切会切错；
     *  - 只有**拼搜索词**那一刻才需要两者同时在场，而那不需要拼串。
     *
     * `searchKey` 是**缓存键**（`videos.search_key` / `song_meta.search_key`），
     * 格式仍是 `"歌名-歌手"`（与历史数据一致），只在这里拼一次。
     */
    const searchKey = joinSearchKey(songName, singerName)

    /**
     * 缓存命中直接返回（`skipCache` 是视频列表的刷新按钮，会真的重搜）。
     *
     * ## 为什么读缓存时还要过一次 `rankVideos`
     *
     * 缓存里存的**本来就是过滤好的列表**（写进去的是 `finalList`），
     * 所以正常路径下这次过滤什么都不会改 —— 它不是"补做过滤"。
     *
     * 它只解决**一个**场景：**用户改了过滤设置**。
     *
     * ```
     * 缓存是 3 天前写的（按当时的规则过滤过）
     * 用户今天新加了过滤词「吉他谱」
     * → 缓存不会因为设置变了就失效，读出来还是 3 天前那批（含吉他谱）
     * → 这里用**当前**规则再过一遍，设置立刻生效
     * ```
     *
     * 代价是几十条的内存过滤，可以忽略。
     *
     * ## ⚠️ 但**不把结果回写缓存**（这里改过一次）
     *
     * 我原来写过「过滤后条数变了就把缓存也修好」，传的是过滤后的 `refiltered`。
     * 那是错的，原因只有一个但足够：
     *
     * **`save` 是 DELETE + INSERT**（`cache.ts` 里 `DELETE FROM videos WHERE
     * search_key = ?` 然后整批重插）。把过滤后的列表写回去，等于**把被过滤掉的
     * 那些行从库里永久删掉** —— 而它们只是"按**当前**规则不该显示"，
     * 并不是脏数据。
     *
     * 后果：用户把容差从 30 调回 90（或删掉一个过滤词）想找回那些结果时，
     * 它们**已经不在库里了**，必须重新联网搜索才回得来。
     *
     * 所以：读路径**只读不写**。规则错了最多是这次显示不对，缓存本身还是完整的。
     */
    const cached = cacheEnabled() ? await cacheManager.get<SearchPayload>(searchKey) : null
    if (cached && cached.data && !skipCache) {
      const payload = cached.data as unknown as SearchPayload
      const cachedList = (payload.data?.result ?? []) as CachedSearchItem[]
      const refiltered = rankVideos(cachedList, {
        song: songName,
        singer: singerName,
        songDurationSec: findSongDuration(searchKey),
        tagBonus: getSetting()['player.tagBonus'],
        filterKeywords: getSetting()['player.filterKeywords'],
        durationToleranceSec: getSetting()['player.durationToleranceSec'],
        /**
         * ⚠️ 缓存路径**一律放宽**时长上限
         *
         * 缓存里存的是**已经取回来并过滤过的**结果，而它当初是用哪一档容差、
         * 有没有走降级轮（降级轮会放宽 ×1.7）取的 —— 这里无从得知
         * （那份信息没落库）。
         *
         * 两种选择里必须挑一个：
         *  - 用**严格**上限重过滤 → 可能把当初按放宽规则合法取回的结果**藏起来**，
         *    用户看到「我什么都没改，列表怎么少了」；
         *  - 用**放宽**上限重过滤 → 最多是多留几条，用户不会觉得东西丢了。
         *
         * 取后者：**宁可多留，不可误藏**。注意这只影响时长这一条 ——
         * 歌名 / 屏蔽词那两条**照常严格**（它们是「是不是同一首歌」的判据，
         * 不存在「当初放宽过」这回事）。
         */
        relaxUpperBound: true,
      })
      if (refiltered.length !== cachedList.length) {
        console.log(
          `[search] ${searchKey} 缓存命中，按当前规则剔除${cachedList.length - refiltered.length}条`,
        )
      }
      /**
       * 过滤后为空 → **这份缓存对当前规则已经没用了**，当作没命中往下真实搜索。
       *
       * 不能返回空数组 + `filtered` 标记：那个标记的语义是
       * 「刚搜过、结果被规则挡掉了」，而这里根本没搜 —— 用户看到
       * 「结果都被过滤掉了」的提示，但其实一次网络请求都没发，
       * 点了刷新可能就有结果了。真实搜索一次才是对的。
       */
      if (refiltered.length > 0) {
        return { data: { ...(payload.data ?? {}), result: refiltered } }
      }
      console.warn(`[search] ${searchKey} 缓存全不符合当前规则，忽略缓存重新搜索`)
    }

    /**
     * 第一级搜索词：`《歌名》歌曲 歌手`
     *
     * ⚠️ **不用 `-`**：B站搜索把 `-` 当**排除语法**（"A -B" = 搜 A 排除 B），
     * 写成 `《歌名》歌曲 - 歌手` 会变成「搜歌、**排除**这个歌手」，正好反了。
     */
    const primaryKeyword = biliApi.buildPrimaryKeyword(song, singer)

    const result = await biliApi.searchSong(primaryKeyword)

    if (result.code !== 0) {
      throw new Error(result.message ?? '搜索失败')
    }

    /**
     * ★ 搜索 + 补齐 + **降级重搜**
     *
     * **用户定的规则**：
     *  - 时长差超过容差（默认 ±90 秒）的丢掉（那多半不是同一首歌 —— 合集、live 全场、串烧）；
     *  - 过滤后**少于 `player.minSearchResults` 条**（默认 30）就再查一页；
     *  - 还不够就换降级词重搜（`歌名 MV` → `歌名 可视化`）。
     *
     * 为什么这件事放在主进程而不是渲染层：
     *  - 翻页/降级都要再发搜索请求（渲染层不该直接打 B站接口）；
     *  - 结果要**写进缓存**，而缓存是主进程的事。
     *
     * ⚠️ 这里**只做网络部分**（搜、补齐、降级）。过滤与排序的**判据**统一在
     * 下面的 `rankVideos` 里执行 —— 两处各写一份必然漂移。
     */
    /**
     * 这份结果是否**按放宽后的时长上限**取的（降级轮会放宽）
     *
     * 初值 `false` = 走的是第一轮（严格上限）。降级成功采用时才置 `true`，
     * 然后传给下面的 `rankVideos` —— 两处必须用同一套上限，
     * 否则「按放宽的规则数出 40 条、按严格规则只剩 5 条」，白降级一场。
     */
    let relaxedBound = false
    /**
     * 取数阶段的统计，等 `rankVideos` 算完过滤后再**合成一行**打出去
     *
     * 为什么攒着不打：原来「取回 N」和「过滤后 M」是**两行**日志，
     * 而它们说的其实是同一次搜索的两端 —— 分两行看反而要自己对照。
     * 合成 `取回 80 → 过滤 40` 一眼就明白「那 40 条是被规则挡掉的」。
     */
    let searchStats: { raw: number; pages: number; rounds: number; relaxed: boolean } | null = null
    try {
      const songSec = findSongDuration(searchKey)
      const settings = getSetting()
      const picked = await biliApi.searchSongFiltered(
        /** 歌名与歌手**分开传**（不拼 `歌名-歌手`）—— 见 `api:searchSong` 开头那段 */
        songName,
        singerName,
        songSec,
        settings['player.minSearchResults'],
        settings['player.durationToleranceSec'],
        /**
         * ★ 过滤词与关键词表**必须传进去**
         *
         * `searchSongFiltered` 要用它们算出「过滤之后还剩几条」，
         * 才能正确判断要不要降级。不传的话它只能按一个虚高的数字判断，
         * 降级机制等于失效（踩过：搜到 80 条判「够了」，实际过滤完只有 25 条）。
         */
        settings['player.filterKeywords'],
        settings['player.tagBonus'],
        /**
         * ★ 把上面已经取到的第 1 页响应传进去
         *
         * 不传的话 `searchSongFiltered` 会**再搜一次第 1 页** ——
         * 每次缓存未命中都白打一次完整的 WBI 签名 + 网络往返。
         * 上面那次 `biliApi.searchSong(primaryKeyword)` 的用途是「失败要能抛错」，
         * 而它拿到的 `result` 恰好就是第 1 页，直接复用即可。
         */
        result,
      )
      /** ★ 这份结果是不是按放宽后的时长上限取的（下面排序要跟着放宽） */
      relaxedBound = picked.relaxed
      if (picked.items.length > 0) {
        result.data = { ...(result.data ?? {}), result: picked.items }
      }
      /** 记下这几个数，最后和「过滤后」合成**一行**打出去（见下面） */
      searchStats = {
        raw: picked.items.length,
        pages: picked.pages,
        rounds: picked.rounds,
        relaxed: relaxedBound,
      }
    } catch (err) {
      /** 补齐/降级失败**不能**让搜索整体失败 —— 用原结果继续 */
      console.warn('[search] 补齐/降级搜索失败（用原始结果继续）:', err)
    }

    /**
     * 记下**这份搜索结果是在什么登录态下取的**（`song_meta.search_login_state`）。
     *
     * 为什么和 `videos.playurl_login_state` 分开：两者是**不同时刻、不同请求**的快照 ——
     * 搜索可能几小时前就做了，而播放地址是刚刚解析的。合成一个字段必然互相覆盖。
     *
     * 用途：未登录时 B 站只返回部分结果（这正是界面提示「登录后再试」的依据），
     * 有了这个快照就能判断「这份结果该不该在登录后重搜」。
     *
     * `ensureLoginState()` 可能返回 `null`（这次没问到）—— 那时**不覆盖**已有值，
     * 因为「未知」不等于「未登录」：把未知写成 0，下次登录后就会白重搜一遍。
     */
    if (cacheEnabled()) {
      try {
        cacheManager.setSearchLoginState(searchKey, await biliApi.ensureLoginState())
      } catch (err) {
        // 登录态记不上不影响搜索结果本身，别让它把整次搜索搞失败
        console.warn('[search] 记录搜索登录态失败（忽略）:', err)
      }
    }

    const results = result.data?.result
    if (Array.isArray(results)) {
      result.data!.result = results.filter(
        (item) => (item as { type?: string }).type === 'video',
      )
    }

    const freshItems = (
      Array.isArray(result.data?.result) ? result.data.result : []
    ) as CachedSearchItem[]

    /**
     * 旧数据（收藏项要从这里取）在**合并之前**读一次。
     *
     * 为什么不复用上面那份 `cached`：`skipCache` 时压根没读缓存，
     * 而「刷新列表」恰恰是最需要保住收藏顺序的场景 ——
     * 那时候 `cached` 是 null，用它当收藏来源等于「一刷新收藏全散了」。
     */
    const oldRows = cacheEnabled() ? cacheManager.listVideos(searchKey) : []

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
     *
     * **这里刻意不把「库里已有的收藏项」拼进返回值**（虽然规则 1-4 也说得通）。
     * 渲染层的 `changeSong` 是靠 `list.length === 0` 判断「要不要重试 3 次」的，
     * 返回收藏项会让它认为搜索成功了，从而**吞掉那 3 次重试** ——
     * 一次偶发空结果就直接少一批候选，而重试本来正是为了救这种情况。
     * 收藏项并没有丢：它们还在 `videos` 表里，下一次搜索成功就会出现在最前面。
     */
    const videoCount = freshItems.length
    if (videoCount === 0) {
      console.warn(`[search] ${searchKey} 搜索结果为空，不写入缓存（避免把偶发失败固化）`)
      return { data: { ...(result.data ?? {}), result: [] } }
    }

    const merged = await mergeWithFavorites(freshItems, oldRows)

    /**
     * ★ 硬过滤 + 分层打分 + 排序（**在写库之前**）
     *
     * 判据全部来自 `@common/utils/videoRank`，与渲染层共用同一份实现。
     * 顺序不能颠倒：`save()` 是按数组下标写 `ord`，所以这一步必须在 `save` 之前。
     *
     * 过滤**只作用于非收藏项**（见 `rankVideos` 的说明）：
     * 收藏是用户自己挑的（点收藏 / 手动「添加视频」），不该被
     * 「标题有没有歌名」「时长对不对」这类**搜索匹配规则**判掉。
     */
    const finalList = rankVideos(merged, {
      song: songName,
      singer: singerName,
      songDurationSec: findSongDuration(searchKey),
      tagBonus: getSetting()['player.tagBonus'],
      filterKeywords: getSetting()['player.filterKeywords'],
      durationToleranceSec: getSetting()['player.durationToleranceSec'],
      /**
       * ★ 与上面「取结果时」用同一套上限
       *
       * 降级轮放宽过（`容差 × 1.7`），这里必须跟着放宽 —— 否则
       * 「按放宽的规则数出 40 条、按严格规则只剩 5 条」，白降级一场。
       */
      relaxUpperBound: relaxedBound,
    })

    /**
     * 一次搜索打**一行**日志
     *
     * 格式：`关键词 取回N → 过滤M（P页/R轮，挡掉K）`
     *
     * 两端都显示才解释得清「取回 80 条怎么列表里只有 40 项」——
     * 那 40 条是被规则挡掉的（标题不含歌名 / 命中过滤词 / 时长差太多），不是丢了。
     *
     * 措辞注意：`R轮 = 1` 时走的是**主搜索词**，不是降级词。
     * 之前一律写「降级词「X」」会让人以为走了降级（用户直接指出过）。
     */
    if (searchStats) {
      const dropped = searchStats.raw - finalList.length
      console.log(
        `[search] ${searchKey} 取回${searchStats.raw} → 过滤${finalList.length}` +
          `（${searchStats.pages}页/${searchStats.rounds}轮` +
          `${searchStats.relaxed ? '/放宽' : ''}${dropped > 0 ? `，挡掉${dropped}` : ''}）`,
      )
    }

    /**
     * 过滤后为空 = **合法结果**，不是搜索失败
     *
     * 靠 `filtered: true` 告诉渲染层，它据此**跳过那 3 次重试**
     * （否则空结果会被当成网络问题，白打 3 次请求、白等两秒）。
     *
     * 这也是为什么**不能**用「回退成不过滤」来解决空结果：
     * 那会把标题不含歌名的条目一起放回列表里。
     */
    if (finalList.length === 0) {
      console.warn(
        `[search] ${searchKey} 按过滤规则后为空（原 ${merged.length} 条）—— 返回空并标记 filtered`,
      )
      return { data: { ...(result.data ?? {}), result: [], filtered: true } }
    }

    if (cacheEnabled()) {
      /**
       * 传整包（`{ code, data: { result, selectedBvid } }`）而不是里面的 `data`：
       * `cacheManager.save` 按这个形状拆列，而 `selectedBvid` 也要一起落到 `song_meta`。
       *
       * `save` 会保留库里已有的 `favorites`（新搜索结果里没有「收藏」这个概念），
       * 而 `view_result` / `playurl_result` 已经搬去 `video_details`，压根不会被碰到。
       */
      await cacheManager.save(searchKey, {
        ...result,
        data: { ...(result.data ?? {}), result: finalList },
      })
    }
    return { data: { ...(result.data ?? {}), result: finalList } }
  })

  /** 「添加视频」：把用户粘贴的链接 / BV 号解析成可预览的信息 */
  mainHandle('api:parseVideo', async ({ input }) => biliApi.parseVideoInput(input))

  /**
   * 收藏 / 取消收藏
   *
   * 返回收藏后的完整列表是刻意为之：**顺序由主进程的 `videos.ord` 决定**
   * （收藏时挪到第一位、取消收藏位置不动），只有主进程知道权威结果。
   * 返回 void 的话渲染层只能自己猜「现在排第几」，迟早和库里不一致。
   */
  mainHandle('api:setFavorite', async ({ searchKey, bvid, favorite }) => {
    /**
     * 收藏一个「库里还没有」的视频时，先把它的元数据补上
     *
     * 典型场景就是「添加视频」：用户粘贴一个 BV 号，那个视频很可能**不在**
     * 这首歌的搜索结果里（否则他直接点列表就行了），所以 `videos` 表里没有这一行。
     * `setFavorite` 会补插一行，但那时标题/封面是空的 —— 而界面刚通过
     * `api:parseVideo` 拿到过完整信息，不写进去的话下次刷新列表它就成了一条
     * 只有 BV 号的空壳。
     *
     * 为什么在这里回源而不是让渲染层把信息传进来：IPC 的参数形状是定好的
     * （`{ searchKey, bvid, favorite }`），不该为了这一件事改契约；
     * 而 `parseVideoInput` 本来就是这个 BV 号必跑的一步（`AddVideoDialog` 已经调过一次），
     * 主进程再取一次只是多一次走缓存/接口的请求。
     *
     * 失败**不影响收藏**：`api:searchSong` 的合并逻辑里，对「新结果里没有的收藏项」
     * 还会再回源刷新一次，所以标题终究会被补上（那条路径本来就有）。
     */
    if (favorite) {
      try {
        const existing = cacheManager.listVideos(searchKey).find((v) => v.bvid === bvid)
        if (!existing || !existing.title) {
          const info = await biliApi.parseVideoInput(bvid)
          cacheManager.upsertVideoMeta(searchKey, {
            bvid,
            title: info.title,
            pic: info.pic,
            author: info.author,
            duration: info.duration,
          })
        }
      } catch (err) {
        console.warn(`[favorite] 补齐视频信息失败（收藏照常进行）: ${bvid}`, err)
      }
    }
    cacheManager.setFavorite(searchKey, bvid, favorite)
    return { favorites: cacheManager.getFavorites(searchKey) }
  })

  mainHandle('api:getFavoriteBvids', ({ searchKey }) => cacheManager.getFavorites(searchKey))

  mainHandle('api:getSelectedBvid', ({ searchKey }) => cacheManager.getSelectedBvid(searchKey))

  /*
   * 没有 `api:setSelectedBvid`：写入在 `api:resolveVideo` 内部完成
   * （每次真正切到某个视频时一行 upsert）。独立的 set 频道是 JSON 时代的
   * 「攒到切歌/退出才写一次」的产物，换 SQLite 后不再需要，已删。
   */

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

      /** 本次是不是真的重新解析过（决定要不要写 playurl，见下面的保存处） */
      let resolvedFresh = false
      /** durl（渐进式 mp4）地址；走 dash 时为 null */
      let videoUrl: string | null = null
      /** dash 双轨（音视频分开）；走 durl 时为 null */
      let dash: DashStreams | null = null
      let viewData: BiliApiResponse | undefined
      let playData: BiliApiResponse | undefined
      let cached: Awaited<ReturnType<typeof cacheManager.get<SearchPayload>>> = null
      let results: CachedSearchItem[] = []

      /**
       * 读缓存列表（**只有元数据**）。
       *
       * `cacheManager.get()` 走的是 `videos_meta` 视图，不含地址列 ——
       * 那两段 dash JSON 每行几十 KB，300 行就是好几 MB，而这里只需要
       * 「列表里有哪些 bvid / 收藏标记 / 顺序」。地址单独按 bvid 取一行，
       * 见下面的 `getVideoAddress`。
       */
      if (keyword && cacheEnabled()) {
        cached = await cacheManager.get<SearchPayload>(keyword)
        const payload = cached?.data as unknown as SearchPayload | undefined
        results = Array.isArray(payload?.data?.result) ? payload.data.result : []
      }

      // 在缓存列表中查找当前 bvid 对应的视频项
      const targetIndex = results.findIndex((item) => item.bvid === bvid)
      let targetVideo: CachedSearchItem | undefined = results[targetIndex]

      /**
       * 这个 bvid 的**地址**（单独读一行，避免把整份列表的 dash 都拖出来）。
       *
       * 只在「列表里有这一项」时才有意义 —— 不在列表里说明没缓存过，
       * 直接走下面的重新解析分支。
       */
      const cachedAddress = keyword && targetVideo
        ? cacheManager.getVideoAddress(keyword, bvid)
        : null

      // 分支：使用缓存 / 重新解析
      if (targetVideo && cachedAddress && !skipCache) {
        const prevDashTried = cachedAddress.dashTried
        const cachedDurl = cachedAddress.durlUrl
        const cachedDash = cachedAddress.playurl
          ? biliApi.extractDashStreams(cachedAddress.playurl, wantQn, wantAudioId)
          : null
        const hasValidData = Boolean(cachedAddress.playurl)
        /**
         * 缓存条目里记的登录态快照。
         *
         * **只有明确是 `false`（当时确实未登录）才值得重取**：
         * 没有这个值（当时登录态未知）不该被当成「未登录时取的」，
         * 否则每次解析都要白重取一遍 —— 这就是「没退出登录却老在重新解析」的来源之一。
         */
        const cachedLoginState = cachedAddress.loginState
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
             * 这条是**预期内**的，不是故障：实测 B 站直链签名寿命中位正好 120 分钟。
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
          /**
           * 登录态与 `dash_tried` 的快照**不在这里写** —— 它们由下面的
           * `updateVideoResult()` 统一落库，那里集中处理「未知（null）时保留旧值」
           * 和「试过 dash 就永久记 1」两条规则。在内存对象上再写一份必然漂移。
           */
        }
      } else {
        /**
         * 无缓存项 / 强制跳过缓存：直接调用接口解析。
         *
         * **这里不再往 `targetVideo` 上挂 `view_result` / `playurl_result`** ——
         * schema v2 之后解析结果不存在内存对象里，而是由下面的
         * `updateVideoResult()` 直接提取成 `videos` 表的列。
         *
         * 旧实现是 `targetVideo = { bvid, view_result, playurl_result }`，
         * 那会把搜索结果里的 `title` / `pic` / `author` / `duration` **整个丢掉**
         * （它们随后会被写回缓存），表现是「播放器里标题空白、封面回退不出来」。
         * 现在展示字段根本不经手这里，那个 bug 从结构上就不可能再发生。
         */
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
      /**
       * **标题 / 封面 / 时长刻意来自不同来源**：
       *  - 标题取**搜索结果**里的：它带 `<em class="keyword">` 关键词高亮，
       *    界面上用 `sanitizeTitleHtml` 净化后 `v-html` 渲染，关键词会加粗；
       *  - 封面取 **view 响应**里的：尺寸比搜索结果里的大；
       *  - 时长也取 **view 响应**里的：**搜索接口有些结果压根不带 `duration`**
       *    （实测存在），于是那些条目在视频列表里没有时长。而 view 响应里一定有
       *    `data.duration`（秒），而这次解析**无论如何都要调 view**（为了拿 `cid`，
       *    playurl 必须带它）—— 白拿的数据就该用来补上。
       *
       * `viewData` 只在这次真的联网解析过时才有值；纯缓存命中时它是 undefined，
       * 那时就退回库里存的那份（`targetVideo.pic` / `title` / `duration`）。
       *
       * 补时长的效果不止「补插新行」：`updateVideoResult` 里更新已有行的那条 SQL 是
       * `duration = COALESCE(duration, ?)`，所以**库里已经是 NULL 的行也会被补上** ——
       * 那些没时长的候选，**播过一次就有了**。
       */
      const viewInfo = viewData?.data as
        | { title?: unknown; pic?: unknown; duration?: unknown }
        | undefined
      const title =
        (typeof targetVideo?.title === 'string' && targetVideo.title) ||
        (typeof viewInfo?.title === 'string' ? viewInfo.title : null)
      const pic =
        (typeof viewInfo?.pic === 'string' ? viewInfo.pic : null) ??
        (typeof targetVideo?.pic === 'string' ? targetVideo.pic : null)
      /**
       * 时长优先用 view 的（搜索结果常缺），再退回库里已有的那份。
       *
       * 两种形状都要收敛成「秒」再传下去：view 给的是数字秒，
       * 而搜索结果/缓存里那份可能是 `"4:03"` 字符串 —— `meta.duration` 的类型是
       * `number | null`，把字符串塞进去 typecheck 会拦住（这正是它该拦的）。
       * 归一用共享的 `durationToSeconds`，别再手写一份解析。
       */
      const duration =
        durationToSeconds(viewInfo?.duration) ?? durationToSeconds(targetVideo?.duration)

      /**
       * 写回缓存 —— 两件事的时机**故意不同**
       *
       * 1. **地址列**：只在**真的重新解析过**时写（`resolvedFresh`）。
       *    踩过：原来只要读到过这个 keyword 的缓存就无条件整包 `save` ——
       *    纯缓存命中、续播、预热下一首都会触发一次「同步 stringify + 写盘 + rename」
       *    （那个 JSON 最大能到几 MB），既阻塞主进程又白白磨损磁盘，而且什么都没改。
       *    现在按主键更新一行，没解析就什么都不写。
       *
       * 2. `selectedBvid`：**放宽成「只要用户切到了这个视频就写」**。
       *    这里修的是一个实打实的 bug：原条件 `keyword && cached && resolvedFresh` 里
       *    `resolvedFresh` 只在联网重新解析时才为 true，于是**缓存命中时压根不写回** ——
       *    用户在缓存有效期内换了视频，`selectedBvid` 一直停在很久以前那次解析的 bvid 上，
       *    表现就是「切回上一首歌，播的不是上次那首最后播的视频」。
       *    现在是一行 upsert，写入成本和「一次 setItem」差不多，不值得再省。
       *
       *    注意这里**没有**区分「用户切过来的」和「预热顺手解析的」：
       *    `warmApi` 也会走这个接口，所以预热同样会把它探测的那首歌的 selectedBvid 写掉 ——
       *    而预热挑的 bvid 与 `changeSong` 逐字一致，写进去的就是「这首歌该播的那个」。
       *
       * `meta` 只在**这一行还不在库里**时用得上（见 updateVideoResult 的注释）：
       * 正在续播的视频可能早已不在搜索结果里，补插时顺手把 view 响应里的
       * 标题/封面一起写上，免得列表里出现一个空壳。
       */
      if (keyword && cacheEnabled()) {
        if (resolvedFresh) {
          cacheManager.updateVideoResult(
            keyword,
            bvid,
            // 传整包 playurl 响应：cache 那边负责提取结构化列
            playData,
            // `loggedIn` 为 null = 这次没问到，cache 那边会保留旧值
            loggedIn,
            // IPC 参数是可选的，这里收敛成确定的布尔再传下去
            noDash === true,
            { title: title ?? '', pic, author: targetVideo?.author ?? null, duration },
          )
        }
        cacheManager.setSelectedBvid(keyword, bvid)
      }

      /**
       * 读清晰度 / 档位用的 playurl 数据。
       *
       * **两个来源，必须都考虑**（踩过：这里原来只读 `targetVideo.playurl_result`，
       * 而那个字段在 schema v2 就删掉了 —— 于是 `readVideoQuality(undefined)` 返回 null，
       * 控制栏的清晰度档位和音质档位直接消失，而且 `typecheck` 抓不到：
       * `CachedSearchItem` 有索引签名，读不存在的属性只会静默变成 undefined）：
       *
       *  1. `playData` —— 本次真的联网解析过（`resolvedFresh`）时的整包响应；
       *  2. `cachedAddress.playurl` —— 走缓存命中时，由 `getVideoAddress()` 从结构化列
       *     **拼回来的最小形状**。
       *
       * 不能只用一个：缓存命中时 `playData` 是 undefined，而重新解析时
       * `cachedAddress` 可能压根没读（`skipCache` / 列表里没这一项）。
       */
      const playurlForRead = playData ?? cachedAddress?.playurl ?? null

      const quality = readVideoQuality(
        playurlForRead,
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
       * 注意它来自 playurl 响应：dash 响应里一次就带回所有可访问档位，
       * 所以手动切换清晰度不需要重新请求接口，直接换一条流即可。
       * 数据来源与上面 `quality` 同一份（见 `playurlForRead` 的注释）。
       */
      const options = readQualityOptions(playurlForRead)

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
