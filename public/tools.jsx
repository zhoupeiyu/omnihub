/// 工具箱 —— 6 个完全离线可用的小工具，复制结果统一走 showToast 提示
const { useState, useEffect: useToolEffect, useRef: useToolRef } = React;

/** 复制文本到剪贴板并提示 */
function copyText(text, showToast) {
  navigator.clipboard.writeText(text)
    .then(() => showToast("已复制到剪贴板"))
    .catch(() => showToast("复制失败，请手动选择"));
}

function formatBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes < 0) return "-";
  const units = ["B", "KB", "MB", "GB"];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }
  return `${value >= 10 || unit === 0 ? value.toFixed(0) : value.toFixed(1)} ${units[unit]}`;
}

function formatDateTimeLocal(date) {
  const pad = (n) => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

function formatDateReadable(date) {
  if (!(date instanceof Date) || Number.isNaN(date.getTime())) return "无法识别";
  return date.toLocaleString("zh-CN", { hour12: false });
}

/** 工具 1：随机密码生成器 */
function PasswordTool({ showToast }) {
  const [length, setLength] = useState(16);
  const [useSymbols, setUseSymbols] = useState(true);
  const [password, setPassword] = useState("");

  function generate(len, symbols) {
    const letters = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789";
    const pool = symbols ? letters + "!@#$%^&*-_=+" : letters;
    const bytes = new Uint32Array(len);
    crypto.getRandomValues(bytes);
    let result = "";
    for (let i = 0; i < len; i++) result += pool[bytes[i] % pool.length];
    setPassword(result);
  }

  useToolEffect(() => generate(length, useSymbols), []);

  return (
    <div className="tool-card">
      <div className="tool-head"><IconKey /><h3>随机密码</h3></div>
      <div className="tool-output">
        <span>{password}</span>
        <button className="btn btn-icon btn-ghost" onClick={() => copyText(password, showToast)} title="复制"><IconCopy /></button>
      </div>
      <div className="tool-row">
        <span className="tool-label">长度 {length}</span>
        <input type="range" className="range" min="8" max="32" value={length}
          onChange={(e) => { const v = Number(e.target.value); setLength(v); generate(v, useSymbols); }} />
      </div>
      <div className="tool-row" style={{ justifyContent: "space-between" }}>
        <label className="tool-label" style={{ display: "flex", alignItems: "center", gap: 6, cursor: "pointer" }}>
          <input type="checkbox" checked={useSymbols}
            onChange={(e) => { setUseSymbols(e.target.checked); generate(length, e.target.checked); }} />
          包含符号
        </label>
        <button className="btn" onClick={() => generate(length, useSymbols)}><IconRefresh />重新生成</button>
      </div>
    </div>
  );
}

/** 工具 2：时间戳转换 */
function TimestampTool({ showToast }) {
  const [now, setNow] = useState(Date.now());
  const [dateInput, setDateInput] = useState(() => formatDateTimeLocal(new Date()));
  const [stampInput, setStampInput] = useState(String(Math.floor(Date.now() / 1000)));

  useToolEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);

  function parseLocalDate(value) {
    if (!value) return null;
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? null : date;
  }

  function parseTimestamp(value) {
    const trimmed = value.trim();
    if (!/^-?\d+$/.test(trimmed)) return null;
    const num = Number(trimmed);
    if (!Number.isFinite(num)) return null;
    return new Date(Math.abs(num) < 100000000000 ? num * 1000 : num);
  }

  const nowSec = Math.floor(now / 1000);
  const date = parseLocalDate(dateInput);
  const timestampDate = parseTimestamp(stampInput);
  const seconds = date ? Math.floor(date.getTime() / 1000) : null;
  const millis = date ? date.getTime() : null;

  return (
    <div className="tool-card">
      <div className="tool-head"><IconClock /><h3>时间戳转换</h3></div>
      <div className="tool-output">
        <span>当前 {nowSec} 秒 / {now} 毫秒</span>
        <button className="btn btn-icon btn-ghost" onClick={() => copyText(String(nowSec), showToast)} title="复制"><IconCopy /></button>
      </div>
      <label className="tool-label">日期转时间戳</label>
      <input className="input" type="datetime-local" step="1" value={dateInput}
        onChange={(e) => setDateInput(e.target.value)} />
      <div className="tool-split">
        <div className="tool-output">
          <span>{seconds != null ? `${seconds} 秒` : "无法识别"}</span>
          {seconds != null && <button className="btn btn-icon btn-ghost" onClick={() => copyText(String(seconds), showToast)} title="复制"><IconCopy /></button>}
        </div>
        <div className="tool-output">
          <span>{millis != null ? `${millis} 毫秒` : "无法识别"}</span>
          {millis != null && <button className="btn btn-icon btn-ghost" onClick={() => copyText(String(millis), showToast)} title="复制"><IconCopy /></button>}
        </div>
      </div>
      <label className="tool-label">时间戳转日期</label>
      <input className="input" inputMode="numeric" placeholder="秒或毫秒，如 1781268000 / 1781268000000"
        value={stampInput} onChange={(e) => setStampInput(e.target.value)} />
      <div className="tool-output">
        <span>{formatDateReadable(timestampDate)}</span>
        {timestampDate && !Number.isNaN(timestampDate.getTime()) && (
          <button className="btn btn-icon btn-ghost" onClick={() => copyText(formatDateReadable(timestampDate), showToast)} title="复制"><IconCopy /></button>
        )}
      </div>
    </div>
  );
}

/** 工具 3：字数统计 */
function WordCountTool() {
  const [text, setText] = useState("");
  const chars = Array.from(text.replace(/\s/g, "")).length;
  const cjk = (text.match(/[\u4e00-\u9fff]/g) || []).length;
  const words = (text.match(/[A-Za-z]+(?:'[A-Za-z]+)?/g) || []).length;
  const lines = text ? text.split("\n").length : 0;

  return (
    <div className="tool-card">
      <div className="tool-head"><IconType /><h3>字数统计</h3></div>
      <textarea className="input" rows="3" placeholder="粘贴或输入文字……"
        style={{ resize: "vertical", lineHeight: 1.7 }}
        value={text} onChange={(e) => setText(e.target.value)} />
      <div className="stat-row">
        <div className="stat-box"><div className="stat-num">{chars}</div><div className="stat-lab">字符</div></div>
        <div className="stat-box"><div className="stat-num">{cjk}</div><div className="stat-lab">汉字</div></div>
        <div className="stat-box"><div className="stat-num">{words}</div><div className="stat-lab">英文词</div></div>
        <div className="stat-box"><div className="stat-num">{lines}</div><div className="stat-lab">行数</div></div>
      </div>
    </div>
  );
}

/** 工具 4：颜色转换（HEX ↔ RGB） */
function ColorTool({ showToast }) {
  const [hex, setHex] = useState("#4a6cf7");

  function toRgb(value) {
    const match = value.match(/^#?([0-9a-f]{6})$/i);
    if (!match) return null;
    const num = parseInt(match[1], 16);
    return { r: (num >> 16) & 255, g: (num >> 8) & 255, b: num & 255 };
  }

  const rgb = toRgb(hex);
  const rgbText = rgb ? `rgb(${rgb.r}, ${rgb.g}, ${rgb.b})` : "格式应为 #RRGGBB";

  return (
    <div className="tool-card">
      <div className="tool-head"><IconDroplet /><h3>颜色转换</h3></div>
      <div className="tool-row">
        <div className="color-swatch" style={{ background: rgb ? hex : "transparent" }}></div>
        <input className="input" value={hex} onChange={(e) => setHex(e.target.value)} placeholder="#4a6cf7" />
        <input type="color" value={rgb ? (hex.startsWith("#") ? hex : "#" + hex) : "#4a6cf7"}
          onChange={(e) => setHex(e.target.value)}
          style={{ width: 44, height: 44, border: "none", background: "transparent", cursor: "pointer", flexShrink: 0 }} />
      </div>
      <div className="tool-output">
        <span>{rgbText}</span>
        {rgb && <button className="btn btn-icon btn-ghost" onClick={() => copyText(rgbText, showToast)} title="复制"><IconCopy /></button>}
      </div>
    </div>
  );
}

/** 工具 5：随机决定器 */
function DiceTool() {
  const [options, setOptions] = useState("吃面\n吃饭\n吃饺子");
  const [result, setResult] = useState("");
  const [rolling, setRolling] = useState(false);
  const timerRef = useToolRef(null);

  function roll() {
    const list = options.split("\n").map((s) => s.trim()).filter(Boolean);
    if (list.length < 2) { setResult("至少填两个选项哦"); return; }
    setRolling(true);
    let count = 0;
    clearInterval(timerRef.current);
    timerRef.current = setInterval(() => {
      setResult(list[Math.floor(Math.random() * list.length)]);
      count++;
      if (count > 12) {
        clearInterval(timerRef.current);
        setRolling(false);
      }
    }, 70);
  }

  useToolEffect(() => () => clearInterval(timerRef.current), []);

  return (
    <div className="tool-card">
      <div className="tool-head"><IconDice /><h3>随机决定</h3></div>
      <textarea className="input" rows="3" style={{ resize: "vertical", lineHeight: 1.7 }}
        value={options} onChange={(e) => setOptions(e.target.value)} placeholder="每行一个选项" />
      <div className="dice-result">{result || "纠结的时候，交给运气"}</div>
      <button className="btn btn-primary" style={{ justifyContent: "center" }} onClick={roll} disabled={rolling}>
        <IconDice />{rolling ? "决定中……" : "帮我决定"}
      </button>
    </div>
  );
}

/** 工具 6：专注倒计时 */
function FocusTimerTool({ showToast }) {
  const [minutes, setMinutes] = useState(25);
  const [secondsLeft, setSecondsLeft] = useState(null);
  const timerRef = useToolRef(null);

  function start() {
    clearInterval(timerRef.current);
    setSecondsLeft(minutes * 60);
    timerRef.current = setInterval(() => {
      setSecondsLeft((prev) => {
        if (prev === null || prev <= 1) {
          clearInterval(timerRef.current);
          if (prev === 1) showToast("时间到！休息一下吧");
          return prev === null ? null : 0;
        }
        return prev - 1;
      });
    }, 1000);
  }

  function stop() {
    clearInterval(timerRef.current);
    setSecondsLeft(null);
  }

  useToolEffect(() => () => clearInterval(timerRef.current), []);

  const running = secondsLeft !== null && secondsLeft > 0;
  const display = secondsLeft === null
    ? `${minutes}:00`
    : `${Math.floor(secondsLeft / 60)}:${String(secondsLeft % 60).padStart(2, "0")}`;

  return (
    <div className="tool-card">
      <div className="tool-head"><IconTimer /><h3>专注倒计时</h3></div>
      <div className="dice-result" style={{ fontFamily: "var(--font-mono)", fontSize: 34 }}>{display}</div>
      <div className="tool-row">
        <span className="tool-label">{minutes} 分钟</span>
        <input type="range" className="range" min="5" max="60" step="5" value={minutes}
          disabled={running} onChange={(e) => setMinutes(Number(e.target.value))} />
      </div>
      <div className="tool-row">
        <button className="btn btn-primary" style={{ flex: 1, justifyContent: "center" }} onClick={start}>
          {running ? "重新开始" : "开始专注"}
        </button>
        {running && <button className="btn" onClick={stop}>停止</button>}
      </div>
    </div>
  );
}

const PDF_PRESETS = [
  { id: "screen", label: "高压缩", desc: "体积优先", hint: "适合传输" },
  { id: "ebook", label: "推荐", desc: "均衡清晰度", hint: "默认" },
  { id: "printer", label: "高质量", desc: "细节优先", hint: "温和压缩" },
];
const PDF_UPLOAD_LIMIT_BYTES = 300 * 1024 * 1024;

function PdfCompressTool({ showToast }) {
  const [file, setFile] = useState(null);
  const [preset, setPreset] = useState("ebook");
  const [job, setJob] = useState(null);
  const [progress, setProgress] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const pollRef = useToolRef(null);
  const fileInputRef = useToolRef(null);

  useToolEffect(() => () => clearInterval(pollRef.current), []);

  function resetJob() {
    clearInterval(pollRef.current);
    setJob(null);
    setProgress(0);
    setBusy(false);
    setError("");
  }

  function selectFile(nextFile) {
    resetJob();
    if (!nextFile) { setFile(null); return; }
    if (nextFile.type && nextFile.type !== "application/pdf") {
      setFile(null);
      setError("请选择 PDF 文件");
      return;
    }
    if (!nextFile.name.toLowerCase().endsWith(".pdf")) {
      setFile(null);
      setError("请选择 PDF 文件");
      return;
    }
    if (nextFile.size > PDF_UPLOAD_LIMIT_BYTES) {
      setFile(nextFile);
      setError(`PDF 太大了，当前最多支持 ${formatBytes(PDF_UPLOAD_LIMIT_BYTES)}`);
      return;
    }
    setFile(nextFile);
  }

  function uploadJob() {
    return new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      const body = new FormData();
      body.append("pdf", file);
      body.append("preset", preset);
      xhr.open("POST", "/api/tools/pdf-compress");
      xhr.responseType = "json";
      xhr.upload.onprogress = (event) => {
        if (!event.lengthComputable) return;
        setProgress(Math.max(4, Math.round((event.loaded / event.total) * 32)));
      };
      xhr.onload = () => {
        const payload = xhr.response || {};
        if (xhr.status >= 200 && xhr.status < 300) resolve(payload);
        else if (xhr.status === 413) reject(new Error(`上传失败：PDF 超过 ${formatBytes(PDF_UPLOAD_LIMIT_BYTES)} 限制`));
        else reject(new Error(payload.error || `上传失败（${xhr.status}）`));
      };
      xhr.onerror = () => reject(new Error("上传失败，请检查本地服务"));
      xhr.send(body);
    });
  }

  function pollJob(id) {
    clearInterval(pollRef.current);
    pollRef.current = setInterval(() => {
      api(`/api/tools/pdf-compress/${id}`)
        .then((payload) => {
          setJob(payload);
          setProgress(payload.progress || 0);
          if (payload.status === "done") {
            clearInterval(pollRef.current);
            setBusy(false);
            showToast("PDF 压缩完成");
          } else if (payload.status === "error") {
            clearInterval(pollRef.current);
            setBusy(false);
            setError(payload.error || "压缩失败");
          }
        })
        .catch((err) => {
          clearInterval(pollRef.current);
          setBusy(false);
          setError(err.message);
        });
    }, 600);
  }

  function startCompress() {
    if (!file) { setError("先选择一个 PDF 文件"); return; }
    resetJob();
    setBusy(true);
    setProgress(3);
    uploadJob()
      .then((payload) => {
        setJob(payload);
        setProgress(Math.max(35, payload.progress || 35));
        pollJob(payload.id);
      })
      .catch((err) => {
        setBusy(false);
        setError(err.message);
      });
  }

  const done = job && job.status === "done" && job.result;
  const ratio = done ? job.result.compressionRatio : 0;
  const presetInfo = PDF_PRESETS.find((item) => item.id === preset) || PDF_PRESETS[1];
  const selectedFileMeta = file ? [
    ["大小", formatBytes(file.size)],
    ["类型", file.type || "application/pdf"],
    ["修改时间", file.lastModified ? formatDateReadable(new Date(file.lastModified)) : "-"],
    ["输出名", file.name.replace(/\.pdf$/i, "_compressed.pdf")],
  ] : [];

  return (
    <div className="tool-card tool-card-wide">
      <div className="tool-head"><IconFilePdf /><h3>PDF 压缩</h3></div>
      <div className="pdf-drop" onClick={() => fileInputRef.current && fileInputRef.current.click()}>
        <input ref={fileInputRef} type="file" accept="application/pdf" hidden
          onChange={(e) => selectFile(e.target.files && e.target.files[0])} />
        <IconUpload />
        <div>
          <strong>{file ? file.name : "选择本地 PDF 文件"}</strong>
          <span>{file ? `${formatBytes(file.size)} · ${file.type || "application/pdf"}` : `上传到你的服务器压缩，单个 PDF 上限 ${formatBytes(PDF_UPLOAD_LIMIT_BYTES)}`}</span>
        </div>
      </div>
      {file && (
        <div className="pdf-file-meta">
          {selectedFileMeta.map(([label, value]) => (
            <div key={label}>
              <span>{label}</span>
              <strong>{value}</strong>
            </div>
          ))}
        </div>
      )}
      <div className="pdf-preset-row">
        {PDF_PRESETS.map((item) => (
          <button key={item.id} className={"preset-btn" + (preset === item.id ? " active" : "")}
            onClick={() => { setPreset(item.id); resetJob(); }} disabled={busy}>
            <strong>{item.label}</strong>
            <span>{item.desc}</span>
            <em>{item.hint}</em>
          </button>
        ))}
      </div>
      <div className="tool-output">
        <span>{busy ? `正在压缩：${job ? job.phase : "上传中"}` : done ? `已节省 ${formatBytes(job.result.savedBytes)} · 压缩率 ${ratio}%` : `当前预设：${presetInfo.label} · ${presetInfo.desc}`}</span>
      </div>
      <div className="progress-track" aria-label="压缩进度">
        <span style={{ width: `${Math.max(0, Math.min(100, progress))}%` }}></span>
      </div>
      {done && (
        <div className="pdf-result-panel">
          <div>
            <span>压缩结果</span>
            <strong>{job.result.outputName}</strong>
          </div>
          <div className="ratio-wrap">
            <div className="ratio-head">
              <span>压缩率</span>
              <strong>{ratio}%</strong>
            </div>
            <div className="progress-track ratio"><span style={{ width: `${Math.max(0, Math.min(100, ratio))}%` }}></span></div>
            <div className="file-compare">
              <span>原始 {formatBytes(job.file.size)}</span>
              <span>压缩后 {formatBytes(job.result.outputBytes)}</span>
            </div>
          </div>
        </div>
      )}
      {error && <div className="tool-error">{error}</div>}
      <div className="tool-row">
        <button className="btn btn-primary" style={{ flex: 1, justifyContent: "center" }}
          onClick={startCompress} disabled={!file || file.size > PDF_UPLOAD_LIMIT_BYTES || busy}>
          <IconFilePdf />{busy ? "压缩中……" : "开始压缩"}
        </button>
        {done && (
          <a className="btn btn-primary" href={job.result.downloadUrl} download={job.result.outputName}>
            <IconDownload />下载压缩后的 PDF
          </a>
        )}
      </div>
    </div>
  );
}

Object.assign(window, {
  PasswordTool, TimestampTool, WordCountTool, ColorTool, DiceTool, FocusTimerTool,
  PdfCompressTool,
});
