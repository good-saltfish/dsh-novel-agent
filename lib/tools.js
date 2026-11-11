/**
 * 小说工作台的工具面（暴露给模型）。
 *
 * 为什么用裸 JSON Schema 而不是 `defineTool`：本插件是被 `link:` 进来的裸目录，
 * 自己目录里没有 `node_modules`，`@deepseek-ai/dsh-tools` 从这里解析不到。
 * `tools.register()` 接受普通对象，只要带 `{ name, description, parameters,
 * output: { schema, render }, execute }`，且 `parameters` 必须是**已展开**的
 * JSON Schema（只支持 type/oneOf/properties/required/additionalProperties/
 * items/enum/const 加注解，不会帮你编译简写）。
 *
 * 铁律：工具只暴露「已经真的存在的能力」。ndecon 里没有的端点，这里一个都不加
 * —— 模型看到一个能调的工具就会调，调不通比看不到更糟。
 */

const str = (description) => ({ type: 'string', description });
const int = (description) => ({ type: 'integer', description });
const bool = (description) => ({ type: 'boolean', description });
const arr = (items, description) => ({ type: 'array', items, ...(description ? { description } : {}) });
const obj = (properties, required = [], description) => ({
  type: 'object',
  additionalProperties: false,
  properties,
  ...(required.length > 0 ? { required } : {}),
  ...(description ? { description } : {}),
});

const TEXT_OUT = {
  schema: obj({ text: str('给模型读的人话结果。') }, ['text']),
  render(_args, value) {
    return [{ type: 'text', text: String(value?.text ?? '') }];
  },
};

const say = (text) => ({ text });

/**
 * 骨架六件套的中文名。
 *
 * `CreationDraft`（`src/ndecon/creation/models.py:101-111`）只有这六个键，
 * 其中 `provenance` 是「哪一段由哪个模型产出」的账本，对用户没有意义，
 * 不列进部件清单。
 */
const PART_LABELS = {
  positioning: '定位',
  volume: '卷纲',
  chapters: '细纲',
  protagonist: '主角',
  golden_finger: '金手指',
};

/** 每本书至少要有这四件才能开写；细纲与卷纲缺了，章节事务会报缺部件。 */
const SCAFFOLD_REQUIRED = ['positioning', 'protagonist', 'golden_finger', 'chapters'];

/** 部件算不算「有」：对象看是否非空，数组看长度，字符串看 trim。 */
function isFilled(value) {
  if (value === null || value === undefined) return false;
  if (Array.isArray(value)) return value.length > 0;
  if (typeof value === 'string') return value.trim().length > 0;
  if (typeof value === 'object') return Object.keys(value).length > 0;
  return true;
}

/**
 * 把一个结构化部件（定位/主角/金手指）压成一行到两行的可读文本。
 *
 * 为什么不用 JSON.stringify：模型读一整坨字段名加引号反而更难抓重点，
 * 而且这些结构里真正有用的是前两三个值字段。
 */
function describeContextPart(label, part) {
  if (!isFilled(part)) return [`- ${label}：（空）`];
  if (typeof part === 'string') return [`- ${label}：${part.trim().slice(0, 120)}`];
  const values = Object.entries(part)
    .filter(([, value]) => isFilled(value))
    .map(([key, value]) => `${key}=${Array.isArray(value) ? value.join('/') : String(value)}`);
  return [`- ${label}：${values.join('；').slice(0, 200)}`];
}

/** 把 ndecon 的 `{...}` 或 `[{...}]` 渲染成紧凑文本，避免模型读整坨 JSON。 */
function summarizeProject(project) {
  const meta = project.meta ?? {};
  const manuscripts = project.manuscripts ?? {};
  const orders = Object.values(manuscripts)
    .map((record) => record.order)
    .filter((order) => Number.isInteger(order))
    .sort((a, b) => a - b);
  const written = orders.length;
  const cursor = project.cursor ?? 0;
  return [
    `- ${meta.id}「${meta.title ?? '(无题)'}」kind=${meta.kind ?? '?'}`,
    `  已写 ${written} 章${written ? `（第 ${orders[0]}–${orders[orders.length - 1]} 章）` : ''}` +
      `，游标 ${cursor}${cursor && cursor === orders[orders.length - 1] ? '（连续）' : ''}`,
    project.premise ? `  前提：${String(project.premise).slice(0, 60)}` : '',
  ].filter(Boolean).join('\n');
}

// 轮询节奏：一章真模型要 25-81 秒，3 秒一次足够快也不会把引擎打爆。
// 上限 2 小时：一本 300 章的书一次连写 4 小时是正常量级，但卡死不能无限等。
const BATCH_POLL_INTERVAL_MS = 3000;
const BATCH_POLL_TIMEOUT_MS = 2 * 60 * 60 * 1000;

export function registerNovelTools(tools, deps) {
  /**
   * 轮询一次连写任务直到它不再是 running。
   *
   * 为什么必须有：批量连写已经从同步端点改成后台任务（POST 回 202 + run_id）。
   * 不轮询就只能拿到「已接受」，工具调用方会以为一章都没写。
   */
  async function pollBatch(projectId, runId, expectedTotal) {
    const deadline = Date.now() + BATCH_POLL_TIMEOUT_MS;
    let last = null;
    while (Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, BATCH_POLL_INTERVAL_MS));
      last = await proxyCall(
        'GET',
        `projects/${encodeURIComponent(projectId)}/runs/${encodeURIComponent(runId)}`,
      );
      if (!last || last.status !== 'running') return last;
    }
    throw new Error(
      `连写任务 ${runId} 在 ${Math.round(BATCH_POLL_TIMEOUT_MS / 1000)} 秒内没跑完`
      + (last ? `（已写 ${last.written || 0}/${expectedTotal || '?'} 章，后台可能还在跑）` : ''),
    );
  }
  const { workspaceFor, proxyCall, runCli } = deps;
  const disposers = [];

  /** 统一把 ndecon 的错误体翻成一句话，别让模型猜 HTTP 码的含义。 */
  function explainError(error) {
    const message = String(error && error.message ? error.message : error);
    return message;
  }

  const definitions = [
    {
      name: 'novel_projects_list',
      description:
        '列出本地 .ndecon-workspace 里的所有小说项目（创作项目与参考书项目），带已写章数与游标。' +
        '调其它 novel_* 工具前先用它确认 project_id。',
      parameters: obj({}, []),
      output: TEXT_OUT,
      async execute() {
        try {
          const workspace = await workspaceFor();
          const list = await proxyCall('GET', 'projects');
          if (!Array.isArray(list) || list.length === 0) {
            return say(`工作区 ${workspace} 里还没有项目。用 novel_project_create 建一个创作项目。`);
          }
          const lines = list.map((project) => {
            const meta = project.meta ?? project;
            const manuscripts = project.manuscripts ?? {};
            const written = Object.keys(manuscripts).length;
            return `- ${meta.id}「${meta.title ?? '(无题)'}」kind=${meta.kind ?? '?'}，已写 ${written} 章`;
          });
          return say(`工作区 ${workspace}，共 ${list.length} 个项目：\n${lines.join('\n')}`);
        } catch (error) {
          throw new Error(`列项目失败：${explainError(error)}`);
        }
      },
    },

    {
      name: 'novel_project_create',
      description:
        '新建一个创作项目并立刻生成骨架（定位 / 主角 / 金手指 / 世界观 / 伏笔账本 / 章节蓝图）。' +
        'chapter_count 决定细纲章数，可到 999。返回 project_id 与骨架文件落点。',
      parameters: obj(
        {
          title: str('书名。'),
          premise: str('一句话前提（这本书讲什么）。'),
          genre: str('题材标签，例如 都市 / 玄幻 / 悬疑。'),
          chapter_count: int('细纲章数（1–999，默认 10）。'),
          provider: str('生成骨架用的 provider：fake（离线确定性，默认）或 ai。'),
          model: str('provider=ai 时可指定模型 id。'),
        },
        ['title', 'premise'],
      ),
      output: TEXT_OUT,
      async execute(args) {
        const title = String(args.title ?? '').trim();
        const premise = String(args.premise ?? '').trim();
        if (!title || !premise) throw new Error('title 与 premise 都必须非空');
        const chapterCount = Number.isInteger(args.chapter_count) ? args.chapter_count : 10;
        if (chapterCount < 1 || chapterCount > 999) throw new Error('chapter_count 必须在 1–999 之间');
        const provider = args.provider === 'ai' ? 'ai' : 'fake';

        try {
          // ndecon 的 create 端点只建空项目；骨架要靠 /generate 生成，两步不能省。
          const created = await proxyCall('POST', 'projects/create', {
            title,
            premise,
            genre: args.genre ?? '',
            kind: 'creation',
          });
          const projectId = created?.meta?.id ?? created?.id;
          if (!projectId) throw new Error('ndecon 未返回 project_id');
          const generated = await proxyCall('POST', `projects/${projectId}/generate`, {
            provider,
            model: args.model ?? null,
            chapter_count: chapterCount,
          });
          // /generate 返回的是整个 CreationProject（`server.py` 的 `_generate`
          // 末尾发的是 `project.model_dump()`），骨架在顶层键 `draft` 里，不是
          // `scaffold`/`parts`——早前读错键，结果永远是「未返回部件清单」。
          const draft = generated?.draft ?? null;
          const parts = draft && typeof draft === 'object'
            ? Object.entries(draft)
              .filter(([key, value]) => key !== 'provenance' && isFilled(value))
              .map(([key]) => PART_LABELS[key] ?? key)
            : [];
          const missing = SCAFFOLD_REQUIRED.filter((key) => !parts.includes(PART_LABELS[key]));
          return say(
            `已创建 ${projectId}「${title}」并生成骨架（${provider}）。\n` +
              `细纲 ${chapterCount} 章。\n` +
              (parts.length ? `骨架部件：${parts.join('、')}` : '骨架生成结果未返回部件清单。') +
              (parts.length && missing.length ? `\n还缺：${missing.join('、')}（可再生成一次或手动补）。` : ''),
          );
        } catch (error) {
          throw new Error(`建项目失败：${explainError(error)}`);
        }
      },
    },

    {
      name: 'novel_accept_skeleton',
      description:
        '把骨架里已生成但未确认的部件标成「已自动验收」，让它们能进入上下文包。' +
        '不调用它，所有部件都停在 draft，后续每一章都缺定位/主角/金手指。' +
        '判据是机械可查的：部件非空、细纲章号连续、主角有名字、金手指有能力与代价。',
      parameters: obj(
        {
          project_id: str('项目 id。'),
          parts: arr(str('部件名。'), '只验收指定部件（定位/卷纲/主角/金手指/细纲），省略则全部。'),
        },
        ['project_id'],
      ),
      output: TEXT_OUT,
      async execute(args) {
        const projectId = String(args.project_id ?? '').trim();
        if (!projectId) throw new Error('project_id 必须非空');
        try {
          const body = Array.isArray(args.parts) && args.parts.length > 0
            ? { parts: args.parts.map((p) => String(p)) }
            : {};
          const result = await proxyCall('POST', `projects/${projectId}/accept-skeleton`, body);
          const accepted = result?.accepted ?? [];
          const rejected = result?.rejected ?? [];
          const lines = [];
          lines.push(accepted.length > 0
            ? `已自动验收：${accepted.join('、')}`
            : '没有任何部件被验收（下面逐条说明原因）');
          for (const item of rejected) {
            lines.push(`  × ${item.part}：${item.reason}`);
          }
          return say(lines.join('\n'));
        } catch (error) {
          throw new Error(`验收骨架失败：${explainError(error)}`);
        }
      },
    },

    {
      name: 'novel_context_pack',
      description:
        '取某一章的上下文包（ContextPack）：五块内容 + 索引文档数 + 未回收伏笔 + 前章摘要。' +
        '这是写这一章之前模型唯一该读的东西；被闸门丢掉、未注入的部件会显式列出来。',
      parameters: obj(
        {
          project_id: str('项目 id（novel_projects_list 里拿）。'),
          order: int('第几章（1–999）。'),
        },
        ['project_id', 'order'],
      ),
      output: TEXT_OUT,
      async execute(args) {
        const projectId = String(args.project_id ?? '').trim();
        const order = Number(args.order);
        if (!projectId) throw new Error('project_id 必填');
        if (!Number.isInteger(order) || order < 1) throw new Error('order 必须是 ≥1 的整数');
        try {
          const pack = await proxyCall('GET', `projects/${projectId}/chapters/${order}/context`);
          // `ContextPack`（src/ndecon/retrieval/context.py:52）字段是平铺的，
          // 没有 `injected`/`blocks` 这层包装——早前按包装读，五块内容一条都不显示。
          // `dropped` 是服务端在 `_get_chapter_context` 里额外塞的（不在 ContextPack 里）。
          const dropped = pack?.dropped ?? null;
          const docs = pack?.index_doc_count ?? null;
          const target = pack?.target_chars ?? null;
          const lines = [`第 ${order} 章上下文包（${projectId}）：`];
          if (docs !== null) lines.push(`- 索引文档：${docs} 条`);
          if (target !== null) lines.push(`- 目标字数：${target} 字（与闸门口径一致）`);
          lines.push(...describeContextPart('定位', pack?.positioning));
          lines.push(...describeContextPart('主角', pack?.protagonist));
          lines.push(...describeContextPart('金手指', pack?.golden_finger));
          const outline = pack?.chapter_outline;
          if (outline) {
            lines.push(`- 本章细纲：${outline.title ?? '(无题)'}` +
              (outline.core_event ? `｜核心事件：${String(outline.core_event).slice(0, 80)}` : '') +
              (Array.isArray(outline.beats) && outline.beats.length ? `｜节拍 ${outline.beats.length} 个` : ''));
          }
          const summary = String(pack?.previous_summary ?? '');
          const source = String(pack?.previous_summary_source ?? '');
          const SOURCE_LABELS = { written: '已写章节摘要', outline: '上一章细纲退化', none: '首章无前文' };
          lines.push(
            `- 前情：${summary ? `${summary.slice(0, 120)}${summary.length > 120 ? '…' : ''}` : '（无）'}` +
              (source ? `（来源：${SOURCE_LABELS[source] ?? source}）` : ''),
          );
          const retrieved = Array.isArray(pack?.retrieved) ? pack.retrieved : [];
          lines.push(`- 检索命中：${retrieved.length} 条`);
          for (const hit of retrieved.slice(0, 5)) {
            lines.push(`  · ${hit?.doc_type ?? '?'}${hit?.title ? `｜${hit.title}` : ''}｜${String(hit?.snippet ?? '').slice(0, 60)}`);
          }
          const foreshadows = Array.isArray(pack?.open_foreshadows) ? pack.open_foreshadows : [];
          lines.push(`- 未回收伏笔：${foreshadows.length} 条`);
          for (const item of foreshadows.slice(0, 5)) {
            lines.push(`  · ${String(item?.content ?? item?.name ?? '?').slice(0, 60)}`);
          }
          const repairs = Array.isArray(pack?.repair_feedback) ? pack.repair_feedback : [];
          if (repairs.length) lines.push(`- 修复证据：${repairs.join('；').slice(0, 200)}`);
          if (Array.isArray(dropped) && dropped.length) {
            // 静默显示为空是最坏的：模型会以为本来就没有，然后自己编。
            lines.push(`- 未注入：${dropped.map((item) => (typeof item === 'string' ? item : item?.part ?? item?.name ?? '?')).join('、')}`);
          }
          return say(lines.join('\n'));
        } catch (error) {
          throw new Error(`取上下文包失败：${explainError(error)}`);
        }
      },
    },

    {
      name: 'novel_chapter_generate',
      description:
        '生成一章正文，走完整个章事务：拼上下文 → 写 → 过硬门 → 不通过就带证据重写（最多 2 次）' +
        '→ 通过才落库并写摘要与 run 记录。返回 verdict、尝试次数、字数、未过门规则与证据例句。',
      parameters: obj(
        {
          project_id: str('项目 id。'),
          order: int('第几章。'),
          provider: str('fake（离线确定性，默认）或 ai。'),
          model: str('provider=ai 时可指定模型 id。'),
          max_repairs: int('硬门不通过时的重写次数上限，默认 2。'),
        },
        ['project_id', 'order'],
      ),
      output: TEXT_OUT,
      async execute(args) {
        const projectId = String(args.project_id ?? '').trim();
        const order = Number(args.order);
        if (!projectId) throw new Error('project_id 必填');
        if (!Number.isInteger(order) || order < 1) throw new Error('order 必须是 ≥1 的整数');
        const provider = args.provider === 'ai' ? 'ai' : 'fake';
        const maxRepairs = Number.isInteger(args.max_repairs) ? args.max_repairs : 2;
        try {
          const cli = await runCli([
            'chapter', projectId, String(order),
            '--provider', provider,
            ...(args.model ? ['--model', String(args.model)] : []),
            '--max-repairs', String(maxRepairs),
            '--workspace', await workspaceFor(),
          ]);
          const output = `${cli.stdout || ''}${cli.stderr || ''}`.trim();
          if (!cli.ok) {
            throw new Error(`章事务未成功（退出码 ${cli.code}）：\n${output.slice(-1200)}`);
          }
          return say(output);
        } catch (error) {
          throw new Error(`生成第 ${order} 章失败：${explainError(error)}`);
        }
      },
    },

    {
      name: 'novel_chapters_run',
      description:
        '连写多章：逐章走章事务，每章都过硬门，进度落 project.cursor，遇到第一处失败就停下。' +
        '不传 from 时从游标之后接着写。返回每章的 status/verdict/尝试次数/字数。',
      parameters: obj(
        {
          project_id: str('项目 id。'),
          from: int('起始章号；省略则从游标之后开始。'),
          to: int('结束章号；省略则写到细纲最后一章。'),
          provider: str('fake（离线确定性，默认）或 ai。'),
          auto_accept: bool('true（默认）过闸门即入库；false 只落 draft 等人确认。'),
          max_repairs: int('每章重写次数上限，默认 2。'),
        },
        ['project_id'],
      ),
      output: TEXT_OUT,
      async execute(args) {
        const projectId = String(args.project_id ?? '').trim();
        if (!projectId) throw new Error('project_id 必填');
        const provider = args.provider === 'ai' ? 'ai' : 'fake';
        const body = { provider };
        if (Number.isInteger(args.from)) body.from = args.from;
        if (Number.isInteger(args.to)) body.to = args.to;
        if (typeof args.auto_accept === 'boolean') body.auto_accept = args.auto_accept;
        if (Number.isInteger(args.max_repairs)) body.max_repairs = args.max_repairs;
        try {
          // 后端回 202 + run_id，活儿在后台跑：同步等它跑完会撞插件的 300 秒
          // 硬超时（实测 10 章真模型要 373 秒），于是工具报失败而其实全写完了。
          const started = await proxyCall('POST', `projects/${encodeURIComponent(projectId)}/runs`, body);
          if (!started || !started.run_id) throw new Error('引擎没有返回 run_id，无法跟踪进度');
          const result = await pollBatch(projectId, started.run_id, started.total);
          const chapters = result.chapters || [];
          const lines = [
            `run ${result.run_id}：第 ${result.from}–${result.to} 章，写入 ${result.written} 章，失败 ${result.failures} 章`,
          ];
          for (const item of chapters) {
            const head = `- 第 ${item.order} 章：${item.status}`;
            const detail = [
              item.verdict ? `verdict=${item.verdict}` : '',
              item.attempts ? `尝试 ${item.attempts} 次` : '',
              item.cjk_chars ? `${item.cjk_chars} 字` : '',
              item.summary_present === false ? '缺摘要' : '',
            ].filter(Boolean).join('，');
            lines.push(`${head}${detail ? `（${detail}）` : ''}`);
            for (const failure of (item.hard_failures || [])) {
              const rule = typeof failure === 'string' ? failure : (failure.rule || failure.gate || '?');
              const why = typeof failure === 'object' && failure.detail ? `：${failure.detail}` : '';
              lines.push(`    未过门 ${rule}${why}`);
            }
            if (item.error) lines.push(`    错误：${item.error}`);
          }
          if (result.failures > 0) {
            lines.push('已在第一处失败处停下——连续失败通常是系统性问题，硬写会把整本写坏。');
          }
          return say(lines.join('\n'));
        } catch (error) {
          throw new Error(`连写失败：${explainError(error)}`);
        }
      },
    },

    {
      name: 'novel_chapter_check',
      description: '只看一章的指纹检查结果（AI 味规则逐条实测值），不改写、不落库。',
      parameters: obj(
        {
          project_id: str('项目 id。'),
          order: int('第几章。'),
        },
        ['project_id', 'order'],
      ),
      output: TEXT_OUT,
      async execute(args) {
        const projectId = String(args.project_id ?? '').trim();
        const order = Number(args.order);
        if (!projectId) throw new Error('project_id 必填');
        if (!Number.isInteger(order) || order < 1) throw new Error('order 必须是 ≥1 的整数');
        try {
          const report = await proxyCall(
            'GET',
            `projects/${encodeURIComponent(projectId)}/chapters/${order}/lint`,
          );
          const findings = report.findings || [];
          const lines = [
            `规则版本 ${report.version ?? '?'}：${report.passed ? '全部在阈值内' : '有规则越界'}`,
            `字数 ${report.cjk_chars ?? '?'}，段落 ${report.paragraph_count ?? '?'}`,
          ];
          for (const item of findings) {
            const flag = item.passed === false ? '✗' : '✓';
            lines.push(`- ${flag} ${item.label || item.rule}：${item.value} / 阈值 ${item.limit}`
              + (item.detail ? `（${item.detail}）` : ''));
          }
          if (findings.length === 0) lines.push('- 没有命中任何规则');
          return say(lines.join('\n'));
        } catch (error) {
          throw new Error(`检查第 ${order} 章失败：${explainError(error)}`);
        }
      },
    },
  ];

  for (const definition of definitions) {
    if (!tools || typeof tools.register !== 'function') {
      throw new Error('tools 服务没有 register 方法');
    }
    disposers.push(tools.register(definition));
  }

  return () => {
    for (const dispose of disposers.splice(0)) {
      try { dispose(); } catch { /* 已注销 */ }
    }
  };
}

export const NOVEL_TOOL_NAMES = [
  'novel_projects_list',
  'novel_project_create',
  'novel_accept_skeleton',
  'novel_context_pack',
  'novel_chapter_generate',
  'novel_chapters_run',
  'novel_chapter_check',
];
