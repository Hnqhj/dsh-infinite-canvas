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
        /** 哨兵轮询间隔：只为"要不要自动开面板"服务，不需要快。 */
        const SENTINEL_INTERVAL_MS = 2_500;
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
        };
        const en = {
            'tab.title': 'Canvas',
            'guide.title': 'Canvas',
            'guide.description': 'Infinite canvas: cards, storyboards and assets on a pannable board that the conversation can drive',
            'frame.title': 'Infinite canvas',
            'diagnostic.title': 'The canvas script did not respond',
            'diagnostic.hint': 'Likely causes: the route is blocked by the trust gate (403), the embed bundle is missing, or the script threw. The raw iframe text is below.',
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

        /* ── tab 正文 ─────────────────────────────────────────────────────── */

        /**
         * 画布 tab 的正文。
         *
         * 只有一个全幅 iframe，外加一条**只在出问题时才出现**的诊断条。
         * 没有额外的页头页脚：画布自己有一行状态栏，加一层就重复了。
         */
        function Body(props) {
            const frameRef = useRef(null);
            const readyRef = useRef(false);
            const [diagnostic, setDiagnostic] = useState(null);
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

            // 画布上报就绪与状态。
            useEffect(() => {
                const onMessage = (event) => {
                    const data = event.data;
                    if (data === null || typeof data !== 'object') return;
                    if (data.source !== MESSAGE_SOURCE) return;
                    if (data.type === 'ready') {
                        readyRef.current = true;
                        setDiagnostic(null);
                    }
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
                const timer = setTimeout(() => {
                    if (readyRef.current) return;
                    setDiagnostic(describeFrame(frameRef.current));
                }, READY_TIMEOUT_MS);
                return () => clearTimeout(timer);
            }, []);

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
                        h('span', { style: { fontWeight: 500 } }, t('diagnostic.title'))),
                    h('div', {
                        // 次级文字用 label-secondary 而不是 opacity —— 前者跟着主题走，
                        // 后者在浅色下会变得偏淡。
                        style: {
                            color: 'var(--dsw-alias-label-secondary, #cfd3d6)',
                            marginTop: 3, fontSize: 12,
                        },
                    }, t('diagnostic.hint')),
                    h('pre', {
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
                    }, diagnostic)));
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
            ctx.effect(() => {
                const tick = async () => {
                    if (runtime.mounted > 0) return;          // 画布开着，iframe 自己在轮询
                    if (Date.now() < runtime.cooldownUntil) return;
                    let payload;
                    try {
                        const response = await fetch(`${API}/status`, { cache: 'no-store' });
                        if (!response.ok) return;
                        payload = await response.json();
                    } catch {
                        return;                                // 宿主半还没挂上，下次再说
                    }
                    runtime.lastStatus = payload;
                    const queued = Array.isArray(payload?.queued) ? payload.queued : [];
                    if (!takeFresh(queued)) return;
                    if (payload?.autoOpenPanel !== true) return;
                    runtime.cooldownUntil = Date.now() + AUTO_OPEN_COOLDOWN_MS;
                    try {
                        ctx.sidebarRight.openTab(TAB_KIND, {});
                    } catch (error) {
                        // 自动打开是便利，不是正确性；失败就留给 `canvas_ping` 的
                        // 超时文案去解释，不能让它把插件弄崩。
                        console.warn(`[dsh-canvas] 自动打开画布失败：${String(error)}`);
                    }
                };
                const timer = setInterval(() => { void tick(); }, SENTINEL_INTERVAL_MS);
                return () => clearInterval(timer);
            }, 'infinite-canvas: auto-open sentinel');
        }

        return {
            name: 'infinite-canvas-client',
            inject: ['slots', 'locale', 'sidebarRightTabs', 'sidebarRight'],
            apply,
        };
    },
});
