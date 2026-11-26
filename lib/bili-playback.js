/**
 * bili-playback.js —— 用真播放在 B 站留观看痕迹。
 *
 * 为什么要有它：`browse.js` 的 `gather()` 只读接口（view/字幕/热评/弹幕），
 * 账号那边一条记录都不会有，首页推荐永远是白板。想看「她真的看过」，
 * 就得让视频在浏览器里放起来——B 站按 heartbeat 记播放进度，历史里就能看到。
 *
 * 三件事：
 *  1. **起浏览器**：用专用 profile 起一个 Edge/Chrome（`--remote-debugging-port`），
 *     进程 detached，插件重启也不影响它继续活着；下次直接复用同一个端口。
 *  2. **注 cookie**：Cookie 从 `BiliClient.cookieHeader()` 拿（和接口用的是同一份登录态），
 *     逐个 `Network.setCookie` 写到 `.bilibili.com`。
 *  3. **播**：navigate 到视频页 → 等 `<video>` 出现 → 静音、按倍速播 → 播够目标秒数关标签。
 *
 * 目标秒数 = 视频时长 ÷ 倍速（默认 2 倍速，也就是「真看完」）。
 * 中途叫停：`handle.abort()` 立刻关标签——模型判了「划走」（最不喜欢那档）时用，
 * 让平台看到的是「看到一半就退出去」，而不是「看完还不喜欢」。
 *
 * 失败一律只 log，不抛：留痕是加分项，不能因为它把整轮 watch() 拖死。
 */
import { spawn } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { detectBrowsers, pickBrowser } from './browsers.js';
import { dshHome } from './db.js';

const CDP_READY_TIMEOUT_MS = 15_000;
const VIDEO_READY_TIMEOUT_MS = 25_000;
const POLL_MS = 1000;

/** 极简 CDP 客户端：连浏览器的 webSocketDebuggerUrl，按 sessionId 收发。 */
class Cdp {
	constructor(ws) {
		this.ws = ws;
		this.nextId = 1;
		this.pending = new Map();
		ws.addEventListener('message', (ev) => {
			let msg = null;
			try { msg = JSON.parse(String(ev.data)); } catch { return; }
			if (!msg?.id || !this.pending.has(msg.id)) return;
			const { resolve, reject } = this.pending.get(msg.id);
			this.pending.delete(msg.id);
			if (msg.error) reject(new Error(`${msg.error.message} (${msg.error.code})`));
			else resolve(msg.result ?? {});
		});
	}

	send(method, params = {}, sessionId) {
		const id = this.nextId++;
		const msg = { id, method, params };
		if (sessionId) msg.sessionId = sessionId;
		return new Promise((resolve, reject) => {
			this.pending.set(id, { resolve, reject });
			try { this.ws.send(JSON.stringify(msg)); } catch (error) { reject(error); }
		});
	}

	close() {
		try { this.ws.close(); } catch { /* 已经关了 */ }
	}
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** "a=1; b=2" → [["a","1"],["b","2"]]（cookie 值里可能有 '='，只切第一个）。 */
function cookiePairs(header) {
	const out = [];
	for (const part of String(header ?? '').split(';')) {
		const i = part.indexOf('=');
		if (i <= 0) continue;
		const name = part.slice(0, i).trim();
		const value = part.slice(i + 1).trim();
		if (name !== '' && value !== '') out.push([name, value]);
	}
	return out;
}

export class BiliPlayback {
	constructor({ getConfig, client, log = () => {}, homedirOverride = '' }) {
		this.getConfig = getConfig;
		this.client = client;
		this.log = log;
		this.home = homedirOverride !== '' ? homedirOverride : dshHome();
		this.browserPath = '';
		this.launching = null;
		// 同时在播的条数：每条占自己的标签，归零才关浏览器（一轮三条可以并行）
		this.active = 0;
	}

	cfg() {
		const browse = this.getConfig?.()?.bili?.browse ?? {};
		return browse.playback ?? {};
	}

	userDataDir() {
		const configured = String(this.cfg().userDataDir ?? '').trim();
		if (configured !== '') return configured;
		return join(this.home, 'fish-soul', 'bili-playback');
	}

	/** 找浏览器（配置指定的优先，否则按 detectBrowsers 的顺序挑第一个）。 */
	async resolveBrowser() {
		if (this.browserPath !== '') return this.browserPath;
		const cfg = this.cfg();
		const list = await detectBrowsers();
		const picked = pickBrowser(list, { kind: cfg.browserKind ?? '', customPath: cfg.customPath ?? '' });
		const path = picked?.path ?? picked?.exePath ?? picked?.file ?? '';
		if (path === '') throw new Error('没找到可用的 Chromium 系浏览器');
		this.browserPath = path;
		return path;
	}

	async cdpVersion(port) {
		const res = await fetch(`http://127.0.0.1:${port}/json/version`, { signal: AbortSignal.timeout(1500) });
		if (!res.ok) throw new Error(`CDP ${res.status}`);
		return res.json();
	}

	/** 起浏览器（如果那个端口上还没有）；返回 webSocketDebuggerUrl。 */
	async ensureBrowser(port) {
		try {
			const info = await this.cdpVersion(port);
			if (info?.webSocketDebuggerUrl) return info.webSocketDebuggerUrl;
		} catch { /* 没起来，往下走 */ }
		if (this.launching !== null) return this.launching;
		this.launching = (async () => {
			const exe = await this.resolveBrowser();
			const dir = this.userDataDir();
			mkdirSync(dir, { recursive: true });
			const args = [
				`--remote-debugging-port=${port}`,
				`--user-data-dir=${dir}`,
				'--no-first-run',
				'--no-default-browser-check',
				'--disable-sync',
				'--mute-audio',
				'--autoplay-policy=no-user-gesture-required',
				'--disable-backgrounding-occluded-windows',
				'--disable-renderer-backgrounding',
				'--window-size=800,600',
				'about:blank'
			];
			const child = spawn(exe, args, { detached: true, stdio: 'ignore', windowsHide: true });
			child.unref();
			this.log('info', `[fish-soul] 起了播放用浏览器：${exe}（端口 ${port}）`);
			const deadline = Date.now() + CDP_READY_TIMEOUT_MS;
			while (Date.now() < deadline) {
				await sleep(500);
				try {
					const info = await this.cdpVersion(port);
					if (info?.webSocketDebuggerUrl) return info.webSocketDebuggerUrl;
				} catch { /* 还没起来 */ }
			}
			throw new Error(`浏览器 ${CDP_READY_TIMEOUT_MS / 1000}s 内没开 CDP 端口 ${port}`);
		})();
		try {
			return await this.launching;
		} finally {
			this.launching = null;
		}
	}

	/**
	 * 收尾：把剩下的页面都关掉，然后让浏览器自己退出——
	 * 不然它会一直挂着一张 about:blank 的空白页在任务栏上。
	 */
	async shutdown(cdp) {
		if (!cdp) return;
		try {
			const { targetInfos } = await cdp.send('Target.getTargets');
			for (const t of (targetInfos ?? []).filter((x) => x.type === 'page')) {
				try { await cdp.send('Target.closeTarget', { targetId: t.targetId }); } catch { /* 已经没了 */ }
			}
			await cdp.send('Browser.close');
		} catch { /* 浏览器可能已经自己退了 */ }
	}

	/**
	 * 开始播一条。立刻返回 handle，播放本身在后台跑。
	 * @param {string} bvid
	 * @param {{duration?: number, rate?: number}} [opts] duration 是视频总秒数（接口给的）
	 * @returns {{bvid:string, seconds:number, rate:number, abort:Function, done:Promise<object>}}
	 */
	start(bvid, { duration = 0, rate } = {}) {
		const cfg = this.cfg();
		const speed = Number(rate ?? cfg.rate ?? 2) > 0 ? Number(rate ?? cfg.rate ?? 2) : 2;
		const maxSeconds = Math.max(10, Number(cfg.maxMinutes ?? 60) * 60);
		const fromDuration = Number(duration) > 0 ? Number(duration) / speed : Number(cfg.seconds ?? 30);
		const seconds = Math.round(Math.min(maxSeconds, Math.max(10, fromDuration || 30)));
		const port = Number(cfg.port ?? 9222);
		const state = { aborted: false, targetId: '', sessionId: '', cdp: null, played: 0, closed: false };

		const closeTarget = async () => {
			if (state.closed || state.targetId === '') return;
			state.closed = true;
			try { await state.cdp?.send('Target.closeTarget', { targetId: state.targetId }); } catch { /* 已经没了 */ }
		};

		// 收尾：自己那条标签已经关了。active 归零才关整个浏览器
		// （归零时 shutdown 会把剩下的页面——包括启动时那张 about:blank——一起关掉再退）。
		const release = async (cdp) => {
			this.active = Math.max(0, this.active - 1);
			if (this.active > 0) return;
			await this.shutdown(cdp);
		};

		const done = (async () => {
			this.active += 1;
			try {
				const wsUrl = await this.ensureBrowser(port);
				const ws = new WebSocket(wsUrl);
				await new Promise((resolve, reject) => {
					ws.addEventListener('open', resolve, { once: true });
					ws.addEventListener('error', () => reject(new Error('CDP 连接失败')), { once: true });
				});
				const cdp = new Cdp(ws);
				state.cdp = cdp;
				// 每条播放开自己的标签：以前是抢同一张 about:blank，两条并行时
				// 谁先收尾谁把它关掉，另一条的 session 就报 -32001。
				const attach = async (id) => cdp.send('Target.attachToTarget', { targetId: id, flatten: true });
				let targetId = (await cdp.send('Target.createTarget', { url: 'about:blank' })).targetId;
				state.targetId = targetId;
				let sessionId;
				try {
					({ sessionId } = await attach(targetId));
				} catch (error) {
					// 标签刚好被别人收掉时重建一次
					if (!String(error instanceof Error ? error.message : error).includes('-32001')) throw error;
					targetId = (await cdp.send('Target.createTarget', { url: 'about:blank' })).targetId;
					state.targetId = targetId;
					({ sessionId } = await attach(targetId));
				}
				state.sessionId = sessionId;
				await cdp.send('Page.enable', {}, sessionId);
				await cdp.send('Runtime.enable', {}, sessionId);
				await cdp.send('Network.enable', {}, sessionId);
				for (const [name, value] of cookiePairs(this.client?.cookieHeader?.() ?? '')) {
					try {
						await cdp.send('Network.setCookie', {
							name, value, domain: '.bilibili.com', path: '/', secure: true, sameSite: 'None'
						}, sessionId);
					} catch { /* 单个 cookie 失败不致命 */ }
				}
				if (state.aborted) { await closeTarget(); await release(cdp); return { ok: false, aborted: true, bvid }; }
				await cdp.send('Page.navigate', { url: `https://www.bilibili.com/video/${bvid}` }, sessionId);

				const evalJs = async (expression) => {
					const r = await cdp.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }, sessionId);
					return r?.result?.value;
				};
				const readyDeadline = Date.now() + VIDEO_READY_TIMEOUT_MS;
				let started = false;
				while (Date.now() < readyDeadline && !started && !state.aborted) {
					await sleep(700);
					started = Boolean(await evalJs(`(() => {
						const v = document.querySelector('video');
						if (!v) return false;
						v.muted = true;
						v.playbackRate = ${speed};
						if (v.paused) { const p = v.play(); if (p && p.catch) p.catch((e) => { window.__playErr = String(e); }); }
						return !v.paused || v.currentTime > 0;
					})()`));
				}
				if (!started) { await closeTarget(); await release(cdp); return { ok: false, error: '播放器没起来', bvid }; }

				const deadline = Date.now() + seconds * 1000 + 5000;
				// 注意单位：currentTime 是「片子里的秒」，走完一条片子要 duration 秒的片子时间，
				// 墙上时间才是 duration ÷ 倍速。别拿墙上的秒数去比 currentTime，2 倍速下会只看一半。
				const mediaTarget = Number(duration) > 0 ? Number(duration) : seconds * speed;
				let last = 0;
				while (Date.now() < deadline) {
					await sleep(POLL_MS);
					if (state.aborted) break;
					const info = await evalJs(`(() => {
						const v = document.querySelector('video');
						return v ? { t: v.currentTime, p: v.paused, d: v.duration, err: window.__playErr || null } : { gone: true };
					})()`);
					if (!info || info.gone) break;
					last = Number(info.t ?? last);
					if (Number(info.d) > 0 && last >= Number(info.d) - 0.5) break; // 放完了
					if (last >= mediaTarget - 0.5) break; // 目标长度到了
				}
				state.played = last;
				await closeTarget();
				await release(cdp);
				cdp.close();
				return { ok: true, bvid, seconds, rate: speed, played: Math.round(last), aborted: state.aborted };
			} catch (error) {
				this.log('warn', `[fish-soul] 播放留痕失败（${bvid}）：${String(error instanceof Error ? error.message : error)}`);
				try { await closeTarget(); } catch { /* 标签可能已经被收掉 */ }
				try { await release(state.cdp); } catch { /* 浏览器已经没了 */ }
				try { state.cdp?.close(); } catch { /* 已关 */ }
				return { ok: false, bvid, error: String(error instanceof Error ? error.message : error) };
			}
		})();

		return {
			bvid,
			seconds,
			rate: speed,
			abort: () => {
				state.aborted = true;
				// 立刻把标签关掉：让平台看到的是「中途退出」，不是「看完再暂停」
				void closeTarget();
			},
			done
		};
	}
}
