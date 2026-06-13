/// 工具箱 —— 6 个完全离线可用的小工具，复制结果统一走 showToast 提示
const { useState, useEffect: useToolEffect, useRef: useToolRef } = React;

/** 复制文本到剪贴板并提示 */
function copyText(text, showToast) {
  navigator.clipboard.writeText(text)
    .then(() => showToast("已复制到剪贴板"))
    .catch(() => showToast("复制失败，请手动选择"));
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
  const [input, setInput] = useState("");

  useToolEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);

  function convert(raw) {
    const trimmed = raw.trim();
    if (!trimmed) return "";
    if (/^\d+$/.test(trimmed)) {
      const ms = trimmed.length <= 10 ? Number(trimmed) * 1000 : Number(trimmed);
      const date = new Date(ms);
      return isNaN(date.getTime()) ? "无法识别" : date.toLocaleString("zh-CN", { hour12: false });
    }
    const date = new Date(trimmed.replace(/-/g, "/"));
    return isNaN(date.getTime()) ? "无法识别" : `${Math.floor(date.getTime() / 1000)}（秒）`;
  }

  const nowSec = Math.floor(now / 1000);
  const result = convert(input);

  return (
    <div className="tool-card">
      <div className="tool-head"><IconClock /><h3>时间戳转换</h3></div>
      <div className="tool-output">
        <span>当前 {nowSec}</span>
        <button className="btn btn-icon btn-ghost" onClick={() => copyText(String(nowSec), showToast)} title="复制"><IconCopy /></button>
      </div>
      <input className="input" placeholder="输入时间戳或日期，如 2026-06-12 18:00"
        value={input} onChange={(e) => setInput(e.target.value)} />
      {result && (
        <div className="tool-output">
          <span>{result}</span>
          <button className="btn btn-icon btn-ghost" onClick={() => copyText(result, showToast)} title="复制"><IconCopy /></button>
        </div>
      )}
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

Object.assign(window, {
  PasswordTool, TimestampTool, WordCountTool, ColorTool, DiceTool, FocusTimerTool,
});
