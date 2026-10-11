/**
 * DSH Companion — preload
 *
 * 严格白名单：只暴露下列方法，不透传 ipcRenderer 本体。
 * 渲染页（悬浮球 / 小窗外壳）都是本地文件，但仍按最小权限原则处理。
 */
'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('companion', {
  // 状态
  getState: () => ipcRenderer.invoke('companion:state'),
  set: (patch) => ipcRenderer.invoke('companion:set', patch),

  // 认证
  probe: () => ipcRenderer.invoke('companion:probe'),

  // 小窗
  openPanel: () => ipcRenderer.invoke('companion:openPanel'),
  closePanel: () => ipcRenderer.invoke('companion:closePanel'),
  togglePin: () => ipcRenderer.invoke('companion:togglePin'),
  showMain: () => ipcRenderer.invoke('companion:showMain'),

  // 悬浮球拖动（用光标真实坐标，避免 renderer 坐标系误差）
  ball: {
    dragStart: () => ipcRenderer.send('ball:drag-start'),
    dragMove: () => ipcRenderer.send('ball:drag-move'),
    dragEnd: () => ipcRenderer.send('ball:drag-end'),
    click: () => ipcRenderer.send('ball:click'),
  },

  // 小窗顶栏（参考实现 T1–T9 形态）
  panel: {
    minimize: () => ipcRenderer.send('panel:minimize'),
    close: () => ipcRenderer.send('panel:close'),
    // T7 紧凑浮窗：切换窗口尺寸（真原生，不是 CSS 缩放）
    setCompact: (on) => ipcRenderer.invoke('panel:setCompact', !!on),
    // ⚠️ 2026-10-11 已移除三个接口（铺满整窗方案）：
    //   · dragStart/Move/End —— 顶栏改由 `-webkit-app-region: drag` 交给系统拖动，
    //     主进程不必再自己 setPosition；
    //   · resizeStart/Move/End —— 窗口不透明后系统提供边框缩放，自绘热区不再需要；
    //   · setIgnoreMouseEvents —— 没有透明圈，穿透机制整体删除。
    //   用户原话「还更方便、更简单一点」⇒ 这里是净删，不是替换。
  },
});
