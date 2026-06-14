/// 图标库 —— 统一 1.8px 描边的内联 SVG 图标组件
const dIconBase = {
  fill: "none",
  stroke: "currentColor",
  strokeWidth: 1.8,
  strokeLinecap: "round",
  strokeLinejoin: "round",
  viewBox: "0 0 24 24",
};

const IconBookmark = (props) => (
  <svg {...dIconBase} {...props}><path d="M19 21l-7-5-7 5V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2z" /></svg>
);
const IconRss = (props) => (
  <svg {...dIconBase} {...props}><path d="M4 11a9 9 0 0 1 9 9" /><path d="M4 4a16 16 0 0 1 16 16" /><circle cx="5" cy="19" r="1.5" fill="currentColor" stroke="none" /></svg>
);
const IconWrench = (props) => (
  <svg {...dIconBase} {...props}><path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z" /></svg>
);
const IconSun = (props) => (
  <svg {...dIconBase} {...props}><circle cx="12" cy="12" r="4" /><path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M6.34 17.66l-1.41 1.41M19.07 4.93l-1.41 1.41" /></svg>
);
const IconMoon = (props) => (
  <svg {...dIconBase} {...props}><path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z" /></svg>
);
const IconPlus = (props) => (
  <svg {...dIconBase} {...props}><path d="M12 5v14M5 12h14" /></svg>
);
const IconTrash = (props) => (
  <svg {...dIconBase} {...props}><path d="M3 6h18M8 6V4a1 1 0 0 1 1-1h6a1 1 0 0 1 1 1v2M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6" /></svg>
);
const IconX = (props) => (
  <svg {...dIconBase} {...props}><path d="M18 6L6 18M6 6l12 12" /></svg>
);
const IconRefresh = (props) => (
  <svg {...dIconBase} {...props}><path d="M21 12a9 9 0 1 1-2.64-6.36L21 8" /><path d="M21 3v5h-5" /></svg>
);
const IconCopy = (props) => (
  <svg {...dIconBase} {...props}><rect x="9" y="9" width="13" height="13" rx="2" /><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" /></svg>
);
const IconCheck = (props) => (
  <svg {...dIconBase} {...props}><path d="M20 6L9 17l-5-5" /></svg>
);
const IconSearch = (props) => (
  <svg {...dIconBase} {...props}><circle cx="11" cy="11" r="8" /><path d="M21 21l-4.35-4.35" /></svg>
);
const IconPalette = (props) => (
  <svg {...dIconBase} {...props}><path d="M12 2a10 10 0 0 0 0 20 2.5 2.5 0 0 0 2.5-2.5c0-.61-.22-1.17-.58-1.6a2.5 2.5 0 0 1 1.9-4.1H18A4 4 0 0 0 22 9.8 10 10 0 0 0 12 2z" /><circle cx="7.5" cy="11.5" r="1" fill="currentColor" stroke="none" /><circle cx="10.5" cy="7" r="1" fill="currentColor" stroke="none" /><circle cx="15" cy="7" r="1" fill="currentColor" stroke="none" /></svg>
);
const IconKey = (props) => (
  <svg {...dIconBase} {...props}><circle cx="7.5" cy="15.5" r="4.5" /><path d="M10.8 12.2L21 2M15 7l3 3" /></svg>
);
const IconClock = (props) => (
  <svg {...dIconBase} {...props}><circle cx="12" cy="12" r="9" /><path d="M12 7v5l3 3" /></svg>
);
const IconType = (props) => (
  <svg {...dIconBase} {...props}><path d="M4 7V5h16v2M9 20h6M12 5v15" /></svg>
);
const IconDroplet = (props) => (
  <svg {...dIconBase} {...props}><path d="M12 2.69l5.66 5.66a8 8 0 1 1-11.31 0z" /></svg>
);
const IconDice = (props) => (
  <svg {...dIconBase} {...props}><rect x="3" y="3" width="18" height="18" rx="3" /><circle cx="8.5" cy="8.5" r="1.2" fill="currentColor" stroke="none" /><circle cx="15.5" cy="8.5" r="1.2" fill="currentColor" stroke="none" /><circle cx="12" cy="12" r="1.2" fill="currentColor" stroke="none" /><circle cx="8.5" cy="15.5" r="1.2" fill="currentColor" stroke="none" /><circle cx="15.5" cy="15.5" r="1.2" fill="currentColor" stroke="none" /></svg>
);
const IconTimer = (props) => (
  <svg {...dIconBase} {...props}><path d="M10 2h4" /><path d="M12 14l3-3" /><circle cx="12" cy="14" r="8" /></svg>
);
const IconFilePdf = (props) => (
  <svg {...dIconBase} {...props}><path d="M14 2H7a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V7z" /><path d="M14 2v5h5" /><path d="M8 16h1.4a1.6 1.6 0 0 0 0-3.2H8v4.2" /><path d="M12.5 16.8v-4h1.1a2 2 0 0 1 0 4h-1.1z" /><path d="M17 12.8h-2v4" /></svg>
);
const IconUpload = (props) => (
  <svg {...dIconBase} {...props}><path d="M12 16V4" /><path d="M7 9l5-5 5 5" /><path d="M20 16v3a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2v-3" /></svg>
);
const IconDownload = (props) => (
  <svg {...dIconBase} {...props}><path d="M12 4v12" /><path d="M7 11l5 5 5-5" /><path d="M20 20H4" /></svg>
);

Object.assign(window, {
  IconBookmark, IconRss, IconWrench, IconSun, IconMoon, IconPlus, IconTrash,
  IconX, IconRefresh, IconCopy, IconCheck, IconSearch, IconPalette, IconKey,
  IconClock, IconType, IconDroplet, IconDice, IconTimer, IconFilePdf,
  IconUpload, IconDownload,
});
