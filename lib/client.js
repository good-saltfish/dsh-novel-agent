/**
 * 小说工作台插件（Client 半）。
 *
 * 骨架照抄 dsh-novel-shelf 与 dsh-office-scene 的写法，三条不能省：
 *   1) window.__ModuleLoader__.load({ id, factory(require) })；
 *   2) exports.inject 只填**真服务名**（slots），座位名不是服务名；
 *   3) slots.inject 的回调**必须 return 清理函数**，否则座位拿不到 occupant，
 *      右栏只显示「这类内容还没有可用的查看方式」。
 *
 * 另一个反复踩的坑：client 侧的 ctx 没有 ctx.inject 之外的 Host API，等服务要靠
 * ctx.inject(['sidebarRight','sidebarRightTabs'], cb)，并且**不能把
 * sidebarRightTabs 写进 exports.inject**（它不在客户端 Service 目录里，
 * 声明成硬依赖会让整个 client 半边加载不了）。
 */

window.__ModuleLoader__.load({
  id: 'dsh-novel-studio',
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' });

    const React = require('react');
    const h = React.createElement;

    const API = 'novel-studio/api';
    const NS = 'dshNovelStudio';
    const TAB_ID = 'dsh-novel-studio/studio';
    const TAB_KIND = 'dsh-novel-studio:studio';
    const TAB_TITLE = '小说工作台';

    /* ------------------------------------------------------------------ */
    /* 请求                                                                */
    /* ------------------------------------------------------------------ */

    /** 反代前缀下必须用去前导斜杠的相对路径，否则整条 404。 */
    function routeUrl(path) {
      return new URL(String(path).replace(/^\/+/, ''), new URL(document.baseURI, 'http://localhost'));
    }

    async function request(method, tail, body) {
      let res;
      try {
        res = await fetch(routeUrl(`${API}/${tail}`), {
          method,
          headers: body ? { 'content-type': 'application/json' } : undefined,
          body: body ? JSON.stringify(body) : undefined,
        });
      } catch (error) {
        // fetch 只有在网络层失败时才 reject（插件没加载、宿主重启中、被反代掐断）。
        throw new Error(`无法连接小说引擎：${String((error && error.message) || error)}`);
      }
      const text = await res.text();
      let parsed = null;
      try { parsed = text ? JSON.parse(text) : null; } catch { parsed = null; }
      if (!res.ok) {
        // 两种错误形状都要认：插件自有的 {ok:false,error:{code,message}}，
        // 和 ndecon 透传过来的 {"error":"项目不存在"}（error 是字符串）。
        const raw = parsed && parsed.error;
        const message = (raw && typeof raw === 'object' && raw.message)
          ? raw.message
          : (typeof raw === 'string' && raw ? raw : `HTTP ${res.status}`);
        throw new Error(message);
      }
      // 插件自有端点统一包一层 {ok,value}；透传的 ndecon 响应是裸 JSON。
      return parsed && parsed.ok === true && 'value' in parsed ? parsed.value : parsed;
    }

    /* ------------------------------------------------------------------ */
    /* 样式                                                                */
    /* ------------------------------------------------------------------ */

    const STYLE = `
.ns-root{display:flex;flex-direction:column;height:100%;min-height:0;font-size:12px;
  color:var(--dsw-alias-label-primary,#e6e9ef);}
.ns-head{display:flex;align-items:center;gap:6px;padding:6px 8px;
  border-bottom:1px solid var(--dsw-alias-border-l2,#2c323d);flex:none;}
.ns-title{font-weight:600;font-size:12.5px;}
.ns-grow{flex:1;}
.ns-body{flex:1;min-height:0;overflow:auto;padding:8px;}
.ns-btn{all:unset;cursor:pointer;padding:2px 8px;border-radius:6px;font-size:11px;
  border:1px solid var(--dsw-alias-border-l2,#39404d);color:var(--dsw-alias-label-secondary,#97a0b0);}
.ns-btn:hover{background:var(--dsw-alias-bg-l2,#232833);}
.ns-btn[disabled]{opacity:.45;cursor:default;}
.ns-item{padding:6px 8px;border-radius:6px;cursor:pointer;margin-bottom:4px;
  border:1px solid transparent;}
.ns-item:hover{background:var(--dsw-alias-bg-l2,#232833);}
.ns-item[data-active="1"]{border-color:var(--dsw-alias-border-l2,#39404d);
  background:var(--dsw-alias-bg-l2,#232833);}
.ns-item-title{font-weight:600;}
.ns-meta{color:var(--dsw-alias-label-secondary,#97a0b0);font-size:11px;margin-top:2px;}
.ns-sec{margin-bottom:10px;}
.ns-sec-title{font-weight:600;margin-bottom:4px;font-size:11.5px;
  color:var(--dsw-alias-label-secondary,#97a0b0);}
.ns-chip{display:inline-block;padding:1px 6px;border-radius:4px;font-size:10.5px;
  border:1px solid var(--dsw-alias-border-l2,#39404d);margin-right:4px;}
.ns-chip[data-state="human-confirmed"]{color:#7ddc9a;border-color:#2f6b45;}
.ns-chip[data-state="auto-accepted"]{color:#7db8dc;border-color:#2f5a6b;}
.ns-chip[data-state="draft"]{color:#dcb87d;border-color:#6b5a2f;}
.ns-warn{padding:6px 8px;border-radius:6px;margin-bottom:8px;font-size:11px;
  background:rgba(220,140,60,.12);border:1px solid rgba(220,140,60,.35);color:#e0b07d;}
.ns-err{padding:6px 8px;border-radius:6px;margin-bottom:8px;font-size:11px;
  background:rgba(220,80,80,.12);border:1px solid rgba(220,80,80,.35);color:#e08a8a;}
.ns-empty{color:var(--dsw-alias-label-secondary,#97a0b0);padding:12px 4px;text-align:center;}
.ns-pre{white-space:pre-wrap;word-break:break-word;line-height:1.7;font-size:12px;}
.ns-kv{display:flex;gap:6px;margin-bottom:2px;}
.ns-kv b{font-weight:600;flex:none;color:var(--dsw-alias-label-secondary,#97a0b0);}
.ns-code{font-family:ui-monospace,Consolas,monospace;font-size:10.5px;
  background:var(--dsw-alias-bg-l2,#232833);padding:1px 4px;border-radius:4px;}
.ns-scroll{max-height:240px;overflow:auto;}
.ns-dim{color:var(--dsw-alias-label-secondary,#97a0b0);}
.ns-form{padding:8px;border-radius:8px;margin-bottom:10px;
  background:var(--dsw-alias-bg-l2,#232833);
  border:1px solid var(--dsw-alias-border-l2,#39404d);}
.ns-form-row{display:flex;gap:8px;}
.ns-form-row > .ns-field{flex:1;min-width:0;}
.ns-field{margin-bottom:6px;}
.ns-field-label{font-size:10.5px;margin-bottom:2px;
  color:var(--dsw-alias-label-secondary,#97a0b0);}
.ns-input{box-sizing:border-box;width:100%;padding:3px 6px;border-radius:5px;
  font-size:11.5px;font-family:inherit;
  color:var(--dsw-alias-label-primary,#e6e9ef);
  background:var(--dsw-alias-bg-l1,#1a1e26);
  border:1px solid var(--dsw-alias-border-l2,#39404d);}
.ns-input:focus{outline:none;border-color:#4a6fa5;}
.ns-input[disabled]{opacity:.5;}
`;

    function installStyle() {
      if (typeof document === 'undefined') return;
      if (document.querySelector(`style[data-plugin-css=${JSON.stringify(NS)}]`)) return;
      const el = document.createElement('style');
      el.dataset.plugin = 'dsh-novel-studio';
      el.dataset.pluginCss = NS;
      el.textContent = STYLE;
      document.head.appendChild(el);
    }

    /* ------------------------------------------------------------------ */
    /* 小工具                                                              */
    /* ------------------------------------------------------------------ */

    const PART_LABEL = {
      positioning: '定位',
      volume: '卷纲',
      protagonist: '主角',
      golden_finger: '金手指',
      chapters: '细纲',
    };

    const STATE_LABEL = {
      'human-confirmed': '已人工确认',
      'auto-accepted': '已自动验收',
      draft: '模型候选',
    };

    function stateOf(project, part) {
      const state = project && project.confirmed_parts ? project.confirmed_parts[part] : null;
      return state || null;
    }

    function chapterOrders(project) {
      const manuscripts = (project && project.manuscripts) || {};
      return Object.values(manuscripts)
        .map((record) => record && record.order)
        .filter((order) => Number.isInteger(order))
        .sort((a, b) => a - b);
    }

    function outlineCount(project) {
      const chapters = project && project.draft && project.draft.chapters;
      return Array.isArray(chapters) ? chapters.length : 0;
    }

    /* ------------------------------------------------------------------ */
    /* 屏幕：项目列表 + 新建项目                                            */
    /* ------------------------------------------------------------------ */

    /** 新建项目表单。面板里必须能手动建，不能只让用户去命令行或找 AI 工具。 */
    function CreateForm({ onCreated, busy }) {
      const [open, setOpen] = React.useState(false);
      const [title, setTitle] = React.useState('');
      const [premise, setPremise] = React.useState('');
      const [genre, setGenre] = React.useState('');
      const [chapterCount, setChapterCount] = React.useState('30');
      const [provider, setProvider] = React.useState('fake');
      const [error, setError] = React.useState('');
      const [stage, setStage] = React.useState('');

      const reset = () => {
        setTitle(''); setPremise(''); setGenre('');
        setChapterCount('30'); setProvider('fake'); setError(''); setStage('');
      };

      const submit = async () => {
        setError('');
        const name = title.trim();
        if (!name) { setError('书名不能为空'); return; }
        const count = Number(chapterCount);
        if (!Number.isInteger(count) || count < 1 || count > 999) {
          setError('章数必须是 1–999 的整数'); return;
        }
        try {
          // 两步不能省：create 只建空项目，骨架必须再调 generate。
          setStage('创建项目…');
          const created = await request('POST', 'projects/create', {
            kind: 'creation', title: name, premise: premise.trim(), genre: genre.trim(),
          });
          const projectId = (created && created.meta && created.meta.id) || (created && created.id);
          if (!projectId) throw new Error('引擎没有返回 project_id');

          setStage(`生成 ${count} 章骨架…`);
          await request('POST', `projects/${encodeURIComponent(projectId)}/generate`, {
            provider, chapter_count: count,
          });

          // 不验收就全是 draft，后续每章都缺定位/主角/金手指。
          // 全部部件都没过判据时引擎回 422，那是「骨架生成了但不可用」，不是网络错误，
          // 要单独接住并把逐条原因带出去。
          setStage('验收骨架…');
          let rejected = [];
          try {
            const accepted = await request('POST', `projects/${encodeURIComponent(projectId)}/accept-skeleton`, {});
            rejected = (accepted && accepted.rejected) || [];
          } catch (e) {
            rejected = [{ part: '全部部件', reason: e.message }];
          }
          setStage('');
          reset();
          setOpen(false);
          onCreated(projectId, rejected);
        } catch (e) {
          setStage('');
          setError(e.message);
        }
      };

      if (!open) {
        return h('div', { style: { marginBottom: 8 } },
          h('button', {
            className: 'ns-btn', disabled: busy,
            onClick: () => { setOpen(true); },
          }, '＋ 新建项目'));
      }

      const field = (label, node) => h('div', { className: 'ns-field' },
        h('div', { className: 'ns-field-label' }, label), node);
      const input = (value, setValue, placeholder) => h('input', {
        className: 'ns-input',
        value,
        placeholder,
        onChange: (e) => setValue(e.target.value),
      });

      return h('div', { className: 'ns-form' },
        h('div', { className: 'ns-sec-title' }, '新建创作项目'),
        field('书名', input(title, setTitle, '必填')),
        field('一句话前提', input(premise, setPremise, '这本书讲什么（可留空）')),
        field('题材', input(genre, setGenre, '如 都市 / 玄幻（可留空）')),
        h('div', { className: 'ns-form-row' },
          field('细纲章数', input(chapterCount, setChapterCount, '1–999')),
          field('骨架来源', h('select', {
            className: 'ns-input', value: provider,
            onChange: (e) => setProvider(e.target.value),
          },
            h('option', { value: 'fake' }, '离线模板（免费、可复现）'),
            h('option', { value: 'ai' }, '已保存的 LLM 配置'),
          )),
        ),
        error ? h('div', { className: 'ns-err' }, error) : null,
        stage ? h('div', { className: 'ns-dim', style: { marginBottom: 6 } }, stage) : null,
        h('div', { style: { display: 'flex', gap: 6 } },
          h('button', { className: 'ns-btn', onClick: submit, disabled: busy || !!stage },
            stage ? '处理中…' : '创建'),
          h('button', {
            className: 'ns-btn',
            onClick: () => { reset(); setOpen(false); },
            disabled: !!stage,
          }, '取消'),
        ),
      );
    }

    function ProjectList({ onPick, onCreated, refreshKey, busy }) {
      const [projects, setProjects] = React.useState(null);
      const [error, setError] = React.useState('');

      const load = React.useCallback(() => {
        setError('');
        request('GET', 'projects')
          .then((list) => setProjects(Array.isArray(list) ? list : []))
          .catch((e) => { setProjects([]); setError(e.message); });
      }, []);

      React.useEffect(() => { load(); }, [load, refreshKey]);

      const form = h(CreateForm, {
        busy,
        onCreated: (projectId, rejected) => { load(); onCreated(projectId, rejected); },
      });

      if (projects === null) return h('div', null, form, h('div', { className: 'ns-empty' }, '加载中…'));

      return h('div', null,
        form,
        error ? h('div', { className: 'ns-err' }, error) : null,
        projects.length === 0
          ? h('div', { className: 'ns-empty' },
              h('div', null, '工作区里还没有项目。'),
              h('div', { className: 'ns-dim', style: { marginTop: 6 } },
                '点上面的「＋ 新建项目」即可建第一本。'))
          : projects.map((project) => {
              const meta = project.meta || project;
              const written = chapterOrders(project).length;
              const outline = outlineCount(project);
              return h('div', {
                key: meta.id,
                className: 'ns-item',
                onClick: () => { if (!busy) onPick(meta.id); },
              },
                h('div', { className: 'ns-item-title' }, meta.title || '(无题)'),
                h('div', { className: 'ns-meta' },
                  `${meta.id} · ${meta.kind || '?'} · 已写 ${written} 章`,
                  outline ? ` / 细纲 ${outline} 章` : ''),
              );
            }),
        h('div', { style: { marginTop: 8 } },
          h('button', { className: 'ns-btn', onClick: load, disabled: busy }, '刷新')),
      );
    }

    /* ------------------------------------------------------------------ */
    /* 屏幕：项目主页                                                       */
    /* ------------------------------------------------------------------ */

    function PartRow({ project, part }) {
      const state = stateOf(project, part);
      const draft = (project.draft || {})[part];
      const hasContent = Array.isArray(draft) ? draft.length > 0 : !!draft;
      let text = '未生成';
      if (hasContent) {
        if (part === 'chapters') text = `${draft.length} 章`;
        else if (part === 'positioning') text = draft.core_premise || draft.genre || '已生成';
        else if (part === 'protagonist') text = draft.name || '已生成';
        else if (part === 'volume') text = draft.volume_title || '已生成';
        else if (part === 'golden_finger') text = draft.name || '已生成';
      }
      return h('div', { className: 'ns-kv' },
        h('b', null, PART_LABEL[part] || part),
        h('span', { className: 'ns-chip', 'data-state': state || (hasContent ? 'draft' : '') },
          state ? STATE_LABEL[state] || state : hasContent ? '模型候选' : '未生成'),
        h('span', { className: 'ns-dim', style: { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, String(text)),
      );
    }

    function ProjectHome({ projectId, onBack, onOpenChapter, busy }) {
      const [project, setProject] = React.useState(null);
      const [error, setError] = React.useState('');

      React.useEffect(() => {
        let cancelled = false;
        request('GET', `projects/${encodeURIComponent(projectId)}`)
          .then((value) => { if (!cancelled) setProject(value); })
          .catch((e) => { if (!cancelled) setError(e.message); });
        return () => { cancelled = true; };
      }, [projectId]);

      if (error) return h('div', null, h('div', { className: 'ns-err' }, error));
      if (!project) return h('div', { className: 'ns-empty' }, '加载中…');

      const meta = project.meta || {};
      const orders = chapterOrders(project);
      const cursor = project.cursor || 0;
      const dropped = ['positioning', 'volume', 'protagonist', 'golden_finger']
        .filter((part) => {
          const state = stateOf(project, part);
          const usable = state === 'auto-accepted' || state === 'human-confirmed';
          const draft = (project.draft || {})[part];
          return !usable && !!draft;
        });

      return h('div', null,
        h('div', { className: 'ns-sec' },
          h('div', { className: 'ns-kv' }, h('b', null, '书名'), h('span', null, meta.title || '(无题)')),
          h('div', { className: 'ns-kv' }, h('b', null, '前提'), h('span', { className: 'ns-pre' }, project.premise || '（空）')),
          h('div', { className: 'ns-kv' }, h('b', null, '游标'), h('span', null, `已提交到第 ${cursor} 章`)),
        ),

        dropped.length > 0
          ? h('div', { className: 'ns-warn' },
              '以下部件有内容但状态不可用，不会注入后续章节的上下文：',
              h('div', { style: { marginTop: 4 } }, dropped.map((part) => PART_LABEL[part] || part).join('、')))
          : null,

        h('div', { className: 'ns-sec' },
          h('div', { className: 'ns-sec-title' }, '骨架部件'),
          ['positioning', 'volume', 'protagonist', 'golden_finger', 'chapters'].map((part) =>
            h(PartRow, { key: part, project, part }),
          ),
        ),

        h('div', { className: 'ns-sec' },
          h('div', { className: 'ns-sec-title' }, `已写章节（${orders.length}）`),
          orders.length === 0
            ? h('div', { className: 'ns-dim' }, '还没有已提交的正文。')
            : orders.map((order) => {
                const record = project.manuscripts[`ch${order}`] || {};
                const chars = recordChars(record);
                const time = recordTime(record);
                return h('div', {
                  key: order,
                  className: 'ns-item',
                  onClick: () => { if (!busy) onOpenChapter(projectId, order); },
                },
                  h('div', { className: 'ns-item-title' }, `第 ${order} 章${record.title ? ` · ${record.title}` : ''}`),
                  h('div', { className: 'ns-meta' },
                    [record.status || '?', chars !== null ? `${chars} 字` : null, time || null]
                      .filter(Boolean).join(' · ')),
                );
              }),
        ),
      );
    }

    /* ------------------------------------------------------------------ */
    /* 屏幕：章节详情                                                       */
    /* ------------------------------------------------------------------ */

    /** 章节记录的展示字段名对齐 ndecon 的 ManuscriptRecord：word_count / updated_at。 */
    function recordChars(record) {
      if (!record) return null;
      const value = record.word_count;
      return Number.isFinite(value) ? value : null;
    }

    function recordTime(record) {
      if (!record || !record.updated_at) return '';
      return String(record.updated_at).slice(0, 19).replace('T', ' ');
    }

    /** 细纲对象转成可读文本；直接把 Pydantic 结构 JSON.stringify 出来没法看。 */
    function outlineText(outline) {
      if (!outline || typeof outline !== 'object') return '';
      const lines = [];
      if (outline.title) lines.push(`标题：${outline.title}`);
      if (outline.core_event) lines.push(`核心事件：${outline.core_event}`);
      if (outline.opening_hook) lines.push(`开篇钩：${outline.opening_hook}`);
      if (outline.ending_hook) lines.push(`章尾钩：${outline.ending_hook}`);
      const beats = Array.isArray(outline.beats) ? outline.beats : [];
      if (beats.length > 0) {
        lines.push(`情节点（${beats.length}）：`);
        for (const beat of beats) {
          const head = [beat.kind, beat.order].filter((x) => x !== undefined && x !== null).join(' ');
          const body = [beat.content, beat.density ? `密度=${beat.density}` : '']
            .filter(Boolean).join(' ');
          lines.push(`  ${head ? `[${head}] ` : '· '}${body}`);
        }
      }
      return lines.join('\n');
    }

    function partText(part, value) {
      if (value === null || value === undefined) return '';
      if (part === 'chapter_outline') return outlineText(value);
      if (typeof value === 'string') return value;
      if (typeof value !== 'object') return String(value);
      const lines = [];
      for (const [key, item] of Object.entries(value)) {
        if (item === null || item === undefined || item === '') continue;
        if (Array.isArray(item)) {
          if (item.length === 0) continue;
          const flat = item.map((entry) => (typeof entry === 'object' ? JSON.stringify(entry) : String(entry)));
          lines.push(`${key}：${flat.join('；')}`);
        } else if (typeof item === 'object') {
          lines.push(`${key}：${JSON.stringify(item)}`);
        } else {
          lines.push(`${key}：${item}`);
        }
      }
      return lines.join('\n');
    }

    function ContextPackView({ projectId, order, onClose }) {
      const [pack, setPack] = React.useState(null);
      const [error, setError] = React.useState('');

      React.useEffect(() => {
        let cancelled = false;
        request('GET', `projects/${encodeURIComponent(projectId)}/chapters/${order}/context`)
          .then((value) => { if (!cancelled) setPack(value); })
          .catch((e) => { if (!cancelled) setError(e.message); });
        return () => { cancelled = true; };
      }, [projectId, order]);

      if (error) return h('div', null, h('div', { className: 'ns-err' }, error));
      if (!pack) return h('div', { className: 'ns-empty' }, '加载上下文包…');

      const blocks = [
        ['定位', pack.positioning],
        ['主角', pack.protagonist],
        ['金手指', pack.golden_finger],
        ['本章细纲', pack.chapter_outline],
      ];
      const dropped = Array.isArray(pack.dropped) ? pack.dropped : [];

      return h('div', null,
        h('div', { className: 'ns-sec' },
          h('div', { className: 'ns-kv' }, h('b', null, '索引文档'), h('span', null, String(pack.index_doc_count ?? 0), ' 条')),
          h('div', { className: 'ns-kv' }, h('b', null, '前章摘要'), h('span', null,
            pack.previous_summary_source === 'written' ? '已写章节摘要'
              : pack.previous_summary_source === 'outline' ? '退化：上一章细纲'
                : '无（首章）')),
        ),
        dropped.length > 0
          ? h('div', { className: 'ns-warn' },
              '这些部件因状态不可用而未注入：',
              h('div', { style: { marginTop: 4 } },
                dropped.map((item) => `${PART_LABEL[item.part] || item.part}（${STATE_LABEL[item.state] || item.state}）`).join('、')))
          : null,
        blocks.map(([label, value]) => h('div', { key: label, className: 'ns-sec' },
          h('div', { className: 'ns-sec-title' }, label),
          value
            ? h('div', { className: 'ns-pre ns-scroll' }, partText(label === '本章细纲' ? 'chapter_outline' : null, value))
            : h('div', { className: 'ns-dim' }, '（未注入）'),
        )),
        h('div', { className: 'ns-sec' },
          h('div', { className: 'ns-sec-title' }, `相关回顾（${(pack.retrieved || []).length}）`),
          (pack.retrieved || []).length === 0
            ? h('div', { className: 'ns-dim' }, '（无命中）')
            : (pack.retrieved || []).map((doc) => h('div', { key: doc.doc_id, className: 'ns-kv' },
                h('b', null, doc.doc_type),
                h('span', { className: 'ns-dim ns-scroll', style: { flex: 1 } }, doc.snippet),
              )),
        ),
        h('div', { className: 'ns-sec' },
          h('div', { className: 'ns-sec-title' }, `未回收伏笔（${(pack.open_foreshadows || []).length}）`),
          (pack.open_foreshadows || []).length === 0
            ? h('div', { className: 'ns-dim' }, '（无）')
            : (pack.open_foreshadows || []).map((item, index) => h('div', { key: index, className: 'ns-dim' },
                `· ${item.content || item.name || JSON.stringify(item)}`)),
        ),
        h('div', { style: { marginTop: 8 } },
          h('button', { className: 'ns-btn', onClick: onClose }, '关闭')),
      );
    }

    function ChapterView({ projectId, order, onBack, busy }) {
      const [chapter, setChapter] = React.useState(null);
      const [error, setError] = React.useState('');
      const [showPack, setShowPack] = React.useState(false);

      React.useEffect(() => {
        let cancelled = false;
        request('GET', `projects/${encodeURIComponent(projectId)}/chapters/${order}`)
          .then((value) => { if (!cancelled) setChapter(value); })
          .catch((e) => { if (!cancelled) setError(e.message); });
        return () => { cancelled = true; };
      }, [projectId, order]);

      if (error) return h('div', null, h('div', { className: 'ns-err' }, error));
      if (!chapter) return h('div', { className: 'ns-empty' }, '加载章节…');
      if (showPack) {
        return h(ContextPackView, { projectId, order, onClose: () => setShowPack(false) });
      }

      const record = chapter.record || {};
      const chars = recordChars(record);
      const time = recordTime(record);
      return h('div', null,
        h('div', { className: 'ns-sec' },
          h('div', { className: 'ns-kv' }, h('b', null, '状态'), h('span', null, record.status || '未生成')),
          chars !== null ? h('div', { className: 'ns-kv' }, h('b', null, '字数'), h('span', null, `${chars} 字`)) : null,
          time ? h('div', { className: 'ns-kv' }, h('b', null, '更新'), h('span', null, time)) : null,
          record.model_id ? h('div', { className: 'ns-kv' }, h('b', null, '产出'), h('span', null, record.model_id)) : null,
        ),
        h('div', { style: { marginBottom: 8, display: 'flex', gap: 6 } },
          h('button', { className: 'ns-btn', onClick: () => setShowPack(true), disabled: busy }, '看上下文包'),
          h('button', { className: 'ns-btn', onClick: onBack }, '返回'),
        ),
        chapter.content
          ? h('div', { className: 'ns-pre' }, chapter.content)
          : h('div', { className: 'ns-empty' }, '这一章还没有正文。'),
      );
    }

    /* ------------------------------------------------------------------ */
    /* 根组件                                                              */
    /* ------------------------------------------------------------------ */

    function StudioTab(props) {
      const [screen, setScreen] = React.useState({ name: 'list' });
      const [busy, setBusy] = React.useState(false);
      const [status, setStatus] = React.useState(null);
      const [note, setNote] = React.useState('');
      const [refreshKey, setRefreshKey] = React.useState(0);
      const sessionId = (props && props.sessionId) || 'studio';

      const loadStatus = React.useCallback(() => {
        request('GET', '_status')
          .then((value) => setStatus(value))
          .catch((e) => setStatus({ lastError: e.message }));
      }, []);

      React.useEffect(() => { loadStatus(); }, [loadStatus]);

      const wrap = (action) => async () => {
        setBusy(true);
        setNote('');
        try { await action(); } catch (e) { setNote(e.message); } finally { setBusy(false); }
      };

      const engine = status
        ? status.running
          ? `引擎 ${status.ndeconVersion || '?'} · 端口 ${status.port}`
          : `引擎未启动${status.lastError ? `：${status.lastError}` : ''}`
        : '引擎状态未知';

      let body;
      if (screen.name === 'project') {
        body = h(ProjectHome, {
          projectId: screen.projectId,
          busy,
          onBack: () => setScreen({ name: 'list' }),
          onOpenChapter: (projectId, order) => setScreen({ name: 'chapter', projectId, order }),
        });
      } else if (screen.name === 'chapter') {
        body = h(ChapterView, {
          projectId: screen.projectId,
          order: screen.order,
          busy,
          onBack: () => setScreen({ name: 'project', projectId: screen.projectId }),
        });
      } else {
        body = h(ProjectList, {
          busy,
          refreshKey,
          onPick: (projectId) => setScreen({ name: 'project', projectId }),
          onCreated: (projectId, rejected) => {
            if (rejected && rejected.length > 0) {
              // 部分部件没过判据：仍然进项目页，但先把原因摆出来。
              setNote(`骨架已生成，但有 ${rejected.length} 个部件没过验收：`
                + rejected.map((item) => `${PART_LABEL[item.part] || item.part}（${item.reason}）`).join('；'));
            }
            setScreen({ name: 'project', projectId });
          },
        });
      }

      return h('div', { className: 'ns-root' },
        h('div', { className: 'ns-head' },
          h('span', { className: 'ns-title' }, TAB_TITLE),
          h('span', { className: 'ns-grow' }),
          h('button', {
            className: 'ns-btn',
            onClick: wrap(async () => { loadStatus(); setRefreshKey((k) => k + 1); }),
            disabled: busy,
          }, '刷新'),
        ),
        h('div', { style: { padding: '4px 8px', fontSize: '10.5px' } , className: 'ns-dim' }, engine),
        note ? h('div', { style: { padding: '0 8px' } }, h('div', { className: 'ns-err' }, note)) : null,
        h('div', { className: 'ns-body' }, body),
      );
    }

    /* ------------------------------------------------------------------ */
    /* 入口按钮                                                            */
    /* ------------------------------------------------------------------ */

    function StudioEntry({ sidebar }) {
      return h('button', {
        type: 'button',
        'data-novel-studio-entry': true,
        title: '在右侧栏打开小说工作台',
        style: {
          all: 'unset',
          cursor: 'pointer',
          display: 'inline-flex',
          alignItems: 'center',
          padding: '2px 8px',
          borderRadius: '6px',
          fontSize: '11px',
          lineHeight: '1.5',
          color: 'var(--dsw-alias-label-secondary, #97a0b0)',
          border: '1px solid var(--dsw-alias-border-l2, #39404d)',
        },
        onClick: () => {
          try { sidebar?.openTab?.(TAB_KIND); } catch (error) {
            console.warn('[dsh-novel-studio] 打开右栏标签失败', error);
          }
        },
      }, '小说');
    }

    /* ------------------------------------------------------------------ */
    /* 注册                                                                */
    /* ------------------------------------------------------------------ */

    exports.name = 'dsh-novel-studio';
    exports.inject = ['slots'];

    // 测试入口：组件挂在闭包里，外面拿不到。宿主只读 inject/apply，不受影响。
    // 有它才能在没有浏览器的情况下把组件跑一遍——「不崩」这件事必须实测，
    // 不能靠看代码。
    exports.__testing = {
      CreateForm,
      ProjectList,
      ProjectHome,
      ContextPackView,
      ChapterView,
      StudioTab,
      StudioEntry,
      partText,
      outlineText,
      recordChars,
      recordTime,
      chapterOrders,
      outlineCount,
      stateOf,
    };

    exports.apply = function apply(ctx) {
      installStyle();
      try {
        ctx.inject(['sidebarRight', 'sidebarRightTabs'], (native) => {
          native.effect(() => native.sidebarRightTabs.register({
            id: TAB_ID,
            kind: TAB_KIND,
            title: () => TAB_TITLE,
          }));

          // 座位注册：inject 可选，这里不用——StudioTab 自己拉数据，
          // 不需要宿主预先把 sessionId 塞进来（多一层注入就多一处可能出错）。
          native.slots.inject('sidebar.right.pane.tab', () => native.slots.register(
            { name: 'sidebar.right.pane.tab', key: TAB_ID },
            StudioTab,
          ));

          // 没有入口按钮，tab 注册了也点不到。
          native.slots.inject('conversation.session.header.actions', () => native.slots.register(
            { name: 'conversation.session.header.actions', id: 'dsh-novel-studio-entry', order: 56 },
            () => h(StudioEntry, { sidebar: native.sidebarRight }),
          ));
        });
      } catch (error) {
        // 静默吞掉等于「插件没装」，一定要留日志。
        console.warn('[dsh-novel-studio] 右栏 tab 注册失败', error);
      }
    };

    return module.exports;
  },
});
