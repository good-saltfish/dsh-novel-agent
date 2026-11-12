/**
 * 「贴 Markdown 设定稿 → 模型拆成骨架 + 设定库」的测试。
 *
 * 全程用假 `complete`，不连真模型：这一段要验的是**解析与校验**，不是模型水平。
 * 真模型拆得好不好会随模型变，但「模型漏了金手指的代价时必须拒收」这条
 * 与模型无关，任何时候都得成立。
 */

import {
  BEAT_ORDER_MAX,
  CHAPTER_ORDER_MAX,
  ENTRY_TYPES,
  MAX_MARKDOWN_CHARS,
  MIN_MARKDOWN_CHARS,
  buildMessages,
  extractJson,
  importFromMarkdown,
  normalizeDraft,
} from '../lib/import-md.js';

let pass = 0;
let fail = 0;
const ok = (name) => { pass += 1; console.log(`  ok  ${name}`); };
const bad = (name, detail) => { fail += 1; console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`); };
const check = (name, condition, detail) => (condition ? ok(name) : bad(name, detail));

const SAMPLE_MD = `# 守灯人

## 世界观
长夜降临，灯火是唯一的边界。守灯人负责在每一座灯楼添油。

## 人物
- 陈默：沉默寡言的年轻守灯人，背着父亲留下的灯油壶。

## 章节目录
1. 第一盏灯——陈默接手最难守的北塔。
2. 灯灭之夜——有人在灯油里掺了东西。
`;

const FULL_DRAFT = {
  title: '守灯人',
  positioning: {
    genre: '悬疑',
    audience: '喜欢克苏鲁氛围的男频读者',
    core_premise: '灯灭之后，黑暗里的东西会顶替人',
    selling_points: ['守夜人情结', '灯火作为边界'],
    tone_target: '压抑、克制',
  },
  volume: {
    volume_title: '北塔的第一个冬天',
    volume_goal: '守住北塔到春天',
    main_conflict: '灯油被人掺假',
    ending_hook: '灯楼名单上出现了陈默自己的名字',
  },
  protagonist: {
    name: '陈默',
    background: '父亲死在北塔，他接手了同一座塔',
    personality: '寡言、认死理',
    desire: '证明父亲不是逃兵',
    flaw: '不肯开口求助',
    signature_ability: '能从灯焰的颜色读出油里掺了什么',
  },
  golden_finger: {
    name: '灯焰辨伪',
    form: '天赋',
    ability: '盯着灯焰能看到油的来路',
    cost_limitation: '每用一次，视力模糊半天，连着用会瞎',
    growth_path: '从辨油到辨人',
  },
  chapters: [
    {
      order: 1,
      title: '第一盏灯',
      core_event: '陈默接手北塔',
      opening_hook: '北塔已经三个月没人肯守',
      ending_hook: '灯油壶底下刻着他父亲的名字',
      beats: [
        { order: 1, scene: '北塔楼下', characters: ['陈默', '老周'], emotion: '疑', event: '老周交接钥匙时欲言又止', plant_foreshadow: '老周少交了一把钥匙' },
        { order: 2, scene: '塔顶灯室', characters: ['陈默'], emotion: '冷', event: '陈默点亮第一盏灯，焰色发青', plant_foreshadow: null },
      ],
    },
  ],
  settings: [
    { entry_type: 'world_rule', name: '长夜边界', content: '灯火之外即长夜，人不能离开灯照范围超过一刻钟', tags: ['铁律'], related_chapters: [1] },
    { entry_type: 'character', name: '老周', content: '上一任守灯人，交接时少交了一把钥匙', tags: ['配角'], related_chapters: [1] },
  ],
  notes: ['稿子里没写金手指的成长路径，按"从辨油到辨人"补了一句——如果不对请改。'],
};

function fakeComplete(reply) {
  const calls = [];
  const fn = async (payload) => {
    calls.push(payload);
    return { text: typeof reply === 'function' ? reply(payload) : reply };
  };
  fn.calls = calls;
  return fn;
}

async function main() {
  console.log('\n=== import-md —— 设定稿解析');

  /* --- 1. 提示词 --- */
  const messages = buildMessages(SAMPLE_MD, { title: '守灯人', genre: '悬疑', premise: '' });
  check('提示词有 system 与 user 两条', messages.length === 2 && messages[0].role === 'system' && messages[1].role === 'user');
  check('system 里点明不许编造', messages[0].content.includes('绝对不要编造'));
  const userText = messages[1].content;
  check('user 里带上了整篇 Markdown', userText.includes('北塔') && userText.includes('灯油'));
  check('user 里带上表单已填的书名与题材', userText.includes('书名：守灯人') && userText.includes('题材：悬疑'));
  check('空的一句话前提不出现', !userText.includes('一句话前提：'));
  check('user 里给出引擎字段名（golden_finger/cost_limitation）', userText.includes('golden_finger') && userText.includes('cost_limitation'));
  check('user 里给出受控词表六种 entry_type', ENTRY_TYPES.every((type) => userText.includes(type)));
  check('提示词要求章号与节拍序号', userText.includes('"order": 1'));

  /* --- 2. 取 JSON：模型爱加围栏与解释 --- */
  check('能剥掉 ```json 围栏', extractJson('```json\n{"a":1}\n```').a === 1);
  check('能剥掉前后解释文字', extractJson('好的，结果如下：\n{"a":2}\n以上。').a === 2);
  check('能处理前后都有花括号的文本', extractJson('{ "a": { "b": 1 } }').a.b === 1);
  let threw = false;
  try { extractJson('完全没有 JSON'); } catch { threw = true; }
  check('没有 JSON 时明确报错', threw);
  threw = false;
  try { extractJson('{ 坏的 }'); } catch (error) { threw = /JSON 解析失败/.test(error.message); }
  check('JSON 坏了时报"解析失败"而不是静默返回空', threw);

  /* --- 3. 归一化：完整稿全部收下 --- */
  const full = normalizeDraft(FULL_DRAFT);
  check('书名解析出来', full.title === '守灯人');
  check('五个部件全部通过校验', ['positioning', 'volume', 'protagonist', 'golden_finger', 'chapters'].every((part) => full.parts[part]));
  check('设定库两条都在', full.settings.length === 2);
  check('没有任何被丢弃项', full.dropped.length === 0);
  check('模型备注带出来', full.notes.length === 1 && full.notes[0].includes('成长路径'));
  check('细纲章号按位置重排为 1', full.parts.chapters[0].order === 1);
  check('节拍序号按位置重排', full.parts.chapters[0].beats.map((b) => b.order).join(',') === '1,2');
  check('伏笔为空时是 null 而不是空串', full.parts.chapters[0].beats[1].plant_foreshadow === null);
  check('出场角色是数组', Array.isArray(full.parts.chapters[0].beats[0].characters));
  check('selling_points 是数组', Array.isArray(full.parts.positioning.selling_points));

  /* --- 4. 归一化：缺必填项必须拒收并说明 --- */
  const missing = normalizeDraft({
    positioning: { audience: '没写类型' },
    protagonist: { background: '没写名字' },
    golden_finger: { name: '无敌', ability: '什么都行' },
    chapters: [{ core_event: '没写标题' }],
    settings: [{ entry_type: '不存在的类型', name: 'x', content: 'y' }],
  });
  check('缺 genre 的定位被丢弃', !missing.parts.positioning);
  check('缺 name 的主角被丢弃', !missing.parts.protagonist);
  check('缺 cost_limitation 的金手指被丢弃', !missing.parts.golden_finger);
  check('丢弃原因写明"限制与代价"', missing.dropped.some((item) => item.part === 'golden_finger' && item.reason.includes('限制与代价')));
  check('全部章都缺标题时细纲被丢弃', !missing.parts.chapters);
  check('细纲丢弃原因写在 dropped 里', missing.dropped.some((item) => item.part === 'chapters'));
  check('非法的 entry_type 被过滤', missing.settings.length === 0);
  check('丢弃项都有给人看的原因', missing.dropped.every((item) => typeof item.reason === 'string' && item.reason.length > 0));

  /* --- 5. 归一化：越界值 --- */
  const longBeats = normalizeDraft({
    chapters: [{
      title: '一章',
      beats: Array.from({ length: BEAT_ORDER_MAX + 5 }, (_, i) => ({ order: i + 1, scene: 's', event: 'e' })),
    }],
  });
  check(`节拍超过 ${BEAT_ORDER_MAX} 个会被截断`, longBeats.parts.chapters[0].beats.length === BEAT_ORDER_MAX);
  check('截断后序号仍连续', longBeats.parts.chapters[0].beats.at(-1).order === BEAT_ORDER_MAX);

  const manyChapters = normalizeDraft({
    chapters: Array.from({ length: CHAPTER_ORDER_MAX + 3 }, (_, i) => ({ title: `第${i + 1}章` })),
  });
  check(`章数超过 ${CHAPTER_ORDER_MAX} 会被截断`, manyChapters.parts.chapters.length === CHAPTER_ORDER_MAX);

  const gapChapters = normalizeDraft({
    chapters: [{ order: 5, title: '甲' }, { order: 9, title: '乙' }],
  });
  check('模型给的跳号章号被重排成 1,2', gapChapters.parts.chapters.map((c) => c.order).join(',') === '1,2');

  const badBeats = normalizeDraft({
    chapters: [{ title: '一章', beats: [{ order: 1, scene: '', event: '有事件' }, { order: 2, scene: '有场景', event: '' }, { scene: 's', event: 'e' }] }],
  });
  check('缺场景或缺事件的节拍被丢掉', badBeats.parts.chapters[0].beats.length === 1);

  /* --- 6. importFromMarkdown：端到端（假模型） --- */
  const complete = fakeComplete(JSON.stringify(FULL_DRAFT));
  const result = await importFromMarkdown({ complete, markdown: SAMPLE_MD, hints: { title: '守灯人' } });
  check('端到端拿到五个部件', Object.keys(result.parts).length === 5);
  check('端到端拿到设定库', result.settings.length === 2);
  check('只调用了一次模型', complete.calls.length === 1);
  check('请求里要求 JSON 模式', complete.calls[0].response_format && complete.calls[0].response_format.type === 'json_object');
  check('请求没塞 max_tokens（预算交给宿主）', complete.calls[0].max_tokens === undefined);
  check('请求温度偏低（要稳定不要创意）', complete.calls[0].temperature === 0.2);

  /* --- 7. 稿子本身的问题必须早于模型失败 --- */
  threw = false;
  try { await importFromMarkdown({ complete: fakeComplete('{}'), markdown: '太短' }); } catch (error) { threw = error.code === 'md-too-short'; }
  check(`稿子短于 ${MIN_MARKDOWN_CHARS} 字时 400（不浪费一次模型调用）`, threw);

  threw = false;
  const huge = '灯'.repeat(MAX_MARKDOWN_CHARS + 1);
  try { await importFromMarkdown({ complete: fakeComplete('{}'), markdown: huge }); } catch (error) { threw = error.code === 'md-too-long'; }
  check(`稿子长于 ${MAX_MARKDOWN_CHARS} 字时 400`, threw);

  const shortCallCount = fakeComplete('{}');
  try { await importFromMarkdown({ complete: shortCallCount, markdown: '短' }); } catch { /* 预期 */ }
  check('稿子不合格时一次模型调用都不发', shortCallCount.calls.length === 0);

  /* --- 8. 模型没拆出东西时必须报错，不能返回空草稿 --- */
  threw = false;
  try {
    await importFromMarkdown({ complete: fakeComplete('{"notes":["看不懂"]}'), markdown: SAMPLE_MD });
  } catch (error) { threw = error.code === 'md-empty'; }
  check('模型什么都没拆出来时报 502，而不是返回一份空草稿', threw);

  /* --- 9. 模型的错与稿子的错要能分清 --- */
  let status = null;
  try {
    await importFromMarkdown({
      complete: async () => { throw Object.assign(new Error('模型没返回内容'), { status: 502, code: 'model-failed' }); },
      markdown: SAMPLE_MD,
    });
  } catch (error) { status = error.status; }
  check('模型失败时 502 原样冒泡', status === 502);

  console.log(`\n${pass} 通过 / ${fail} 失败`);
  process.exit(fail === 0 ? 0 : 1);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
