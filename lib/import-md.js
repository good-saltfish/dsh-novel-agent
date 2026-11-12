/**
 * 从一份 Markdown 设定稿，让模型一次性产出「骨架 + 设定库」。
 *
 * 为什么这一段放在插件宿主而不是引擎：
 * 引擎只有 `POST /projects/<id>/generate`，它按「书名 + 一句话前提 + 题材」
 * 自己编骨架——用户手里那一大篇设定（人物小传、世界观、章节目录）根本没有
 * 进去的通道。而模型只能由插件这边调（DSH 的 llm 服务在宿主进程里），所以
 * 「读 Markdown → 让模型拆成结构化部件」这件事天然属于插件。
 *
 * 一条硬纪律：**这里只产出草稿，不写盘**。落盘走引擎已有的
 * `PUT /parts/<part>` 与 `PUT /plan/accept/settings`，让人有机会先看一眼。
 * 模型读错了 Markdown 的时候，用户改的是草稿，不是已经写进 project.json 的
 * 错误设定——那种错误会一路污染后面每一章的上下文。
 */

/** Markdown 太短的稿子拆不出东西，太长会把上下文吃光。 */
export const MIN_MARKDOWN_CHARS = 40;
export const MAX_MARKDOWN_CHARS = 60_000;

/** 与引擎 `creation/models.py` 对齐的受控词表与上限（改这里必须同步）。 */
export const ENTRY_TYPES = ['world_rule', 'faction', 'character', 'location', 'item', 'power_system'];
export const CHAPTER_ORDER_MAX = 999;
export const BEAT_ORDER_MAX = 20;

const SYSTEM_PROMPT = [
  '你是网文创作助手。用户给你一份 Markdown 设定稿，你要把它拆成结构化的创作工程部件。',
  '',
  '铁律：',
  '1. 只输出一个 JSON 对象，不要任何解释、不要 Markdown 代码围栏。',
  '2. 稿子里没有的内容一律给 null 或空数组，**绝对不要编造**。用户宁可看到"没写"，也不要看到一个假的设定。',
  '3. 保留原文的专有名词原样（人名、地名、能力名），不要润色改写。',
  '4. 稿子里自相矛盾的地方，以靠前的段落为准，并在 notes 里写一条说明。',
].join('\n');

/** 让模型照着填的 JSON 骨架。字段名必须与引擎模型逐字一致。 */
const SCHEMA_HINT = `{
  "title": "书名，字符串。稿子里没有就用空字符串",
  "positioning": {
    "genre": "主类型，必填。如 都市/玄幻/悬疑",
    "audience": "目标读者",
    "core_premise": "一句话卖点",
    "selling_points": ["差异化卖点"],
    "tone_target": "目标基调"
  },
  "volume": {
    "volume_title": "卷名，必填",
    "volume_goal": "本卷目标",
    "main_conflict": "本卷核心矛盾",
    "ending_hook": "卷尾钩子"
  },
  "protagonist": {
    "name": "姓名，必填",
    "background": "出身/初始处境",
    "personality": "性格",
    "desire": "核心欲望",
    "flaw": "缺陷/成长课题",
    "signature_ability": "标志性能力"
  },
  "golden_finger": {
    "name": "名称，必填",
    "form": "形态",
    "ability": "能做什么",
    "cost_limitation": "限制与代价，必填",
    "growth_path": "成长路径"
  },
  "chapters": [
    {
      "order": 1,
      "title": "章标题，必填",
      "core_event": "本章核心事件",
      "opening_hook": "开篇钩子",
      "ending_hook": "章尾钩子",
      "beats": [
        {
          "order": 1,
          "scene": "场景/地点，必填",
          "characters": ["出场角色"],
          "emotion": "情绪走向",
          "event": "发生什么，必填",
          "plant_foreshadow": "本节拍埋的伏笔，没有就 null"
        }
      ]
    }
  ],
  "settings": [
    {
      "entry_type": "world_rule | faction | character | location | item | power_system 六选一",
      "name": "名称，必填",
      "content": "设定内容，必填",
      "tags": ["标签"],
      "related_chapters": [1]
    }
  ],
  "notes": ["你做的判断或发现的矛盾，给人看的一句话"]
}`;

/**
 * 组 prompt。
 *
 * `hints` 里的书名/题材/一句话前提是用户在表单里填的——它们是用户的**意图**，
 * 比稿子里可能过时的描述更权威，所以显式告诉模型优先用它们。
 */
export function buildMessages(markdown, hints = {}) {
  const given = [];
  for (const [key, label] of [['title', '书名'], ['genre', '题材'], ['premise', '一句话前提']]) {
    const value = String(hints[key] || '').trim();
    if (value) given.push(`- ${label}：${value}`);
  }
  const user = [
    given.length > 0
      ? `用户在表单里已经填了这些，**以这些为准**，不要用稿子里的旧说法覆盖：\n${given.join('\n')}\n`
      : '',
    '请按下面的结构输出 JSON：',
    SCHEMA_HINT,
    '',
    'Markdown 设定稿：',
    '```markdown',
    String(markdown),
    '```',
  ].filter((part) => part !== '').join('\n');
  return [
    { role: 'system', content: SYSTEM_PROMPT },
    { role: 'user', content: user },
  ];
}

/** 取第一个 `{` 到最后一个 `}`。模型爱在 JSON 前后加解释或代码围栏。 */
export function extractJson(text) {
  const raw = String(text || '');
  const start = raw.indexOf('{');
  const end = raw.lastIndexOf('}');
  if (start < 0 || end <= start) {
    throw new Error('模型没有返回 JSON 对象（找不到花括号）。可以再点一次，或换个模型试试。');
  }
  const body = raw.slice(start, end + 1);
  try {
    return JSON.parse(body);
  } catch (error) {
    throw new Error(`模型返回的 JSON 解析失败：${error.message}`);
  }
}

function text(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function list(value) {
  if (!Array.isArray(value)) return [];
  return value.map((item) => String(item == null ? '' : item).trim()).filter(Boolean);
}

function intOrNull(value) {
  const n = Number(value);
  return Number.isFinite(n) ? Math.trunc(n) : null;
}

/**
 * 校验并归一化模型产出。
 *
 * 返回 `{ title, parts, settings, notes, dropped }`：
 * - `parts` 只含**通过引擎必填校验**的部件，可直接喂给 `PUT /parts/<part>`
 * - `dropped` 记录被丢掉的部件与原因——必须显示给用户，静默丢弃等于骗人
 */
export function normalizeDraft(raw) {
  const dropped = [];
  const parts = {};
  const notes = list(raw && raw.notes);
  const title = text(raw && raw.title);

  const positioning = raw && raw.positioning;
  if (positioning && typeof positioning === 'object') {
    const genre = text(positioning.genre);
    if (!genre) dropped.push({ part: 'positioning', reason: '没解析出主类型（引擎必填）' });
    else {
      parts.positioning = {
        genre,
        audience: text(positioning.audience),
        core_premise: text(positioning.core_premise),
        selling_points: list(positioning.selling_points),
        tone_target: text(positioning.tone_target),
      };
    }
  }

  const volume = raw && raw.volume;
  if (volume && typeof volume === 'object') {
    const volumeTitle = text(volume.volume_title);
    if (!volumeTitle) dropped.push({ part: 'volume', reason: '没解析出卷名（引擎必填）' });
    else {
      parts.volume = {
        volume_title: volumeTitle,
        volume_goal: text(volume.volume_goal),
        main_conflict: text(volume.main_conflict),
        ending_hook: text(volume.ending_hook),
      };
    }
  }

  const protagonist = raw && raw.protagonist;
  if (protagonist && typeof protagonist === 'object') {
    const name = text(protagonist.name);
    if (!name) dropped.push({ part: 'protagonist', reason: '没解析出主角姓名（引擎必填）' });
    else {
      parts.protagonist = {
        name,
        background: text(protagonist.background),
        personality: text(protagonist.personality),
        desire: text(protagonist.desire),
        flaw: text(protagonist.flaw),
        signature_ability: text(protagonist.signature_ability),
      };
    }
  }

  const golden = raw && raw.golden_finger;
  if (golden && typeof golden === 'object') {
    const name = text(golden.name);
    const cost = text(golden.cost_limitation);
    if (!name) dropped.push({ part: 'golden_finger', reason: '没解析出金手指名称（引擎必填）' });
    else if (!cost) {
      dropped.push({ part: 'golden_finger', reason: '没解析出限制与代价（引擎必填，缺了会写成无敌流）' });
    } else {
      parts.golden_finger = {
        name,
        form: text(golden.form),
        ability: text(golden.ability),
        cost_limitation: cost,
        growth_path: text(golden.growth_path),
      };
    }
  }

  const rawChapters = Array.isArray(raw && raw.chapters) ? raw.chapters : [];
  const chapters = [];
  for (const item of rawChapters) {
    if (!item || typeof item !== 'object') continue;
    const chapterTitle = text(item.title);
    if (!chapterTitle) continue;
    const beats = [];
    for (const beat of Array.isArray(item.beats) ? item.beats : []) {
      if (!beat || typeof beat !== 'object') continue;
      const scene = text(beat.scene);
      const event = text(beat.event);
      if (!scene || !event) continue;
      if (beats.length >= BEAT_ORDER_MAX) break;
      const foreshadow = text(beat.plant_foreshadow);
      beats.push({
        order: beats.length + 1,
        scene,
        characters: list(beat.characters),
        triangle: list(beat.triangle),
        emotion: text(beat.emotion),
        event,
        plant_foreshadow: foreshadow || null,
      });
    }
    chapters.push({
      // 章号由位置决定：引擎要求 [order] == 1..N 连续，信模型给的章号迟早跳号。
      order: chapters.length + 1,
      title: chapterTitle,
      core_event: text(item.core_event),
      opening_hook: text(item.opening_hook),
      ending_hook: text(item.ending_hook),
      beats,
    });
    if (chapters.length >= CHAPTER_ORDER_MAX) break;
  }
  if (chapters.length > 0) parts.chapters = chapters;
  else if (Array.isArray(rawChapters) && rawChapters.length > 0) {
    dropped.push({ part: 'chapters', reason: '解析出的章节都缺标题（引擎必填）' });
  }

  const settings = [];
  for (const entry of Array.isArray(raw && raw.settings) ? raw.settings : []) {
    if (!entry || typeof entry !== 'object') continue;
    const entryType = text(entry.entry_type);
    const name = text(entry.name);
    const content = text(entry.content);
    if (!ENTRY_TYPES.includes(entryType) || !name || !content) continue;
    settings.push({
      entry_type: entryType,
      name,
      content,
      tags: list(entry.tags),
      related_chapters: (Array.isArray(entry.related_chapters) ? entry.related_chapters : [])
        .map(intOrNull)
        .filter((n) => n !== null && n >= 1),
    });
  }

  return { title, parts, settings, notes, dropped };
}

/**
 * 读 Markdown → 让模型拆 → 归一化。
 *
 * `complete` 是 `lib/bridge.js` 的 `createLlmBridge().complete`，测试里换成假函数
 * 就能把「提示词 → 解析 → 归一化」整条链路跑一遍而不用真模型。
 */
export async function importFromMarkdown({ complete, markdown, hints = {} }) {
  const body = String(markdown || '').trim();
  if (body.length < MIN_MARKDOWN_CHARS) {
    throw Object.assign(
      new Error(`设定稿太短了（${body.length} 字，至少 ${MIN_MARKDOWN_CHARS} 字）。太短拆不出设定，不如直接在表单里填。`),
      { status: 400, code: 'md-too-short' },
    );
  }
  if (body.length > MAX_MARKDOWN_CHARS) {
    throw Object.assign(
      new Error(`设定稿太长了（${body.length} 字，上限 ${MAX_MARKDOWN_CHARS} 字）。先删到主线相关部分再试。`),
      { status: 400, code: 'md-too-long' },
    );
  }
  const { text: answer } = await complete({
    messages: buildMessages(body, hints),
    // 桥只认 OpenAI 的 response_format，不认自定义的 jsonMode 简写。
    response_format: { type: 'json_object' },
    temperature: 0.2,
  });
  const parsed = extractJson(answer);
  const normalized = normalizeDraft(parsed);
  const partCount = Object.keys(normalized.parts).length;
  if (partCount === 0 && normalized.settings.length === 0) {
    throw Object.assign(
      new Error('模型没从这份稿子里拆出任何可用部件——多半是稿子不是设定（或模型没按 JSON 回）。原样再试一次，或换个模型。'),
      { status: 502, code: 'md-empty' },
    );
  }
  return normalized;
}
