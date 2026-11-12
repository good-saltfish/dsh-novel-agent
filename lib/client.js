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

/*
 * 同一份代码被执行两遍时，别把整个右栏拖死。
 *
 * 宿主的 __ModuleLoader__ 拿 id 当唯一键，第二次注册会把
 * `client-modules: duplicate factory registration for "dsh-novel-agent"
 * (bundle executed twice without invalidate?)` 直接抛出来，右栏半边加载失败——
 * 用户看到的就是「插件崩了」。
 *
 * 什么时候会执行两遍：插件改名（dsh-novel-studio → dsh-novel-agent）之后，页面启动
 * 清单里还留着旧包名的 URL（有插件会把启动时的脚本清单冻结一份复用），新旧两个
 * URL 指向同一个文件，于是同一份代码被执行两遍。改名只发生一次，缓存副本不会自己
 * 消失。两次注册的是同一个 factory，丢弃第二份没有任何损失。
 *
 * 为什么用 try/catch 而不是「注册过就跳过」的标记：宿主刷新插件时会先 invalidate
 * 再重新执行脚本来重新注册。用标记挡的话，那次合法重注册会被一起挡掉，宿主随后报
 * `bundle ... loaded without registering`，右栏再也回不来。只在真的抛「重复注册」
 * 时吞，合法重注册仍然照常走。
 */
function isDuplicateRegistration(error) {
  const message = String((error && error.message) || error || '');
  return message.includes('duplicate factory registration') && message.includes('dsh-novel-agent');
}

try {
  window.__ModuleLoader__.load({
    id: 'dsh-novel-agent',
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' });

    const React = require('react');
    const h = React.createElement;

    const API = 'novel-studio/api';
    const NS = 'dshNovelStudio';
    // 轮询间隔：一章真模型要 25-81 秒，2 秒一次足够快也不会把引擎打爆。
    const POLL_INTERVAL_MS = 2000;
    const TAB_ID = 'dsh-novel-agent/studio';
    const TAB_KIND = 'dsh-novel-agent:studio';
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
        // 404「未知接口」是**版本错位**，不是路径写错：插件比引擎新，端点在老引擎
        // 上还不存在（典型：装了 0.2.4 的插件，引擎还停在改名前那一版）。
        // 只回「未知接口」用户会以为插件坏了，实际点一次「重启引擎」多半就好，
        // 所以这里必须把「该动作是升级」说出来，而不是让它像一次代码 bug。
        const stale = res.status === 404
          && typeof message === 'string' && message.includes('未知接口');
        const failure = new Error(stale
          ? `${message}——这个功能需要更新的引擎。先点「重启引擎」；仍不行就去设置页重装引擎。`
          : message);
        // 把原始响应挂上去：有的端点用 422 表达「业务上没过判据」，
        // 正文里带逐条原因（比如 accept-skeleton 的 rejected）。
        // 只留一句 "HTTP 422" 会让界面无从解释，用户只能看到失败。
        failure.status = res.status;
        failure.payload = parsed;
        throw failure;
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
/* 活进度：用户点暂停之前最想知道的就是「现在到底在干嘛」。
   一行标题 + 两行细节，比一句「连写中…」多不了多少地方，但能直接回答
   「是模型在慢慢写，还是已经死了」。 */
.ns-progress{margin:8px 0 4px;padding:8px 10px;border-radius:9px;font-size:11px;
  background:linear-gradient(180deg, rgba(90,150,230,.14), rgba(90,150,230,.05));
  border:1px solid rgba(90,150,230,.38);}
.ns-progress-head{font-weight:620;color:#9dc3f0;margin-bottom:3px;}
.ns-progress-body{color:#b9c3d2;line-height:1.7;}
.ns-progress-advisory{color:#e8b884;line-height:1.7;margin-top:2px;}
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

/* 探测结果：一行字，通/不通用颜色区分，细节在下一行小字里 */
.ns-probe{padding:7px 10px;border-radius:9px;font-size:11px;line-height:1.6;margin-top:8px;
  border:1px solid #333a47;background:rgba(255,255,255,.03);}
.ns-probe[data-tone="ok"]{color:#8ee6a8;border-color:#2f6b45;background:rgba(80,200,120,.10);}
.ns-probe[data-tone="bad"]{color:#e89696;border-color:#6b3232;background:rgba(200,80,80,.10);}
.ns-probe[data-tone="slow"]{color:#e0bf86;border-color:#6b5a2f;background:rgba(220,170,80,.10);}
/* 选型指引：一张小表，左列是模型特征，右列是「所以拿它干什么」 */
.ns-tips{margin-top:6px;font-size:11px;line-height:1.7;color:#97a0b0;}
.ns-tips b{color:#c7cfdc;font-weight:620;}

/* 操作区：按钮一行排开，换行不换高 */
.ns-actions{display:flex;flex-wrap:wrap;gap:5px;margin-bottom:10px;}
/* 破坏性操作单独一档颜色：删除和保存长得一样，用户迟早会点错。 */
.ns-btn[data-variant="danger"]{color:#f0b4b4;border-color:#6b3232;
  background:linear-gradient(180deg,#3a2226,#2e1c20);
  box-shadow:0 1px 0 rgba(255,255,255,.05) inset, 0 2px 4px rgba(0,0,0,.28);}
.ns-btn[data-variant="danger"]:hover{color:#ffd0d0;border-color:#8d4242;}
/* 屏幕顶部的返回条：所有屏都必须有，位置一致，用户才不用每屏重新找。 */
.ns-backbar{display:flex;align-items:center;gap:6px;margin-bottom:10px;}
.ns-textarea{min-height:220px;resize:vertical;line-height:1.7;font-family:inherit;}
.ns-version{display:flex;align-items:center;justify-content:space-between;gap:8px;
  cursor:default;font-family:ui-monospace,Consolas,monospace;font-size:11px;}
.ns-version:hover{transform:none;}

/* 并行候选：一版一块，块内竖排（编号行 + 预览 + 提交按钮） */
.ns-cand{display:flex;flex-direction:column;gap:6px;cursor:default;}
.ns-cand:hover{transform:none;}
.ns-cand-head{display:flex;align-items:center;gap:6px;flex-wrap:wrap;}
.ns-cand-preview{font-size:11.5px;line-height:1.72;color:#b9c3d2;
  white-space:pre-wrap;word-break:break-word;max-height:120px;overflow:auto;}
.ns-cand[data-picked="1"]{border-color:#3f6ea8;
  background:linear-gradient(180deg, rgba(70,130,200,.14), rgba(70,130,200,.04));}

/* 骨架部件：可展开编辑，展开后是一组字段 */
.ns-part{margin-bottom:2px;}
.ns-part .ns-kv{cursor:pointer;}
.ns-part .ns-kv:hover{background:rgba(255,255,255,.03);}
.ns-part-body{padding:8px 10px 10px;margin:2px 0 8px;border-radius:8px;
  background:rgba(255,255,255,.025);box-shadow:0 1px 0 rgba(255,255,255,.04) inset;}
.ns-part-body .ns-field{margin-bottom:6px;}
`;


    function installStyle() {
      if (typeof document === 'undefined') return;
      if (document.querySelector(`style[data-plugin-css=${JSON.stringify(NS)}]`)) return;
      const el = document.createElement('style');
      el.dataset.plugin = 'dsh-novel-agent';
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

    /**
     * 设定条目类型的可读名。
     *
     * 后端受控词表（`creation/models.py::SettingEntry.entry_type`）是英文，
     * 直接显示 `world_rule` 用户得先猜；这张表是唯一翻译点，改后端要同步这里。
     */
    const ENTRY_LABEL = {
      world_rule: '世界规则',
      faction: '势力',
      character: '人物',
      location: '地点',
      item: '道具',
      power_system: '力量体系',
    };

    /**
     * 「设定候选」的展示文本。
     *
     * 候选**不是**已确认设定：引擎的语义是「候选不代笔」，确认要走
     * `plan/accept/settings`。展示时必须把这一点说出来，否则用户会以为
     * 已经入库，接着写正文才发现设定根本不在上下文里。
     */
    function planSettingsText(plan) {
      if (!plan || typeof plan !== 'object') return '（无结果）';
      const lines = [];
      const entries = Array.isArray(plan.entries) ? plan.entries : [];
      lines.push(`设定候选 ${entries.length} 条`);
      if (plan.model_id) lines.push(`产出：${plan.model_id}${plan.prompt_version ? ` · ${plan.prompt_version}` : ''}`);
      lines.push('');
      for (const entry of entries) {
        const kind = ENTRY_LABEL[entry.entry_type] || entry.entry_type || '设定';
        lines.push(`【${kind}】${entry.name || '(无名)'}`);
        if (entry.content) lines.push(`    ${entry.content}`);
        const tags = Array.isArray(entry.tags) ? entry.tags : [];
        if (tags.length > 0) lines.push(`    标签：${tags.join('、')}`);
      }
      if (plan.golden_finger) {
        const finger = plan.golden_finger;
        lines.push('');
        lines.push(`【金手指】${finger.name || '(无名)'}`);
        if (finger.ability) lines.push(`    能做什么：${finger.ability}`);
        if (finger.cost_limitation) lines.push(`    代价与限制：${finger.cost_limitation}`);
        if (finger.growth_path) lines.push(`    成长路径：${finger.growth_path}`);
      }
      const notes = Array.isArray(plan.notes) ? plan.notes : [];
      if (notes.length > 0) lines.push('', `说明：${notes.join('；')}`);
      return lines.join('\n');
    }

    /**
     * 「细纲候选」的展示文本。
     *
     * 节拍是往已有细纲章的 `beats` 上整章替换（`_accept_plan_outline` 的语义），
     * 所以这里按章聚合展示，用户才能判断「换掉这一章的节拍」值不值。
     */
    function planOutlineText(plan) {
      if (!plan || typeof plan !== 'object') return '（无结果）';
      const lines = [];
      const chapters = Array.isArray(plan.chapters) ? plan.chapters : [];
      const beatTotal = chapters.reduce((sum, item) => sum + ((item && item.beats) || []).length, 0);
      lines.push(`细纲候选 ${chapters.length} 章，共 ${beatTotal} 个节拍`);
      if (plan.model_id) lines.push(`产出：${plan.model_id}${plan.prompt_version ? ` · ${plan.prompt_version}` : ''}`);
      lines.push('');
      for (const chapter of chapters) {
        const beats = Array.isArray(chapter.beats) ? chapter.beats : [];
        lines.push(`第 ${chapter.order} 章${chapter.emotion_track ? `（${chapter.emotion_track}）` : ''} · ${beats.length} 拍`);
        for (const beat of beats) {
          const scene = beat.scene ? `${beat.scene}｜` : '';
          const who = (Array.isArray(beat.characters) && beat.characters.length > 0)
            ? `（${beat.characters.join('、')}）` : '';
          lines.push(`  ${beat.order}. ${scene}${beat.event || ''}${who}`);
          if (beat.plant_foreshadow) lines.push(`      埋：${beat.plant_foreshadow}`);
        }
      }
      const notes = Array.isArray(plan.notes) ? plan.notes : [];
      if (notes.length > 0) lines.push('', `说明：${notes.join('；')}`);
      return lines.join('\n');
    }

    /**
     * 每个部件「不填会怎样」。
     *
     * 用户的原话：「设定、骨架部分太工程化了，太绝对了，其实有些设定对于有些书
     * 是不需要的，不一定要有」。引擎的语义其实早就是可选的（`CreationDraft` 五个
     * 字段全是 `| None`，验收也只对「有内容的部件」挑刺），是界面把「未生成」画得
     * 像半个错误，用户才以为必须凑齐五件套。逐条写清后果，「这本不需要」才
     * 是一个正当选择，而不是欠账。
     */
    const PART_HINT = {
      positioning: '不填也能写，只是每章少了「给谁看、卖点是什么」这层约束。',
      volume: '引擎的上下文包根本不注入卷纲，填了主要是给人看、给候选 planner 当参考。',
      protagonist: '不填=主角没有固定人设，模型可能每章换性格。长篇建议填。',
      golden_finger: '不填=不引入超常能力。现实、纯悬疑、纯情感题材可以不要。',
      chapters: '写正文必需：没有细纲就没有「第几章」可写。这是唯一硬性的一件。',
    };

    /** 唯一「不填就没法写」的部件。其它四个都可选，只是可选的程度不同。 */
    const REQUIRED_PARTS = ['chapters'];

    /**
     * 「面板 / Markdown」的查看方式，记在 localStorage。
     *
     * 记下来是因为这是个人偏好而不是单次操作：每次进项目页都要重选一遍会很烦。
     * 读写都包在 try 里——右栏可能跑在沙箱 iframe 或隐私模式下，localStorage
     * 抛异常就退化成默认值，不能因为存不了偏好就让整页白屏。
     */
    const VIEW_MODE_KEY = 'dsh-novel-agent.view-mode';

    // localStorage 存不了时的兜底：至少本次会话里选择要算数。
    // 否则在禁 localStorage 的环境（沙箱 iframe、隐私模式、某些 Electron 配置）里
    // 点「Markdown」会毫无反应——用户会以为按钮坏了。
    let memoryViewMode = 'panel';

    function readViewMode() {
      try {
        const saved = window.localStorage.getItem(VIEW_MODE_KEY);
        return saved === 'markdown' ? 'markdown' : saved === 'panel' ? 'panel' : memoryViewMode;
      } catch (error) {
        return memoryViewMode;
      }
    }

    function saveViewMode(mode) {
      memoryViewMode = mode === 'markdown' ? 'markdown' : 'panel';
      try { window.localStorage.setItem(VIEW_MODE_KEY, memoryViewMode); } catch (error) { /* 存不了就只在本次生效 */ }
    }

    /**
     * 一个骨架部件转成 Markdown 片段。
     *
     * 字段名走 `PART_FIELDS` 的中文标签，与面板视图保持同一套词——用户在两种
     * 视图之间来回切时，不能同一件事两个叫法。
     */
    function partMarkdown(part, value) {
      if (value === null || value === undefined) return '';
      if (part === 'chapters') {
        const chapters = Array.isArray(value) ? value : [];
        return chapters.map((chapter) => {
          const lines = [`### 第 ${chapter.order} 章${chapter.title ? ` · ${chapter.title}` : ''}`];
          if (chapter.core_event) lines.push(`- 核心事件：${chapter.core_event}`);
          if (chapter.opening_hook) lines.push(`- 开篇钩：${chapter.opening_hook}`);
          if (chapter.ending_hook) lines.push(`- 章尾钩：${chapter.ending_hook}`);
          const beats = Array.isArray(chapter.beats) ? chapter.beats : [];
          if (beats.length > 0) {
            lines.push('- 节拍：');
            for (const beat of beats) {
              const scene = beat.scene ? `${beat.scene}｜` : '';
              const who = (Array.isArray(beat.characters) && beat.characters.length > 0)
                ? `（${beat.characters.join('、')}）` : '';
              lines.push(`  ${beat.order}. ${scene}${beat.event || ''}${who}`);
              if (beat.plant_foreshadow) lines.push(`     - 埋伏笔：${beat.plant_foreshadow}`);
            }
          }
          return lines.join('\n');
        }).join('\n\n');
      }
      const spec = PART_FIELDS[part] || [];
      const lines = [];
      for (const [key, label, kind] of spec) {
        const raw = value[key];
        if (kind === 'list') {
          const list = Array.isArray(raw) ? raw.filter(Boolean) : [];
          if (list.length === 0) continue;
          lines.push(`- ${label}：`);
          for (const item of list) lines.push(`  - ${item}`);
        } else if (raw !== null && raw !== undefined && String(raw).trim()) {
          lines.push(`- ${label}：${raw}`);
        }
      }
      return lines.join('\n');
    }

    /**
     * 整本书的 Markdown 全貌。
     *
     * 用户要「以 md 的形式完整展示（面板也保留，二者选其一）」。这里只做投影，
     * 不重排数据：同一个项目，Markdown 视图和面板视图必须描述同一份
     * `project.json`，否则两边说的不是一本书。所以每个字段都从 `project` 直接取，
     * 不缓存、不补全。
     */
    function projectMarkdown(project) {
      if (!project || typeof project !== 'object') return '（项目还没加载完）';
      const meta = project.meta || {};
      const draft = project.draft || {};
      const lines = [`# ${meta.title || '(未命名)'}`];

      const head = [];
      if (project.genre) head.push(['题材', project.genre]);
      if (project.premise) head.push(['一句话设定', project.premise]);
      head.push(['细纲', `${outlineCount(project)} 章`]);
      head.push(['已写', `${chapterOrders(project).length} 章`]);
      const confirmed = project.confirmed_parts || {};
      const usable = ['positioning', 'volume', 'protagonist', 'golden_finger']
        .filter((part) => confirmed[part] === 'human-confirmed' || confirmed[part] === 'auto-accepted')
        .map((part) => PART_LABEL[part]);
      head.push(['会进上下文', usable.length > 0 ? usable.join('、') : '（无）']);
      lines.push('');
      for (const [label, value] of head) lines.push(`- ${label}：${value}`);

      for (const part of ['positioning', 'volume', 'protagonist', 'golden_finger']) {
        const body = partMarkdown(part, draft[part]);
        if (!body) continue;
        const state = confirmed[part];
        lines.push('', `## ${PART_LABEL[part]}${state ? `（${STATE_LABEL[state] || state}）` : ''}`, '', body);
      }

      const settings = Array.isArray(project.settings) ? project.settings : [];
      if (settings.length > 0) {
        lines.push('', `## 设定库（${settings.length} 条）`);
        for (const [type, items] of groupSettings(settings)) {
          lines.push('', `### ${ENTRY_LABEL[type] || type}（${items.length}）`);
          for (const entry of items) {
            lines.push(`- **${entry.name || '(无名)'}**：${entry.content || ''}`);
            const tags = Array.isArray(entry.tags) ? entry.tags : [];
            if (tags.length > 0) lines.push(`  - 标签：${tags.join('、')}`);
            const chapters = Array.isArray(entry.related_chapters) ? entry.related_chapters : [];
            if (chapters.length > 0) lines.push(`  - 相关章：第 ${chapters.join('、')} 章`);
          }
        }
      }

      const outline = Array.isArray(draft.chapters) ? draft.chapters : [];
      if (outline.length > 0) {
        lines.push('', `## 细纲（${outline.length} 章）`);
        const sorted = [...outline].sort((a, b) => (a.order || 0) - (b.order || 0));
        const body = partMarkdown('chapters', sorted);
        if (body) lines.push('', body);
      }

      const orders = chapterOrders(project);
      if (orders.length > 0) {
        lines.push('', `## 已写章节（${orders.length}）`);
        for (const order of orders) {
          const record = (project.manuscripts || {})[`ch${order}`] || {};
          const bits = [
            record.status || '?',
            recordChars(record) !== null ? `${recordChars(record)} 字` : null,
            recordTime(record) || null,
          ].filter(Boolean);
          lines.push(`- 第 ${order} 章${record.title ? ` · ${record.title}` : ''}（${bits.join('，')}）`);
        }
      }

      return lines.join('\n');
    }

    /** 按 `entry_type` 分组并保持稳定顺序（后端受控词表的顺序更好读）。 */
    function groupSettings(entries) {
      const order = ['world_rule', 'faction', 'character', 'location', 'item', 'power_system'];
      const buckets = new Map();
      for (const entry of Array.isArray(entries) ? entries : []) {
        const key = entry && entry.entry_type ? entry.entry_type : 'other';
        if (!buckets.has(key)) buckets.set(key, []);
        buckets.get(key).push(entry);
      }
      return [...buckets.entries()].sort((a, b) => {
        const i = order.indexOf(a[0]);
        const j = order.indexOf(b[0]);
        return (i === -1 ? order.length : i) - (j === -1 ? order.length : j);
      });
    }

    /**
     * 设定库的可读文本。
     *
     * 这块以前在插件里零渲染：`/plan/accept/settings` 写进 `project.settings`
     * 之后，用户在界面上一条都看不到。确认过的设定等于白确认——他不会知道
     * 自己到底给这本书定了什么规矩。
     */
    function settingsText(entries) {
      const list = Array.isArray(entries) ? entries : [];
      if (list.length === 0) {
        return '（还没有确认过的设定。上面「生成设定候选」看中了再点「确认设定」，条目才会出现在这里；'
          + '也可以整本不要设定——上下文包只注入「已确认」的部件，不确认就不进正文。）';
      }
      const lines = [`已确认设定 ${list.length} 条`];
      for (const [type, items] of groupSettings(list)) {
        lines.push('', `【${ENTRY_LABEL[type] || type}】${items.length} 条`);
        for (const entry of items) {
          lines.push(`  · ${entry.name || '(无名)'}：${entry.content || ''}`);
          const tags = Array.isArray(entry.tags) ? entry.tags : [];
          if (tags.length > 0) lines.push(`      标签：${tags.join('、')}`);
          const chapters = Array.isArray(entry.related_chapters) ? entry.related_chapters : [];
          if (chapters.length > 0) lines.push(`      相关章：第 ${chapters.join('、')} 章`);
        }
      }
      return lines.join('\n');
    }

    /**
     * 角色卡：主角部件 + 设定库里 `character` 类型的条目。
     *
     * 两处合起来看，因为存储上它们确实分两处（主角是骨架的结构化对象，配角只
     * 存在于设定库），但用户点「角色卡」时不会关心这个区别。分开显示反而会让
     * 人以为配角没存进去。
     */
    function characterCards(project) {
      const cards = [];
      const draft = (project && project.draft) || {};
      const lead = draft.protagonist;
      if (lead && (lead.name || lead.personality || lead.background)) {
        const facts = [
          ['出身/初始处境', lead.background],
          ['性格', lead.personality],
          ['核心欲望', lead.desire],
          ['缺陷/成长课题', lead.flaw],
          ['标志性能力', lead.signature_ability],
        ].filter(([, value]) => value && String(value).trim());
        cards.push({
          key: 'protagonist',
          role: '主角',
          name: lead.name || '(未命名)',
          source: '骨架 · 主角',
          facts,
          tags: [],
        });
      }
      const settings = Array.isArray(project && project.settings) ? project.settings : [];
      for (let index = 0; index < settings.length; index += 1) {
        const entry = settings[index];
        if (!entry || entry.entry_type !== 'character') continue;
        cards.push({
          key: `setting-${index}-${entry.name || ''}`,
          role: '配角/其它',
          name: entry.name || '(无名)',
          source: '设定库 · 人物',
          facts: entry.content ? [['设定', entry.content]] : [],
          tags: Array.isArray(entry.tags) ? entry.tags : [],
        });
      }
      return cards;
    }

    function charactersText(project) {
      const cards = characterCards(project);
      if (cards.length === 0) {
        return '（还没有角色。骨架里填「主角」，或让设定候选产出「人物」类条目再确认。）';
      }
      const lines = [`角色 ${cards.length} 张`];
      for (const card of cards) {
        lines.push('', `【${card.role}】${card.name}`);
        if (card.facts.length === 0) lines.push('  （除了名字没有别的设定）');
        for (const [label, value] of card.facts) lines.push(`  ${label}：${value}`);
        if (card.tags.length > 0) lines.push(`  标签：${card.tags.join('、')}`);
      }
      return lines.join('\n');
    }

    /**
     * 剧情线：把细纲逐章的节拍按章号串成一条时间线。
     *
     * 为什么单独做而不复用细纲展示：用户要的是「剧情线」，看的是事件怎么推进、
     * 伏笔什么时候埋——按章罗列 beats 只是结构，串起来才看得出节奏断裂（比如
     * 连续三章都在铺垫、没有推进）。这里不做任何推断，只做投影与计数。
     */
    function storylineRows(project) {
      const chapters = (project && project.draft && Array.isArray(project.draft.chapters))
        ? [...project.draft.chapters].sort((a, b) => (a.order || 0) - (b.order || 0))
        : [];
      const rows = [];
      for (const chapter of chapters) {
        const beats = Array.isArray(chapter.beats) ? chapter.beats : [];
        for (const beat of beats) {
          rows.push({
            key: `ch${chapter.order}-b${beat.order}`,
            chapter: chapter.order,
            order: beat.order,
            scene: beat.scene || '',
            event: beat.event || '',
            characters: Array.isArray(beat.characters) ? beat.characters.filter(Boolean) : [],
            foreshadow: beat.plant_foreshadow || '',
          });
        }
      }
      return rows;
    }

    function storylineText(project) {
      const rows = storylineRows(project);
      if (rows.length === 0) {
        return '（细纲里还没有节拍。先展开「细纲」补 beats，或点「生成细纲候选」再确认。）';
      }
      const chapterCount = new Set(rows.map((row) => row.chapter)).size;
      const planted = rows.filter((row) => row.foreshadow);
      const lines = [`共 ${rows.length} 拍，覆盖 ${chapterCount} 章，埋伏笔 ${planted.length} 处`];
      for (const row of rows) {
        const scene = row.scene ? `${row.scene}｜` : '';
        const who = row.characters.length > 0 ? `（${row.characters.join('、')}）` : '';
        lines.push('', `第 ${row.chapter} 章 · ${row.order}. ${scene}${row.event}${who}`);
        if (row.foreshadow) lines.push(`      埋：${row.foreshadow}`);
      }
      return lines.join('\n');
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

      // 有 DSH 模型就默认用它：用户既然在模型页配好了，新建时再默认走离线模板
      // 就会得到一份占位骨架，看起来像「模型没生效」。
      const [hasModel, setHasModel] = React.useState(null);
      React.useEffect(() => {
        request('GET', '_status')
          .then((value) => {
            const ok = !!(value && value.hasModel);
            setHasModel(ok);
            if (ok) setProvider('ai');
          })
          .catch(() => setHasModel(false));
      }, []);

      const reset = () => {
        setTitle(''); setPremise(''); setGenre('');
        setChapterCount('30'); setProvider(hasModel ? 'ai' : 'fake'); setError(''); setStage('');
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
            h('option', { value: 'ai' }, hasModel === false ? 'DSH 模型（还没配，会失败）' : 'DSH 模型（用你配的模型）'),
            h('option', { value: 'fake' }, '离线模板（免费、可复现，内容不可用）'),
          )),
        ),
        error ? h('div', { className: 'ns-err' }, error) : null,
        provider === 'ai' && hasModel === false
          ? h('div', { className: 'ns-warn' }, 'DSH 里还没有可用模型，骨架生成会失败。先去「模型」页选一个，或改成离线模板。')
          : null,
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

    function ProjectList({ onPick, onCreated, refreshKey, busy, onDeleted }) {
      const [projects, setProjects] = React.useState(null);
      const [error, setError] = React.useState('');
      const [note, setNote] = React.useState('');

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

      const handleDeleted = (projectId) => {
        setNote(`已删除项目 ${projectId}（正文、摘要、台账、版本历史都已删除）`);
        load();
        if (onDeleted) onDeleted(projectId);
      };

      if (projects === null) return h('div', null, form, h('div', { className: 'ns-empty' }, '加载中…'));

      return h('div', null,
        form,
        error ? h('div', { className: 'ns-err' }, error) : null,
        note ? h('div', { className: 'ns-warn' }, note) : null,
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
                // 删除按钮必须吃掉冒泡，否则点删除会先把用户带进这个项目，
                // 而删除请求还在飞——用户看到的是「删了又打开」。
                h('div', { onClick: (event) => { event.stopPropagation(); } },
                  h(DeleteProjectButton, {
                    projectId: meta.id,
                    title: meta.title,
                    busy,
                    onDeleted: handleDeleted,
                  }),
                ),
              );
            }),
        h('div', { style: { marginTop: 8 } },
          h('button', { className: 'ns-btn', onClick: load, disabled: busy }, '刷新')),
      );
    }

    /* ------------------------------------------------------------------ */
    /* 屏幕：项目主页                                                       */
    /* ------------------------------------------------------------------ */

    /* 各骨架部件的字段清单：与 ndecon 的 Pydantic 模型逐字段对齐。
       写死在这里而不是从后端拿，是因为字段名是契约的一部分——后端改字段名时
       前端必须跟着改，硬编码能让这种改动在 code review 里显形；动态渲染则会把
       字段改名变成「界面静默少了一行」。 */
    const PART_FIELDS = {
      positioning: [
        ['genre', '主类型', 'text'],
        ['audience', '目标读者', 'text'],
        ['core_premise', '一句话卖点', 'text'],
        ['selling_points', '差异化卖点', 'list'],
        ['tone_target', '目标基调', 'text'],
      ],
      volume: [
        ['volume_title', '卷名', 'text'],
        ['volume_goal', '本卷目标', 'text'],
        ['main_conflict', '核心矛盾', 'text'],
        ['ending_hook', '卷尾钩子', 'text'],
      ],
      protagonist: [
        ['name', '姓名', 'text'],
        ['background', '出身/初始处境', 'text'],
        ['personality', '性格', 'text'],
        ['desire', '核心欲望', 'text'],
        ['flaw', '缺陷/成长课题', 'text'],
        ['signature_ability', '标志性能力', 'text'],
      ],
      golden_finger: [
        ['name', '名称', 'text'],
        ['form', '形态', 'text'],
        ['ability', '能做什么', 'text'],
        ['cost_limitation', '限制与代价', 'text'],
        ['growth_path', '成长路径', 'text'],
      ],
    };

    /** 把部件对象摊成「字段 → 值」，空值也保留，否则用户看不出哪里是空的。 */
    function partFieldValues(part, draft) {
      const spec = PART_FIELDS[part] || [];
      const source = draft || {};
      return spec.map(([key, label, kind]) => {
        const raw = source[key];
        if (kind === 'list') {
          const list = Array.isArray(raw) ? raw : [];
          return { key, label, kind, text: list.join('\n') };
        }
        return { key, label, kind, text: typeof raw === 'string' ? raw : '' };
      });
    }

    /** 从编辑框的值还原成后端要的结构。列表一行一条，空行丢弃。 */
    function partFromEdits(part, values) {
      const spec = PART_FIELDS[part] || [];
      const out = {};
      for (const [key, , kind] of spec) {
        const text = values[key] === undefined ? '' : String(values[key]);
        if (kind === 'list') {
          out[key] = text.split('\n').map((line) => line.trim()).filter(Boolean);
        } else {
          out[key] = text.trim();
        }
      }
      return out;
    }

    /**
     * 正文用哪个 provider。
     *
     * 这里必须读真实状态，不能写死 'fake'：模型页选的模型存的是宿主的 settings，
     * 正文生成要的是引擎的 provider 名字。两者不一致的话，用户在模型页选了模型、
     * 点生成却拿到离线占位正文，界面还显示「已提交」，这是最难发现的一类错。
     */
    function useProvider(defaultValue) {
      const [provider, setProvider] = React.useState(defaultValue || '');
      const [hasModel, setHasModel] = React.useState(null);
      const [modelLabel, setModelLabel] = React.useState('');
      React.useEffect(() => {
        request('GET', '_status')
          .then((value) => {
            setHasModel(!!(value && value.hasModel));
            const saved = value && value.model;
            setModelLabel(saved ? `${saved.model}${saved.source === 'saved' ? '（单独选）' : '（跟随 DSH 默认）'}` : '');
            // 有模型就默认走 ai；没模型才退回 fake，并把这件事显示出来。
            setProvider((current) => current || (value && value.hasModel ? 'ai' : 'fake'));
          })
          .catch(() => { setHasModel(false); setProvider((current) => current || 'fake'); });
      }, []);
      return { provider, setProvider, hasModel, modelLabel };
    }

    /** 生成前的提示条：把「这次到底用哪个模型」摆在按钮旁边。 */
    /**
     * 连写各阶段的中文名。
     *
     * 引擎每进一个阶段就把 `phase` 写进 ch*.json，界面据此说出「现在在干嘛」。
     * 没有这层翻译，用户看到的是一串英文标识符，等于没说。
     */
    const PHASE_LABEL = {
      start: '准备',
      context: '拼上下文',
      writing: '生成正文',
      gate: '过闸门',
      summary: '生成摘要',
      commit: '写入正文',
      done: '完成',
    };

    /**
     * 把一次连写任务的进度摊成一句话。
     *
     * 用户的原话是「慢的让我觉得是生成失败了」。一句「连写中…」无法区分
     * 「模型在慢慢写」和「进程已经死了」，所以他只能去点重新生成，撞上
     * 「已经有一次连写在跑」。这里必须给出：第几章、哪一步、已经多久。
     */
    function progressText(job) {
      if (!job) return '';
      const order = job.current_order || 0;
      const phase = PHASE_LABEL[job.current_phase] || job.current_phase || '';
      const parts = [];
      if (order) parts.push(`第 ${order} 章`);
      if (phase) parts.push(phase);
      const elapsed = elapsedText(job.current_since);
      if (elapsed) parts.push(`已 ${elapsed}`);
      if (job.current_detail) parts.push(job.current_detail);
      return parts.join(' · ');
    }

    /**
     * 从「进入某阶段的时间」算已经过去多久。
     *
     * 引擎写的是本地时间 ISO 串（无时区后缀），`new Date` 按本地时区解析，
     * 与引擎同一台机器所以对得上。解析失败就返回空串——宁可少显示一行，
     * 也不能显示 NaN。
     */
    function elapsedText(since) {
      if (!since) return '';
      const started = new Date(since).getTime();
      if (!Number.isFinite(started)) return '';
      const seconds = Math.max(0, Math.round((Date.now() - started) / 1000));
      if (seconds < 60) return `${seconds} 秒`;
      const minutes = Math.floor(seconds / 60);
      const rest = seconds % 60;
      if (minutes < 60) return `${minutes} 分${rest ? ` ${rest} 秒` : ''}`;
      return `${Math.floor(minutes / 60)} 小时 ${minutes % 60} 分`;
    }

    function providerHint(hasModel, modelLabel) {
      if (hasModel === null) return h('div', { className: 'ns-dim' }, '正在确认模型…');
      if (!hasModel) {
        return h('div', { className: 'ns-warn' },
          '还没有可用的模型，这次会用离线占位正文（内容不可用，仅供跑通流程）。',
          ' 去「模型」页选一个，或在 DSH 设置里配默认模型。');
      }
      return h('div', { className: 'ns-dim' }, `这次用 ${modelLabel || 'DSH 默认模型'} 生成（经 DSH 模型桥，走 llm.stream）`);
    }

    /**
     * 骨架生成失败时给一句「接下来该做什么」。
     *
     * 为什么必须有：模型少给一块、JSON 被截断、端点超时，这三种失败用户能做的
     * 事完全不同（换模型 / 重试 / 调小章数）。只回一句错误原文，用户只能反复
     * 点同一个按钮。
     */
    function skeletonAdvice(message) {
      const text = String(message || '');
      if (text.includes('缺少部件') || text.includes('不是 JSON 对象') || text.includes('不合法')) {
        return '。模型这次没按模板给齐五块骨架——重试一次通常就好；连续两次都缺同一块，换一个模型（「模型」页）。';
      }
      if (text.includes('超时')) {
        return '。模型这侧超时了。可以先把细纲章数调小（比如 10 章）再试，或换一个更快的模型。';
      }
      if (text.includes('没有可用的模型') || text.includes('尚未选择')) {
        return '。先去「模型」页选一个模型。';
      }
      return '';
    }

    /**
     * 连写失败时给一句「接下来该做什么」。
     *
     * 闸门的判定名（repair / reject）对用户没有意义，真正决定下一步的是
     * **哪条硬门没过**：偏短要调目标字数或换更强的模型，重复桥段要改细纲，
     * 占位正文要换 provider。只报 "repair" 用户只能反复点同一个按钮。
     */
    function runAdvice(failedChapters) {
      const rules = new Set();
      for (const chapter of failedChapters || []) {
        for (const rule of chapter.hard_failures || []) rules.add(rule);
        const error = String(chapter.error || '');
        if (error.includes('超时')) rules.add('timeout');
        if (error.includes('没有可用的模型') || error.includes('尚未选择')) rules.add('no-model');
        if (error.includes('JSON 不合法')) rules.add('bad-json');
      }
      const advice = [];
      if (rules.has('chapter_length')) {
        advice.push('字数没过：模型写得太短。换一个更强的模型，或把每章目标字数调小（细纲章数不变）。');
      }
      if (rules.has('repeat_span') || rules.has('cross_chapter_similarity')) {
        advice.push('和前面某章太像：细纲里的事件要写得更具体，别让它复用同一套桥段。');
      }
      if (rules.has('tier1_engineering_words') || rules.has('placeholder')) {
        advice.push('正文里混进了写作说明或占位标记：多半是模型没进入写手角色，换模型重试。');
      }
      if (rules.has('timeout')) {
        // 不提 NOVEL_DECON_TIMEOUT：那是引擎子进程的环境变量，用户在右栏里改不到。
        // 超时现在只是兜底（默认 900 秒，远大于正常耗时），撞上它说明端点卡住了。
        advice.push('模型超时：这个时长已经远超正常耗时，多半是端点卡住或网络断了。点一次「重启引擎」再试，或换一个模型。');
      }
      if (rules.has('no-model')) advice.push('还没有可用模型：先去「模型」页选一个。');
      if (rules.has('bad-json')) advice.push('模型返回的 JSON 结构不对：重试一次，仍失败就换模型。');
      return advice.length > 0 ? `。${advice.join(' ')}` : '';
    }

    /**
     * 屏幕顶部的返回条。
     *
     * 每个屏都必须有：以前只有正常渲染路径带返回，加载中态与出错态什么都不显示，
     * 用户点进一个加载失败的章节页就卡死在那里——只能关掉整个右栏标签页重进。
     * 返回是导航的兜底，任何状态都不能没有。
     */
    function BackBar({ label, onBack, disabled, extra }) {
      return h('div', { className: 'ns-backbar' },
        h('button', {
          className: 'ns-btn',
          'data-variant': 'ghost',
          onClick: onBack,
          disabled: !!disabled,
        }, label || '← 返回'),
        extra || null,
      );
    }

    /**
     * 删除项目：两次点击确认。
     *
     * 为什么不用 window.confirm：宿主右栏里 confirm 有可能被拦或看起来像没反应，
     * 而删除是不可撤销的（`store.delete` 直接 rmtree，没有回收站）。
     * 改成按钮自己变形——第一次点变成「确定删除？」，第二次才真删，
     * 5 秒内不点就自己缩回去。
     */
    function DeleteProjectButton({ projectId, title, busy, onDeleted }) {
      const [armed, setArmed] = React.useState(false);
      const [working, setWorking] = React.useState(false);
      const [error, setError] = React.useState('');
      const timer = React.useRef(null);

      React.useEffect(() => () => { if (timer.current) clearTimeout(timer.current); }, []);

      const arm = () => {
        setArmed(true);
        setError('');
        if (timer.current) clearTimeout(timer.current);
        timer.current = setTimeout(() => setArmed(false), 5000);
      };

      const fire = async () => {
        if (timer.current) clearTimeout(timer.current);
        setWorking(true);
        setError('');
        try {
          await request('DELETE', `projects/${encodeURIComponent(projectId)}`);
          setArmed(false);
          onDeleted(projectId);
        } catch (e) {
          setError(e.message);
          setArmed(false);
        } finally { setWorking(false); }
      };

      return h('div', { style: { marginTop: 8 } },
        h('div', { style: { display: 'flex', gap: 6, alignItems: 'center' } },
          h('button', {
            className: 'ns-btn',
            'data-variant': 'danger',
            disabled: busy || working,
            onClick: armed ? fire : arm,
            title: armed ? `再点一次就真的删掉《${title || projectId}》，删了找不回来` : '删除这本书',
          }, working ? '删除中…' : (armed ? '确定删除？再点一次' : '删除这本书')),
          armed
            ? h('button', {
              className: 'ns-btn',
              'data-variant': 'ghost',
              disabled: working,
              onClick: () => { if (timer.current) clearTimeout(timer.current); setArmed(false); },
            }, '取消')
            : null,
        ),
        h('div', { className: 'ns-dim', style: { marginTop: 4, fontSize: '10.5px' } },
          '删除会连正文、摘要、台账、版本历史一起删掉，没有回收站。'),
        error ? h('div', { className: 'ns-err', style: { marginTop: 6 } }, error) : null,
      );
    }

    /**
     * 单个骨架部件：折叠时一行摘要，展开后是完整字段的编辑表单。
     *
     * 为什么必须可编辑：`_generate` 产出的只是候选，里面有「陆沉（占位名，可改）」
     * 这种明显要改的字段，而 `_save_part` 是唯一能把候选变成 `human-confirmed`
     * 的通道。没有这个入口，用户面对占位名只能重开项目——而重开项目会把已经
     * 写好的正文一起丢掉。
     */
    function PartRow({ project, part, busy, onSaved }) {
      const [open, setOpen] = React.useState(false);
      const [values, setValues] = React.useState(null);
      const [working, setWorking] = React.useState('');
      const [error, setError] = React.useState('');
      const [note, setNote] = React.useState('');

      const state = stateOf(project, part);
      const draft = (project.draft || {})[part];
      const hasContent = Array.isArray(draft) ? draft.length > 0 : !!draft;
      const required = REQUIRED_PARTS.includes(part);
      let summary = required ? '未生成（必需）' : '不需要（可选）';
      if (hasContent) {
        if (part === 'chapters') summary = `${draft.length} 章`;
        else if (part === 'positioning') summary = draft.core_premise || draft.genre || '已生成';
        else if (part === 'protagonist') summary = draft.name || '已生成';
        else if (part === 'volume') summary = draft.volume_title || '已生成';
        else if (part === 'golden_finger') summary = draft.name || '已生成';
      }

      const toggle = () => {
        if (!open && PART_FIELDS[part]) {
          const next = {};
          for (const field of partFieldValues(part, draft)) next[field.key] = field.text;
          setValues(next);
          setNote('');
          setError('');
        }
        setOpen(!open);
      };

      const save = async () => {
        setWorking('save');
        setError('');
        setNote('');
        try {
          const body = partFromEdits(part, values || {});
          const updated = await request('PUT', `projects/${encodeURIComponent(project.meta.id)}/parts/${part}`, { content: body });
          void updated;
          setNote('已保存并标为「已人工确认」');
          if (onSaved) onSaved();
        } catch (e) {
          setError(e.message);
        } finally { setWorking(''); }
      };

      const locked = busy || !!working;
      const fields = PART_FIELDS[part];

      return h('div', { className: 'ns-part' },
        h('div', { className: 'ns-kv', style: { cursor: 'pointer' }, onClick: toggle },
          h('b', null, PART_LABEL[part] || part),
          h('span', { className: 'ns-chip', 'data-state': state || (hasContent ? 'draft' : (required ? 'missing' : 'optional')) },
            state ? STATE_LABEL[state] || state : hasContent ? '模型候选' : (required ? '必需' : '可选')),
          h('span', { className: 'ns-dim', style: { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, String(summary)),
          h('span', { className: 'ns-dim' }, open ? ' ▾' : ' ▸'),
        ),

        open
          ? h('div', { className: 'ns-part-body' },
              h('div', { className: 'ns-dim', style: { marginBottom: 6 } }, PART_HINT[part] || ''),
              fields
                ? fields.map(([key, label, kind]) => h('div', { className: 'ns-field', key },
                    h('div', { className: 'ns-field-label' }, label),
                    kind === 'list'
                      ? h('textarea', {
                          className: 'ns-textarea',
                          style: { minHeight: 64 },
                          value: values ? values[key] : '',
                          disabled: locked,
                          onChange: (event) => setValues({ ...values, [key]: event.target.value }),
                        })
                      : h('input', {
                          className: 'ns-input',
                          value: values ? values[key] : '',
                          disabled: locked,
                          onChange: (event) => setValues({ ...values, [key]: event.target.value }),
                        }),
                  ))
                : h('div', { className: 'ns-meta' },
                    `细纲共 ${(draft || []).length} 章。章号必须从 1 起连续——逐章改标题/节拍请在章节页或下面的「细纲候选」里做，`
                    + '这里只读，避免误改章号顺序。'),
              h('div', { style: { marginTop: 6, display: 'flex', gap: 6 } },
                fields
                  ? h('button', { className: 'ns-btn', 'data-variant': 'primary', onClick: save, disabled: locked },
                      working === 'save' ? '保存中…' : '保存并确认')
                  : null,
                h('button', { className: 'ns-btn', 'data-variant': 'ghost', onClick: toggle, disabled: locked }, '收起'),
              ),
              hasContent
                ? h('div', { className: 'ns-pre', style: { marginTop: 8 } }, partMarkdown(part, draft) || '（空）')
                : null,
              note ? h('div', { className: 'ns-meta' }, note) : null,
              error ? h('div', { className: 'ns-err' }, error) : null,
            )
          : null,
      );
    }

    function ProjectHome({ projectId, onBack, onOpenChapter, busy, onChanged, onDeleted }) {
      const [project, setProject] = React.useState(null);
      const [error, setError] = React.useState('');
      const [note, setNote] = React.useState('');
      const [working, setWorking] = React.useState('');
      const [from, setFrom] = React.useState('');
      const { provider, hasModel, modelLabel } = useProvider();
      const [to, setTo] = React.useState('');
      const [autoAccept, setAutoAccept] = React.useState(true);
      // 字数是否当硬门。默认关：用户的原话是「规则先不要定太死 先让我测试能不能
      // 生成就行（可以设置要求：比如字数要求什么的）」。默认关 = 写不够也入库并
      // 显示一条提示；打开 = 写不够就打回重写，可能一直写不出来。
      const [lengthGate, setLengthGate] = React.useState(false);
      const [skeletonCount, setSkeletonCount] = React.useState('30');
      const [skeletonNote, setSkeletonNote] = React.useState('');
      // 设定候选 / 细纲候选：引擎早就写好了（`plan_settings.py` 430 行、两条
      // `/plan/*` 端点 + 两条 `/plan/accept/*`），但插件里以前一个入口都没有，
      // 等于这三块能力对着右栏用户不存在。候选与确认必须分两步：
      // 引擎的语义是「候选不代笔」，生成只返回候选，确认才落库。
      const [settingPlan, setSettingPlan] = React.useState(null);
      const [outlinePlan, setOutlinePlan] = React.useState(null);
      // 两种看法：面板（可点可改）与 Markdown（整本一次看完）。
      // 用户要的是「二者选其一」，所以这里是个显式切换，不是并列两张卡——
      // 并列会让同一份数据在一屏里出现两遍，改完 A 不知道 B 刷没刷。
      const [viewMode, setViewMode] = React.useState(() => readViewMode());
      // 角色卡 / 剧情线：用户说「后续可以再单独添加一个设定模块 还有角色卡 剧情线什么的」。
      // 放在项目页折叠区内，不占主视线，但一进来就能看到有没有内容。
      const [showCharacters, setShowCharacters] = React.useState(false);
      const [showStoryline, setShowStoryline] = React.useState(false);
      // 正在跑的连写任务。**不能只靠这个 state**：它只在发起连写的那一次页面
      // 会话里有值，用户刷新页面、退出重进、或者从别处点回来，它都是 null，
      // 而引擎那边的任务还在跑。所以 load() 里会从 run 列表把它找回来。
      const [activeRun, setActiveRun] = React.useState(null);
      // 活进度（第几章、哪一步、已多久）：由轮询或恢复时拿到，单独存一份，
      // 这样即使 activeRun 来自「恢复」而不是「这次发起的」，也能显示。
      const [liveJob, setLiveJob] = React.useState(null);
      const pauseSent = React.useRef(false);

      const load = React.useCallback(() => {
        setError('');
        request('GET', `projects/${encodeURIComponent(projectId)}`)
          .then((value) => { setProject(value); })
          .catch((e) => { setError(e.message); });
      }, [projectId]);

      /**
       * 找回「正在跑的那一次连写」。
       *
       * 这是用户第三条需求的核心：他生成过慢时重新点生成，界面说「这个项目已经有
       * 一次连写在跑」，但他既看不到那次任务、也暂停不了。根因就是暂停入口挂在
       * 发起连写的那个页面实例的 useState 上。run 列表里带 `live` 标记，
       * 只要磁盘上还有在跑的任务，任何一次进入项目页都能重新接上。
       */
      const recoverActiveRun = React.useCallback(() => {
        request('GET', `projects/${encodeURIComponent(projectId)}/runs`)
          .then((value) => {
            const runs = (value && value.runs) || [];
            const running = runs.find((item) => item && item.live);
            if (!running) return;
            setActiveRun({
              runId: running.run_id,
              from: (running.job && running.job.from) || 0,
              to: (running.job && running.job.to) || 0,
              recovered: true,
            });
            setLiveJob(running.job || null);
          })
          .catch(() => { /* 找不回不是错误：下次轮询还会再试 */ });
      }, [projectId]);

      React.useEffect(() => { load(); recoverActiveRun(); }, [load, recoverActiveRun]);

      // 有活任务时按固定间隔刷新进度：引擎那侧一章要几分钟，2 秒一次足够。
      // 没有活任务就不轮询——空转请求只会把引擎日志刷满。
      React.useEffect(() => {
        if (!activeRun || !activeRun.runId) return undefined;
        let stopped = false;
        const tick = async () => {
          try {
            const job = await request('GET',
              `projects/${encodeURIComponent(projectId)}/runs/${encodeURIComponent(activeRun.runId)}`);
            if (stopped) return;
            setLiveJob(job);
            if (job.status !== 'running') {
              setActiveRun(null);
              setLiveJob(null);
              pauseSent.current = false;
              load();
              if (onChanged) onChanged();
            }
          } catch (e) {
            if (!stopped) setLiveJob({ status: 'unknown', error: e.message });
          }
        };
        const timer = setInterval(tick, POLL_INTERVAL_MS);
        tick();
        return () => { stopped = true; clearInterval(timer); };
      }, [activeRun, projectId, load, onChanged]);

      /**
       * 补骨架：generate → accept-skeleton。
       *
       * 两步都不能省。只 generate 的话五个部件全停在 draft，`is_usable()` 全部丢弃，
       * 后面每章都缺定位/主角/金手指——项目看起来「有骨架」，写出来的全是无根的正文。
       */
      const buildSkeleton = async () => {
        setWorking('骨架');
        setSkeletonNote('');
        setError('');
        try {
          const count = Number(skeletonCount);
          if (!Number.isInteger(count) || count < 1 || count > 999) {
            throw new Error('细纲章数必须是 1–999 的整数');
          }
          await request('POST', `projects/${encodeURIComponent(projectId)}/generate`, {
            provider,
            chapter_count: count,
          });
          let rejected = [];
          let accepted = [];
          try {
            const result = await request('POST', `projects/${encodeURIComponent(projectId)}/accept-skeleton`, {});
            accepted = (result && result.accepted) || [];
            rejected = (result && result.rejected) || [];
          } catch (e) {
            // 422 表示「没有任何部件过判据」，这是业务结果不是网络故障：
            // 骨架确实生成了，但没过验收，必须把逐条原因摆出来。
            const payload = e && e.payload;
            accepted = (payload && payload.accepted) || [];
            rejected = (payload && payload.rejected) || [];
            if (rejected.length === 0) throw e;
          }
          setSkeletonNote(rejected.length === 0
            ? `骨架已生成并验收（${count} 章，${accepted.length} 个部件入库）`
            : `骨架已生成，${accepted.length} 个部件入库，${rejected.length} 个没过验收：`
              + rejected.map((item) => `${PART_LABEL[item.part] || item.part}（${item.reason}）`).join('；'));
          load();
          if (onChanged) onChanged();
        } catch (e) {
          setSkeletonNote(`${e.message}${skeletonAdvice(e.message)}`);
        } finally { setWorking(''); }
      };

      if (error) {
        return h('div', null,
          h(BackBar, { label: '← 返回项目列表', onBack }),
          h('div', { className: 'ns-err' }, error),
        );
      }      if (!project) {
        // 加载中也要能返回：项目打不开时这是唯一出路。
        return h('div', null,
          h(BackBar, { label: '← 返回项目列表', onBack }),
          h('div', { className: 'ns-empty' }, '加载中…'),
        );
      }

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
          // 后端立刻回 202 + run_id，活儿在后台跑。同步等它跑完会撞插件的
          // 300 秒硬超时（实测 10 章真模型要 373 秒），于是界面报失败而其实全写完了。
          const started = await request('POST', `projects/${encodeURIComponent(projectId)}/runs`, {
            from: startValue,
            to: endValue,
            provider,
            auto_accept: autoAccept,
            length_gate: lengthGate,
          });
          const runId = started.run_id;
          if (!runId) throw new Error('引擎没有返回 run_id，无法跟踪进度');

          setActiveRun({ runId, from: startValue, to: endValue });
          let done = null;
          while (!done) {
            await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
            const job = await request('GET',
              `projects/${encodeURIComponent(projectId)}/runs/${encodeURIComponent(runId)}`);
            setLiveJob(job);
            const totalToDo = job.total || started.total || (endValue - startValue + 1);
            if (job.status === 'running') {
              // 进度必须说到「第几章、哪一步、已多久」：只写「连写中…」的话，
              // 用户面对一章几分钟的等待，只会以为卡死了。
              const progress = progressText(job);
              setNote((progress ? `正在写：${progress}` : `正在写：第 ${startValue}–${endValue} 章`)
                + `，已完成 ${job.written || 0}/${totalToDo}`
                + (job.failures ? `，失败 ${job.failures} 章` : '')
                + (pauseSent.current ? '（暂停请求已发出：这一章写完就停）' : ''));
              continue;
            }
            done = job;
          }
          setActiveRun(null);
          setLiveJob(null);
          pauseSent.current = false;

          const failed = (done.chapters || []).filter((ch) => ch.status !== 'committed');
          const stoppedEarly = done.status !== 'finished';
          // 只说「第 1 章 repair」等于什么都没说：repair 是闸门的判定名，
          // 用户既不知道哪条规则没过，也不知道下次该改提示词、换模型还是调字数。
          // 后端已经把每条硬门的 rule 与 detail 放在 hard_failures / error 里，
          // 这里必须带出来——否则用户只能反复点同一个按钮。
          setNote(`写了 ${done.written} 章${done.failures ? `，失败 ${done.failures} 章` : ''}`
            + (stoppedEarly ? '（中途停下）' : '')
            + (done.error ? `：${done.error}` : '')
            + (failed.length > 0
              ? '；' + failed.map((ch) => {
                const rules = (ch.hard_failures || []).join('、');
                const why = ch.error || rules || ch.verdict || ch.status;
                return `第 ${ch.order} 章 ${why}`;
              }).join('；')
              + runAdvice(failed)
              : ''));
          load();
          if (onChanged) onChanged();
        } catch (e) {
          setActiveRun(null);
          setLiveJob(null);
          pauseSent.current = false;
          setError(e.message);
        } finally { setWorking(''); }
      };

      /**
       * 暂停当前连写。
       *
       * 只发一次：引擎那边是「举手」语义（下一章开始前检查），重复发没有意义。
       * 也不立刻清掉 activeRun——任务其实还在跑最后一章，清掉按钮会让用户
       * 以为已经停了，然后看到进度条又动起来。
       */
      const pauseBatch = async () => {
        if (!activeRun || pauseSent.current) return;
        pauseSent.current = true;
        try {
          const result = await request('POST',
            `projects/${encodeURIComponent(projectId)}/runs/${encodeURIComponent(activeRun.runId)}/pause`, {});
          setNote((result && result.note) || '暂停请求已发出：当前这一章写完就停。');
        } catch (e) {
          pauseSent.current = false;
          setNote(`暂停失败：${e.message}`);
        }
      };

      /**
       * 生成「设定候选」并（可选）确认入库。
       *
       * 两步必须分开：`/plan/settings` 只返回候选、一个字都不写盘；
       * `/plan/accept/settings` 才把 entries 追加进 project.settings
       * （同名同类型不覆盖），并把 golden_finger 写进 draft。
       * 合成一步就剥夺了「看一眼再决定」——而那正是候选存在的理由。
       */
      const planSettings = async (accept) => {
        setWorking(accept ? '确认设定' : '设定候选');
        setNote('');
        setError('');
        try {
          if (!accept) {
            const result = await request('POST',
              `projects/${encodeURIComponent(projectId)}/plan/settings`, { provider });
            setSettingPlan(result);
            setNote('设定候选已生成（未入库）。看过觉得可用，点「确认设定」才写进项目。');
            return;
          }
          if (!settingPlan || !settingPlan.plan) throw new Error('先生成一次设定候选');
          const plan = settingPlan.plan;
          const body = { entries: plan.entries || [] };
          if (plan.golden_finger) body.golden_finger = plan.golden_finger;
          await request('POST',
            `projects/${encodeURIComponent(projectId)}/plan/accept/settings`, body);
          setSettingPlan(null);
          setNote('设定已入库：后续每章上下文都会带上它们。');
          load();
          if (onChanged) onChanged();
        } catch (e) {
          setNote(`设定候选失败：${e.message}`);
        } finally { setWorking(''); }
      };

      /**
       * 生成「细纲候选」并（可选）确认。
       *
       * 确认是逐章**整章替换** beats（候选是完整提案，不是增量），所以只提交
       * 候选里出现的章、且只提交有节拍的章——把整份 project 传回去会把没提到
       * 的章清空。
       */
      const planOutline = async (accept) => {
        setWorking(accept ? '确认细纲' : '细纲候选');
        setNote('');
        setError('');
        try {
          if (!accept) {
            const result = await request('POST',
              `projects/${encodeURIComponent(projectId)}/plan/outline`, { provider });
            setOutlinePlan(result);
            setNote('细纲候选已生成（未入库）。确认后会把对应章的节拍整章替换掉。');
            return;
          }
          if (!outlinePlan || !outlinePlan.plan) throw new Error('先生成一次细纲候选');
          const chapters = (outlinePlan.plan.chapters || [])
            .filter((item) => item && Array.isArray(item.beats) && item.beats.length > 0)
            .map((item) => ({ order: item.order, beats: item.beats }));
          if (chapters.length === 0) throw new Error('候选里没有任何节拍，没什么可确认的');
          await request('POST',
            `projects/${encodeURIComponent(projectId)}/plan/accept/outline`, { chapters });
          setOutlinePlan(null);
          setNote(`细纲已入库：${chapters.length} 章的节拍被替换。`);
          load();
          if (onChanged) onChanged();
        } catch (e) {
          setNote(`细纲候选失败：${e.message}`);
        } finally { setWorking(''); }
      };

      const switchView = (mode) => {
        setViewMode(mode);
        saveViewMode(mode);
      };

      /**
       * 复制整本 Markdown 到剪贴板。
       *
       * 走 `navigator.clipboard`，但要处理它不存在（非 https / 老内核）和
       * 被拒（用户没给权限）两种情况：失败时必须把文本留着让人自己选中复制，
       * 不能只弹一句「复制失败」然后什么都不给。
       */
      const copyMarkdown = async () => {
        const text = projectMarkdown(project);
        try {
          if (!navigator.clipboard || !navigator.clipboard.writeText) {
            throw new Error('这个环境不支持读剪贴板');
          }
          await navigator.clipboard.writeText(text);
          setNote(`已复制 ${text.length} 个字符的 Markdown。`);
        } catch (e) {
          setNote(`复制失败（${e.message}）：Markdown 已经显示在下面，可以直接全选复制。`);
        }
      };

      return h('div', null,
        h(BackBar, { label: '← 返回项目列表', onBack }),
        h('div', { className: 'ns-sec' },
          h('div', { className: 'ns-kv' }, h('b', null, '书名'), h('span', null, meta.title || '(无题)')),
          h('div', { className: 'ns-kv' }, h('b', null, '前提'), h('span', { className: 'ns-pre' }, project.premise || '（空）')),
          h('div', { className: 'ns-kv' }, h('b', null, '游标'), h('span', null, `已提交到第 ${cursor} 章 / 细纲 ${total} 章`)),
        ),

        // 两种看法放在最上面：它决定下面整页长什么样，用户必须先看到。
        // 复制按钮留在这一层，因为 Markdown 视图里最常干的事就是复制出去贴别处。
        h('div', { className: 'ns-sec' },
          h('div', { className: 'ns-form-row' },
            h('button', {
              className: 'ns-btn',
              'data-variant': viewMode === 'panel' ? 'primary' : 'ghost',
              onClick: () => switchView('panel'),
            }, '面板'),
            h('button', {
              className: 'ns-btn',
              'data-variant': viewMode === 'markdown' ? 'primary' : 'ghost',
              onClick: () => switchView('markdown'),
            }, 'Markdown'),
            viewMode === 'markdown'
              ? h('button', { className: 'ns-btn', 'data-variant': 'ghost', onClick: copyMarkdown }, '复制全部')
              : null,
          ),
          h('div', { className: 'ns-dim', style: { marginTop: 6 } },
            viewMode === 'markdown'
              ? '整本一次看完（设定、细纲、已写章节）。这里只读——改东西切回「面板」，两边读的是同一份 project.json。'
              : '可点可改。想一次看完整本、或复制到别处，切到「Markdown」。'),
        ),

        viewMode === 'markdown'
          ? h('div', { className: 'ns-sec' },
              h('div', { className: 'ns-pre', style: { whiteSpace: 'pre-wrap' } }, projectMarkdown(project)),
            )
          : null,

        // 面板视图的显示区块。Markdown 视图下整组隐藏——用户要的是「二者选其
        // 一」，两种看法同时铺在屏幕上，同一份数据出现两遍，改完一边不知道另一
        // 边刷没刷。「连写」是操作不是展示，所以留在这个分组外面。
        ...(viewMode === 'panel' ? [
        dropped.length > 0
          ? h('div', { className: 'ns-warn' },
              '以下部件有内容但状态不可用，不会注入后续章节的上下文：',
              h('div', { style: { marginTop: 4 } }, dropped.map((part) => PART_LABEL[part] || part).join('、')))
          : null,

        // 骨架为空时必须给出「生成骨架」按钮：没有它，这本书永远写不出正文
        // （章事务第一件事就是读细纲，细纲空 → 直接 400）。用户在这里看到的是
        // 五个「未生成」，除了重开项目没有任何出路——这是最典型的死路。
        total === 0
          ? h('div', { className: 'ns-card' },
              h('div', { className: 'ns-sec-title' }, '还没有骨架'),
              h('div', { className: 'ns-meta' },
                '这本书的细纲是空的，现在生成章节会被直接拒绝。先在这里补出骨架。'),
              h('div', { className: 'ns-form-row', style: { marginTop: 8 } },
                h('div', { className: 'ns-field' },
                  h('div', { className: 'ns-field-label' }, '细纲章数'),
                  h('input', {
                    className: 'ns-input',
                    value: skeletonCount,
                    disabled: locked,
                    placeholder: '30',
                    onChange: (event) => setSkeletonCount(event.target.value),
                  }),
                ),
              ),
              h('div', { style: { marginTop: 6, display: 'flex', gap: 6 } },
                h('button', { className: 'ns-btn', 'data-variant': 'primary', onClick: buildSkeleton, disabled: locked },
                  working === '骨架' ? '生成中…' : '生成骨架'),
                h('button', { className: 'ns-btn', 'data-variant': 'ghost', onClick: buildSkeleton, disabled: locked },
                  '重新生成（覆盖现有候选）'),
              ),
              skeletonNote ? h('div', { className: 'ns-warn' }, skeletonNote) : null,
            )
          : null,

        // 连写也在面板分组里。Markdown 视图的定位是「整本一次看完」的只读全景，
        // 写章是「干活」，切回面板再做——两个视图各管一件事，比混着放更好理解。
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
          // 字数要求是可选项，默认不拦。用户的原话：「规则先不要定太死 先让我测试
          // 能不能生成就行（可以设置要求：比如字数要求什么的 有没有可能是字数
          // 不达标导致一直不生成 这是不对的）」——所以默认「写不够也入库」，
          // 只有他主动勾上才打回重写。
          h('div', { className: 'ns-field' },
            h('div', { className: 'ns-field-label' }, '字数要求'),
            h('select', {
              className: 'ns-input',
              value: lengthGate ? 'strict' : 'loose',
              disabled: locked,
              onChange: (event) => setLengthGate(event.target.value === 'strict'),
            },
              h('option', { value: 'loose' }, '写不够也入库（显示字数提示）'),
              h('option', { value: 'strict' }, '写不够就打回重写（可能一直写不出来）'),
            ),
          ),
          h('div', { className: 'ns-meta' },
            `本次将写第 ${startValue}–${endValue} 章。每章都走章事务：过硬门才落盘，过不了就回滚并记台账。`),
          h('div', { style: { marginTop: 4 } }, providerHint(hasModel, modelLabel)),
          h('div', { style: { marginTop: 6, display: 'flex', gap: 6 } },
            h('button', { className: 'ns-btn', 'data-variant': 'primary', onClick: runBatch, disabled: locked },
              working === '连写' ? '连写中…' : `连写第 ${startValue}–${endValue} 章`),
            // 暂停只在有任务在跑时出现。它不是「中断」：一章的事务是原子的，
            // 硬掐会留下半截正文把上一版好内容冲掉，所以引擎只在两章之间停。
            activeRun
              ? h('button', {
                className: 'ns-btn',
                'data-variant': 'danger',
                disabled: pauseSent.current === true,
                onClick: pauseBatch,
              }, pauseSent.current ? '已请求暂停…' : '暂停')
              : null,
          ),
          // 用户的原话：「可以让用户手动暂停 遇到模型出错报错 而不是给自己一个
          // 超时时间 没必要」。所以这里要说清「停在哪、会不会丢」，
          // 否则点了暂停的人会担心已写好的章是不是白写了。
          activeRun
            ? h('div', { className: 'ns-meta' },
                '暂停在两章之间生效：当前这一章会写完并提交，不会留半截正文；已提交的章不受影响。')
            : null,
          // 活进度：第几章、哪一步、已多久。放在暂停按钮下面，因为用户点暂停
          // 之前最想知道的就是「现在到底在干嘛」。
          activeRun && liveJob
            ? h('div', { className: 'ns-progress' },
                h('div', { className: 'ns-progress-head' },
                  liveJob.status === 'running' ? '连写进行中' : `任务状态：${liveJob.status || '未知'}`),
                h('div', { className: 'ns-progress-body' },
                  progressText(liveJob) || '正在准备…'),
                h('div', { className: 'ns-progress-body' },
                  `已完成 ${liveJob.written || 0} 章`
                  + (liveJob.failures ? `，失败 ${liveJob.failures} 章` : '')
                  + (liveJob.total ? ` / 共 ${liveJob.total} 章` : '')),
                // 已提交章的字数提示：字数不在目标带内但照样入库了。
                // 必须显示，否则用户会以为「字数不达标所以一直不生成」。
                (liveJob.chapters || [])
                  .filter((ch) => (ch.advisories || []).length > 0)
                  .map((ch) => h('div', { key: `adv-${ch.order}`, className: 'ns-progress-advisory' },
                    `第 ${ch.order} 章已入库（${ch.cjk_chars} 字）：${(ch.advisories || []).join('；')}`)),
              )
            : null,
          note ? h('div', { className: 'ns-warn' }, note) : null,
        ),

        h('div', { className: 'ns-sec' },
          h('div', { className: 'ns-sec-title' }, '骨架部件'),
          h('div', { className: 'ns-dim', style: { marginBottom: 6 } },
            '点一行展开可改。保存后该部件标为「已人工确认」，会注入后续每一章的上下文。'),
          ['positioning', 'volume', 'protagonist', 'golden_finger', 'chapters'].map((part) =>
            h(PartRow, { key: part, project, part, busy: locked, onSaved: load }),
          ),
        ),

        // 设定候选 / 细纲候选：引擎有两条 planner（`plan_providers.py` 430 行）
        // 和四条端点，但插件以前一个入口都没有——能力对着用户不存在。
        // 卡片必须把「候选未入库」写清：这两块的确认是不可逆的（细纲是整章替换）。
        h('div', { className: 'ns-sec' },
          h('div', { className: 'ns-sec-title' }, '设定候选'),
          h('div', { className: 'ns-dim', style: { marginBottom: 6 } },
            '按当前前提补一批世界规则、人物、势力等设定条目。生成只是候选，点「确认设定」才会写进项目；同名同类型不会覆盖已有条目。'),
          h('div', { className: 'ns-form-row' },
            h('button', {
              className: 'ns-btn',
              'data-variant': 'ghost',
              onClick: () => planSettings(false),
              disabled: locked,
            }, working === '设定候选' ? '生成中…' : '生成设定候选'),
            settingPlan
              ? h('button', {
                  className: 'ns-btn',
                  onClick: () => planSettings(true),
                  disabled: locked,
                }, working === '确认设定' ? '写入中…' : '确认设定')
              : null,
            settingPlan
              ? h('button', {
                  className: 'ns-btn',
                  'data-variant': 'ghost',
                  onClick: () => setSettingPlan(null),
                  disabled: locked,
                }, '丢弃')
              : null,
          ),
          settingPlan
            ? h('div', { className: 'ns-pre', style: { marginTop: 8 } },
                planSettingsText(settingPlan.plan))
            : null,
          settingPlan && Array.isArray(settingPlan.knowledge) && settingPlan.knowledge.length > 0
            ? h('div', { className: 'ns-dim', style: { marginTop: 4 } },
                `这次参考了 ${settingPlan.knowledge.length} 条资料库条目。`)
            : null,
        ),

        h('div', { className: 'ns-sec' },
          h('div', { className: 'ns-sec-title' }, '细纲候选'),
          h('div', { className: 'ns-dim', style: { marginBottom: 6 } },
            '为已写好细纲的章补节拍（每拍场景 / 人物 / 事件 / 要不要埋伏笔）。确认是逐章整章替换节拍，替换前请自己看一遍。'),
          h('div', { className: 'ns-form-row' },
            h('button', {
              className: 'ns-btn',
              'data-variant': 'ghost',
              onClick: () => planOutline(false),
              disabled: locked || total === 0,
            }, working === '细纲候选' ? '生成中…' : '生成细纲候选'),
            outlinePlan
              ? h('button', {
                  className: 'ns-btn',
                  onClick: () => planOutline(true),
                  disabled: locked,
                }, working === '确认细纲' ? '写入中…' : '确认细纲')
              : null,
            outlinePlan
              ? h('button', {
                  className: 'ns-btn',
                  'data-variant': 'ghost',
                  onClick: () => setOutlinePlan(null),
                  disabled: locked,
                }, '丢弃')
              : null,
          ),
          total === 0
            ? h('div', { className: 'ns-dim', style: { marginTop: 6 } },
                '还没有细纲，先生成骨架。')
            : null,
          outlinePlan
            ? h('div', { className: 'ns-pre', style: { marginTop: 8 } },
                planOutlineText(outlinePlan.plan))
            : null,
        ),

        // 设定库：`project.settings` 里的条目（`/plan/accept/settings` 写入的那批）
        // 以前在插件里一个字都不显示——用户确认完设定，界面上什么都没变。
        h('div', { className: 'ns-sec' },
          h('div', { className: 'ns-sec-title' }, `设定库（${(project.settings || []).length}）`),
          h('div', { className: 'ns-dim', style: { marginBottom: 6 } },
            '确认过的世界观条目。它们是「参考」，不会强制写进每一章；不想要就整本不要，不影响写正文。'),
          h('div', { className: 'ns-pre' }, settingsText(project.settings)),
        ),

        // 角色卡 / 剧情线：折叠起来，因为它们是「查一眼」而不是「天天改」。
        // 默认收起还有个原因：角色卡与设定库有重叠（人物类型条目两边都出现），
        // 同时展开会让人以为数据重复了。
        h('div', { className: 'ns-sec' },
          h('div', { className: 'ns-form-row' },
            h('button', {
              className: 'ns-btn',
              'data-variant': showCharacters ? 'primary' : 'ghost',
              onClick: () => setShowCharacters(!showCharacters),
            }, `角色卡（${characterCards(project).length}）`),
            h('button', {
              className: 'ns-btn',
              'data-variant': showStoryline ? 'primary' : 'ghost',
              onClick: () => setShowStoryline(!showStoryline),
            }, `剧情线（${storylineRows(project).length}）`),
          ),
          showCharacters
            ? h('div', { className: 'ns-pre', style: { marginTop: 8 } }, charactersText(project))
            : null,
          showStoryline
            ? h('div', { className: 'ns-pre', style: { marginTop: 8 } }, storylineText(project))
            : null,
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
        // 注意是 `[]` 不是 `null`：`...(cond ? [...] : null)` 在 false 分支上会抛
        // 「object null is not iterable」。空数组展开等于什么都不插。
        ] : []),

        // 删除放在最后：它是破坏性操作，不该出现在用户一进项目就看到的位置。
        // 它也在面板分组外面：Markdown 视图下同样要能删。
        h('div', { className: 'ns-sec' },
          h('div', { className: 'ns-sec-title' }, '危险操作'),
          h(DeleteProjectButton, {
            projectId,
            title: meta.title,
            busy: locked,
            onDeleted: () => { if (onDeleted) onDeleted(projectId); },
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

    /**
     * 正文长度，口子与引擎 `_save_chapter` 保持一致：
     * `len(re.sub(r"\\s+", "", content))`——去掉所有空白后的字符数，标点算一个。
     *
     * 必须跟引擎同一口径：这里显示 2,431 字、保存后记录变成 2,398，用户会以为
     * 自己写的内容被吞了。引擎另有 CJK 口径（只数汉字）用于字数闸门，那是
     * 判据，不是给人看「改了多少」。
     */
    function textChars(content) {
      if (typeof content !== 'string') return 0;
      return content.replace(/\s+/g, '').length;
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

    function ContextPackView({ projectId, order, onClose, backLabel }) {
      const [pack, setPack] = React.useState(null);
      const [error, setError] = React.useState('');

      React.useEffect(() => {
        let cancelled = false;
        request('GET', `projects/${encodeURIComponent(projectId)}/chapters/${order}/context`)
          .then((value) => { if (!cancelled) setPack(value); })
          .catch((e) => { if (!cancelled) setError(e.message); });
        return () => { cancelled = true; };
      }, [projectId, order]);

      // 出错与加载中都必须有返回：上下文包拉不到时，用户不能卡在一个空白页上。
      if (error) {
        return h('div', null,
          h(BackBar, { label: backLabel || '← 返回章节', onBack: onClose }),
          h('div', { className: 'ns-err' }, error),
        );
      }
      if (!pack) {
        return h('div', null,
          h(BackBar, { label: backLabel || '← 返回章节', onBack: onClose }),
          h('div', { className: 'ns-empty' }, '加载上下文包…'),
        );
      }

      const blocks = [
        ['定位', pack.positioning],
        ['主角', pack.protagonist],
        ['金手指', pack.golden_finger],
        ['本章细纲', pack.chapter_outline],
      ];
      const dropped = Array.isArray(pack.dropped) ? pack.dropped : [];

      return h('div', null,
        h(BackBar, { label: backLabel || '← 返回章节', onBack: onClose }),
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
          h('button', { className: 'ns-btn', onClick: onClose }, '关闭'),
        ),
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
      // 「改过没保存」要能看出来：改稿时用户会切出去查资料再回来，
      // 没有脏标记的话，切走那一刻的输入是白写的，而他不会知道。
      const [savedText, setSavedText] = React.useState('');
      const [versions, setVersions] = React.useState(null);
      const [runs, setRuns] = React.useState(null);
      const [lint, setLint] = React.useState(null);
      // 笔法体检：比对的是「人类 67 本 5829 章」的节奏分位，与 lint 的
      // 词法指纹是两件事。分开存，免得一个按钮出两种结论让人误读。
      const [style, setStyle] = React.useState(null);
      // 并行候选：一次让模型写几版。默认 3——两版只够「A 还是 B」，
      // 三版才能看出模型在哪一版上真的把细纲接住了。
      const [candCount, setCandCount] = React.useState(3);
      const [candidates, setCandidates] = React.useState(null);
      const [working, setWorking] = React.useState('');
      const { provider, hasModel, modelLabel } = useProvider();

      const load = React.useCallback(() => {
        setError('');
        request('GET', `projects/${encodeURIComponent(projectId)}/chapters/${order}`)
          .then((value) => {
            setChapter(value);
            const content = (value && value.content) || '';
            setDraftText(content);
            setSavedText(content);
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
          h(BackBar, { label: '← 返回项目', onBack }),
          h('div', { className: 'ns-err' }, error),
        );
      }
      if (!chapter) {
        return h('div', null,
          h(BackBar, { label: '← 返回项目', onBack }),
          h('div', { className: 'ns-empty' }, '加载章节…'),
        );
      }
      if (showPack) {
        // 上下文包是章节页的子视图，返回目标是「回到章节」，不是「回项目」。
        return h(ContextPackView, {
          projectId,
          order,
          onClose: () => setShowPack(false),
          backLabel: '← 返回章节',
        });
      }

      const record = chapter.record || {};
      const chars = recordChars(record);
      const time = recordTime(record);
      const locked = busy || !!working;
      const dirty = draftText !== savedText;

      const generate = () => act('生成', async () => {
        const body = await request('POST', `projects/${encodeURIComponent(projectId)}/chapters/${order}/run`, { provider });
        const outcome = body.outcome || {};
        setNote(outcome.status === 'committed'
          ? `已提交：${outcome.verdict}，${outcome.cjk_chars} 字，尝试 ${outcome.attempts} 次`
          : `没过闸门（${outcome.verdict}）：正文未落盘，可看台账里的证据`);
        load();
      });

      const generateDraft = () => act('候选', async () => {
        await request('POST', `projects/${encodeURIComponent(projectId)}/chapters/${order}/generate`, { provider });
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
        setSavedText(draftText);
        setEditing(false);
        setNote(`已保存（人工编辑，状态 draft，${textChars(draftText)} 字）`);
        load();
      });

      const check = () => act('检查', async () => {
        const value = await request('GET', `projects/${encodeURIComponent(projectId)}/chapters/${order}/lint`);
        setLint(value);
      });

      // 笔法体检与「检查」分开两个按钮：词法指纹（破折号几个、有没有「不是X而是Y」）
      // 和节奏分布（段落多长、分句多碎）是两套判据，混在一个报告里用户分不清
      // 该改词还是该改节奏。
      const checkStyle = () => act('笔法', async () => {
        const value = await request('GET', `projects/${encodeURIComponent(projectId)}/chapters/${order}/style`);
        setStyle(value);
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

      // 进页面不自动拉候选：没生成过的时候那是一份空壳，白占一次请求；
      // 真生成过的话用户点一下就知道，比每次进章节都多跑一趟接口划算。
      const loadCandidates = () => act('拉候选', async () => {
        const value = await request('GET', `projects/${encodeURIComponent(projectId)}/chapters/${order}/candidates`);
        setCandidates(value);
        if (!value.exists) setNote('这一章还没生成过并行候选。点「再生成几版」或先选好数量。');
      });

      const generateCandidates = () => act('并写', async () => {
        const value = await request('POST', `projects/${encodeURIComponent(projectId)}/chapters/${order}/candidates`, {
          action: 'generate',
          provider,
          count: candCount,
        });
        setCandidates(value);
        setNote(`已生成 ${value.ok_count}/${value.requested} 版，${value.passed_count} 版过硬门（目标 ${value.target_chars} 字，耗时 ${value.elapsed_ms} ms）。正文还没落盘，挑一版再提交。`);
      });

      const selectCandidate = (index) => act('提交', async () => {
        const value = await request('POST', `projects/${encodeURIComponent(projectId)}/chapters/${order}/candidates`, {
          action: 'select',
          index,
          provider,
        });
        const selection = value.selection || {};
        setChapter(value);
        setDraftText((value && value.content) || '');
        // 服务端把候选产物整份塞进 body.candidates；补上 exists 才能继续当
        // 「已生成过」的卡片渲染（否则卡片会退回「还没生成过」的说明文案）。
        setCandidates(value.candidates ? { ...value.candidates, exists: true } : null);
        // 判定不是 pass 时把话说清楚：正文已经落盘了，但状态是 draft，
        // 用户需要知道「这一版进去的是待确认稿」而不是「已经定稿」。
        setNote(selection.verdict === 'pass'
          ? `已提交候选 #${selection.selected_index}：${selection.verdict}，${selection.cjk_chars} 字，状态 ${selection.status}`
          : `已提交候选 #${selection.selected_index}：判定 ${selection.verdict}，${selection.cjk_chars} 字，状态 ${selection.status}（未过硬门，需人工确认）`);
      });

      return h('div', null,
        h(BackBar, { label: '← 返回项目', onBack }),
        h('div', { className: 'ns-sec' },
          h('div', { className: 'ns-kv' }, h('b', null, '状态'), h('span', null, record.status || '未生成')),
          chars !== null ? h('div', { className: 'ns-kv' }, h('b', null, '字数'), h('span', null, `${chars} 字`)) : null,
          time ? h('div', { className: 'ns-kv' }, h('b', null, '更新'), h('span', null, time)) : null,
          record.model_id ? h('div', { className: 'ns-kv' }, h('b', null, '产出'), h('span', null, record.model_id)) : null,
        ),

        // 自评跟着 record 一起来，不需要按钮：它在生成时就已经写好了。
        // 放在最上面而不是折叠，是因为它回答的正是「这一章要不要重写」。
        record.review
          ? h('div', { className: 'ns-card' },
            h('div', { className: 'ns-sec-title' }, '模型自评'),
            h('div', { className: 'ns-pre' }, reviewText(record.review)),
            h('div', { className: 'ns-dim', style: { marginTop: 4 } },
              '这份自评只做记录，不会自动触发重写。觉得分数偏低就重新生成一次或手动改。'),
          )
          : null,
        h('div', { className: 'ns-actions' },
          h('button', { className: 'ns-btn', 'data-variant': 'primary', onClick: generate, disabled: locked },
            working === '生成' ? '生成中…' : '生成（过闸门）'),
          h('button', { className: 'ns-btn', onClick: generateDraft, disabled: locked },
            working === '候选' ? '产出中…' : '只产候选'),
          h('button', { className: 'ns-btn', 'data-variant': 'ghost', onClick: loadCandidates, disabled: locked }, '并行候选'),
          h('button', { className: 'ns-btn', onClick: generateCandidates, disabled: locked },
            working === '并写' ? '并发生成中…' : '再生成几版'),
          record.status && record.status !== 'user-confirmed'
            ? h('button', { className: 'ns-btn', onClick: confirm, disabled: locked }, '确认')
            : null,
          h('button', { className: 'ns-btn', 'data-variant': 'ghost', onClick: () => setShowPack(true), disabled: locked }, '上下文包'),
          h('button', { className: 'ns-btn', 'data-variant': 'ghost', onClick: check, disabled: locked }, '检查'),
          h('button', { className: 'ns-btn', 'data-variant': 'ghost', onClick: checkStyle, disabled: locked },
            working === '笔法' ? '体检中…' : '笔法'),
          h('button', { className: 'ns-btn', 'data-variant': 'ghost', onClick: loadVersions, disabled: locked }, '版本'),
          h('button', { className: 'ns-btn', 'data-variant': 'ghost', onClick: loadRuns, disabled: locked }, '台账'),
          h('button', { className: 'ns-btn', 'data-variant': 'ghost', onClick: () => setEditing(!editing), disabled: locked },
            editing ? '取消编辑' : '编辑'),
          h('button', { className: 'ns-btn', 'data-variant': 'ghost', onClick: onBack }, '返回项目'),
        ),
        // 把「这次用哪个模型」摆在按钮下面。用户报的「调了模型还是占位正文」，
        // 就是因为这里以前写死 fake，界面上又没任何地方说明。
        h('div', { style: { marginTop: 6 } }, providerHint(hasModel, modelLabel)),
        note ? h('div', { className: 'ns-warn' }, note) : null,

        editing
          ? h('div', { className: 'ns-card' },
            h('div', { className: 'ns-sec-title' },
              '编辑正文',
              dirty ? h('span', { className: 'ns-chip', 'data-state': 'draft', style: { marginLeft: 8 } }, '未保存') : null),
            h('div', { className: 'ns-dim', style: { marginBottom: 6 } },
              `${textChars(draftText)} 字（去空白）· 原 ${textChars(savedText)} 字`),
            h('textarea', {
              className: 'ns-input ns-textarea',
              value: draftText,
              onChange: (event) => setDraftText(event.target.value),
            }),
            h('div', { style: { marginTop: 6, display: 'flex', gap: 6 } },
              h('button', {
                className: 'ns-btn',
                'data-variant': 'primary',
                onClick: save,
                disabled: locked || !dirty,
              }, working === '保存' ? '保存中…' : '保存'),
              h('button', {
                className: 'ns-btn',
                'data-variant': 'ghost',
                onClick: () => {
                  // 有改动才问，没改动直接关：每次都弹确认会让人盲点「确定」。
                  if (dirty && !window.confirm('有改动还没保存，确定放弃？')) return;
                  setDraftText(savedText);
                  setEditing(false);
                },
              }, '取消'),
              h('button', {
                className: 'ns-btn',
                'data-variant': 'ghost',
                onClick: () => { setDraftText(savedText); },
                disabled: locked || !dirty,
              }, '还原'),
            ),
            h('div', { className: 'ns-dim', style: { marginTop: 6 } },
              '保存后这一章会标成 draft（人工编辑）并覆盖当前正文；旧稿仍可从「版本」回退。'),
          )
          : null,

        lint
          ? h('div', { className: 'ns-card' },
            h('div', { className: 'ns-sec-title' }, '检查结果'),
            h('div', { className: 'ns-pre' }, lintText(lint)),
          )
          : null,

        style
          ? h('div', { className: 'ns-card' },
            h('div', { className: 'ns-sec-title' }, '笔法体检'),
            h('div', { className: 'ns-pre' }, styleText(style)),
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

        candidates
          ? h('div', { className: 'ns-card' },
            h('div', { className: 'ns-sec-title' }, `并行候选（${(candidates.candidates || []).length}）`),
            h('div', { className: 'ns-form-row', style: { marginBottom: 8 } },
              h('div', { className: 'ns-field' },
                h('div', { className: 'ns-field-label' }, '版本数'),
                h('select', {
                  className: 'ns-input',
                  value: String(candCount),
                  disabled: locked,
                  onChange: (event) => setCandCount(Number(event.target.value)),
                },
                  [2, 3, 4, 5, 6].map((n) => h('option', { key: n, value: String(n) }, `${n} 版`)),
                ),
              ),
              h('div', { className: 'ns-field ns-grow' },
                h('div', { className: 'ns-field-label' }, '说明'),
                h('div', { className: 'ns-dim' }, candidates.exists
                  ? `目标 ${candidates.target_chars} 字 · 成功 ${candidates.ok_count}/${candidates.requested} 版 · 过硬门 ${candidates.passed_count} 版 · ${candidates.elapsed_ms} ms`
                  : '还没生成过：选好版本数点「再生成几版」。'),
              ),
            ),
            (candidates.candidates || []).length === 0
              ? h('div', { className: 'ns-dim' }, '还没有候选。')
              : (candidates.candidates || []).map((item) => {
                const gate = item.gate || {};
                const passed = !!gate.passed;
                const picked = candidates.selected_index === item.index;
                return h('div', {
                  key: item.index,
                  className: 'ns-item ns-cand',
                  'data-picked': picked ? '1' : undefined,
                },
                  h('div', { className: 'ns-cand-head' },
                    h('span', { className: 'ns-chip' }, `#${item.index}`),
                    item.status === 'ok'
                      ? h('span', { className: 'ns-badge', 'data-tone': passed ? 'ok' : 'bad' },
                        `${gate.verdict || '—'} · ${gate.cjk_chars || 0} 字`)
                      : h('span', { className: 'ns-badge', 'data-tone': 'bad' }, '生成失败'),
                    picked ? h('span', { className: 'ns-chip', 'data-state': 'auto-accepted' }, '已选中') : null,
                    h('span', { className: 'ns-grow' }),
                    item.status === 'ok'
                      ? h('button', {
                        className: 'ns-btn',
                        'data-variant': 'primary',
                        onClick: () => selectCandidate(item.index),
                        disabled: locked,
                      }, working === '提交' ? '提交中…' : '用这一版')
                      : null,
                  ),
                  item.status === 'ok'
                    ? h('div', { className: 'ns-cand-preview' }, item.preview || '（无预览）')
                    : h('div', { className: 'ns-err' }, item.error || '生成失败（原因未知）'),
                  // 硬门证据只列最要紧的一行：候选卡片是给读者挑稿用的，
                  // 不是台账——真要看全部证据点「台账」。
                  (gate.hard_failures || []).length > 0
                    ? h('div', { className: 'ns-dim' },
                      `硬门未过：${(gate.hard_failures || []).map((f) => f.rule).join('、')}`)
                    : null,
                );
              }),
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

    /**
     * 章节自评（ChapterSelfReview）的展示文本。
     *
     * 引擎在每章落盘时同时写了这份自评（`ManuscriptRecord.review`），字段是
     * `hook_strength` / `info_density` / `outline_followed` / `deviations` /
     * `notes` / `model_id` / `prompt_version`。**它只报告，不自动改写**——
     * 界面要做的只是把它摆出来，不能把它渲染成「已通过」或「已修复」。
     *
     * 为什么值得显示：以前右栏完全看不到 review（引擎自带网页反而会显示），
     * 于是「模型自己觉得这章钩子只有 2 分」这条信息在插件里根本不存在，
     * 用户只能从正文里猜。
     */
    function reviewText(review) {
      if (!review || typeof review !== 'object') return '';
      const lines = [];
      // 分数用 1–5 星而不是数字：这一栏是给人快速扫的，`钩子 2/5` 和
      // `钩子 ★★☆☆☆` 信息量相同，后者一眼能看出好不好。
      const stars = (score) => {
        const value = Math.max(0, Math.min(5, Math.round(Number(score) || 0)));
        return `${'★'.repeat(value)}${'☆'.repeat(5 - value)}`;
      };
      if (Number.isFinite(Number(review.hook_strength))) {
        lines.push(`钩子强度：${stars(review.hook_strength)}（${review.hook_strength}/5）`);
      }
      if (Number.isFinite(Number(review.info_density))) {
        lines.push(`信息密度：${stars(review.info_density)}（${review.info_density}/5）`);
      }
      if (typeof review.outline_followed === 'boolean') {
        lines.push(`是否按细纲推进：${review.outline_followed ? '是' : '否'}`);
      }
      const deviations = Array.isArray(review.deviations) ? review.deviations : [];
      if (deviations.length > 0) {
        lines.push(`偏离细纲（${deviations.length}）：`);
        for (const item of deviations) lines.push(`  - ${item}`);
      }
      if (review.notes) lines.push(`评语：${review.notes}`);
      // 产出方要标注：`rule:*` 是规则产物，不是模型真读过；不标会被当成模型意见。
      if (review.model_id) {
        const judge = String(review.model_id).startsWith('rule:')
          ? '规则判定（非模型自评）'
          : review.model_id;
        lines.push(`自评来源：${judge}${review.prompt_version ? ` · ${review.prompt_version}` : ''}`);
      }
      return lines.join('\n');
    }

    /**
     * 笔法体检展示。
     *
     * 措辞必须守住一条：这是**节奏分布信号**，不是「这一章是 AI 写的」的判定。
     * 人类小说单章与 AI 在单章上必然重叠（留出集实测单条误杀 2.2%-5.1%），
     * 说成判定会让用户去改本来没问题的正文。
     */
    function styleText(report) {
      if (!report || typeof report !== 'object') return '（无结果）';
      const lines = [];
      const base = report.baseline || {};
      if (report.version) lines.push(`规则版本：${report.version}`);
      if (Number.isFinite(report.cjk_chars)) lines.push(`字数：${report.cjk_chars}`);
      if (base.books) {
        lines.push(`基线：${base.books} 本 ${base.chapters} 章实测分位（留出 ${base.holdout_books} 本 ${base.holdout_chapters} 章验收）`);
      }
      if (report.score !== undefined) {
        const pct = Math.round((Number(report.score) || 0) * 100);
        lines.push(`越界占比：${pct}%（越界 >1 条时生成环节会带着证据重写一次）`);
      }
      const findings = Array.isArray(report.findings) ? report.findings : [];
      lines.push('');
      if (findings.length === 0) {
        lines.push('五项节奏判据全部落在人类分布内。');
      } else {
        for (const item of findings) {
          const arrow = item.direction === 'lo' ? '低于' : '高于';
          lines.push(`✗ ${item.metric} · 实测 ${item.value} · ${arrow}人类 ${item.bound} 线 ${item.limit}`);
          if (item.percentile) lines.push(`    人类 ${Number(item.percentile).toFixed(1)} 分位`);
          if (item.evidence) lines.push(`    例：${item.evidence}`);
        }
      }
      if (report.note) lines.push('', report.note);
      return lines.join('\n');
    }

    /** 台账展示：只列本章的，因为用户在章节页里最关心这一章为什么没过。 */
    function runsText(payload, order) {
      const groups = (payload && Array.isArray(payload.runs)) ? payload.runs : [];
      const lines = [];
      for (const group of groups) {
        for (const item of (group.chapters || [])) {
          if (order !== undefined && item.order !== order) continue;
          // 只有 committed 的记录才配显示 verdict：被回收成 failed 的记录里
          // gate_verdict 是章事务被杀之前写下的，跟最终结果无关，两个一起打印
          // 会读成「失败了但通过了」。
          const settled = item.status === 'committed';
          const head = [group.run_id, `第 ${item.order} 章`, item.status,
            settled ? item.verdict : '']
            .filter(Boolean).join(' · ');
          // 摘要来源必须显示：机械兜底只保证「不断档」，模型读过的摘要才有情节级信息。
          // 不显示的话，用户看到 10 章全 committed，不知道后面几章的上下文其实很薄。
          const digest = item.summary_source === 'model' ? '摘要由模型读过'
            : item.summary_source === 'mechanical' ? '摘要为机械兜底（上下文较薄）'
              : '';
          lines.push(`${head}${item.attempts ? ` · 尝试 ${item.attempts} 次` : ''}`
            + `${item.cjk_chars ? ` · ${item.cjk_chars} 字` : ''}${digest ? ` · ${digest}` : ''}`);
          // 台账里只写 "repair" 等于没写：附上每条硬门的实测说明，
          // 否则事后翻台账也看不出当时到底差多少、该改哪一处。
          for (const detail of (item.hard_failure_details || [])) {
            lines.push(`  - ${detail}`);
          }
          if (item.error) lines.push(`  - ${item.error}`);
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
      const [probe, setProbe] = React.useState(null);
      const [probing, setProbing] = React.useState(false);
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

      /**
       * 测当前下拉框里选的这个模型。
       *
       * 打的是插件的 `_models/probe`（直连宿主 llm，不经过引擎、不改任何设置），
       * 所以「试一下」不会留下任何配置副作用——这是它和「用这个模型」的根本区别。
       * 结果一律 200，通不通看 `value.ok`：用 5xx 表达的话 request() 会抛异常，
       * 宿主给的原始失败原因（401/额度/超时）就丢了。
       */
      const runProbe = async () => {
        if (!provider || !model) return;
        setProbing(true);
        setProbe(null);
        setError('');
        try {
          const value = await request('POST', '_models/probe', { provider, model });
          setProbe(value || { ok: false, failure: '没有返回结果' });
        } catch (e) { setError(e.message); } finally { setProbing(false); }
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
          disabled: probing || saving || busy || !provider || !model,
          onClick: () => { runProbe(); },
        }, probing ? '测…' : '测一下这个模型'),
        h('button', {
          className: 'ns-btn',
          'data-variant': 'ghost',
          disabled: saving || busy,
          onClick: () => { setProvider(''); setModel(''); save('', ''); },
        }, '恢复跟随 DSH 默认'),
      ));
      if (probe) {
        const tone = probe.ok ? (probe.note ? 'slow' : 'ok') : 'bad';
        const head = probe.ok
          ? `能通（${((probe.ms || 0) / 1000).toFixed(1)} 秒）${probe.sample ? `：${probe.sample}` : ''}`
          : `不通（${((probe.ms || 0) / 1000).toFixed(1)} 秒）${probe.failure ? `：${probe.failure}` : ''}`;
        form.push(h('div', { key: 'probe', className: 'ns-probe', 'data-tone': tone },
          h('div', null, head),
          probe.note ? h('div', { className: 'ns-meta' }, probe.note) : null,
        ));
      }

      return h('div', null,
        h(BackBar, { label: '← 返回项目列表', onBack }),
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
          h(ModelTips),
        ),
      );
    }

    /**
     * 模型选型指引。
     *
     * 这些结论全部来自 2026-11-04/05 的实测（`_scratch/probe_*.py`、走引擎连写），
     * 不是凭印象写的推荐。放这里是因为用户最容易踩的坑是「换了个模型，
     * 连写就失败」，而失败原因各不相同：有的根本不支持 JSON、有的是字数服从度差、
     * 有的端点偶发卡住。混在一起看就成了「这插件对别的模型都不行」。
     *
     * 措辞上刻意区分「不能用来写正文」与「能写但会偏短」——前者是能力问题，
     * 后者是服从度问题，混为一谈会让用户换掉一个本来够用的模型。
     */
    function ModelTips() {
      return h('div', { className: 'ns-tips' },
        h('div', { className: 'ns-sec-title', style: { marginTop: '10px' } }, '选型参考（实测，不是推荐榜）'),
        h('div', null,
          h('b', null, '写正文'), '：优先选 ',
          h('span', { className: 'ns-code' }, 'deepseek-flash'),
          ' 一类。实测一章 2600 字约 25–35 秒，字数服从度好。'),
        h('div', null,
          h('b', null, 'glm-5.3-flash'), '：能通，但系统性写不够字数——三档 max_tokens（默认/4096/8192）'
          + '实测只给 1311/1930/1218 字，全部 finish=stop（不是被截断，是没按要求写）。'
          + '拿它连写会被闸门按 2600±15% 反复打回。'),
        h('div', null,
          h('b', null, 'sensenova-6.8-flash-lite'), '：直连四组全部成功，但走引擎偶发卡到超时'
          + '（端点侧问题，不是插件）。可作备选，别当主力。'),
        h('div', null,
          h('b', null, 'qiniu/conatus-free'), '：免费额度有限流，连写会 429（free_campaign_global_limit）。'),
        h('div', { className: 'ns-meta' },
          '「测一下这个模型」只发一句「回复两个字：可用」，测的是通不通、快不快，'
          + '测不出字数服从度和长文稳定性——那些只能靠真写一章看出来。'),
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
      const [python, setPython] = React.useState('');
      const [error, setError] = React.useState('');
      const [note, setNote] = React.useState('');
      const [saving, setSaving] = React.useState(false);
      const touched = React.useRef(false);
      const touchedPython = React.useRef(false);

      const load = React.useCallback(() => {
        setError('');
        request('GET', '_settings')
          .then((value) => {
            setData(value);
            if (!touched.current) setWorkspace((value && value.workspace) || '');
            if (!touchedPython.current) setPython((value && value.python) || '');
          })
          .catch((e) => setError(e.message));
      }, []);

      React.useEffect(() => { load(); }, [load]);

      const save = async () => {
        setSaving(true);
        setError('');
        setNote('');
        try {
          const value = await request('PUT', '_settings', { workspace, python: python || null });
          setData(value);
          touched.current = false;
          touchedPython.current = false;
          setNote('已保存。引擎会用新工作区重启，之后列出的就是那个目录里的项目。');
          if (onSaved) onSaved(value);
        } catch (e) { setError(e.message); } finally { setSaving(false); }
      };

      const count = data && Number.isInteger(data.projectCount) ? data.projectCount : null;

      return h('div', null,
        h(BackBar, { label: '← 返回项目列表', onBack }),
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
              placeholder: 'D:\\novels',
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
        // 解释器路径单独一张卡：它跟工作区无关，混在一起会让用户以为两者有先后关系。
        h('div', { className: 'ns-card', style: { marginTop: 8 } },
          h('div', { className: 'ns-sec-title' }, 'Python 解释器'),
          h('div', { className: 'ns-meta' },
            '平时留空就行，插件会自己找（依次试 python / py -3 / python3），缺写作引擎时还会自动装。'),
          h('div', { className: 'ns-field', style: { marginTop: 8 } },
            h('div', { className: 'ns-field-label' }, '装在非常规位置时填绝对路径'),
            h('input', {
              className: 'ns-input',
              value: python,
              disabled: saving || busy,
              placeholder: 'C:\\Python311\\python.exe',
              onChange: (event) => { touchedPython.current = true; setPython(event.target.value); },
            }),
          ),
          h('div', { className: 'ns-meta' },
            '填了会优先用它；填错了也不会把插件卡死，会退回自动探测。改完要重启引擎才生效。'),
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

      // 引擎自动安装的进度。
      //
      // 从零装一次要 20–60 秒，慢网络几分钟。这段时间面板里什么都点不动，
      // 只显示「引擎未启动」会让用户以为插件坏了、去点重试、越点越乱。
      // 所以装的时候要明说在装、装到第几步，并自动轮询到装完为止。
      //
      // 这三个常量必须声明在下面的 useEffect 之前：依赖数组是在渲染期求值的，
      // 放到后面就是 TDZ 错误（Cannot access 'installing' before initialization）。
      const install = status && status.engineInstall ? status.engineInstall : null;
      const installing = !!(install && install.state === 'installing');
      const installFailed = !!(install && install.state === 'failed');

      // 装着的时候自己盯着，别让用户手动点刷新。
      //
      // 只在「正在装」时起定时器：常驻轮询会让面板每一秒都打一次引擎，
      // 而引擎平时没什么可变的。装完之后引擎会自己起来，这里多刷两次
      // 是为了拿到起来之后的版本与端口。
      React.useEffect(() => {
        if (!installing) return undefined;
        const timer = setInterval(() => {
          loadStatus();
          setRefreshKey((k) => k + 1);
        }, 2000);
        return () => clearInterval(timer);
      }, [installing, loadStatus]);

      const wrap = (action) => async () => {
        setBusy(true);
        setNote('');
        try { await action(); } catch (e) { setNote(e.message); } finally { setBusy(false); }
      };

      const engine = status
        ? status.running
          ? `引擎 ${status.ndeconVersion || '?'} · 端口 ${status.port}`
          : installing
            ? `正在装写作引擎（第 ${install.attempt || 1} 步）…装完会自动接上，不用点重启`
            : installFailed
              ? `写作引擎没装上：${install.hint || '原因未知'}`
              : `引擎未启动${status.lastError ? `：${status.lastError}` : ''}`
        : '引擎状态未知';

      // 引擎自己退出时，光显示「未启动」没用 —— 用户需要一条能自救的路。
      // 上次退出的退出码与 stderr 也一起摆出来，否则「无法连接引擎」这类报错
      // 只能靠猜（端口号早已失效，重启宿主才恢复，而问题往往只在子进程上）。
      // 主动停止（点「重启引擎」、改工作区）不该被当成崩溃报出来，
      // 否则用户会以为引擎不稳定。
      const exitHint = status && status.lastExit && !status.lastExit.intentional
        ? `上次退出：code=${status.lastExit.code}`
          + `${status.lastExit.signal ? ` signal=${status.lastExit.signal}` : ''}`
          + `${status.lastExit.stderr ? ` · ${status.lastExit.stderr.slice(-160)}` : ''}`
        : '';
      const engineDown = !!(status && !status.running);
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
          onDeleted: () => { setScreen({ name: 'list' }); setRefreshKey((k) => k + 1); },
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
          onDeleted: () => { setRefreshKey((k) => k + 1); },
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
            title: '重新拉起引擎进程（改了后端代码或引擎自己退出后用这个）',
            onClick: wrap(async () => {
              const result = await request('POST', '_restart', {});
              if (result && result.restarted === false) {
                // 重启失败是业务结果，不是请求失败：要显式说出来，
                // 否则用户看到「引擎未启动」只会以为按钮没生效。
                setNote(`引擎重启失败：${result.error || '原因未知'}`);
              }
              loadStatus();
              setRefreshKey((k) => k + 1);
            }),
            disabled: busy,
          }, '重启引擎'),
          h('button', {
            className: 'ns-btn',
            onClick: wrap(async () => { loadStatus(); setRefreshKey((k) => k + 1); }),
            disabled: busy,
          }, '刷新'),
        ),
        h('div', { style: { padding: '5px 10px', fontSize: '10.5px' }, className: 'ns-dim' },
          engine,
          status && status.lastError && status.running ? ` · ${status.lastError}` : '',
          engineDown && exitHint ? ` · ${exitHint}` : '',
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
            console.warn('[dsh-novel-agent] 打开右栏标签失败', error);
          }
        },
      }, '小说');
    }

    /* ------------------------------------------------------------------ */
    /* 注册                                                                */
    /* ------------------------------------------------------------------ */

    exports.name = 'dsh-novel-agent';
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
      ModelTips,
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
      styleText,
      reviewText,
      planSettingsText,
      planOutlineText,
      runsText,
      partFieldValues,
      partFromEdits,
      PartRow,
      BackBar,
      DeleteProjectButton,
      skeletonAdvice,
      runAdvice,
      progressText,
      elapsedText,
      partMarkdown,
      projectMarkdown,
      groupSettings,
      settingsText,
      characterCards,
      charactersText,
      storylineRows,
      storylineText,
      readViewMode,
      saveViewMode,
      PART_HINT,
      REQUIRED_PARTS,
      VIEW_MODE_KEY,
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
            { name: 'conversation.session.header.actions', id: 'dsh-novel-agent-entry', order: 56 },
            () => h(StudioEntry, { sidebar: native.sidebarRight }),
          ));
        });
      } catch (error) {
        // 静默吞掉等于「插件没装」，一定要留日志。
        console.warn('[dsh-novel-agent] 右栏 tab 注册失败', error);
      }
    };

    return module.exports;
  },
  });
} catch (error) {
  // 只吞「同一份代码被注册了两次」这一种。其它错误（语法、缺 API）必须继续抛，
  // 否则插件静默失效，用户只会看到右栏空着，查不出原因。
  if (!isDuplicateRegistration(error)) throw error;
  console.warn(
    '[dsh-novel-agent] 同一份 client 代码被页面执行了两次（改名后旧包名还在启动清单里），'
      + '已忽略第二次注册。重启一次 DSH 宿主即可彻底清掉。',
  );
}
