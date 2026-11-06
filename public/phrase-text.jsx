import { Parser, zhHansModel } from 'budoux';
const headingPhraseParser = new Parser(zhHansModel);
function PhraseText({ children }) {
  const text = String(children ?? '');
  if (!/[\u3400-\u9fff]/.test(text)) return text;
  const phrases = headingPhraseParser.parse(text);
  return <span className="phrase-text" lang="zh">{phrases.map((phrase, index) => <React.Fragment key={index}>{index > 0 && <wbr />}{phrase}</React.Fragment>)}</span>;
}
