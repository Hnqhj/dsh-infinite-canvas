/**
 * 无限画布 —— DSH 客户端（浏览器）半。
 *
 * 纯 JS、无构建：只认 `window.__ModuleLoader__.load({ id, factory })`，
 * `require('react')` 由页面自己的模块表提供（不装第二份 React）。
 *
 * ## 它注册了什么
 *
 * 一个**原生右侧栏 tab 类型**（`kind: 'canvas'`），两阶段：
 *
 *   ① `ctx.sidebarRightTabs.register({ id, kind, title, guide, keepMounted })` —— 类型声明
 *   ② `ctx.slots.register('sidebar.right.pane.tab', key: id)`                     —— tab 正文
 *   ③ `ctx.slots.register('sidebar.right.pane.tab.title', key: id)`               —— chip 上的图标
 *
 * `id` 是这套东西在 tab 系统里的身份，也必须是 ②③ 的 `key`。加上 `guide` 条目，
 * 「画布」会和「工作区文件 / 新建终端 / 浏览器」并排出现在右侧栏的引导页上 ——
 * 这是 DSH 自己的入口惯例，不另造按钮。
 *
 * ## 正文为什么是 iframe
 *
 * 画布是 Vue 3 + Vue Flow，DSH 客户端插件是 React + 无构建。两者塞进同一个
 * 文档树要处理样式互相污染、两套响应式系统共存的挂载/卸载时机 —— 而没有一条
 * 收益。iframe 换来三件事：
 *
 *  - **样式隔离**（画布那 33 份上游 CSS 不会碰到 DSH 的任何一个类名）；
 *  - **同源**（由宿主半的 `/api/dsh-canvas/embed/*` 发出来，localStorage 有稳定
 *    origin，画布的项目存档不会每次重开就丢，也不需要 CORS）；
 *  - **尺寸自适应免费**（iframe 变了，内部窗口就变了，画布的 ResizeObserver 直接
 *    收到通知 —— 右栏那种"拖宽但不重挂载"的场景自己不用管）。
 *
 * DSH 自带的浏览器 tab 用的也是 `<iframe>`（桌面端是 `<webview>`），所以这条路
 * 不是绕开框架，而是框架自己的做法。
 *
 * ## 命令到达时画布没开怎么办
 *
 * iframe 没挂载 = 没人在轮询 = 命令会一直等到超时。所以这里有一个**哨兵**：
 * 画布没开时每 2.5 秒读一次宿主的 `/status`（纯读，不会消费任何命令），
 * 发现队列里有新命令就按配置把画布 tab 打开，iframe 一起来就把命令领走。
 * 用 `/status` 而不是别的接口，是因为"看一眼"和"取走"必须是两件事。
 * ## 主题怎么跟 DSH 走
 *
 * DSH 的偏好是三态（`light` / `dark` / `system`），但 DOM 上只留**解析后**的
 * 结果：`body[data-ds-dark-theme]` 有值就是深色，外加 `html { color-scheme }`。
 * （出处：`dsh-client-ui-theme` 与 `dsh-client-ui-layout` 的 README。）
 *
 * 本文件做两件事：
 *  ① 把 `body[data-ds-dark-theme]` 翻译成 iframe 认得的 `light` / `dark`；
 *  ② 把父页面 body 上**已解析**的 `--dsw-*` token 值一并送过去。
 *
 * 为什么要送 token 而不是在 iframe 里另写一套：官方文档写明「token 样式表是
 * 颜色值的唯一权威来源，设计系统中缺失的值会有意不补入」。自己复刻一套浅色
 * 看着像，但和 DSH 实际解析出来的值只会在某个色阶上不一致 —— 那就不叫"一致"。
 *
 * 主题变化**只发消息，不重建 iframe**：重建会把画布里的卡片、视口、选中全清掉。
 */
window.__ModuleLoader__.load({
    id: 'dsh-infinite-canvas',
    factory(require) {
        const React = require('react');
        const h = React.createElement;
        const { useEffect, useMemo, useRef, useState } = React;

        /** 词典命名空间。 */
        const NS = 'infinite-canvas';
        /** 这个实现的身份；同时也是两处正文注册的 key。**不要**改成包名以外的东西。 */
        const TAB_ID = 'dsh-infinite-canvas';
        /** tab 类型名（页类型按 kind 打开，没有 patterns）。 */
        const TAB_KIND = 'canvas';
        /** 宿主半的路由前缀。 */
        const API = '/api/dsh-canvas';
        /**
         * 画布页面。同源，所以可以用相对路径。
         *
         * 这是 **Poiesis / NexusVault 的真画布**（上游 `apps/web/src/views/CanvasView.vue`
         * 与它的整个闭包），由 `build/` 单独构建产出，见 `build/overlay/src/main.ts`。
         * 不是占位页 —— 占位页在 P1 迁移时已经删掉了。
         */
        const EMBED_URL = `${API}/embed/index.html`;
        /**
         * 退避间隔：**只在挂起式等待不成立时**才用它（宿主半还是老版本、请求失败、
         * 或画布已经开着没必要挂请求）。
         *
         * 挂起式生效时这里几乎用不上：请求打到服务端就被留在那儿，直到真有命令，
         * 命令一到立刻回来 —— 那是用的 Server 那边的等待，不是这边的定时器。
         */
        const SENTINEL_BACKOFF_MS = 2_500;
        /**
         * 一次挂起往返如果快过这个数，说明服务端**没有**真的挂住我们（老版本宿主半
         * 会把 `hold` 当没看见，直接回快照）。那种情况下必须用上面的退避，否则
         * 「立刻返回 → 立刻再问」会打成每秒几十次的热循环。
         */
        const MIN_HOLD_MS = 250;
        /** 自动开过一次之后的冷却，避免命令连发时反复抢焦点。 */
        const AUTO_OPEN_COOLDOWN_MS = 6_000;
        /** 超过这个时间还没收到画布的 ready，就认为出问题并给出诊断。 */
        const READY_TIMEOUT_MS = 4_000;
        /** `autoOpened` 集合的上限；超出后丢掉较早的一半。 */
        const AUTO_OPENED_MAX = 200;
        /** 与画布页面约定的 postMessage 标识。 */
        const MESSAGE_SOURCE = 'dsh-canvas';
        /** 父页面往画布发消息时的标识。 */
        const HOST_SOURCE = 'dsh-canvas-host';

        /* ── 词典 ─────────────────────────────────────────────────────────── */

        const zh = {
            'tab.title': '画布',
            'guide.title': '画布',
            'guide.description': '无限画布：卡片、分镜、素材摊在一张可平移缩放的板上，对话能直接操控它',
            'frame.title': '无限画布',
            'diagnostic.title': '画布脚本没有回应',
            'diagnostic.hint': '常见原因：接口被信任栅栏拦下（403）、画布静态包没打进去、或脚本抛错。iframe 文档里的文字在下面。',
            'diagnostic.lost': '画布脚本失去了响应',
            'diagnostic.lostHint': '命令通道还是通的，但画布已经把它的处理器注销了 —— 面板被重新挂载过，或者画布内部抛了错。',
            'diagnostic.transport': '画布连不上命令通道',
            'diagnostic.transportHint': '下面是通道自己报的最后一处故障。命令现在发不进去，面板里的手动操作不受影响。',
            'diagnostic.health': '轮询 {polls} · 已应答 {answered} · 错误 {errors} · 在途 {inFlight}',
        };
        const en = {
            'tab.title': 'Canvas',
            'guide.title': 'Canvas',
            'guide.description': 'Infinite canvas: cards, storyboards and assets on a pannable board that the conversation can drive',
            'frame.title': 'Infinite canvas',
            'diagnostic.title': 'The canvas script did not respond',
            'diagnostic.hint': 'Likely causes: the route is blocked by the trust gate (403), the embed bundle is missing, or the script threw. The raw iframe text is below.',
            'diagnostic.lost': 'The canvas stopped responding',
            'diagnostic.lostHint': 'The channel is still up, but the canvas has unregistered its handler — the panel remounted, or something threw inside it.',
            'diagnostic.transport': 'The canvas cannot reach the command channel',
            'diagnostic.transportHint': 'The last failure reported by the channel itself is below. Commands cannot get through; manual work inside the panel is unaffected.',
            'diagnostic.health': 'polls {polls} · answered {answered} · errors {errors} · in flight {inFlight}',
        };

        /** 拿不到宿主 translator 时的兜底：按页面语言在 zh / en 之间二选一。 */
        function fallbackT() {
            const language = `${document.documentElement.lang || navigator.language || 'en'}`.toLowerCase();
            const dict = language.startsWith('zh') ? zh : en;
            return (key) => dict[key] ?? en[key] ?? key;
        }

        /* ── 跨实例的运行时状态 ───────────────────────────────────────────── */

        /**
         * 模块级而不是组件级：哨兵要知道"屏幕上有几个画布 tab 活着"，
         * 这个事实横跨所有实例，放进任何单个组件的 state 里都会读到过期的值。
         */
        const runtime = {
            /** 已挂载的画布 tab 正文数。>0 表示 iframe 自己在轮询。 */
            mounted: 0,
            /** 已经为哪些 requestId 触发过自动打开。 */
            autoOpened: new Set(),
            /** 自动打开的冷却截止时间戳。 */
            cooldownUntil: 0,
            /** 探测到的会话标识（诊断用）。 */
            sessionId: null,
            /** 最近一次 `/status` 快照（诊断用）。 */
            lastStatus: null,
            /**
             * 我们已经见过的命令计数 —— 挂起式等待的游标。
             *
             * 没有它，服务端就不知道"这条命令你处理过了"，只要队列里还有东西就
             * 立刻回答，两边会互相追着打成热循环。语义和长轮询的 cursor 一样。
             */
            since: 0,
        };

        /* ── 主题跟随 ─────────────────────────────────────────────────────── */

        /**
         * DSH 用 `body[data-ds-dark-theme]` 表示深色 —— 属性挂在 **body** 上，
         * 不是 html，也不是 `data-theme`。（出处：`dsh-client-ui-theme` 的
         * README「主题呈现」段 + `dsh-client-ui-layout` 的呈现器实现：宿主把解析后
         * 的快照投影成 `html { color-scheme }` + `body[data-ds-dark-theme]`
         * + body 上的内联 `--dsw-*` 变量。）
         *
         * 注意 DSH 的偏好是**三态**（`light` / `dark` / `system`），而 DOM 上
         * 只留下**解析后**的结果：`system` 在这里已经变成 light 或 dark 了。
         * 所以这里只问"现在是深是浅"，不试图还原用户选了哪一态。
         */
        function detectTheme() {
            // ① 官方落点：body 上的属性就是权威答案。
            if (document.body?.hasAttribute('data-ds-dark-theme') === true) return 'dark';

            // ② 显式标记（自家页面 / 旧版本 DSH 的兜底）。
            const root = document.documentElement;
            const explicit = root.dataset?.theme ?? root.dataset?.colorScheme;
            if (explicit === 'dark') return 'dark';
            if (explicit === 'light') return 'light';

            // ③ 没有属性就量背景亮度 —— 深色分支可能只体现为一张深色背景。
            try {
                const background = getComputedStyle(document.body).backgroundColor;
                const match = /rgba?\(([^)]+)\)/.exec(background);
                if (match !== null) {
                    const parts = match[1].split(',').map((value) => Number.parseFloat(value));
                    const [r = 255, g = 255, b = 255, a = 1] = parts;
                    if (Number.isFinite(r) && a > 0.5) {
                        const luminance = (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
                        return luminance < 0.5 ? 'dark' : 'light';
                    }
                }
            } catch {
                /* 量不到就往下走 */
            }
            // ④ 最后问系统。注意这是**兜底**而不是"system 态"：DSH 的 system
            //    已经在 ① 被解析掉了，走到这里说明 DOM 上没有任何线索。
            return window.matchMedia?.('(prefers-color-scheme: dark)')?.matches === true ? 'dark' : 'light';
        }

        /**
         * `--dsw-static-*` 的完整名单（77 个，实测自 app.asar 的 dsh-client-ui-theme）。
         *
         * **整层搬，不按需挑** —— 理由见 `readDswTokens()` 里的注释：
         * alias 层的值是指向 static 的 `var()` 引用，缺了 static 就断链。
         * 这层全是字面量（0 个引用），搬起来没有解析深度问题。
         *
         * 若将来 DSH 增删 static token：改这里，或者干脆改成从 body 上枚举
         * （`Array.from(getComputedStyle(body))` 不给自定义属性名，
         * 所以只能靠 `document.styleSheets` 遍历规则 —— 那就过度设计了，暂不做）。
         */
        const STATIC_TOKEN_NAMES = [
                "--dsw-static-amber-100", "--dsw-static-amber-400", "--dsw-static-amber-500", "--dsw-static-amber-600",
                "--dsw-static-amber-900", "--dsw-static-blue-100", "--dsw-static-blue-300", "--dsw-static-blue-400",
                "--dsw-static-blue-450", "--dsw-static-blue-50", "--dsw-static-blue-500", "--dsw-static-blue-50p",
                "--dsw-static-blue-600", "--dsw-static-blue-75", "--dsw-static-blue-800", "--dsw-static-blue-900",
                "--dsw-static-blue-950", "--dsw-static-deepseek-100", "--dsw-static-deepseek-200", "--dsw-static-deepseek-300",
                "--dsw-static-deepseek-400", "--dsw-static-deepseek-450", "--dsw-static-deepseek-50", "--dsw-static-deepseek-500",
                "--dsw-static-deepseek-600", "--dsw-static-deepseek-700-delete", "--dsw-static-deepseek-800", "--dsw-static-deepseek-900",
                "--dsw-static-green-100", "--dsw-static-green-400", "--dsw-static-green-500", "--dsw-static-green-500-a08",
                "--dsw-static-green-500-a12", "--dsw-static-green-900", "--dsw-static-neutral-00", "--dsw-static-neutral-100",
                "--dsw-static-neutral-1000", "--dsw-static-neutral-150", "--dsw-static-neutral-200", "--dsw-static-neutral-250",
                "--dsw-static-neutral-300", "--dsw-static-neutral-400", "--dsw-static-neutral-50", "--dsw-static-neutral-500",
                "--dsw-static-neutral-550", "--dsw-static-neutral-600", "--dsw-static-neutral-700", "--dsw-static-neutral-800",
                "--dsw-static-neutral-850", "--dsw-static-neutral-900", "--dsw-static-neutral-bluish-00", "--dsw-static-neutral-bluish-100",
                "--dsw-static-neutral-bluish-1000", "--dsw-static-neutral-bluish-150", "--dsw-static-neutral-bluish-200", "--dsw-static-neutral-bluish-300",
                "--dsw-static-neutral-bluish-400", "--dsw-static-neutral-bluish-50", "--dsw-static-neutral-bluish-500", "--dsw-static-neutral-bluish-60",
                "--dsw-static-neutral-bluish-600", "--dsw-static-neutral-bluish-700", "--dsw-static-neutral-bluish-75", "--dsw-static-neutral-bluish-750",
                "--dsw-static-neutral-bluish-800", "--dsw-static-neutral-bluish-850", "--dsw-static-neutral-bluish-875", "--dsw-static-neutral-bluish-900",
                "--dsw-static-neutral-bluish-950", "--dsw-static-red-100", "--dsw-static-red-400", "--dsw-static-red-400-a12",
                "--dsw-static-red-50", "--dsw-static-red-500", "--dsw-static-red-600", "--dsw-static-red-600-a08",
                "--dsw-static-red-900",
        ];
        const STATIC_TOKEN_COUNT = STATIC_TOKEN_NAMES.length;

        /**
         * 把 DSH 自己的 token 读出来，交给 iframe 用。
         *
         * **为什么要传而不是让 iframe 自己声明一套**：官方文档写得很直接 ——
         * 「token 样式表是颜色值的唯一权威来源，设计系统中缺失的值会有意不补入」。
         * 也就是说任何"看起来差不多"的复刻都是错的（用户说深浅切换时要跟 DSH 一致，
         * 跟一个自己猜的浅蓝不一致就等于没跟）。父页面就是那份权威样式表的宿主，
         * `getComputedStyle` 读出来的就是**当前主题解析后的最终值**。
         *
         * ⚠️ **必须连 `--dsw-static-*` 一起送，只送 alias 层是错的。**
         * DSH 的 token 是两层：alias 层的值是 `var(--dsw-static-*)` **引用**
         * （例：`--dsw-alias-bg-base: var(--dsw-static-neutral-bluish-00)`），
         * static 层才是字面量（`#fff` / `#151517`）。只送 alias 层，iframe 里
         * 那个 `--dsw-static-*` 不存在 → `var()` 断链 → **整条声明失效**。
         *
         * 实测（`.workbuddy/verify/probe-var-chain.mjs`）：
         *   两层都在              → `rgb(255, 255, 255)`  ✓
         *   只送 alias            → `rgba(0, 0, 0, 0)`    声明被丢弃
         *   只送 alias + 兜底值    → `rgb(21, 21, 23)`     吃兜底 = 看着像"没生效"
         * 最后一行正是本插件一度出现的现象：工具条恒为深色 #151517，
         * 而 DSH 已经是浅色 —— **看起来像主题桥没写，其实是少送了一层。**
         *
         * 好在 static 层**全是字面量、0 个引用**（实测 77/77），所以整层搬过来
         * 不会带来新的解析深度，不用递归解引用。
         *
         * 读不到的 token 一律不给（返回对象里就没有那个键），让 iframe 侧的
         * `var(--dsw-*, 兜底)` 走兜底 —— 宁可退回一个明确的备选，也不要塞一个
         * 空串进去让 `var()` 整体失效。
         */
        function readDswTokens() {
            /** 语义别名：只列真正用到的那些，不是全量 113 个。 */
            const ALIAS = [
                'bg-base', 'bg-layer-1', 'bg-layer-2', 'bg-layer-3', 'bg-overlay',
                'bg-module-platform', 'bg-skeleton', 'bg-mask-1', 'bg-mask-2', 'bg-mask-3',
                'label-primary', 'label-secondary', 'label-tertiary',
                'border-l1', 'border-l2', 'border-l3', 'border-l4',
                'state-business-primary', 'state-danger', 'brand-primary',
                'focus-ring-color', 'focus-ring-width',
            ];
            const computed = getComputedStyle(document.body);
            const tokens = {};
            for (const name of ALIAS) {
                // 焦点环那两个是组件级 token，不在 body 上；读不到就跳过。
                const value = computed.getPropertyValue(`--dsw-alias-${name}`).trim();
                if (value !== '') tokens[`--dsw-alias-${name}`] = value;
            }

            /**
             * static 层：**整层搬**，不按需挑。
             *
             * 为什么不按 alias 的引用去反查（那样更"省"）：alias 层可能通过
             * `color-mix()` 间接引用多个 static，一次反查要解析表达式；
             * 而整层只有 77 个字面量，一次读空成本可以忽略。
             * 顺带的好处：将来 shell 那边新增一个 `--dsw-static-*` 用途，
             * 不改这里也能用上。
             */
            for (let i = 0; i < STATIC_TOKEN_COUNT; i += 1) {
                const name = STATIC_TOKEN_NAMES[i];
                if (name === undefined) continue;
                const value = computed.getPropertyValue(name).trim();
                if (value !== '') tokens[name] = value;
            }

            // 等宽栈也一起带过去，诊断条里的 iframe 原文要用。
            const mono = computed.getPropertyValue('--dsw-font-family-mono').trim();
            if (mono !== '') tokens['--dsw-font-family-mono'] = mono;
            return tokens;
        }

        /**
         * 订阅主题变化。
         *
         * **观察目标必须是 body 而不是 documentElement** —— `data-ds-dark-theme`
         * 挂在 body 上。这是从旧实现（盯着 html 的 `data-theme`）改过来的关键点。
         *
         * 三条路一起看：body 属性变化（用户改设置）、系统偏好变化（system 态下
         * 跟操作系统走），外加一个低频轮询兜底（防某些变更只走 CSSOM 不改属性）。
         */
        function subscribeTheme(listener) {
            let current = detectTheme();
            listener(current, readDswTokens());
            let tokens = readDswTokens();
            const check = () => {
                const next = detectTheme();
                const nextTokens = readDswTokens();
                const changed = next !== current
                    || JSON.stringify(nextTokens) !== JSON.stringify(tokens);
                if (!changed) return;
                current = next;
                tokens = nextTokens;
                listener(next, nextTokens);
            };
            const observer = new MutationObserver(check);
            observer.observe(document.body, {
                attributes: true,
                attributeFilter: ['data-ds-dark-theme', 'class', 'style'],
            });
            const media = window.matchMedia?.('(prefers-color-scheme: dark)');
            media?.addEventListener?.('change', check);
            const timer = setInterval(check, 2_000);
            return () => {
                observer.disconnect();
                media?.removeEventListener?.('change', check);
                clearInterval(timer);
            };
        }

        /* ── 会话标识 ─────────────────────────────────────────────────────── */

        /**
         * 解析这次 tab 属于哪个会话。
         *
         * 三个来源依次试：owner props、`useTabInfo()` 的 tab 记录、父页面地址。
         * **拿不到就返回 `undefined`，不编一个** —— 宿主半的桥把"缺标识"当成
         * "不限定会话"，命令照样送达；编一个错的反而会让命令永远匹配不上。
         */
        function resolveSessionId(props, tab) {
            const candidates = [
                props?.sessionId,
                tab?.sessionId,
                tab?.navigation?.params?.sessionId,
            ];
            for (const candidate of candidates) {
                if (typeof candidate === 'string' && candidate.trim() !== '') return candidate.trim();
            }
            const fromPath = /\/session\/([^/?#]+)/.exec(window.location.pathname);
            if (fromPath !== null) return decodeURIComponent(fromPath[1]);
            return undefined;
        }

        /* ── 图标 ─────────────────────────────────────────────────────────── */

        /** chip 上的 16px 图标：两侧虚线的画布导轨 + 两块内容。 */
        function CanvasIcon() {
            return h('svg', {
                width: 16, height: 16, viewBox: '0 0 24 24', fill: 'none',
                'aria-hidden': 'true', style: { display: 'block' },
            },
                h('rect', {
                    x: 1.75, y: 4.25, width: 20.5, height: 15.5, rx: 2.5,
                    stroke: 'currentColor', strokeWidth: 1.4, strokeDasharray: '3 3', opacity: 0.7,
                }),
                h('rect', { x: 4.5, y: 7.25, width: 6.5, height: 9.5, rx: 1.2, fill: 'currentColor', opacity: 0.9 }),
                h('rect', {
                    x: 13, y: 9.25, width: 6.5, height: 5.5, rx: 1.2,
                    stroke: 'currentColor', strokeWidth: 1.4, opacity: 0.85,
                }));
        }

        /**
         * 从传输层的状态快照里挑出**界面真的会用到**的那几项。
         *
         * 挑出来而不是整体存：`pollOnce()` 每趟结束都 `emit` 一次，空载时约每 180
         * 毫秒一条消息；整体存进 state 的话，这块面板会跟着每 0.18 秒重渲染一次 ——
         * 而它关心的其实只是「画布还在不在」和「有没有出错」。
         *
         * 关键项没变时**返回原对象**：`setState` 拿到同一个引用就会跳过重渲染。
         *
         * @param payload - 传输层 `status()` 的快照。
         * @param previous - 上一次的健康摘要（首次为 `null`）。
         */
        function reduceHealth(payload, previous) {
            if (payload === null || typeof payload !== 'object') return previous;
            const next = {
                canvasReady: payload.canvasReady === true,
                lastError: typeof payload.lastError === 'string' && payload.lastError !== ''
                    ? payload.lastError
                    : null,
                errors: Number(payload.errors) > 0 ? Number(payload.errors) : 0,
                inFlight: Array.isArray(payload.inFlight) ? payload.inFlight.length : 0,
                // 计数类只在有人看的时候才需要精确 —— 顺手带上，不参与比较。
                polls: Number(payload.polls) || 0,
                answered: Number(payload.answered) || 0,
            };
            if (previous !== null
                && previous.canvasReady === next.canvasReady
                && previous.lastError === next.lastError
                && previous.errors === next.errors
                && previous.inFlight === next.inFlight) {
                return previous;
            }
            return next;
        }

        /**
         * 决定现在该显示哪一条诊断（没有则返回 `null`）。
         *
         * 三种情况，按"谁更能解释现状"排序：
         *
         *   ① 曾经 ready 过、但传输层说画布的处理器没了 —— 面板重挂载或画布内部报错。
         *      这是**最容易漏的一类**：它不像"白屏"那样一眼看出来，语义是"页面看着
         *      还正常，但对话里的命令一条都进不来"。
         *   ② 到点还没 ready —— 走原来的 iframe 原文诊断。
         *   ③ 传输层自己报错了 —— 把通道原文的故障端出来。
         */
        function pickDiagnostic({ ready, health, failure, t }) {
            // ① 画布曾经在，但处理器没了。**不给 iframe 原文**：那时候画面往往还是
            //    好好的，`describeFrame` 抓下来的只会是一堆画布自己的 UI 文案 ——
            //    那不是证据，是噪音。
            if (ready && health !== null && health.canvasReady === false) {
                return { title: t('diagnostic.lost'), hint: t('diagnostic.lostHint'), detail: null, health };
            }
            // ② 从来没 ready 过才有意义；ready 之后 `failure` 会被清掉。
            if (!ready && failure !== null) {
                return { title: t('diagnostic.title'), hint: t('diagnostic.hint'), detail: failure, health };
            }
            if (health !== null && health.lastError !== null) {
                return { title: t('diagnostic.transport'), hint: t('diagnostic.transportHint'), detail: health.lastError, health };
            }
            return null;
        }

        /* ── tab 正文 ─────────────────────────────────────────────────────── */

        /**
         * 画布 tab 的正文。
         *
         * 只有一个全幅 iframe，外加一条**只在出问题时才出现**的诊断条。
         * 没有额外的页头页脚：画布自己有一行状态栏，加一层就重复了。
         */
        function Body(props) {
            const frameRef = useRef(null);
            const [ready, setReady] = useState(false);
            /**
             * 传输层自己上报的健康状况：`canvasReady` / `lastError` / `errors` / `inFlight`。
             *
             * 它每完成一趟轮询就 `emit` 一次（空载时大约每 180 毫秒一条消息），所以
             * **只挑真正会在界面上出现的那几项存**，且变了才更新 —— 见 `reduceHealth`。
             */
            const [health, setHealth] = useState(null);
            /**
             * 帧诊断：到点还没 ready 时去看一眼 iframe，把里面的原文抓下来。
             * 与 `health` 分开，是因为它是一次性的快照，而后者是持续订阅。
             */
            const [failure, setFailure] = useState(null);
            const t = typeof props?.t === 'function' ? props.t : fallbackT();

            /**
             * `useTabInfo()` 由框架注入，是这个席位的契约的一部分，所以无条件调用
             * （放在 `useMemo` 里或加条件分支都会破坏 hook 顺序）。读不到内容时
             * 只是拿不到会话标识，不影响画布本身。
             */
            let info = {};
            try {
                info = props.useTabInfo() ?? {};
            } catch {
                info = {};
            }

            const sessionId = resolveSessionId(props, info.tab);

            /**
             * iframe 的地址**只在会话变化时重建**。
             *
             * 主题刻意不进依赖：主题变化走 postMessage，重建 iframe 会把画布里的
             * 卡片、视口、选中全部清掉 —— 那是"换个皮肤就把你的画布弄没了"。
             * 首帧仍带一个 `theme=` 参数，让 iframe 在脚本跑起来之前就知道该
             * 用哪套色（否则会有一闪而过的错色）。
             */
            const src = useMemo(() => {
                const url = new URL(EMBED_URL, window.location.origin);
                url.searchParams.set('theme', detectTheme());
                if (sessionId !== undefined) url.searchParams.set('sessionId', sessionId);
                return url.toString();
                // eslint-disable-next-line react-hooks/exhaustive-deps
            }, [sessionId]);

            // 计入/退出挂载计数：哨兵靠它判断要不要自动开面板。
            useEffect(() => {
                runtime.mounted += 1;
                runtime.sessionId = sessionId ?? null;
                return () => {
                    runtime.mounted = Math.max(0, runtime.mounted - 1);
                };
            }, [sessionId]);

            // 画布上报就绪与运行状态。
            useEffect(() => {
                const onMessage = (event) => {
                    // 只认同源消息：iframes 之外的另一个窗口也能往这里 postMessage，
                    // 伪造一条 `ready` 就能让诊断条无声消失。
                    if (event.origin !== window.location.origin) return;
                    const data = event.data;
                    if (data === null || typeof data !== 'object') return;
                    if (data.source !== MESSAGE_SOURCE) return;
                    if (data.type === 'ready') {
                        setReady(true);
                        // 超时那次抓下的帧原文已经过期 —— 留着它，画布恢复之后
                        // 还会挂着一条早就对不上现状的诊断。
                        setFailure(null);
                        return;
                    }
                    // 函数式更新：effect 因此不必依赖 `health`，监听器也就不会
                    // 随着每一条 status 消息反复卸载重装。
                    if (data.type === 'status') setHealth((prev) => reduceHealth(data.payload, prev));
                };
                window.addEventListener('message', onMessage);
                return () => window.removeEventListener('message', onMessage);
            }, []);

            // 主题与 DSH token 实时同步。**不重建 iframe**，只发消息 ——
            // 重建会把画布里的卡片、视口、选中全部清掉。
            useEffect(() => subscribeTheme((theme, tokens) => {
                frameRef.current?.contentWindow?.postMessage(
                    { source: HOST_SOURCE, type: 'theme', payload: { theme, tokens } },
                    '*',
                );
            }), []);

            // 到点还没 ready 就去看一眼 iframe 里到底是白屏、错误页还是别的什么。
            // 这是 P0 阶段最值钱的一段代码：它把"没反应"变成"能读到原因"。
            useEffect(() => {
                if (ready) return undefined;
                const timer = setTimeout(() => {
                    setFailure(describeFrame(frameRef.current));
                }, READY_TIMEOUT_MS);
                return () => clearTimeout(timer);
            }, [ready]);

            // 该显示哪一条诊断（没有则 `null`）。用 `useMemo` 是因为「要不要显示」
            // 由四个状态共同决定，而它们的变化频率差得很远。
            const diagnostic = useMemo(
                () => pickDiagnostic({ ready, health, failure, t }),
                [ready, health, failure, t],
            );

            return h('div', { style: { position: 'absolute', inset: 0, display: 'flex', flexDirection: 'column' } },
                h('iframe', {
                    ref: frameRef,
                    src,
                    title: t('frame.title'),
                    // 同源是刻意要求：读 iframe 文档做诊断、以及开局的 theme 参数都靠它。
                    style: { flex: '1 1 auto', width: '100%', height: '100%', border: 0, display: 'block', background: 'transparent' },
                }),
                diagnostic === null ? null : h('div', {
                    // 用色全部走 DSH 自己的 --dsw-* 别名，兜底值取自官方深色调色板
                    //（bg-base #151517 / border-l2 #ffffff1f / state #f25a5a）。
                    // 注意 token 名是 --dsw-* 而不是 --dsh-*：--dsh-* 是几何与字号
                    // 命名空间（--dsh-frame-* / --dsh-content-font-size / --dsh-scrollbar-*），
                    // 颜色一律 --dsw-*。写错前缀不会报错，只会静默退回兜底色。
                    style: {
                        flex: 'none',
                        borderTop: '1px solid var(--dsw-alias-border-l2, rgba(255,255,255,.12))',
                        background: 'var(--dsw-alias-bg-base, #151517)',
                        color: 'var(--dsw-alias-label-primary, #f9fafb)',
                        padding: '10px 12px',
                        fontSize: 13,
                        lineHeight: 1.6,
                    },
                },
                    h('div', { style: { display: 'flex', alignItems: 'center', gap: 6 } },
                        // 状态点用语义状态色，和 DSH 自己的错误提示同一套 token。
                        h('span', {
                            'aria-hidden': 'true',
                            style: {
                                width: 6, height: 6, borderRadius: '50%', flex: 'none',
                                background: 'var(--dsw-alias-state-danger, #f25a5a)',
                            },
                        }),
                        h('span', { style: { fontWeight: 500 } }, diagnostic.title)),
                    h('div', {
                        // 次级文字用 label-secondary 而不是 opacity —— 前者跟着主题走，
                        // 后者在浅色下会变得偏淡。
                        style: {
                            color: 'var(--dsw-alias-label-secondary, #cfd3d6)',
                            marginTop: 3, fontSize: 12,
                        },
                    }, diagnostic.hint),
                    diagnostic.health === null ? null : h('div', {
                        // 传输层自己的计数。它平时是隐形的，只有出错时才值得占一行 ——
                        // 「轮询多少次、应答了多少」恰恰是判断"管子到底断在哪"的依据。
                        style: {
                            color: 'var(--dsw-alias-label-secondary, #cfd3d6)',
                            marginTop: 3, fontSize: 12,
                            fontFamily: 'var(--dsw-font-family-mono, ui-monospace, monospace)',
                        },
                    }, healthSummary(t, diagnostic.health)),
                    diagnostic.detail === null ? null : h('pre', {
                        style: {
                            margin: '8px 0 0', padding: '8px 10px', maxHeight: 140, overflow: 'auto',
                            fontSize: 11, lineHeight: 1.6, whiteSpace: 'pre-wrap', wordBreak: 'break-all',
                            fontFamily: 'var(--dsw-font-family-mono, ui-monospace, monospace)',
                            color: 'var(--dsw-alias-label-secondary, #cfd3d6)',
                            background: 'var(--dsw-alias-bg-layer-1, #232324)',
                            border: '1px solid var(--dsw-alias-border-l1, rgba(255,255,255,.06))',
                            // 官方圆角尺度：xs 4 / sm 8 / md 12 / lg 16 / panel 28
                            borderRadius: 'var(--dsw-radius-xs, 4px)',
                        },
                    }, diagnostic.detail)));
        }

        /** 把传输层的计数排成一行可读文字。词典里的 `{polls}` 这类占位在此落地。 */
        function healthSummary(t, health) {
            return t('diagnostic.health')
                .replace('{polls}', String(health.polls))
                .replace('{answered}', String(health.answered))
                .replace('{errors}', String(health.errors))
                .replace('{inFlight}', String(health.inFlight));
        }

        /**
         * 把 iframe 的现状描述成一句人话。
         *
         * 同源才能读到 `contentDocument`；读不到就如实说读不到 —— 不要假装看到了。
         */
        function describeFrame(frame) {
            if (frame === null || frame === undefined) return '没有 iframe 元素。';
            try {
                const doc = frame.contentDocument;
                if (doc === null) return 'iframe 文档不可读（跨源）。';
                const text = (doc.body?.textContent ?? '').trim();
                if (text === '') return `iframe 文档已加载但内容为空（状态 ${doc.readyState}）。`;
                return text.slice(0, 400);
            } catch (error) {
                return `读取 iframe 文档失败：${error instanceof Error ? error.message : String(error)}`;
            }
        }

        /* ── chip 标题 ────────────────────────────────────────────────────── */

        function Title() {
            return h('span', { style: { display: 'inline-flex', alignItems: 'center', gap: 5 } }, h(CanvasIcon));
        }

        /* ── 哨兵：命令到了但画布没开，就把它叫起来 ─────────────────────────── */

        /**
         * 记下这批 requestId 并返回"有没有新的"。
         *
         * 记在 `autoOpened` 里而不是"看队列非空" —— 否则一条没人处理的命令会让
         * 哨兵每 2.5 秒抢一次焦点，直到超时为止。
         */
        function takeFresh(queued) {
            const fresh = queued.filter((item) => !runtime.autoOpened.has(item.requestId));
            if (fresh.length === 0) return false;
            for (const item of fresh) runtime.autoOpened.add(item.requestId);
            if (runtime.autoOpened.size > AUTO_OPENED_MAX) {
                const keep = [...runtime.autoOpened].slice(-Math.floor(AUTO_OPENED_MAX / 2));
                runtime.autoOpened = new Set(keep);
            }
            return true;
        }

        function apply(ctx) {
            ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'infinite-canvas: dictionaries');
            const t = ctx.locale.bind(NS);

            // ① 类型声明：一份没有运行时钩子的静态注册。
            ctx.effect(() => ctx.sidebarRightTabs.register({
                id: TAB_ID,
                kind: TAB_KIND,
                title: () => t('tab.title'),
                // 让画布出现在右栏的引导页上，与"工作区文件 / 新建终端 / 浏览器"并排。
                guide: [{
                    id: TAB_ID,
                    kind: TAB_KIND,
                    title: () => t('guide.title'),
                    description: () => t('guide.description'),
                }],
                // 切 tab、切会话都不重挂载 —— 画布里的视口和卡片不能被一次误点清掉。
                keepMounted: true,
            }), 'infinite-canvas: tab type');

            // ② 正文：keyed slot，key 必须等于 ①的 id。
            ctx.effect(() => ctx.slots.inject('sidebar.right.pane.tab', () => ctx.slots.register({
                name: 'sidebar.right.pane.tab',
                key: TAB_ID,
                locale: NS,
                inject: () => ({ t }),
            }, Body)), 'infinite-canvas: tab body');

            // ③ chip 标题：只在前面加一枚图标，文字仍用打开时捕获的标题。
            ctx.effect(() => ctx.slots.inject('sidebar.right.pane.tab.title', () => ctx.slots.register({
                name: 'sidebar.right.pane.tab.title',
                key: TAB_ID,
                locale: NS,
                inject: () => ({ t }),
            }, Title)), 'infinite-canvas: tab title');

            // ④ 哨兵。`/status` 是纯读端点，问多少次都不会把命令消费掉，
            //    所以"看一眼"和"取走"是两件事，不存在竞态。
            //
            //    **挂起式而不是定时轮询。** 命令没来的话，请求一直挂在服务端；
            //    命令一到服务端立刻回答，我们立刻去开面板。原来的做法是从固定的
            //    2.5 秒间隔里碰运气 —— 平均白等 1.25 秒，而整个冷路径总共才 12 秒，
            //    这一块是最贵也最没必要的开支。请求量还从每分钟 24 次降到 3 次。
            ctx.effect(() => {
                let stopped = false;
                let timer = null;
                /** 下一次出发的时刻。一次只挂一个请求，由服务端替我们等待。 */
                const schedule = (delayMs) => {
                    if (stopped) return;
                    timer = setTimeout(() => { void tick(); }, Math.max(0, delayMs));
                };

                const tick = async () => {
                    if (stopped || runtime.mounted > 0) {
                        // 画布开着，iframe 自己在长轮询；隔一会儿再看，不必挂请求。
                        if (!stopped) schedule(SENTINEL_BACKOFF_MS);
                        return;
                    }
                    if (Date.now() < runtime.cooldownUntil) {
                        schedule(runtime.cooldownUntil - Date.now());
                        return;
                    }
                    let payload;
                    const started = Date.now();
                    try {
                        const response = await fetch(
                            `${API}/status?hold=1&since=${runtime.since}`,
                            { cache: 'no-store' },
                        );
                        if (!response.ok) {
                            // 宿主半还没挂上（或已被卸载），下次再说。
                            schedule(SENTINEL_BACKOFF_MS);
                            return;
                        }
                        payload = await response.json();
                    } catch {
                        schedule(SENTINEL_BACKOFF_MS);
                        return;
                    }
                    if (stopped) return;

                    runtime.lastStatus = payload;
                    const seq = Number(payload?.seq);
                    if (Number.isFinite(seq) && seq > runtime.since) runtime.since = seq;

                    const queued = Array.isArray(payload?.queued) ? payload.queued : [];
                    const fresh = takeFresh(queued);
                    const cost = Date.now() - started;

                    if (!fresh && cost < MIN_HOLD_MS) {
                        // 服务端没真的挂住我们 —— 多半是宿主半还是旧版本（`hold`
                        // 参数被当成没看见）。退回定时轮询的节奏，别打成热循环。
                        schedule(SENTINEL_BACKOFF_MS);
                        return;
                    }
                    if (!fresh || payload?.autoOpenPanel !== true) {
                        schedule(0);
                        return;
                    }
                    runtime.cooldownUntil = Date.now() + AUTO_OPEN_COOLDOWN_MS;
                    try {
                        ctx.sidebarRight.openTab(TAB_KIND, {});
                    } catch (error) {
                        // 自动打开是便利，不是正确性；失败就留给 `canvas_ping` 的
                        // 超时文案去解释，不能让它把插件弄崩。
                        console.warn(`[dsh-canvas] 自动打开画布失败：${String(error)}`);
                    }
                    schedule(AUTO_OPEN_COOLDOWN_MS);
                };

                // 初次不必抢：真有命令时服务端会立刻回答，早出发的价值只在于早建立连接。
                schedule(0);
                return () => {
                    stopped = true;
                    if (timer !== null) clearTimeout(timer);
                };
            }, 'infinite-canvas: auto-open sentinel');
        }

        return {
            name: 'infinite-canvas-client',
            inject: ['slots', 'locale', 'sidebarRightTabs', 'sidebarRight'],
            apply,
        };
    },
});
