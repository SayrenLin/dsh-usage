/**
 * dsh-usage — browser half (v0.2 redesign).
 *
 * Design principles: restrained, minimal, modern, techy. The differentiator
 * is "everything is customizable": every feature is a WIDGET with two
 * expressions —
 *   - detail (the panel card: full data + controls), and
 *   - compact (the bottom-left floating dock row: one glanceable line).
 * Each widget can be pinned to the dock, collapsed, hidden, or reordered.
 * Colors are NOT configured here: the dock inherits the DSH theme tokens
 * (`--dsw-alias-*`) so light/dark and the accent follow the host. Layout
 * preferences persist in localStorage; this build never checks for updates.
 *
 * Hand-written `__ModuleLoader__` bundle (no build step). The slot runtime
 * injects `wide` and `t`; the plugin body registers dictionaries and the
 * `sidebar.footer.action` slot.
 */
window.__ModuleLoader__.load({
	id: "dsh-usage",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

		let react = require("react");
		let react_jsx_runtime = require("react/jsx-runtime");
		let primitives = require("@deepseek-ai/dsh-client-ui-primitives");
		// 0.2 renamed size-suffixed icons; leave the shared host module untouched.
		primitives = {
			...primitives,
			Tooltip: primitives.Tooltip,
			IconChevronLeftOutline14: primitives.IconChevronLeftOutline14 ?? primitives.IconChevronLeftOutlineRegular,
			IconRefreshOutline14: primitives.IconRefreshOutline14 ?? primitives.IconRefreshOutlineRegular,
			IconSettingsOutline14: primitives.IconSettingsOutline14 ?? primitives.IconSettingsOutlineRegular,
			IconDataOutline16: primitives.IconDataOutline16 ?? primitives.IconDataOutlineRegular,
			IconCloseOutline16: primitives.IconCloseOutline16 ?? primitives.IconCloseOutlineRegular
		};

		const NS = "dsh-usage";

		/**
		 * DeepSeek 峰谷时段：固定按北京时间（UTC+8）判定，不跟随设备时区。
		 * 工作日 09:00–12:00 / 14:00–18:00 为高峰，其余时间与周末为空闲。
		 * 做法是把时间戳平移到 UTC+8 的「墙钟」，再用 getUTC* 读取，避免 DST 与时区偏移。
		 * @param now - 可注入的当前时刻（测试用）。
		 * @returns 高峰返回 "yellow"，空闲返回 "green"。
		 */
		function peakState(now) {
			const d = now instanceof Date ? now : new Date();
			const beijing = new Date(d.getTime() + 8 * 60 * 60 * 1000);
			const day = beijing.getUTCDay();
			const hour = beijing.getUTCHours();
			const workday = day >= 1 && day <= 5;
			const inPeak = workday && ((hour >= 9 && hour < 12) || (hour >= 14 && hour < 18));
			return inPeak ? "yellow" : "green";
		}

		//#region css
		const css = [
			// floating dock (persistent, bottom-left, raised above the sidebar settings): one frame, divider rows, gear in the top-right corner
			".u_dock{position:fixed;left:14px;bottom:72px;z-index:30;display:flex;flex-direction:column;gap:6px;align-items:flex-start}",
			".u_dockFrame{position:relative;box-sizing:border-box;width:100%;min-width:200px;max-width:280px;padding:32px 14px 12px;border-radius:12px;border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-base);box-shadow:var(--dsw-shadow-lv2);display:flex;flex-direction:column}",
			".u_dockSettings{position:absolute;top:8px;right:10px;display:flex;align-items:center;justify-content:center;width:20px;height:20px;border-radius:50%;border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-tertiary);cursor:pointer;padding:0}",
			".u_dockSettings:hover{color:var(--dsw-alias-state-business-primary)}",
			".u_dockRefresh{position:absolute;top:8px;right:36px;display:flex;align-items:center;justify-content:center;width:20px;height:20px;border-radius:50%;border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-tertiary);cursor:pointer;padding:0}",
			".u_dockRefresh:hover{color:var(--dsw-alias-state-business-primary)}",
		// dock footer: an always-visible peak-hours note under the pinned rows
			".u_dockRefresh, .u_dockSettings{display:none}",
			".u_dockGrip{position:absolute;top:8px;left:10px;display:flex;align-items:center;justify-content:center;width:20px;height:20px;border-radius:5px;border:none;background:0 0;color:var(--dsw-alias-label-tertiary);cursor:grab;padding:0;touch-action:none}",
			".u_dockGrip:hover{color:var(--dsw-alias-label-secondary);background:var(--dsw-alias-interactive-bg-hover)}",
			".u_dockGrip:active{cursor:grabbing}",
			// rail mode: a single rounded-rect balance pill, centered on the
			// collapsed sidebar; clicking reveals the dock
			".u_railBtn{position:fixed;bottom:72px;z-index:30;border-radius:6px;border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-base);box-shadow:var(--dsw-shadow-lv2);cursor:pointer;display:flex;flex-direction:column;align-items:center;gap:0;padding:3px 6px;transform:translateX(-50%);transition:transform .15s ease}",
			".u_railBtn:hover{transform:translateX(-50%) scale(1.05)}",
			".u_railLabel{color:var(--dsw-alias-label-secondary);font-size:9px;line-height:11px}",
			".u_railValue{color:var(--dsw-alias-label-primary);font-size:10px;font-weight:600;line-height:13px;font-variant-numeric:tabular-nums;max-width:56px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}",
			".u_railValue[data-tone=ok]{color:var(--dsw-alias-state-success-primary)}",
			".u_railValue[data-tone=bad]{color:var(--dsw-alias-state-error-primary)}",
			".u_railScrim{position:fixed;inset:0;z-index:25;background:transparent}",
			// week mini cells (compact heat)
			// detail panel
			".u_panel{position:absolute;left:calc(100% + 12px);top:0;z-index:40;box-sizing:border-box;width:min(420px,calc(100vw - 32px));max-height:calc(100dvh - 32px);border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-base);box-shadow:var(--dsw-shadow-lv2);border-radius:12px;display:flex;flex-direction:column;overflow:hidden}",
			".u_header{box-sizing:border-box;border-bottom:1px solid var(--dsw-alias-border-l2);background:0 0;flex:none;justify-content:space-between;align-items:center;min-height:44px;padding:10px 12px;display:flex}",
			".u_headerLeft{align-items:center;gap:8px;display:flex}",
			".u_title{color:var(--dsw-alias-label-primary);font-size:13px;font-weight:500;line-height:20px}",
			".u_headerActions{align-items:center;gap:2px;display:flex}",
			".u_iconButton{cursor:pointer;width:26px;height:26px;color:var(--dsw-alias-label-tertiary);background:0 0;border:none;border-radius:6px;justify-content:center;align-items:center;padding:0;display:inline-flex}",
			".u_iconButton:hover{color:var(--dsw-alias-label-secondary);background:var(--dsw-alias-interactive-bg-hover)}",
			".u_body{flex:1;min-height:0;padding:4px 14px 14px;overflow-y:auto}",
			".u_note{color:var(--dsw-alias-label-tertiary);margin:4px 0;font-size:12px;line-height:18px}",
			".u_closeButton{width:32px;height:32px;margin-right:-4px}",
			// dock: today's spend card (10px section rhythm keeps the tiers apart)
			".u_dockCard{display:flex;flex-direction:column;gap:10px;width:100%}",
			".u_costHead{display:flex;flex-direction:column;gap:2px}",
			".u_costRow{position:relative;display:flex;align-items:center;justify-content:center;min-height:28px}",
			// compressed billing band: peak zones widened, idle zones narrowed, labels inline
			".u_bandBox{display:flex;flex-direction:column;gap:2px;padding-bottom:10px}",
			".u_band{position:relative;display:flex;gap:2px;height:9px;border-radius:4px}",
			".u_bandZone{display:flex;align-items:center;justify-content:center;min-width:20px;overflow:hidden;border-radius:3px;background:color-mix(in srgb, var(--dsw-alias-label-secondary) 15%, transparent);box-shadow:inset 0 1px 2px rgba(0,0,0,.12),inset 0 0 0 1px var(--dsw-alias-border-l2);color:var(--dsw-alias-label-secondary);font-size:9px;line-height:16px;white-space:nowrap}",
			".u_bandZone[data-kind=peak]{background:#f59e0b;color:#3d2b00;font-weight:600}",
			".u_bandZone[data-dim]{background:transparent;box-shadow:inset 0 0 0 1px #f59e0b;color:#b7791f}",
			".u_bandZone[data-active]{color:var(--dsw-alias-label-primary);font-weight:600}",
			".u_bandZone[data-kind=peak][data-active]{color:#3d2b00}",
			".u_bandNow{position:absolute;top:-6px;width:0;height:0;border-left:4px solid transparent;border-right:4px solid transparent;border-top:6px solid #2ea043;transform:translateX(-50%);pointer-events:none}",
			".u_bandNow[data-peak=yellow]{border-top-color:#f59e0b}",
			".u_bandEdges{position:relative;height:12px;margin-top:2px}",
			".u_bandEdge{position:absolute;transform:translateX(-50%);color:var(--dsw-alias-label-tertiary);font-size:9px;line-height:12px;white-space:nowrap;font-variant-numeric:tabular-nums}",
			".u_trend{display:inline-block;width:0;height:0;margin-left:3px;vertical-align:middle}",
			".u_trend[data-trend=up]{border-left:3px solid transparent;border-right:3px solid transparent;border-bottom:6px solid var(--dsw-alias-state-success-primary)}",
			".u_trend[data-trend=down]{border-left:3px solid transparent;border-right:3px solid transparent;border-top:6px solid var(--dsw-alias-state-error-primary)}",
			".u_trend[data-trend=flat]{width:6px;height:6px;border-radius:1px;background:var(--dsw-alias-label-tertiary);vertical-align:0}",
			".u_metricRow{display:flex;gap:12px;align-items:flex-start}",
			".u_metric{flex:1;min-width:0;display:flex;flex-direction:column;align-items:center;gap:2px;text-align:center}",
			".u_metricLabel{color:var(--dsw-alias-label-tertiary);font-size:10px;line-height:13px;white-space:nowrap;text-align:center}",
			".u_metricValue{display:flex;align-items:baseline;justify-content:center;gap:1px;color:var(--dsw-alias-label-primary);font-size:16px;font-weight:600;line-height:20px;font-variant-numeric:tabular-nums}",
			".u_metricUnit{font-size:11px;font-weight:600;line-height:14px;color:var(--dsw-alias-label-secondary)}",
			// three clearly different hues: input / cache read / output
			".u_barSeg[data-kind=input]{background:var(--dsw-alias-state-business-primary)}",
			".u_barSeg[data-kind=cacheRead]{background:var(--dsw-alias-state-success-primary,#2ea043)}",
			".u_barSeg[data-kind=output]{background:var(--dsw-alias-state-warn-primary,#d29922)}",
			".u_dockLegend{display:flex;gap:9px;align-items:center;margin-top:-4px;color:var(--dsw-alias-label-tertiary);font-size:9.5px;line-height:12px}",
			".u_legendItem{display:inline-flex;align-items:center;gap:4px}",
			".u_legendDot{width:7px;height:7px;border-radius:2px;background:color-mix(in srgb, var(--dsw-alias-label-secondary) 16%, transparent)}",
			".u_legendItem[data-kind=input] .u_legendDot{background:var(--dsw-alias-state-business-primary)}",
			".u_legendItem[data-kind=cacheRead] .u_legendDot{background:var(--dsw-alias-state-success-primary,#2ea043)}",
			".u_legendItem[data-kind=output] .u_legendDot{background:var(--dsw-alias-state-warn-primary,#d29922)}",
			".u_barLegend{display:flex;gap:10px;align-items:center;color:var(--dsw-alias-label-tertiary);font-size:10px;line-height:14px}",
			// detail panel cards (whole header row toggles; no drag, no hide)
			".u_cards{display:flex;flex-direction:column;gap:8px}",
			".u_card{border:1px solid var(--dsw-alias-border-l2);border-radius:10px;overflow:hidden}",
			".u_cardHead{display:flex;align-items:center;justify-content:space-between;gap:8px;width:100%;padding:8px 10px;border:none;background:0 0;color:var(--dsw-alias-label-primary);font:inherit;font-size:12.5px;font-weight:600;line-height:18px;text-align:left;cursor:pointer}",
			".u_cardHead:hover{background:var(--dsw-alias-interactive-bg-hover)}",
			".u_cardTitle{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}",
			".u_chevron{flex:none;color:var(--dsw-alias-label-tertiary);font-size:14px;line-height:1;transition:transform .15s ease}",
			".u_chevron[data-open]{transform:rotate(90deg)}",
			".u_cardBody{padding:8px 10px 10px}",
			// dock: today's spend card
			".u_costLabel{color:var(--dsw-alias-label-tertiary);font-size:10.5px;line-height:14px}",
			".u_costValue{color:var(--dsw-alias-label-primary);font-size:24px;font-weight:600;line-height:28px;font-variant-numeric:tabular-nums}",
			".u_costValue[data-peak=yellow]{color:#f59e0b;font-size:32px;line-height:36px}",
			".u_bar{display:flex;width:100%;height:5px;border-radius:3px;overflow:hidden;background:color-mix(in srgb, var(--dsw-alias-label-secondary) 16%, transparent)}",
			".u_dockCard{cursor:pointer}",
			".u_dockCard:not([data-expanded]) .u_metricRow, .u_dockCard:not([data-expanded]) .u_dockBar, .u_dockCard:not([data-expanded]) .u_dockLegend{display:none}",
			".u_chevronDock[data-open]{transform:rotate(90deg)}",
			".u_chevronDock{color:var(--dsw-alias-label-tertiary);font-size:13px;line-height:14px;margin-left:2px;transition:color .12s ease}",
			".u_balanceLine:hover .u_chevronDock{color:var(--dsw-alias-label-secondary)}",
			".u_balanceLine{cursor:pointer;border-radius:6px}",
			".u_balanceLine:hover{background:var(--dsw-alias-interactive-bg-hover)}",
			".u_balanceLine:active{background:color-mix(in srgb, var(--dsw-alias-label-secondary) 14%, transparent)}",
			".u_balanceLine{display:flex;align-items:center;gap:6px;padding-top:8px;border-top:1px solid var(--dsw-alias-border-l1);color:var(--dsw-alias-label-tertiary);font-size:12.5px;line-height:17px}",
			".u_balanceLineValue{font-size:13px}",
			".u_balanceLineValue{margin-left:auto;color:var(--dsw-alias-label-primary);font-weight:600;font-variant-numeric:tabular-nums}",
			".u_balanceLineValue[data-tone=ok]{color:var(--dsw-alias-label-primary)}",
			".u_balanceLineValue[data-tone=bad]{color:var(--dsw-alias-state-error-primary)}",
			".u_warnDot{width:6px;height:6px;border-radius:50%;background:var(--dsw-alias-state-warn-primary,#d29922);flex:none}",
			// usage rows: numbers by default, composition bar on hover/focus
			".u_days{display:flex;flex-direction:column;gap:2px}",
			".u_day{display:flex;align-items:center;gap:8px;width:100%;min-height:26px;padding:4px 2px;border:none;background:0 0;color:inherit;font:inherit;text-align:left;cursor:pointer;border-radius:6px}",
			".u_day:hover{background:var(--dsw-alias-interactive-bg-hover)}",
			".u_dayDate{flex:none;width:42px;color:var(--dsw-alias-label-tertiary);font-size:11px;line-height:16px;font-variant-numeric:tabular-nums}",
			".u_dayTokens{flex:none;width:54px;text-align:right;color:var(--dsw-alias-label-secondary);font-size:11px;line-height:16px;font-variant-numeric:tabular-nums}",
			".u_dayHit{flex:none;width:44px;text-align:right;color:var(--dsw-alias-label-tertiary);font-size:11px;line-height:16px;font-variant-numeric:tabular-nums}",
			".u_dayCost{flex:none;margin-left:auto;color:var(--dsw-alias-label-primary);font-size:11px;font-weight:600;line-height:16px;font-variant-numeric:tabular-nums}",
			".u_dayBar{display:none;flex:1;min-width:0}",
			".u_day:hover .u_dayTokens,.u_day:hover .u_dayHit,.u_day:focus-visible .u_dayTokens,.u_day:focus-visible .u_dayHit{display:none}",
			".u_day:hover .u_dayBar,.u_day:focus-visible .u_dayBar{display:flex}",
			".u_recentFoot{margin-top:8px;padding-top:6px;border-top:1px solid var(--dsw-alias-border-l1);display:flex;flex-direction:column;gap:4px}",
			".u_recentMeta{margin:0;color:var(--dsw-alias-label-tertiary);font-size:10px;line-height:14px;font-variant-numeric:tabular-nums}",
			// widget cards (two-column grid; full-width cards span both)
			// action buttons appear only on hover (collapse arrow stays visible)
			// balance detail
			".u_providerPicker{align-items:center;gap:8px;margin:0 0 8px;font-size:12px;line-height:18px;display:flex}",
			".u_providerPickerLabel{color:var(--dsw-alias-label-tertiary);flex:none}",
			".u_providerLine{align-items:center;gap:8px;margin:0 0 8px;font-size:12px;line-height:18px;display:flex}",
			".u_providerName{color:var(--dsw-alias-label-primary);font-weight:500}",
			".u_providerSelect{box-sizing:border-box;min-width:0;flex:1;color:var(--dsw-alias-label-primary);background:var(--dsw-alias-bg-base);border:1px solid var(--dsw-alias-border-l2);border-radius:8px;padding:4px 6px;font:inherit;font-size:12px;line-height:18px}",
			".u_balanceGrid{display:flex;align-items:center;gap:14px;flex-wrap:wrap;row-gap:8px}",
			".u_balanceTable{flex:1;min-width:132px}",
			"@media (max-width:560px){.u_panel{left:16px;right:16px;width:auto;top:56px;max-height:calc(100vh - 72px)}.u_balanceAmount{font-size:26px}}",
			".u_balanceLeft{display:flex;flex-direction:column;gap:2px;flex:none}",
			".u_balanceAmount{color:var(--dsw-alias-state-business-primary);font-size:32px;font-weight:600;line-height:38px;font-variant-numeric:tabular-nums}",
			".u_balanceStatus{align-items:center;gap:5px;font-size:12px;line-height:16px;display:inline-flex}",
			".u_balanceOk{color:var(--dsw-alias-state-success-primary)}",
			".u_balanceBad{color:var(--dsw-alias-state-error-primary)}",
			".u_balanceTable{display:grid;grid-template-columns:auto auto;column-gap:10px;row-gap:1px;margin-left:auto;font-size:12px;line-height:17px}",
			".u_balanceTableLabel{color:var(--dsw-alias-label-tertiary);text-align:right;white-space:nowrap}",
			".u_balanceTableValue{color:var(--dsw-alias-label-primary);font-weight:600;text-align:right;font-variant-numeric:tabular-nums;white-space:nowrap}",
			".u_error{background:var(--dsw-alias-interactive-bg-hover-danger);color:var(--dsw-alias-state-error-primary);border-radius:8px;justify-content:space-between;align-items:flex-start;gap:8px;margin:4px 0;padding:7px 8px;font-size:12px;line-height:18px;display:flex}",
			// balance failure: status + actionable hint + the raw upstream line
			".u_balanceError{display:flex;flex-direction:column;gap:4px}",
			".u_errorText{display:flex;flex-direction:column;gap:2px;min-width:0}",
			".u_errorStatus{font-weight:600}",
			".u_errorHint{color:var(--dsw-alias-label-secondary);font-size:11.5px;line-height:16px}",
			".u_errorRaw{display:block;margin:0 0 4px;padding:5px 7px;border:1px solid var(--dsw-alias-border-l1);border-radius:6px;background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-tertiary);font:11px/15px ui-monospace,Consolas,monospace;overflow-wrap:anywhere;white-space:normal}",
			".u_coverage{color:var(--dsw-alias-label-secondary);margin:4px 0;font-size:12px;line-height:18px}",
			".u_coverageSummary{display:flex;align-items:center;gap:6px;padding:4px 0;list-style:none;cursor:pointer;border-radius:4px}",
			".u_coverageSummary::-webkit-details-marker{display:none}",
			".u_coverageSummary:hover{color:var(--dsw-alias-label-primary)}",
			".u_coverageSummary:focus-visible{outline:2px solid var(--dsw-alias-state-business-primary);outline-offset:2px}",
			".u_coverageDot{width:5px;height:5px;border-radius:50%;background:var(--dsw-alias-state-warn-primary,#d29922);flex:none}",
			".u_coverageLabel{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}",
			".u_coverageMore{display:flex;align-items:center;gap:4px;margin-left:auto;flex:none;font-size:11px;color:var(--dsw-alias-label-tertiary)}",
			".u_coverageArrow{display:inline-block;font-size:14px}",
			".u_coverage[open] .u_coverageArrow{transform:rotate(90deg)}",
			".u_coverageDetails{display:flex;align-items:center;gap:8px;margin-left:11px;padding:0 0 4px;font-size:11px;line-height:18px;color:var(--dsw-alias-label-tertiary)}",
			".u_coverageText{min-width:0;flex:1;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}",
			".u_coverageDetails .u_retry{line-height:18px;white-space:nowrap}",
			".u_coverage:not([open])>.u_coverageDetails{display:none}",
			".u_coverageQuiet .u_coverageDot{display:none}",
			".u_coverageQuiet .u_coverageLabel{color:var(--dsw-alias-label-tertiary);font-size:11px}",
			".u_retry{color:inherit;font:inherit;cursor:pointer;background:0 0;border:none;flex:none;padding:0}",
			// stats detail
			".u_statBig{color:var(--dsw-alias-label-primary);font-size:22px;font-weight:600;line-height:28px;font-variant-numeric:tabular-nums}",
			".u_statBreak{display:flex;flex-wrap:wrap;gap:3px 10px;margin-top:3px}",
			".u_statBreakItem{color:var(--dsw-alias-label-tertiary);font-size:10px;line-height:14px;font-variant-numeric:tabular-nums;white-space:nowrap}",
			".u_statBreakItem b{color:var(--dsw-alias-label-secondary);font-weight:600}",
			".u_hitCaption{color:var(--dsw-alias-label-tertiary);margin-top:6px;font-size:11px;line-height:16px;font-variant-numeric:tabular-nums}",
			".u_hitCaption b{color:var(--dsw-alias-label-secondary);font-weight:600}",
			// recent detail
			".u_days{flex-direction:column;display:flex;max-height:102px;overflow-y:auto;scrollbar-width:thin;scrollbar-color:color-mix(in srgb, var(--dsw-alias-label-secondary) 16%, transparent) transparent}",
			".u_days::-webkit-scrollbar{width:4px}",
			".u_days::-webkit-scrollbar-thumb{background:color-mix(in srgb, var(--dsw-alias-label-secondary) 16%, transparent);border-radius:2px}",
			".u_detailHeader{align-items:center;gap:8px;display:flex}",
			".u_detailTabs{display:flex;gap:6px;margin:8px 0 2px}",
			".u_segBtn{border:1px solid var(--dsw-alias-border-l2);background:transparent;color:var(--dsw-alias-label-secondary);font:inherit;font-size:11px;line-height:16px;padding:2px 9px;border-radius:6px;cursor:pointer}",
			".u_segBtn:hover{color:var(--dsw-alias-label-primary)}",
			".u_segBtn[data-active=true]{background:color-mix(in srgb, var(--dsw-alias-state-business-primary) 14%, transparent);border-color:color-mix(in srgb, var(--dsw-alias-state-business-primary) 40%, transparent);color:var(--dsw-alias-label-primary);font-weight:600}",
			".u_back{cursor:pointer;width:26px;height:26px;color:var(--dsw-alias-label-secondary);background:0 0;border:none;border-radius:6px;justify-content:center;align-items:center;padding:0;display:inline-flex;flex:none}",
			".u_back:hover{color:var(--dsw-alias-label-primary);background:var(--dsw-alias-interactive-bg-hover)}",
			".u_detailDate{color:var(--dsw-alias-label-primary);font-size:12px;font-weight:600;line-height:18px}",
			".u_detailHit{color:var(--dsw-alias-label-tertiary);margin-left:auto;font-size:11px;line-height:18px;font-variant-numeric:tabular-nums}",
			".u_detailSummary{display:flex;flex-wrap:wrap;gap:2px 10px;margin:6px 0 4px;color:var(--dsw-alias-label-tertiary);font-size:10.5px;line-height:15px;font-variant-numeric:tabular-nums}",
			".u_modelList{display:flex;flex-direction:column;gap:2px}",
			".u_modelRow{flex-direction:column;gap:3px;margin:8px 0 0;display:flex}",
			".u_modelMeta{align-items:baseline;gap:8px;display:flex}",
			".u_modelName{color:var(--dsw-alias-label-secondary);min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:12px;line-height:18px}",
			".u_modelTokens{color:var(--dsw-alias-label-primary);margin-left:auto;flex:none;font-size:12px;line-height:18px;font-variant-numeric:tabular-nums}",
			".u_modelHit{color:var(--dsw-alias-label-tertiary);flex:none;font-size:11px;line-height:18px;font-variant-numeric:tabular-nums}",
			".u_modelCost{color:var(--dsw-alias-label-primary);flex:none;font-size:11px;line-height:18px;font-weight:600;font-variant-numeric:tabular-nums}",
			// hidden manager
			".u_footerNote{color:var(--dsw-alias-label-caption);margin:10px 0 0;font-size:10px;line-height:14px;font-variant-numeric:tabular-nums}",
			// activity heatmap (GitHub-style dots: 28 day columns × 6 four-hour rows)
			".u_heatBox{display:flex;flex-direction:column;gap:6px}",
			".u_heatHead{display:flex;align-items:center;justify-content:space-between;gap:8px}",
			".u_heatCaption{color:var(--dsw-alias-label-tertiary);font-size:10px;line-height:14px}",
			".u_heatLegend{display:flex;align-items:center;gap:3px;font-size:10px;line-height:14px;color:var(--dsw-alias-label-caption)}",
			".u_heatLegendCell{width:10px;height:10px;border-radius:2px;background:color-mix(in srgb, var(--dsw-alias-label-secondary) 16%, transparent)}",
			".u_heatCalendar{display:grid;grid-template-columns:26px repeat(8,18px);gap:5px;align-items:center;justify-content:center}",
			".u_heatCorner{}",
			".u_heatMonth{color:var(--dsw-alias-label-caption);font-size:9px;line-height:11px;white-space:nowrap;overflow:visible}",
			".u_heatWeekday{color:var(--dsw-alias-label-caption);font-size:9px;line-height:12px;text-align:right;padding-right:1px;white-space:nowrap}",
			".u_heatCell{aspect-ratio:1/1;min-width:0;border-radius:3px;cursor:pointer;background:color-mix(in srgb, var(--dsw-alias-label-secondary) 16%, transparent)}",
			".u_heatToday{box-shadow:0 0 0 1px var(--dsw-alias-label-secondary)}",
			".u_heatCell[data-selected]{box-shadow:0 0 0 2px var(--dsw-alias-state-business-primary)}",
			".u_heatCell[data-selected].u_heatToday{box-shadow:0 0 0 2px var(--dsw-alias-state-business-primary)}",
			".u_heatDetail{margin-top:10px;padding-top:8px;border-top:1px solid var(--dsw-alias-border-l1);display:flex;flex-direction:column;gap:4px}",
			".u_detailHead{display:flex;align-items:baseline;justify-content:space-between;gap:8px}",
			".u_detailDay{color:var(--dsw-alias-label-primary);font-size:12px;font-weight:600;line-height:18px}",
			".u_detailCost{color:var(--dsw-alias-label-primary);font-size:13px;font-weight:600;font-variant-numeric:tabular-nums}",
			".u_detailMeta{display:flex;flex-wrap:wrap;gap:2px 10px;color:var(--dsw-alias-label-tertiary);font-size:10.5px;line-height:15px;font-variant-numeric:tabular-nums}",
			".u_detailLegend{display:flex;gap:10px;margin:2px 0;color:var(--dsw-alias-label-tertiary);font-size:9.5px;line-height:14px}",
			".u_more{border:0;background:transparent;color:var(--dsw-alias-label-secondary);font:inherit;font-size:10.5px;line-height:16px;padding:2px 0;text-align:left;cursor:pointer}",
			".u_more:hover{color:var(--dsw-alias-label-primary)}",
			".u_heatFuture{background:transparent}",
			".u_heatTip{position:fixed;z-index:60;transform:translate(-50%,-100%);pointer-events:none;display:flex;flex-direction:column;gap:1px;padding:6px 8px;border-radius:8px;border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-base);box-shadow:var(--dsw-shadow-lv2);color:var(--dsw-alias-label-primary);font-size:11px;line-height:15px;white-space:nowrap}",
			".u_heatTipDate{color:var(--dsw-alias-label-secondary);font-variant-numeric:tabular-nums}",
			".u_heatTipCost{color:var(--dsw-alias-label-primary);font-weight:600}",
			".u_hoverTip{max-width:240px;white-space:normal;text-align:left}",
			// compact day activity strip (6 four-hour dots for today)
			// dual channel comparison
		];
		if (typeof document !== "undefined" && typeof document.createElement === "function") {
			const style = document.createElement("style");
			style.textContent = css.join("");
			document.head.appendChild(style);
		}
		//#endregion

		//#region helpers
		function createLoader() {
			let seq = 0;
			return { start: () => ++seq, isCurrent: (s) => s === seq };
		}

		async function fetchJson(path) {
			const response = await fetch(path, { headers: { accept: "application/json" }, cache: "no-store" });
			if (!response.ok) throw new Error(`HTTP ${response.status}`);
			return response.json();
		}

		function interpolate(text, params) {
			if (params === void 0 || params === null) return text;
			return String(text).replace(/\{(\w+)\}/g, (match, key) => params[key] !== void 0 ? String(params[key]) : match);
		}

		/** Pin a date to local noon so day arithmetic never crosses a DST edge. */
		function setTimeToNoon(date) {
			date.setHours(12, 0, 0, 0);
			return date;
		}

		function dayKeyOf(date) {
			const month = String(date.getMonth() + 1).padStart(2, "0");
			const day = String(date.getDate()).padStart(2, "0");
			return `${date.getFullYear()}-${month}-${day}`;
		}

		function todayKey() {
			return dayKeyOf(new Date());
		}

		function dayLabel(dateStr) {
			const parts = String(dateStr).split("-");
			return parts.length === 3 ? `${parts[1]}-${parts[2]}` : dateStr;
		}

		/** Thousands-separated integer. */
		function fmtTokens(value) {
			const n = Number(value);
			if (!Number.isFinite(n)) return String(value ?? "–");
			return n.toLocaleString("en-US");
		}

		/** Compact magnitude: 1.2k / 42.8M / 1.4B. */
		function fmtCompact(value) {
			const n = Number(value);
			if (!Number.isFinite(n)) return "–";
			if (n >= 1e9) return `${(n / 1e9).toFixed(1)}B`;
			if (n >= 1e6) return `${(n / 1e6).toFixed(1)}M`;
			if (n >= 1e3) return `${(n / 1e3).toFixed(1)}k`;
			return fmtTokens(n);
		}

		/** Split a compact magnitude ("988.0k") into ["988.0", "k"]. */
		function splitCompact(text) {
			const match = /^([\d.,]+)([kMB])$/.exec(String(text ?? ""));
			return match === null ? [String(text ?? ""), ""] : [match[1], match[2]];
		}

		function currencySymbol(currency) {
			if (currency === "CNY" || currency === "RMB") return "¥";
			if (currency === "USD") return "$";
			if (currency === "EUR") return "€";
			if (typeof currency === "string" && currency !== "") return `${currency} `;
			return "";
		}

		function fmtCurrency(value, currency) {
			if (value === null || value === void 0) return "–";
			const n = Number(value);
			if (Number.isFinite(n) && String(value).trim() !== "") {
				return `${currencySymbol(currency)}${n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
			}
			return `${currencySymbol(currency)}${value}`;
		}

		/**
		 * Spend formatting (CNY by default). Tiny non-zero amounts render as
		 * "<¥0.01" so a real cost never looks like a free one.
		 */
		function fmtMoney(value, currency) {
			if (value === null || value === void 0) return "—";
			const n = Number(value);
			if (!Number.isFinite(n)) return "—";
			const symbol = currency === "USD" ? "$" : "¥";
			if (n > 0 && n < 0.005) return `<${symbol}0.01`;
			return `${symbol}${n.toFixed(2)}`;
		}

		/** Unrounded spend for tooltips: the display rounds, the data does not. */
		function fmtMoneyExact(value, currency) {
			if (value === null || value === void 0) return "—";
			const n = Number(value);
			if (!Number.isFinite(n)) return "—";
			const symbol = currency === "USD" ? "$" : "¥";
			return `${symbol}${n.toFixed(4)}`;
		}

		/** Integer percentage of part over whole, "0%" when there is nothing. */
		function fmtShare(part, whole) {
			const total = Number(whole);
			const value = Number(part);
			if (!Number.isFinite(total) || !Number.isFinite(value) || total <= 0) return "0%";
			return `${Math.round((value / total) * 100)}%`;
		}

		function fmtHit(rate) {
			if (rate === null || rate === void 0) return "–";
			const n = Number(rate);
			if (!Number.isFinite(n)) return "–";
			return `${n}%`;
		}

		function statusTextOf(account, translate) {
			if (account === null || account === void 0) return translate("balance.loading");
			switch (account.status) {
				case "ok": return translate("status.ok");
				case "disabled": return translate("balance.disabled");
				case "not-configured": return translate("balance.notConfigured", { ref: account.missingCredentials?.[0] ?? "" });
				case "unauthorized": return translate("balance.unauthorized");
				case "rate-limited": return translate("balance.rateLimited");
				case "unavailable": return translate("balance.unavailableStatus");
				case "invalid-response": return translate("balance.invalidResponse");
				case "blocked": return translate("balance.blocked");
				// Older server builds report a DNS-policy rejection as "unsupported";
				// never let that read as "this provider has no balance API".
				case "unsupported": return account.error ? translate("balance.blocked") : translate("balance.unsupported");
				default: return translate("balance.loading");
			}
		}

		/**
		 * Turn one balance failure into an actionable hint.
		 * The upstream HTTP status is the only reliable discriminator, and the
		 * server keeps it verbatim in the error text ("balance API returned HTTP
		 * 401"), so it is parsed back out here instead of guessing from status.
		 * @param status - normalized account status from the server.
		 * @param error - raw error text, may be empty.
		 * @param translate - locale lookup.
		 * @returns hint text, or "" when nothing useful can be said.
		 */
		function balanceHint(status, error, translate) {
			const text = typeof error === "string" ? error : "";
			const code = /HTTP\s+(\d{3})/i.exec(text)?.[1] ?? "";
			if (status === "unauthorized" || code === "401" || code === "403") return translate("balance.hintUnauthorized");
			if (code === "404" || code === "405") return translate("balance.hintNotFound");
			if (status === "rate-limited" || code === "429") return translate("balance.hintRateLimited");
			if (/^5\d\d$/.test(code)) return translate("balance.hintUpstream");
			if (/resolves to a private network/i.test(text)) return translate("balance.hintBlockedDns");
			if (/fetch failed|ENOTFOUND|ECONNREFUSED|ECONNRESET|EAI_AGAIN|ETIMEDOUT|TimeoutError|abort/i.test(text)) return translate("balance.hintNetwork");
			if (status === "invalid-response") return translate("balance.hintInvalidResponse");
			return "";
		}

		function defaultProviderId(list) {
			return list.find((provider) => provider.id === "deepseek-official")?.id
				?? list.find((provider) => provider.configured)?.id
				?? list[0]?.id
				?? null;
		}

		/** 5-level alpha ramp derived from the accent color (heat cells). */
		function heatAlpha(level) {
			return [0, 0.22, 0.42, 0.65, 1][level] ?? 0;
		}

		function heatColor(level) {
			const alpha = heatAlpha(level);
			// Keep the spaces: some CSS parsers (jsdom) reject the tight form and
			// would silently drop the inline background.
			return `color-mix(in srgb, var(--dsw-alias-state-business-primary) ${Math.round(alpha * 100)}%, transparent)`;
		}

		/** Bucket a value into 5 heat levels (0–4) by max. */
		function heatLevel(value, max) {
			if (!(value > 0) || !(max > 0)) return 0;
			const ratio = value / max;
			if (ratio >= 0.8) return 4;
			if (ratio >= 0.5) return 3;
			if (ratio >= 0.25) return 2;
			return 1;
		}
		//#endregion

		//#region settings
		const SETTINGS_KEY = "dsh-usage:settings:v1";
		/** Panel cards, in fixed display order. */
		const WIDGETS = ["balance", "heatmap"];
		/** Cards that start collapsed (the channel split is an optional view). */
		const WIDGET_COLLAPSED_DEFAULT = {};

		function defaultSettings() {
			return {
				dockOffset: 72,
				collapsed: Object.fromEntries(WIDGETS.map((id) => [id, WIDGET_COLLAPSED_DEFAULT[id] === true]))
			};
		}

		function normalizeSettings(value) {
			const base = defaultSettings();
			if (value === null || typeof value !== "object") return base;
			// Older builds stored order/widgets/theme; those keys are dropped here.
			const collapsed = {};
			for (const id of WIDGETS) collapsed[id] = value.collapsed?.[id] ?? base.collapsed[id];
			return {
				dockOffset: Number.isFinite(value.dockOffset) ? Math.min(800, Math.max(0, value.dockOffset)) : base.dockOffset,
				collapsed
			};
		}

		function loadSettings() {
			try {
				const raw = localStorage.getItem(SETTINGS_KEY);
				return raw === null ? defaultSettings() : normalizeSettings(JSON.parse(raw));
			} catch {
				return defaultSettings();
			}
		}

		function saveSettings(settings) {
			try {
				localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
			} catch {
				/* storage full or blocked — settings stay session-only */
			}
		}

		/** React hook: persisted settings + patch updater (object or updater fn). */
		function useSettings() {
			const [settings, setSettings] = react.useState(loadSettings);
			react.useEffect(() => {
				saveSettings(settings);
			}, [settings]);
			const update = react.useCallback((patch) => {
				setSettings((previous) => {
					if (typeof patch === "function") return patch(previous);
					return { ...previous, ...patch };
				});
			}, []);
			return [settings, update];
		}

		/** Flip one card's collapsed flag. */
		function toggleCollapsed(settings, id) {
			return {
				...settings,
				collapsed: { ...settings.collapsed, [id]: !settings.collapsed[id] }
			};
		}
		//#endregion

		//#region locales
		const zh = {
			"panel.title": "用量详情",
			"panel.updatedAt": "更新于 {time}",
			"action.refresh": "刷新",
			"action.retry": "重试",
			"action.close": "关闭",
			"action.back": "返回",
			"action.collapse": "折叠",
			"action.expand": "展开",
			"action.moveUp": "上移",
			"action.moveDown": "下移",
			"action.dockDrag": "拖动调整位置",
			"provider.label": "供应商",
			"status.ok": "正常",
			"widget.balance": "余额",
			"widget.today": "今日用量",
			"widget.hit": "缓存命中率",
			"widget.heatmap": "活跃热力图",
			"widget.recent": "用量记录",
			"heat.caption": "近 8 周",
			"heat.less": "少",
			"heat.more": "多",
			"heat.wd.0": "周一",
			"heat.wd.1": "周二",
			"heat.wd.2": "周三",
			"heat.wd.3": "周四",
			"heat.wd.4": "周五",
			"heat.wd.5": "周六",
			"heat.wd.6": "周日",
			"balance.available": "可用余额",
			"balance.toppedUp": "充值余额",
			"balance.granted": "赠送余额",
			"balance.used": "已用",
			"balance.limit": "总额度",
			"balance.noProvider": "DSH 中没有配置可查询余额的供应商（需要 API Key）",
			"balance.loading": "获取余额中…",
			"balance.notConfigured": "未配置 {ref}（请在 DSH 中配置凭据）",
			"balance.disabled": "余额查询已关闭",
			"balance.unsupported": "该供应商无公开余额接口",
			"balance.unauthorized": "凭据无效",
			"balance.rateLimited": "查询被限流，稍后重试",
			"balance.unavailableStatus": "上游不可用",
			"balance.invalidResponse": "上游响应异常",
			"balance.blocked": "上游域名被 DNS 拦到了内网地址",
			"balance.hintBlockedDns": "DNS 返回了内网/保留地址：多半是 Clash 等 TUN 代理的 fake-IP（198.18.x.x）或 hosts 劫持。fake-IP 已放行；若仍是本机/内网 IP，请检查 hosts 与 DNS。",
			"balance.errorNoDetail": "上游未返回可读原因",
			"balance.hintUnauthorized": "API Key 无效或没有余额查询权限，请到 DSH 设置里重新填写官方 API Key。",
			"balance.hintNotFound": "余额接口不存在：当前 baseURL 可能不是官方地址（多为代理/镜像）。",
			"balance.hintRateLimited": "查询被上游限流，稍后点刷新重试。",
			"balance.hintUpstream": "DeepSeek 上游故障，稍后重试。",
			"balance.hintNetwork": "网络不可达：插件直连上游、不走系统代理，请确认能直连 api.deepseek.com。",
			"balance.hintInvalidResponse": "上游返回了非余额 JSON，可能是代理改写或接口变更。",
			"usage.input": "输入",
			"usage.output": "输出",
			"usage.cacheRead": "缓存读",
			"usage.cacheWrite": "缓存写",
			"usage.loading": "统计聚合中…",
			"usage.partial": "已排除无法读取的会话，数值为可读小计",
			"usage.legacySummary": "旧格式会话 {count} 条未计入",
			"usage.legacyDetail": "0.1 旧格式（压缩）会话无法被当前宿主读取，已排除在可读小计之外。",
			"usage.unreadable": "记录暂不可读，未按零用量计算",
			"usage.partialSummary": "部分统计 · {count} 条会话未计入",
			"usage.unreadableSummary": "用量暂不可用 · {count} 条会话未计入",
			"usage.details": "详情",
			"usage.unavailable": "用量暂不可用",
			"usage.ratioPartial": "统计不完整，暂不计算通道比例",
			"usage.noData": "窗口内暂无用量数据",
			"usage.byModel": "模型",
			"usage.bySession": "会话",
			"usage.noSessions": "无会话明细",
			"usage.unnamedSession": "未命名会话",
			"usage.noModels": "当日无按模型数据",
			"usage.todayHit": "今日缓存命中率",
			"cost.today": "今日花费",
			"cost.peakShort": "峰 {value}",
			"cost.offPeakShort": "谷 {value}",

			"cost.peak": "峰",
			"cost.offPeak": "谷",
			"cost.balance": "余额",
			"cost.noData": "暂无花费数据",
			"cost.bandTitle": "24 小时计价带：琥珀为高峰，其余半价（北京时间）",
			"usage.cumulativeHit": "累计命中 {value}",
			"usage.cumulativeCost": "花费 {value}",
			"usage.cumulativeTokens": "累计用量 {value}",
			"usage.totalSpend": "累计 {value}",
			"usage.hitTrend": "较上次刷新 {value}",
			"usage.hoverHint": "悬停看成分，点击看模型明细",
			"usage.summaryTokens": "用量 {value}",
			"usage.summaryHit": "命中 {value}",
			"usage.totalHit": "累计缓存命中率",
		};
		const en = {
			"panel.title": "Usage detail",
			"panel.updatedAt": "Updated at {time}",
			"action.refresh": "Refresh",
			"action.retry": "Retry",
			"action.close": "Close",
			"action.back": "Back",
			"action.pin": "Pin to dock",
			"action.unpin": "Unpin",
			"action.hide": "Hide",
			"action.collapse": "Collapse",
			"action.expand": "Expand",
			"action.moveUp": "Move up",
			"action.moveDown": "Move down",
			"action.drag": "Drag to reorder",
			"action.dockDrag": "Drag to reposition",
			"hidden.count": "{count} hidden",
			"hidden.restore": "Restore",
			"provider.label": "Provider",
			"status.ok": "OK",
			"widget.balance": "Balance",
			"widget.today": "Today",
			"widget.month": "This month",
			"widget.hit": "Cache hit rate",
			"widget.heatmap": "Activity",
			"widget.recent": "Usage log",
			"heat.caption": "Last 8 weeks",
			"heat.less": "Less",
			"heat.more": "More",
			"heat.wd.0": "Mon",
			"heat.wd.1": "Tue",
			"heat.wd.2": "Wed",
			"heat.wd.3": "Thu",
			"heat.wd.4": "Fri",
			"heat.wd.5": "Sat",
			"heat.wd.6": "Sun",
			"heat.today": "Today's activity",
			"balance.available": "Available balance",
			"balance.toppedUp": "Topped up",
			"balance.granted": "Granted",
			"balance.used": "Used",
			"balance.limit": "Total credits",
			"balance.noProvider": "No provider in DSH can report a balance (an API key is required).",
			"balance.loading": "Fetching balance…",
			"balance.notConfigured": "{ref} is not configured (configure credentials in DSH)",
			"balance.disabled": "Balance queries are disabled.",
			"balance.unsupported": "This provider has no public balance interface.",
			"balance.unauthorized": "The credential is invalid.",
			"balance.rateLimited": "Rate limited; retry later.",
			"balance.unavailableStatus": "Upstream unavailable.",
			"balance.invalidResponse": "Unexpected upstream response.",
			"balance.blocked": "The upstream hostname resolved to a private address.",
			"balance.hintBlockedDns": "DNS returned a private/reserved address: usually a TUN proxy fake-IP (198.18.x.x) or a hosts hijack. fake-IP is allowed now; a real local/LAN address means a broken hosts or DNS setup.",
			"balance.errorNoDetail": "The upstream returned no readable reason.",
			"balance.hintUnauthorized": "The API key is invalid or cannot query the balance endpoint; re-enter the official key in DSH settings.",
			"balance.hintNotFound": "The balance endpoint does not exist; the baseURL is probably not the official host (relay/mirror).",
			"balance.hintRateLimited": "Rate limited by the upstream; retry later.",
			"balance.hintUpstream": "DeepSeek upstream failure; retry later.",
			"balance.hintNetwork": "Network unreachable: the plugin connects directly (no system proxy); check that api.deepseek.com is reachable.",
			"balance.hintInvalidResponse": "The upstream returned non-balance JSON; a proxy may be rewriting it, or the API changed.",
			"usage.input": "Input",
			"usage.output": "Output",
			"usage.cacheRead": "Cache read",
			"usage.cacheWrite": "Cache write",
			"usage.loading": "Aggregating usage…",
			"usage.partial": "Unreadable sessions excluded; values are readable subtotals.",
			"usage.legacySummary": "{count} legacy sessions not counted",
			"usage.legacyDetail": "Legacy compressed (0.1) sessions cannot be read by this host and are excluded from the readable subtotal.",
			"usage.unreadable": "Records unreadable; usage is unknown.",
			"usage.partialSummary": "Partial stats · {count} sessions not counted",
			"usage.unreadableSummary": "Usage unavailable · {count} sessions not counted",
			"usage.details": "Details",
			"usage.unavailable": "Usage unavailable",
			"usage.ratioPartial": "Incomplete statistics; channel ratio unavailable",
			"usage.noData": "No usage inside the window.",
			"usage.byModel": "Model",
			"usage.bySession": "Session",
			"usage.noSessions": "No session breakdown",
			"usage.unnamedSession": "Untitled session",
			"usage.noModels": "No per-model data for this day.",
			"usage.todayHit": "Today's cache hit rate",
			"cost.today": "Spent today",
			"cost.peakShort": "Peak {value}",
			"cost.offPeakShort": "Off {value}",
			"cost.peak": "Peak",
			"cost.offPeak": "Off",
			"cost.balance": "Balance",
			"cost.noData": "No spend data yet",
			"cost.bandTitle": "24h billing band: amber = peak, everything else is half price (Beijing time)",
			"usage.cumulativeHit": "Total hit {value}",
			"usage.cumulativeCost": "spent {value}",
			"usage.cumulativeTokens": "Total {value}",
			"usage.totalSpend": "Total {value}",
			"usage.hitTrend": "{value} vs the previous refresh",
			"usage.hoverHint": "Hover for the breakdown, click for models",
			"usage.summaryTokens": "Used {value}",
			"usage.summaryHit": "Hit {value}",
			"usage.totalHit": "All-time cache hit rate",
			"peak.off": "Off-peak · half of peak rate",
			"peak.on": "Peak hours · standard rate",
			"peak.title": "Peak & Off-Peak Hours",
			"peak.peakRow": "Peak: weekdays 9:00–12:00, 14:00–18:00 (Beijing time)",
			"peak.offRow": "Off-peak: all other hours + weekends",
			"peak.halfRow": "Off-peak is half of peak price",
			"peak.footerWeek": "Peak: Monday to Friday",
			"peak.footerHours": "9:00-12:00  14:00-18:00",
			"peak.footerRest": "(all other hours are off-peak)",
			"peak.footerHalf": "Off-peak price is half of the peak price"
		};
		//#endregion

		//#region small components
		function PinIcon(props) {
			return react_jsx_runtime.jsx("svg", {
				viewBox: "0 0 16 16",
				width: props.size ?? 12,
				height: props.size ?? 12,
				fill: "currentColor",
				"aria-hidden": true,
				children: react_jsx_runtime.jsx("path", { d: "M9.5 1.5 14.5 6.5 12 9l-1 5-3-3-3.5 3.5-1-1L7 10 4 7l5-1 2.5-2.5z" })
			});
		}

		/** Apple-style grabber: three horizontal lines (drag handle affordance). */
		function GripIcon(props) {
			return react_jsx_runtime.jsx("svg", {
				viewBox: "0 0 16 16",
				width: props.size ?? 12,
				height: props.size ?? 12,
				fill: "currentColor",
				"aria-hidden": true,
				children: react_jsx_runtime.jsxs(react_jsx_runtime.Fragment, {
					children: [
						react_jsx_runtime.jsx("rect", { x: 3, y: 3, width: 10, height: 2, rx: 1 }),
						react_jsx_runtime.jsx("rect", { x: 3, y: 7, width: 10, height: 2, rx: 1 }),
						react_jsx_runtime.jsx("rect", { x: 3, y: 11, width: 10, height: 2, rx: 1 })
					]
				})
			});
		}

		/** Walk up from the dock node to the sidebar shell (class/tag heuristics). */
		function findSidebar(node) {
			let cursor = node?.parentElement ?? null;
			while (cursor !== null && cursor !== document.body && cursor !== document.documentElement) {
				const cls = cursor.className;
				if (typeof cls === "string" && (cls.includes("SidebarRoot") || cls.includes("sidebar"))) return cursor;
				if (cursor.tagName === "ASIDE" || cursor.tagName === "NAV") return cursor;
				cursor = cursor.parentElement;
			}
			return null;
		}

		function ProviderPicker({ providers, selected, onSelect, translate }) {
			if (providers.length === 0) return null;
			return react_jsx_runtime.jsxs("label", {
				className: "u_providerPicker",
				children: [
					react_jsx_runtime.jsx("span", { className: "u_providerPickerLabel", children: translate("provider.label") }),
					react_jsx_runtime.jsxs("select", {
						className: "u_providerSelect",
						value: selected ?? "",
						onChange: (event) => onSelect(event.target.value),
						children: providers.map((provider) => react_jsx_runtime.jsx("option", { value: provider.id, children: provider.displayName }, provider.id))
					})
				]
			});
		}

		function BalanceDetail({ account, translate, onRetry }) {
			if (account === null || account === void 0 || account.status === "pending") {
				return react_jsx_runtime.jsx("p", { className: "u_note", children: translate("balance.loading") });
			}
			if (account.mode === "unsupported" || account.scheme === null) {
				return react_jsx_runtime.jsx("p", { className: "u_note", children: translate("balance.unsupported") });
			}
			if (account.status === "disabled") return react_jsx_runtime.jsx("p", { className: "u_note", children: translate("balance.disabled") });
			if (account.status === "not-configured") {
				return react_jsx_runtime.jsx("p", { className: "u_note", children: translate("balance.notConfigured", { ref: account.missingCredentials?.[0] ?? "" }) });
			}
			if (account.status !== "ok" || account.balance === null || account.balance === void 0) {
				// Show what actually went wrong: the status label, the concrete
				// hint derived from the upstream error, and the raw error line so
				// the reason never hides behind a generic "unexpected response".
				const hint = balanceHint(account.status, account.error, translate);
				return react_jsx_runtime.jsxs("div", {
					className: "u_balanceError",
					children: [
						react_jsx_runtime.jsxs("div", {
							className: "u_error",
							children: [
								react_jsx_runtime.jsxs("div", {
									className: "u_errorText",
									children: [
										react_jsx_runtime.jsx("span", { className: "u_errorStatus", children: statusTextOf(account, translate) }, "status"),
										hint !== "" && react_jsx_runtime.jsx("span", { className: "u_errorHint", children: hint }, "hint")
									]
								}),
								react_jsx_runtime.jsx("button", { type: "button", className: "u_retry", onClick: onRetry, children: translate("action.retry") }, "retry")
							]
						}),
						react_jsx_runtime.jsx("code", {
							className: "u_errorRaw",
							title: account.error ?? "",
							children: account.error ?? translate("balance.errorNoDetail")
						}, "raw")
					]
				});
			}
			const balance = account.balance;
			const rows = [
				{ label: translate("balance.toppedUp"), value: balance.toppedUp },
				{ label: translate("balance.granted"), value: balance.granted }
			].filter((row) => row.value !== null && row.value !== void 0);
			const positive = balance.isAvailable !== false;
			return react_jsx_runtime.jsxs("div", {
				className: "u_balanceGrid",
				children: [
					react_jsx_runtime.jsxs("div", {
						className: "u_balanceLeft",
						children: [
							react_jsx_runtime.jsx("span", { className: "u_balanceAmount", children: fmtCurrency(balance.total, balance.currency) }),
							react_jsx_runtime.jsx("span", {
								className: positive ? "u_balanceStatus u_balanceOk" : "u_balanceStatus u_balanceBad",
								children: translate(positive ? "status.ok" : "balance.unavailableStatus")
							})
						]
					}),
					react_jsx_runtime.jsx("div", {
						className: "u_balanceTable",
						children: rows.flatMap((row) => [
							react_jsx_runtime.jsx("span", { className: "u_balanceTableLabel", children: row.label }, `l-${row.label}`),
							react_jsx_runtime.jsx("span", { className: "u_balanceTableValue", children: fmtCurrency(row.value, balance.currency) }, `v-${row.label}`)
						])
					})
				]
			});
		}

		function TokenBreakdown({ buckets, translate }) {
			const items = [
				[translate("usage.input"), buckets.inputTokens ?? 0],
				[translate("usage.output"), buckets.outputTokens ?? 0],
				[translate("usage.cacheRead"), buckets.cacheReadTokens ?? 0]
			];
			return react_jsx_runtime.jsx("div", {
				className: "u_statBreak",
				children: items.map(([label, value]) => react_jsx_runtime.jsxs("span", {
					className: "u_statBreakItem",
					children: [label, " ", react_jsx_runtime.jsx("b", { children: fmtCompact(value) })]
				}, label))
			});
		}

		function DayDetail({ day, onBack, translate, currency }) {
			const models = Array.isArray(day?.models) ? day.models : [];
			const sessions = Array.isArray(day?.sessions) ? day.sessions : [];
			const dayCost = day?.cost ?? null;
			const [view, setView] = react.useState("model");
			const labelOf = (session) => {
				if (typeof session.title === "string" && session.title !== "") return session.title;
				const time = session.createdAt ? new Date(session.createdAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) : null;
				const dir = typeof session.cwd === "string" && session.cwd !== "" ? session.cwd.split(/[\\/]/).filter(Boolean).pop() : null;
				const parts = [time, dir].filter((part) => part !== null && part !== "");
				return parts.length === 0 ? translate("usage.unnamedSession") : parts.join(" · ");
			};
			return react_jsx_runtime.jsxs(react_jsx_runtime.Fragment, {
				children: [
					react_jsx_runtime.jsxs("div", {
						className: "u_detailHeader",
						children: [
							react_jsx_runtime.jsx("button", {
								type: "button",
								className: "u_back",
								"aria-label": translate("action.back"),
								onClick: onBack,
								children: react_jsx_runtime.jsx(primitives.IconChevronLeftOutline14, { size: 14 })
							}),
							react_jsx_runtime.jsx("span", { className: "u_detailDate", children: day.date }),
							react_jsx_runtime.jsx("span", { className: "u_detailHit", children: fmtMoney(dayCost?.total, currency) })
						]
					}),
					react_jsx_runtime.jsxs("div", {
						className: "u_detailTabs",
						children: [
							react_jsx_runtime.jsx("button", {
								type: "button",
								className: "u_segBtn",
								"data-active": view === "model" ? true : void 0,
								onClick: () => setView("model"),
								children: translate("usage.byModel")
							}),
							react_jsx_runtime.jsx("button", {
								type: "button",
								className: "u_segBtn",
								"data-active": view === "session" ? true : void 0,
								onClick: () => setView("session"),
								children: translate("usage.bySession")
							})
						]
					}),
					react_jsx_runtime.jsxs("div", {
						className: "u_detailSummary",
						children: [
							react_jsx_runtime.jsx("span", { children: translate("usage.summaryTokens", { value: fmtCompact(day?.tokens ?? 0) }) }),
							react_jsx_runtime.jsx("span", { children: translate("usage.summaryHit", { value: fmtHit(day?.cacheHitRate) }) }),
							dayCost !== null && react_jsx_runtime.jsx("span", { children: translate("cost.peakShort", { value: fmtMoney(dayCost.peak, currency) }) }),
							dayCost !== null && react_jsx_runtime.jsx("span", { children: translate("cost.offPeakShort", { value: fmtMoney(dayCost.offPeak, currency) }) })
						]
					}),
					view === "session"
						? sessions.length === 0
							? react_jsx_runtime.jsx("p", { className: "u_note", children: translate("usage.noSessions") })
							: react_jsx_runtime.jsx("div", {
								className: "u_modelList",
								children: sessions.map((session) => react_jsx_runtime.jsxs("div", {
									className: "u_modelRow",
									children: [
										react_jsx_runtime.jsxs("div", {
											className: "u_modelMeta",
											children: [
												react_jsx_runtime.jsx("span", { className: "u_modelName", title: session.id, children: labelOf(session) }),
												react_jsx_runtime.jsx("span", { className: "u_modelCost", children: fmtMoney(session.cost?.total, currency) })
											]
										}),
										react_jsx_runtime.jsx(CompositionBar, { buckets: session, className: "u_bar", translate, tips: false })
									]
								}, session.id))
							})
						: models.length === 0
						? react_jsx_runtime.jsx("p", { className: "u_note", children: translate("usage.noModels") })
						: react_jsx_runtime.jsx("div", {
							className: "u_modelList",
							children: models.map((model) => react_jsx_runtime.jsxs("div", {
								className: "u_modelRow",
								children: [
									react_jsx_runtime.jsxs("div", {
										className: "u_modelMeta",
										children: [
											react_jsx_runtime.jsx("span", { className: "u_modelName", title: model.model, children: model.model }),
											react_jsx_runtime.jsx("span", { className: "u_modelCost", children: fmtMoney(model.cost?.total, currency) })
										]
									}),
									react_jsx_runtime.jsx(CompositionBar, { buckets: model, className: "u_bar", translate, tips: false })
								]
							}, model.model))
						})
				]
			});
		}
		//#endregion

		//#region main component

		/**
		 * 24-hour billing band: the two peak windows are amber blocks, the marker
		 * is the current Beijing time. On weekends/holidays the blocks dim, which
		 * says "the windows do not apply today" without any sentence.
		 * @param props - `peak` ("yellow" | "green") and the locale lookup.
		 */
		function PeakBand({ peak, translate }) {
			const now = new Date();
			const beijing = new Date(now.getTime() + 8 * 60 * 60 * 1000);
			const minutes = beijing.getUTCHours() * 60 + beijing.getUTCMinutes();
			const weekday = beijing.getUTCDay();
			const workday = weekday >= 1 && weekday <= 5;
			// Compressed day: idle stretches narrowed, peak windows widened. Clock
			// times sit under the junctions ("9时", "12时" ...), not inside the bar.
			const zones = [
				{ kind: "off", from: 0, to: 540, weight: 1, edge: "" },
				{ kind: "peak", from: 540, to: 720, weight: 1.3, edge: "9时" },
				{ kind: "off", from: 720, to: 840, weight: 0.8, edge: "12时" },
				{ kind: "peak", from: 840, to: 1080, weight: 1.3, edge: "14时" },
				{ kind: "off", from: 1080, to: 1440, weight: 1, edge: "18时" }
			];
			const totalWeight = zones.reduce((sum, zone) => sum + zone.weight, 0);
			let offset = 0;
			let marker = 0;
			const edges = [];
			for (const zone of zones) {
				const share = zone.weight / totalWeight;
				if (zone.edge !== "") edges.push({ at: offset * 100, label: zone.edge });
				if (minutes >= zone.from && minutes < zone.to) {
					marker = offset + share * ((minutes - zone.from) / (zone.to - zone.from));
				}
				offset += share;
			}
			return react_jsx_runtime.jsxs("div", {
				className: "u_bandBox",
				title: translate("cost.bandTitle"),
				"aria-label": translate("cost.bandTitle"),
				children: [
					react_jsx_runtime.jsxs("div", {
						className: "u_band",
						children: [
							...zones.map((zone) => react_jsx_runtime.jsx("span", {
								className: "u_bandZone",
								"data-kind": zone.kind,
								"data-dim": zone.kind === "peak" && !workday ? true : void 0,
								style: { flexGrow: zone.weight }
							}, zone.from)),
							react_jsx_runtime.jsx("span", {
								className: "u_bandNow",
								"data-peak": peak,
								style: { left: `${(marker * 100).toFixed(2)}%` }
							}, "now")
						]
					}),
					react_jsx_runtime.jsx("div", {
						className: "u_bandEdges",
						children: edges.map((edge) => react_jsx_runtime.jsx("span", {
							className: "u_bandEdge",
							style: { left: `${edge.at.toFixed(2)}%` },
							children: edge.label
						}, edge.label))
					})
				]
			});
		}

		/** Three-segment token composition bar: input / cacheRead / output. */
		function CompositionBar({ buckets, className, translate, tips = true }) {
			const input = Number(buckets?.inputTokens ?? 0) || 0;
			const cacheRead = Number(buckets?.cacheReadTokens ?? 0) || 0;
			const output = Number(buckets?.outputTokens ?? 0) || 0;
			const sum = input + cacheRead + output;
			if (sum <= 0) return null;
			// A tiny kind (output is often <5%) still gets a 3px sliver so the bar
			// never looks like it only has one or two components.
			const seg = (kind, label, value) => react_jsx_runtime.jsx("span", {
				className: "u_barSeg",
				"data-kind": kind,
				style: { width: `${(value / sum) * 100}%`, minWidth: value > 0 ? "3px" : "0" },
				title: tips ? `${label} ${fmtTokens(value)} · ${Math.round((value / sum) * 100)}%` : void 0
			}, kind);
			const labelOf = (key, fallback) => (typeof translate === "function" ? translate(key) : fallback);
			return react_jsx_runtime.jsxs("span", {
				className,
				children: [
					seg("input", labelOf("usage.input", "输入"), input),
					seg("cacheRead", labelOf("usage.cacheRead", "缓存读"), cacheRead),
					seg("output", labelOf("usage.output", "输出"), output)
				]
			});
		}

		/**
		 * Sidebar footer action: floating dock + detail panel.
		 * @param props - `wide` from the sidebar shell, `t` bound by the slot runtime.
		 */
		function UsagePanel({ wide, t }) {
			const translate = (key, params) => interpolate(t !== void 0 ? t(key) : key, params);
			const [settings, updateSettings] = useSettings();
			const [open, setOpen] = react.useState(false);
			const [dockOpen, setDockOpen] = react.useState(false);
			const panelRef = react.useRef(null);

			// Panel closing rules: Escape, a click outside, or the gear again.
			react.useEffect(() => {
				if (!open) return void 0;
				const onKey = (event) => {
					if (event.key === "Escape") {
						event.stopPropagation();
						setOpen(false);
					}
				};
				const onDown = (event) => {
					const panel = panelRef.current;
					if (panel === null) return;
					const target = event.target;
					if (typeof Node !== "undefined" && target instanceof Node && panel.contains(target)) return;
					if (typeof Element !== "undefined" && target instanceof Element && target.closest("[data-dsh-usage-dock], .u_railBtn")) return;
					setOpen(false);
				};
				document.addEventListener("keydown", onKey);
				document.addEventListener("pointerdown", onDown, true);
				return () => {
					document.removeEventListener("keydown", onKey);
					document.removeEventListener("pointerdown", onDown, true);
				};
			}, [open]);
			const [providers, setProviders] = react.useState([]);
			const [selectedProvider, setSelectedProvider] = react.useState(null);
			const [account, setAccount] = react.useState(null);
			const [accountLoading, setAccountLoading] = react.useState(false);
			const [accountError, setAccountError] = react.useState(null);
			const [usage, setUsage] = react.useState(null);
			const [usageError, setUsageError] = react.useState(null);
			const [selectedDate, setSelectedDate] = react.useState(todayKey);
			const [showAllSessions, setShowAllSessions] = react.useState(false);
			const [heatTip, setHeatTip] = react.useState(null);
			// Hit-rate direction versus the previous refresh (green up / red down / grey flat).
			const [hitTrend, setHitTrend] = react.useState(null);
			const [costTip, setCostTip] = react.useState(null);
			const [panelPos, setPanelPos] = react.useState(null);
			const [dockExpanded, setDockExpanded] = react.useState(false);
			const [hoverTip, setHoverTip] = react.useState(null);
			const hoverTargetRef = react.useRef(null);
			const uiRootRef = react.useRef(null);
			const hitTrendRef = react.useRef(null);
			const [refreshedAt, setRefreshedAt] = react.useState(null);
			// 计价档位：固定按北京时间判断，每 60s 重算
			const [peak, setPeak] = react.useState(() => peakState(new Date()));
			react.useEffect(() => {
				const id = setInterval(() => setPeak(peakState(new Date())), 60000);
				return () => clearInterval(id);
			}, []);
			const mountedRef = react.useRef(true);
			const usageLoaderRef = react.useRef(null);
			const accountLoaderRef = react.useRef(null);
			if (usageLoaderRef.current === null) usageLoaderRef.current = createLoader();
			if (accountLoaderRef.current === null) accountLoaderRef.current = createLoader();

			const loadProviders = react.useCallback(() => {
				fetchJson("/api/usage/providers").then((payload) => {
					if (!mountedRef.current) return;
					const list = payload?.ok === true && Array.isArray(payload.providers) ? payload.providers : [];
					setProviders(list);
					// Only providers configured in DSH AND backed by a public balance
					// endpoint are selectable: no hardcoded list, no dead entries.
					const usable = list.filter((provider) => provider.scheme !== null && provider.configured === true);
					setSelectedProvider((previous) => previous !== null && usable.some((provider) => provider.id === previous)
						? previous
						: defaultProviderId(usable));
				}).catch(() => { /* keep the previous list */ });
			}, []);

			const loadAccount = react.useCallback((providerId, force) => {
				if (providerId === null || providerId === void 0 || providerId === "") return;
				const seq = accountLoaderRef.current.start();
				setAccountLoading(true);
				setAccountError(null);
				fetchJson(`/api/usage/balance?provider=${encodeURIComponent(providerId)}${force ? "&refresh=1" : ""}`).then((payload) => {
					if (!mountedRef.current || !accountLoaderRef.current.isCurrent(seq)) return;
					setAccountLoading(false);
					if (payload?.ok !== true) {
						setAccount(null);
						setAccountError(payload?.message ?? "balance failed");
						return;
					}
					setAccount(payload.account ?? null);
				}).catch((error) => {
					if (!mountedRef.current || !accountLoaderRef.current.isCurrent(seq)) return;
					setAccountLoading(false);
					setAccountError(error instanceof Error ? error.message : String(error));
				});
			}, []);

			const loadUsage = react.useCallback(() => {
				const seq = usageLoaderRef.current.start();
				setUsageError(null);
				fetchJson("/api/usage/usage").then((payload) => {
					if (!mountedRef.current || !usageLoaderRef.current.isCurrent(seq)) return;
					if (payload?.ok !== true) {
						setUsage(null);
						setUsageError(payload?.message ?? "usage failed");
						return;
					}
					setUsage(payload);
					setRefreshedAt(Date.now());
				}).catch((error) => {
					if (!mountedRef.current || !usageLoaderRef.current.isCurrent(seq)) return;
					setUsage(null);
					setUsageError(error instanceof Error ? error.message : String(error));
				});
			}, []);

			react.useEffect(() => {
				mountedRef.current = true;
				loadProviders();
				loadUsage();
				return () => {
					mountedRef.current = false;
				};
			}, [loadProviders, loadUsage]);

			react.useEffect(() => {
				if (selectedProvider === null) return;
				loadAccount(selectedProvider, false);
			}, [selectedProvider, loadAccount]);

			react.useEffect(() => {
				// Both halves of the number move on their own: the dock is useful only
				// if it is as fresh as the session log, so poll at 60s whether the panel
				// is open or not (the server collection is incremental).
				const tick = () => {
					if (selectedProvider !== null) loadAccount(selectedProvider, false);
					loadUsage();
				};
				const timer = setInterval(tick, 30000);
				return () => clearInterval(timer);
			}, [open, selectedProvider, loadAccount, loadUsage]);

			// Native title tooltips wait ~1s; take them over and show our card at once.
			react.useEffect(() => {
				const restore = () => {
					const target = hoverTargetRef.current;
					if (target === null) return;
					const text = target.getAttribute("data-tip");
					if (text !== null) {
						target.setAttribute("title", text);
						target.removeAttribute("data-tip");
					}
					hoverTargetRef.current = null;
					setHoverTip(null);
				};
				const show = (event) => {
					const node = event.target instanceof Element ? event.target.closest("[title]") : null;
					if (node === null || uiRootRef.current === null || !uiRootRef.current.contains(node)) return;
					const text = node.getAttribute("title");
					if (text === null || text === "") return;
					if (hoverTargetRef.current !== null && hoverTargetRef.current !== node) restore();
					node.setAttribute("data-tip", text);
					node.removeAttribute("title");
					const rect = node.getBoundingClientRect();
					hoverTargetRef.current = node;
					setHoverTip({ text, x: rect.left + rect.width / 2, y: rect.top - 6 });
				};
				const hide = (event) => {
					const target = hoverTargetRef.current;
					if (target === null) return;
					if (event.relatedTarget instanceof Node && target.contains(event.relatedTarget)) return;
					restore();
				};
				document.addEventListener("pointerover", show, true);
				document.addEventListener("pointerout", hide, true);
				window.addEventListener("blur", restore);
				return () => {
					document.removeEventListener("pointerover", show, true);
					document.removeEventListener("pointerout", hide, true);
					window.removeEventListener("blur", restore);
				};
			}, []);

			// Centre the panel on the dock, then shift it to stay inside the viewport.
			react.useLayoutEffect(() => {
				if (!open) return void 0;
				const compute = () => {
					const dock = dockRef.current;
					const panel = panelRef.current;
					if (dock === null || panel === null) return;
					const dockRect = dock.getBoundingClientRect();
					const viewport = window.innerHeight || 800;
					// The dock sits above the sidebar footer ("更多"), so its bottom edge is
					// the hard floor: the panel must never extend past it.
					const floor = Math.min(viewport - 8, dockRect.bottom - 8);
					const maxHeight = Math.max(240, floor - 16);
					const height = Math.min(panel.scrollHeight, maxHeight);
					const wanted = dockRect.top + dockRect.height / 2 - height / 2;
					const top = Math.max(8, Math.min(wanted, floor - height));
					setPanelPos({ top: Math.round(top - dockRect.top), maxHeight: Math.round(maxHeight) });
				};
				compute();
				const late = window.setTimeout(compute, 80);
				window.addEventListener("resize", compute);
				return () => {
					window.clearTimeout(late);
					window.removeEventListener("resize", compute);
				};
			}, [open, usage, settings.dockOffset]);

			const retry = () => {
				loadProviders();
				loadUsage();
				if (selectedProvider !== null) loadAccount(selectedProvider, true);
			};

			// Coming back to the window should not show a stale number.
			react.useEffect(() => {
				const refreshOnReturn = () => {
					if (document.visibilityState !== "visible") return;
					loadUsage();
					if (selectedProvider !== null) loadAccount(selectedProvider, false);
				};
				document.addEventListener("visibilitychange", refreshOnReturn);
				window.addEventListener("focus", refreshOnReturn);
				return () => {
					document.removeEventListener("visibilitychange", refreshOnReturn);
					window.removeEventListener("focus", refreshOnReturn);
				};
			}, [loadUsage, loadAccount, selectedProvider]);

			const usableProviders = react.useMemo(
				() => providers.filter((provider) => provider.scheme !== null && provider.configured === true),
				[providers]
			);

			const selectedDayEntry = Array.isArray(usage?.days) ? usage.days.find((day) => day.date === selectedDate) ?? null : null;
			const daySessions = Array.isArray(selectedDayEntry?.sessions) ? selectedDayEntry.sessions : [];
			const visibleSessions = showAllSessions ? daySessions : daySessions.slice(0, 5);
			const hiddenSessions = daySessions.length - visibleSessions.length;
			const usageUnavailable = usage === null || usage.coverage?.status === "unavailable";
			const usagePartial = usage?.coverage?.status === "partial";
			const skippedSessions = Array.isArray(usage?.coverage?.skippedSessions) ? usage.coverage.skippedSessions : [];
			// 0.1 legacy compressed logs are expected leftovers the host cannot
			// open: keep them out of the top warning, list them in the disclosure.
			const legacyOnly = usagePartial && skippedSessions.length > 0
				&& skippedSessions.every((entry) => entry.reason === "unsupported-format");
			// Legacy-only skips neither show the warning dot nor block the
			// channel-share widget.
			const coverageNotice = usagePartial || usage?.coverage?.status === "unavailable"
				? translate(usagePartial ? (legacyOnly ? "usage.legacyDetail" : "usage.partial") : "usage.unreadable", { count: skippedSessions.length }) : null;
			const coverageSummary = coverageNotice !== null
				? translate(usagePartial ? (legacyOnly ? "usage.legacySummary" : "usage.partialSummary") : "usage.unreadableSummary", { count: skippedSessions.length }) : null;
			const emptyUsageText = usageUnavailable
				? translate(usageError !== null || coverageNotice !== null ? "usage.unavailable" : "usage.loading") : translate("usage.noData");

			// Derived stats shared by several widgets.
			const stats = react.useMemo(() => {
				if (usageUnavailable || !Array.isArray(usage.days)) return null;
				const today = todayKey();
				const month = today.slice(0, 7);
				const addBucket = (target, entry) => {
					target.inputTokens += Number(entry.inputTokens ?? 0) || 0;
					target.outputTokens += Number(entry.outputTokens ?? 0) || 0;
					target.cacheReadTokens += Number(entry.cacheReadTokens ?? 0) || 0;
					target.cacheWriteTokens += Number(entry.cacheWriteTokens ?? 0) || 0;
				};
				const dayBuckets = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };
				const monthBuckets = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };
				let totalTokensSum = 0;
				let todayHit = null;
				for (const day of usage.days) {
					totalTokensSum += Number(day.tokens ?? 0) || 0;
					if (day.date === today) {
						addBucket(dayBuckets, day);
						todayHit = day.cacheHitRate ?? null;
					}
					if (day.date.startsWith(month)) addBucket(monthBuckets, day);
				}
				const bucketTokens = (buckets) => buckets.inputTokens + buckets.outputTokens + buckets.cacheReadTokens + buckets.cacheWriteTokens;
				return {
					day: { ...dayBuckets, tokens: bucketTokens(dayBuckets) },
					month: { ...monthBuckets, tokens: bucketTokens(monthBuckets) },
					total: usage.total ?? { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, tokens: totalTokensSum },
					todayHit,
					totalHit: usage.total?.cacheHitRate ?? null
				};
			}, [usage]);
			// Show the exact readable subtotal; the coverage notice below explains
			// that unreadable sessions are excluded (no "≥" prefix — the subtotal
			// itself is a precise number).
			const dayTitleOf = (key) => {
				const weekday = (new Date(Number(key.slice(0, 4)), Number(key.slice(5, 7)) - 1, Number(key.slice(8, 10))).getDay() + 6) % 7;
				return `${Number(key.slice(5, 7))}月${Number(key.slice(8, 10))}日 ${translate(`heat.wd.${weekday}`)}`;
			};
			const sessionLabelOf = (session, translate) => {
				if (typeof session.title === "string" && session.title !== "") return session.title;
				return translate("usage.unnamedSession");
			};
			const usageValue = (tokens) => stats === null ? "—" : fmtCompact(tokens);
			react.useEffect(() => {
				const current = Number(stats?.todayHit);
				if (stats === null || !Number.isFinite(current)) {
					hitTrendRef.current = null;
					setHitTrend(null);
					return;
				}
				const previous = hitTrendRef.current;
				hitTrendRef.current = current;
				if (previous === null) return void setHitTrend(null);
				const delta = current - previous;
				setHitTrend({ dir: delta > 0.049 ? "up" : delta < -0.049 ? "down" : "flat", delta });
			}, [stats]);

			const recent = react.useMemo(() => {
				if (usageUnavailable || !Array.isArray(usage.days)) return [];
				const cutoff = new Date();
				cutoff.setDate(cutoff.getDate() - 13);
				const cutoffKey = dayKeyOf(cutoff);
				const today = todayKey();
				return usage.days.filter((day) => day.date >= cutoffKey && day.date <= today && (Number(day.tokens ?? 0) || 0) > 0).reverse();
			}, [usage]);

			const dayMap = react.useMemo(() => {
				const map = new Map();
				if (usage !== null && Array.isArray(usage.days)) for (const day of usage.days) map.set(day.date, day);
				return map;
			}, [usage]);

			// Balance compact tone + value: green while healthy, red when the
			// account is out of credit or broken, neutral otherwise.
			// Balance compact tone + value: green while healthy, red only when the
			// account is genuinely out of credit. A failed balance query is NOT a
			// broken account: show a neutral dash and keep the reason in a tooltip
			// instead of shouting "!".
			const balanceCompact = (() => {
				if (accountLoading && account === null) return { value: "…", tone: null, hint: null };
				if (account === null) return { value: accountError !== null ? "—" : "–", tone: null, hint: accountError };
				if (account.mode === "unsupported" || account.scheme === null) return { value: "–", tone: null, hint: statusTextOf(account, translate) };
				if (account.status === "not-configured" || account.status === "disabled") return { value: "–", tone: null, hint: statusTextOf(account, translate) };
				if (account.status !== "ok" || account.balance === null || account.balance === void 0) {
					return {
						value: "—",
						tone: null,
						hint: [statusTextOf(account, translate), account.error].filter((part) => typeof part === "string" && part !== "").join(" · ")
					};
				}
				if (account.balance.isAvailable === false) return { value: fmtCurrency(account.balance.total, account.balance.currency), tone: "bad", hint: statusTextOf(account, translate) };
				return { value: fmtCurrency(account.balance.total, account.balance.currency), tone: "ok", hint: null };
			})();

			// Activity heatmap: 13 week-columns × 7 weekday rows (day-level tokens).
			const heatData = react.useMemo(() => {
				if (usageUnavailable || !Array.isArray(usage.days)) return null;
				const byDate = new Map(usage.days.map((day) => [day.date, { tokens: Number(day.tokens ?? 0) || 0, cost: day.cost ?? null }]));
				const today = todayKey();
				const end = new Date();
				setTimeToNoon(end);
				// Monday of the current week, then twelve weeks back.
				const start = new Date(end);
				start.setDate(start.getDate() - ((start.getDay() + 6) % 7) - 7 * 7);
				const weeks = [];
				const cursor = new Date(start);
				let max = 0;
				let previousMonth = null;
				for (let w = 0; w < 8; w += 1) {
					const cells = [];
					for (let d = 0; d < 7; d += 1) {
						const key = dayKeyOf(cursor);
						const day = byDate.get(key) ?? { tokens: 0, cost: null };
						if (day.tokens > max) max = day.tokens;
						cells.push({ key, tokens: day.tokens, cost: day.cost, future: key > today });
						cursor.setDate(cursor.getDate() + 1);
					}
					const month = Number(cells[0].key.slice(5, 7));
					weeks.push({ cells, label: previousMonth === null || month !== previousMonth ? `${month}月` : "" });
					previousMonth = month;
				}
				const rows = [];
				for (let r = 0; r < 7; r += 1) {
					rows.push(weeks.map((week) => {
						const cell = week.cells[r];
						return { ...cell, level: cell.future ? -1 : heatLevel(cell.tokens, max) };
					}));
				}
				return { weeks, rows, max, today };
			}, [usage]);

			// Dual channel comparison (DSH sessions vs Claude Code JSONL logs).
			// Dock sizing: track the sidebar shell so the dock always centers inside
			// it (equal gaps on both sides), aligned with the settings area below.
			const dockRef = react.useRef(null);
			const [dockMetrics, setDockMetrics] = react.useState(null);
			react.useEffect(() => {
				const dock = dockRef.current;
				if (dock === null) return void 0;
				const sidebar = findSidebar(dock);
				if (sidebar === null) return void 0;
				const measure = () => {
					const rect = sidebar.getBoundingClientRect();
					const style = getComputedStyle(sidebar);
					const padLeft = parseFloat(style.paddingLeft) || 0;
					const padRight = parseFloat(style.paddingRight) || 0;
					// Inset the dock by a fixed margin on both sides so it never
					// touches the sidebar edges.
					const margin = 20;
					const width = rect.width - padLeft - padRight - margin * 2;
					if (width > 0) setDockMetrics({ left: rect.left + padLeft + margin, width, centerX: rect.left + rect.width / 2, rightEdge: rect.right });
					else setDockMetrics({ left: 14, width: 0, centerX: rect.left + rect.width / 2, rightEdge: rect.right });
				};
				measure();
				if (typeof ResizeObserver !== "undefined") {
					const observer = new ResizeObserver(measure);
					observer.observe(sidebar);
					return () => observer.disconnect();
				}
				return void 0;
			}, []);

			// Panel geometry: a popover that grows UP from the floating dock, so it
			// stays attached to the gear the user clicked. Measured once at open
			// (and on resize) — never tracked per frame, so it cannot drift.
			const [panelBox, setPanelBox] = react.useState(null);
			const measurePanel = react.useCallback(() => {
				const dock = dockRef.current;
				if (dock === null) return;
				const rect = dock.getBoundingClientRect();
				// DSH animates its columns with transforms, so viewport math is wrong
				// here: anchor to the ancestor that actually positions fixed children.
				const host = dock.offsetParent instanceof Element ? dock.offsetParent : document.body;
				const hostRect = host.getBoundingClientRect();
				const left = Math.round(rect.right - hostRect.left + 12);
				const bottom = Math.round(hostRect.bottom - rect.bottom);
				const width = Math.max(300, Math.min(420, Math.round(hostRect.width - left - 16)));
				setPanelBox({ left, bottom, width: Math.round(width), maxHeight: Math.max(260, Math.round(hostRect.height - 32)) });
			}, []);
			const openPanel = () => {
				measurePanel();
				setOpen(true);
			};
			react.useEffect(() => {
				if (!open) return void 0;
				const onResize = () => measurePanel();
				window.addEventListener("resize", onResize);
				return () => window.removeEventListener("resize", onResize);
			}, [open, measurePanel]);

			// Dock vertical repositioning: press the top-left grip and drag;
			// the offset persists in settings.
			const dockDragRef = react.useRef(null);
			const onDockGripDown = (event) => {
				dockDragRef.current = { startY: event.clientY, startOffset: settings.dockOffset };
				try {
					event.currentTarget.setPointerCapture?.(event.pointerId);
				} catch {
					/* jsdom/older engines */
				}
			};
			const onDockGripMove = (event) => {
				const drag = dockDragRef.current;
				if (drag === null) return;
				const next = Math.min(800, Math.max(0, drag.startOffset + (drag.startY - event.clientY)));
				if (next !== settings.dockOffset) updateSettings({ dockOffset: next });
			};
			const onDockGripUp = () => {
				dockDragRef.current = null;
			};

			const toggleWidgetKey = (id) => updateSettings(toggleCollapsed(settings, id));

			const costCurrency = usage?.costMeta?.currency ?? "CNY";
			const todayEntry = Array.isArray(usage?.days) ? usage.days.find((day) => day.date === todayKey()) ?? null : null;
			const todayCost = todayEntry?.cost ?? null;
			const totalCost = usage?.total?.cost ?? null;

			// Panel card bodies.
			const balanceBody = usableProviders.length === 0
				? react_jsx_runtime.jsx("p", { className: "u_note", children: translate("balance.noProvider") })
				: react_jsx_runtime.jsxs(react_jsx_runtime.Fragment, {
					children: [
						usableProviders.length > 1
							? react_jsx_runtime.jsx(ProviderPicker, { providers: usableProviders, selected: selectedProvider, onSelect: setSelectedProvider, translate })
							: react_jsx_runtime.jsxs("div", {
								className: "u_providerLine",
								children: [
									react_jsx_runtime.jsx("span", { className: "u_providerPickerLabel", children: translate("provider.label") }),
									react_jsx_runtime.jsx("span", { className: "u_providerName", children: usableProviders[0].displayName })
								]
							}),
						react_jsx_runtime.jsx(BalanceDetail, { account, translate, onRetry: retry })
					]
				});

			const heatmapBody = heatData === null
				? react_jsx_runtime.jsx("p", { className: "u_note", children: emptyUsageText })
				: react_jsx_runtime.jsxs("div", {
					className: "u_heatBox",
					children: [
						react_jsx_runtime.jsxs("div", {
							className: "u_heatHead",
							children: [
								react_jsx_runtime.jsx("span", { className: "u_heatCaption", children: translate("heat.caption") }),
								react_jsx_runtime.jsxs("span", {
									className: "u_heatLegend",
									children: [
										react_jsx_runtime.jsx("span", { children: translate("heat.less") }),
										...[0, 1, 2, 3, 4].map((level) => react_jsx_runtime.jsx("span", {
											className: "u_heatLegendCell",
											style: { background: level === 0 ? void 0 : heatColor(level) }
										}, level)),
										react_jsx_runtime.jsx("span", { children: translate("heat.more") })
									]
								})
							]
						}),
						react_jsx_runtime.jsxs("div", {
							className: "u_heatCalendar",
							children: [
								react_jsx_runtime.jsx("div", { className: "u_heatCorner" }),
								...heatData.weeks.map((week, index) => react_jsx_runtime.jsx("div", {
									className: "u_heatMonth",
									children: week.label
								}, `m-${index}`)),
								...heatData.rows.flatMap((cells, row) => [
									react_jsx_runtime.jsx("div", {
										className: "u_heatWeekday",
										children: translate(`heat.wd.${row}`)
									}, `wd-${row}`),
									...cells.map((cell) => react_jsx_runtime.jsx("div", {
										className: [
											"u_heatCell",
											cell.key === heatData.today ? "u_heatToday" : "",
											cell.future ? "u_heatFuture" : ""
										].filter((name) => name !== "").join(" "),
										style: cell.level > 0 ? { background: heatColor(cell.level) } : void 0,
										"data-selected": cell.key === selectedDate ? true : void 0,
										onClick: () => {
											setSelectedDate(cell.key);
											setShowAllSessions(false);
										},
										onMouseEnter: (event) => {
											const rect = event.currentTarget.getBoundingClientRect();
											setHeatTip({ key: cell.key, tokens: cell.tokens, cost: cell.cost, x: rect.left + rect.width / 2, y: rect.top - 6 });
										},
										onMouseLeave: () => setHeatTip(null)
									}, cell.key))
								])
							]
						}),
					,
					react_jsx_runtime.jsxs("div", {
						className: "u_heatDetail",
						children: selectedDayEntry === null
							? react_jsx_runtime.jsx("p", { className: "u_note", children: translate("usage.noDay") })
							: [
								react_jsx_runtime.jsxs("div", {
									className: "u_detailHead",
									children: [
										react_jsx_runtime.jsx("span", { className: "u_detailDay", children: dayTitleOf(selectedDate) }),
										react_jsx_runtime.jsx("span", { className: "u_detailCost", children: fmtMoney(selectedDayEntry.cost?.total, costCurrency) })
									]
								}),
								react_jsx_runtime.jsxs("div", {
									className: "u_detailMeta",
									children: [
										react_jsx_runtime.jsx("span", { children: translate("usage.summaryTokens", { value: fmtCompact(selectedDayEntry.tokens ?? 0) }) }),
										react_jsx_runtime.jsx("span", { children: translate("usage.summaryHit", { value: fmtHit(selectedDayEntry.cacheHitRate) }) }),
										selectedDayEntry.cost != null && react_jsx_runtime.jsx("span", { children: translate("cost.peakShort", { value: fmtMoney(selectedDayEntry.cost.peak, costCurrency) }) }),
										selectedDayEntry.cost != null && react_jsx_runtime.jsx("span", { children: translate("cost.offPeakShort", { value: fmtMoney(selectedDayEntry.cost.offPeak, costCurrency) }) })
									]
								}),
								react_jsx_runtime.jsxs("div", {
									className: "u_detailLegend",
									children: ["input", "cacheRead", "output"].map((kind) => react_jsx_runtime.jsxs("span", {
										className: "u_legendItem",
										"data-kind": kind,
										children: [react_jsx_runtime.jsx("span", { className: "u_legendDot" }), translate(`usage.${kind}`)]
									}, kind))
								}),
								...visibleSessions.map((session) => react_jsx_runtime.jsxs("div", {
									className: "u_modelRow",
									children: [
										react_jsx_runtime.jsxs("div", {
											className: "u_modelMeta",
											children: [
												react_jsx_runtime.jsx("span", { className: "u_modelName", title: session.id, children: sessionLabelOf(session, translate) }),
												react_jsx_runtime.jsx("span", { className: "u_modelTokens", children: fmtCompact(session.tokens ?? 0) }),
												react_jsx_runtime.jsx("span", { className: "u_modelHit", children: fmtHit(session.cacheHitRate) }),
												react_jsx_runtime.jsx("span", { className: "u_modelCost", children: fmtMoney(session.cost?.total, costCurrency) })
											]
										}),
										react_jsx_runtime.jsx(CompositionBar, { buckets: session, className: "u_bar", translate, tips: false })
									]
								}, session.id)),
								hiddenSessions > 0 && react_jsx_runtime.jsx("button", {
									type: "button",
									className: "u_more",
									onClick: () => setShowAllSessions(true),
									children: translate("usage.moreSessions", { value: hiddenSessions })
								})
							]
					}),
						heatTip !== null && react_jsx_runtime.jsxs("div", {
							className: "u_heatTip",
							style: { left: `${heatTip.x}px`, top: `${heatTip.y}px` },
							children: [
								react_jsx_runtime.jsx("span", { className: "u_heatTipDate", children: heatTip.key }),
								react_jsx_runtime.jsx("span", { children: `${fmtTokens(heatTip.tokens)} token` }),
								heatTip.cost !== null && react_jsx_runtime.jsx("span", { className: "u_heatTipCost", children: fmtMoney(heatTip.cost.total, costCurrency) })
							]
						})
					]
				});

			const cardBody = (id) => {
				if (id === "balance") return balanceBody;
				if (id === "heatmap") return heatmapBody;
				return null;
			};

			const updatedLabel = refreshedAt === null ? "" : translate("panel.updatedAt", {
				time: new Date(refreshedAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })
			});
			// Panel-level totals: they span every card, so they live in the footer.
			const footerLabel = (() => {
				const parts = [];
				if (updatedLabel !== "") parts.push(updatedLabel);
				if (usage !== null && usage.total !== null && usage.total !== void 0) {
					parts.push(translate("usage.cumulativeTokens", { value: fmtCompact(usage.total.tokens ?? 0) }));
					if (usage.total.cost !== null && usage.total.cost !== void 0) parts.push(translate("usage.cumulativeCost", { value: fmtMoney(usage.total.cost.total, costCurrency) }));
					parts.push(translate("usage.cumulativeHit", { value: fmtHit(usage.total.cacheHitRate) }));
				}
				return parts.join(" · ");
			})();

			// Floating dock: today's spend card. Rows are display-only; the gear
			// in the corner is the only way into the detail panel.
			const dock = react_jsx_runtime.jsx("div", {
				className: "u_dock",
				ref: dockRef,
				style: {
					bottom: `${settings.dockOffset}px`,
					...(dockMetrics !== null && dockMetrics.width > 0 ? { left: `${dockMetrics.left}px`, width: `${dockMetrics.width}px` } : {})
				},
				"data-dsh-usage-dock": true,
				children: react_jsx_runtime.jsxs("div", {
					className: "u_dockFrame",
					children: [
						react_jsx_runtime.jsx("button", {
							type: "button",
							className: "u_dockGrip",
							"aria-label": translate("action.dockDrag"),
							title: translate("action.dockDrag"),
							onPointerDown: onDockGripDown,
							onPointerMove: onDockGripMove,
							onPointerUp: onDockGripUp,
							children: react_jsx_runtime.jsx(GripIcon, { size: 12 })
						}),
						react_jsx_runtime.jsxs("div", {
							className: "u_dockCard",
							"data-expanded": dockExpanded ? true : void 0,
							onClick: () => setDockExpanded((value) => !value),
							children: [
								react_jsx_runtime.jsxs("div", {
									className: "u_costHead",
									children: [
										react_jsx_runtime.jsx("span", { className: "u_costLabel", children: translate("cost.today") }),
										react_jsx_runtime.jsx("div", {
											className: "u_costRow",
											children: react_jsx_runtime.jsx("span", {
												className: "u_costValue",
												"data-peak": peak,
												onMouseEnter: (event) => {
													if (todayCost === null) return;
													const rect = event.currentTarget.getBoundingClientRect();
													setCostTip({ x: rect.left + rect.width / 2, y: rect.top - 8 });
												},
												onMouseLeave: () => setCostTip(null),
												children: fmtMoney(todayCost?.total, costCurrency)
											})
										})
									]
								}),
								react_jsx_runtime.jsx(PeakBand, { peak, translate }),
								react_jsx_runtime.jsxs("div", {
									className: "u_metricRow",
									children: [
										react_jsx_runtime.jsxs("div", {
											className: "u_metric",
											children: [
												react_jsx_runtime.jsx("span", { className: "u_metricLabel", children: translate("widget.today") }),
												react_jsx_runtime.jsx("span", { className: "u_metricValue", children: (() => {
												const [value, unit] = splitCompact(usageValue(stats?.day.tokens));
												return [react_jsx_runtime.jsx("span", { children: value }, "value"), unit !== "" && react_jsx_runtime.jsx("span", { className: "u_metricUnit", children: unit }, "unit")];
											})() })
											]
										}),
										react_jsx_runtime.jsxs("div", {
											className: "u_metric",
											children: [
												react_jsx_runtime.jsx("span", { className: "u_metricLabel", children: translate("widget.hit") }),
												react_jsx_runtime.jsx("span", { className: "u_metricValue", children: (() => {
												const text = fmtHit(stats?.todayHit);
												const unit = text.endsWith("%") ? "%" : "";
												return [
													react_jsx_runtime.jsx("span", { children: unit === "" ? text : text.slice(0, -1) }, "value"),
													unit !== "" && react_jsx_runtime.jsx("span", { className: "u_metricUnit", children: unit }, "unit"),
													hitTrend !== null && react_jsx_runtime.jsx("span", {
														className: "u_trend",
														"data-trend": hitTrend.dir,
														title: translate("usage.hitTrend", { value: `${hitTrend.delta >= 0 ? "+" : ""}${hitTrend.delta.toFixed(1)}%` }),
															}, "trend")
												];
											})() })
											]
										})
									]
								}),
								react_jsx_runtime.jsx(CompositionBar, { buckets: stats?.day, className: "u_bar u_dockBar", translate }),
								react_jsx_runtime.jsxs("div", {
									className: "u_dockLegend",
									children: [
										react_jsx_runtime.jsxs("span", { className: "u_legendItem", "data-kind": "input", children: [react_jsx_runtime.jsx("span", { className: "u_legendDot" }), translate("usage.input")] }),
										react_jsx_runtime.jsxs("span", { className: "u_legendItem", "data-kind": "cacheRead", children: [react_jsx_runtime.jsx("span", { className: "u_legendDot" }), translate("usage.cacheRead")] }),
										react_jsx_runtime.jsxs("span", { className: "u_legendItem", "data-kind": "output", children: [react_jsx_runtime.jsx("span", { className: "u_legendDot" }), translate("usage.output")] })
									]
								}),
								react_jsx_runtime.jsxs("div", {
									className: "u_balanceLine",
									onClick: (event) => {
										event.stopPropagation();
										setOpen(true);
									},
									children: [
										react_jsx_runtime.jsx("span", { className: "u_balanceLineLabel", children: translate("cost.balance") }),
										react_jsx_runtime.jsx("span", { className: "u_balanceLineValue", "data-tone": balanceCompact.tone, children: balanceCompact.value }),
										react_jsx_runtime.jsx("span", { className: "u_chevronDock", "data-open": open ? true : void 0, children: "›" }),
										balanceCompact.hint !== null && react_jsx_runtime.jsx("span", { className: "u_warnDot", title: balanceCompact.hint })
									]
								})
							]
						}),
						react_jsx_runtime.jsx("button", {
							type: "button",
							className: "u_dockRefresh",
							"aria-label": translate("action.refresh"),
							title: translate("action.refresh"),
							onClick: retry,
							children: react_jsx_runtime.jsx(primitives.IconRefreshOutline14, { size: 11 })
						}),
						react_jsx_runtime.jsx("button", {
							type: "button",
							className: "u_dockSettings",
							"aria-label": translate("panel.title"),
							title: translate("panel.title"),
							onClick: () => setOpen((value) => !value),
							children: react_jsx_runtime.jsx(primitives.IconSettingsOutline14, { size: 12 })
						})
						,
						costTip !== null && todayCost !== null && react_jsx_runtime.jsxs("div", {
							className: "u_heatTip",
							style: { left: `${costTip.x}px`, top: `${costTip.y}px` },
							children: [
								react_jsx_runtime.jsx("span", { className: "u_heatTipCost", children: fmtMoneyExact(todayCost.total, costCurrency) }),
								react_jsx_runtime.jsx("span", { className: "u_heatTipDate", children: `${translate("cost.peak")} ${fmtMoney(todayCost.peak, costCurrency)} · ${translate("cost.offPeak")} ${fmtMoney(todayCost.offPeak, costCurrency)}` })
							]
						})
					]
				})
			});

			if (!open) {
				// Rail mode (sidebar collapsed): a single balance button that
				// reveals the dock; a transparent scrim closes it again.
				if (!wide && !dockOpen) {
					return react_jsx_runtime.jsx("button", {
						type: "button",
						className: "u_railBtn",
						style: {
							bottom: `${settings.dockOffset}px`,
							...(dockMetrics !== null && dockMetrics.centerX !== void 0 ? { left: `${dockMetrics.centerX}px` } : { left: "14px" })
						},
						"data-dsh-usage-rail": true,
						"aria-label": translate("panel.title"),
						onClick: () => setDockOpen(true),
						children: [
							react_jsx_runtime.jsx("span", { className: "u_railLabel", children: translate("widget.balance") }),
							react_jsx_runtime.jsx("span", { className: "u_railValue", "data-tone": balanceCompact.tone, children: balanceCompact.value })
						]
					});
				}
				if (!wide && dockOpen) {
					return react_jsx_runtime.jsxs(react_jsx_runtime.Fragment, {
						children: [
							react_jsx_runtime.jsx("div", { className: "u_railScrim", onClick: () => setDockOpen(false) }),
							dock
						]
					});
				}
				return dock;
			}

			const cards = WIDGETS.map((id) => {
				const collapsed = settings.collapsed[id] === true;
				return react_jsx_runtime.jsxs("section", {
					className: "u_card",
					"data-widget": id,
					"data-collapsed": collapsed ? true : void 0,
					children: [
						react_jsx_runtime.jsxs("button", {
							type: "button",
							className: "u_cardHead",
							"aria-expanded": !collapsed,
							"aria-controls": `dsh-usage-${id}-body`,
							onClick: () => toggleWidgetKey(id),
							children: [
								react_jsx_runtime.jsx("span", { className: "u_cardTitle", children: translate(`widget.${id}`) }),
								react_jsx_runtime.jsx("span", { className: "u_chevron", "data-open": collapsed ? void 0 : true, children: "›" })
							]
						}),
						!collapsed && react_jsx_runtime.jsx("div", {
							className: "u_cardBody",
							id: `dsh-usage-${id}-body`,
							children: cardBody(id)
						})
					]
				}, id);
			});

			const panel = react_jsx_runtime.jsxs("section", {
				className: "u_panel",
				ref: panelRef,
				style: panelPos === null ? void 0 : { top: `${panelPos.top}px`, maxHeight: `${panelPos.maxHeight}px` },
				
				"data-dsh-usage-panel": true,
				"aria-label": translate("panel.title"),
				children: [
					react_jsx_runtime.jsxs("div", {
						className: "u_body",
						children: [
							usageError !== null && react_jsx_runtime.jsxs("div", {
								className: "u_error",
								children: [
									react_jsx_runtime.jsx("span", { children: usageError }),
									react_jsx_runtime.jsx("button", { type: "button", className: "u_retry", onClick: retry, children: translate("action.retry") })
								]
							}),
							coverageNotice !== null && react_jsx_runtime.jsxs("details", {
								className: legacyOnly ? "u_coverage u_coverageQuiet" : "u_coverage",
								children: [
									react_jsx_runtime.jsxs("summary", {
										className: "u_coverageSummary",
										children: [
											legacyOnly ? null : react_jsx_runtime.jsx("span", { className: "u_coverageDot", "aria-hidden": true }),
											react_jsx_runtime.jsx("span", { className: "u_coverageLabel", role: "status", title: coverageSummary, children: coverageSummary }),
											react_jsx_runtime.jsxs("span", { className: "u_coverageMore", "aria-hidden": true, children: [translate("usage.details"), react_jsx_runtime.jsx("span", { className: "u_coverageArrow", children: "›" })] })
										]
									}),
									react_jsx_runtime.jsxs("div", {
										className: "u_coverageDetails",
										children: [
											react_jsx_runtime.jsx("span", { className: "u_coverageText", title: coverageNotice, children: coverageNotice }),
											react_jsx_runtime.jsx("button", { type: "button", className: "u_retry", onClick: retry, children: translate("action.retry") })
										]
									})
								]
							}),
							react_jsx_runtime.jsx("div", { className: "u_cards", children: cards }),
							react_jsx_runtime.jsx("p", { className: "u_footerNote", children: footerLabel })
						]
					})
				]
			});

			return react_jsx_runtime.jsxs(react_jsx_runtime.Fragment, {
				children: [
					react_jsx_runtime.jsx("div", { ref: uiRootRef, style: { display: "contents" }, children: [react.cloneElement(dock, { children: [dock.props.children, panel] })] }),
					hoverTip !== null && react_jsx_runtime.jsx("div", {
						className: "u_heatTip u_hoverTip",
						style: { left: `${hoverTip.x}px`, top: `${hoverTip.y}px` },
						children: hoverTip.text
					})
				]
			});
		}
		//#endregion

		//#region plugin body
		/** Services required by the client plugin body. */
		const inject = ["slots", "locale"];

		/**
		 * Client plugin body: register the dictionaries and the sidebar footer action.
		 * @param ctx - client root context.
		 */
		function apply(ctx) {
			ctx.effect(() => ctx.locale.register(NS, { zh, en }), "usage: dictionaries");
			ctx.slots.inject("sidebar.footer.action", () => ctx.slots.register({
				name: "sidebar.footer.action",
				id: "usage",
				locale: NS,
				order: 10
			}, UsagePanel));
		}
		//#endregion

		exports.apply = apply;
		exports.inject = inject;
		exports.UsagePanel = UsagePanel;
		exports.fmtTokens = fmtTokens;
		exports.fmtCompact = fmtCompact;
		exports.fmtCurrency = fmtCurrency;
		exports.fmtMoney = fmtMoney;
		exports.fmtMoneyExact = fmtMoneyExact;
		exports.fmtShare = fmtShare;
		exports.splitCompact = splitCompact;
		exports.fmtHit = fmtHit;
		exports.heatLevel = heatLevel;
		exports.heatColor = heatColor;
		exports.peakState = peakState;
		exports.balanceHint = balanceHint;
		exports.statusTextOf = statusTextOf;
		exports.defaultSettings = defaultSettings;
		exports.normalizeSettings = normalizeSettings;
		exports.createLoader = createLoader;
		return module.exports;
	}
});
