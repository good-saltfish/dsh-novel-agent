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
  color:var(--dsw-alias-label-primary,#e6e9ef);
  background:
    radial-gradient(1200px 400px at 20% -10%, rgba(90,130,220,.10), transparent 60%),
    radial-gradient(900px 300px at 100% 0%, rgba(120,90,200,.08), transparent 55%);
  }
.ns-head{display:flex;align-items:center;gap:6px;padding:8px 10px;
  border-bottom:1px solid var(--dsw-alias-border-l2,#2c323d);flex:none;
  background:linear-gradient(180deg, rgba(255,255,255,.035), rgba(255,255,255,0));
  backdrop-filter:blur(6px);}
.ns-title{font-weight:650;font-size:13px;letter-spacing:.02em;}
.ns-grow{flex:1;}
.ns-body{flex:1;min-height:0;overflow:auto;padding:10px;}

/* 按钮：有厚度，按下真的会陷下去 */
.ns-btn{all:unset;cursor:pointer;padding:4px 10px;border-radius:8px;font-size:11px;
  color:var(--dsw-alias-label-secondary,#aab3c2);
  background:linear-gradient(180deg,#2b3240,#232935);
  border:1px solid #3a4250;
  box-shadow:0 1px 0 rgba(255,255,255,.06) inset, 0 2px 4px rgba(0,0,0,.28);
  transition:transform .08s ease, box-shadow .12s ease, filter .12s ease;}
.ns-btn:hover{filter:brightness(1.12);}
.ns-btn:active{transform:translateY(1px);
  box-shadow:0 1px 2px rgba(0,0,0,.3) inset;}
.ns-btn[disabled]{opacity:.42;cursor:default;box-shadow:none;transform:none;}
.ns-btn[data-variant="primary"]{color:#eaf1ff;border-color:#3f6ea8;
  background:linear-gradient(180deg,#3f74b4,#2c5791);
  box-shadow:0 1px 0 rgba(255,255,255,.16) inset, 0 3px 10px rgba(50,110,190,.28);}
.ns-btn[data-variant="ghost"]{background:transparent;border-color:#333a47;box-shadow:none;}

/* 卡片：抬起来 */
.ns-card{border-radius:10px;padding:10px;margin-bottom:10px;
  background:linear-gradient(180deg, rgba(255,255,255,.045), rgba(255,255,255,.012));
  border:1px solid var(--dsw-alias-border-l2,#333a47);
  box-shadow:0 1px 0 rgba(255,255,255,.05) inset, 0 6px 16px rgba(0,0,0,.22);}
.ns-item{padding:8px 10px;border-radius:9px;cursor:pointer;margin-bottom:6px;
  border:1px solid #333a47;
  background:linear-gradient(180deg, rgba(255,255,255,.04), rgba(255,255,255,.01));
  box-shadow:0 2px 6px rgba(0,0,0,.18);
  transition:transform .1s ease, box-shadow .12s ease, border-color .12s ease;}
.ns-item:hover{transform:translateY(-1px);border-color:#4a6fa5;
  box-shadow:0 6px 18px rgba(0,0,0,.3), 0 0 0 1px rgba(90,140,220,.18);}
.ns-item[data-active="1"]{border-color:#4a6fa5;
  background:linear-gradient(180deg, rgba(90,140,220,.16), rgba(90,140,220,.05));}
.ns-item-title{font-weight:620;}
.ns-meta{color:var(--dsw-alias-label-secondary,#97a0b0);font-size:11px;margin-top:3px;}
.ns-sec{margin-bottom:12px;}
.ns-sec-title{font-weight:620;margin-bottom:6px;font-size:11px;letter-spacing:.04em;
  text-transform:uppercase;color:#8b95a7;}
.ns-chip{display:inline-block;padding:2px 8px;border-radius:999px;font-size:10.5px;
  border:1px solid #3a4250;margin-right:5px;background:rgba(255,255,255,.03);}
.ns-chip[data-state="human-confirmed"]{color:#8ee6a8;border-color:#2f6b45;
  background:rgba(80,200,120,.10);}
.ns-chip[data-state="auto-accepted"]{color:#8fc6e8;border-color:#2f5a6b;
  background:rgba(90,170,220,.10);}
.ns-chip[data-state="draft"]{color:#e0bf86;border-color:#6b5a2f;
  background:rgba(220,170,80,.10);}
.ns-warn{padding:8px 10px;border-radius:9px;margin-bottom:10px;font-size:11px;
  background:linear-gradient(180deg, rgba(220,140,60,.16), rgba(220,140,60,.08));
  border:1px solid rgba(220,140,60,.42);color:#e8b884;}
.ns-err{padding:8px 10px;border-radius:9px;margin-bottom:10px;font-size:11px;
  background:linear-gradient(180deg, rgba(220,80,80,.16), rgba(220,80,80,.08));
  border:1px solid rgba(220,80,80,.42);color:#e89696;}
.ns-empty{color:#97a0b0;padding:18px 8px;text-align:center;}
.ns-pre{white-space:pre-wrap;word-break:break-word;line-height:1.75;font-size:12px;}
.ns-kv{display:flex;gap:8px;margin-bottom:3px;}
.ns-kv b{font-weight:620;flex:none;min-width:52px;color:#8b95a7;}
.ns-code{font-family:ui-monospace,Consolas,monospace;font-size:10.5px;
  background:rgba(255,255,255,.05);padding:1px 5px;border-radius:5px;border:1px solid #333a47;}
.ns-scroll{max-height:260px;overflow:auto;padding-right:2px;}
.ns-dim{color:#8b95a7;}

/* 分段控件：三屏导航 */
.ns-tabs{display:flex;gap:2px;padding:2px;border-radius:9px;margin-bottom:10px;
  background:rgba(0,0,0,.22);border:1px solid #333a47;}
.ns-tab{all:unset;cursor:pointer;flex:1;text-align:center;padding:5px 8px;
  border-radius:7px;font-size:11px;color:#97a0b0;transition:all .12s ease;}
.ns-tab[data-active="1"]{color:#eaf1ff;
  background:linear-gradient(180deg,#3f74b4,#2c5791);
  box-shadow:0 2px 6px rgba(50,110,190,.32);}
.ns-tab:hover:not([data-active="1"]){color:#c7cfdc;}

.ns-form{padding:10px;border-radius:10px;margin-bottom:12px;
  background:linear-gradient(180deg, rgba(255,255,255,.05), rgba(255,255,255,.015));
  border:1px solid #39404d;
  box-shadow:0 1px 0 rgba(255,255,255,.05) inset, 0 6px 16px rgba(0,0,0,.22);}
.ns-form-row{display:flex;gap:8px;}
.ns-form-row > .ns-field{flex:1;min-width:0;}
.ns-field{margin-bottom:8px;}
.ns-field-label{font-size:10.5px;margin-bottom:3px;color:#8b95a7;letter-spacing:.02em;}
.ns-input{box-sizing:border-box;width:100%;padding:5px 8px;border-radius:7px;
  font-size:11.5px;font-family:inherit;
  color:var(--dsw-alias-label-primary,#e6e9ef);
  background:linear-gradient(180deg,#191d25,#1e232c);
  border:1px solid #39404d;
  box-shadow:0 1px 2px rgba(0,0,0,.25) inset;
  transition:border-color .12s ease, box-shadow .12s ease;}
.ns-input:focus{outline:none;border-color:#4a6fa5;
  box-shadow:0 0 0 3px rgba(74,111,165,.18);}
.ns-input[disabled]{opacity:.5;}

/* 模型页 */
.ns-model-row{display:flex;align-items:center;gap:8px;margin-bottom:6px;}
.ns-model-row .ns-input{flex:1;}
.ns-badge{font-size:10px;padding:1px 6px;border-radius:999px;
  border:1px solid #3a4250;color:#97a0b0;}
.ns-badge[data-tone="ok"]{color:#8ee6a8;border-color:#2f6b45;background:rgba(80,200,120,.10);}
.ns-badge[data-tone="bad"]{color:#e89696;border-color:#6b3232;background:rgba(200,80,80,.10);}

/* 操作区：按钮一行排开，换行不换高 */
.ns-actions{display:flex;flex-wrap:wrap;gap:5px;margin-bottom:10px;}
.ns-textarea{min-height:220px;resize:vertical;line-height:1.7;font-family:inherit;}
.ns-version{display:flex;align-items:center;justify-content:space-between;gap:8px;
  cursor:default;font-family:ui-monospace,Consolas,monospace;font-size:11px;}
.ns-version:hover{transform:none;}
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

    function ProjectHome({ projectId, onBack, onOpenChapter, busy, onChanged }) {
      const [project, setProject] = React.useState(null);
      const [error, setError] = React.useState('');
      const [note, setNote] = React.useState('');
      const [working, setWorking] = React.useState('');
      const [from, setFrom] = React.useState('');
      const [to, setTo] = React.useState('');
      const [autoAccept, setAutoAccept] = React.useState(true);

      const load = React.useCallback(() => {
        setError('');
        request('GET', `projects/${encodeURIComponent(projectId)}`)
          .then((value) => { setProject(value); })
          .catch((e) => { setError(e.message); });
      }, [projectId]);

      React.useEffect(() => { load(); }, [load]);

      if (error) {
        return h('div', null,
          h('div', { className: 'ns-err' }, error),
          h('div', { style: { marginTop: 8 } }, h('button', { className: 'ns-btn', onClick: onBack }, '返回')),
        );
      }
      if (!project) return h('div', { className: 'ns-empty' }, '加载中…');

      const meta = project.meta || {};
      const orders = chapterOrders(project);
      const cursor = project.cursor || 0;
      const total = outlineCount(project);
      const dropped = ['positioning', 'volume', 'protagonist', 'golden_finger']
        .filter((part) => {
          const state = stateOf(project, part);
          const usable = state === 'auto-accepted' || state === 'human-confirmed';
          const draft = (project.draft || {})[part];
          return !usable && !!draft;
        });

      const locked = busy || !!working;

      // 连写的默认区间是「游标之后」：用户最常做的是接着往下写，
      // 而不是从头重写一遍已经写过的章。
      const startValue = from === '' ? (cursor + 1) : Number(from);
      const endValue = to === '' ? Math.min(total, cursor + 10) : Number(to);

      const runBatch = async () => {
        setWorking('连写');
        setNote('');
        setError('');
        try {
          if (!Number.isInteger(startValue) || !Number.isInteger(endValue) || startValue < 1) {
            throw new Error('章号区间必须是正整数');
          }
          const body = await request('POST', `projects/${encodeURIComponent(projectId)}/runs`, {
            from: startValue,
            to: endValue,
            provider: 'fake',
            auto_accept: autoAccept,
          });
          const failed = (body.chapters || []).filter((ch) => ch.status !== 'committed');
          setNote(`写了 ${body.written} 章${body.failures ? `，失败 ${body.failures} 章` : ''}`
            + (failed.length > 0 ? `：${failed.map((ch) => `第 ${ch.order} 章 ${ch.verdict || ch.status}`).join('；')}` : ''));
          load();
          if (onChanged) onChanged();
        } catch (e) { setError(e.message); } finally { setWorking(''); }
      };

      return h('div', null,
        h('div', { className: 'ns-sec' },
          h('div', { className: 'ns-kv' }, h('b', null, '书名'), h('span', null, meta.title || '(无题)')),
          h('div', { className: 'ns-kv' }, h('b', null, '前提'), h('span', { className: 'ns-pre' }, project.premise || '（空）')),
          h('div', { className: 'ns-kv' }, h('b', null, '游标'), h('span', null, `已提交到第 ${cursor} 章 / 细纲 ${total} 章`)),
        ),

        dropped.length > 0
          ? h('div', { className: 'ns-warn' },
              '以下部件有内容但状态不可用，不会注入后续章节的上下文：',
              h('div', { style: { marginTop: 4 } }, dropped.map((part) => PART_LABEL[part] || part).join('、')))
          : null,

        h('div', { className: 'ns-card' },
          h('div', { className: 'ns-sec-title' }, '连写'),
          h('div', { className: 'ns-form-row' },
            h('div', { className: 'ns-field' },
              h('div', { className: 'ns-field-label' }, '从第几章'),
              h('input', {
                className: 'ns-input',
                value: from,
                placeholder: String(cursor + 1),
                disabled: locked,
                onChange: (event) => setFrom(event.target.value),
              }),
            ),
            h('div', { className: 'ns-field' },
              h('div', { className: 'ns-field-label' }, '到第几章'),
              h('input', {
                className: 'ns-input',
                value: to,
                placeholder: String(Math.min(total, cursor + 10)),
                disabled: locked,
                onChange: (event) => setTo(event.target.value),
              }),
            ),
          ),
          h('div', { className: 'ns-field' },
            h('div', { className: 'ns-field-label' }, '落库方式'),
            h('select', {
              className: 'ns-input',
              value: autoAccept ? 'auto' : 'draft',
              disabled: locked,
              onChange: (event) => setAutoAccept(event.target.value === 'auto'),
            },
              h('option', { value: 'auto' }, '过闸门即入库（auto-accepted）'),
              h('option', { value: 'draft' }, '过闸门也只落草稿（逐章确认）'),
            ),
          ),
          h('div', { className: 'ns-meta' },
            `本次将写第 ${startValue}–${endValue} 章。每章都走章事务：过硬门才落盘，过不了就回滚并记台账。`),
          h('div', { style: { marginTop: 6 } },
            h('button', { className: 'ns-btn', 'data-variant': 'primary', onClick: runBatch, disabled: locked },
              working === '连写' ? '连写中…' : `连写第 ${startValue}–${endValue} 章`),
          ),
          note ? h('div', { className: 'ns-warn' }, note) : null,
        ),

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

    /**
     * 章节详情：看、生成、改、确认、查版本、看台账。
     *
     * 两条生成路径必须分开摆：
     * - 「生成」走 /run（章事务）：过硬门才落盘，过不了就回滚，台账有记录。
     * - 「只产候选」走 /generate：不闸门、落 draft，用来快速看一眼模型会写什么。
     * 合并成一个按钮会让用户以为「生成了就是写好了」——这是最贵的一种误解。
     */
    function ChapterView({ projectId, order, onBack, busy }) {
      const [chapter, setChapter] = React.useState(null);
      const [error, setError] = React.useState('');
      const [note, setNote] = React.useState('');
      const [showPack, setShowPack] = React.useState(false);
      const [editing, setEditing] = React.useState(false);
      const [draftText, setDraftText] = React.useState('');
      const [versions, setVersions] = React.useState(null);
      const [runs, setRuns] = React.useState(null);
      const [lint, setLint] = React.useState(null);
      const [working, setWorking] = React.useState('');

      const load = React.useCallback(() => {
        setError('');
        request('GET', `projects/${encodeURIComponent(projectId)}/chapters/${order}`)
          .then((value) => {
            setChapter(value);
            setDraftText((value && value.content) || '');
          })
          .catch((e) => setError(e.message));
      }, [projectId, order]);

      React.useEffect(() => { load(); }, [load]);

      const act = async (label, fn) => {
        setWorking(label);
        setNote('');
        setError('');
        try { await fn(); } catch (e) { setError(e.message); } finally { setWorking(''); }
      };

      if (error) {
        return h('div', null,
          h('div', { className: 'ns-err' }, error),
          h('div', { style: { marginTop: 8 } },
            h('button', { className: 'ns-btn', onClick: onBack }, '返回')),
        );
      }
      if (!chapter) return h('div', { className: 'ns-empty' }, '加载章节…');
      if (showPack) {
        return h(ContextPackView, { projectId, order, onClose: () => setShowPack(false) });
      }

      const record = chapter.record || {};
      const chars = recordChars(record);
      const time = recordTime(record);
      const locked = busy || !!working;

      const generate = () => act('生成', async () => {
        const body = await request('POST', `projects/${encodeURIComponent(projectId)}/chapters/${order}/run`, { provider: 'fake' });
        const outcome = body.outcome || {};
        setNote(outcome.status === 'committed'
          ? `已提交：${outcome.verdict}，${outcome.cjk_chars} 字，尝试 ${outcome.attempts} 次`
          : `没过闸门（${outcome.verdict}）：正文未落盘，可看台账里的证据`);
        load();
      });

      const generateDraft = () => act('候选', async () => {
        await request('POST', `projects/${encodeURIComponent(projectId)}/chapters/${order}/generate`, { provider: 'fake' });
        setNote('已产出候选正文（未过闸门，状态 draft，确认后才会成为可用稿）');
        load();
      });

      const confirm = () => act('确认', async () => {
        await request('POST', `projects/${encodeURIComponent(projectId)}/chapters/${order}/confirm`);
        setNote('已人工确认');
        load();
      });

      const save = () => act('保存', async () => {
        await request('PUT', `projects/${encodeURIComponent(projectId)}/chapters/${order}`, { content: draftText });
        setEditing(false);
        setNote('已保存（人工编辑，状态 draft）');
        load();
      });

      const check = () => act('检查', async () => {
        const value = await request('GET', `projects/${encodeURIComponent(projectId)}/chapters/${order}/lint`);
        setLint(value);
      });

      const loadVersions = () => act('版本', async () => {
        const value = await request('GET', `projects/${encodeURIComponent(projectId)}/chapters/${order}/versions`);
        setVersions(value);
      });

      const loadRuns = () => act('台账', async () => {
        const value = await request('GET', `projects/${encodeURIComponent(projectId)}/runs`);
        setRuns(value);
      });

      const restore = (stamp) => act('回退', async () => {
        const value = await request('POST', `projects/${encodeURIComponent(projectId)}/chapters/${order}/restore`, { stamp });
        setChapter(value);
        setDraftText((value && value.content) || '');
        setNote(`已回退到 ${stamp}（当前稿已存档，可再回退撤销）`);
        setVersions(null);
      });

      return h('div', null,
        h('div', { className: 'ns-sec' },
          h('div', { className: 'ns-kv' }, h('b', null, '状态'), h('span', null, record.status || '未生成')),
          chars !== null ? h('div', { className: 'ns-kv' }, h('b', null, '字数'), h('span', null, `${chars} 字`)) : null,
          time ? h('div', { className: 'ns-kv' }, h('b', null, '更新'), h('span', null, time)) : null,
          record.model_id ? h('div', { className: 'ns-kv' }, h('b', null, '产出'), h('span', null, record.model_id)) : null,
        ),
        h('div', { className: 'ns-actions' },
          h('button', { className: 'ns-btn', 'data-variant': 'primary', onClick: generate, disabled: locked },
            working === '生成' ? '生成中…' : '生成（过闸门）'),
          h('button', { className: 'ns-btn', onClick: generateDraft, disabled: locked },
            working === '候选' ? '产出中…' : '只产候选'),
          record.status && record.status !== 'user-confirmed'
            ? h('button', { className: 'ns-btn', onClick: confirm, disabled: locked }, '确认')
            : null,
          h('button', { className: 'ns-btn', 'data-variant': 'ghost', onClick: () => setShowPack(true), disabled: locked }, '上下文包'),
          h('button', { className: 'ns-btn', 'data-variant': 'ghost', onClick: check, disabled: locked }, '检查'),
          h('button', { className: 'ns-btn', 'data-variant': 'ghost', onClick: loadVersions, disabled: locked }, '版本'),
          h('button', { className: 'ns-btn', 'data-variant': 'ghost', onClick: loadRuns, disabled: locked }, '台账'),
          h('button', { className: 'ns-btn', 'data-variant': 'ghost', onClick: () => setEditing(!editing), disabled: locked },
            editing ? '取消编辑' : '编辑'),
          h('button', { className: 'ns-btn', 'data-variant': 'ghost', onClick: onBack }, '返回'),
        ),
        note ? h('div', { className: 'ns-warn' }, note) : null,

        editing
          ? h('div', { className: 'ns-card' },
            h('div', { className: 'ns-sec-title' }, '编辑正文'),
            h('textarea', {
              className: 'ns-input ns-textarea',
              value: draftText,
              onChange: (event) => setDraftText(event.target.value),
            }),
            h('div', { style: { marginTop: 6, display: 'flex', gap: 6 } },
              h('button', { className: 'ns-btn', 'data-variant': 'primary', onClick: save, disabled: locked },
                working === '保存' ? '保存中…' : '保存'),
              h('button', { className: 'ns-btn', 'data-variant': 'ghost', onClick: () => setEditing(false) }, '取消'),
            ),
          )
          : null,

        lint
          ? h('div', { className: 'ns-card' },
            h('div', { className: 'ns-sec-title' }, '检查结果'),
            h('div', { className: 'ns-pre' }, lintText(lint)),
          )
          : null,

        versions
          ? h('div', { className: 'ns-card' },
            h('div', { className: 'ns-sec-title' }, `历史版本（${(versions.versions || []).length}）`),
            (versions.versions || []).length === 0
              ? h('div', { className: 'ns-dim' }, '还没有历史版本（只在覆盖已有正文时存档）。')
              : versions.versions.map((stamp) => h('div', { key: stamp, className: 'ns-item ns-version' },
                h('span', null, stamp),
                h('button', { className: 'ns-btn', 'data-variant': 'ghost', onClick: () => restore(stamp), disabled: locked }, '回退'),
              )),
          )
          : null,

        runs
          ? h('div', { className: 'ns-card' },
            h('div', { className: 'ns-sec-title' }, '运行台账'),
            h('div', { className: 'ns-pre' }, runsText(runs, order)),
          )
          : null,

        editing
          ? null
          : chapter.content
            ? h('div', { className: 'ns-pre' }, chapter.content)
            : h('div', { className: 'ns-empty' }, '这一章还没有正文。点「生成（过闸门）」或「只产候选」。'),
      );
    }

    /**
     * 指纹报告（FingerprintReport）的展示文本。
     * 字段名对齐 ndecon：每条 finding 是 {rule,label,value,limit,severity,passed,detail}，
     * 不是 {count,evidence}——读错字段会显示成「规则名 · undefined」。
     */
    function lintText(report) {
      if (!report || typeof report !== 'object') return '（无结果）';
      const lines = [];
      if (typeof report.passed === 'boolean') lines.push(`是否通过：${report.passed ? '通过' : '有规则越界'}`);
      if (report.version) lines.push(`规则版本：${report.version}`);
      if (Number.isFinite(report.cjk_chars)) lines.push(`字数：${report.cjk_chars}`);
      if (Number.isFinite(report.paragraph_count)) lines.push(`段落：${report.paragraph_count}`);
      const findings = Array.isArray(report.findings) ? report.findings : [];
      const bad = findings.filter((item) => item && item.passed === false);
      lines.push('');
      if (findings.length === 0) lines.push('没有命中任何规则。');
      for (const item of findings) {
        const flag = item.passed === false ? '✗' : '✓';
        const head = [flag, item.label || item.rule, `${item.value} / 阈值 ${item.limit}`].join(' · ');
        lines.push(head);
        if (item.detail) lines.push(`    ${item.detail}`);
      }
      if (bad.length === 0 && findings.length > 0) lines.push('（全部规则都在阈值内）');
      return lines.join('\n');
    }

    /** 台账展示：只列本章的，因为用户在章节页里最关心这一章为什么没过。 */
    function runsText(payload, order) {
      const groups = (payload && Array.isArray(payload.runs)) ? payload.runs : [];
      const lines = [];
      for (const group of groups) {
        for (const item of (group.chapters || [])) {
          if (order !== undefined && item.order !== order) continue;
          const head = [group.run_id, `第 ${item.order} 章`, item.status, item.verdict]
            .filter(Boolean).join(' · ');
          lines.push(`${head}${item.attempts ? ` · 尝试 ${item.attempts} 次` : ''}${item.cjk_chars ? ` · ${item.cjk_chars} 字` : ''}`);
        }
      }
      return lines.length === 0 ? '本章还没有运行记录。' : lines.join('\n');
    }


    /* ------------------------------------------------------------------ */
    /* 模型页                                                              */
    /* ------------------------------------------------------------------ */

    /**
     * 「模型」页：显示 DSH 里配好的模型，允许单独换（不动全局默认）。
     *
     * 为什么要能单独存：`agentDefaultModel` 是全会话共享的全局默认。写一章
     * 几千字、成本比聊天高一个量级，想单独给写作换便宜模型时不该被迫改全局。
     */
    function ModelScreen({ busy, onBack }) {
      const [data, setData] = React.useState(null);
      const [error, setError] = React.useState('');
      const [saving, setSaving] = React.useState(false);
      const [provider, setProvider] = React.useState('');
      const [model, setModel] = React.useState('');
      // 用户已经动过选择：后续任何一次后台刷新都不许把他的手选覆盖掉。
      // 这条不是洁癖——load() 会在保存后、刷新后重跑，覆盖的表现是「选了半天又跳回去」。
      const touched = React.useRef(false);

      const load = React.useCallback(() => {
        setError('');
        request('GET', '_models')
          .then((value) => {
            setData(value);
            if (touched.current) return;
            const saved = value && value.saved;
            setProvider(saved && typeof saved.provider === 'string' ? saved.provider : '');
            setModel(saved && typeof saved.model === 'string' ? saved.model : '');
          })
          .catch((e) => setError(e.message));
      }, []);

      React.useEffect(() => { load(); }, [load]);

      const providers = (data && Array.isArray(data.providers)) ? data.providers : [];
      const active = providers.find((item) => item.id === provider);
      const models = active && Array.isArray(active.models) ? active.models : [];

      const save = async (nextProvider, nextModel) => {
        setSaving(true);
        setError('');
        try {
          await request('PUT', '_models', { provider: nextProvider, model: nextModel });
          // 存好之后把手选标记放开：这时候服务端返回的就是新的基准，
          // 再刷新应当以它为准，而不是永远不再接受服务端的值。
          touched.current = false;
          load();
        } catch (e) { setError(e.message); } finally { setSaving(false); }
      };

      const current = data && data.current;
      const sourceLabel = current
        ? (current.source === 'saved' ? '本插件单独选' : '跟随 DSH 默认')
        : '没有可用模型';

      const form = [];
      form.push(h('div', { key: 'row1', className: 'ns-form-row' },
        h('div', { className: 'ns-field' },
          h('div', { className: 'ns-field-label' }, '供应商'),
          h('select', {
            className: 'ns-input',
            value: provider,
            disabled: saving,
            onChange: (event) => {
              touched.current = true;
              const next = event.target.value;
              setProvider(next);
              const entry = providers.find((item) => item.id === next);
              const first = entry && entry.models && entry.models[0] ? entry.models[0].id : '';
              setModel(first);
            },
          },
            h('option', { value: '' }, '（跟随 DSH 默认模型）'),
            providers.map((item) => h('option', { key: item.id, value: item.id }, item.name || item.id)),
          ),
        ),
        h('div', { className: 'ns-field' },
          h('div', { className: 'ns-field-label' }, '模型'),
          models.length > 0
            ? h('select', {
              className: 'ns-input',
              value: model,
              disabled: saving || !provider,
              onChange: (event) => { touched.current = true; setModel(event.target.value); },
            },
              h('option', { value: '' }, '（默认）'),
              models.map((item) => h('option', { key: item.id, value: item.id }, item.name || item.id)),
            )
            : h('input', {
              className: 'ns-input',
              value: model,
              placeholder: provider ? '手填模型 id（该供应商没有列出可选模型）' : '先选供应商',
              disabled: saving || !provider,
              onChange: (event) => { touched.current = true; setModel(event.target.value); },
            }),
        ),
      ));
      if (active && active.error) {
        form.push(h('div', { key: 'perr', className: 'ns-warn' }, `这个供应商当前不可用：${active.error}`));
      }
      form.push(h('div', { key: 'row2', style: { display: 'flex', gap: '6px', marginTop: '2px' } },
        h('button', {
          className: 'ns-btn',
          'data-variant': 'primary',
          disabled: saving || busy || !provider || !model,
          onClick: () => save(provider, model),
        }, saving ? '保存中…' : '用这个模型'),
        h('button', {
          className: 'ns-btn',
          'data-variant': 'ghost',
          disabled: saving || busy,
          onClick: () => { setProvider(''); setModel(''); save('', ''); },
        }, '恢复跟随 DSH 默认'),
      ));

      return h('div', null,
        h('div', { className: 'ns-sec' },
          h('button', { className: 'ns-btn', 'data-variant': 'ghost', onClick: onBack }, '← 返回项目列表'),
        ),
        error ? h('div', { className: 'ns-err' }, error) : null,
        h('div', { className: 'ns-card' },
          h('div', { className: 'ns-sec-title' }, '当前引擎在用'),
          current
            ? h('div', null,
              h('div', { className: 'ns-kv' }, h('b', null, '供应商'), h('span', null, current.provider)),
              h('div', { className: 'ns-kv' }, h('b', null, '模型'), h('span', null, current.model)),
              h('div', { className: 'ns-kv' }, h('b', null, '来源'), h('span', null, sourceLabel)),
            )
            : h('div', { className: 'ns-warn' },
              '还没有可用模型。先在 DSH 设置里配一个默认模型，或在下面单独选一个。'),
          data && data.bridge
            ? h('div', { className: 'ns-meta' }, `模型桥：${data.bridge}（只监听本机，带随机 token）`)
            : null,
        ),
        h('div', { className: 'ns-form' },
          h('div', { className: 'ns-sec-title' }, '单独指定（只影响本插件）'),
          form,
          h('div', { className: 'ns-meta' },
            providers.length === 0
              ? '宿主没有列出任何供应商。可以在 DSH 设置里配默认模型。'
              : `DSH 里共有 ${providers.length} 个供应商。`),
        ),
      );
    }

    /* ------------------------------------------------------------------ */
    /* 设置页                                                              */
    /* ------------------------------------------------------------------ */

    /**
     * 设置页：改工作区路径。
     *
     * 这是最容易出「项目不见了」的地方：工作区换一个目录，右栏看到的就是另一批书。
     * 所以这里必须同时显示「现在用的是哪个目录」和「那个目录里有多少项目」，
     * 不能只给一个输入框让用户猜自己改对了没有。
     */
    function SettingsScreen({ busy, onBack, onSaved }) {
      const [data, setData] = React.useState(null);
      const [workspace, setWorkspace] = React.useState('');
      const [error, setError] = React.useState('');
      const [note, setNote] = React.useState('');
      const [saving, setSaving] = React.useState(false);
      const touched = React.useRef(false);

      const load = React.useCallback(() => {
        setError('');
        request('GET', '_settings')
          .then((value) => {
            setData(value);
            if (touched.current) return;
            setWorkspace((value && value.workspace) || '');
          })
          .catch((e) => setError(e.message));
      }, []);

      React.useEffect(() => { load(); }, [load]);

      const save = async () => {
        setSaving(true);
        setError('');
        setNote('');
        try {
          const value = await request('PUT', '_settings', { workspace });
          setData(value);
          touched.current = false;
          setNote('已保存。引擎会用新工作区重启，之后列出的就是那个目录里的项目。');
          if (onSaved) onSaved(value);
        } catch (e) { setError(e.message); } finally { setSaving(false); }
      };

      const count = data && Number.isInteger(data.projectCount) ? data.projectCount : null;

      return h('div', null,
        h('div', { style: { marginBottom: 10 } },
          h('button', { className: 'ns-btn', 'data-variant': 'ghost', onClick: onBack }, '← 返回项目列表'),
        ),
        error ? h('div', { className: 'ns-err' }, error) : null,
        note ? h('div', { className: 'ns-warn' }, note) : null,
        h('div', { className: 'ns-card' },
          h('div', { className: 'ns-sec-title' }, '工作区'),
          h('div', { className: 'ns-kv' }, h('b', null, '当前'), h('span', { className: 'ns-pre' }, (data && data.workspace) || '（未知）')),
          count !== null
            ? h('div', { className: 'ns-kv' }, h('b', null, '项目数'), h('span', null, `${count} 本`))
            : null,
          h('div', { className: 'ns-field', style: { marginTop: 8 } },
            h('div', { className: 'ns-field-label' }, '改成别的目录（绝对路径）'),
            h('input', {
              className: 'ns-input',
              value: workspace,
              disabled: saving || busy,
              placeholder: 'D:\\myproject\\.ndecon-workspace',
              onChange: (event) => { touched.current = true; setWorkspace(event.target.value); },
            }),
          ),
          h('div', { className: 'ns-meta' },
            '换目录不会搬动已有的书，只是换一个「看哪个库」。写错的路径会当场建出来。'),
          h('div', { style: { marginTop: 8 } },
            h('button', { className: 'ns-btn', 'data-variant': 'primary', onClick: save, disabled: saving || busy },
              saving ? '保存中…' : '保存并重启引擎'),
          ),
        ),
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

      // 模型必须一直可见：用户最常踩的坑就是「以为模型配好了，点生成才发现没配」。
      const modelText = status && status.model
        ? `${status.model.model}${status.model.source === 'saved' ? '（单独选）' : ''}`
        : '未选模型';
      const modelOk = !!(status && status.hasModel);

      let body;
      if (screen.name === 'models') {
        body = h(ModelScreen, {
          busy,
          onBack: () => { setScreen({ name: 'list' }); loadStatus(); },
        });
      } else if (screen.name === 'settings') {
        body = h(SettingsScreen, {
          busy,
          onBack: () => { setScreen({ name: 'list' }); loadStatus(); },
          onSaved: () => { loadStatus(); setRefreshKey((k) => k + 1); },
        });
      } else if (screen.name === 'project') {
        body = h(ProjectHome, {
          projectId: screen.projectId,
          busy,
          onBack: () => setScreen({ name: 'list' }),
          onOpenChapter: (projectId, order) => setScreen({ name: 'chapter', projectId, order }),
          onChanged: () => setRefreshKey((k) => k + 1),
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
            'data-variant': 'ghost',
            title: '选择用哪个模型（来自 DSH）',
            onClick: () => setScreen({ name: 'models' }),
          },
            h('span', { className: 'ns-badge', 'data-tone': modelOk ? 'ok' : 'bad' }, modelText),
          ),
          h('button', {
            className: 'ns-btn',
            'data-variant': 'ghost',
            title: '工作区与设置',
            onClick: () => setScreen({ name: 'settings' }),
          }, '设置'),
          h('button', {
            className: 'ns-btn',
            onClick: wrap(async () => { loadStatus(); setRefreshKey((k) => k + 1); }),
            disabled: busy,
          }, '刷新'),
        ),
        h('div', { style: { padding: '5px 10px', fontSize: '10.5px' }, className: 'ns-dim' },
          engine,
          status && status.lastError && status.running ? ` · ${status.lastError}` : '',
        ),
        note ? h('div', { style: { padding: '0 10px' } }, h('div', { className: 'ns-err' }, note)) : null,
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
      ModelScreen,
      SettingsScreen,
      StudioTab,
      StudioEntry,
      partText,
      outlineText,
      recordChars,
      recordTime,
      chapterOrders,
      outlineCount,
      stateOf,
      lintText,
      runsText,
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
