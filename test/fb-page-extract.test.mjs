import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { isPostDateCandidate, collectPostDates, chooseLatestPost, pickLatestStory, textOfHref } from '../scripts/fetch-fb-posts.mjs';

const fixture = (name) => readFileSync(fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url)), 'utf8');
const FEED_HTML = fixture('fb-page-chat-and-featured.html');
const POST_NEW = 'https://www.facebook.com/fakepage/posts/pfbidNEW';
const POST_OLD = 'https://www.facebook.com/fakepage/posts/pfbidOLD';

/**
 * dump 的形狀＝EXTRACT 在瀏覽器裡回傳的東西：每個帶日期的元素附上
 * label（完整 aria-label）／chat（在聊天區內）／inLink（在 <a> 裡）三個旗標。
 * 「哪一個旗標算貼文日期」的規則放在 Node 端（isPostDateCandidate），才能被測試釘住。
 */
const chatDump = (over = {}) => ({
  dates: [
    // 使用者自己的 Messenger 對話：真頁面上有 10 個這種（實測），全部都不是貼文日期
    { date: '2026年10月14日', rel: '', href: '', label: '2026年10月14日 19:42，王小明', chat: true, inLink: false, likes: '', comments: '' },
    { date: '2026年10月14日', rel: '', href: '', label: '輸入，訊息已在2026年10月14日 11:01由你傳送', chat: true, inLink: false, likes: '', comments: '' },
    { date: '2026年10月14日', rel: '', href: '', label: '2026年10月14日 11:01，你', chat: false, inLink: false, likes: '', comments: '' },
    // 真貼文：日期在貼文永久連結裡
    { date: '2026年10月14日', rel: '', href: POST_NEW, label: '2026年10月14日 星期三下午4:08', chat: false, inLink: true, likes: '12', comments: '3' },
    { date: '2026年10月11日', rel: '', href: POST_OLD, label: '2026年10月11日 星期日下午4:08', chat: false, inLink: true, likes: '40', comments: '5' },
  ],
  texts: [
    { href: POST_OLD, text: '舊貼文的內文（同一個 href 才算同一則）' },
    { href: 'https://www.facebook.com/fakepage/', text: '上線狀態指標 在線上 假粉專 o t s r o e p d n' },
  ],
  messages: ['精選舊文的內文：這是一年前那則被置頂的公聽會貼文（不可當成最新）'],
  pageName: 'Fake 委員粉專',
  followers: '1,234',
  login: false,
  ...over,
});

test('貼文日期：聊天側欄的訊息時間不算（Messenger 泡泡也帶日期）', () => {
  const dump = chatDump();
  const chatEntries = dump.dates.filter((d) => d.chat || /訊息|傳送/.test(d.label) || /\d{1,2}:\d{2}\s*[，,]/.test(d.label));
  assert.equal(chatEntries.length, 3, '這份 dump 裡有 3 個聊天樣子的日期');
  assert.ok(chatEntries.every((e) => isPostDateCandidate(e) === false), '聊天訊息泡泡、輸入提示、有「時:分，名字」的都不能算貼文日期');

  const posts = collectPostDates(dump);
  assert.deepEqual(posts.map((p) => p.ymd), ['2026-10-14', '2026-10-11'], '只剩兩則真貼文，新→舊');
  assert.ok(posts.every((p) => p.href), '留下的都是貼文連結');
});

test('貼文日期：要有「星期」或位在貼文連結裡（其餘一律不算）', () => {
  assert.equal(isPostDateCandidate({ date: '2026年10月14日', label: '2026年10月14日', chat: false, inLink: false }), false);
  assert.equal(isPostDateCandidate({ date: '2026年10月14日', label: '2026年10月14日 星期三', chat: false, inLink: false }), true);
  assert.equal(isPostDateCandidate({ date: '2026年10月14日', label: '什麼都沒寫', chat: false, inLink: true }), true);
  assert.equal(isPostDateCandidate({ date: '2026年10月14日', label: '2026年10月14日 19:42，你', chat: false, inLink: true }), false,
    '聊天形狀的 label 即使被包在連結裡也不算');
  assert.equal(isPostDateCandidate({ date: '', label: '3小時', chat: false, inLink: true }), false, '沒有絕對日期的不算');
});

test('貼文日期：未來日期與 2000 年前不算（saneDate）', () => {
  const dump = chatDump({
    dates: [
      { date: '2030年1月1日', rel: '', href: POST_NEW, label: '2030年1月1日 星期二', chat: false, inLink: true, likes: '', comments: '' },
      { date: '1999年1月1日', rel: '', href: POST_OLD, label: '1999年1月1日 星期五', chat: false, inLink: true, likes: '', comments: '' },
    ],
  });
  assert.deepEqual(collectPostDates(dump), [], '兩個都不合理 → 一則都不留');
});

test('內嵌 JSON：日期與內文來自同一則，精選舊文不會被當成最新', () => {
  const stories = pickLatestStory(FEED_HTML);
  assert.deepEqual(stories.map((s) => s.date), ['2026-10-14', '2025-10-23'], '新的在前，只有兩個 story');
  assert.match(stories[0].text, /最新貼文的內文/, '最新那則的內文是它自己的');
  assert.equal(stories[0].url, POST_NEW);
  assert.match(stories[1].text, /精選舊文的內文/, '精選舊文帶著自己的日期（2025-10-23）');
  assert.ok(!stories.some((s) => s.date === '2026-05-29'), '聊天區塊裡的 creation_time 不算 feed story');
});

test('挑最新貼文：同一天以 JSON 為準（它帶著同一則的內文），精選舊文的內文不得出現', () => {
  const chosen = chooseLatestPost({ dump: chatDump(), html: FEED_HTML });
  assert.equal(chosen.date, '2026-10-14');
  assert.match(chosen.summary, /最新貼文的內文/, '摘要＝與日期同一則的內文');
  assert.ok(!chosen.summary.includes('精選舊文的內文'), '頁面最上面那則精選舊文的內文不可以變成摘要');
  assert.equal(chosen.postUrl, POST_NEW);
  assert.equal(chosen.likes, '12', '同一個連結時才把讚數掛上去');
  assert.equal(chosen.comments, '3');
});

test('挑最新貼文：配不到同一則的內文就留空，不退回「DOM 第一則訊息」', () => {
  // 只有聊天日期、沒有 feed JSON → 什麼都沒有
  const onlyChat = chooseLatestPost({ dump: chatDump({ dates: chatDump().dates.slice(0, 3) }), html: '<html>沒有 feed JSON</html>' });
  assert.equal(onlyChat.date, '');
  assert.equal(onlyChat.summary, '');
  assert.ok(!onlyChat.summary.includes('精選舊文'), 'DOM 第一則訊息（messages[0]）不再是摘要的來源');

  // DOM 有貼文日期，但那個連結沒有自己的內文（texts 沒有對應 href）→ 日期留著、摘要留空
  const noText = chooseLatestPost({
    dump: chatDump({ texts: [], messages: ['這是 DOM 第一則訊息，不可以用'] }),
    html: '<html>沒有 feed JSON</html>',
  });
  assert.equal(noText.date, '2026-10-14');
  assert.equal(noText.summary, '', '同一個 href 拿不到內文 → 留空（寧可空白，不要配錯）');
});

test('挑最新貼文：沒有 feed JSON 時，DOM 那條路要用同一個 href 的內文', () => {
  const chosen = chooseLatestPost({ dump: chatDump(), html: '<html>沒有 feed JSON</html>' });
  assert.equal(chosen.date, '2026-10-14', 'DOM 上最新的貼文日期');
  assert.equal(chosen.summary, textOfHref(chatDump(), POST_NEW) || '');
  assert.equal(chosen.summary, '', '這份 dump 的 POST_NEW 沒有內文 → 留空');
  assert.equal(chosen.likes, '12', '同一則的互動數還是可以掛');
});

test('EXTRACT 會標記聊天區（原始碼層級：規則被改回去就會紅）', async () => {
  const src = readFileSync(fileURLToPath(new URL('../scripts/fetch-fb-posts.mjs', import.meta.url)), 'utf8');
  assert.ok(src.includes('[data-scope="messages_table"], [data-message-id], [role="log"], [aria-roledescription="訊息"]'), 'EXTRACT 要看得出「這個日期在聊天區裡」');
  assert.ok(src.includes('chat: inChat(el)'), '每個日期元素都要帶 chat 旗標');
  assert.ok(!/let summary = best \? best\.text \|\| messages\[0\]/.test(src), '摘要不可以再從 DOM 第一則訊息來');
});
