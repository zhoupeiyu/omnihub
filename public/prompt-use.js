// Explicit template tokens, excluding JSON objects and CSS/code blocks.
function promptTemplateTokens(text) {
  return [...String(text || '').matchAll(/\{\{\s*([\p{L}\p{N}_][\p{L}\p{N}_ .-]{0,47}?)\s*\}\}|(?<!\{)\{\s*([\p{L}\p{N}_][\p{L}\p{N}_ .-]{0,47}?)\s*\}(?!\})/gu)]
    .map(match => ({raw:match[0],name:(match[1] || match[2]).trim(),index:match.index}));
}
function promptTemplateNames(text) { return [...new Set(promptTemplateTokens(text).map(token => token.name))]; }
function fillPromptTemplate(text, values) {
  let offset = 0, result = '';
  for (const token of promptTemplateTokens(text)) {
    result += text.slice(offset,token.index) + (Object.hasOwn(values,token.name) && String(values[token.name]).trim() ? String(values[token.name]) : token.raw);
    offset = token.index + token.raw.length;
  }
  return result + String(text || '').slice(offset);
}
function promptCreationModule(item) {
  const category = String(item?.category || '').trim();
  if (['图像','图像生成','绘画','image'].includes(category)) return 'image';
  if (['视频','视频生成','video'].includes(category)) return 'seedance';
  return null;
}
