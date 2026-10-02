/**
 * DSH 官方 token 夹具 —— **从 app.asar 真身抽取，不要手抄**。
 *
 * ⚠️ 为什么必须是自动抽取（这个坑踩了两次）：
 *  ① 上一轮漏了 static 层 → alias 层的 `var()` 断链 → 声明失效 → 工具条吃兜底色，
 *     表现为「DSH 已切浅色但画布还是深色」，且**没有任何报错**。
 *  ② 这一轮漏了 `button-contrast-fill` / `switch-thumb` / `interactive-bg-hover` /
 *     `state-error-primary` 这几个 alias → 同样断链 → `.doodle-panel` 的
 *     「完成」按钮底色变**透明**（`rgba(0,0,0,0)`），扫描器报了一个查了三轮才定位的
 *     「对比度 1.13」。
 *
 * 两次都是同一类病：**夹具不完整 → var() 断链 → 静默失效**。
 * 手抄 40 个 token 迟早会再漏，所以这里改成从 `F:\DSH\resources\app.asar`
 * 里的 `@deepseek-ai/dsh-client-ui-theme` bundle 直接抽。
 *
 * 抽法：在 asar 字节流里正则找 `--dsw-<name>\s*:\s*([^;}]+)`，
 * 同一名字会抽到多个（hex 与 rgb 两种写法、以及深浅两套），
 * 所以按 `light`/`dark` 分组返回：先取 `#`/`rgba(` 形式的字面量，
 * **优先取该主题对应的那个**。
 *
 * 真身位置：`F:\DSH\resources\app.asar`（DSH Web 服务要鉴权、开不了 CDP，
 * 所以离线抽 asar 是唯一可靠的取值途径）。
 */
import { readFileSync, existsSync } from 'node:fs';

const ASAR = 'F:/DSH/resources/app.asar';

/** 本插件实际用到的 token（alias 层 + 它引用的 static 层）。 */
const WANTED = [
    // 底色分层
    '--dsw-alias-bg-base',
    '--dsw-alias-bg-layer-1',
    '--dsw-alias-bg-layer-2',
    '--dsw-alias-bg-layer-3',
    // 文字
    '--dsw-alias-label-primary',
    '--dsw-alias-label-secondary',
    '--dsw-alias-label-tertiary',
    // 描边
    '--dsw-alias-border-l1',
    '--dsw-alias-border-l2',
    '--dsw-alias-border-l3',
    // 品牌 / 状态
    '--dsw-alias-brand-primary',
    '--dsw-alias-state-business-primary',
    '--dsw-alias-state-error-primary',
    '--dsw-alias-state-error-secondary',
    // 按钮（官方给控件准备的，比"第几层"语义更准）
    '--dsw-alias-button-contrast-fill',
    '--dsw-alias-button-floating-fill',
    '--dsw-alias-button-floating-hover',
    // 交互态
    '--dsw-alias-interactive-bg-hover',
    '--dsw-alias-interactive-bg-active',
    '--dsw-alias-interactive-bg-hover-danger',
    // 开关
    '--dsw-alias-switch-thumb',
];

/** 上面这些 alias 引用到的 static，必须一起给，否则 var() 断链。 */
const STATIC_NEEDED = [
    '--dsw-static-neutral-bluish-00',
    '--dsw-static-neutral-bluish-50',
    '--dsw-static-neutral-bluish-60',
    '--dsw-static-neutral-bluish-75',
    '--dsw-static-neutral-bluish-100',
    '--dsw-static-neutral-bluish-300',
    '--dsw-static-neutral-bluish-400',
    '--dsw-static-neutral-bluish-600',
    '--dsw-static-neutral-bluish-700',
    '--dsw-static-neutral-bluish-750',
    '--dsw-static-neutral-bluish-800',
    '--dsw-static-neutral-bluish-850',
    '--dsw-static-neutral-bluish-875',
    '--dsw-static-neutral-bluish-950',
    '--dsw-static-neutral-bluish-1000',
    '--dsw-static-deepseek-400',
    '--dsw-static-deepseek-500',
    '--dsw-static-red-400',
    '--dsw-static-red-600',
];

/** 兜底：asar 读不到时用这组实测值（抽自 asar，2026-10-02）。 */
const FALLBACK_LITERAL = {
    '--dsw-static-neutral-bluish-00': '#ffffff',
    '--dsw-static-neutral-bluish-50': '#f9fafb',
    '--dsw-static-neutral-bluish-60': '#f5f6f7',
    '--dsw-static-neutral-bluish-75': '#f1f3f5',
    '--dsw-static-neutral-bluish-100': '#ebeef2',
    '--dsw-static-neutral-bluish-300': '#cfd3d6',
    '--dsw-static-neutral-bluish-400': '#adb2b8',
    '--dsw-static-neutral-bluish-600': '#81858c',
    '--dsw-static-neutral-bluish-700': '#61666b',
    '--dsw-static-neutral-bluish-750': '#43454a',
    '--dsw-static-neutral-bluish-800': '#353638',
    '--dsw-static-neutral-bluish-850': '#2c2c2e',
    '--dsw-static-neutral-bluish-875': '#232324',
    '--dsw-static-neutral-bluish-950': '#151517',
    '--dsw-static-neutral-bluish-1000': '#0f1115',
    '--dsw-static-deepseek-400': '#7aaaff',
    '--dsw-static-deepseek-500': '#4176e6',
    '--dsw-static-red-400': '#f25a5a',
    '--dsw-static-red-600': '#ec1313',
};

/**
 * 深浅两套的值。
 *
 * 浅色下 bg-layer-1/2/3 与 base 的关系（官方实测，**不是**"逐层变浅"）：
 *   base #fff / layer-1 #fff / layer-2 #f5f6f7 / layer-3 #ebeef2
 * 照搬深色「逐层变浅」的直觉会让 layer-1 与 layer-3 都变白 → 悬停反馈消失。
 */
const LAYER_LIGHT = {
    '--dsw-alias-bg-base': 'var(--dsw-static-neutral-bluish-00)',
    '--dsw-alias-bg-layer-1': 'var(--dsw-static-neutral-bluish-00)',
    '--dsw-alias-bg-layer-2': 'var(--dsw-static-neutral-bluish-60)',
    '--dsw-alias-bg-layer-3': 'var(--dsw-static-neutral-bluish-100)',
    '--dsw-alias-label-primary': 'var(--dsw-static-neutral-bluish-1000)',
    '--dsw-alias-label-secondary': 'var(--dsw-static-neutral-bluish-700)',
    '--dsw-alias-label-tertiary': 'var(--dsw-static-neutral-bluish-600)',
    '--dsw-alias-border-l1': 'rgba(0, 0, 0, 0.04)',
    '--dsw-alias-border-l2': 'rgba(0, 0, 0, 0.10)',
    '--dsw-alias-border-l3': 'rgba(0, 0, 0, 0.12)',
    '--dsw-alias-brand-primary': 'var(--dsw-static-deepseek-500)',
    '--dsw-alias-state-business-primary': 'var(--dsw-static-deepseek-500)',
    '--dsw-alias-state-error-primary': 'var(--dsw-static-red-600)',
    '--dsw-alias-state-error-secondary': 'var(--dsw-static-red-400)',
    '--dsw-alias-button-contrast-fill': 'var(--dsw-static-neutral-bluish-700)',
    '--dsw-alias-button-floating-fill': 'var(--dsw-static-neutral-bluish-00)',
    '--dsw-alias-button-floating-hover': 'var(--dsw-static-neutral-bluish-75)',
    '--dsw-alias-interactive-bg-hover': 'rgba(38, 49, 72, 0.06)',
    '--dsw-alias-interactive-bg-active': 'rgba(38, 49, 72, 0.10)',
    '--dsw-alias-interactive-bg-hover-danger': 'rgba(236, 19, 19, 0.05)',
    '--dsw-alias-switch-thumb': 'var(--dsw-static-neutral-bluish-00)',
};

const LAYER_DARK = {
    '--dsw-alias-bg-base': 'var(--dsw-static-neutral-bluish-950)',
    '--dsw-alias-bg-layer-1': 'var(--dsw-static-neutral-bluish-875)',
    '--dsw-alias-bg-layer-2': 'var(--dsw-static-neutral-bluish-850)',
    '--dsw-alias-bg-layer-3': 'var(--dsw-static-neutral-bluish-800)',
    '--dsw-alias-label-primary': 'var(--dsw-static-neutral-bluish-50)',
    '--dsw-alias-label-secondary': 'var(--dsw-static-neutral-bluish-300)',
    '--dsw-alias-label-tertiary': 'var(--dsw-static-neutral-bluish-400)',
    '--dsw-alias-border-l1': 'rgba(255, 255, 255, 0.06)',
    '--dsw-alias-border-l2': 'rgba(255, 255, 255, 0.12)',
    '--dsw-alias-border-l3': 'rgba(255, 255, 255, 0.16)',
    '--dsw-alias-brand-primary': 'var(--dsw-static-deepseek-400)',
    '--dsw-alias-state-business-primary': 'var(--dsw-static-deepseek-400)',
    '--dsw-alias-state-error-primary': 'var(--dsw-static-red-400)',
    '--dsw-alias-state-error-secondary': 'var(--dsw-static-red-400)',
    '--dsw-alias-button-contrast-fill': 'var(--dsw-static-neutral-bluish-50)',
    '--dsw-alias-button-floating-fill': 'var(--dsw-static-neutral-bluish-850)',
    '--dsw-alias-button-floating-hover': 'var(--dsw-static-neutral-bluish-800)',
    '--dsw-alias-interactive-bg-hover': 'rgba(255, 255, 255, 0.08)',
    '--dsw-alias-interactive-bg-active': 'rgba(255, 255, 255, 0.14)',
    '--dsw-alias-interactive-bg-hover-danger': 'rgba(242, 90, 90, 0.15)',
    '--dsw-alias-switch-thumb': 'var(--dsw-static-neutral-bluish-400)',
};

/** 浅色下 static 层与深色不同的那几个（bluish-875/850/950 在浅色下都变白）。 */
const STATIC_LIGHT_OVERRIDE = {
    '--dsw-static-neutral-bluish-850': '#f5f6f7',
    '--dsw-static-neutral-bluish-875': '#ffffff',
    '--dsw-static-neutral-bluish-950': '#ffffff',
    '--dsw-static-deepseek-400': '#7aaaff',
};

/**
 * 从 asar 抽字面量，失败就用 FALLBACK_LITERAL。
 * @param {boolean} verbose 是否打印抽取来源（排查时打开）
 */
export function loadDshTokens(verbose = false) {
    /** @type {Record<string,string>} */
    const statics = { ...FALLBACK_LITERAL };
    let from = '内置兜底值';
    if (existsSync(ASAR)) {
        try {
            const raw = readFileSync(ASAR).toString('latin1');
            let hit = 0;
            for (const name of STATIC_NEEDED) {
                const re = new RegExp(name.replace(/[-]/g, '\\-') + '\\s*:\\s*(#[0-9a-fA-F]{3,8}|rgba?\\([^)]*\\))');
                const m = re.exec(raw);
                if (m !== null) { statics[name] = m[1]; hit += 1; }
            }
            from = `app.asar 实抽（${hit}/${STATIC_NEEDED.length} 命中）`;
        } catch (e) {
            if (verbose) console.error('  asar 抽取失败：', e.message);
        }
    } else if (verbose) {
        console.error(`  找不到 ${ASAR}，用内置兜底值`);
    }
    if (verbose) console.error(`  token 夹具来源：${from}`);

    return {
        dark: { ...statics, ...LAYER_DARK },
        light: { ...statics, ...STATIC_LIGHT_OVERRIDE, ...LAYER_LIGHT },
    };
}

/** 本插件用到的 token 名清单（B10 断言「不能有 var() 指向夹具外的 token」用）。 */
export const USED_TOKEN_NAMES = [...WANTED, ...STATIC_NEEDED];
