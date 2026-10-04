import { fileURLToPath } from 'node:url';

const here = (p) => fileURLToPath(new URL(p, import.meta.url));

export const CONFIG = {
  dbPath: process.env.LY_DB || here('../data/ly.db'),
  webDist: here('../web/dist'),
  port: Number(process.env.PORT || 8787),
  // 預設只綁 loopback。對外部署時設 LY_HOST=0.0.0.0，此時 POST /api/v1/sync 會要求 LY_SYNC_TOKEN（見 index.mjs）。
  host: process.env.LY_HOST || '127.0.0.1',
  // CR-7／D8：手動同步端點的保護。沒設 token 時只有綁在 loopback 才開放同步。
  syncToken: process.env.LY_SYNC_TOKEN || '',
  // 實測：預設函式庫 UA（python-requests / Go-http-client / Python-urllib）會被 WAF 回 403，
  // 具名且可聯絡的 UA 才會 200。這是禮貌也是必要條件。
  // 注意：HTTP header 只能是 latin-1，UA 不可放中文，否則 Node 會丟 Invalid character in header content。
  userAgent:
    process.env.LY_UA ||
    'ly-dashboard/1.0 (+https://github.com/local/ly-dashboard; legislative-yuan-open-data-sync; contact: local-admin)',
  endpoints: {
    id9: 'https://data.ly.gov.tw/odw/ID9Action.action?fileType=json',
    id14: 'https://data.ly.gov.tw/odw/ID14Action.action?fileType=json',
  },
  // 議案：g0v 社群維護的立法院 API（非官方），已把議案與提案委員對好，官方 data.ly.gov.tw 沒有這層關聯。
  bills: {
    url: 'https://ly.govapi.tw/v2/bills',
    pageSize: 1000,
    name: 'g0v 立法院 API',
    homepage: 'https://ly.govapi.tw/',
  },
  // 預算審議：同一個 g0v API，改抓政府／委員會送來的預算類議案（總預算案、法人預算、預算決議書面報告）
  budget: {
    categories: ['中央政府總預算案', '法人預(決)算案', '預(決) 算決議案、定期報告'],
    // 立法院預算中心的評估報告（官方 WebAPI）；只取與預算審議直接相關的兩類
    reportsUrl: 'https://www.ly.gov.tw/WebAPI/BudgetCenterResearch.aspx',
    reportTypes: ['預算案評估', '決算案評估'],
    // 委員會登記發言名單（官方 ID223）；整屆一次抓約 20 秒，逾時放寬
    meetingsUrl: 'https://data.ly.gov.tw/odw/ID223Action.action',
    meetingsTimeoutMs: 120_000,
  },
  // 常設委員會（依立法院官網順序）＋程序委員會；委員會頁的選單依此排序，其餘依件數排在後面
  committeeOrder: ['內政委員會', '外交及國防委員會', '經濟委員會', '財政委員會', '教育及文化委員會', '交通委員會', '司法及法制委員會', '社會福利及衛生環境委員會', '程序委員會'],
  // 委員會會議紀錄：g0v API 的公報議程，只留「委員會紀錄」（類別代碼 3）；本屆約 3,300 筆議程、4 頁
  records: {
    url: 'https://ly.govapi.tw/v2/gazette_agendas',
    category: 3,
    // 委員會會議的議事網資料：附件（書面報告、機關回覆＝部會對委員質詢的書面答復）與會議影片；本屆約 1,300 場、13MB／千筆
    meetsUrl: 'https://ly.govapi.tw/v2/meets',
    meetTypes: ['委員會', '聯席會議', '公聽會'],
  },
  // 新聞：Google News RSS，以「"姓名" 立委」搜尋近 30 天；逐位委員依序抓，間隔避免被限流。
  news: {
    url: 'https://news.google.com/rss/search',
    name: 'Google 新聞',
    windowDays: 30,
    keepDays: 180,
    delayMs: Number(process.env.LY_NEWS_DELAY_MS ?? 1000),
    // M5：整體時間預算。用完就停止剩餘委員並標記 partial，不讓單一階段拖垮整個同步。
    budgetMs: Number(process.env.LY_NEWS_BUDGET_MS ?? 5 * 60 * 1000),
    // 基金／機關／行政法人新聞：名稱每 entityBatch 個合成一次 OR 查詢（約 600 個名稱 → 約 80 次），
    // 有自己的時間預算（不被委員新聞用光）；用不完就從上次停下的組別接著抓。
    entityBatch: Number(process.env.LY_NEWS_ENTITY_BATCH ?? 8),
    entityBudgetMs: Number(process.env.LY_NEWS_ENTITY_BUDGET_MS ?? 4 * 60 * 1000),
    // 現任直轄市議員（約 360 位）逐位查 Google 新聞的時間預算；用完下輪從停下的議員接續。0＝不查
    councilBudgetMs: Number(process.env.LY_NEWS_COUNCIL_BUDGET_MS ?? 8 * 60 * 1000),
    // 媒體官方 RSS：補 Google 新聞漏掉的報導、也不受 Google 限流影響。每家每輪只抓一次（最新幾十則），
    // 再依標題分派給委員／機關首長／主計／基金機關，規則與 Google 那一路相同。抓不到只記警告。
    // join：中央社與自由是政治類、聯合 6638 是要聞類（政治為主）、公視只有一個綜合 feed（Atom）。
    // 聯合的 id 是分類代碼，換 id 就是換分類；`/news/rssfeed/7225` 是「全球」（國際），
    // 2026-10-03 實測 398 則寫入委員新聞 0 筆，故改用 6638 要聞（496 則 → 210 筆）。
    // GitHub Actions 收集的媒體 RSS（news-data 分支，見 .github/workflows/collect-news.yml）；空字串＝不匯入
    feedUrl: process.env.LY_NEWS_FEED_URL ?? 'https://raw.githubusercontent.com/cormort/ly-dashboard/news-data',
    // repo 若是私人的，讀收集檔要帶 GitHub token（只需要這個 repo 的 Contents 唯讀權限）；目前公開，不用設。私人 repo 沒帶 token 一律回 404
    feedToken: process.env.LY_GITHUB_TOKEN || '',
    // 收集檔最新一則的收集時間超過這麼久，就在新聞同步的備註提醒「收集端可能停了」
    feedStaleHours: Number(process.env.LY_NEWS_FEED_STALE_HOURS ?? 6),
    // 媒體 RSS 另外每小時抓一次（feed 只留最新幾十則，一天抓一次會漏）；0＝停用，只隨每日同步抓
    outletIntervalMs: Number(process.env.LY_NEWS_OUTLET_INTERVAL_MS ?? 60 * 60 * 1000),
    outlets: [
      // 中央社分類各一個 feed（政治只留最新 20 則）；name 是新聞上顯示的媒體名，feed 只用在 log 分辨是哪一類。
      // 分類網址取自中央社 RSS 服務頁（https://www.cna.com.tw/about/rss.aspx）；國際、兩岸、科技、生活、文化、運動、娛樂與用途關聯低，沒收
      { name: '中央社', feed: '政治', url: 'https://feeds.feedburner.com/rsscna/politics' },
      { name: '中央社', feed: '產經證券', url: 'https://feeds.feedburner.com/rsscna/finance' },
      { name: '中央社', feed: '社會', url: 'https://feeds.feedburner.com/rsscna/social' },
      { name: '中央社', feed: '地方', url: 'https://feeds.feedburner.com/rsscna/local' },
      { name: '自由時報', url: 'https://news.ltn.com.tw/rss/politics.xml' },
      { name: '聯合新聞網', url: 'https://udn.com/news/rssfeed/6638' },
      { name: '公視新聞', url: 'https://news.pts.org.tw/xml/newsfeed.xml' },
    ],
  },
  // 社群帳號：人工整理的 Google 試算表（知道連結者可檢視），以 CSV 匯出網址抓取。
  social: {
    url:
      process.env.LY_SOCIAL_CSV ||
      'https://docs.google.com/spreadsheets/d/1hFuV22z3ceSGFC03zGUUX5qEKzetBQLeCA-mHTJcQFw/export?format=csv&gid=1916425311',
    name: '委員社群帳號整理表',
    // 整理表裡「最新貼文日期」最新的一筆超過這麼多天，就在畫面與 /health 提醒「整理表可能沒在更新」
    staleDays: Number(process.env.LY_SOCIAL_STALE_DAYS ?? 7),
    // 議員臉書整理表（格式見 docs/social-sheet-spec.md「議員分頁」）的 CSV 匯出網址；空字串＝不匯入
    councilUrl: process.env.LY_COUNCIL_SOCIAL_CSV || '',
  },
  source: {
    name: '立法院開放資料',
    url: 'https://data.ly.gov.tw/',
    license: '政府資料開放授權條款第 1 版',
  },
  // M1：測試／驗證用的階段開關（外部來源全部跳過 → 秒級、不打第三方）
  skip: {
    bills: process.env.LY_SKIP_BILLS === '1',
    budget: process.env.LY_SKIP_BUDGET === '1',
    news: process.env.LY_SKIP_NEWS === '1',
    social: process.env.LY_SKIP_SOCIAL === '1',
  },
  // 前端會顯示的兩種「紀錄」保留上限（同步紀錄／異動紀錄）。
  // 預設 0 = 全部保留（要落地就留著）；要設上限再給環境變數，例：LY_SYNC_RUNS_KEEP=200
  retention: {
    syncRuns: Number(process.env.LY_SYNC_RUNS_KEEP ?? 0),
    changeLog: Number(process.env.LY_CHANGE_LOG_KEEP ?? 0),
  },
  staleAfterHours: Number(process.env.LY_STALE_HOURS || 36),
  // 靜態資料（人口／選舉／鄉鎮圖資，由 scripts/build-county-stats.mjs 產生）不在同步流程內，
  // 來源是月報與選舉年，不會天天變；超過這個月數就在 /health 的 warnings 提醒重跑 build。
  staticStaleMonths: Number(process.env.LY_STATIC_STALE_MONTHS ?? 3),
  syncIntervalMs: Number(process.env.LY_SYNC_INTERVAL_MS || 24 * 60 * 60 * 1000),
  fetchTimeoutMs: Number(process.env.LY_FETCH_TIMEOUT_MS || 30_000),
  // 同一個 host 的最小請求間隔：g0v API 連續抓多頁會回 429（實測），溫和一點也保護對方
  minRequestIntervalMs: Number(process.env.LY_MIN_INTERVAL_MS ?? 400),
  fetchRetries: Number(process.env.LY_FETCH_RETRIES || 3),
  // B6：Retry-After 可能要求等上數千秒；尊重它，但不能讓一個標頭把整個同步階段卡死。
  retryAfterCapMs: Number(process.env.LY_RETRY_AFTER_CAP_MS ?? 60_000),
  // B1／B2：整批覆寫的相對筆數門檻（低於上次成功的這個比例就中止，保留舊資料）。
  // 真的遇到來源合法縮減（例如委員會減併）時，用 LY_ALLOW_SHRINK=1 強制覆寫一次。
  shrinkMinRatio: Number(process.env.LY_SHRINK_MIN_RATIO ?? 0.8),
  allowShrink: process.env.LY_ALLOW_SHRINK === '1',
};
